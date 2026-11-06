import { ConflictException } from '@nestjs/common';
import {
  BusinessTeamService,
  normalizeTeamPhone,
} from './business-team.service';

describe('business team invites', () => {
  it('normalizes Kenyan numbers', () => {
    expect(normalizeTeamPhone('0712345678')).toBe('+254712345678');
    expect(normalizeTeamPhone('+254712345678')).toBe('+254712345678');
  });

  it('invites by phone and does not create a member until accept', async () => {
    const prisma: any = {
      users: {
        findFirst: jest.fn().mockResolvedValue({ id: 'u2', is_active: true }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'u2',
          phone: '+254712345678',
          is_active: true,
          is_deleted: false,
        }),
      },
      business_members: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'm1',
          role: 'finance',
        }),
      },
      business_invites: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: 'inv-1',
          ...data,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn(),
      },
      notifications: { create: jest.fn().mockResolvedValue({}) },
      audit_logs: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((fn) => fn(prisma)),
    };
    const access = {
      resolve: jest.fn().mockResolvedValue({
        role: 'owner',
        business: {
          id: 'biz-1',
          owner_user_id: 'owner-1',
          trading_name: 'Acme',
          legal_name: 'Acme Ltd',
        },
      }),
    };
    const auth = { verifyPin: jest.fn().mockResolvedValue(undefined) };
    const svc = new BusinessTeamService(prisma, access as any, auth as any);

    const invited = await svc.invite('owner-1', {
      phone: '0712345678',
      role: 'finance',
      pin: '1234',
    });
    expect(invited.data.status).toBe('pending');
    expect(invited.data.permissions).toEqual(
      expect.arrayContaining(['invoices:read']),
    );
    expect(prisma.business_members.create).not.toHaveBeenCalled();

    prisma.business_invites.findFirst.mockResolvedValue({
      id: 'inv-1',
      phone: '+254712345678',
      role: 'finance',
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000),
      business_id: 'biz-1',
      invited_by: 'owner-1',
      business: {
        id: 'biz-1',
        owner_user_id: 'owner-1',
        trading_name: 'Acme',
        legal_name: 'Acme Ltd',
      },
    });
    const accepted = await svc.accept('u2', 'inv-1');
    expect(accepted.data.role).toBe('finance');
    expect(prisma.business_members.create).toHaveBeenCalled();
  });

  it('refuses a second active membership', async () => {
    const prisma: any = {
      users: {
        findFirst: jest.fn().mockResolvedValue({ id: 'u2', is_active: true }),
      },
      business_members: {
        findUnique: jest.fn().mockResolvedValue({ is_active: true }),
      },
      business_invites: { findFirst: jest.fn() },
    };
    const svc = new BusinessTeamService(
      prisma,
      {
        resolve: jest.fn().mockResolvedValue({
          role: 'owner',
          business: { id: 'biz', owner_user_id: 'o', trading_name: 'A' },
        }),
      } as any,
      { verifyPin: jest.fn() } as any,
    );
    await expect(
      svc.invite('o', { phone: '+254712345678', role: 'admin', pin: '1234' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
