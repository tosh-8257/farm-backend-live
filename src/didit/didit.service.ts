import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export const DEVICE_RECOVERY_VENDOR_PREFIX = 'devrec:';
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
    return Object.keys(value)
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

/** Business statuses in which the owner may (re)start Didit KYB. */
const KYB_STARTABLE_BUSINESS_STATUSES = [
  'draft',
  'more_information_required',
  'rejected',
  'under_review',
];

/** Didit KYB session statuses that must not be restarted. */
const KYB_FINAL_OR_ACTIVE = new Set(['approved', 'in_review']);

/**
 * Normalises a Didit session status ("Approved", "IN_REVIEW", "In Review")
 * to a lowercase snake_case value. Returns undefined for anything that is not
 * a short status-like string.
 */
export function normalizeDiditStatus(status: unknown): string | undefined {
  if (typeof status !== 'string') return undefined;
  const value = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!/^[a-z_]{2,40}$/.test(value)) return undefined;
  return value;
}

/** Accepts Unix seconds (number or numeric string) or an ISO-8601 string. */
export function diditTimestampSeconds(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? NaN : ms / 1000;
  }
  return NaN;
}

/**
 * Didit has shipped both a flat envelope (fields at the top level) and a
 * nested one (`{ event, data: {...} }`). Merge so handlers read one shape;
 * top-level fields win.
 */
export function flattenDiditPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const data =
    payload.data &&
    typeof payload.data === 'object' &&
    !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...data, ...payload };
  if (
    typeof merged.webhook_type !== 'string' &&
    typeof payload.event === 'string'
  ) {
    merged.webhook_type = payload.event;
  }
  return merged;
}

