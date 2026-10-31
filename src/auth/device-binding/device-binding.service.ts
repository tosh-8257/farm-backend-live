import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  OwnerMatchResult,
  RecoveryOwnerMatchService,
} from '../../didit/recovery-owner-match.service';
import { randomBytes, randomInt } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { hashOtp, verifyOtp } from '../../common/utils/otp-hash.util';
import {
  deviceChallengeMessage,
  parseDevicePublicKey,
  verifyDeviceSignature,
} from './device-signature.util';
import { DEVICE_RECOVERY_VENDOR_PREFIX } from '../../didit/didit.service';
import { DeviceProofDto } from './dto/device-proof.dto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;
const RECOVERY_TTL_MS = 30 * 60 * 1000;
const RECOVERY_OTP_MAX_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeviceLoginResult = { trustedDeviceId: string | null };

/** Error body returned when a login comes from an untrusted device. */
export class NewDeviceException extends ForbiddenException {
  constructor(pendingDeviceId: string) {
    super({
      statusCode: 403,
      code: 'NEW_DEVICE',
      pending_device_id: pendingDeviceId,
      message:
        'New device. Approve it on your trusted phone or recover with your ID.',
    });
  }
}

@Injectable()
export class DeviceBindingService {
  private readonly logger = new Logger(DeviceBindingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly ownerMatch?: RecoveryOwnerMatchService,
  ) {}

  isEnabled(): boolean {
    return this.cfg.get<string>('DEVICE_BINDING_ENABLED') === 'true';
  }

  private otpSecret(): string {
    return (
      this.cfg.get<string>('OTP_HASH_SECRET') ||
      this.cfg.get<string>('JWT_ACCESS_SECRET') ||
      ''
    );
  }

