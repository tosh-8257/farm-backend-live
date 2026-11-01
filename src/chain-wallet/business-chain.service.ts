import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { AlgorandWalletClient } from './algorand-wallet.client';
import { chainConfig } from './chain-config';
import { sealSecret, walletSigner } from './key-vault';
import { AlgoSigner, keyScheme, signerFromSeed } from './signer';
import { randomBytes } from 'crypto';
const businessWalletEnabled = () =>
  process.env.BUSINESS_WALLET_ENABLED === 'true';

const DAY = 86_400_000;

/**
 * Creates the custodial account row for a business wallet (no chain call).
 * Uses the root Prisma client (never inside a caller's DB transaction, so a
 * duplicate-key race cannot abort the caller's money transaction).
 */
export async function createBusinessChainAccount(
  prisma: any,
  businessId: string,
  walletId: string,
) {
  const existing = await prisma.business_chain_wallets.findUnique({
    where: { wallet_id: walletId },
  });
  if (existing) return existing;
  const seed = new Uint8Array(randomBytes(32));
  const s = signerFromSeed(seed, keyScheme());
  const address = s.address;
  const scheme = s.scheme;
  s.wipe();
  try {
    return await prisma.business_chain_wallets.create({
      data: {
        business_id: businessId,
        wallet_id: walletId,
        network: chainConfig().network,
        address,
        key_scheme: scheme,
        ...sealSecret(seed, address),
      },
    });
  } catch {
    return prisma.business_chain_wallets.findUnique({
      where: { wallet_id: walletId },
    });
  } finally {
    seed.fill(0);
  }
}

/**
 * Custodial Algorand account per business (merchant) wallet
 * (BUSINESS_WALLET_ENABLED + on-chain wallets configured).
 *
 * Same design as user custodial wallets and project escrows: the seed is
 * sealed with WALLET_KEY_ENCRYPTION_KEY (AAD = address), never logged or
 * returned. The funder pays the minimum balance and the FARM opt-in fee,
 * capped by BUSINESS_CHAIN_PROVISION_DAILY_MAX accounts per day (default 25).
 * Chain sync (ChainSyncService) mirrors every ledger move of the business
 * wallet through this account; until it is ready the FARM reserve backs it.
 */
