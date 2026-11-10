import { AuthService } from './auth.service';

describe('Firebase phone verification flow', () => {
  it('verifies the Firebase phone claim and issues a FARM session', async () => {
    const prisma = {
      pending_login_verifications: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pending-1',
          status: 'pending',
          phone: '+254700123456',
          role: 'user',
          expires_at: new Date(Date.now() + 60_000),
          users: {
            id: 'user-1',
            is_deleted: false,
            is_suspended: false,
            is_active: true,
            pin_hash: null,
            first_name: 'Test',
            last_name: 'User',
            username: 'tester',
            phone: '+254700123456',
            email: 'tester@example.com',
            role: 'user',
            kyc_status: 'verified',
            kyc_level: 0,
            wallets: [{ id: 'wallet-1' }],
          },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user_sessions: { create: jest.fn().mockResolvedValue({}) },
      users: { update: jest.fn().mockResolvedValue({}) },
    };
    const firebase = {
      verifyIdToken: jest.fn().mockResolvedValue({
        uid: 'firebase-user-1',
        phone_number: '+254700123456',
      }),
    };
    const mine = jest.fn().mockResolvedValue({ enabled: true, data: null });
    const service = new AuthService(
      prisma as any,
      {} as any,
      { get: jest.fn().mockReturnValue('12') } as any,
      {} as any,
      {} as any,
      firebase as any,
      {} as any,
      undefined,
      { get: () => ({ mine }) } as any,
    );

    jest.spyOn(service as any, 'issueTokens').mockResolvedValue({
      access_token: 'farm-access-token',
      refresh_token: 'farm-refresh-token',
      jti: 'jwt-id',
    });

    const result = await service.verifyPhone(
      'firebase-id-token',
      'pending-1',
      '127.0.0.1',
      'jest',
    );

    expect(firebase.verifyIdToken).toHaveBeenCalledWith('firebase-id-token');
    expect(prisma.pending_login_verifications.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pending-1', status: 'pending' }),
        data: expect.objectContaining({ status: 'verified' }),
      }),
    );
    expect(prisma.users.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { phone_verified: true },
    });
    expect(result.data.access_token).toBe('farm-access-token');
    expect(result.data.refresh_token).toBe('farm-refresh-token');
    expect(result.data.user.phone_verified).toBe(true);
    expect(mine).toHaveBeenCalledWith('user-1');
  });

  it('rejects a Firebase token whose phone does not match the pending login', async () => {
    const prisma = {
      pending_login_verifications: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pending-1',
          status: 'pending',
          phone: '+254700123456',
          expires_at: new Date(Date.now() + 60_000),
          users: { id: 'user-1' },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const firebase = {
      verifyIdToken: jest
        .fn()
        .mockResolvedValue({ phone_number: '+254711999999' }),
    };
    const service = new AuthService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      firebase as any,
    );

    await expect(
      service.verifyPhone(
        'firebase-id-token',
        'pending-1',
        '127.0.0.1',
        'jest',
      ),
    ).rejects.toThrow('Phone verification does not match this account.');
    expect(prisma.pending_login_verifications.update).toHaveBeenCalled();
  });
});