  async audit(
    userId: string | null,
    action: string,
    entityId: string | null,
    values: Record<string, unknown>,
    ip?: string,
  ) {
    try {
      await this.prisma.audit_logs.create({
        data: {
          user_id: userId,
          action,
          entity_type: 'trusted_device',
          entity_id: entityId,
          new_values: values as never,
          ip_address: ip ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `audit ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── Challenge ───────────────────────────────────────────────────────────
  async createChallenge(deviceId: string, ip?: string) {
    const nonce = randomBytes(32).toString('base64url');
    const row = await this.prisma.device_login_challenges.create({
      data: {
        device_id: deviceId,
        nonce,
        ip_address: ip ?? null,
        expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });
    return {
      data: {
        challenge_id: row.id,
        nonce,
        expires_at: row.expires_at.toISOString(),
        message_format:
          'farm-device-login:v1:{challenge_id}:{nonce}:{device_id}',
      },
    };
  }

  /** Consumes a challenge and checks the signature. Throws on failure. */
  async verifyProof(raw: DeviceProofDto): Promise<void> {
    // The login body is a union type so the global pipe may not validate it.
    const proof = plainToInstance(DeviceProofDto, raw ?? {});
    if (
      validateSync(proof).length > 0 ||
      !UUID.test(proof.challenge_id ?? '')
    ) {
      throw new UnauthorizedException('Invalid device proof');
    }
    try {
      parseDevicePublicKey(proof.key_alg, proof.public_key);
    } catch {
      throw new BadRequestException('Invalid device public key');
    }
    const claimed = await this.prisma.device_login_challenges.updateMany({
      where: {
        id: proof.challenge_id,
        device_id: proof.device_id,
        used_at: null,
        expires_at: { gt: new Date() },
      },
      data: { used_at: new Date() },
    });
    if (claimed.count !== 1) {
      throw new UnauthorizedException('Device challenge expired or used');
    }
    const challenge = await this.prisma.device_login_challenges.findUnique({
      where: { id: proof.challenge_id },
    });
    const ok =
      !!challenge &&
      verifyDeviceSignature(
        proof.key_alg,
        proof.public_key,
        deviceChallengeMessage(challenge.id, challenge.nonce, proof.device_id),
        proof.signature,
      );
    if (!ok) throw new UnauthorizedException('Invalid device signature');
  }

  // ── Login gate ──────────────────────────────────────────────────────────
  /**
   * Called after the password (or Firebase token) is verified and before any
   * token is issued. With the flag off it is a no-op. With it on: the first
   * device is auto-trusted, a known trusted device passes, and anything else
   * becomes a pending device (NewDeviceException).
   */
  async evaluateLogin(
    userId: string,
    proof: DeviceProofDto | undefined,
    ip?: string,
  ): Promise<DeviceLoginResult> {
    if (!this.isEnabled()) return { trustedDeviceId: null };
    if (!proof) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'DEVICE_PROOF_REQUIRED',
        message: 'Please update the FARM app to sign in.',
      });
    }
    await this.verifyProof(proof);

    const devices = await this.prisma.trusted_devices.findMany({
      where: { user_id: userId },
    });
    const trusted = devices.filter(
      (d) => d.status === 'trusted' && !d.revoked_at,
    );
    const existing = devices.find((d) => d.device_id === proof.device_id);
    const meta = {
      platform: proof.platform ?? null,
      name: proof.name?.slice(0, 100) ?? null,
    };

    if (trusted.length === 0) {
      const row = await this.prisma.trusted_devices.upsert({
        where: {
          user_id_device_id: { user_id: userId, device_id: proof.device_id },
        },
        create: {
          user_id: userId,
          device_id: proof.device_id,
          public_key: proof.public_key,
          key_alg: proof.key_alg,
          ...meta,
          status: 'trusted',
          approved_at: new Date(),
          last_seen_at: new Date(),
        },
        update: {
          public_key: proof.public_key,
          key_alg: proof.key_alg,
          ...meta,
          status: 'trusted',
          approved_at: new Date(),
          revoked_at: null,
          last_seen_at: new Date(),
        },
      });
      await this.audit(userId, 'DEVICE_AUTO_TRUSTED', row.id, meta, ip);
      return { trustedDeviceId: row.id };
    }

    const match = trusted.find(
      (d) =>
        d.device_id === proof.device_id &&
        d.public_key === proof.public_key &&
        d.key_alg === proof.key_alg,
    );
    if (match) {
      await this.prisma.trusted_devices.update({
        where: { id: match.id },
        data: { last_seen_at: new Date() },
      });
      return { trustedDeviceId: match.id };
    }

    // Unknown device, revoked device, or a trusted id with a different key.
    const pending = existing
      ? await this.prisma.trusted_devices.update({
          where: { id: existing.id },
          data: {
            public_key: proof.public_key,
            key_alg: proof.key_alg,
            ...meta,
            status: 'pending',
            created_at: new Date(),
            approved_at: null,
            last_seen_at: new Date(),
          },
        })
      : await this.prisma.trusted_devices.create({
          data: {
            user_id: userId,
            device_id: proof.device_id,
            public_key: proof.public_key,
            key_alg: proof.key_alg,
            ...meta,
            status: 'pending',
            last_seen_at: new Date(),
          },
        });
    await this.audit(userId, 'DEVICE_PENDING', pending.id, meta, ip);
    try {
      await this.notifications.sendPush(
        userId,
        'New device sign-in',
        `${meta.name ?? 'A new device'} is trying to sign in to FARM. Open FARM to approve or reject it.`,
        { type: 'device_approval', pending_device_id: pending.id },
      );
    } catch (error) {
      this.logger.warn(
        `device approval push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new NewDeviceException(pending.id);
  }

  /** Refresh-token binding check. Returns false if the session must die. */
  async isSessionDeviceValid(
    trustedDeviceId: string | null | undefined,
    presentedDeviceId: string | undefined,
  ): Promise<boolean> {
    if (!trustedDeviceId) return true; // legacy / flag-off session
    const device = await this.prisma.trusted_devices.findUnique({
      where: { id: trustedDeviceId },
    });
    if (!device || device.status !== 'trusted' || device.revoked_at) {
      return false;
    }
    return presentedDeviceId === device.device_id;
  }

  // ── Pending device status (new phone polls) ─────────────────────────────
  async pendingStatus(pendingId: string, deviceId: string) {
    if (!UUID.test(pendingId)) throw new NotFoundException('Not found');
    const row = await this.prisma.trusted_devices.findUnique({
      where: { id: pendingId },
    });
    if (!row || row.device_id !== deviceId) {
      throw new NotFoundException('Not found');
    }
    let status = row.status;
    if (
      status === 'pending' &&
      Date.now() - row.created_at.getTime() > PENDING_TTL_MS
    ) {
      status = 'expired';
    }
    return { data: { status } };
  }

  // ── Trusted-device actions (signed-in) ──────────────────────────────────
  private publicView(d: {
    id: string;
    device_id: string;
    platform: string | null;
    name: string | null;
    status: string;
    created_at: Date;
    last_seen_at: Date | null;
    revoked_at: Date | null;
    approved_at: Date | null;
  }) {
    return {
      id: d.id,
      device_id: d.device_id,
      platform: d.platform,
      name: d.name,
      status: d.status,
      created_at: d.created_at,
      approved_at: d.approved_at,
      last_seen_at: d.last_seen_at,
      revoked_at: d.revoked_at,
    };
  }

  async listDevices(userId: string, currentJti?: string) {
    const [rows, current] = await Promise.all([
      this.prisma.trusted_devices.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
      }),
      this.currentDeviceId(userId, currentJti),
    ]);
    return {
      data: rows.map((r) => ({
        ...this.publicView(r),
        is_current: r.id === current,
      })),
    };
  }

  /** trusted_devices.id of the device the caller's session is bound to. */
  async currentDeviceId(userId: string, jti?: string) {
    if (!jti) return null;
    const session = await this.prisma.user_sessions.findFirst({
      where: { user_id: userId, jwt_id: jti },
      select: { trusted_device_id: true },
    });
    return session?.trusted_device_id ?? null;
  }

  private async requireTrustedCaller(userId: string, jti?: string) {
    const id = await this.currentDeviceId(userId, jti);
    const device = id
      ? await this.prisma.trusted_devices.findUnique({ where: { id } })
      : null;
    if (
      !device ||
      device.user_id !== userId ||
      device.status !== 'trusted' ||
      device.revoked_at
    ) {
      throw new ForbiddenException(
        'Only a trusted device can approve new devices',
      );
    }
    return device;
  }

  async decidePending(
    userId: string,
    jti: string | undefined,
    pendingId: string,
    approve: boolean,
    ip?: string,
  ) {
    if (!UUID.test(pendingId)) throw new NotFoundException('Not found');
    const approver = await this.requireTrustedCaller(userId, jti);
    const result = await this.prisma.trusted_devices.updateMany({
      where: {
        id: pendingId,
        user_id: userId,
        status: 'pending',
        created_at: { gt: new Date(Date.now() - PENDING_TTL_MS) },
      },
      data: approve
        ? {
            status: 'trusted',
            approved_at: new Date(),
            approved_by_device_id: approver.id,
            revoked_at: null,
          }
        : { status: 'rejected' },
    });
    if (result.count !== 1) {
      throw new NotFoundException('No pending device to decide');
    }
    await this.audit(
      userId,
      approve ? 'DEVICE_APPROVED' : 'DEVICE_REJECTED',
      pendingId,
      { approver_device_id: approver.id },
      ip,
    );
    return {
      data: { id: pendingId, status: approve ? 'trusted' : 'rejected' },
    };
  }

  async revokeDevice(
    userId: string,
    deviceRowId: string,
    actor: { id: string; admin: boolean },
    ip?: string,
  ) {
    if (!UUID.test(deviceRowId)) throw new NotFoundException('Not found');
    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.trusted_devices.updateMany({
        where: { id: deviceRowId, user_id: userId, revoked_at: null },
        data: { status: 'revoked', revoked_at: now },
      }),
      this.prisma.user_sessions.updateMany({
        where: { user_id: userId, trusted_device_id: deviceRowId },
        data: { is_revoked: true },
      }),
    ]);
    if (updated.count !== 1) throw new NotFoundException('Device not found');
    await this.audit(
      userId,
      actor.admin ? 'DEVICE_REVOKED_BY_ADMIN' : 'DEVICE_REVOKED',
      deviceRowId,
      { actor_id: actor.id },
      ip,
    );
    return { data: { id: deviceRowId, status: 'revoked' } };
  }

