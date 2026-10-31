import { AdminService } from './admin.service';

describe('AdminService transaction list details', () => {
  it('returns admin-accessible details by transaction id with linked parties', async () => {
    const transaction = {
      id: '11111111-1111-4111-8111-111111111111',
      transaction_reference: 'deposit-ref-1',
      transaction_type: 'deposit',
      status: 'PENDING',
      amount: 100,
      fee: 0,
      net_amount: 100,
      currency: 'FARM',
      description: 'Pending crypto deposit',
      metadata: { user_id: 'user-1', payment_provider: 'IvoryPay' },
      created_at: new Date('2024-05-01T10:15:30.000Z'),
      processed_at: null,
      wallets_transactions_sender_wallet_idTowallets: null,
      wallets_transactions_receiver_wallet_idTowallets: null,
    };
    const prisma: any = {
      transactions: {
        findFirst: jest.fn().mockResolvedValue(transaction),
      },
      users: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          username: 'alice',
          first_name: 'Alice',
          last_name: 'Example',
        }),
      },
    };
    const service = new AdminService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getTransactionDetails(transaction.id);

    expect(prisma.transactions.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { id: transaction.id },
            { transaction_reference: transaction.id },
          ],
        },
      }),
    );
    expect(result.data).toEqual(
      expect.objectContaining({
        id: transaction.id,
        transaction_reference: transaction.transaction_reference,
        user_id: 'user-1',
        username: 'alice',
        sender_name: 'IvoryPay',
        receiver_name: 'Alice Example',
        payment_provider: 'IvoryPay',
      }),
    );
  });

  it('resolves deposit users from metadata and returns display timestamps and parties', async () => {
    const tx = {
      id: 'tx-1',
      transaction_reference: 'deposit-ref-1',
      transaction_type: 'deposit',
      status: 'completed',
      amount: 250,
      fee: 0,
      net_amount: 250,
      currency: 'KES',
      description: 'Crypto deposit',
      metadata: {
        user_id: 'user-1',
        payment_method: 'CRYPTO',
        payment_provider: 'IvoryPay',
      },
      created_at: new Date('2024-05-01T10:15:30.000Z'),
      processed_at: null,
      wallets_transactions_sender_wallet_idTowallets: null,
      wallets_transactions_receiver_wallet_idTowallets: null,
    };
    const prisma: any = {
      transactions: {
        findMany: jest.fn().mockResolvedValue([tx]),
        count: jest.fn().mockResolvedValue(1),
      },
      users: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'user-1',
            username: 'alice',
            first_name: 'Alice',
            last_name: 'Example',
            email: 'alice@example.com',
            phone: '+254700000000',
          },
        ]),
      },
    };
    const service = new AdminService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.listTransactions({
      transaction_type: 'deposit',
    });

    expect(result.data[0]).toEqual(
      expect.objectContaining({
        user_id: 'user-1',
        username: 'alice',
        user_name: 'Alice Example',
        method: 'CRYPTO',
        date: '2024-05-01',
        time: '10:15:30',
        sender_name: 'IvoryPay',
        receiver_name: 'Alice Example',
      }),
    );
  });

  it('includes withdrawal owner, destination, method, and timestamp in admin withdrawal rows', async () => {
    const withdrawal = {
      id: 'withdrawal-1',
      userId: 'user-2',
      amount: 125,
      fee: 2,
      settlement: 123,
      total: 127,
      currency: 'KES',
      method: 'MOBILE_MONEY',
      phoneNumber: '+254700000001',
      reference: 'withdrawal-ref-1',
      status: 'PENDING',
      createdAt: new Date('2024-05-02T11:16:17.000Z'),
      user: {
        id: 'user-2',
        username: 'bob',
        first_name: 'Bob',
        last_name: 'Example',
        email: 'bob@example.com',
        phone: '+254700000000',
      },
    };
    const prisma: any = {
      withdrawal: {
        findMany: jest.fn().mockResolvedValue([withdrawal]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new AdminService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.listAllWithdrawals({});

    expect(result.data[0]).toEqual(
      expect.objectContaining({
        user_id: 'user-2',
        username: 'bob',
        user_name: 'Bob Example',
        transaction_reference: 'withdrawal-ref-1',
        method: 'MOBILE_MONEY',
        sender_name: 'Bob Example',
        receiver_name: '+254700000001',
        date: '2024-05-02',
        time: '11:16:17',
      }),
    );
  });
});

describe('AdminService dispute resolution', () => {
  it.each(['buyer', 'seller'] as const)(
    'passes resolution details to escrow helpers when the %s wins',
    async (winner) => {
      const escrow = { id: 'escrow-1', status: 'disputed' };
      const prisma: any = {
        escrow_contracts: {
          findUnique: jest.fn().mockResolvedValue(escrow),
        },
        audit_logs: {
          create: jest.fn().mockResolvedValue({}),
        },
      };
      const escrowService: any = {
        executeRelease: jest.fn().mockResolvedValue(undefined),
        executeRefund: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdminService(
        prisma,
        escrowService,
        {} as any,
        {} as any,
        {} as any,
      );

      await service.resolveDispute('escrow-1', 'admin-1', {
        winner,
        note: 'Evidence reviewed',
      });

      const selectedHelper =
        winner === 'seller'
          ? escrowService.executeRelease
          : escrowService.executeRefund;
      const otherHelper =
        winner === 'seller'
          ? escrowService.executeRefund
          : escrowService.executeRelease;
      expect(selectedHelper).toHaveBeenCalledWith(escrow, {
        adminId: 'admin-1',
        note: 'Evidence reviewed',
      });
      expect(otherHelper).not.toHaveBeenCalled();
      expect(prisma.escrow_contracts.findUnique).toHaveBeenCalledWith({
        where: { id: 'escrow-1' },
      });
      expect(prisma.audit_logs.create).toHaveBeenCalled();
    },
  );
});

describe('AdminService.broadcastNotification', () => {
  it('maps the audience selector to the correct user filter and sends a notification', async () => {
    const prisma = {
      users: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'user-1', email: 'u@example.com', phone: '+254700000000' },
          ]),
      },
      audit_logs: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const notifications = {
      sendNotification: jest.fn().mockResolvedValue({ id: 'notif-1' }),
      createInApp: jest.fn().mockResolvedValue({ id: 'notif-1' }),
      sendPush: jest.fn().mockResolvedValue(true),
      sendEmail: jest.fn().mockResolvedValue(true),
      sendSms: jest.fn().mockResolvedValue(true),
    };

    const service = new AdminService(
      prisma as any,
      {} as any,
      notifications as any,
      {} as any,
    );

    await service.broadcastNotification('admin-1', {
      title: 'Platform notice',
      body: 'This is a test announcement',
      audience: 'verified',
    });

    expect(prisma.users.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          is_deleted: false,
          is_active: true,
          kyc_status: 'verified',
        }),
      }),
    );
    expect(notifications.sendNotification).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: 'Platform notice',
        body: 'This is a test announcement',
      }),
    );
  });
});

