import { NotFoundException } from '@nestjs/common';
import { DeviceBindingService } from './device-binding.service';

const REC = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const DEV = 'device-abcdef-1';
const ADMIN = '33333333-3333-4333-8333-333333333333';

function build(
  recStatus = 'otp_verified',
  match: {
    matched: boolean;
    reasons: string[];
    score: number | null;
  } | null = null,
) {
  const rec = {
    id: REC,
    user_id: USER,
    trusted_device_id: 'td-1',
    status: recStatus,
    didit_status: 'Approved',
    didit_session_id: 'sess-1',
    review_reason: null,
    expires_at: new Date(Date.now() + 60_000),
  };
  const tx = {
    device_recoveries: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    trusted_devices: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    user_sessions: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    device_recoveries: {
      findUnique: jest.fn().mockResolvedValue(rec),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([rec]),
    },
    trusted_devices: {
      findUnique: jest.fn().mockResolvedValue({ id: 'td-1', device_id: DEV }),
    },
    users: { findUnique: jest.fn().mockResolvedValue({ phone: '+254700' }) },
    audit_logs: { create: jest.fn() },
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const cfg = { get: jest.fn(() => 'true') };
  const notifications = { sendSms: jest.fn(), sendPush: jest.fn() };
  const ownerMatch = match
    ? { check: jest.fn().mockResolvedValue(match) }
    : undefined;
  const svc = new DeviceBindingService(
    prisma as never,
    cfg as never,
    notifications as never,
    ownerMatch as never,
  );
  const actions = () =>
    prisma.audit_logs.create.mock.calls.map(
      (c: [{ data: { action: string } }]) => c[0].data.action,
    );
  return { svc, prisma, tx, ownerMatch, actions };
}

describe('device recovery owner match', () => {
  it('completes only after a positive owner match', async () => {
    const t = build('otp_verified', {
      matched: true,
      reasons: [],
      score: 91,
    });
    const r = await t.svc.completeRecovery(REC, DEV);
    expect(r).toEqual({ data: { status: 'trusted' } });
    expect(t.ownerMatch?.check).toHaveBeenCalledWith(USER, 'sess-1');
    expect(t.tx.user_sessions.updateMany).toHaveBeenCalled();
    expect(t.actions()).toContain('DEVICE_RECOVERED');
  });

  it('routes a mismatch to manual review and never trusts the device', async () => {
    const t = build('otp_verified', {
      matched: false,
      reasons: ['FACE_MATCH_BELOW_THRESHOLD'],
      score: 40,
    });
    const r = await t.svc.completeRecovery(REC, DEV);
    expect(r).toEqual({ data: { status: 'manual_review' } });
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
    expect(t.tx.trusted_devices.update).not.toHaveBeenCalled();
    expect(t.prisma.device_recoveries.updateMany).toHaveBeenLastCalledWith({
      where: { id: REC, status: 'verifying' },
      data: {
        status: 'manual_review',
        review_reason: 'FACE_MATCH_BELOW_THRESHOLD',
        face_match_score: 40,
      },
    });
    expect(t.actions()).toContain('DEVICE_RECOVERY_REVIEW_REQUIRED');
  });

  it('fails closed to review when the owner-match service is missing', async () => {
    const t = build('otp_verified', null);
    const r = await t.svc.completeRecovery(REC, DEV);
    expect(r.data.status).toBe('manual_review');
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('still requires an approved Didit decision first', async () => {
    const t = build('otp_sent', { matched: true, reasons: [], score: 99 });
    await expect(t.svc.completeRecovery(REC, DEV)).rejects.toThrow(
      'ID check not approved yet',
    );
    expect(t.ownerMatch?.check).not.toHaveBeenCalled();
  });

  it('reports manual_review on repeat completes without re-checking', async () => {
    const t = build('manual_review', { matched: true, reasons: [], score: 99 });
    expect(await t.svc.completeRecovery(REC, DEV)).toEqual({
      data: { status: 'manual_review' },
    });
    expect(t.ownerMatch?.check).not.toHaveBeenCalled();
  });
});

describe('admin recovery review', () => {
  it('approve completes the recovery with an audit entry', async () => {
    const t = build('manual_review');
    const r = await t.svc.approveRecoveryReview(REC, ADMIN, '1.2.3.4');
    expect(r).toEqual({ data: { status: 'completed' } });
    expect(t.tx.device_recoveries.updateMany).toHaveBeenCalledWith({
      where: { id: REC, status: { in: ['manual_review', 'verifying'] } },
      data: expect.objectContaining({
        status: 'completed',
        reviewed_by: ADMIN,
      }) as unknown,
    });
    expect(t.tx.trusted_devices.update).toHaveBeenCalled();
    expect(t.actions()).toContain('DEVICE_RECOVERY_REVIEW_APPROVED');
  });

  it('reject marks the recovery and pending device rejected', async () => {
    const t = build('manual_review');
    const r = await t.svc.rejectRecoveryReview(REC, ADMIN, 'face differs');
    expect(r).toEqual({ data: { status: 'rejected' } });
    expect(t.tx.trusted_devices.updateMany).toHaveBeenCalledWith({
      where: { id: 'td-1', status: 'pending' },
      data: { status: 'rejected' },
    });
    expect(t.tx.user_sessions.updateMany).not.toHaveBeenCalled();
    expect(t.actions()).toContain('DEVICE_RECOVERY_REVIEW_REJECTED');
  });

  it('cannot approve a recovery that is not under review', async () => {
    const t = build('otp_verified');
    await expect(t.svc.approveRecoveryReview(REC, ADMIN)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lists recoveries awaiting review', async () => {
    const t = build('manual_review');
    const r = await t.svc.listRecoveryReviews();
    expect(r.data).toHaveLength(1);
  });
});