  // ── Recovery: SMS OTP + Didit ID check ──────────────────────────────────
  async startRecovery(pendingId: string, deviceId: string, ip?: string) {
    if (!UUID.test(pendingId)) throw new NotFoundException('Not found');
    const pending = await this.prisma.trusted_devices.findUnique({
      where: { id: pendingId },
      include: { users: { select: { id: true, phone: true } } },
    });
    if (
      !pending ||
      pending.device_id !== deviceId ||
      pending.status !== 'pending' ||
      Date.now() - pending.created_at.getTime() > PENDING_TTL_MS
    ) {
      throw new NotFoundException('No pending device to recover');
    }
    const phone = pending.users?.phone;
    if (!phone) throw new BadRequestException('No phone on this account');

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const row = await this.prisma.device_recoveries.create({
      data: {
        user_id: pending.user_id,
        trusted_device_id: pending.id,
        otp_hash: hashOtp(otp, this.otpSecret()),
        expires_at: new Date(Date.now() + RECOVERY_TTL_MS),
      },
    });
    const appHash = this.cfg.get<string>('ANDROID_SMS_APP_HASH')?.trim();
    // "<#>" prefix + trailing app hash lets Android's SMS Retriever pick it up.
    const message =
      `<#> Your FARM device recovery code is ${otp}. It expires in 30 minutes. Never share it.` +
      (appHash ? `\n${appHash}` : '');
    await this.notifications.sendSms(phone, message);
    await this.audit(
      pending.user_id,
      'DEVICE_RECOVERY_STARTED',
      pending.id,
      {
        recovery_id: row.id,
      },
      ip,
    );
    return {
      data: {
        recovery_id: row.id,
        phone_hint: phone.length > 4 ? `••••${phone.slice(-4)}` : '••••',
      },
    };
  }

