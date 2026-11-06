import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ChainWalletService } from '../chain-wallet/chain-wallet.service';
import { validateSecurityEnvironment } from '../config/environment-validation';
import { parseReconcileArgs } from './reconcile-policy';

function redact(message: string) {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]')
    .replace(/rediss?:\/\/\S+/gi, '[redacted]')
    .slice(0, 400);
}

/**
 * Render one-off:
 *   npm run ops:reconcile -- --mode=dry --limit=100
 *   npm run ops:reconcile -- --mode=send --limit=100 --expect-total=123.45
 * Dry is the default. Send refuses unless --expect-total matches the dry-run
 * total. Output is tx ids and totals only.
 */
async function main() {
  const args = parseReconcileArgs(process.argv.slice(2));
  validateSecurityEnvironment();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const svc = app.get(ChainWalletService);
    const result = await svc.operatorReconcile({
      mode: args.mode,
      limit: args.limit,
      expectTotal: args.expectTotal,
      actorId: null,
    });
    process.stdout.write(
      `${JSON.stringify({
        mode: result.mode,
        wallets: result.wallets,
        positive_total: result.positive_total,
        tx_ids: result.tx_ids,
      })}\n`,
    );
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
