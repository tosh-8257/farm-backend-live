import { Test } from '@nestjs/testing';
import { DepositService } from './deposit.service';
import { PrismaService } from '../database/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { IvorypayService } from '../ivorypay/ivorypay.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { CacheService } from '../common/cache/cache.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CurrencyConversionService } from '../currency/currency-conversion.service';
import { NowpaymentsService } from '../nowpayments/nowpayments.service';

describe('DepositService', () => {
  let service: DepositService;
  let prisma: any;
  let ivorypay: any;
  let paystack: any;
  let websocket: any;
  let cache: any;
  let notifications: any;
  let currencyConversion: any;
  let nowpayments: any;

  beforeEach(async () => {
    prisma = {
      deposit: {
        create: jest.fn(),
        update: jest.fn(),
      },
      transactions: {
        create: jest.fn(),
      },
      audit_logs: {
        create: jest.fn(),
      },
    };

    ivorypay = {
      createPayment: jest.fn(),
    };

    paystack = {};
    websocket = {};
    cache = {};
    notifications = {};
    currencyConversion = {};
    nowpayments = {
      getAvailableCurrencies: jest.fn().mockResolvedValue(['btc']),
      getMinimumPaymentAmount: jest.fn().mockResolvedValue({
        currency: 'btc',
        minimumAmount: 0.00001,
        minimumUsd: 1.5,
      }),
      estimateAmount: jest.fn().mockResolvedValue(0.00005),
      createPayment: jest.fn(),
      getPayment: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        DepositService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaystackService, useValue: paystack },
        { provide: IvorypayService, useValue: ivorypay },
        { provide: WebsocketGateway, useValue: websocket },
        { provide: CacheService, useValue: cache },
        { provide: NotificationsService, useValue: notifications },
        { provide: CurrencyConversionService, useValue: currencyConversion },
        { provide: NowpaymentsService, useValue: nowpayments },
      ],
    }).compile();

    service = module.get(DepositService);
  });

  it('rejects crypto deposits on the generic deposit endpoint', async () => {
    await expect(
      service.createDeposit('user-1', {
        amount_fiat: 1,
        paymentMethod: 'CRYPTO',
        email: 'user@example.com',
      }),
    ).rejects.toThrow('dedicated /api/v1/crypto/deposit endpoint');
  });

  it('does not create a generic deposit for crypto requests', async () => {
    await expect(
      service.createDeposit('user-2', {
        amount_fiat: 2,
        paymentMethod: 'CRYPTO',
        email: 'user2@example.com',
      }),
    ).rejects.toThrow('dedicated /api/v1/crypto/deposit endpoint');
    expect(prisma.deposit.create).not.toHaveBeenCalled();
  });

  it('returns a server-side NOWPayments estimate and effective minimum', async () => {
    const result = await service.getNowpaymentsCryptoEstimate('BTC', '2');

    expect(nowpayments.estimateAmount).toHaveBeenCalledWith(2, 'usd', 'btc');
    expect(result.data).toEqual({
      currency: 'btc',
      priceAmount: 2,
      estimatedAmount: 0.00005,
      minimumAmount: 0.00001,
      minimumUsd: 1.5,
      minimumDepositUsd: 2,
    });
  });

  it('rejects estimates for unsupported NOWPayments currencies', async () => {
    await expect(
      service.getNowpaymentsCryptoEstimate('doge', 2),
    ).rejects.toThrow('The selected cryptocurrency is not currently available');
    expect(nowpayments.estimateAmount).not.toHaveBeenCalled();
  });

  it('charges card deposits only the amount entered by the user', async () => {
    paystack.initializePayment = jest.fn().mockResolvedValue({
      authorization_url: 'https://checkout.example.test/payment',
      access_code: 'paystack-access-code',
    });
    prisma.deposit.create.mockResolvedValue({
      id: 'deposit-1',
      amount: 10,
      fee: 0,
      total: 10,
      currency: 'KES',
      paymentMethod: 'CARD',
      provider: 'paystack',
      reference: 'reference-1',
      status: 'PENDING',
    });

    const result = await service.createDeposit('user-1', {
      amount_fiat: 10,
      currency: 'KES',
      paymentMethod: 'CARD',
      email: 'user@example.com',
    });

    expect(paystack.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10, channels: ['card'] }),
    );
    expect(prisma.deposit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: 10, fee: 0, total: 10 }),
      }),
    );
    expect(result.deposit.fee).toBe(0);
    expect(result.deposit.total).toBe(10);
    expect(result.access_code).toBe('paystack-access-code');
  });

  it('charges mobile money deposits only the amount entered by the user', async () => {
    paystack.initializePayment = jest.fn().mockResolvedValue({
      authorization_url: 'https://checkout.example.test/payment',
    });
    prisma.deposit.create.mockResolvedValue({
      id: 'deposit-2',
      amount: 100,
      fee: 0,
      total: 100,
      currency: 'KES',
      paymentMethod: 'MOBILE_MONEY',
      provider: 'paystack',
      reference: 'reference-2',
      status: 'PENDING',
    });

    const result = await service.createDeposit('user-1', {
      amount_fiat: 100,
      currency: 'KES',
      paymentMethod: 'MOBILE_MONEY',
      phone: '+254700000000',
      email: 'user@example.com',
    });

    expect(paystack.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100,
        channels: ['mobile_money'],
        phone: '+254700000000',
      }),
    );
    expect(prisma.deposit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: 100, fee: 0, total: 100 }),
      }),
    );
    expect(result.deposit.fee).toBe(0);
    expect(result.deposit.total).toBe(100);
  });

  it('initializes KES bank deposits through Paystack bank_transfer checkout', async () => {
    paystack.initializePayment = jest.fn().mockResolvedValue({
      authorization_url: 'https://checkout.example.test/payment',
      access_code: 'pesalink-access-code',
    });
    prisma.deposit.create.mockResolvedValue({
      id: 'deposit-3',
      amount: 100,
      fee: 0,
      total: 100,
      currency: 'KES',
      paymentMethod: 'BANK_TRANSFER',
      provider: 'paystack',
      reference: 'reference-3',
      status: 'PENDING',
    });

    const result = await service.createDeposit('user-1', {
      amount_fiat: 100,
      currency: 'KES',
      paymentMethod: 'BANK_TRANSFER',
      email: 'user@example.com',
    });

    expect(paystack.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100,
        currency: 'KES',
        channels: ['bank_transfer'],
      }),
    );
    expect(result).toMatchObject({
      payment_url: 'https://checkout.example.test/payment',
      authorization_url: 'https://checkout.example.test/payment',
      access_code: 'pesalink-access-code',
    });
    expect(result.deposit).toMatchObject({
      currency: 'KES',
      paymentMethod: 'BANK_TRANSFER',
      status: 'PENDING',
    });
  });

  it('does not leave a pending deposit when Paystack rejects bank checkout', async () => {
    paystack.initializePayment = jest
      .fn()
      .mockRejectedValue(new Error('Paystack bank channel unavailable'));

    await expect(
      service.createDeposit('user-1', {
        amount_fiat: 100,
        currency: 'KES',
        paymentMethod: 'BANK_TRANSFER',
        email: 'user@example.com',
      }),
    ).rejects.toThrow('Paystack bank channel unavailable');

    expect(prisma.deposit.create).not.toHaveBeenCalled();
    expect(prisma.transactions.create).not.toHaveBeenCalled();
  });

  it('credits a successful bank-transfer deposit to the depositing user wallet once', async () => {
    const deposit = {
      id: 'bank-deposit-1',
      userId: 'user-1',
      amount: 100,
      currency: 'KES',
      paymentMethod: 'BANK_TRANSFER',
      provider: 'paystack',
      reference: 'bank-reference-1',
      status: 'PENDING',
    };
    const transaction = {
      id: 'bank-transaction-1',
      transaction_reference: deposit.reference,
      transaction_type: 'deposit',
      status: 'pending',
      amount: 100,
      currency: 'KES',
      metadata: {
        provider: 'paystack',
        user_id: deposit.userId,
        payment_method: 'BANK_TRANSFER',
      },
    };
    const wallet = {
      id: 'user-wallet-1',
      user_id: deposit.userId,
      balance: 250,
    };
    const tx = {
      wallets: {
        findFirst: jest.fn().mockResolvedValue(wallet),
        update: jest.fn().mockResolvedValue({}),
      },
      deposit: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
      ledger_entries: { create: jest.fn().mockResolvedValue({}) },
      transactions: { update: jest.fn().mockResolvedValue({}) },
    };

    paystack.verifyTransaction = jest
      .fn()
      .mockResolvedValue({ status: 'success' });
    prisma.deposit.findFirst = jest.fn().mockResolvedValue(deposit);
    prisma.transactions.findUnique = jest.fn().mockResolvedValue(transaction);
    prisma.$transaction = jest.fn((callback) => callback(tx));
    cache.cacheInvalidatePattern = jest.fn().mockResolvedValue(undefined);
    cache.cacheDelete = jest.fn().mockResolvedValue(undefined);

    await expect(
      service.finalizeSuccessfulDeposit(deposit.reference),
    ).resolves.toBe(true);
    await expect(
      service.finalizeSuccessfulDeposit(deposit.reference),
    ).resolves.toBe(false);

    expect(paystack.verifyTransaction).toHaveBeenCalledWith(deposit.reference);
    expect(tx.wallets.findFirst).toHaveBeenCalledWith({
      where: { user_id: deposit.userId, is_active: true },
    });
    expect(tx.wallets.update).toHaveBeenCalledTimes(1);
    expect(tx.wallets.update).toHaveBeenCalledWith({
      where: { id: wallet.id },
      data: { balance: { increment: deposit.amount } },
    });
    expect(tx.ledger_entries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          wallet_id: wallet.id,
          entry_type: 'credit',
          amount: deposit.amount,
        }),
      }),
    );
    expect(tx.transactions.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: transaction.id },
        data: expect.objectContaining({
          status: 'completed',
          receiver_wallet_id: wallet.id,
        }),
      }),
    );
  });

  it('deducts the public merchant QR fee before crediting wallets', async () => {
    const transaction = {
      id: 'transaction-qr-1',
      transaction_reference: 'qr-reference-1',
      transaction_type: 'deposit',
      status: 'pending',
      amount: 100,
      currency: 'FARM',
      metadata: {
        provider: 'ivorypay',
        user_id: 'merchant-user-1',
        merchant_id: 'merchant-1',
        qr_guest_payment: true,
      },
    };
    const deposit = {
      id: 'deposit-qr-1',
      userId: 'merchant-user-1',
      amount: 100,
      currency: 'FARM',
      status: 'PENDING',
    };
    const merchantWallet = {
      id: 'merchant-wallet-1',
      balance: 10,
    };
    const superadminWallet = {
      id: 'superadmin-wallet-1',
      balance: 0,
    };
    const tx: any = {
      merchants: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'merchant-1',
          user_id: 'merchant-user-1',
          business_name: 'Test Merchant',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      wallets: {
        findFirst: jest.fn().mockResolvedValue(merchantWallet),
        update: jest
          .fn()
          .mockResolvedValueOnce({ balance: 109 })
          .mockResolvedValueOnce({ balance: 1 }),
      },
      users: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'superadmin-1',
          wallets: [superadminWallet],
        }),
      },
      deposit: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      transactions: {
        update: jest.fn().mockResolvedValue({}),
      },
      qr_payments: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ledger_entries: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    prisma.deposit.findFirst = jest.fn().mockResolvedValue(deposit);
    prisma.transactions.findUnique = jest.fn().mockResolvedValue(transaction);
    prisma.$transaction = jest.fn((callback) => callback(tx));
    cache.cacheInvalidatePattern = jest.fn().mockResolvedValue(undefined);
    cache.cacheDelete = jest.fn().mockResolvedValue(undefined);
    websocket.emitBalanceUpdate = jest.fn();
    notifications.sendNotification = jest.fn().mockResolvedValue(undefined);

    await expect(
      service.finalizeSuccessfulDeposit(transaction.transaction_reference),
    ).resolves.toBe(true);

    expect(tx.wallets.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'merchant-wallet-1' },
      data: { balance: { increment: 99 } },
    });
    expect(tx.wallets.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'superadmin-wallet-1' },
      data: { balance: { increment: 1 } },
    });
    expect(tx.transactions.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: transaction.id },
        data: expect.objectContaining({
          transaction_type: 'merchant_payment',
          status: 'completed',
          fee: 1,
          net_amount: 99,
          receiver_wallet_id: 'merchant-wallet-1',
          metadata: expect.objectContaining({
            platform_fee_type: 'merchant_sale',
            platform_fee_percent: 1,
            platform_fee: 1,
          }),
        }),
      }),
    );
    expect(tx.ledger_entries.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          wallet_id: 'merchant-wallet-1',
          entry_type: 'credit',
          amount: 99,
        }),
        expect.objectContaining({
          wallet_id: 'superadmin-wallet-1',
          entry_type: 'credit',
          amount: 1,
        }),
      ]),
    });
  });
});