  private async loadRecovery(recoveryId: string, deviceId: string) {
    if (!UUID.test(recoveryId)) throw new NotFoundException('Not found');
    const rec = await this.prisma.device_recoveries.findUnique({
      where: { id: recoveryId },
    });
    // Rows already handed to (or decided by) review stay readable after the
    // OTP window so the app can show the review outcome.
    const decided = ['manual_review', 'verifying', 'completed', 'rejected'];
    if (
      !rec ||
      (!decided.includes(rec.status) && rec.expires_at < new Date())
    ) {
      throw new NotFoundException('Recovery expired. Start again.');
    }
    const device = await this.prisma.trusted_devices.findUnique({
      where: { id: rec.trusted_device_id },
    });
    if (!device || device.device_id !== deviceId) {
      throw new NotFoundException('Not found');
    }
    return { rec, device };
  }

  /** Verifies the SMS code, then opens a Didit ID session. */
  async verifyRecoveryOtp(
    recoveryId: string,
    deviceId: string,
    otp: string,
    createIdSession: (vendorData: string) => Promise<{
      url: string;
      session_id: string;
      session_token?: string;
    }>,
    ip?: string,
  ) {
    const { rec } = await this.loadRecovery(recoveryId, deviceId);
    if (rec.status !== 'otp_sent') {
      throw new BadRequestException('Code already used');
    }
    if (rec.otp_attempts >= RECOVERY_OTP_MAX_ATTEMPTS) {
      throw new ForbiddenException('Too many attempts. Start again.');
    }
    if (!verifyOtp(rec.otp_hash, otp, this.otpSecret())) {
      await this.prisma.device_recoveries.update({
        where: { id: rec.id },
        data: { otp_attempts: { increment: 1 } },
      });
      throw new BadRequestException('Invalid code');
    }
    const session = await createIdSession(
      `${DEVICE_RECOVERY_VENDOR_PREFIX}${rec.id}`,
    );
    await this.prisma.device_recoveries.update({
      where: { id: rec.id },
      data: {
        status: 'otp_verified',
        didit_session_id: session.session_id,
      },
    });
    await this.audit(
      rec.user_id,
      'DEVICE_RECOVERY_OTP_OK',
      rec.trusted_device_id,
      {
        recovery_id: rec.id,
      },
      ip,
    );
    return {
      data: {
        id_check_url: session.url,
        session_id: session.session_id,
        session_token: session.session_token,
      },
    };
  }

