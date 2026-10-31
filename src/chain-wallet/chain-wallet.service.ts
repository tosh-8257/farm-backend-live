import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { generateTxReference } from '../common/utils/reference.util';
import { AlgorandWalletClient } from './algorand-wallet.client';
import { RateService } from './rate.service';
import {
  ALGO_ASSET_ID,
  ALGO_DECIMALS,
  chainConfig,
  FARM_DECIMALS,
  USDC_DECIMALS,
} from './chain-config';
import { sealSecret, walletSigner } from './key-vault';
import { AlgoSigner } from './signer';
import { chainReadiness } from './readiness';

const explorer = (net: string) =>
  `https://${net === 'testnet' ? 'testnet.' : ''}explorer.perawallet.app`;

@Injectable()
export class ChainWalletService {
  private readonly log = new Logger(ChainWalletService.name);
  private polling = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: AlgorandWalletClient,
    private readonly rates: RateService,
  ) {}

  status() {
    const c = chainConfig();
    return {
      data: {
        network: c.network,
        wallets: c.wallets,
        deposits: c.deposits,
        conversion: c.conversion,
        mirror: c.mirror,
        sync: c.sync,
        reserve_address: c.wallets.enabled
          ? process.env.FARM_RESERVE_ADDRESS
          : null,
        receive_only: true,
        usdc_asa_id: c.wallets.enabled ? process.env.USDC_ASA_ID : null,
        farm_asa_id: c.wallets.enabled ? process.env.FARM_ASA_ID : null,
        peg: '1 FARM = 1 KSh',
      },
    };
  }

  private present(w: any) {
    return {
      address: w.address,
      network: w.network,
      status: w.status,
      ready: w.status === 'ready',
      usdc_asa_id: process.env.USDC_ASA_ID ?? null,
      farm_asa_id: process.env.FARM_ASA_ID ?? null,
      explorer_url: `${explorer(w.network)}/address/${w.address}/`,
    };
  }

  /** Returns (and on first call creates) the user's custodial address. */
  async mine(userId: string) {
    const c = chainConfig();
    if (!c.wallets.enabled) return { data: null, enabled: false };
    let w = await this.prisma.user_chain_wallets.findUnique({
      where: { user_id: userId },
    });
    if (!w) {
      const acct = this.chain.newAccount();
      try {
        w = await this.prisma.user_chain_wallets.create({
          data: {
            user_id: userId,
            network: c.network,
            address: acct.address,
            key_scheme: acct.scheme,
            ...sealSecret(acct.seed, acct.address),
          },
        });
      } catch {
        // concurrent first call: the other request won (unique user_id)
        w = await this.prisma.user_chain_wallets.findUnique({
          where: { user_id: userId },
        });
      } finally {
        acct.seed.fill(0);
      }
      if (!w) throw new ServiceUnavailableException('Could not create wallet');
    }
    if (w.status === 'created' || w.status === 'failed')
      void this.provision(w.id).catch(() => undefined);
    return { data: this.present(w), enabled: true };
  }

  /** Fund min-balance and opt in to USDC + FARM. Each step is resumable. */
  async provision(id: string) {
    const claim = await this.prisma.user_chain_wallets.updateMany({
      where: { id, status: { in: ['created', 'failed'] } },
      data: { status: 'provisioning', error: null },
    });
    if (!claim.count) return;
    const w = (await this.prisma.user_chain_wallets.findUnique({
      where: { id },
    }))!;
    let sk: AlgoSigner | null = null;
    try {
      const data: Record<string, string> = {};
      if (!w.funded_tx_id)
        data.funded_tx_id = await this.chain.fund(
          w.address,
          BigInt(process.env.CHAIN_WALLET_FUND_MICROALGOS ?? '310000'),
        );
      sk = walletSigner(w);
      if (!w.usdc_opt_in_tx)
        data.usdc_opt_in_tx = await this.chain.optIn(
          w.address,
          sk,
          BigInt(process.env.USDC_ASA_ID!),
        );
      if (!w.farm_opt_in_tx)
        data.farm_opt_in_tx = await this.chain.optIn(
          w.address,
          sk,
          BigInt(process.env.FARM_ASA_ID!),
        );
      await this.prisma.user_chain_wallets.update({
        where: { id },
        data: { ...data, status: 'ready' },
      });
    } catch (e: any) {
      const msg = String(e?.message ?? 'provisioning failed').slice(0, 300);
      this.log.warn(`Wallet ${id} provisioning failed: ${msg}`);
      await this.prisma.user_chain_wallets.update({
        where: { id },
        data: { status: 'failed', error: msg },
      });
    } finally {
      sk?.wipe();
    }
  }

  async myDeposits(userId: string) {
    const rows = await this.prisma.chain_deposits.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    return {
      data: rows.map((d) => ({
        id: d.id,
        tx_id: d.tx_id,
        asset: d.asset_symbol,
        amount: Number(d.amount_units) / 10 ** d.decimals,
        status: d.status,
        rate_kes: d.rate_kes == null ? null : Number(d.rate_kes),
        rate_source: d.rate_source,
        farm_amount: d.farm_amount == null ? null : Number(d.farm_amount),
        created_at: d.created_at,
        tx_url: `${explorer(d.network)}/tx/${d.tx_id}/`,
      })),
    };
  }

  // ---------------- Deposits ----------------

  @Interval('chain-deposit-poll', 60_000)
  async scheduledPoll() {
    if (!chainConfig().deposits.enabled || this.polling) return;
    this.polling = true;
    try {
      await this.pollDeposits();
      await this.creditPending();
    } catch (e: any) {
      this.log.warn(`Deposit poll failed: ${e?.message ?? e}`);
    } finally {
      this.polling = false;
    }
  }

  /** Back-compat name used by the admin sync endpoint. */
  async pollUsdc() {
    return this.pollDeposits();
  }

  /**
   * Records new USDC and FARM transfers into custodial addresses. Idempotent
   * (unique network+tx+asset). FARM moved by FARM itself (reserve or another
   * custodial account, i.e. the on-chain sync) is NOT a deposit.
   */
  async pollDeposits() {
    const c = chainConfig();
    if (!c.deposits.enabled)
      throw new ServiceUnavailableException('Deposits are disabled');
    const reserve = process.env.FARM_RESERVE_ADDRESS!;
    const assets = [
      {
        id: BigInt(process.env.USDC_ASA_ID!),
        symbol: 'USDC',
        decimals: USDC_DECIMALS,
      },
      {
        id: BigInt(process.env.FARM_ASA_ID!),
        symbol: 'FARM',
        decimals: FARM_DECIMALS,
      },
    ];
    let recorded = 0;
    let seen = 0;
    for (const a of assets) {
      const key = `${c.network}:${a.symbol.toLowerCase()}:${a.id}`;
      let cur = await this.prisma.chain_sync_state.findUnique({
        where: { key },
      });
      if (!cur) {
        // start from "now": nothing before go-live is backfilled
        const r = await this.chain.currentRound();
        cur = await this.prisma.chain_sync_state.create({
          data: { key, last_round: r },
        });
      }
      const txs = await this.chain.transfersSince(a.id, cur.last_round);
      seen += txs.length;
      const addrs = [...new Set(txs.flatMap((t) => [t.receiver, t.sender]))];
      const owners = addrs.length
        ? await this.prisma.user_chain_wallets.findMany({
            where: { address: { in: addrs }, network: c.network },
            select: { address: true, user_id: true },
          })
        : [];
      const byAddr = new Map(owners.map((o) => [o.address, o.user_id]));
      const internal = (addr: string) => addr === reserve || byAddr.has(addr);
      const rows = txs
        .filter(
          (t) =>
            byAddr.has(t.receiver) &&
            t.amount > 0n &&
            t.sender !== t.receiver &&
            !(a.symbol === 'FARM' && internal(t.sender)),
        )
        .map((t) => ({
          network: c.network,
          tx_id: t.txId,
          asset_id: t.assetId,
          asset_symbol: a.symbol,
          user_id: byAddr.get(t.receiver)!,
          address: t.receiver,
          sender: t.sender,
          amount_units: t.amount,
          decimals: a.decimals,
          confirmed_round: t.round,
        }));
      if (rows.length)
        recorded += (
          await this.prisma.chain_deposits.createMany({
            data: rows,
            skipDuplicates: true,
          })
        ).count;
      const maxRound = txs.reduce(
        (m, t) => (t.round > m ? t.round : m),
        cur.last_round,
      );
      if (maxRound > cur.last_round)
        await this.prisma.chain_sync_state.update({
          where: { key },
          data: { last_round: maxRound },
        });
    }
    const algo = await this.pollAlgo(c.network, reserve);
    return { seen: seen + algo.seen, recorded: recorded + algo.recorded };
  }

  /**
   * Native ALGO received by custodial addresses. Ignored: the funder's
   * provisioning payment (and anything else from the funder), the FARM
   * reserve, other custodial addresses (internal moves) and self payments.
   * Idempotent via the unique (network, tx_id, asset_id=0) key.
   */
  async pollAlgo(network: string, reserve: string) {
    const key = `${network}:algo:0`;
    const cur = await this.prisma.chain_sync_state.findUnique({
      where: { key },
    });
    const head = await this.chain.currentRound();
    if (!cur) {
      // start from "now": nothing before go-live is backfilled
      await this.prisma.chain_sync_state.create({
        data: { key, last_round: head },
      });
      return { seen: 0, recorded: 0 };
    }
    const wallets = await this.prisma.user_chain_wallets.findMany({
      where: { network, status: 'ready' },
      select: { address: true, user_id: true, funded_tx_id: true },
    });
    if (!wallets.length) {
      await this.prisma.chain_sync_state.update({
        where: { key },
        data: { last_round: head },
      });
      return { seen: 0, recorded: 0 };
    }
    const byAddr = new Map(wallets.map((w) => [w.address, w]));
    const fundingTx = new Set(
      wallets.map((w) => w.funded_tx_id).filter((x): x is string => !!x),
    );
    const funder = this.chain.funderAddress();
    let seen = 0;
    let recorded = 0;
    for (const w of wallets) {
      const txs = await this.chain.paymentsTo(w.address, cur.last_round);
      seen += txs.length;
      const rows = txs
        .filter(
          (t) =>
            t.receiver === w.address &&
            t.amount > 0n &&
            t.sender !== t.receiver &&
            t.sender !== funder &&
            t.sender !== reserve &&
            !byAddr.has(t.sender) &&
            !fundingTx.has(t.txId),
        )
        .map((t) => ({
          network,
          tx_id: t.txId,
          asset_id: ALGO_ASSET_ID,
          asset_symbol: 'ALGO',
          user_id: w.user_id,
          address: w.address,
          sender: t.sender,
          amount_units: t.amount,
          decimals: ALGO_DECIMALS,
          confirmed_round: t.round,
        }));
      if (rows.length)
        recorded += (
          await this.prisma.chain_deposits.createMany({
            data: rows,
            skipDuplicates: true,
          })
        ).count;
    }
    // Rounds up to `head` were covered for every address; overlap is safe (idempotent).
    if (head > cur.last_round)
      await this.prisma.chain_sync_state.update({
        where: { key },
        data: { last_round: head },
      });
    return { seen, recorded };
  }

  async creditPending() {
    let pending = await this.prisma.chain_deposits.findMany({
      where: { status: { in: ['detected', 'pending_rate'] } },
      orderBy: { created_at: 'asc' },
      take: 100,
    });
    if (!pending.length) return { credited: 0, waiting: 0 };
    let credited = 0;
    const PEG = { rate: 1, source: 'peg:1 FARM = 1 KSh', at: new Date() };
    for (const d of pending.filter((x) => x.asset_symbol === 'FARM')) {
      try {
        if (await this.credit(d, PEG)) credited++;
      } catch (e: any) {
        this.log.warn(`Credit of deposit ${d.id} failed: ${e?.message ?? e}`);
      }
    }
    pending = pending.filter((x) => x.asset_symbol !== 'FARM');
    let waiting = 0;
    const cfg = chainConfig();
    for (const sym of ['USDC', 'ALGO'] as const) {
      const group = pending.filter(
        (x) => (x.asset_symbol === 'ALGO' ? 'ALGO' : 'USDC') === sym,
      );
      if (!group.length) continue;
      const rate =
        sym === 'USDC'
          ? cfg.conversion.enabled
            ? await this.rates.usdcKes()
            : null
          : cfg.algoConversion.enabled
            ? await this.rates.algoKes()
            : null;
      if (!rate) {
        // No live rate: hold, never guess.
        await this.prisma.chain_deposits.updateMany({
          where: { id: { in: group.map((d) => d.id) }, status: 'detected' },
          data: { status: 'pending_rate' },
        });
        waiting += group.length;
        continue;
      }
      for (const d of group) {
        try {
          if (await this.credit(d, rate)) credited++;
          else waiting++;
        } catch (e: any) {
          waiting++;
          this.log.warn(`Credit of deposit ${d.id} failed: ${e?.message ?? e}`);
        }
      }
    }
    return { credited, waiting };
  }

  private async credit(
    d: any,
    rate: { rate: number; source: string; at: Date },
  ) {
    const usdc = Number(d.amount_units) / 10 ** d.decimals; // asset amount (USDC or FARM)
    const isFarm = d.asset_symbol === 'FARM';
    const farm =
      Math.floor(usdc * rate.rate * 10 ** FARM_DECIMALS) / 10 ** FARM_DECIMALS;
    if (!(farm > 0)) return false;
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.chain_deposits.updateMany({
        where: { id: d.id, status: { in: ['detected', 'pending_rate'] } },
        data: {
          status: 'credited',
          rate_kes: rate.rate,
          rate_source: rate.source,
          rate_at: rate.at,
          farm_amount: farm,
          credited_at: new Date(),
        },
      });
      if (!claim.count) return false; // someone else credited it
      const w = await tx.wallets.findFirst({
        where: { user_id: d.user_id, is_active: true },
      });
      if (!w) throw new BadRequestException('User wallet not found');
      await tx.wallets.update({
        where: { id: w.id },
        data: { balance: { increment: farm } },
      });
      const t = await tx.transactions.create({
        data: {
          transaction_reference: generateTxReference(),
          receiver_wallet_id: w.id,
          transaction_type: 'deposit',
          // FARM deposits are already on chain in the user's address: the
          // on-chain sync must not move FARM again for this ledger entry.
          status: 'completed',
          amount: farm,
          fee: 0,
          net_amount: farm,
          description: isFarm
            ? `Received ${usdc} FARM on Algorand`
            : `Received ${usdc} ${d.asset_symbol} on Algorand @ ${rate.rate} KSh`,
          metadata: {
            chain_deposit_id: d.id,
            tx_id: d.tx_id,
            asset: d.asset_symbol,
            chain_settled: isFarm,
            rate: rate.rate,
            rate_source: rate.source,
          },
          processed_at: new Date(),
        },
      });
      await tx.ledger_entries.create({
        data: {
          transaction_id: t.id,
          wallet_id: w.id,
          entry_type: 'credit',
          amount: farm,
          description: `${d.asset_symbol} received on Algorand`,
        },
      });
      await tx.blockchain_transactions.create({
        data: {
          transaction_id: t.id,
          blockchain_name: 'algorand',
          tx_hash: d.tx_id,
          sender_address: d.sender,
          receiver_address: d.address,
          asset_id: d.asset_id.toString(),
          amount: usdc,
          status: 'confirmed',
          raw_response: {
            network: d.network,
            confirmed_round: d.confirmed_round.toString(),
          },
        },
      });
      await tx.chain_deposits.update({
        where: { id: d.id },
        data: { transaction_id: t.id },
      });
      return true;
    });
  }

  // ---------------- FARM ledger -> chain reconciliation ----------------

  /**
   * dry: compare each ready wallet's internal FARM balance with its on-chain
   * FARM holding and record the difference. execute (FARM_ONCHAIN_MIRROR_ENABLED):
   * also top up positive differences from the issuer reserve. Never debits the
   * ledger; the internal ledger stays the source of truth.
   */
  async reconcile(
    adminId: string,
    mode: 'dry' | 'execute',
    limit = 100,
    address?: string,
  ) {
    const c = chainConfig();
    if (address !== undefined && !/^[A-Z2-7]{58}$/.test(address))
      throw new BadRequestException('Invalid Algorand address');
    if (!c.wallets.enabled)
      throw new ServiceUnavailableException('Chain wallets are disabled');
    if (mode === 'execute' && !c.mirror.enabled)
      throw new ServiceUnavailableException({
        message: 'Mirror is disabled',
        missing: c.mirror.missing,
      });
    const farmAsa = BigInt(process.env.FARM_ASA_ID!);
    if (mode === 'execute') {
      const busy = await this.prisma.chain_outbox.count({
        where: { status: { notIn: ['sent', 'skipped'] } },
      });
      if (busy)
        throw new BadRequestException(
          `${busy} on-chain transfers are still in flight; run again when the outbox is drained`,
        );
    }
    const ws = await this.prisma.user_chain_wallets.findMany({
      where: {
        status: 'ready',
        network: c.network,
        ...(address ? { address } : {}),
      },
      take: Math.min(Math.max(limit, 1), 500),
      orderBy: { created_at: 'asc' },
    });
    const run = await this.prisma.farm_reconciliation_runs.create({
      data: { network: c.network, mode, ledger_total: 0, started_by: adminId },
    });
    let ledgerTotal = 0;
    let chainTotal = 0;
    try {
      for (const w of ws) {
        const agg = await this.prisma.wallets.aggregate({
          where: { user_id: w.user_id, is_active: true, currency: 'FARM' },
          _sum: { balance: true },
        });
        const ledger = Number(agg._sum.balance ?? 0);
        const ledgerUnits = BigInt(Math.floor(ledger * 10 ** FARM_DECIMALS));
        const chainUnits = await this.chain.assetBalance(w.address, farmAsa);
        const delta = ledgerUnits - chainUnits;
        ledgerTotal += ledger;
        chainTotal += Number(chainUnits) / 10 ** FARM_DECIMALS;
        let status =
          delta === 0n
            ? 'matched'
            : delta > 0n
              ? 'planned'
              : 'chain_above_ledger';
        let txId: string | null = null;
        if (mode === 'execute' && delta > 0n) {
          const sk = this.chain.reserveSigner();
          try {
            const prep = await this.chain.prepareFarmTransfer({
              from: process.env.FARM_RESERVE_ADDRESS!,
              signer: sk,
              to: w.address,
              assetId: farmAsa,
              amount: delta,
              note: `farm:mirror:${run.id}:${w.user_id}`,
            });
            txId = prep.txId;
            await prep.send();
          } finally {
            sk.wipe();
          }
          status = 'sent';
        }
        await this.prisma.farm_mirror_entries.create({
          data: {
            run_id: run.id,
            user_id: w.user_id,
            address: w.address,
            ledger_bal: ledger,
            chain_bal: Number(chainUnits) / 10 ** FARM_DECIMALS,
            delta_units: delta,
            tx_id: txId,
            status,
          },
        });
      }
      await this.prisma.farm_reconciliation_runs.update({
        where: { id: run.id },
        data: {
          status: 'done',
          ledger_total: ledgerTotal,
          chain_total: chainTotal,
          wallets: ws.length,
          finished_at: new Date(),
        },
      });
    } catch (e: any) {
      await this.prisma.farm_reconciliation_runs.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          error: String(e?.message ?? e).slice(0, 300),
          ledger_total: ledgerTotal,
          finished_at: new Date(),
        },
      });
      throw new ServiceUnavailableException(
        'Reconciliation stopped; see run record',
      );
    }
    return {
      data: {
        run_id: run.id,
        mode,
        wallets: ws.length,
        ledger_total: ledgerTotal,
        chain_total: chainTotal,
      },
    };
  }

  async runs() {
    const r = await this.prisma.farm_reconciliation_runs.findMany({
      orderBy: { created_at: 'desc' },
      take: 20,
    });
    return {
      data: r.map((x) => ({
        ...x,
        ledger_total: Number(x.ledger_total),
        chain_total: x.chain_total == null ? null : Number(x.chain_total),
      })),
    };
  }

  /** Read-only go-live report (balances via algod reads; no keys used). */
  async readiness(expectedTransfers?: number) {
    const c = chainConfig();
    const users = await this.prisma.wallets.groupBy({
      by: ['user_id'],
      where: {
        is_active: true,
        currency: 'FARM',
        wallet_type: { notIn: ['platform', 'treasury'] as any },
        OR: [{ balance: { gt: 0 } }, { locked_balance: { gt: 0 } }],
      },
      _sum: { balance: true, locked_balance: true },
    });
    const ids = users.map((u) => u.user_id).filter(Boolean) as string[];
    const cws = await this.prisma.user_chain_wallets.findMany({
      where: { network: c.network },
      select: { user_id: true, address: true, status: true },
    });
    const ready = new Map(
      cws
        .filter((w) => w.status === 'ready')
        .map((w) => [w.user_id, w.address]),
    );
    const outbox = await this.prisma.chain_outbox.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    let funderAddress: string | undefined;
    try {
      if (process.env.ALGORAND_FUNDER_MNEMONIC)
        funderAddress = this.chain.funderAddress();
    } catch {
      funderAddress = undefined;
    }
    const missing = [
      ...c.wallets.missing,
      ...c.wallets.problems,
      ...c.sync.missing,
      ...c.mirror.missing,
    ];
    return chainReadiness({
      network: c.network,
      nodeUrl:
        process.env.ALGORAND_NODE_URL || 'https://mainnet-api.algonode.cloud',
      farmAsaId: process.env.FARM_ASA_ID || '',
      reserveAddress: process.env.FARM_RESERVE_ADDRESS || '',
      funderAddress,
      missingEnv: [...new Set(missing)],
      fundMicroAlgos: Number(
        process.env.CHAIN_WALLET_FUND_MICROALGOS ?? 310000,
      ),
      expectedTransfers,
      db: {
        userFarm: users.reduce(
          (a, u) =>
            a +
            Number(u._sum.balance ?? 0) +
            Number(u._sum.locked_balance ?? 0),
          0,
        ),
        usersWithBalance: ids.length,
        usersWithoutAddress: ids.filter((id) => !ready.has(id)).length,
        walletsNotReady: cws.filter((w) => w.status !== 'ready').length,
        readyAddresses: ids
          .map((id) => ready.get(id))
          .filter(Boolean) as string[],
        outbox: Object.fromEntries(
          outbox.map((o) => [o.status, o._count._all]),
        ),
      },
    });
  }
}