describe('AdminService KYC image responses', () => {
  const images = {
    front_image: 'https://res.cloudinary.com/demo/front.jpg',
    back_image: 'https://res.cloudinary.com/demo/back.jpg',
    selfie_image: 'https://res.cloudinary.com/demo/selfie.jpg',
    address_document: 'https://res.cloudinary.com/demo/address.jpg',
  };

  it('includes uploaded images in the admin KYC queue', async () => {
    const document = {
      id: 'kyc-1',
      front_image: images.front_image,
      back_image_url: images.back_image,
      selfie_image: images.selfie_image,
      address_document: images.address_document,
    };
    const prisma: any = {
      kyc_documents: {
        findMany: jest.fn().mockResolvedValue([document]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new AdminService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.listKycQueue({});

    expect(result.data[0]).toEqual(
      expect.objectContaining({
        front_image: images.front_image,
        back_image: images.back_image,
        selfie_image: images.selfie_image,
        address_document: images.address_document,
        front_image_url: images.front_image,
        back_image_url: images.back_image,
        selfie_image_url: images.selfie_image,
        address_document_url: images.address_document,
      }),
    );
    expect(prisma.kyc_documents.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          front_image: true,
          back_image: true,
          selfie_image: true,
          address_document: true,
          front_image_url: true,
          back_image_url: true,
          selfie_image_url: true,
        }),
      }),
    );
  });

  it('includes uploaded images when an admin opens KYC details', async () => {
    const document = {
      id: 'kyc-1',
      front_image: images.front_image,
      back_image_url: images.back_image,
      selfie_image: images.selfie_image,
      address_document: images.address_document,
    };
    const prisma: any = {
      kyc_documents: {
        findUnique: jest.fn().mockResolvedValue(document),
      },
    };
    const service = new AdminService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getKycDocument('kyc-1');

    expect(result.data).toEqual(
      expect.objectContaining({
        front_image: images.front_image,
        back_image: images.back_image,
        selfie_image: images.selfie_image,
        front_image_url: images.front_image,
        back_image_url: images.back_image,
        selfie_image_url: images.selfie_image,
        address_document_url: images.address_document,
      }),
    );
  });
});