export function isDiditKybEvent(flat: Record<string, unknown>): boolean {
  const type = typeof flat.webhook_type === 'string' ? flat.webhook_type : '';
  return (
    type.startsWith('business.') ||
    flat.session_kind === 'business' ||
    typeof flat.business_session_id === 'string'
  );
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

  /**
   * Didit session for new-device recovery. vendor_data is
   * devrec:<device_recoveries.id>; the webhook records the decision on that
   * row only and never changes users.kyc_status.
   */
  async createDeviceRecoverySession(vendorData: string) {
    if (!vendorData.startsWith(DEVICE_RECOVERY_VENDOR_PREFIX)) {
      throw new BadGatewayException('Invalid recovery session');
    }
    const apiKey = this.config.get<string>('DIDIT_API_KEY')?.trim();
    if (!apiKey) {
      throw new BadGatewayException('Didit session creation is not configured');
    }
    const workflow =
      this.config.get<string>('DIDIT_DEVICE_RECOVERY_WORKFLOW_ID')?.trim() ||
      WORKFLOW_ID;
    return this.requestSession(apiKey, workflow, vendorData, 'KYC');
  }

  private async processDeviceRecoveryWebhook(
    eventId: string,
    recoveryId: string,
    flat: Record<string, unknown>,
  ): Promise<void> {
    const status = typeof flat.status === 'string' ? flat.status : null;
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.didit_webhook_events.create({
          data: {
            event_id: eventId,
            webhook_type:
              typeof flat.webhook_type === 'string' ? flat.webhook_type : null,
            session_id:
              typeof flat.session_id === 'string' ? flat.session_id : null,
            status,
          },
        });
        if (!status || !UUID_PATTERN.test(recoveryId)) return;
        await transaction.device_recoveries.updateMany({
          where: {
            id: recoveryId,
            status: 'otp_verified',
            ...(typeof flat.session_id === 'string'
              ? { didit_session_id: flat.session_id }
              : {}),
          },
          data: { didit_status: status.slice(0, 40) },
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return;
      throw error;
    }
  }

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

    const session = await this.requestSession(
      apiKey,
      WORKFLOW_ID,
      userId,
      'KYC',
    );
    if (!session.session_token) {
      throw new BadGatewayException(
        'Didit returned an incomplete session response',
      );
    }
    return {
      url: session.url,
      session_id: session.session_id,
      session_token: session.session_token,
    };
  }

  /**
   * Starts a Didit KYB (business verification) session for the caller's
   * business. vendor_data is the business record id. The result is advisory
   * only: the business is still approved manually by an admin.
   */
  async createKybSession(userId: string) {
    const workflowId = this.config.get<string>('DIDIT_KYB_WORKFLOW_ID')?.trim();
    const apiKey = this.config.get<string>('DIDIT_API_KEY')?.trim();
    if (!workflowId || !apiKey) {
      throw new ServiceUnavailableException(
        'Business verification is not available yet. DIDIT_KYB_WORKFLOW_ID and DIDIT_API_KEY must be configured.',
      );
    }

    const business = await this.prisma.businesses.findUnique({
      where: { owner_user_id: userId },
      select: { id: true, status: true, didit_kyb_status: true },
    });
    if (!business) {
      throw new NotFoundException(
        'No business application found. Start the upgrade first.',
      );
    }
    if (business.status === 'approved') {
      throw new ConflictException('This business is already approved');
    }
    if (!KYB_STARTABLE_BUSINESS_STATUSES.includes(business.status)) {
      throw new ConflictException(
        'Business verification cannot be started in the current state',
      );
    }
    if (
      business.didit_kyb_status &&
      KYB_FINAL_OR_ACTIVE.has(business.didit_kyb_status)
    ) {
      throw new ConflictException(
        business.didit_kyb_status === 'approved'
          ? 'Business verification is already complete'
          : 'Business verification is already being reviewed',
      );
    }

    const session = await this.requestSession(
      apiKey,
      workflowId,
      business.id,
      'KYB',
    );

    await this.prisma.businesses.update({
      where: { id: business.id },
      data: {
        didit_kyb_session_id: session.session_id,
        didit_kyb_status: 'not_started',
        didit_kyb_updated_at: new Date(),
      },
    });

    return { url: session.url, session_id: session.session_id };
  }

  async getKybStatus(userId: string) {
    const business = await this.prisma.businesses.findUnique({
      where: { owner_user_id: userId },
      select: {
        id: true,
        didit_kyb_session_id: true,
        didit_kyb_status: true,
        didit_kyb_entity_status: true,
        didit_kyb_updated_at: true,
      },
    });
    if (!business) {
      throw new NotFoundException('No business application found.');
    }
    const workflow = this.config.get<string>('DIDIT_KYB_WORKFLOW_ID')?.trim();
    return {
      data: {
        configured: Boolean(workflow),
        status: business.didit_kyb_status ?? 'none',
        entity_status: business.didit_kyb_entity_status,
        session_id: business.didit_kyb_session_id,
        updated_at: business.didit_kyb_updated_at,
      },
    };
  }

  private async requestSession(
    apiKey: string,
    workflowId: string,
    vendorData: string,
    kind: 'KYC' | 'KYB',
  ): Promise<{ url: string; session_id: string; session_token?: string }> {
    let response: Response;
    try {
      response = await fetch(DIDIT_SESSION_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflow_id: workflowId,
          vendor_data: vendorData,
        }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      this.logger.error(
        `Didit ${kind === 'KYB' ? 'KYB ' : ''}session request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException('Didit session creation failed');
    }

    if (!response.ok) {
      const upstreamDetail = (await response.text())
        .replaceAll(apiKey, '[redacted]')
        .replaceAll(vendorData, '[redacted]')
        .slice(0, 1_000);
      this.logger.error(
        `Didit ${kind === 'KYB' ? 'KYB ' : ''}session request returned HTTP ${response.status}: ${upstreamDetail || '(empty response)'}`,
      );
      const message =
        response.status === 401
          ? 'Didit rejected the API key. Check that DIDIT_API_KEY is valid.'
          : response.status === 403
            ? 'Didit denied session creation. Check that the API key has write:sessions permission and belongs to the application that owns the workflow.'
            : response.status === 400
              ? `Didit rejected the workflow or session configuration. Check that the configured workflow exists, is published, and is a ${kind} workflow in the same application as the API key.`
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
    const sessionId =
      typeof values.session_id === 'string'
        ? values.session_id
        : typeof values.business_session_id === 'string'
          ? values.business_session_id
          : undefined;
    if (typeof values.url !== 'string' || !sessionId) {
      throw new BadGatewayException(
        'Didit returned an incomplete session response',
      );
    }

    return {
      url: values.url,
      session_id: sessionId,
      session_token:
        typeof values.session_token === 'string'
          ? values.session_token
          : undefined,
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

    const timestamp = diditTimestampSeconds(payload.timestamp);
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

    const flat = flattenDiditPayload(payload);
    if (isDiditKybEvent(flat)) {
      return this.processKybWebhook(eventId, flat);
    }

    const status = flat.status;
    const kycStatus = kycStatusForDiditStatus(status);
    const vendorData = flat.vendor_data;

    if (
      typeof vendorData === 'string' &&
      vendorData.startsWith(DEVICE_RECOVERY_VENDOR_PREFIX)
    ) {
      return this.processDeviceRecoveryWebhook(
        eventId,
        vendorData.slice(DEVICE_RECOVERY_VENDOR_PREFIX.length),
        flat,
      );
    }

    try {
      await this.prisma.$transaction(
        async (transaction) => {
          await transaction.didit_webhook_events.create({
            data: {
              event_id: eventId,
              webhook_type:
                typeof flat.webhook_type === 'string'
                  ? flat.webhook_type
                  : null,
              session_id:
                typeof flat.session_id === 'string' ? flat.session_id : null,
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

          // Remember the approved KYC session as the identity reference used
          // to prove account ownership during device recovery. First approval
          // wins; a later session never silently replaces the reference.
          if (kycStatus === 'verified' && typeof flat.session_id === 'string') {
            await transaction.kyc_identity_references.upsert({
              where: { user_id: vendorData },
              create: {
                user_id: vendorData,
                didit_session_id: flat.session_id.slice(0, 128),
              },
              update: {},
            });
          }
        },
        { maxWait: 1_000, timeout: 4_000 },
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) return;
      throw error;
    }
  }

  /**
   * Stores a signed Didit KYB event on the business record. Advisory only:
   * businesses.status is never changed here; an admin approves manually.
   * Idempotent on event_id via didit_webhook_events (unique).
   */
  private async processKybWebhook(
    eventId: string,
    flat: Record<string, unknown>,
  ): Promise<void> {
    const webhookType =
      typeof flat.webhook_type === 'string' ? flat.webhook_type : '';
    const isEntityEvent = webhookType.startsWith('business.');
    const sessionId =
      typeof flat.session_id === 'string'
        ? flat.session_id
        : typeof flat.business_session_id === 'string'
          ? flat.business_session_id
          : null;
    const vendorData = flat.vendor_data;
    const status = normalizeDiditStatus(flat.status);

    try {
      await this.prisma.$transaction(
        async (transaction) => {
          await transaction.didit_webhook_events.create({
            data: {
              event_id: eventId,
              webhook_type: webhookType ? webhookType.slice(0, 64) : null,
              session_id: isEntityEvent ? null : sessionId,
              status:
                typeof flat.status === 'string'
                  ? flat.status.slice(0, 64)
                  : null,
            },
          });

          if (
            typeof vendorData !== 'string' ||
            !UUID_PATTERN.test(vendorData)
          ) {
            this.logger.warn(
              `Didit KYB event ${eventId} has invalid vendor_data`,
            );
            return;
          }

          const business = await transaction.businesses.findUnique({
            where: { id: vendorData },
            select: { id: true, didit_kyb_session_id: true },
          });
          if (!business) {
            this.logger.warn(`Didit KYB event ${eventId}: unknown business`);
            return;
          }
          // Session events must belong to the session we created for this
          // business, so a stale or foreign session cannot overwrite it.
          if (
            !isEntityEvent &&
            (!sessionId || business.didit_kyb_session_id !== sessionId)
          ) {
            this.logger.warn(
              `Didit KYB event ${eventId}: session does not match business`,
            );
            return;
          }

          const result = JSON.parse(JSON.stringify(flat)) as Record<
            string,
            Prisma.InputJsonValue
          >;
          delete result.metadata;

          const data: Prisma.businessesUpdateInput = {
            didit_kyb_updated_at: new Date(),
          };
          if (isEntityEvent) {
            if (webhookType === 'business.status.updated' && status) {
              data.didit_kyb_entity_status = status.toUpperCase().slice(0, 32);
            }
            if (webhookType === 'business.data.updated') {
              // Entity profile changes are kept alongside the latest session
              // decision rather than replacing it.
              const existing = await transaction.businesses.findUnique({
                where: { id: business.id },
                select: { didit_kyb_result: true },
              });
              const prior =
                existing?.didit_kyb_result &&
                typeof existing.didit_kyb_result === 'object' &&
                !Array.isArray(existing.didit_kyb_result)
                  ? existing.didit_kyb_result
                  : {};
              data.didit_kyb_result = { ...prior, business_entity: result };
            }
          } else {
            if (status) data.didit_kyb_status = status;
            if (flat.decision && typeof flat.decision === 'object') {
              data.didit_kyb_result = result;
            } else if (webhookType === 'data.updated') {
              const existing = await transaction.businesses.findUnique({
                where: { id: business.id },
                select: { didit_kyb_result: true },
              });
              const prior =
                existing?.didit_kyb_result &&
                typeof existing.didit_kyb_result === 'object' &&
                !Array.isArray(existing.didit_kyb_result)
                  ? existing.didit_kyb_result
                  : {};
              data.didit_kyb_result = { ...prior, last_data_update: result };
            }
          }

          await transaction.businesses.update({
            where: { id: business.id },
            data,
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