@Injectable()
export class BusinessChainService {
  private readonly log = new Logger(BusinessChainService.name);
  private busy = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: AlgorandWalletClient,
  ) {}

  enabled() {
    return businessWalletEnabled() && chainConfig().wallets.enabled;
  }

  /** Account row for a business wallet; created on first call (no chain call). */
  async ensureAccount(businessId: string, walletId: string) {
    return createBusinessChainAccount(this.prisma, businessId, walletId);
  }

  private async provisionedToday() {
    return this.prisma.business_chain_wallets.count({
      where: {
        funded_tx_id: { not: null },
        updated_at: { gte: new Date(Date.now() - DAY) },
      },
    });
  }

  /**
   * ALGO top-up so the account can hold one more asset (USDC). Only the
   * shortfall is sent, capped per account (BUSINESS_CHAIN_USDC_TOPUP_MAX_MICROALGOS,
   * default 0.11 ALGO) and counted against the daily provisioning cap.
   */
  private async ensureOptInBalance(address: string) {
    const info = await this.chain.algoInfo(address);
    const need = info.minBalance + 100_000n + 2_000n; // +1 asset min balance + fee
    if (info.amount >= need) return null;
    const short = need - info.amount;
    const cap = BigInt(
      process.env.BUSINESS_CHAIN_USDC_TOPUP_MAX_MICROALGOS ?? '110000',
    );
    if (short > cap) throw new Error('USDC opt-in top-up exceeds cap');
    const max = Number(process.env.BUSINESS_CHAIN_PROVISION_DAILY_MAX ?? 25);
    if ((await this.provisionedToday()) >= max)
      throw new Error('daily business account funding cap reached');
    return this.chain.fund(address, short);
  }

  /**
   * Fund min balance + FARM and USDC opt-ins. Resumable; compare-and-set
   * claim. Also catches up ready accounts that predate the USDC opt-in: they
   * stay ready (and keep syncing FARM) if the catch-up fails.
   */
  async provision(id: string) {
    const usdcAsa = process.env.USDC_ASA_ID;
    const claim = await this.prisma.business_chain_wallets.updateMany({
      where: {
        id,
        OR: [
          { status: { in: ['created', 'failed'] } },
          ...(usdcAsa ? [{ status: 'ready', usdc_opt_in_tx: null }] : []),
        ],
      },
      data: { status: 'provisioning', error: null },
    });
    if (!claim.count) return null;
    const w = (await this.prisma.business_chain_wallets.findUnique({
      where: { id },
    }))!;
    const catchUp = !!w.funded_tx_id && !!w.farm_opt_in_tx;
    let sk: AlgoSigner | null = null;
    try {
      const data: Record<string, string> = {};
      if (!w.funded_tx_id) {
        const max = Number(
          process.env.BUSINESS_CHAIN_PROVISION_DAILY_MAX ?? 25,
        );
        if ((await this.provisionedToday()) >= max)
          throw new Error('daily business account funding cap reached');
        data.funded_tx_id = await this.chain.fund(
          w.address,
          BigInt(process.env.CHAIN_WALLET_FUND_MICROALGOS ?? '310000'),
        );
      }
      sk = walletSigner(w);
      if (!w.farm_opt_in_tx)
        data.farm_opt_in_tx = await this.chain.optIn(
          w.address,
          sk,
          BigInt(process.env.FARM_ASA_ID!),
        );
      if (usdcAsa && !w.usdc_opt_in_tx) {
        const asa = BigInt(usdcAsa);
        if (await this.chain.isOptedIn(w.address, asa)) {
          data.usdc_opt_in_tx = 'already-opted-in';
        } else {
          await this.ensureOptInBalance(w.address);
          data.usdc_opt_in_tx = await this.chain.optIn(w.address, sk, asa);
        }
      }
      return await this.prisma.business_chain_wallets.update({
        where: { id },
        data: { ...data, status: 'ready' },
      });
    } catch (e: any) {
      const msg = String(e?.message ?? 'provisioning failed').slice(0, 300);
      this.log.warn(`Business chain wallet ${id} provisioning failed: ${msg}`);
      await this.prisma.business_chain_wallets.update({
        where: { id },
        // A failed USDC catch-up never takes a working FARM account offline.
        data: { status: catchUp ? 'ready' : 'failed', error: msg },
      });
      return null;
    } finally {
      sk?.wipe();
    }
  }

  /** Creates missing accounts for linked business wallets and provisions them. */
  @Interval('business-chain-provision', 60_000)
  async tick() {
    if (!this.enabled() || this.busy) return;
    this.busy = true;
    try {
      const missing = await this.prisma.businesses.findMany({
        where: { wallet_id: { not: null }, status: 'approved' },
        select: { id: true, wallet_id: true },
        take: 50,
      });
      for (const b of missing) await this.ensureAccount(b.id, b.wallet_id!);
      const todo = await this.prisma.business_chain_wallets.findMany({
        where: {
          OR: [
            { status: { in: ['created', 'failed'] } },
            // USDC catch-up; skip ones that already failed it (error set) until retried by an admin.
            ...(process.env.USDC_ASA_ID
              ? [{ status: 'ready', usdc_opt_in_tx: null, error: null }]
              : []),
          ],
        },
        select: { id: true },
        take: 10,
      });
      for (const r of todo) await this.provision(r.id);
    } catch (e: any) {
      this.log.warn(`Business chain tick failed: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  /** Public receive details for the Business wallet page (no secrets). */
  async present(walletId: string) {
    if (!this.enabled()) return null;
    const w = await this.prisma.business_chain_wallets.findUnique({
      where: { wallet_id: walletId },
      select: {
        address: true,
        network: true,
        status: true,
        usdc_opt_in_tx: true,
      },
    });
    if (!w) return null;
    return {
      address: w.address,
      network: w.network,
      status: w.status,
      ready: w.status === 'ready',
      farm_asa_id: process.env.FARM_ASA_ID ?? null,
      usdc_asa_id: process.env.USDC_ASA_ID ?? null,
      usdc_ready: w.status === 'ready' && !!w.usdc_opt_in_tx,
    };
  }
}