describe('AdminService KYC review notifications', () => {
  it.each([
    ['verified', 'KYC Approved', 'kyc_update'],
    ['rejected', 'KYC Rejected', 'kyc_update'],
  ] as const)(
    'notifies the user when KYC status becomes %s',
    async (status, title, type) => {
      const document = {
        id: 'kyc-1',
        user_id: 'user-1',
        status: 'pending',
        first_name: 'Ada',
        last_name: 'Lovelace',
        date_of_birth: new Date('1990-12-10T00:00:00.000Z'),
        document_type: 'National ID',
        document_number: 'ID-123',
        front_image: 'https://res.cloudinary.com/demo/front.jpg',
      };
      const prisma: any = {
        kyc_documents: {
          findUnique: jest.fn().mockResolvedValue(document),
          update: jest.fn().mockResolvedValue({ ...document, status }),
        },
        users: { update: jest.fn().mockResolvedValue({}) },
        audit_logs: { create: jest.fn().mockResolvedValue({}) },
      };
      const notifications = {
        sendNotification: jest.fn().mockResolvedValue({ id: 'notification-1' }),
      };
      const service = new AdminService(
        prisma,
        {} as any,
        notifications as any,
        {} as any,
        {} as any,
      );

      await service.reviewKyc('kyc-1', 'admin-1', {
        status,
        ...(status === 'rejected'
          ? { rejection_reason: 'Image is unclear' }
          : {}),
      });

      expect(notifications.sendNotification).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type,
          entityId: 'kyc-1',
          title,
          metadata: expect.objectContaining({
            kyc_id: 'kyc-1',
            kyc_status: status,
          }),
        }),
      );
      if (status === 'rejected') {
        expect(notifications.sendNotification).toHaveBeenCalledWith(
          'user-1',
          expect.objectContaining({
            body: expect.stringContaining('Image is unclear'),
          }),
        );
      }
    },
  );
});

