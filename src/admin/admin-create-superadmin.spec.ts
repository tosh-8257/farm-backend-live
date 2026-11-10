import { AdminService } from './admin.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

describe('AdminService.createSuperadmin', () => {
  it('creates a super_admin account with its wallet and audit record', async () => {
    const user = {
      id: 'superadmin-2',
      first_name: 'Ada',
      last_name: 'Lovelace',
      username: 'ada',
      phone: '+254700000001',
      email: 'ada@example.com',
      role: 'super_admin',
    };
    const transaction = {
      users: { create: jest.fn().mockResolvedValue(user) },
      wallets: { create: jest.fn().mockResolvedValue({ id: 'wallet-2' }) },
      audit_logs: { create: jest.fn().mockResolvedValue({ id: 'audit-2' }) },
    };
    const prisma = {
      users: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((callback: (tx: any) => unknown) =>
        callback(transaction),
      ),
    };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.createSuperadmin(
      {
        first_name: 'Ada',
        last_name: 'Lovelace',
        username: 'ada',
        phone: '+254700000001',
        email: 'ada@example.com',
        password: 'a-strong-password',
        country: 'Kenya',
      },
      'superadmin-1',
    );

    expect(transaction.users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'super_admin' }),
      }),
    );
    expect(transaction.wallets.create).toHaveBeenCalled();
    expect(transaction.audit_logs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CREATE_SUPERADMIN',
          new_values: expect.objectContaining({ role: 'super_admin' }),
        }),
      }),
    );
    expect(result.data.role).toBe('super_admin');
  });

  it('schedules a custodial wallet without waiting for chain setup', async () => {
    const user = {
      id: 'superadmin-2',
      first_name: 'Ada',
      last_name: 'Lovelace',
      username: 'ada',
      phone: '+254700000001',
      email: 'ada@example.com',
      role: 'super_admin',
    };
    const transaction = {
      users: { create: jest.fn().mockResolvedValue(user) },
      wallets: { create: jest.fn().mockResolvedValue({ id: 'wallet-2' }) },
      audit_logs: { create: jest.fn().mockResolvedValue({ id: 'audit-2' }) },
    };
    const prisma = {
      users: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((callback: (tx: any) => unknown) =>
        callback(transaction),
      ),
    };
    const mine = jest.fn().mockReturnValue(new Promise(() => {}));
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      { get: () => ({ mine }) } as any,
    );

    await expect(
      service.createSuperadmin(
        {
          first_name: 'Ada',
          last_name: 'Lovelace',
          username: 'ada',
          phone: '+254700000001',
          email: 'ada@example.com',
          password: 'a-strong-password',
          country: 'Kenya',
        },
        'superadmin-1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({ message: 'Superadmin created successfully' }),
    );
    expect(mine).toHaveBeenCalledWith('superadmin-2');
  });
});
