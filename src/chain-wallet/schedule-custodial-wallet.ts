import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ChainWalletService } from './chain-wallet.service';

/**
 * Fire-and-forget custodial wallet creation. Never throws: registration and
 * phone verification must succeed even when chain wallets are down.
 * mine() is idempotent and no-ops unless CHAIN_WALLETS are enabled.
 */
export function scheduleCustodialWallet(
  moduleRef: ModuleRef | undefined,
  log: Logger,
  userId: string,
) {
  if (!moduleRef || !userId) return;
  let wallets: ChainWalletService;
  try {
    wallets = moduleRef.get(ChainWalletService, { strict: false });
  } catch {
    return;
  }
  if (!wallets?.mine) return;
  void wallets.mine(userId).catch((error: unknown) => {
    log.warn(
      `Background chain wallet for ${userId} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
