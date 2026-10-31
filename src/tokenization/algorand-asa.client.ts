import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import algosdk from 'algosdk';
import { algorandConfig } from './algorand-config';
import {
  AlgoSigner,
  FEE_MULTIPLIER,
  roleScheme,
  signerFromMnemonic,
} from '../chain-wallet/signer';

export interface AsaCreated {
  assetId: bigint;
  txId: string;
  confirmedRound: bigint;
  issuer: string;
}

/** Thin wrapper around algod. Secrets are read at call time and never logged. */
@Injectable()
export class AlgorandAsaClient {
  /** Issuer (manager/reserve/freeze/clawback) signer. Caller must wipe(). */
  issuerSigner(): AlgoSigner {
    try {
      return signerFromMnemonic(
        process.env.ALGORAND_ISSUER_MNEMONIC!,
        roleScheme('ALGORAND_ISSUER'),
      );
    } catch {
      throw new ServiceUnavailableException('Issuer account is misconfigured');
    }
  }

  async createAsset(p: {
    assetName: string;
    unitName: string;
    total: bigint;
    url?: string;
    note?: string;
  }): Promise<AsaCreated> {
    const cfg = algorandConfig();
    if (!cfg.enabled)
      throw new ServiceUnavailableException('Tokenization is not configured');
    const algod = new algosdk.Algodv2(
      process.env.ALGORAND_TOKEN ?? '',
      process.env.ALGORAND_NODE_URL!,
      '',
    );
    let acct: AlgoSigner;
    try {
      // ed25519 or Falcon-1024 (ALGORAND_ISSUER_KEY_SCHEME / ALGORAND_KEY_SCHEME)
      acct = signerFromMnemonic(
        process.env.ALGORAND_ISSUER_MNEMONIC!,
        roleScheme('ALGORAND_ISSUER'),
      );
    } catch {
      throw new ServiceUnavailableException('Issuer account is misconfigured');
    }
    const issuer = acct.address;
    const sp = await algod.getTransactionParams().do();
    const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
      sender: issuer,
      total: p.total,
      decimals: 0,
      defaultFrozen: false,
      unitName: p.unitName,
      assetName: p.assetName,
      assetURL: p.url,
      manager: issuer,
      reserve: issuer,
      freeze: issuer,
      clawback: issuer,
      note: p.note ? new TextEncoder().encode(p.note) : undefined,
      suggestedParams: {
        ...sp,
        flatFee: true,
        fee: BigInt(sp.minFee) * FEE_MULTIPLIER[acct.scheme],
      },
    });
    const signed = await acct.sign([txn]).finally(() => acct.wipe());
    const txId = txn.txID();
    await algod.sendRawTransaction(signed).do();
    const res = await algosdk.waitForConfirmation(algod, txId, 8);
    if (res.assetIndex == null || res.confirmedRound == null)
      throw new Error('Asset creation was not confirmed');
    return {
      assetId: BigInt(res.assetIndex),
      txId,
      confirmedRound: BigInt(res.confirmedRound),
      issuer,
    };
  }
}