  async recoveryStatus(recoveryId: string, deviceId: string) {
    const { rec } = await this.loadRecovery(recoveryId, deviceId);
    return { data: { status: rec.status, id_check: rec.didit_status } };
  }

  /** Both checks passed: revoke every other device, trust this one. */
  async completeRecovery(recoveryId: string, deviceId: string, ip?: string) {
    const { rec, device } = await this.loadRecovery(recoveryId, deviceId);
    if (rec.status === 'manual_review' || rec.status === 'verifying') {
      return { data: { status: 'manual_review' } };
    }
    if (rec.status !== 'otp_verified' || rec.didit_status !== 'Approved') {
      throw new ForbiddenException('ID check not approved yet');
    }
    // Claim the row so the (paid) owner match runs once.
    const claimed = await this.prisma.device_recoveries.updateMany({
      where: { id: rec.id, status: 'otp_verified' },
      data: { status: 'verifying' },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException('Recovery already in progress');
    }

    // Fail closed: anything other than a positive owner match goes to an
    // admin. Never auto-approved.
    const match: OwnerMatchResult = this.ownerMatch
      ? await this.ownerMatch.check(rec.user_id, rec.didit_session_id)
      : { matched: false, reasons: ['OWNER_MATCH_UNAVAILABLE'], score: null };

    if (!match.matched) {
      const reasons = match.reasons.length ? match.reasons : ['UNKNOWN'];
      await this.prisma.device_recoveries.updateMany({
        where: { id: rec.id, status: 'verifying' },
        data: {
          status: 'manual_review',
          review_reason: reasons.join(',').slice(0, 500),
          face_match_score: match.score,
        },
      });
      await this.audit(
        rec.user_id,
        'DEVICE_RECOVERY_REVIEW_REQUIRED',
        device.id,
        { recovery_id: rec.id, reasons, face_match_score: match.score },
        ip,
      );
      return { data: { status: 'manual_review' } };
    }

    await this.finalizeRecovery(rec.id, rec.user_id, device.id, ['verifying'], {
      face_match_score: match.score,
    });
    await this.audit(
      rec.user_id,
      'DEVICE_RECOVERED',
      device.id,
      { recovery_id: rec.id, owner_match: true, face_match_score: match.score },
      ip,
    );
    await this.notifyRecovered(rec.user_id);
    return { data: { status: 'trusted' } };
  }

  /** Atomically completes a recovery from one of `fromStatuses`. */
  private async finalizeRecovery(
    recoveryId: string,
    userId: string,
    trustedDeviceId: string,
    fromStatuses: string[],
    extra: Prisma.device_recoveriesUpdateManyMutationInput,
  ) {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.device_recoveries.updateMany({
        where: { id: recoveryId, status: { in: fromStatuses } },
        data: { ...extra, status: 'completed', completed_at: now },
      });
      if (claimed.count !== 1) return 0;
      await tx.trusted_devices.updateMany({
        where: {
          user_id: userId,
          id: { not: trustedDeviceId },
          revoked_at: null,
        },
        data: { status: 'revoked', revoked_at: now },
      });
      await tx.user_sessions.updateMany({
        where: { user_id: userId },
        data: { is_revoked: true },
      });
      await tx.trusted_devices.update({
        where: { id: trustedDeviceId },
        data: { status: 'trusted', approved_at: now, revoked_at: null },
      });
      return 1;
    });
    if (!result) throw new BadRequestException('Recovery already completed');
  }

  private async notifyRecovered(userId: string) {
    try {
      await this.notifications.sendSms(
        (
          await this.prisma.users.findUnique({
            where: { id: userId },
            select: { phone: true },
          })
        )?.phone ?? '',
        'FARM: your account was moved to a new phone and other devices were signed out. If this was not you, contact support now.',
      );
    } catch {
      /* best effort */
    }
  }

  // ── Admin manual review ─────────────────────────────────────────────────
  async listRecoveryReviews() {
    const rows = await this.prisma.device_recoveries.findMany({
      where: { status: { in: ['manual_review', 'verifying'] } },
      orderBy: { created_at: 'asc' },
      take: 100,
      select: {
        id: true,
        user_id: true,
        trusted_device_id: true,
        status: true,
        didit_session_id: true,
        didit_status: true,
        review_reason: true,
        face_match_score: true,
        created_at: true,
      },
    });
    return { data: rows };
  }

  async approveRecoveryReview(
    recoveryId: string,
    adminId: string,
    ip?: string,
  ) {
    const rec = await this.prisma.device_recoveries.findUnique({
      where: { id: recoveryId },
    });
    if (!rec || !['manual_review', 'verifying'].includes(rec.status)) {
      throw new NotFoundException('No recovery awaiting review');
    }
    await this.finalizeRecovery(
      rec.id,
      rec.user_id,
      rec.trusted_device_id,
      ['manual_review', 'verifying'],
      { reviewed_by: adminId, reviewed_at: new Date() },
    );
    await this.audit(
      rec.user_id,
      'DEVICE_RECOVERY_REVIEW_APPROVED',
      rec.trusted_device_id,
      { recovery_id: rec.id, admin_id: adminId, reasons: rec.review_reason },
      ip,
    );
    await this.notifyRecovered(rec.user_id);
    return { data: { status: 'completed' } };
  }

  async rejectRecoveryReview(
    recoveryId: string,
    adminId: string,
    reason: string | undefined,
    ip?: string,
  ) {
    const rec = await this.prisma.device_recoveries.findUnique({
      where: { id: recoveryId },
    });
    if (!rec || !['manual_review', 'verifying'].includes(rec.status)) {
      throw new NotFoundException('No recovery awaiting review');
    }
    const now = new Date();
    const done = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.device_recoveries.updateMany({
        where: { id: rec.id, status: { in: ['manual_review', 'verifying'] } },
        data: { status: 'rejected', reviewed_by: adminId, reviewed_at: now },
      });
      if (claimed.count !== 1) return 0;
      await tx.trusted_devices.updateMany({
        where: { id: rec.trusted_device_id, status: 'pending' },
        data: { status: 'rejected' },
      });
      return 1;
    });
    if (!done) throw new BadRequestException('Recovery already decided');
    await this.audit(
      rec.user_id,
      'DEVICE_RECOVERY_REVIEW_REJECTED',
      rec.trusted_device_id,
      {
        recovery_id: rec.id,
        admin_id: adminId,
        note: reason?.slice(0, 300) ?? null,
      },
      ip,
    );
    return { data: { status: 'rejected' } };
  }
}
