import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { CurrencyConversionService } from '../currency/currency-conversion.service';
import { QrPaymentsService } from '../qr-payments/qr-payments.service';
import { BusinessCommerceService } from './business-commerce.service';
import { BusinessWebhooksService } from './business-webhooks.service';
import { NotificationsService } from '../notifications/notifications.service';

const PAYABLE = ['sent', 'pending', 'overdue'];
/** How long a started web checkout holds a link use or an invoice. */
export const HOLD_MINUTES = 60;
export const WEB_METHODS = ['mpesa', 'card', 'bank', 'crypto'] as const;
export type WebMethod = (typeof WEB_METHODS)[number];

/**
 * Hosted web checkout for payers without the FARM app. The payer pays in KES
 * through the existing guest merchant checkout (QrPaymentsService), which
 * credits the business settlement wallet (not a merchant QR personal credit).
 * This service records the invoice or link and notifies the owner; the wallet
 * credit happens in QrPaymentsService.complete.
 */
@Injectable()
export class BusinessWebCheckoutService {
  private readonly logger = new Logger(BusinessWebCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commerce: BusinessCommerceService,
    private readonly qr: QrPaymentsService,
    private readonly currency: CurrencyConversionService,
    private readonly webhooks: BusinessWebhooksService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** Details for the public pay page. */
  async target(kind: 'link' | 'invoice', ref: string) {
    if (kind === 'link') {
      const l = await this.prisma.business_payment_links.findUnique({
        where: { code: ref },
      });
      if (!l) throw new NotFoundException('Payment link not found');
      const b = await this.commerce.businessName(l.business_id);
      return {
        kind,
        id: l.id,
        business_id: l.business_id,
        ref: l.code,
        title: l.title,
        description: l.description ?? '',
        amount: Number(l.amount),
        payable: this.commerce.linkState(l) === 'active',
        state: this.commerce.linkState(l),
        business_name: b.trading_name || b.legal_name,
      };
    }
    const inv = await this.prisma.business_invoices.findUnique({
      where: { invoice_number: ref },
    });
    if (!inv || inv.status === 'draft')
      throw new NotFoundException('Invoice not found');
    const b = await this.commerce.businessName(inv.business_id);
    return {
      kind,
      id: inv.id,
      business_id: inv.business_id,
      ref: inv.invoice_number,
      title: `Invoice ${inv.invoice_number}`,
      description: inv.due_date
        ? `Due ${inv.due_date.toISOString().slice(0, 10)}`
        : '',
      amount: Number(inv.total),
      payable: PAYABLE.includes(inv.status),
      state: inv.status,
      business_name: b.trading_name || b.legal_name,
    };
  }

  async quoteKes(amountFarm: number) {
    const rate = Number((await this.currency.getCurrentRate()).farm_kes_rate);
    if (!Number.isFinite(rate) || rate <= 0)
      throw new BadRequestException('The FARM exchange rate is unavailable');
    return Math.round(amountFarm * rate * 100) / 100;
  }

  /** Starts a provider checkout and returns the provider URL to redirect to. */
  async start(
    kind: 'link' | 'invoice',
    ref: string,
    method: string,
    email?: string,
  ) {
    if (!WEB_METHODS.includes(method as WebMethod))
      throw new BadRequestException('Choose a payment method');
    const t = await this.target(kind, ref);
    if (!t.payable)
      throw new GoneException(
        `This ${kind === 'link' ? 'link' : 'invoice'} cannot be paid (${t.state})`,
      );
    const biz = await this.prisma.businesses.findUnique({
      where: { id: t.business_id },
      select: { merchant_id: true },
    });
    if (!biz?.merchant_id)
      throw new BadRequestException(
        'This business cannot accept web payments yet. Pay in the FARM app.',
      );
    const amountKes = await this.quoteKes(t.amount);
    // Claim the link use / invoice BEFORE sending the payer to the provider,
    // so concurrent payers cannot overshoot max_uses or pay an invoice twice.
    const checkoutId = randomUUID();
    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000);
    await this.reserve(kind, t.id, checkoutId, expiresAt);
    let url: string | undefined;
    let reference: string | undefined;
    try {
      const res: any = await this.qr.initialize(
        {
          merchantId: biz.merchant_id,
          amount: amountKes,
          method: method as WebMethod,
          guestEmail: email?.trim() || undefined,
        },
        {
          businessDocument: kind === 'link' ? 'payment_link' : 'invoice',
        },
      );
      url = res?.data?.authorization_url ?? res?.authorization_url;
      reference = res?.data?.reference ?? res?.reference;
      if (!url || !reference)
        throw new BadRequestException(
          'Could not start the payment. Try again.',
        );
      if (!/^https:\/\//i.test(url))
        throw new BadRequestException('Unexpected payment provider URL');
      await this.prisma.business_web_checkouts.create({
        data: {
          id: checkoutId,
          business_id: t.business_id,
          source: kind === 'link' ? 'payment_link' : 'invoice',
          source_id: t.id,
          transaction_reference: reference,
          amount: t.amount,
          amount_kes: amountKes,
          method,
          payer_email: email?.trim() || null,
          reserved: true,
          expires_at: expiresAt,
        },
      });
    } catch (e) {
      await this.release(
        kind === 'link' ? 'payment_link' : 'invoice',
        t.id,
        checkoutId,
      );
      throw e;
    }
    return { url, reference };
  }

  /** Atomically takes one link use, or an exclusive hold on the invoice. */
  async reserve(
    kind: 'link' | 'invoice',
    id: string,
    checkoutId: string,
    until: Date,
  ) {
    if (kind === 'link') {
      const n = await this.prisma.$executeRaw`
        UPDATE business_payment_links SET use_count = use_count + 1, updated_at = now()
         WHERE id = ${id}::uuid AND is_active = true
           AND (expires_at IS NULL OR expires_at > now())
           AND (max_uses IS NULL OR use_count < max_uses)`;
      if (n !== 1)
        throw new GoneException(
          'This payment link is no longer accepting payments',
        );
      return;
    }
    const r = await this.prisma.business_invoices.updateMany({
      where: {
        id,
        status: { in: PAYABLE as any },
        OR: [
          { payment_hold_ref: null },
          { payment_hold_until: { lt: new Date() } },
        ],
      },
      data: { payment_hold_ref: checkoutId, payment_hold_until: until },
    });
    if (!r.count)
      throw new GoneException(
        'This invoice is already being paid or is no longer payable. Try again later.',
      );
  }

  /** Gives back a reservation taken by reserve(). Safe to call twice. */
  async release(source: string, id: string, checkoutId: string) {
    if (source === 'payment_link') {
      await this.prisma.$executeRaw`
        UPDATE business_payment_links SET use_count = use_count - 1, updated_at = now()
         WHERE id = ${id}::uuid AND use_count > 0`;
    } else {
      await this.prisma.business_invoices.updateMany({
        where: { id, payment_hold_ref: checkoutId },
        data: { payment_hold_ref: null, payment_hold_until: null },
      });
    }
  }

  /**
   * Checks the provider status and, once completed, records the business
   * payment exactly once (status claim on the checkout row).
   */
  async reconcile(reference: string) {
    const c = await this.prisma.business_web_checkouts.findUnique({
      where: { transaction_reference: reference },
    });
    if (!c) throw new NotFoundException('Checkout not found');
    if (c.status !== 'pending' && c.status !== 'expired') return c.status;
    const wasExpired = c.status === 'expired';
    let status: string;
    try {
      const v: any = await this.qr.verify(reference);
      status = v?.data?.status ?? 'pending';
    } catch (e) {
      this.logger.warn(`verify ${reference} failed: ${e}`);
      return 'pending';
    }
    if (status === 'failed') {
      const f = await this.prisma.business_web_checkouts.updateMany({
        where: { id: c.id, status: c.status },
        data: { status: 'failed' },
      });
      if (f.count && !wasExpired && c.reserved)
        await this.release(c.source, c.source_id, c.id);
      return 'failed';
    }
    if (status !== 'completed') {
      // Provider still pending past the hold: free the link use / invoice.
      if (!wasExpired && c.expires_at && c.expires_at < new Date()) {
        const x = await this.prisma.business_web_checkouts.updateMany({
          where: { id: c.id, status: 'pending' },
          data: { status: 'expired' },
        });
        if (x.count && c.reserved)
          await this.release(c.source, c.source_id, c.id);
        return 'expired';
      }
      return wasExpired ? 'expired' : 'pending';
    }

    // Amount check: the credited FARM must match what was asked (1% rate tolerance).
    const txn = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
      select: { amount: true, status: true },
    });
    const credited = Number(txn?.amount ?? 0);
    if (
      Math.abs(credited - Number(c.amount)) >
      Number(c.amount) * 0.01 + 0.01
    ) {
      this.logger.error(
        `Web checkout ${reference} amount mismatch: ${credited} vs ${String(c.amount)}`,
      );
    }
    const claim = await this.prisma.business_web_checkouts.updateMany({
      where: { id: c.id, status: c.status },
      data: { status: 'completed', completed_at: new Date() },
    });
    if (!claim.count) return 'completed';
    await this.prisma.business_payments.create({
      data: {
        business_id: c.business_id,
        source: c.source,
        source_id: c.source_id,
        payer_user_id: null,
        amount: credited || Number(c.amount),
        transaction_reference: reference,
        channel: 'web',
      },
    });
    // Money has already arrived. Settle against the reservation; if it was lost
    // (late completion after the hold expired), try to take it again atomically,
    // and if that fails record the payment for refund/review.
    const settled = await this.settle(c, wasExpired);
    if (!settled) {
      await this.prisma.business_payment_exceptions
        .create({
          data: {
            business_id: c.business_id,
            checkout_id: c.id,
            source: c.source,
            source_id: c.source_id,
            transaction_reference: reference,
            amount: credited || Number(c.amount),
            reason:
              c.source === 'payment_link'
                ? 'Payment link had no uses left when the web payment completed'
                : 'Invoice was already paid or cancelled when the web payment completed',
          },
        })
        .catch(() => undefined);
      this.logger.error(
        `Web payment ${reference} could not be applied; recorded for refund/review`,
      );
      return 'completed';
    }
    if (c.source === 'payment_link') {
      this.webhooks.emit(c.business_id, 'live', 'payment_link.paid', {
        payment_link_id: c.source_id,
        amount: Number(c.amount),
        channel: 'web',
        transaction_reference: reference,
      });
    } else {
      this.webhooks.emit(c.business_id, 'live', 'invoice.paid', {
        invoice_id: c.source_id,
        amount: Number(c.amount),
        channel: 'web',
        transaction_reference: reference,
      });
    }
    await this.notifyOwner(c, reference);
    this.webhooks.emit(c.business_id, 'live', 'payment.succeeded', {
      source: c.source,
      source_id: c.source_id,
      amount: Number(c.amount),
      channel: 'web',
      transaction_reference: reference,
    });
    return 'completed';
  }

  private async notifyOwner(c: any, reference: string) {
    if (!this.notifications) return;
    const biz = await this.prisma.businesses.findUnique({
      where: { id: c.business_id },
      select: { owner_user_id: true },
    });
    if (!biz?.owner_user_id) return;
    const invoice = c.source === 'invoice';
    await this.notifications
      .sendNotification(biz.owner_user_id, {
        type: 'merchant',
        entityId: reference,
        title: invoice ? 'Invoice paid' : 'Payment link paid',
        body: `You received ${Number(c.amount)} FARM from a ${invoice ? 'invoice' : 'payment link'}.`,
        metadata: {
          event: invoice ? 'invoice.paid' : 'payment_link.paid',
          source: c.source,
          source_id: c.source_id,
          amount: Number(c.amount),
          transaction_reference: reference,
          channel: 'web',
        },
      })
      .catch((error) => {
        this.logger.warn(
          `owner notify ${reference}: ${error instanceof Error ? error.message : 'error'}`,
        );
      });
  }

  /** Applies a completed web payment to its link/invoice. Returns false when it cannot. */
  private async settle(c: any, wasExpired: boolean): Promise<boolean> {
    const reference = c.transaction_reference;
    if (c.source === 'payment_link') {
      if (c.reserved && !wasExpired) return true; // use was taken at checkout start
      const n = await this.prisma.$executeRaw`
        UPDATE business_payment_links SET use_count = use_count + 1, updated_at = now()
         WHERE id = ${c.source_id}::uuid AND (max_uses IS NULL OR use_count < max_uses)`;
      return n === 1;
    }
    const inv = await this.prisma.business_invoices.updateMany({
      where: {
        id: c.source_id,
        status: { in: PAYABLE as any },
        OR: [
          { payment_hold_ref: c.id },
          { payment_hold_ref: null },
          { payment_hold_until: { lt: new Date() } },
        ],
      },
      data: {
        status: 'paid',
        paid_at: new Date(),
        transaction_reference: reference,
        payment_hold_ref: null,
        payment_hold_until: null,
      },
    });
    return inv.count === 1;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcilePending() {
    const since = new Date(Date.now() - 3 * 24 * 3600_000);
    const rows = await this.prisma.business_web_checkouts.findMany({
      where: {
        status: { in: ['pending', 'expired'] },
        created_at: { gte: since },
      },
      select: { transaction_reference: true },
      take: 100,
    });
    for (const r of rows) {
      try {
        await this.reconcile(r.transaction_reference);
      } catch (e) {
        this.logger.warn(`reconcile ${r.transaction_reference}: ${e}`);
      }
    }
  }
}