describe('AdminService admin management', () => {
  it('lists only non-deleted admin accounts', async () => {
    const prisma = {
      users: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.listAdmins({ page: 1, limit: 20 });

    expect(prisma.users.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: 'admin', is_deleted: false },
      }),
    );
    expect(prisma.users.count).toHaveBeenCalledWith({
      where: { role: 'admin', is_deleted: false },
    });
  });

  describe('AdminService superadmin wallet revenue', () => {
    it('includes merchant sale fees and counts in total platform revenue', async () => {
      const revenueByType: Record<string, { fee: number; count: number }> = {
        escrow_lock: { fee: 9.78, count: 4 },
        escrow_release: { fee: 8.6, count: 2 },
        withdrawal: { fee: 4.35, count: 3 },
        merchant_payment: { fee: 2.5, count: 5 },
      };
      const prisma: any = {
        users: {
          findUnique: jest.fn().mockResolvedValue({
            role: 'super_admin',
            wallets: [
              {
                balance: 107,
                locked_balance: 7,
                currency: 'FARM',
                wallet_address: 'superadmin-wallet',
              },
            ],
          }),
        },
        withdrawal: {
          aggregate: jest
            .fn()
            .mockResolvedValue({ _sum: { amount: 0, settlement: 0 } }),
        },
        transactions: {
          aggregate: jest.fn(({ where }) => {
            const value = revenueByType[where.transaction_type];
            return Promise.resolve({
              _sum: { fee: value.fee },
              _count: { id: value.count },
            });
          }),
        },
      };
      const service = new AdminService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      const result = await service.getSuperadminWallet('superadmin-1');

      expect(result.data).toEqual(
        expect.objectContaining({
          balance: 107,
          available_balance: 100,
          locked_balance: 7,
          merchant_sales_revenue: 2.5,
          merchant_sales_count: 5,
          total_platform_revenue: 25.23,
        }),
      );
      expect(prisma.transactions.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            transaction_type: 'merchant_payment',
            status: 'completed',
            fee: { gt: 0 },
            metadata: {
              path: ['platform_fee_type'],
              equals: 'merchant_sale',
            },
          }),
        }),
      );
    });
  });

  it('keeps admin and superadmin accounts out of ordinary user lists', async () => {
    const prisma = {
      users: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.listUsers({ page: 1, limit: 20 });

    expect(prisma.users.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          is_deleted: false,
          AND: [
            {
              OR: [
                { role: { notIn: ['admin', 'super_admin'] } },
                { role: null },
              ],
            },
          ],
        },
      }),
    );
  });

  it('revokes admin sessions when suspending an account', async () => {
    const tx = {
      users: {
        update: jest.fn().mockResolvedValue({
          id: 'admin-1',
          role: 'admin',
          is_suspended: true,
        }),
      },
      user_sessions: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      audit_logs: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      users: { findFirst: jest.fn().mockResolvedValue({ id: 'admin-1' }) },
      $transaction: jest.fn((callback: (client: any) => unknown) =>
        callback(tx),
      ),
    };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.setAdminStatus('admin-1', 'suspend', 'superadmin-1');

    expect(tx.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'admin-1' },
        data: { is_suspended: true, is_active: false },
      }),
    );
    expect(tx.user_sessions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          user_id: 'admin-1',
          OR: [{ is_revoked: false }, { is_revoked: null }],
        },
        data: { is_revoked: true },
      }),
    );
    expect(tx.audit_logs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'SUSPEND_ADMIN' }),
      }),
    );
  });

  it('reactivates an approved admin account', async () => {
    const tx = {
      users: {
        update: jest.fn().mockResolvedValue({
          id: 'admin-1',
          role: 'admin',
          is_active: true,
          is_suspended: false,
        }),
      },
      audit_logs: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      users: { findFirst: jest.fn().mockResolvedValue({ id: 'admin-1' }) },
      $transaction: jest.fn((callback: (client: any) => unknown) =>
        callback(tx),
      ),
    };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.setAdminStatus('admin-1', 'approve', 'superadmin-1');

    expect(tx.users.update).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      data: { is_suspended: false, is_active: true },
    });
  });

  it('removes admin sign-in data and revokes sessions when deleting', async () => {
    const tx = {
      users: { update: jest.fn().mockResolvedValue({ id: 'admin-1' }) },
      user_sessions: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      device_tokens: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      biometric_settings: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      api_keys: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      notifications: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      audit_logs: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      users: { findFirst: jest.fn().mockResolvedValue({ id: 'admin-1' }) },
      $transaction: jest.fn((callback: (client: any) => unknown) =>
        callback(tx),
      ),
    };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.deleteAdmin('admin-1', 'superadmin-1');

    expect(tx.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'admin-1' },
        data: expect.objectContaining({
          is_deleted: true,
          is_active: false,
          is_suspended: true,
          email: null,
          firebase_uid: null,
          phone: expect.stringMatching(/^deleted_/),
          username: 'deleted_admin-1',
        }),
      }),
    );
    expect(tx.user_sessions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          user_id: 'admin-1',
          OR: [{ is_revoked: false }, { is_revoked: null }],
        },
        data: expect.objectContaining({ is_revoked: true }),
      }),
    );
  });

  it('does not allow the ordinary user editor to assign staff roles', async () => {
    const prisma = {
      users: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          role: 'user',
          is_deleted: false,
        }),
        update: jest.fn(),
      },
    };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.updateUser('user-1', { role: 'admin' }, 'admin-1'),
    ).rejects.toThrow('Staff roles can only be managed by superadmins');
    expect(prisma.users.update).not.toHaveBeenCalled();
  });

  it('excludes admin and superadmin roles from ordinary user counts', async () => {
    const prisma = {
      users: { count: jest.fn().mockResolvedValue(0) },
      merchants: { count: jest.fn().mockResolvedValue(0) },
      escrow_contracts: { count: jest.fn().mockResolvedValue(0) },
      transactions: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: 0 },
          _count: 0,
        }),
      },
      kyc_documents: { count: jest.fn().mockResolvedValue(0) },
      merchant_payouts: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.getDashboardStats();

    expect(prisma.users.count).toHaveBeenCalledWith({
      where: {
        is_deleted: false,
        OR: [{ role: { notIn: ['admin', 'super_admin'] } }, { role: null }],
      },
    });
  });

  it('excludes admin and superadmin roles from the superadmin dashboard total', async () => {
    const revenueByType: Record<string, { fee: number; count: number }> = {
      escrow_lock: { fee: 9.78, count: 4 },
      escrow_release: { fee: 8.6, count: 2 },
      withdrawal: { fee: 4.35, count: 3 },
      merchant_payment: { fee: 2.5, count: 5 },
    };
    const prisma = {
      users: { count: jest.fn().mockResolvedValue(0) },
      transactions: {
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn(({ where }) => {
          const revenue = revenueByType[where.transaction_type] ?? {
            fee: 0,
            count: 0,
          };
          return Promise.resolve({
            _sum: { amount: 0, fee: revenue.fee },
            _count: { id: revenue.count },
          });
        }),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([
          ...Object.entries(revenueByType).map(([type, r]) => ({
            transaction_type: type,
            _sum: { fee: r.fee },
            _count: { id: r.count },
          })),
          {
            transaction_type: 'transfer',
            _sum: { fee: 1.5 },
            _count: { id: 3 },
          },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      support_tickets: { count: jest.fn().mockResolvedValue(0) },
      escrow_contracts: { count: jest.fn().mockResolvedValue(0) },
      kyc_documents: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {
        getCurrentRate: jest.fn().mockResolvedValue({
          live_enabled: true,
          stale: false,
          is_override: false,
        }),
      } as any,
    );

    const result = await service.getSuperadminDashboard();
    const streams = (result.data as any).revenue_streams;
    expect(streams.map((r: any) => r.type)).toContain('transfer');
    expect((result.data as any).system_checks.checks[0]).toMatchObject({
      name: 'Database',
      status: 'ok',
    });
    expect((result.data as any).system_health).toBeUndefined();

    expect(prisma.users.count).toHaveBeenCalledWith({
      where: {
        is_deleted: false,
        OR: [{ role: { notIn: ['admin', 'super_admin'] } }, { role: null }],
      },
    });
    expect(prisma.transactions.aggregate).toHaveBeenCalledWith({
      where: {
        transaction_type: 'merchant_payment',
        status: 'completed',
        fee: { gt: 0 },
        metadata: {
          path: ['platform_fee_type'],
          equals: 'merchant_sale',
        },
      },
      _sum: { fee: true },
      _count: { id: true },
    });
    expect(result.data).toEqual(
      expect.objectContaining({
        escrow_creation_earnings: 9.78,
        escrow_creation_count: 4,
        escrow_release_earnings: 8.6,
        escrow_release_count: 2,
        withdraw_fee_earnings: 4.35,
        withdrawal_fee_count: 3,
        merchant_sales_fee_earnings: 2.5,
        merchant_sales_count: 5,
        platform_fee_total_earnings: 26.73, // includes the 1.50 transfer-fee stream
        total_revenue: 26.73,
      }),
    );
  });
});

describe('AdminService.resolveDispute', () => {
  const makeService = (escrow: any) => {
    const prisma = {
      escrow_contracts: { findUnique: jest.fn().mockResolvedValue(escrow) },
      audit_logs: { create: jest.fn().mockResolvedValue({}) },
    };
    const escrowService = {
      executeRelease: jest.fn().mockResolvedValue(undefined),
      executeRefund: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as any,
      escrowService as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, escrowService };
  };

  it('refunds the buyer when an admin resolves a dispute in their favor', async () => {
    const { service, escrowService, prisma } = makeService({
      id: 'escrow-1',
      status: 'disputed',
    });

    await service.resolveDispute('escrow-1', 'admin-1', {
      winner: 'buyer',
      note: 'Seller did not deliver',
    });

    expect(escrowService.executeRefund).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'escrow-1' }),
      { adminId: 'admin-1', note: 'Seller did not deliver' },
    );
    expect(escrowService.executeRelease).not.toHaveBeenCalled();
    expect(prisma.audit_logs.create).toHaveBeenCalled();
  });

  it('releases funds to the seller when an admin resolves in their favor', async () => {
    const { service, escrowService } = makeService({
      id: 'escrow-1',
      status: 'disputed',
    });

    await service.resolveDispute('escrow-1', 'admin-1', {
      winner: 'seller',
      note: 'Delivery confirmed',
    });

    expect(escrowService.executeRelease).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'escrow-1' }),
      { adminId: 'admin-1', note: 'Delivery confirmed' },
    );
    expect(escrowService.executeRefund).not.toHaveBeenCalled();
  });

  it('does not resolve an escrow unless it is disputed', async () => {
    const { service, escrowService, prisma } = makeService({
      id: 'escrow-1',
      status: 'active',
    });

    await expect(
      service.resolveDispute('escrow-1', 'admin-1', {
        winner: 'seller',
        note: 'Not a dispute',
      }),
    ).rejects.toThrow('Only disputed escrows can be resolved');

    expect(escrowService.executeRelease).not.toHaveBeenCalled();
    expect(escrowService.executeRefund).not.toHaveBeenCalled();
    expect(prisma.audit_logs.create).not.toHaveBeenCalled();
  });
});

