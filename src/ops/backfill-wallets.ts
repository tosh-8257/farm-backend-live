import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ChainWalletService } from '../chain-wallet/chain-wallet.service';
import { validateSecurityEnvironment } from '../config/environment-validation';
import { parseBackfillArgs } from './backfill-wallets-policy';

function redact(message: string) {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]')
    .replace(/rediss?:\/\/\S+/gi, '[redacted]')
    .slice(0, 400);
}

/**
 * Render one-off. Creates custodial Algorand wallets only. It does not move
 * FARM; ledger reconcile stays on `ops:reconcile`.
 *
 *   npm run ops:backfill-wallets -- --mode=dry --limit=25
 *   npm run ops:backfill-wallets -- --mode=send --limit=25 --expect-count=25
 *
 * Dry is the default. Send refuses unless --expect-count equals the dry-run
 * `selected` count for the same --limit, and unless the funder's spendable
 * ALGO covers CHAIN_WALLET_FUND_MICROALGOS (default 310000, 0.31 ALGO) for
 * every selected user. Users with a FARM balance are first.
 */
async function main() {
  const args = parseBackfillArgs(process.argv.slice(2));
  validateSecurityEnvironment();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const svc = app.get(ChainWalletService);
    const result = await svc.operatorBackfillWallets({
      mode: args.mode,
      limit: args.limit,
      expectCount: args.expectCount,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = redact(
    error instanceof Error ? error.message : 'operator job failed',
  );
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
});
