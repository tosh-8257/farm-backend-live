import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';

const WORKFLOW_ID = '9d75ebb3-2dbe-410e-9062-5c84c41af087';
const DIDIT_SESSION_URL = 'https://verification.didit.me/v3/session/';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type KycStatus =
  | 'none'
  | 'pending'
  | 'verified'
  | 'rejected'
  | 'under_review'
  | 'additional_info_required';

export function shortenFloats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shortenFloats);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        shortenFloats(item),
      ]),
    );
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return Math.trunc(value);
  }
  return value;
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as object)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortKeys((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

export function canonicalizeDiditPayload(payload: unknown): string {
  return JSON.stringify(sortKeys(shortenFloats(payload)));
}

export function kycStatusForDiditStatus(
  status: unknown,
): KycStatus | undefined {
  switch (status) {
    case 'Approved':
      return 'verified';
    case 'Declined':
      return 'rejected';
    case 'In Review':
      return 'under_review';
    case 'Resubmitted':
      return 'additional_info_required';
    case 'Kyc Expired':
      return 'none';
    case 'Not Started':
    case 'In Progress':
    case 'Awaiting User':
    case 'Abandoned':
    case 'Expired':
      return 'pending';
    default:
      return undefined;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

@Injectable()
export class DiditService {
  private readonly logger = new Logger(DiditService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async createSession(userId: string) {
    // Any previous status (none, rejected via the old manual flow, declined,
    // abandoned, ...) may start a new Didit session. Only already-verified
    // users are stopped, so a manual approval is never overwritten.
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { kyc_status: true },
    });
    if (user?.kyc_status === 'verified') {
      throw new ConflictException('Identity is already verified');
    }

    const apiKey = this.config.get<string>('DIDIT_API_KEY')?.trim();
    if (!apiKey) {
      throw new BadGatewayException('Didit session creation is not configured');
    }

    let response: Response;
    try {
      response = await fetch(DIDIT_SESSION_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflow_id: WORKFLOW_ID,
          vendor_data: userId,
        }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      this.logger.error(
        `Didit session request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException('Didit session creation failed');
    }

    if (!response.ok) {
      const upstreamDetail = (await response.text())
        .replaceAll(apiKey, '[redacted]')
        .replaceAll(userId, '[redacted]')
        .slice(0, 1_000);
      this.logger.error(
        `Didit session request returned HTTP ${response.status}: ${upstreamDetail || '(empty response)'}`,
      );
      const message =
        response.status === 401
          ? 'Didit rejected the API key. Check that DIDIT_API_KEY is valid.'
          : response.status === 403
            ? 'Didit denied session creation. Check that the API key has write:sessions permission and belongs to the application that owns the workflow.'
            : response.status === 400
              ? 'Didit rejected the workflow or session configuration. Check that the configured workflow exists, is published, and is a KYC workflow in the same application as the API key.'
              : response.status === 429
                ? 'Didit is rate-limiting session creation. Wait briefly and try again.'
                : `Didit session creation failed (HTTP ${response.status}). Check the backend logs for the sanitized provider response.`;
      throw new BadGatewayException(message);
    }

    let session: unknown;
    try {
      session = await response.json();
    } catch {
      throw new BadGatewayException(
        'Didit returned an invalid session response',
      );
    }

    if (!session || typeof session !== 'object') {
      throw new BadGatewayException(
        'Didit returned an invalid session response',
      );
    }

    const values = session as Record<string, unknown>;
    if (
      typeof values.url !== 'string' ||
      typeof values.session_id !== 'string' ||
      typeof values.session_token !== 'string'
    ) {
      throw new BadGatewayException(
        'Didit returned an incomplete session response',
      );
    }

    return {
      url: values.url,
      session_id: values.session_id,
      session_token: values.session_token,
    };
  }

  async processWebhook(
    payload: Record<string, unknown>,
    signature: string,
  ): Promise<void> {
    const secret = this.config.get<string>('DIDIT_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('DIDIT_WEBHOOK_SECRET is not configured');
      throw new InternalServerErrorException(
        'Webhook verification is not configured',
      );
    }

    if (!/^[a-f\d]{64}$/i.test(signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const expected = createHmac('sha256', secret)
      .update(canonicalizeDiditPayload(payload), 'utf8')
      .digest();
    const received = Buffer.from(signature, 'hex');
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const timestamp = Number(payload.timestamp);
    if (
      !Number.isFinite(timestamp) ||
      timestamp <= 0 ||
      Math.abs(Date.now() / 1000 - timestamp) > 300
    ) {
      throw new UnauthorizedException('Stale webhook');
    }

    const eventId = payload.event_id;
    if (
      typeof eventId !== 'string' ||
      eventId.length === 0 ||
      eventId.length > 128
    ) {
      throw new UnauthorizedException('Invalid webhook event ID');
    }

    const status = payload.status;
    const kycStatus = kycStatusForDiditStatus(status);
    const vendorData = payload.vendor_data;

    try {
      await this.prisma.$transaction(
        async (transaction) => {
          await transaction.didit_webhook_events.create({
            data: {
              event_id: eventId,
              webhook_type:
                typeof payload.webhook_type === 'string'
                  ? payload.webhook_type
                  : null,
              session_id:
                typeof payload.session_id === 'string'
                  ? payload.session_id
                  : null,
              status: typeof status === 'string' ? status : null,
            },
          });

          if (!kycStatus) {
            this.logger.warn(
              `Ignoring unsupported Didit status: ${String(status)}`,
            );
            return;
          }

          if (
            typeof vendorData !== 'string' ||
            !UUID_PATTERN.test(vendorData)
          ) {
            this.logger.warn(`Didit event ${eventId} has invalid vendor_data`);
            return;
          }

          // users.kyc_status is the single source of truth and is driven by
          // Didit decisions. Historical manual kyc_documents rows are left
          // untouched (audit trail). A user who is already verified (e.g.
          // approved via the legacy manual flow) is never downgraded by a
          // non-approval Didit event.
          await transaction.users.updateMany({
            where:
              kycStatus === 'verified'
                ? { id: vendorData }
                : { id: vendorData, NOT: { kyc_status: 'verified' } },
            data: { kyc_status: kycStatus },
          });
        },
        { maxWait: 1_000, timeout: 4_000 },
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) return;
      throw error;
    }
  }
}
