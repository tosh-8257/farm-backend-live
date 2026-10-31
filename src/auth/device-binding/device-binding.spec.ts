import { generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  deviceChallengeMessage,
  verifyDeviceSignature,
} from './device-signature.util';
import {
  DeviceBindingService,
  NewDeviceException,
} from './device-binding.service';

const CH = '11111111-1111-4111-8111-111111111111';
const DEV = 'device-abc-123';

function ed() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { pub: raw.toString('base64'), privateKey };
}
function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  return {
    pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey,
  };
}
function signEd(k: KeyObject, msg: Buffer) {
  return sign(null, msg, k).toString('base64');
}

describe('verifyDeviceSignature', () => {
  const msg = deviceChallengeMessage(CH, 'nonce', DEV);
  it('accepts raw ed25519 keys', () => {
    const k = ed();
    expect(
      verifyDeviceSignature('ed25519', k.pub, msg, signEd(k.privateKey, msg)),
    ).toBe(true);
  });
  it('accepts p256 with DER and raw r||s signatures', () => {
    const k = p256();
    const der = sign('sha256', msg, k.privateKey).toString('base64');
    const raw = sign('sha256', msg, {
      key: k.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64');
    expect(verifyDeviceSignature('p256', k.pub, msg, der)).toBe(true);
    expect(verifyDeviceSignature('p256', k.pub, msg, raw)).toBe(true);
  });
  it('rejects wrong message, wrong key type and garbage', () => {
    const k = ed();
    const sig = signEd(k.privateKey, msg);
    expect(verifyDeviceSignature('ed25519', k.pub, Buffer.from('x'), sig)).toBe(
      false,
    );
    expect(verifyDeviceSignature('p256', k.pub, msg, sig)).toBe(false);
    expect(verifyDeviceSignature('ed25519', 'AAAA', msg, sig)).toBe(false);
  });
});

function build(enabled = true, devices: Record<string, unknown>[] = []) {
  const prisma = {
    device_login_challenges: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: CH, nonce: 'n0nce' }),
    },
    trusted_devices: {
      findMany: jest.fn().mockResolvedValue(devices),
      upsert: jest.fn().mockResolvedValue({ id: 'dev-row-1' }),
      update: jest.fn().mockResolvedValue({ id: 'dev-row-x' }),
      create: jest.fn().mockResolvedValue({ id: 'pending-1' }),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user_sessions: { findFirst: jest.fn(), updateMany: jest.fn() },
    audit_logs: { create: jest.fn() },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
  const cfg = {
    get: jest.fn((k: string) =>
      k === 'DEVICE_BINDING_ENABLED' ? String(enabled) : 'secret',
    ),
  };
  const notifications = { sendPush: jest.fn(), sendSms: jest.fn() };
  const svc = new DeviceBindingService(
    prisma as never,
    cfg as never,
    notifications as never,
  );
  return { svc, prisma, notifications };
}

function proof(k = ed()) {
  return {
    key: k,
    dto: {
      device_id: DEV,
      public_key: k.pub,
      key_alg: 'ed25519' as const,
      challenge_id: CH,
      signature: signEd(k.privateKey, deviceChallengeMessage(CH, 'n0nce', DEV)),
      platform: 'android',
      name: 'Pixel',
    },
  };
}

describe('DeviceBindingService.evaluateLogin', () => {
  it('is a no-op when the flag is off', async () => {
    const { svc, prisma } = build(false);
    await expect(svc.evaluateLogin('u1', undefined)).resolves.toEqual({
      trustedDeviceId: null,
    });
    expect(prisma.trusted_devices.findMany).not.toHaveBeenCalled();
  });

  it('requires a device proof when enabled', async () => {
    const { svc } = build(true);
    await expect(svc.evaluateLogin('u1', undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('auto-trusts the first device and audits it', async () => {
    const { svc, prisma } = build(true, []);
    const res = await svc.evaluateLogin('u1', proof().dto);
    expect(res.trustedDeviceId).toBe('dev-row-1');
    expect(prisma.trusted_devices.upsert.mock.calls[0][0].create.status).toBe(
      'trusted',
    );
    expect(prisma.audit_logs.create.mock.calls[0][0].data.action).toBe(
      'DEVICE_AUTO_TRUSTED',
    );
  });

  it('passes a known trusted device', async () => {
    const p = proof();
    const { svc } = build(true, [
      {
        id: 'd1',
        device_id: DEV,
        public_key: p.key.pub,
        key_alg: 'ed25519',
        status: 'trusted',
        revoked_at: null,
      },
    ]);
    await expect(svc.evaluateLogin('u1', p.dto)).resolves.toEqual({
      trustedDeviceId: 'd1',
    });
  });

  it('blocks a new device, records it pending and pushes the trusted phone', async () => {
    const { svc, prisma, notifications } = build(true, [
      {
        id: 'd1',
        device_id: 'other-device-1',
        public_key: 'x',
        key_alg: 'ed25519',
        status: 'trusted',
        revoked_at: null,
      },
    ]);
    await expect(svc.evaluateLogin('u1', proof().dto)).rejects.toBeInstanceOf(
      NewDeviceException,
    );
    expect(prisma.trusted_devices.create.mock.calls[0][0].data.status).toBe(
      'pending',
    );
    expect(notifications.sendPush).toHaveBeenCalled();
  });

  it('treats a trusted device id with a different key as new', async () => {
    const { svc } = build(true, [
      {
        id: 'd1',
        device_id: DEV,
        public_key: ed().pub,
        key_alg: 'ed25519',
        status: 'trusted',
        revoked_at: null,
      },
    ]);
    await expect(svc.evaluateLogin('u1', proof().dto)).rejects.toBeInstanceOf(
      NewDeviceException,
    );
  });

  it('rejects a bad signature and a reused challenge', async () => {
    const { svc, prisma } = build(true, []);
    const bad = { ...proof().dto, signature: proof().dto.signature };
    bad.public_key = ed().pub;
    await expect(svc.evaluateLogin('u1', bad)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    prisma.device_login_challenges.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await expect(svc.evaluateLogin('u1', proof().dto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('DeviceBindingService sessions and approvals', () => {
  it('ties refresh tokens to the trusted device', async () => {
    const { svc, prisma } = build();
    expect(await svc.isSessionDeviceValid(null, undefined)).toBe(true);
    prisma.trusted_devices.findUnique.mockResolvedValue({
      device_id: DEV,
      status: 'trusted',
      revoked_at: null,
    });
    expect(await svc.isSessionDeviceValid('d1', DEV)).toBe(true);
    expect(await svc.isSessionDeviceValid('d1', 'someone-else')).toBe(false);
    prisma.trusted_devices.findUnique.mockResolvedValue({
      device_id: DEV,
      status: 'revoked',
      revoked_at: new Date(),
    });
    expect(await svc.isSessionDeviceValid('d1', DEV)).toBe(false);
  });

  it('only a session bound to a trusted device may approve', async () => {
    const { svc, prisma } = build();
    prisma.user_sessions.findFirst.mockResolvedValue({
      trusted_device_id: null,
    });
    await expect(
      svc.decidePending('u1', 'jti', CH, true),
    ).rejects.toBeInstanceOf(ForbiddenException);

    prisma.user_sessions.findFirst.mockResolvedValue({
      trusted_device_id: 'd1',
    });
    prisma.trusted_devices.findUnique.mockResolvedValue({
      id: 'd1',
      user_id: 'u1',
      status: 'trusted',
      revoked_at: null,
    });
    await expect(svc.decidePending('u1', 'jti', CH, true)).resolves.toEqual({
      data: { id: CH, status: 'trusted' },
    });
    expect(prisma.audit_logs.create.mock.calls[0][0].data.action).toBe(
      'DEVICE_APPROVED',
    );
  });

  it('revoking a device also revokes its sessions', async () => {
    const { svc, prisma } = build();
    await svc.revokeDevice('u1', CH, { id: 'admin', admin: true });
    expect(prisma.user_sessions.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'u1', trusted_device_id: CH },
      data: { is_revoked: true },
    });
  });
});
