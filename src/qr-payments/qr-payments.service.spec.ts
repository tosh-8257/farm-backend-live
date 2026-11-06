jest.mock('../paystack/paystack.service', () => ({
  PaystackService: class PaystackService {},
}));

import { QrPaymentsService } from './qr-payments.service';

describe('QrPaymentsService checkout initialization', () => {
  const merchant = {
    id: 'merchant-1',
    user_id: 'owner-1',
    status: 'approved',
    business_name: 'Farm Shop',
    business_email: 'shop@example.com',
    qr_code: '{"merchant_id":"merchant-1"}',
    users_merchants_user_idTousers: { email: 'owner@example.com' },
  };

  const createService = () => {
    const transaction = { id: 'transaction-1' };
    const createTransaction = jest.fn().mockResolvedValue(transaction);
    const prisma: any = {
      merchants: { findUnique: jest.fn().mockResolvedValue(merchant) },
      wallets: { findFirst: jest.fn().mockResolvedValue({ id: 'wallet-1' }) },
      $transaction: jest.fn((callback) =>
        callback({
          transactions: { create: createTransaction },
          qr_payments: { create: jest.fn().mockResolvedValue({}) },
        }),
      ),
      transactions: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const paystack = {
      initializePayment: jest.fn().mockResolvedValue({
        authorization_url: 'https://checkout.paystack.com/reference',
      }),
    };
    const ivorypay = {
      getSupportedPaymentOptions: jest
        .fn()
        .mockResolvedValue([
          { token: 'USDC', network: 'POLYGON', networkName: 'Polygon' },
        ]),
      createPayment: jest.fn().mockResolvedValue({
        payment_link: 'https://checkout.ivorypay.io/reference',
      }),
    };
    const currencyConversion = {
      getCurrentRate: jest.fn().mockResolvedValue({
        farm_kes_rate: 130,
        farm_usd_rate: 1.3,
      }),
    };
    const service = new QrPaymentsService(
      prisma,
      paystack as any,
      ivorypay as any,
      currencyConversion as any,
      {} as any,
      {} as any,
      {} as any,
      { createForTransaction: jest.fn(), enqueuePdfAndEmail: jest.fn() } as any,
    );
    return { service, prisma, paystack, ivorypay, createTransaction };
  };

  it('uses the Paystack bank_transfer channel for QR bank checkout', async () => {
    const { service, paystack, createTransaction } = createService();

    await service.initialize({
      merchantId: merchant.id,
      amount: 100,
      method: 'bank',
      guestEmail: 'customer@example.com',
    });

    expect(paystack.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100,
        currency: 'KES',
        channels: ['bank_transfer'],
      }),
    );
    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'Public QR payment to Farm Shop',
        }),
      }),
    );
  });

  it('uses the public checkout success page as the provider callback', async () => {
    const { service, paystack } = createService();

    await service.initialize({
      merchantId: merchant.id,
      amount: 100,
      method: 'card',
      guestEmail: 'customer@example.com',
    });

    expect(paystack.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        callback_url: expect.stringMatching(
          /^https:\/\/farmpay\.africa\/pay\/success\?reference=QR-/,
        ),
      }),
    );
  });

  it('initializes mobile money checkout without collecting a phone number', async () => {
    const { service, paystack } = createService();

    await service.initialize({
      merchantId: merchant.id,
      amount: 100,
      method: 'mpesa',
      guestEmail: 'customer@example.com',
      guestPhone: '+254710484154',
      crypto: 'USDT',
      chain: 'BSC_MAINNET',
    });

    expect(paystack.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100,
        currency: 'KES',
        channels: ['mobile_money'],
      }),
    );
    expect(paystack.initializePayment.mock.calls[0][0]).not.toHaveProperty(
      'phone',
    );
  });
});

