import {
  CanActivate, ExecutionContext, Injectable,
  UnauthorizedException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);

  constructor(private cfg: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // Determine provider from path
    if (req.path.includes('paystack')) {
      return this.verifyPaystack(req);
    }
    if (req.path.includes('ivorypay')) {
      return this.verifyIvorypay(req);
    }
    if (req.path.includes('nowpayments')) {
      return this.verifyNowpayments(req);
    }

    this.logger.warn(`Unknown webhook path: ${req.path}`);
    throw new UnauthorizedException('Unknown webhook provider');
  }

  private verifyPaystack(req: Request): boolean {
    const secret = this.cfg.get<string>('PAYSTACK_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('PAYSTACK_WEBHOOK_SECRET not set — rejecting webhook');
      throw new UnauthorizedException('Webhook secret not configured');
    }

    const paystackSignature = req.headers['x-paystack-signature'] as string;
    if (!paystackSignature) {
      throw new UnauthorizedException('Missing Paystack signature header');
    }

    // Paystack signs the raw body with HMAC-SHA512
    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      this.logger.error('Raw body not available — ensure rawBody middleware is configured');
      throw new UnauthorizedException('Cannot verify signature without raw body');
    }

    const expected = createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');

    try {
      const sigBuffer = Buffer.from(paystackSignature, 'hex');
      const expectedBuffer = Buffer.from(expected, 'hex');

      if (sigBuffer.length !== expectedBuffer.length) {
        throw new UnauthorizedException('Paystack signature mismatch');
      }

      // Use timing-safe comparison to prevent timing attacks
      if (!timingSafeEqual(sigBuffer, expectedBuffer)) {
        throw new UnauthorizedException('Paystack signature mismatch');
      }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException('Paystack signature verification failed');
    }

    return true;
  }

  private verifyIvorypay(req: Request): boolean {
    const secret = this.cfg.get<string>('IVORYPAY_API_KEY');
    if (!secret) {
      this.logger.error(
        'IVORYPAY_API_KEY not set — rejecting IvoryPay webhook',
      );
      throw new UnauthorizedException('Webhook secret not configured');
    }

    const signature = req.headers['x-ivorypay-signature'] as string;
    if (!signature) throw new UnauthorizedException('Missing Ivorypay signature header');

    const rawBody = (req as any).rawBody;
    if (!rawBody) throw new UnauthorizedException('Cannot verify signature without raw body');

    let payloadData: string;
    try {
      const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'));
      if (!Object.prototype.hasOwnProperty.call(parsed, 'data')) {
        throw new Error('Missing IvoryPay webhook data');
      }
      payloadData = JSON.stringify(parsed.data);
    } catch (e) {
      this.logger.error('Ivorypay signature verification failed: invalid JSON payload');
      throw new UnauthorizedException('Ivorypay signature verification failed');
    }

    const expected = createHmac('sha512', secret).update(payloadData).digest('hex');

    try {
      const sigBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expected, 'hex');
      if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
        throw new UnauthorizedException('Ivorypay signature mismatch');
      }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException('Ivorypay signature verification failed');
    }

    return true;
  }

  private verifyNowpayments(req: Request): boolean {
    const secret = this.cfg.get<string>('NOWPAYMENTS_IPN_SECRET');
    if (!secret && !req.path.includes('payout')) {
      // Payment IPNs are never trusted on their own: the handler re-fetches the
      // payment from NOWPayments and validates order/amount/currency before
      // crediting. The HMAC check is an extra layer enabled by the secret.
      this.logger.warn(
        'NOWPAYMENTS_IPN_SECRET not set — skipping IPN HMAC; relying on authoritative status re-check',
      );
      return true;
    }
    if (!secret) {
      this.logger.error(
        'NOWPAYMENTS_IPN_SECRET not set — rejecting webhook',
      );
      throw new UnauthorizedException('Webhook secret not configured');
    }
    const signature = req.headers['x-nowpayments-sig'];
    if (typeof signature !== 'string' || !signature.trim()) {
      throw new UnauthorizedException('Missing NOWPayments signature');
    }
    if (!req.body || typeof req.body !== 'object') {
      throw new UnauthorizedException('Invalid NOWPayments webhook payload');
    }

    const sortObject = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortObject);
      if (!value || typeof value !== 'object') return value;
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((sorted, key) => {
          sorted[key] = sortObject(
            (value as Record<string, unknown>)[key],
          );
          return sorted;
        }, {});
    };
    const canonicalPayload = JSON.stringify(sortObject(req.body));
    const expected = createHmac('sha512', secret)
      .update(canonicalPayload)
      .digest('hex');
    const normalizedSignature = signature.trim().toLowerCase();
    if (
      !/^[0-9a-f]{128}$/.test(normalizedSignature) ||
      !timingSafeEqual(
        Buffer.from(normalizedSignature, 'hex'),
        Buffer.from(expected, 'hex'),
      )
    ) {
      throw new UnauthorizedException('NOWPayments signature mismatch');
    }
    return true;
  }
}