describe('AdminService.broadcastNotification recipient targeting', () => {
  it('sends to explicitly supplied recipients when recipient IDs are provided', async () => {
    const prisma = {
      users: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'user-2',
            email: 'user2@example.com',
            phone: '+254700000001',
          },
        ]),
      },
      audit_logs: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const notifications = {
      sendNotification: jest.fn().mockResolvedValue({ id: 'notif-2' }),
      createInApp: jest.fn().mockResolvedValue({ id: 'notif-2' }),
      sendPush: jest.fn().mockResolvedValue(true),
      sendEmail: jest.fn().mockResolvedValue(true),
      sendSms: jest.fn().mockResolvedValue(true),
    };

    const service = new AdminService(
      prisma as any,
      {} as any,
      notifications as any,
      {} as any,
    );

    await service.broadcastNotification('admin-1', {
      title: 'Direct notice',
      body: 'Sent to selected recipients',
      recipientIds: ['user-2'],
    });

    expect(prisma.users.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: { in: ['user-2'] } }],
        }),
      }),
    );
    expect(notifications.sendNotification).toHaveBeenCalledWith(
      'user-2',
      expect.objectContaining({
        title: 'Direct notice',
        body: 'Sent to selected recipients',
      }),
    );
  });
});

// From main (19e858a): exchange-rate caching.
describe('AdminService exchange rates', () => {
  const createCacheStub = () => ({
    cacheGet: jest.fn(),
    cacheSet: jest.fn(),
    cacheDelete: jest.fn(),
    cacheInvalidatePattern: jest.fn(),
  });

  it('caches exchange rates and reuses them on repeated reads', async () => {
    const prisma = {
      exchange_rates: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { base_currency: 'USD', target_currency: 'FARM', rate: 130 },
          ]),
      },
    };
    const cache = createCacheStub();
    cache.cacheGet.mockResolvedValueOnce(null).mockResolvedValueOnce({
      data: [{ base_currency: 'USD', target_currency: 'FARM', rate: 130 }],
    });

    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      cache as any,
    );

    const first = await service.getExchangeRates();
    const second = await service.getExchangeRates();

    expect(first).toEqual({
      data: [{ base_currency: 'USD', target_currency: 'FARM', rate: 130 }],
    });
    expect(second).toEqual(first);
    expect(prisma.exchange_rates.findMany).toHaveBeenCalledTimes(1);
    expect(cache.cacheSet).toHaveBeenCalledWith(
      'exchange-rates:all',
      expect.any(Object),
      300,
    );
  });
});

describe('AdminService exchange-rate cache invalidation', () => {
  it('drops the cached exchange-rate list after an update', async () => {
    const prisma = {
      exchange_rates: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'rate-1' }),
      },
    };
    const cache = { cacheDelete: jest.fn().mockResolvedValue(undefined) };
    const service = new AdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      cache as any,
    );

    await service.updateExchangeRates(
      [{ base_currency: 'usd', target_currency: 'farm', rate: 130 }],
      'admin-1',
    );

    expect(prisma.exchange_rates.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        base_currency: 'USD',
        target_currency: 'FARM',
      }),
    });
    expect(cache.cacheDelete).toHaveBeenCalledWith('exchange-rates:all');
  });
});
