import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../../database/prisma.service';

// Paths that trigger automatic audit logging regardless of service-level logging
const AUDITED_PATHS = [
  '/admin',
  '/kyc',
  '/payments',
  '/auth',
  '/security',
  '/users',
  '/transactions',
  '/withdraw',
  '/deposit',
  '/transfer-requests',
  '/settings',
  '/merchant',
  '/escrow',
  '/investments',
  '/wallet',
  '/device-token',
];

@Injectable()
export class AuditMiddleware implements NestMiddleware {
  private readonly logger = new Logger('AuditMiddleware');

  constructor(private prisma: PrismaService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const shouldAudit = AUDITED_PATHS.some((p) => req.path.includes(p));
    if (!shouldAudit || req.method === 'GET') return next();

    // Log after response is sent
    const originalSend = res.send.bind(res);
    res.send = (body: any) => {
      const user = (req as any).user;
      if (user?.id) {
        // Fire and forget — don't block the response
        this.prisma.audit_logs
          .create({
            data: {
              user_id: user.id,
              action: `${req.method} ${req.path}`,
              entity_type: req.path.split('/')[2] ?? 'unknown',
              ip_address: req.ip ?? null,
              user_agent: req.headers['user-agent'] ?? null,
              new_values: {
                body: this.sanitize(req.body),
                status: res.statusCode,
                request_id: (req as any).requestId,
              },
            },
          })
          .catch((e) => this.logger.error('Audit log failed:', e));
      }
      return originalSend(body);
    };

    next();
  }

  // Strip sensitive fields before logging
  private sanitize(body: any): any {
    return redactAuditBody(body);
  }
}

const SENSITIVE_PARTS = new Set([
  'pin',
  'password',
  'otp',
  'token',
  'secret',
  'mnemonic',
  'fingerprint',
  'authorization',
  'cookie',
  'pwd',
]);

function sensitiveKey(key: string) {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return parts.some((part) => SENSITIVE_PARTS.has(part));
}

/** Redact credentials before they are written to audit_logs. */
export function redactAuditBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map((item) => redactAuditBody(item));
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (sensitiveKey(key)) {
      clean[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      clean[key] = redactAuditBody(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}
