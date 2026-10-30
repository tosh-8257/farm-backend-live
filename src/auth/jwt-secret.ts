import { ConfigService } from '@nestjs/config';

/**
 * Returns the JWT access secret or throws. There is deliberately no fallback:
 * a missing secret must stop the app instead of signing tokens with a known key.
 */
export function requireJwtAccessSecret(cfg: ConfigService): string {
  const secret = cfg.get<string>('JWT_ACCESS_SECRET')?.trim();
  if (!secret) {
    throw new Error('JWT_ACCESS_SECRET is not configured. Refusing to start.');
  }
  return secret;
}
