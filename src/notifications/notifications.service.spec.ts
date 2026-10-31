import { NotificationsService } from './notifications.service';
import axios from 'axios';

describe('NotificationsService.sendNotification for support replies', () => {
  it('stores the notification and sends a high-priority push', async () => {
    const notification = { id: 'notification-1' };
    const sendEachForMulticast = jest.fn().mockResolvedValue({
      responses: [{ success: true }],
      successCount: 1,
      failureCount: 0,
    });
    const prisma = {
      notifications: {
        create: jest.fn().mockResolvedValue(notification),
      },
      device_tokens: {
        findMany: jest.fn().mockResolvedValue([{ token: 'fcm-token' }]),
        updateMany: jest.fn(),
      },
    };
    const service = new NotificationsService(
      prisma as any,
      { get: jest.fn() } as any,
      { messaging: { sendEachForMulticast } } as any,
    );

    await service.sendNotification('user-1', {
      type: 'admin',
      title: 'Support replied',
      body: 'Support replied to your enquiry.',
      entityId: 'ticket-1',
      metadata: { category: 'support_reply', ticketId: 'ticket-1' },
    });

    expect(prisma.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: 'user-1',
          title: 'Support replied',
        }),
      }),
    );
    expect(sendEachForMulticast).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ['fcm-token'],
        notification: {
          title: 'Support replied',
          body: 'Support replied to your enquiry.',
        },
        android: expect.objectContaining({
          priority: 'high',
          notification: expect.objectContaining({
            channelId: 'farm_notifications',
          }),
        }),
        apns: expect.objectContaining({
          headers: { 'apns-priority': '10' },
        }),
        data: expect.objectContaining({
          type: 'admin',
          entityId: 'ticket-1',
          notificationId: 'notification-1',
        }),
      }),
    );
  });
});

