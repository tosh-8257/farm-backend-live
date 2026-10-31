import { Injectable } from '@nestjs/common';
import algosdk from 'algosdk';
import { randomBytes } from 'crypto';
import {
  AlgoSigner,
  FEE_MULTIPLIER,
  KeyScheme,
  keyScheme,
  roleScheme,
  signerFromMnemonic,
  signerFromSeed,
} from './signer';

export interface IncomingTransfer {
  txId: string;
  assetId: bigint;
  sender: string;
  receiver: string;
  amount: bigint;
  round: bigint;
}

export interface PreparedTransfer {
  txId: string;
  lastValid: bigint;
  send: () => Promise<void>;
}

/**
 * All algod/indexer access for Phase 6. Keys are only held in memory for the
 * duration of a call and never logged. FARM ASA is never created here: it is
 * created once by the owner's reserve account (MainNet asset 3759208862) and
 * referenced by FARM_ASA_ID. Keys may be ed25519 or Falcon-1024 (see signer.ts).
 */
@Injectable()
export class AlgorandWalletClient {
  private algod() {
    return new algosdk.Algodv2(
      process.env.ALGORAND_TOKEN ?? '',
      process.env.ALGORAND_NODE_URL!,
      '',
    );
  }
  private indexer() {
    return new algosdk.Indexer(
      process.env.ALGORAND_INDEXER_TOKEN ?? '',
      process.env.ALGORAND_INDEXER_URL,
      '',
    );
  }
  /** Pays ALGO: min balance for new accounts and fees (fee pooling). */
  funder(): AlgoSigner {
    return signerFromMnemonic(
      process.env.ALGORAND_FUNDER_MNEMONIC!,
      roleScheme('ALGORAND_FUNDER'),
    );
  }
  /** FARM reserve (Falcon-1024 by default). Only for server-side top-ups/sync. */
  reserveSigner(): AlgoSigner {
    const s = signerFromMnemonic(
      process.env.FARM_RESERVE_MNEMONIC!,
      roleScheme('FARM_RESERVE'),
    );
    if (s.address !== process.env.FARM_RESERVE_ADDRESS) {
      s.wipe();
      throw new Error(
        'FARM_RESERVE_MNEMONIC does not match FARM_RESERVE_ADDRESS (check FARM_RESERVE_KEY_SCHEME)',
      );
    }
    return s;
  }

  /** New custodial account. Only the 32-byte seed is kept (encrypted by the caller). */
  newAccount(scheme: KeyScheme = keyScheme()): {
    address: string;
    seed: Uint8Array;
    scheme: KeyScheme;
  } {
    const seed = new Uint8Array(randomBytes(32));
    const s = signerFromSeed(seed, scheme);
    const address = s.address;
    s.wipe();
    return { address, seed, scheme };
  }

  /** Fee for one txn signed by `scheme` (Falcon signatures cost 3x). */
  static fee(minFee: bigint | number, scheme: KeyScheme): bigint {
    return BigInt(minFee) * FEE_MULTIPLIER[scheme];
  }

  private async sendSigned(signed: Uint8Array[], txId: string) {
    const algod = this.algod();
    await algod.sendRawTransaction(signed).do();
    await algosdk.waitForConfirmation(algod, txId, 8);
    return txId;
  }

