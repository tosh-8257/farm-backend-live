import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ChainWalletService } from '../chain-wallet/chain-wallet.service';
import { validateSecurityEnvironment } from '../config/environment-validation';
import { parseCreditArgs } from './reconcile-policy';

function redact(message: string) {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]')
    .replace(/rediss?:\/\/\S+/gi, '[redacted]')
    .slice(0, 400);
}

/**
 * Render one-off. Dry unless --mode=send.
 *   npm run ops:credit-deposit -- --tx=TXID
 *   npm run ops:credit-deposit -- --tx=TXID --mode=send --asset=FARM
 * Prints the tx id only (plus asset and whether it credited). No secrets.
 */
async function main() {
  const args = parseCreditArgs(process.argv.slice(2));
  if (!args.tx) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: '--tx is required' })}\n`,
    );
    process.exit(1);
  }
  validateSecurityEnvironment();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const svc = app.get(ChainWalletService);
    const result = await svc.creditDepositByTx({
      txId: args.tx,
      asset: args.asset,
      network: args.network,
      dry: !args.send,
      actorId: null,
    });
    process.stdout.write(
      `${JSON.stringify({
        mode: result.data.mode,
        tx_id: result.data.tx_id,
        asset: result.data.asset,
        credited: result.data.credited ?? false,
        already_credited: result.data.already_credited,
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