describe('QrPaymentsService settlement', () => {
  const reference = 'QR-123-payment';

  it('resolves IvoryPay callback IDs and verifies against the internal transaction', async () => {
    const internalReference = 'internal-ivory-reference';
    const payment = {
      id: 'transaction-1',
      transaction_reference: internalReference,
      status: 'pending',
      transaction_type: 'merchant_payment',
      metadata: {
        provider: 'ivorypay',
        provider_ref: 'provider-transaction-id',
        provider_checkout_id: 'provider-checkout-id',
        amount_fiat: 100,
        amount_usd: 1,
      },
      qr_payments: [{ merchant_id: 'merchant-1' }],
    };
    const prisma: any = {
      transactions: {
        findFirst: jest.fn().mockResolvedValue(payment),
        findUnique: jest.fn().mockResolvedValue({
          id: 'transaction-1',
          status: 'completed',
        }),
      },
      qr_payments: {
        findFirst: jest.fn().mockResolvedValue({ merchant_id: 'merchant-1' }),
      },
      merchants: {
        findUnique: jest.fn().mockResolvedValue({ business_name: 'Farm Shop' }),
      },
    };
    const ivorypay = {
      verifyTransaction: jest.fn().mockResolvedValue({
        status: 'COMPLETED',
        amount: 1,
        currency: 'USD',
      }),
    };
    const service = new QrPaymentsService(
      prisma,
      {} as any,
      ivorypay as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const complete = jest.spyOn(service, 'complete').mockResolvedValue(true);

    await expect(service.verify('provider-checkout-id')).resolves.toEqual({
      data: {
        status: 'completed',
        business_name: 'Farm Shop',
        amount: 100,
        currency: 'KES',
      },
    });
    expect(prisma.transactions.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  metadata: {
                    path: ['provider_checkout_id'],
                    equals: 'provider-checkout-id',
                  },
                }),
              ]),
            }),
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  AND: expect.arrayContaining([
                    expect.objectContaining({
                      transaction_type: 'merchant_payment',
                    }),
                    expect.objectContaining({
                      qr_payments: {
                        some: { merchant_id: { not: null } },
                      },
                    }),
                  ]),
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(ivorypay.verifyTransaction).toHaveBeenCalledWith(
      internalReference,
      'provider-transaction-id',
      expect.arrayContaining([
        'provider-transaction-id',
        'provider-checkout-id',
      ]),
    );
    expect(complete).toHaveBeenCalledWith(
      internalReference,
      'ivorypay',
      expect.objectContaining({ status: 'COMPLETED' }),
    );
  });

  it('recovers a failed but unsettled crypto payment after IvoryPay confirms success', async () => {
    const internalReference = 'failed-ivory-reference';
    const payment = {
      id: 'transaction-2',
      transaction_reference: internalReference,
      status: 'failed',
      metadata: {
        type: 'qr_sale',
        isQrSale: true,
        provider: 'ivorypay',
        provider_ref: 'provider-transaction-id',
        amount_fiat: 100,
        amount_usd: 1,
      },
    };
    const prisma: any = {
      transactions: {
        findFirst: jest.fn().mockResolvedValue(payment),
        findUnique: jest.fn().mockResolvedValue({
          id: 'transaction-2',
          status: 'completed',
        }),
      },
      qr_payments: {
        findFirst: jest.fn().mockResolvedValue({ merchant_id: 'merchant-1' }),
      },
      merchants: {
        findUnique: jest.fn().mockResolvedValue({ business_name: 'Farm Shop' }),
      },
    };
    const ivorypay = {
      verifyTransaction: jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        amount: 1,
        currency: 'USD',
      }),
    };
    const service = new QrPaymentsService(
      prisma,
      {} as any,
      ivorypay as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const complete = jest.spyOn(service, 'complete').mockResolvedValue(true);

    await service.verify('provider-transaction-id');

    expect(complete).toHaveBeenCalledWith(
      internalReference,
      'ivorypay',
      expect.objectContaining({ status: 'SUCCESS' }),
    );
  });

  it('settles successful Paystack verification and reports completed status', async () => {
    const pendingTransaction = {
      id: 'transaction-1',
      transaction_reference: reference,
      status: 'pending',
      metadata: {
        type: 'qr_sale',
        isQrSale: true,
        provider: 'paystack',
        provider_ref: reference,
        amount_fiat: 100,
      },
    };
    const prisma: any = {
      transactions: {
        findFirst: jest.fn().mockResolvedValue(pendingTransaction),
        findUnique: jest.fn().mockResolvedValue({
          id: 'transaction-1',
          status: 'completed',
        }),
      },
      qr_payments: {
        findFirst: jest.fn().mockResolvedValue({ merchant_id: 'merchant-1' }),
      },
      merchants: {
        findUnique: jest.fn().mockResolvedValue({ business_name: 'Farm Shop' }),
      },
    };
    const paystack = {
      verifyTransaction: jest.fn().mockResolvedValue({
        status: 'success',
        reference,
        amount: 10_000,
      }),
    };
    const service = new QrPaymentsService(
      prisma,
      paystack as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const complete = jest.spyOn(service, 'complete').mockResolvedValue(true);

    await expect(service.verify(reference)).resolves.toEqual({
      data: {
        status: 'completed',
        business_name: 'Farm Shop',
        amount: 100,
        currency: 'KES',
      },
    });
    expect(paystack.verifyTransaction).toHaveBeenCalledWith(reference);
    expect(complete).toHaveBeenCalledWith(reference, 'paystack', {
      status: 'success',
      reference,
      amount: 10_000,
    });
  });

  it.each(['ANYID', 'f.'])(
    'rejects invalid public merchant ID %s without querying Prisma',
    async (merchantId) => {
      const findUnique = jest.fn();
      const service = new QrPaymentsService(
        { merchants: { findUnique } } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      await expect(service.getPublicMerchant(merchantId)).rejects.toThrow(
        'Invalid merchant ID from QR',
      );
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it('returns not found for a valid but unknown public merchant ID', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const service = new QrPaymentsService(
      { merchants: { findUnique } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.getPublicMerchant('00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow('Merchant not found or unable to accept payments');
  });

  it('credits the merchant wallet once for a verified Paystack payment', async () => {
    const transaction = {
      id: 'transaction-1',
      amount: 7.5,
      receiver_wallet_id: 'wallet-1',
      transaction_type: 'merchant_payment',
      metadata: {
        provider: 'paystack',
        amount_fiat: 100,
      },
      qr_payments: [{ merchant_id: 'merchant-1' }],
    };
    const tx = {
      transactions: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      wallets: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'wallet-1',
          user_id: 'owner-1',
          balance: 12.5,
        }),
        update: jest.fn().mockResolvedValue({ balance: 20 }),
      },
      ledger_entries: { create: jest.fn().mockResolvedValue({}) },
      qr_payments: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      merchants: { update: jest.fn().mockResolvedValue({}) },
      users: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'superadmin-1',
          wallets: [{ id: 'superadmin-wallet-1', balance: 100 }],
        }),
      },
    };
    const prisma: any = {
      transactions: { findUnique: jest.fn().mockResolvedValue(transaction) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const cache = {
      invalidateWallet: jest.fn().mockResolvedValue(undefined),
      cacheDelete: jest.fn().mockResolvedValue(undefined),
      cacheInvalidatePattern: jest.fn().mockResolvedValue(undefined),
    };
    const websocket = {
      emitBalanceUpdate: jest.fn(),
      emitTransactionUpdate: jest.fn(),
    };
    const notifications = {
      sendNotification: jest.fn().mockResolvedValue(undefined),
    };
    const receipts = {
      createForTransaction: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
      enqueuePdfAndEmail: jest.fn(),
    };
    const service = new QrPaymentsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      cache as any,
      websocket as any,
      notifications as any,
      receipts as any,
    );

    const settled = await service.complete(reference, 'paystack', {
      status: 'success',
      reference,
      amount: 10_000,
    });
    tx.transactions.updateMany.mockResolvedValue({ count: 0 });
    const duplicate = await service.complete(reference, 'paystack', {
      status: 'success',
      reference,
      amount: 10_000,
    });

    expect(settled).toBe(true);
    expect(duplicate).toBe(false);
    expect(tx.wallets.update).toHaveBeenCalledTimes(2);
    expect(tx.wallets.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: { increment: 7.425 } },
      select: { balance: true },
    });
    expect(tx.wallets.update).toHaveBeenCalledWith({
      where: { id: 'superadmin-wallet-1' },
      data: { balance: { increment: 0.075 } },
      select: { balance: true },
    });
    expect(tx.transactions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          fee: 0.075,
          net_amount: 7.425,
          description: 'Public QR merchant payment',
        }),
      }),
    );
    expect(tx.ledger_entries.create).toHaveBeenCalledTimes(2);
    expect(tx.merchants.update).toHaveBeenCalledTimes(1);
    expect(receipts.createForTransaction).toHaveBeenCalledWith(
      tx,
      'transaction-1',
      'merchant-1',
      7.5,
      expect.any(Date),
      0.075,
    );
    expect(receipts.enqueuePdfAndEmail).toHaveBeenCalledWith('receipt-1');
    expect(cache.invalidateWallet).toHaveBeenCalledWith('owner-1');
    expect(cache.cacheInvalidatePattern).toHaveBeenCalledWith(
      'transactions:owner-1:*',
    );
    expect(cache.invalidateWallet).toHaveBeenCalledWith('superadmin-1');
    expect(cache.cacheDelete).toHaveBeenCalledWith(
      'admin:superadmin-dashboard',
    );
    expect(websocket.emitBalanceUpdate).toHaveBeenCalledWith('owner-1', 20);
    expect(
      websocket.emitBalanceUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(cache.invalidateWallet.mock.invocationCallOrder[0]);
    expect(notifications.sendNotification).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({
        title: 'Merchant payment successful',
        metadata: expect.objectContaining({
          event: 'merchant_payment_received',
          reference,
        }),
      }),
    );
  });

  it('credits only the owner personal wallet for a QR sale', async () => {
    const transaction = {
      id: 'transaction-business-qr',
      amount: 7.5,
      receiver_wallet_id: 'business-wallet',
      transaction_type: 'merchant_payment',
      metadata: {
        provider: 'paystack',
        amount_fiat: 100,
      },
      qr_payments: [{ merchant_id: 'merchant-1' }],
    };
    const tx = {
      transactions: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      wallets: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'business-wallet',
          user_id: null,
          wallet_type: 'merchant',
          balance: 12.5,
        }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'personal-wallet',
          user_id: 'owner-1',
          wallet_type: 'user',
          balance: 25,
        }),
        update: jest.fn().mockResolvedValue({ balance: 32.425 }),
      },
      ledger_entries: { create: jest.fn().mockResolvedValue({}) },
      qr_payments: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      merchants: {
        findUnique: jest.fn().mockResolvedValue({ user_id: 'owner-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      users: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'superadmin-1',
          wallets: [{ id: 'superadmin-wallet-1', balance: 100 }],
        }),
      },
    };
    const prisma: any = {
      transactions: { findUnique: jest.fn().mockResolvedValue(transaction) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const cache = {
      invalidateWallet: jest.fn().mockResolvedValue(undefined),
      cacheDelete: jest.fn().mockResolvedValue(undefined),
      cacheInvalidatePattern: jest.fn().mockResolvedValue(undefined),
    };
    const websocket = {
      emitBalanceUpdate: jest.fn(),
      emitTransactionUpdate: jest.fn(),
    };
    const notifications = {
      sendNotification: jest.fn().mockResolvedValue(undefined),
    };
    const receipts = {
      createForTransaction: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
      enqueuePdfAndEmail: jest.fn(),
    };
    const service = new QrPaymentsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      cache as any,
      websocket as any,
      notifications as any,
      receipts as any,
    );

    await expect(
      service.complete(reference, 'paystack', {
        status: 'success',
        reference,
        amount: 10_000,
      }),
    ).resolves.toBe(true);

    expect(tx.wallets.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'personal-wallet' },
      data: { balance: { increment: 7.425 } },
      select: { balance: true },
    });
    expect(tx.wallets.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'business-wallet' } }),
    );
    expect(tx.ledger_entries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          wallet_id: 'personal-wallet',
          amount: 7.425,
        }),
      }),
    );
    expect(websocket.emitBalanceUpdate).toHaveBeenCalledWith('owner-1', 32.425);
  });

  it('credits the business wallet for an invoice or payment-link checkout', async () => {
    const transaction = {
      id: 'transaction-invoice',
      amount: 7.5,
      receiver_wallet_id: 'business-wallet',
      transaction_type: 'merchant_payment',
      metadata: {
        provider: 'paystack',
        amount_fiat: 100,
        business_document: 'invoice',
      },
      qr_payments: [{ merchant_id: 'merchant-1' }],
    };
    const tx = {
      transactions: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      wallets: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'business-wallet',
          user_id: null,
          wallet_type: 'merchant',
          balance: 12.5,
        }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'personal-wallet',
          user_id: 'owner-1',
          wallet_type: 'user',
          balance: 25,
        }),
        update: jest.fn().mockResolvedValue({ balance: 19.925 }),
      },
      ledger_entries: { create: jest.fn().mockResolvedValue({}) },
      qr_payments: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      merchants: {
        findUnique: jest.fn().mockResolvedValue({ user_id: 'owner-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      users: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'superadmin-1',
          wallets: [{ id: 'superadmin-wallet-1', balance: 100 }],
        }),
      },
      businesses: { findFirst: jest.fn() },
      business_payments: { create: jest.fn() },
    };
    const prisma: any = {
      transactions: { findUnique: jest.fn().mockResolvedValue(transaction) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = new QrPaymentsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {
        invalidateWallet: jest.fn().mockResolvedValue(undefined),
        cacheDelete: jest.fn().mockResolvedValue(undefined),
        cacheInvalidatePattern: jest.fn().mockResolvedValue(undefined),
      } as any,
      { emitBalanceUpdate: jest.fn(), emitTransactionUpdate: jest.fn() } as any,
      { sendNotification: jest.fn().mockResolvedValue(undefined) } as any,
      {
        createForTransaction: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
        enqueuePdfAndEmail: jest.fn(),
      } as any,
    );
    await expect(
      service.complete('QR-INV', 'paystack', {
        status: 'success',
        reference: 'QR-INV',
        amount: 10_000,
      }),
    ).resolves.toBe(true);
    expect(tx.wallets.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'business-wallet' },
      data: { balance: { increment: 7.425 } },
      select: { balance: true },
    });
    expect(tx.business_payments.create).not.toHaveBeenCalled();
  });

  it('settles an IvoryPay QR payment from its documented verified token and crypto amount', async () => {
    const transaction = {
      id: 'transaction-ivory',
      amount: 7.5,
      receiver_wallet_id: 'wallet-1',
      transaction_type: 'merchant_payment',
      metadata: {
        type: 'qr_sale',
        isQrSale: true,
        provider: 'ivorypay',
        amount_fiat: 100,
        amount_usd: 1,
        crypto: 'USDT',
      },
      qr_payments: [{ merchant_id: 'merchant-1' }],
    };
    const tx = {
      transactions: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      wallets: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'wallet-1',
          user_id: 'owner-1',
          balance: 12.5,
        }),
        update: jest
          .fn()
          .mockResolvedValueOnce({ balance: 20 })
          .mockResolvedValueOnce({ balance: 100.075 }),
      },
      ledger_entries: { create: jest.fn().mockResolvedValue({}) },
      qr_payments: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      merchants: { update: jest.fn().mockResolvedValue({}) },
      users: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'superadmin-1',
          wallets: [{ id: 'superadmin-wallet-1', balance: 100 }],
        }),
      },
    };
    const prisma: any = {
      transactions: { findUnique: jest.fn().mockResolvedValue(transaction) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const cache = {
      invalidateWallet: jest.fn().mockResolvedValue(undefined),
      cacheDelete: jest.fn().mockResolvedValue(undefined),
      cacheInvalidatePattern: jest.fn().mockResolvedValue(undefined),
    };
    const websocket = {
      emitBalanceUpdate: jest.fn(),
      emitTransactionUpdate: jest.fn(),
    };
    const notifications = {
      sendNotification: jest.fn().mockResolvedValue(undefined),
    };
    const receipts = {
      createForTransaction: jest
        .fn()
        .mockResolvedValue({ id: 'receipt-ivory' }),
      enqueuePdfAndEmail: jest.fn(),
    };
    const service = new QrPaymentsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      cache as any,
      websocket as any,
      notifications as any,
      receipts as any,
    );

    await expect(
      service.complete(reference, 'ivorypay', {
        reference,
        status: 'SUCCESS',
        token: 'USDT',
        expectedAmountInCrypto: 1,
        receivedAmountInCrypto: 1,
      }),
    ).resolves.toBe(true);

    expect(tx.wallets.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: { increment: 7.425 } },
      select: { balance: true },
    });
    expect(tx.wallets.update).toHaveBeenCalledWith({
      where: { id: 'superadmin-wallet-1' },
      data: { balance: { increment: 0.075 } },
      select: { balance: true },
    });
    expect(receipts.enqueuePdfAndEmail).toHaveBeenCalledWith('receipt-ivory');
    expect(websocket.emitBalanceUpdate).toHaveBeenCalledWith('owner-1', 20);
    expect(notifications.sendNotification).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({ title: 'Merchant payment successful' }),
    );
  });

  it('does not settle a payment when the verified Paystack amount differs', async () => {
    const prisma: any = {
      transactions: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'transaction-1',
          amount: 7.5,
          receiver_wallet_id: 'wallet-1',
          metadata: {
            type: 'qr_sale',
            isQrSale: true,
            provider: 'paystack',
            amount_fiat: 100,
          },
          qr_payments: [{ merchant_id: 'merchant-1' }],
        }),
      },
      $transaction: jest.fn(),
    };
    const service = new QrPaymentsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.complete(reference, 'paystack', {
        status: 'success',
        reference,
        amount: 9_999,
      }),
    ).resolves.toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('QrPaymentsService public receipt download', () => {
  const completedQrTransaction = {
    id: 'transaction-qr',
    transaction_reference: 'QR-reference',
    status: 'completed',
    transaction_type: 'merchant_payment',
    metadata: { type: 'qr_sale', isQrSale: true },
    qr_payments: [{ merchant_id: 'merchant-1' }],
  };

  it('returns the receipt download for a completed public QR sale', async () => {
    const receipts = {
      getPublicDownloadUrlForTransaction: jest.fn().mockResolvedValue({
        data: { url: 'https://storage.example/receipt.pdf' },
      }),
    };
    const prisma: any = {
      transactions: {
        findFirst: jest.fn().mockResolvedValue(completedQrTransaction),
      },
    };
    const service = new QrPaymentsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      receipts as any,
    );

    await expect(
      service.getReceiptDownloadUrl('QR-reference'),
    ).resolves.toEqual({
      data: { url: 'https://storage.example/receipt.pdf' },
    });
    expect(receipts.getPublicDownloadUrlForTransaction).toHaveBeenCalledWith(
      'transaction-qr',
    );
  });

  it('does not expose receipts for incomplete QR payments', async () => {
    const receipts = {
      getPublicDownloadUrlForTransaction: jest.fn(),
    };
    const prisma: any = {
      transactions: {
        findFirst: jest.fn().mockResolvedValue({
          ...completedQrTransaction,
          status: 'pending',
        }),
      },
    };
    const service = new QrPaymentsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      receipts as any,
    );

    await expect(service.getReceiptDownloadUrl('QR-reference')).rejects.toThrow(
      'Completed QR payment receipt not found',
    );
    expect(receipts.getPublicDownloadUrlForTransaction).not.toHaveBeenCalled();
  });
});
