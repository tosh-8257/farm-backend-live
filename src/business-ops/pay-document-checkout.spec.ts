import { BusinessWebCheckoutService } from './business-web-checkout.service';
import { invoiceUrl, linkUrl } from './business-commerce.service';

/**
 * The live farmpay.africa checkout (pay-doc.html) does this for every path
 * that is not /merchant-payment:
 *   merchantId = path[1]
 *   if (merchantId.length < 10) throw "Invalid QR code..."
 * /pay/l/:code therefore loads merchant id "l" and never calls the pay API.
 */
export function hostedCheckoutMerchantId(pathname: string) {
  const path = pathname.split('/').filter(Boolean);
  const legacy = path[0] === 'merchant-payment';
  return legacy ? '' : (path[1] ?? '');
}

describe('invoice and payment-link checkout', () => {
  const prev = process.env.PAYMENT_BASE_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAYMENT_BASE_URL;
    else process.env.PAYMENT_BASE_URL = prev;
  });

  it('shares farmpay.africa /pay/l and /pay/i urls, which the QR page misreads', () => {
    delete process.env.PAYMENT_BASE_URL;
    const link = linkUrl('Ab12Cd34');
    const invoice = invoiceUrl('INV-2026-A1B2C3D4');
    expect(link).toBe('https://farmpay.africa/pay/l/Ab12Cd34');
    expect(invoice).toBe('https://farmpay.africa/pay/i/INV-2026-A1B2C3D4');
    expect(hostedCheckoutMerchantId('/pay/l/Ab12Cd34')).toBe('l');
    expect(hostedCheckoutMerchantId('/pay/l/Ab12Cd34').length < 10).toBe(true);
    expect(hostedCheckoutMerchantId('/checkout/merchant-uuid-1')).not.toBe('l');
  });

  it('starts a provider checkout as an invoice or payment link, not a QR sale', async () => {
    const prisma: any = {
      business_payment_links: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'link-1',
          business_id: 'biz-1',
          code: 'Ab12Cd34',
          title: 'Till',
          description: null,
          amount: 10,
          is_active: true,
          expires_at: null,
          max_uses: null,
          use_count: 0,
        }),
      },
      businesses: {
        findUnique: jest.fn().mockResolvedValue({ merchant_id: 'merchant-1' }),
      },
      business_web_checkouts: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const qr = {
      initialize: jest.fn().mockResolvedValue({
        data: {
          authorization_url: 'https://checkout.paystack.com/abc',
          reference: 'QR-1',
        },
      }),
    };
    const svc = new BusinessWebCheckoutService(
      prisma,
      {
        businessName: jest.fn().mockResolvedValue({
          trading_name: 'Shop',
          legal_name: 'Shop Ltd',
          status: 'approved',
        }),
        linkState: jest.fn().mockReturnValue('active'),
      } as any,
      qr as any,
      {
        getCurrentRate: jest.fn().mockResolvedValue({ farm_kes_rate: 1 }),
      } as any,
      { emit: jest.fn() } as any,
    );
    const started = await svc.start('link', 'Ab12Cd34', 'mpesa', 'a@b.co');
    expect(started.url).toBe('https://checkout.paystack.com/abc');
    expect(qr.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: 'merchant-1', method: 'mpesa' }),
      { businessDocument: 'payment_link' },
    );
  });

  it('marks the invoice paid and notifies the owner after the provider confirms', async () => {
    const prisma: any = {
      business_web_checkouts: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'chk-1',
          business_id: 'biz-1',
          source: 'invoice',
          source_id: 'inv-1',
          transaction_reference: 'QR-1',
          amount: 10,
          status: 'pending',
          reserved: true,
          expires_at: new Date(Date.now() + 60_000),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      transactions: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ amount: 10, status: 'completed' }),
      },
      business_payments: { create: jest.fn().mockResolvedValue({}) },
      business_invoices: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      businesses: {
        findUnique: jest.fn().mockResolvedValue({ owner_user_id: 'owner-1' }),
      },
    };
    const notifications = {
      sendNotification: jest.fn().mockResolvedValue(undefined),
    };
    const webhooks = { emit: jest.fn() };
    const svc = new BusinessWebCheckoutService(
      prisma,
      {} as any,
      {
        verify: jest.fn().mockResolvedValue({ data: { status: 'completed' } }),
      } as any,
      {} as any,
      webhooks as any,
      notifications as any,
    );
    await expect(svc.reconcile('QR-1')).resolves.toBe('completed');
    expect(prisma.business_invoices.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'paid',
          transaction_reference: 'QR-1',
        }),
      }),
    );
    expect(notifications.sendNotification).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({ title: 'Invoice paid' }),
    );
    expect(webhooks.emit).toHaveBeenCalledWith(
      'biz-1',
      'live',
      'invoice.paid',
      expect.objectContaining({ invoice_id: 'inv-1' }),
    );
  });
});
