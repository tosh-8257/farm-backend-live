import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { verify } from 'jsonwebtoken';
import type { Request } from 'express';

/**
 * Rate-limit key. Authenticated calls are counted per user so customers
 * behind the same mobile-carrier address do not share a bucket. The signature
 * is checked and expiry is ignored, so a request whose access token just
 * expired still belongs to that user while the app refreshes. Anonymous
 * calls fall back to req.ip, which respects Express trust proxy (one hop on
 * Render) and does not trust a client-supplied X-Forwarded-For.
 */
export function rateLimitTracker(req: Request): string {
  const userId = userIdFromRequest(req);
  if (userId) return `user:${userId}`;
  const ip = req.ip || req.ips?.[0] || 'unknown';
  return `ip:${ip}`;
}

function userIdFromRequest(req: Request): string | null {
  const header = req.headers?.authorization;
  const access = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const fromAccess = subjectIfSigned(access, process.env.JWT_ACCESS_SECRET);
  if (fromAccess) return fromAccess;
  const body = req.body as { refresh_token?: unknown } | undefined;
  const refresh =
    typeof body?.refresh_token === 'string' ? body.refresh_token : '';
  return subjectIfSigned(refresh, process.env.JWT_REFRESH_SECRET);
}

function subjectIfSigned(
  token: string,
  secret: string | undefined,
): string | null {
  if (!token || !secret) return null;
  try {
    const payload = verify(token, secret, { ignoreExpiration: true });
    if (!payload || typeof payload === 'string' || !payload.sub) return null;
    return String(payload.sub);
  } catch {
    return null;
  }
}

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(rateLimitTracker(req as Request));
  }
}