  async fund(address: string, microAlgos: bigint) {
    const f = this.funder();
    try {
      const sp = await this.algod().getTransactionParams().do();
      const t = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: f.address,
        receiver: address,
        amount: microAlgos,
        suggestedParams: {
          ...sp,
          flatFee: true,
          fee: AlgorandWalletClient.fee(sp.minFee, f.scheme),
        },
      });
      return await this.sendSigned(await f.sign([t]), t.txID());
    } finally {
      f.wipe();
    }
  }

  /** ALGO balance and min balance (microALGO) of an account. */
  async algoInfo(
    address: string,
  ): Promise<{ amount: bigint; minBalance: bigint }> {
    const a: any = await this.algod().accountInformation(address).do();
    return {
      amount: BigInt(a.amount ?? 0),
      minBalance: BigInt(a.minBalance ?? a['min-balance'] ?? 0),
    };
  }

  /** Funder ALGO payment, signed now, sent later (txId known before send). */
  async prepareFund(
    address: string,
    microAlgos: bigint,
    note: string,
  ): Promise<PreparedTransfer> {
    const f = this.funder();
    try {
      const sp = await this.algod().getTransactionParams().do();
      const t = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: f.address,
        receiver: address,
        amount: microAlgos,
        note: new TextEncoder().encode(note),
        suggestedParams: {
          ...sp,
          flatFee: true,
          fee: AlgorandWalletClient.fee(sp.minFee, f.scheme),
        },
      });
      const signed = await f.sign([t]);
      const txId = t.txID();
      return {
        txId,
        lastValid: BigInt(t.lastValid),
        send: async () => {
          await this.sendSigned(signed, txId);
        },
      };
    } finally {
      f.wipe();
    }
  }

  /** Opt-in signed by the account; its fee is paid by the funder (pooled). */
  async optIn(address: string, signer: AlgoSigner, assetId: bigint) {
    const f = this.funder();
    try {
      const sp = await this.algod().getTransactionParams().do();
      const t = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: address,
        receiver: address,
        amount: 0,
        assetIndex: assetId,
        suggestedParams: { ...sp, flatFee: true, fee: 0n },
      });
      const feePay = this.feePayment(f, sp, [signer.scheme]);
      algosdk.assignGroupID([feePay, t]);
      const signed = [...(await f.sign([feePay])), ...(await signer.sign([t]))];
      return await this.sendSigned(signed, t.txID());
    } finally {
      f.wipe();
    }
  }

  /** 0-ALGO self payment from the funder paying for itself + the others. */
  private feePayment(
    f: AlgoSigner,
    sp: algosdk.SuggestedParams,
    others: KeyScheme[],
  ) {
    const fee = [f.scheme, ...others].reduce(
      (a, s) => a + AlgorandWalletClient.fee(sp.minFee, s),
      0n,
    );
    return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: f.address,
      receiver: f.address,
      amount: 0,
      suggestedParams: { ...sp, fee, flatFee: true },
    });
  }

  /**
   * Build a FARM transfer whose fee is paid by the funder (atomic group), so
   * custodial accounts never need ALGO top-ups. The txId and lastValid are
   * known BEFORE sending, so the caller can persist them first (outbox).
   */
  async prepareFarmTransfer(p: {
    from: string;
    signer: AlgoSigner;
    to: string;
    assetId: bigint;
    amount: bigint;
    note: string;
  }): Promise<PreparedTransfer> {
    const f = this.funder();
    try {
      const sp = await this.algod().getTransactionParams().do();
      const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: p.from,
        receiver: p.to,
        amount: p.amount,
        assetIndex: p.assetId,
        note: new TextEncoder().encode(p.note),
        suggestedParams: { ...sp, fee: 0n, flatFee: true },
      });
      const feePay = this.feePayment(f, sp, [p.signer.scheme]);
      algosdk.assignGroupID([feePay, axfer]);
      const signed = [
        ...(await f.sign([feePay])),
        ...(await p.signer.sign([axfer])),
      ];
      const txId = axfer.txID();
      return {
        txId,
        lastValid: BigInt(axfer.lastValid),
        send: async () => {
          await this.sendSigned(signed, txId);
        },
      };
    } finally {
      f.wipe();
    }
  }

  /** 'confirmed' | 'pending' | 'unknown' for a txId we may have sent before. */
  async txStatus(txId: string): Promise<'confirmed' | 'pending' | 'unknown'> {
    try {
      const p = await this.algod().pendingTransactionInformation(txId).do();
      return p.confirmedRound && p.confirmedRound > 0 ? 'confirmed' : 'pending';
    } catch {
      /* not in the node's pool any more - ask the indexer */
    }
    try {
      const r = await this.indexer().lookupTransactionByID(txId).do();
      return r.transaction?.confirmedRound ? 'confirmed' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async assetBalance(address: string, assetId: bigint): Promise<bigint> {
    try {
      const r = await this.algod()
        .accountAssetInformation(address, assetId)
        .do();
      return BigInt(r.assetHolding?.amount ?? 0);
    } catch {
      return 0n;
    }
  }

  async currentRound(): Promise<bigint> {
    const s = await this.algod().status().do();
    return BigInt(s.lastRound);
  }

  /** Funder address (derived, key wiped immediately). */
  funderAddress(): string {
    const f = this.funder();
    try {
      return f.address;
    } finally {
      f.wipe();
    }
  }

  /** Native ALGO payments received by `address` since `minRound`. */
  async paymentsTo(
    address: string,
    minRound: bigint,
    limit = 200,
  ): Promise<IncomingTransfer[]> {
    const r = await this.indexer()
      .searchForTransactions()
      .address(address)
      .addressRole('receiver')
      .txType('pay')
      .minRound(minRound)
      .limit(limit)
      .do();
    return (r.transactions ?? [])
      .filter((t) => t.paymentTransaction && t.id && t.confirmedRound != null)
      .map((t) => ({
        txId: t.id!,
        assetId: 0n,
        sender: t.sender,
        receiver: t.paymentTransaction!.receiver,
        amount: BigInt(t.paymentTransaction!.amount),
        round: BigInt(t.confirmedRound!),
      }));
  }

  async transfersSince(
    assetId: bigint,
    minRound: bigint,
    limit = 500,
  ): Promise<IncomingTransfer[]> {
    const r = await this.indexer()
      .searchForTransactions()
      .assetID(assetId)
      .txType('axfer')
      .minRound(minRound)
      .limit(limit)
      .do();
    return (r.transactions ?? [])
      .filter(
        (t) => t.assetTransferTransaction && t.id && t.confirmedRound != null,
      )
      .map((t) => ({
        txId: t.id!,
        assetId,
        sender: t.sender,
        receiver: t.assetTransferTransaction!.receiver,
        amount: BigInt(t.assetTransferTransaction!.amount),
        round: BigInt(t.confirmedRound!),
      }));
  }
}
