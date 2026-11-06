import { QrService } from './qr.service';
import { createHmac } from 'crypto';

describe('QrService merchant QR validation', () => {
  it('creates a public pay link for the merchant QR code', () => {
    const service = new QrService(
      {} as any,
      {} as any,
      {} as any,
      { get: () => 'https://farmapp.africa/merchant-payment/' } as any,
      {} as any,
      {} as any,
    );

    const url = (service as any).checkoutUrl('{"merchant_id":"merchant-1"}');

    expect(url).toBe('https://farmpay.africa/checkout/merchant-1');
  });

  it('trims merchant IDs and removes stray braces from public pay links', () => {
    const service = new QrService(
      {} as any,
      {} as any,
      {} as any,
      { get: () => 'https://farmapp.africa/merchant-payment/' } as any,
      {} as any,
      {} as any,
    );

    const url = (service as any).checkoutUrl(
      '{"merchant_id":" {merchant-1} "}',
    );

    expect(url).toBe('https://farmpay.africa/checkout/merchant-1');
  });

  it('validates a signed merchant QR scanned from its hosted checkout URL', async () => {
    const secret = 'merchant-secret';
    const payload = {
      merchant_id: 'merchant-1',
      business_name: 'Test Merchant',
      v: 1,
    };
    const sig = createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');
    const signedPayload = JSON.stringify({ ...payload, sig });
    const qr = Buffer.from(signedPayload).toString('base64url');
    const prisma: any = {
      merchants: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'merchant-1',
          status: 'approved',
          business_name: 'Test Merchant',
          qr_secret: secret,
        }),
      },
    };
    const service = new QrService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.validate(
        `https://farmapp.africa/merchant-payment/?qr=${qr}`,
        'customer-1',
      ),
    ).resolves.toMatchObject({
      data: {
        valid: true,
        type: 'merchant',
        merchant_id: 'merchant-1',
        business_name: 'Test Merchant',
      },
    });
  });

  describe('QrService merchant QR settlement fees', () => {
    it('credits only the owner personal wallet for a QR sale', async () => {
      const previousFlag = process.env.BUSINESS_WALLET_ENABLED;
      process.env.BUSINESS_WALLET_ENABLED = 'true';
      try {
        const merchant = {
          id: 'merchant-1',
          user_id: 'merchant-owner-1',
          status: 'approved',
          business_name: 'Test Merchant',
          transaction_fee_percent: 0,
        };
        const businessWallet = {
          id: 'business-wallet',
          wallet_type: 'merchant',
          balance: 20,
        };
        const personalWallet = {
          id: 'personal-wallet',
          user_id: merchant.user_id,
          wallet_type: 'user',
          balance: 30,
        };
        const tx: any = {
          transactions: {
            create: jest.fn().mockResolvedValue({ id: 'transaction-1' }),
          },
          wallets: {
            update: jest
              .fn()
              .mockResolvedValueOnce({ balance: 398 })
              .mockResolvedValueOnce({ balance: 119 })
              .mockResolvedValueOnce({ balance: 129 })
              .mockResolvedValueOnce({ balance: 101 }),
            findFirst: jest.fn().mockResolvedValue(null),
          },
          users: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'superadmin-1',
              wallets: [{ id: 'superadmin-wallet-1' }],
            }),
          },
          merchants: { update: jest.fn().mockResolvedValue({}) },
          qr_payments: { create: jest.fn().mockResolvedValue({}) },
          business_payments: { create: jest.fn().mockResolvedValue({}) },
          ledger_entries: { createMany: jest.fn().mockResolvedValue({}) },
        };
        const prisma: any = {
          merchants: { findUnique: jest.fn().mockResolvedValue(merchant) },
          businesses: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'business-1',
              wallet_id: businessWallet.id,
              owner_user_id: merchant.user_id,
              status: 'approved',
              trading_name: merchant.business_name,
            }),
          },
          wallets: {
            findFirst: jest
              .fn()
              .mockResolvedValueOnce({ id: 'customer-wallet', balance: 500 })
              .mockResolvedValueOnce(personalWallet),
            findUnique: jest.fn().mockResolvedValue(businessWallet),
          },
          users: {
            findUnique: jest.fn().mockResolvedValue({ username: 'payer' }),
          },
          $transaction: jest.fn((callback) => callback(tx)),
        };
        const service = new QrService(
          prisma,
          { verifyPin: jest.fn().mockResolvedValue(undefined) } as any,
          {} as any,
          {} as any,
          { sendNotification: jest.fn().mockResolvedValue(undefined) } as any,
          {
            emitBalanceUpdate: jest.fn(),
            emitTransactionUpdate: jest.fn(),
          } as any,
          {
            invalidateWallet: jest.fn().mockResolvedValue(undefined),
            cacheDelete: jest.fn().mockResolvedValue(undefined),
          } as any,
        );
        jest.spyOn(service, 'validate').mockResolvedValue({
          data: {
            valid: true,
            type: 'merchant',
            merchant_id: merchant.id,
          },
        } as any);

        await service.merchantPay('customer-1', {
          qr_payload: 'merchant-qr',
          amount: 100,
          pin: '1234',
        });

        expect(tx.wallets.update).toHaveBeenNthCalledWith(2, {
          where: { id: personalWallet.id },
          data: { balance: { increment: 99 } },
        });
        expect(tx.wallets.update).not.toHaveBeenCalledWith({
          where: { id: businessWallet.id },
          data: { balance: { increment: 99 } },
        });
        expect(tx.business_payments.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            business_id: 'business-1',
            source: 'qr',
            channel: 'qr',
          }),
        });
        expect(tx.ledger_entries.createMany).toHaveBeenCalledWith({
          data: expect.arrayContaining([
            expect.objectContaining({
              wallet_id: personalWallet.id,
              amount: 99,
            }),
          ]),
        });
      } finally {
        if (previousFlag === undefined) {
          delete process.env.BUSINESS_WALLET_ENABLED;
        } else {
          process.env.BUSINESS_WALLET_ENABLED = previousFlag;
        }
      }
    });

    it('deducts 1% from the sale, credits superadmin, and preserves buyer surcharge', async () => {
      const merchant = {
        id: 'merchant-1',
        user_id: 'merchant-owner-1',
        status: 'approved',
        business_name: 'Test Merchant',
        transaction_fee_percent: 2,
      };
      const transaction = {
        id: 'transaction-1',
        transaction_reference: 'FARM-TEST-1',
      };
      const tx: any = {
        transactions: { create: jest.fn().mockResolvedValue(transaction) },
        wallets: {
          update: jest
            .fn()
            .mockResolvedValueOnce({ balance: 398 })
            .mockResolvedValueOnce({ balance: 119 })
            .mockResolvedValueOnce({ balance: 101 }),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'superadmin-1',
            wallets: [{ id: 'superadmin-wallet-1' }],
          }),
        },
        merchants: { update: jest.fn().mockResolvedValue({}) },
        qr_payments: { create: jest.fn().mockResolvedValue({}) },
        ledger_entries: {
          createMany: jest.fn().mockResolvedValue({ count: 3 }),
        },
      };
      const prisma: any = {
        merchants: { findUnique: jest.fn().mockResolvedValue(merchant) },
        businesses: { findFirst: jest.fn().mockResolvedValue(null) },
        wallets: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 'customer-wallet', balance: 500 })
            .mockResolvedValueOnce({
              id: 'merchant-wallet',
              balance: 20,
            }),
        },
        users: {
          findUnique: jest.fn().mockResolvedValue({ username: 'payer' }),
        },
        $transaction: jest.fn((callback) => callback(tx)),
      };
      const notifications = {
        sendNotification: jest.fn().mockResolvedValue(undefined),
      };
      const websocket = {
        emitBalanceUpdate: jest.fn(),
        emitTransactionUpdate: jest.fn(),
      };
      const cache = {
        invalidateWallet: jest.fn().mockResolvedValue(undefined),
        cacheDelete: jest.fn().mockResolvedValue(undefined),
      };
      const service = new QrService(
        prisma,
        { verifyPin: jest.fn().mockResolvedValue(undefined) } as any,
        {} as any,
        {} as any,
        notifications as any,
        websocket as any,
        cache as any,
      );
      jest.spyOn(service, 'validate').mockResolvedValue({
        data: {
          valid: true,
          type: 'merchant',
          merchant_id: merchant.id,
        },
      } as any);

      const result = await service.merchantPay('customer-1', {
        qr_payload: 'merchant-qr',
        amount: 100,
        pin: '1234',
      });

      expect(tx.transactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amount: 100,
            fee: 1,
            net_amount: 99,
            metadata: expect.objectContaining({
              platform_fee_type: 'merchant_sale',
              platform_fee: 1,
              customer_fee: 2,
            }),
          }),
        }),
      );
      expect(tx.wallets.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'customer-wallet' },
        data: { balance: { decrement: 102 } },
      });
      expect(tx.wallets.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'merchant-wallet' },
        data: { balance: { increment: 99 } },
      });
      expect(tx.wallets.update).toHaveBeenNthCalledWith(3, {
        where: { id: 'superadmin-wallet-1' },
        data: { balance: { increment: 1 } },
      });
      expect(tx.ledger_entries.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            wallet_id: 'merchant-wallet',
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
      expect(result.data).toEqual(
        expect.objectContaining({
          amount: 100,
          fee: 2,
          platform_fee: 1,
          merchant_net: 99,
        }),
      );
      expect(notifications.sendNotification).toHaveBeenCalledWith(
        'merchant-owner-1',
        expect.objectContaining({
          body: expect.stringContaining('You received 99 FARM'),
        }),
      );
      expect(cache.invalidateWallet).toHaveBeenCalledWith('superadmin-1');
      expect(cache.cacheDelete).toHaveBeenCalledWith(
        'admin:superadmin-dashboard',
      );
    });
  });

  it('validates a public merchant pay URL scanned in the app', async () => {
    const prisma: any = {
      merchants: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'merchant-1',
          status: 'approved',
          business_name: 'Test Merchant',
          transaction_fee_percent: 0,
          daily_limit: 0,
        }),
      },
    };
    const service = new QrService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.validate('https://farmapp.africa/pay/merchant-1', 'customer-1'),
    ).resolves.toMatchObject({
      data: {
        valid: true,
        type: 'merchant',
        merchant_id: 'merchant-1',
        business_name: 'Test Merchant',
      },
    });
  });

  it('rejects QR validation for a merchant that is not approved', async () => {
    const prisma: any = {
      merchants: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'merchant-1',
          status: 'pending',
        }),
      },
    };
    const service = new QrService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.validate(
        JSON.stringify({ merchant_id: 'merchant-1' }),
        'customer-1',
      ),
    ).rejects.toThrow('Merchant is not approved to accept payments');
  });
});
