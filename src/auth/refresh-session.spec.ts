import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn().mockResolvedValue(true),
  hash: jest.fn().mockResolvedValue('hashed-new'),
}));

describe('refresh on a bound device', () => {
  const session = {
    id: 's1',
    refresh_token: 'hashed',
    trusted_device_id: 'td-1',
    used_at: null,
    ip_address: '1.1.1.1',
    user_agent: 'app',
    device_name: null,
    device_os: null,
    users: { role: 'user', wallets: [{ id: 'w1' }] },
  };

  function build() {
    const prisma: any = {
      user_sessions: {
        findFirst: jest.fn().mockResolvedValue(session),
        findMany: jest.fn().mockResolvedValue([session]),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
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
        if (key === 'BCRYPT_ROUNDS') return '4';
        return undefined;
      },
    };
    const devices = {
      isEnabled: () => true,
      isSessionDeviceValid: jest.fn().mockResolvedValue(true),
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

  beforeEach(() => {
    process.env.LONG_LIVED_SESSIONS_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.LONG_LIVED_SESSIONS_ENABLED;
  });

  it('refreshes by jti without SMS and keeps the device binding', async () => {
    const { svc, prisma } = build();
    const result = await svc.refresh(
      'user-1',
      'raw-refresh',
      '1.1.1.1',
      'dev-1',
      'jti-1',
    );
    expect(prisma.user_sessions.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jwt_id: 'jti-1' }),
      }),
    );
    expect(prisma.user_sessions.findMany).not.toHaveBeenCalled();
    expect(result.data.reauth).toBe('refresh');
    expect(result.data.refresh_token).toBe('refresh');
    expect(result.message).toMatch(/refreshed/i);
  });

  it('asks for the device id without revoking the session', async () => {
    const { svc, prisma } = build();
    await expect(
      svc.refresh('user-1', 'raw-refresh', '1.1.1.1', undefined, 'jti-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user_sessions.update).not.toHaveBeenCalled();
    expect(prisma.user_sessions.updateMany).not.toHaveBeenCalled();
  });
});