describe('NotificationsService.notifyTransfer', () => {
  it('builds a richer transfer-received notification with sender username and no balance', async () => {
    const prisma = {
      users: {
        findUnique: jest.fn().mockImplementation(({ where }: any) => {
          if (where.id === 'sender-id') {
            return Promise.resolve({
              id: 'sender-id',
              first_name: 'John',
              last_name: 'Mwangi',
              username: 'john',
            });
          }
          return Promise.resolve({
            id: 'receiver-id',
            first_name: 'Grace',
            last_name: 'Njeri',
            username: 'grace',
          });
        }),
      },
      wallets: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (where.user_id === 'sender-id') {
            return Promise.resolve({ balance: 430 });
          }
          return Promise.resolve({ balance: 680 });
        }),
      },
    };

    const service = new NotificationsService(
      prisma as any,
      { get: jest.fn() } as any,
      {} as any,
    );
    const sendNotificationSpy = jest
      .spyOn(service, 'sendNotification')
      .mockResolvedValue({ id: 'notify-1' } as any);

    await service.notifyTransfer('sender-id', 'receiver-id', 250, 'tx-123');

    expect(sendNotificationSpy).toHaveBeenCalledWith(
      'receiver-id',
      expect.objectContaining({
        title: '💰 Money Received',
        body: expect.stringContaining('@john sent you 250 FARM.'),
      }),
    );
  });

  describe('NotificationsService password-reset email delivery', () => {
    const defaultConfigValues: Record<string, string | undefined> = {
      SMTP_PORT: '465',
      RESEND_API_KEY: 'test-resend-key',
      RESEND_FROM: 'FARM Support <support@farmapp.africa>',
    };
    const createService = (
      configValues: Record<string, string | undefined> = defaultConfigValues,
    ) =>
      new NotificationsService(
        {} as any,
        { get: jest.fn((key: string) => configValues[key]) } as any,
        {} as any,
      );

    afterEach(() => {
      jest.restoreAllMocks();
    });

    describe('NotificationsService receipt email delivery', () => {
      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('sends the generated receipt PDF as a Resend attachment', async () => {
        const service = new NotificationsService(
          {} as any,
          {
            get: jest.fn(
              (key: string) =>
                ({
                  RESEND_API_KEY: 'test-resend-key',
                  RESEND_FROM: 'FARM <receipts@farmapp.africa>',
                })[key],
            ),
          } as any,
          {} as any,
        );
        const post = jest.spyOn(axios, 'post').mockResolvedValue({});

        await service.sendReceiptEmailOrThrow({
          to: 'merchant@example.com',
          bcc: 'customer@example.com',
          receiptNumber: 'FARM-2026-TRANSACTION',
          amount: 500,
          currency: 'KES',
          creditedAmount: 3.846,
          pdfBase64: 'cGRm',
          logoBase64: 'bG9nbw==',
          merchantName: 'Farm Shop',
          merchantEmail: 'shop@example.com',
          merchantPhone: '+254700000000',
          merchantLocation: 'Nairobi, Kenya',
          transactionId: 'QR-reference-123',
          paymentMethod: 'card',
          paidAt: '13 Oct 2026, 2:30 PM',
          downloadUrl: 'https://storage.example/download',
          viewUrl: 'https://storage.example/view',
        });

        expect(post).toHaveBeenCalledWith(
          'https://api.resend.com/emails',
          expect.objectContaining({
            to: 'merchant@example.com',
            bcc: 'customer@example.com',
            subject: 'FARM payment receipt FARM-2026-TRANSACTION',
            html: expect.stringContaining('Payment successful'),
            text: expect.stringContaining('Download Receipt (PDF)'),
            attachments: [
              {
                filename: 'FARM-2026-TRANSACTION.pdf',
                content: 'cGRm',
              },
              {
                filename: 'farm-logo.png',
                content: 'bG9nbw==',
                content_id: 'farm-brand-logo',
              },
            ],
          }),
          expect.any(Object),
        );
        const request = post.mock.calls[0][1] as {
          html: string;
          text: string;
        };
        expect(request.html).toContain('Farm Shop');
        expect(request.html).toContain('500.00 KES');
        expect(request.html).toContain('3.846 FARM');
        expect(request.html).toContain('QR-reference-123');
        expect(request.html).toContain('card');
        expect(request.html).toContain('13 Oct 2026, 2:30 PM');
        expect(request.html).toContain('https://storage.example/download');
        expect(request.html).toContain('https://storage.example/view');
        expect(request.html).toContain('support@farmapp.africa');
        expect(request.html).toContain('https://farmapp.africa');
        expect(request.text).toContain('Transaction ID: QR-reference-123');
        expect(post.mock.calls[0][2]).toEqual(
          expect.objectContaining({
            headers: {
              Authorization: 'Bearer test-resend-key',
              'Content-Type': 'application/json',
            },
          }),
        );
      });
    });

    it('sends reset email through the Resend HTTPS API', async () => {
      const service = createService();
      const post = jest.spyOn(axios, 'post').mockResolvedValue({});

      await service.sendEmailOrThrow(
        'person@example.com',
        'Reset your FARM password',
        '<p>Reset</p>',
        'Reset your password',
      );

      expect(post).toHaveBeenCalledWith(
        'https://api.resend.com/emails',
        {
          from: 'FARM Support <support@farmapp.africa>',
          to: 'person@example.com',
          subject: 'Reset your FARM password',
          html: '<p>Reset</p>',
          text: 'Reset your password',
        },
        {
          headers: {
            Authorization: 'Bearer test-resend-key',
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );
    });

    it('fails clearly when the Resend API key or sender is missing', async () => {
      const service = createService({
        ...defaultConfigValues,
        RESEND_API_KEY: undefined,
      });
      const post = jest.spyOn(axios, 'post');

      await expect(
        service.sendEmailOrThrow(
          'person@example.com',
          'Reset',
          '<p>Reset</p>',
          'Reset',
        ),
      ).rejects.toThrow('Transactional email API is not configured');
      expect(post).not.toHaveBeenCalled();
    });

    it('does not expose provider response details when API delivery fails', async () => {
      const service = createService();
      jest.spyOn(axios, 'post').mockRejectedValue(
        Object.assign(new Error('provider returned private diagnostic'), {
          isAxiosError: true,
          response: {
            status: 403,
            data: {
              name: 'validation_error',
              message: 'example.com is not verified',
            },
          },
        }),
      );
      const errorLog = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation();

      await expect(
        service.sendEmailOrThrow(
          'person@example.com',
          'Reset',
          '<p>Reset</p>',
          'Reset',
        ),
      ).rejects.toThrow(
        'Transactional email provider rejected the request (HTTP 403)',
      );
      expect(errorLog).toHaveBeenCalledWith(
        'Transactional email API delivery failed (HTTP 403) (validation_error)',
      );
      expect(errorLog).not.toHaveBeenCalledWith(
        expect.stringContaining('example.com'),
      );
    });
  });
});
