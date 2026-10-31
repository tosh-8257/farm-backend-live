import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { paginate, paginationParams } from '../common/utils/pagination.util';
import { BusinessAccessService } from './business-access.service';
import { BusinessFinanceService } from './business-finance.service';
import { BusinessWebhooksService } from './business-webhooks.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomerDto, InvoiceDto, PaymentLinkDto } from './business-ops.dto';

const INVOICE_STATUSES = [
  'draft',
  'sent',
  'pending',
  'paid',
  'overdue',
  'cancelled',
];
const PAYABLE = ['sent', 'pending', 'overdue'];

/** Public base URL for shareable pay pages. Not a secret; configurable per environment. */
export function payBaseUrl() {
  return (
    // Hosted checkout on farmpay.africa (farm1 web/pay-doc.html). APP_URL is
    // the web app and must not be used here.
    (process.env.PAYMENT_BASE_URL || 'https://farmpay.africa').replace(
      /\/+$/,
      '',
    )
  );
}
export const linkUrl = (code: string) =>
  `${payBaseUrl()}/pay/l/${encodeURIComponent(code)}`;
export const invoiceUrl = (n: string) =>
  `${payBaseUrl()}/pay/i/${encodeURIComponent(n)}`;

export function escapeHtml(v: unknown) {
  const text =
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
      ? String(v)
      : '';
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class BusinessCommerceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly finance: BusinessFinanceService,
    private readonly wallets: WalletsService,
    private readonly webhooks: BusinessWebhooksService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- customers ----------
  async listCustomers(userId: string, q: any) {
    const a = await this.access.resolve(userId, 'customers:read');
    const { skip, take, page, limit } = paginationParams(q.page, q.limit);
    const search = String(q.search ?? '').trim();
    const where: any = { business_id: a.business.id };
    if (search)
      where.OR = ['name', 'email', 'phone'].map((f) => ({
        [f]: { contains: search, mode: 'insensitive' },
      }));
    const [items, total] = await Promise.all([
      this.prisma.business_customers.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.business_customers.count({ where }),
    ]);
    return { data: items, meta: paginate(total, page, limit) };
  }

  async getCustomer(userId: string, id: string) {
    const a = await this.access.resolve(userId, 'customers:read');
    const c = await this.prisma.business_customers.findFirst({
      where: { id, business_id: a.business.id },
      include: { invoices: { orderBy: { created_at: 'desc' }, take: 20 } },
    });
    if (!c) throw new NotFoundException('Customer not found');
    return {
      data: { ...c, invoices: c.invoices.map((i) => this.shapeInvoice(i)) },
    };
  }

  async createCustomer(userId: string, dto: CustomerDto) {
    const a = await this.access.resolve(userId, 'customers:manage');
    const c = await this.prisma.business_customers.create({
      data: { ...this.clean(dto), business_id: a.business.id },
    });
    return { data: c, message: 'Customer added' };
  }

  async updateCustomer(userId: string, id: string, dto: CustomerDto) {
    const a = await this.access.resolve(userId, 'customers:manage');
    const r = await this.prisma.business_customers.updateMany({
      where: { id, business_id: a.business.id },
      data: this.clean(dto),
    });
    if (!r.count) throw new NotFoundException('Customer not found');
    return this.getCustomer(userId, id);
  }

  private clean(dto: CustomerDto) {
    return {
      name: dto.name.trim(),
      email: dto.email?.trim() || null,
      phone: dto.phone?.trim() || null,
      notes: dto.notes?.trim() || null,
    };
  }

  // ---------- invoices ----------
  /** Marks unpaid invoices past their due date as overdue (lazy, idempotent). */
  private async markOverdue(businessId?: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await this.prisma.business_invoices.updateMany({
      where: {
        ...(businessId ? { business_id: businessId } : {}),
        status: { in: ['sent', 'pending'] },
        due_date: { lt: today },
      },
      data: { status: 'overdue' },
    });
  }

  async listInvoices(userId: string, q: any) {
    const a = await this.access.resolve(userId, 'invoices:read');
    await this.markOverdue(a.business.id);
    const { skip, take, page, limit } = paginationParams(q.page, q.limit);
    const where: any = { business_id: a.business.id };
    if (q.status) {
      if (!INVOICE_STATUSES.includes(q.status))
        throw new BadRequestException('Unknown invoice status');
      where.status = q.status;
    }
    const [items, total] = await Promise.all([
      this.prisma.business_invoices.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: { customer: true },
      }),
      this.prisma.business_invoices.count({ where }),
    ]);
    return {
      data: items.map((i) => this.shapeInvoice(i)),
      meta: paginate(total, page, limit),
    };
  }

  async getInvoice(userId: string, id: string) {
    const a = await this.access.resolve(userId, 'invoices:read');
    await this.markOverdue(a.business.id);
    const inv = await this.prisma.business_invoices.findFirst({
      where: { id, business_id: a.business.id },
      include: { customer: true },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    return { data: this.shapeInvoice(inv) };
  }

  private computeItems(dto: InvoiceDto) {
    const items = dto.items.map((i) => ({
      description: i.description.trim(),
      quantity: i.quantity,
      unit_price: round2(i.unit_price),
      amount: round2(i.quantity * i.unit_price),
    }));
    const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
    if (subtotal > 1_000_000)
      throw new BadRequestException('Invoice total is too large');
    return { items, subtotal, total: subtotal };
  }

  private async checkCustomer(businessId: string, customerId?: string) {
    if (!customerId) return null;
    const c = await this.prisma.business_customers.findFirst({
      where: { id: customerId, business_id: businessId },
    });
    if (!c) throw new BadRequestException('Customer not found');
    return c.id;
  }

  async createInvoice(userId: string, dto: InvoiceDto) {
    const a = await this.access.resolve(userId, 'invoices:manage');
    const customer_id = await this.checkCustomer(
      a.business.id,
      dto.customer_id,
    );
    const { items, subtotal, total } = this.computeItems(dto);
    const inv = await this.prisma.business_invoices.create({
      data: {
        business_id: a.business.id,
        customer_id,
        items,
        subtotal,
        total,
        invoice_number: `INV-${new Date().getFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`,
        due_date: dto.due_date ? new Date(dto.due_date) : null,
        notes: dto.notes?.trim() || null,
        created_by: userId,
      },
    });
    return { data: this.shapeInvoice(inv), message: 'Invoice saved as draft' };
  }

  async updateInvoice(userId: string, id: string, dto: InvoiceDto) {
    const a = await this.access.resolve(userId, 'invoices:manage');
    const customer_id = await this.checkCustomer(
      a.business.id,
      dto.customer_id,
    );
    const { items, subtotal, total } = this.computeItems(dto);
    const r = await this.prisma.business_invoices.updateMany({
      where: { id, business_id: a.business.id, status: 'draft' },
      data: {
        customer_id,
        items,
        subtotal,
        total,
        due_date: dto.due_date ? new Date(dto.due_date) : null,
        notes: dto.notes?.trim() || null,
      },
    });
    if (!r.count)
      throw new BadRequestException('Only draft invoices can be edited');
    return this.getInvoice(userId, id);
  }

  async sendInvoice(userId: string, id: string) {
    const a = await this.access.resolve(userId, 'invoices:manage');
    const r = await this.prisma.business_invoices.updateMany({
      where: { id, business_id: a.business.id, status: 'draft' },
      data: { status: 'sent', sent_at: new Date() },
    });
    if (!r.count)
      throw new BadRequestException('Only draft invoices can be sent');
    await this.markOverdue(a.business.id);
    const emailed = await this.emailInvoice(a.business.id, id);
    return {
      ...(await this.getInvoice(userId, id)),
      emailed,
      message: emailed
        ? 'Invoice issued and emailed to your customer.'
        : 'Invoice issued. Share the pay link with your customer.',
    };
  }

  /** Re-sends the invoice email with the pay link. */
  async resendInvoice(userId: string, id: string) {
    const a = await this.access.resolve(userId, 'invoices:manage');
    const inv = await this.prisma.business_invoices.findFirst({
      where: { id, business_id: a.business.id },
      include: { customer: true },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (!PAYABLE.includes(inv.status))
      throw new BadRequestException(`Invoice is ${inv.status}`);
    if (!inv.customer?.email)
      throw new BadRequestException('This customer has no email address');
    const emailed = await this.emailInvoice(a.business.id, id);
    if (!emailed)
      throw new BadRequestException(
        'The email could not be sent. Try again later.',
      );
    return {
      ...(await this.getInvoice(userId, id)),
      emailed,
      message: 'Invoice emailed',
    };
  }

  /** Emails the customer (if they have an address) with a pay link. Returns true on send. */
  async emailInvoice(businessId: string, id: string): Promise<boolean> {
    const inv = await this.prisma.business_invoices.findFirst({
      where: { id, business_id: businessId },
      include: {
        customer: true,
        business: { select: { trading_name: true, legal_name: true } },
      },
    });
    const to = inv?.customer?.email?.trim();
    if (!inv || !to) return false;
    const name = inv.business.trading_name || inv.business.legal_name;
    const url = invoiceUrl(inv.invoice_number);
    const rows = (Array.isArray(inv.items) ? (inv.items as any[]) : [])
      .map(
        (it) =>
          `<tr><td style="padding:4px 8px">${escapeHtml(it.description)}</td><td style="padding:4px 8px;text-align:right">${escapeHtml(it.quantity)}</td><td style="padding:4px 8px;text-align:right">${escapeHtml(it.amount ?? '')}</td></tr>`,
      )
      .join('');
    const html = `<div style="font-family:Arial,sans-serif;color:#111;max-width:560px">
<h2 style="margin:0 0 8px">Invoice ${escapeHtml(inv.invoice_number)}</h2>
<p>Hi ${escapeHtml(inv.customer?.name)}, ${escapeHtml(name)} has sent you an invoice.</p>
<table style="border-collapse:collapse;width:100%;border:1px solid #ddd">${rows}</table>
<p style="font-size:18px"><b>Total: ${Number(inv.total).toFixed(2)} ${escapeHtml(inv.currency)}</b>${inv.due_date ? ` &middot; due ${inv.due_date.toISOString().slice(0, 10)}` : ''}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Pay invoice</a></p>
<p style="color:#666;font-size:12px">Or open this link: ${escapeHtml(url)}</p></div>`;
    const ok = await this.notifications.sendEmail(
      to,
      `Invoice ${inv.invoice_number} from ${name}`,
      html,
    );
    if (ok)
      await this.prisma.business_invoices.update({
        where: { id: inv.id },
        data: { last_emailed_at: new Date() },
      });
    return ok;
  }

  async cancelInvoice(userId: string, id: string) {
    const a = await this.access.resolve(userId, 'invoices:manage');
    const r = await this.prisma.business_invoices.updateMany({
      where: {
        id,
        business_id: a.business.id,
        status: { in: ['draft', ...PAYABLE] as any },
      },
      data: { status: 'cancelled', cancelled_at: new Date() },
    });
    if (!r.count)
      throw new BadRequestException('This invoice can no longer be cancelled');
    return {
      ...(await this.getInvoice(userId, id)),
      message: 'Invoice cancelled',
    };
  }

  shapeInvoice(i: any) {
    return {
      ...i,
      subtotal: Number(i.subtotal),
      total: Number(i.total),
      pay_url: i.status === 'draft' ? null : invoiceUrl(i.invoice_number),
    };
  }

  // ---------- payment links ----------
  async listLinks(userId: string, q: any) {
    const a = await this.access.resolve(userId, 'links:read');
    const { skip, take, page, limit } = paginationParams(q.page, q.limit);
    const where = { business_id: a.business.id };
    const [items, total] = await Promise.all([
      this.prisma.business_payment_links.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.business_payment_links.count({ where }),
    ]);
    return {
      data: items.map((l) => this.shapeLink(l)),
      meta: paginate(total, page, limit),
    };
  }

  async getLink(userId: string, id: string) {
    const a = await this.access.resolve(userId, 'links:read');
    const l = await this.prisma.business_payment_links.findFirst({
      where: { id, business_id: a.business.id },
    });
    if (!l) throw new NotFoundException('Payment link not found');
    const payments = await this.prisma.business_payments.findMany({
      where: { source: 'payment_link', source_id: l.id },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    return {
      data: {
        ...this.shapeLink(l),
        payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
      },
    };
  }

  async createLink(userId: string, dto: PaymentLinkDto) {
    const a = await this.access.resolve(userId, 'links:manage');
    const expires_at = dto.expires_at ? new Date(dto.expires_at) : null;
    if (expires_at && expires_at <= new Date())
      throw new BadRequestException('Expiry must be in the future');
    const l = await this.prisma.business_payment_links.create({
      data: {
        business_id: a.business.id,
        code: randomBytes(6).toString('base64url'),
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        amount: round2(dto.amount),
        expires_at,
        max_uses: dto.max_uses ?? null,
        created_by: userId,
      },
    });
    return { data: this.shapeLink(l), message: 'Payment link created' };
  }

  async setLinkActive(userId: string, id: string, is_active: boolean) {
    const a = await this.access.resolve(userId, 'links:manage');
    const r = await this.prisma.business_payment_links.updateMany({
      where: { id, business_id: a.business.id },
      data: { is_active },
    });
    if (!r.count) throw new NotFoundException('Payment link not found');
    return this.getLink(userId, id);
  }

  linkState(l: any): 'active' | 'disabled' | 'expired' | 'completed' {
    if (!l.is_active) return 'disabled';
    if (l.expires_at && new Date(l.expires_at) <= new Date()) return 'expired';
    if (l.max_uses != null && l.use_count >= l.max_uses) return 'completed';
    return 'active';
  }

  private shapeLink(l: any) {
    return {
      ...l,
      amount: Number(l.amount),
      state: this.linkState(l),
      url: linkUrl(l.code),
    };
  }

  // ---------- payer side (any signed-in Farm user) ----------
  async businessName(businessId: string) {
    const b = await this.prisma.businesses.findUnique({
      where: { id: businessId },
      select: {
        trading_name: true,
        legal_name: true,
        status: true,
        owner_user_id: true,
      },
    });
    if (!b || b.status !== 'approved')
      throw new NotFoundException('Business not available');
    return b;
  }

  async publicLink(code: string) {
    const l = await this.prisma.business_payment_links.findUnique({
      where: { code },
    });
    if (!l) throw new NotFoundException('Payment link not found');
    const b = await this.businessName(l.business_id);
    return {
      data: {
        code: l.code,
        title: l.title,
        description: l.description,
        amount: Number(l.amount),
        currency: l.currency,
        state: this.linkState(l),
        business_name: b.trading_name || b.legal_name,
      },
    };
  }

  async payLink(payerId: string, code: string, pin: string, ip: string) {
    const l = await this.prisma.business_payment_links.findUnique({
      where: { code },
    });
    if (!l) throw new NotFoundException('Payment link not found');
    if (this.linkState(l) !== 'active')
      throw new GoneException(
        'This payment link is no longer accepting payments',
      );
    const b = await this.businessName(l.business_id);
    if (b.owner_user_id === payerId)
      throw new ForbiddenException('You cannot pay your own payment link');
    // Reserve a use first so max_uses cannot be exceeded by concurrent payers.
    const reserved = await this.prisma.business_payment_links.updateMany({
      where: {
        id: l.id,
        is_active: true,
        ...(l.max_uses != null ? { use_count: { lt: l.max_uses } } : {}),
      },
      data: { use_count: { increment: 1 } },
    });
    if (!reserved.count)
      throw new GoneException(
        'This payment link is no longer accepting payments',
      );
    try {
      const res = await this.pay(
        payerId,
        l.business_id,
        b.owner_user_id,
        Number(l.amount),
        pin,
        ip,
        `Payment link: ${l.title}`,
        'payment_link',
        l.id,
      );
      this.webhooks.emit(l.business_id, 'live', 'payment_link.paid', {
        payment_link_id: l.id,
        code: l.code,
        amount: Number(l.amount),
        transaction_reference: res.data.transaction_reference,
      });
      return res;
    } catch (e) {
      await this.prisma.business_payment_links.update({
        where: { id: l.id },
        data: { use_count: { decrement: 1 } },
      });
      throw e;
    }
  }

  async publicInvoice(payerId: string, invoiceNumber: string) {
    await this.markOverdue();
    const inv = await this.prisma.business_invoices.findUnique({
      where: { invoice_number: invoiceNumber },
    });
    if (!inv || inv.status === 'draft')
      throw new NotFoundException('Invoice not found');
    const b = await this.businessName(inv.business_id);
    if (inv.status === 'sent' && b.owner_user_id !== payerId) {
      await this.prisma.business_invoices.updateMany({
        where: { id: inv.id, status: 'sent' },
        data: { status: 'pending' },
      });
      inv.status = 'pending';
    }
    return {
      data: {
        invoice_number: inv.invoice_number,
        status: inv.status,
        items: inv.items,
        total: Number(inv.total),
        currency: inv.currency,
        due_date: inv.due_date,
        business_name: b.trading_name || b.legal_name,
      },
    };
  }

  async payInvoice(
    payerId: string,
    invoiceNumber: string,
    pin: string,
    ip: string,
  ) {
    await this.markOverdue();
    const inv = await this.prisma.business_invoices.findUnique({
      where: { invoice_number: invoiceNumber },
    });
    if (!inv || inv.status === 'draft')
      throw new NotFoundException('Invoice not found');
    if (!PAYABLE.includes(inv.status))
      throw new BadRequestException(`Invoice is ${inv.status}`);
    const b = await this.businessName(inv.business_id);
    if (b.owner_user_id === payerId)
      throw new ForbiddenException('You cannot pay your own invoice');
    // Claim the invoice before moving money so it cannot be paid twice.
    const claimed = await this.prisma.business_invoices.updateMany({
      where: {
        id: inv.id,
        status: { in: PAYABLE as any },
        // A web checkout in progress holds the invoice until it expires.
        OR: [
          { payment_hold_ref: null },
          { payment_hold_until: { lt: new Date() } },
        ],
      },
      data: { status: 'paid', paid_at: new Date() },
    });
    if (!claimed.count)
      throw new BadRequestException('Invoice is no longer payable');
    try {
      const res = await this.pay(
        payerId,
        inv.business_id,
        b.owner_user_id,
        Number(inv.total),
        pin,
        ip,
        `Invoice ${inv.invoice_number}`,
        'invoice',
        inv.id,
      );
      await this.prisma.business_invoices.update({
        where: { id: inv.id },
        data: { transaction_reference: res.data.transaction_reference },
      });
      this.webhooks.emit(inv.business_id, 'live', 'invoice.paid', {
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        amount: Number(inv.total),
        transaction_reference: res.data.transaction_reference,
      });
      return res;
    } catch (e) {
      await this.prisma.business_invoices.update({
        where: { id: inv.id },
        data: { status: inv.status, paid_at: null },
      });
      throw e;
    }
  }

  /** Money moves only through the existing WalletsService.sendFunds (PIN, limits, fees, ledger). */
  private async pay(
    payerId: string,
    businessId: string,
    ownerId: string,
    amount: number,
    pin: string,
    ip: string,
    description: string,
    source: string,
    sourceId: string,
  ) {
    const w = await this.finance.walletFor(ownerId);
    const res = await this.wallets.sendFunds(
      payerId,
      { recipient_identifier: w.wallet_address, amount, pin, description },
      ip,
      { merchantFee: true },
    );
    await this.prisma.business_payments.create({
      data: {
        business_id: businessId,
        source,
        source_id: sourceId,
        payer_user_id: payerId,
        amount,
        transaction_reference: res.data.transaction_reference,
      },
    });
    this.webhooks.emit(businessId, 'live', 'payment.succeeded', {
      source,
      source_id: sourceId,
      amount,
      transaction_reference: res.data.transaction_reference,
    });
    return {
      data: {
        transaction_reference: res.data.transaction_reference,
        amount,
        fee: res.data.fee,
        merchant_fee: res.data.merchant_fee ?? 0,
        status: 'successful',
      },
      message: 'Payment successful',
    };
  }
}
