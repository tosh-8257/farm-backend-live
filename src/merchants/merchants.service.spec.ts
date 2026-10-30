import { MerchantsService } from './merchants.service';

describe('MerchantsService QR access', () => {
  let service: MerchantsService;
  let prisma: any;
  let qrService: any;

  beforeEach(() => {
    prisma = {
      merchants: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
    qrService = {
      generateMerchantQr: jest.fn(),
      getMerchantQr: jest.fn(),
    };
    const cache = {
      cacheGet: jest.fn().mockResolvedValue(null),
      cacheSet: jest.fn().mockResolvedValue(undefined),
      cacheInvalidatePattern: jest.fn().mockResolvedValue(undefined),
    };
    service = new MerchantsService(prisma, qrService, cache as any);
  });

  it('rejects QR access for a merchant that is still pending approval', async () => {
    prisma.merchants.findFirst.mockResolvedValue({
      id: 'merchant-1',
      user_id: 'user-1',
      status: 'pending',
      qr_code: 'payload',
    });

    await expect(service.getMerchantQr('user-1')).rejects.toThrow(
      'Merchant application is pending approval',
    );
    expect(qrService.getMerchantQr).not.toHaveBeenCalled();
  });

  it('resubmits a rejected application as pending', async () => {
    const rejectedMerchant = {
      id: 'merchant-1',
      user_id: 'user-1',
      status: 'rejected',
    };
    const updatedMerchant = { ...rejectedMerchant, status: 'pending' };
    prisma.merchants.findFirst.mockResolvedValue(rejectedMerchant);
    prisma.merchants.update.mockResolvedValue(updatedMerchant);

    const result = await service.apply('user-1', {
      business_name: 'Farm Shop',
      business_type: 'Retail',
      business_email: 'shop@example.com',
      business_phone: '+254700000000',
      country: 'Kenya',
      city: 'Nairobi',
    });

    expect(prisma.merchants.update).toHaveBeenCalledWith({
      where: { id: 'merchant-1' },
      data: {
        business_name: 'Farm Shop',
        business_type: 'Retail',
        business_email: 'shop@example.com',
        business_phone: '+254700000000',
        country: 'Kenya',
        city: 'Nairobi',
        status: 'pending',
        approved_by: null,
        approved_at: null,
      },
    });
    expect(result.message).toBe('Application resubmitted. Pending review.');
  });

  it('does not allow resubmission while an application is pending', async () => {
    prisma.merchants.findFirst.mockResolvedValue({
      id: 'merchant-1',
      user_id: 'user-1',
      status: 'pending',
    });

    await expect(
      service.apply('user-1', {
        business_name: 'Farm Shop',
        business_type: 'Retail',
        business_email: 'shop@example.com',
        business_phone: '+254700000000',
        country: 'Kenya',
        city: 'Nairobi',
      }),
    ).rejects.toThrow('You already have a merchant application');
    expect(prisma.merchants.update).not.toHaveBeenCalled();
  });

  it('allows fetching a QR image for an approved merchant', async () => {
    prisma.merchants.findFirst.mockResolvedValue({
      id: 'merchant-1',
      user_id: 'user-1',
      status: 'approved',
      qr_code: 'payload',
    });
    qrService.getMerchantQr.mockResolvedValue({
      data: { qr_image_base64: 'abc' },
    });

    await expect(service.getMerchantQr('user-1')).resolves.toEqual({
      data: { qr_image_base64: 'abc' },
    });
    expect(qrService.getMerchantQr).toHaveBeenCalledWith('merchant-1');
  });

  it('returns the QR payer email on the merchant transaction record', async () => {
    prisma.merchants.findFirst.mockResolvedValue({
      id: 'merchant-1',
      user_id: 'user-1',
      status: 'approved',
    });
    prisma.wallets = {
      findFirst: jest.fn().mockResolvedValue({ id: 'merchant-wallet-1' }),
    };
    prisma.transactions = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'transaction-1',
          amount: 25,
          metadata: { guest_email: 'customer@example.com' },
        },
      ]),
      count: jest.fn().mockResolvedValue(1),
    };

    const result = await service.getTransactions('user-1', {
      page: 1,
      limit: 20,
    });

    expect(result.data[0]).toEqual(
      expect.objectContaining({
        payer_email: 'customer@example.com',
        amount: 25,
      }),
    );
  });

  it('blocks sales transactions while the application is pending', async () => {
    prisma.merchants.findFirst.mockResolvedValue({
      id: 'merchant-1',
      user_id: 'user-1',
      status: 'pending',
    });
    prisma.wallets = { findFirst: jest.fn() };

    await expect(
      service.getTransactions('user-1', { page: 1, limit: 20 }),
    ).rejects.toThrow('Merchant application is pending approval');
    expect(prisma.wallets.findFirst).not.toHaveBeenCalled();
  });

  it('blocks payout history while the application is rejected', async () => {
    prisma.merchants.findFirst.mockResolvedValue({
      id: 'merchant-1',
      user_id: 'user-1',
      status: 'rejected',
    });
    prisma.merchant_payouts = { findMany: jest.fn(), count: jest.fn() };

    await expect(
      service.getPayouts('user-1', { page: 1, limit: 20 }),
    ).rejects.toThrow('Merchant application is pending approval');
    expect(prisma.merchant_payouts.findMany).not.toHaveBeenCalled();
  });
});
