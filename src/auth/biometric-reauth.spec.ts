import { ForbiddenException } from '@nestjs/common';
import { AuthService } from './auth.service';

function service(opts: {
  enabled?: boolean;
  device?: any;
  bio?: any;
  user?: any;
}) {
  const prisma: any = {
    trusted_devices: {
      findFirst: jest.fn().mockResolvedValue(opts.device ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
    biometric_settings: {
      findUnique: jest.fn().mockResolvedValue(opts.bio ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
    users: {
      findUnique: jest.fn().mockResolvedValue(
        opts.user ?? {
          id: 'user-1',
          is_deleted: false,
          is_suspended: false,
          is_active: true,
          role: 'user',
          first_name: 'A',
          last_name: 'B',
          username: 'ab',
          phone: '+254700000000',
          email: null,
          kyc_status: 'none',
          kyc_level: 0,
          phone_verified: true,
          pin_hash: 'x',
          profile_image: null,
          wallets: [{ id: 'w1' }],
        },
      ),
    },
    user_sessions: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    security_events: { create: jest.fn().mockResolvedValue({}) },
  };
  const jwt = {
    signAsync: jest
      .fn()
      .mockResolvedValueOnce('access')
      .mockResolvedValueOnce('refresh'),
  };
  const cfg = {
    get: (key: string) => {
      if (key === 'JWT_ACCESS_SECRET') return 'a'.repeat(40);
      if (key === 'JWT_REFRESH_SECRET') return 'b'.repeat(40);
      if (key === 'JWT_ACCESS_EXPIRES') return '15m';
      if (key === 'JWT_REFRESH_EXPIRES') return '90d';
      return undefined;
    },
  };
  const devices = {
    isEnabled: () => true,
    verifyProof: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new AuthService(
    prisma,
    jwt as any,
    cfg as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    devices as any,
  );
  return { svc, prisma, devices };
}

const proof = {
  device_id: 'dev-1',
  public_key: 'pk',
  key_alg: 'ed25519',
  challenge_id: '00000000-0000-4000-8000-000000000001',
  signature: 'sig',
} as any;

describe('biometric re-auth', () => {
  const prev = process.env.LONG_LIVED_SESSIONS_ENABLED;

  afterEach(() => {
    if (prev === undefined) delete process.env.LONG_LIVED_SESSIONS_ENABLED;
    else process.env.LONG_LIVED_SESSIONS_ENABLED = prev;
  });

  it('stays closed when the flag is off', async () => {
    delete process.env.LONG_LIVED_SESSIONS_ENABLED;
    const { svc } = service({});
    await expect(
      svc.biometricReauth({ device: proof }, '1.1.1.1', 'jest'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('issues a long-lived session for a trusted device with biometrics', async () => {
    process.env.LONG_LIVED_SESSIONS_ENABLED = 'true';
    const { svc, prisma } = service({
      device: {
        id: 'td-1',
        user_id: 'user-1',
        name: 'Phone',
        platform: 'android',
      },
      bio: { enabled: true, device_id: 'dev-1' },
    });
    const result = await svc.biometricReauth(
      { device: proof },
      '1.1.1.1',
      'app',
    );
    expect(result.data.reauth).toBe('biometric');
    expect(result.data.requiresPhoneVerification).toBe(false);
    expect(result.data.refresh_token).toBe('refresh');
    expect(result.data.refresh_expires_in).toBe(90 * 86_400);
    expect(prisma.user_sessions.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trusted_device_id: 'td-1',
        user_id: 'user-1',
        expires_at: expect.any(Date),
      }),
    });
  });
});
