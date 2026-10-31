import { EscrowService, remainingAmount } from '../escrow/escrow.service';
import { BusinessEscrowService, milestonesOf } from './business-escrow.service';
import { BusinessWebCheckoutService } from './business-web-checkout.service';
import {
  BusinessCommerceService,
  invoiceUrl,
  linkUrl,
} from './business-commerce.service';

const escrowRow = {
  id: 'e1',
  buyer_id: 'buyer',
  seller_id: 'seller',
  buyer_wallet_id: 'bw',
  seller_wallet_id: 'sw',
  status: 'active',
  amount: 100,
  released_amount: 0,
  title: 'Build',
  reference_code: 'ESC-1',
};

function makeEscrow(rows: any[]) {
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
    escrow_contracts: { update: jest.fn() },
    wallets: { update: jest.fn().mockResolvedValue({ balance: 10 }) },
    transactions: {
      create: jest
        .fn()
        .mockImplementation(({ data }) => ({ id: 't1', ...data })),
    },
    ledger_entries: { createMany: jest.fn(), create: jest.fn() },
  };
  const prisma: any = { $transaction: jest.fn((w) => w(tx)) };
  const auth: any = { verifyPin: jest.fn().mockResolvedValue(true) };
  const notif: any = {
    sendNotification: jest.fn().mockResolvedValue(undefined),
  };
  const ws: any = { emitBalanceUpdate: jest.fn() };
  const svc = new EscrowService(prisma, auth, {} as any, notif, {} as any, ws);
  jest.spyOn(svc as any, 'getEscrowOrFail').mockResolvedValue({ ...escrowRow });
  jest
    .spyOn(svc as any, 'creditSuperadminWalletInTx')
    .mockResolvedValue(undefined);
  return { svc, tx, auth };
}

describe('Phase 2b: partial escrow release', () => {
  it('remainingAmount never goes negative', () => {
    expect(remainingAmount({ amount: 100, released_amount: 40 })).toBe(60);
    expect(remainingAmount({ amount: 100 })).toBe(100);
    expect(remainingAmount({ amount: 100, released_amount: 100 })).toBe(0);
  });

  it('releases one milestone: buyer locked funds down, seller credited minus 1.5%', async () => {
    const { svc, tx, auth } = makeEscrow([
      { amount: 100, released_amount: 40 },
    ]);
    const r = await svc.releasePartial('e1', 'buyer', 40, '1234', 'Design');
    expect(auth.verifyPin).toHaveBeenCalledWith('buyer', '1234');
    expect(tx.wallets.update).toHaveBeenCalledWith({
      where: { id: 'bw' },
      data: { locked_balance: { decrement: 40 }, balance: { decrement: 40 } },
    });
    expect(tx.wallets.update).toHaveBeenCalledWith({
      where: { id: 'sw' },
      data: { balance: { increment: 39.4 } },
    });
    expect(tx.transactions.create.mock.calls[0][0].data.metadata.partial).toBe(
      true,
    );
    expect(tx.escrow_contracts.update).not.toHaveBeenCalled();
    expect(r.data).toMatchObject({
      amount: 40,
      fee: 0.6,
      remaining: 60,
      completed: false,
    });
  });

  it('completes the escrow when the last milestone is released', async () => {
    const { svc, tx } = makeEscrow([{ amount: 100, released_amount: 100 }]);
    const r = await svc.releasePartial('e1', 'buyer', 60, '1234', 'Final');
    expect(tx.escrow_contracts.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(r.data.completed).toBe(true);
  });

  it('refuses to release more than is still locked and moves no money', async () => {
    const { svc, tx } = makeEscrow([]);
    await expect(
      svc.releasePartial('e1', 'buyer', 500, '1234', 'Too much'),
    ).rejects.toThrow(/exceeds what is still locked/);
    expect(tx.wallets.update).not.toHaveBeenCalled();
    expect(tx.transactions.create).not.toHaveBeenCalled();
  });

  it('only the buyer can release, and amounts must be positive', async () => {
    const { svc } = makeEscrow([]);
    await expect(
      svc.releasePartial('e1', 'seller', 10, '1', 'x'),
    ).rejects.toThrow(/Only the buyer/);
    await expect(
      svc.releasePartial('e1', 'buyer', 0, '1', 'x'),
    ).rejects.toThrow(/positive/);
  });
});

describe('Phase 2b: business milestones', () => {
  const be = {
    id: 'b1',
    business_id: 'biz',
    buyer_user_id: 'buyer',
    escrow_contract_id: 'e1',
    status: 'funded',
    title: 'Build',
    milestones: [
      { title: 'Design', amount: 40, status: 'pending' },
      { title: 'Build', amount: 60, status: 'pending' },
    ],
  };
  function make(releaseImpl: any) {
    const prisma: any = {
      business_escrows: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(be),
        update: jest.fn(),
      },
      escrow_contracts: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const escrow: any = { releasePartial: jest.fn(releaseImpl) };
    const webhooks: any = { emit: jest.fn() };
    const svc = new BusinessEscrowService(prisma, {} as any, escrow, webhooks);
    jest.spyOn(svc, 'sync').mockResolvedValue(undefined);
    return { svc, prisma, escrow, webhooks };
  }

  it('releases a milestone through EscrowService.releasePartial and emits a webhook', async () => {
    const { svc, prisma, escrow, webhooks } = make(async () => ({
      data: { transaction_reference: 'T1', remaining: 60, completed: false },
    }));
    await svc.releaseMilestone('buyer', 'b1', 0, '1234');
    expect(escrow.releasePartial).toHaveBeenCalledWith(
      'e1',
      'buyer',
      40,
      '1234',
      'Design',
    );
    const saved =
      prisma.business_escrows.update.mock.calls[0][0].data.milestones;
    expect(saved[0].status).toBe('released');
    expect(saved[1].status).toBe('pending');
    expect(webhooks.emit).toHaveBeenCalledWith(
      'biz',
      'live',
      'escrow.milestone_released',
      expect.any(Object),
    );
  });

  it('puts the milestone back when the release fails (wrong PIN etc.)', async () => {
    const { svc, prisma } = make(async () => {
      throw new Error('Invalid PIN');
    });
    await expect(svc.releaseMilestone('buyer', 'b1', 0, 'bad')).rejects.toThrow(
      'Invalid PIN',
    );
    const restored =
      prisma.business_escrows.update.mock.calls[0][0].data.milestones;
    expect(milestonesOf({ milestones: restored })[0].status).toBe('pending');
  });

  it('refuses a release when another request already claimed the milestone', async () => {
    const { svc, prisma, escrow } = make(async () => ({}));
    prisma.business_escrows.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      svc.releaseMilestone('buyer', 'b1', 0, '1234'),
    ).rejects.toThrow(/try again/);
    expect(escrow.releasePartial).not.toHaveBeenCalled();
  });
});

describe('Phase 2b: web checkout reconciliation', () => {
  function make(checkout: any, verifyStatus: string) {
    const prisma: any = {
      business_web_checkouts: {
        findUnique: jest.fn().mockResolvedValue(checkout),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      transactions: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ amount: 50, status: 'completed' }),
      },
      business_payments: { create: jest.fn() },
      business_payment_links: { update: jest.fn() },
      business_invoices: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const qr: any = {
      verify: jest.fn().mockResolvedValue({ data: { status: verifyStatus } }),
    };
    const webhooks: any = { emit: jest.fn() };
    const svc = new BusinessWebCheckoutService(
      prisma,
      {} as any,
      qr,
      {} as any,
      webhooks,
    );
    return { svc, prisma, webhooks };
  }
  const base = {
    id: 'c1',
    business_id: 'biz',
    source: 'payment_link',
    source_id: 'l1',
    transaction_reference: 'QR-1',
    amount: 50,
    status: 'pending',
  };

  it('records a web payment once; the link use was already reserved at checkout start', async () => {
    const { svc, prisma, webhooks } = make(
      { ...base, reserved: true },
      'completed',
    );
    expect(await svc.reconcile('QR-1')).toBe('completed');
    expect(prisma.business_payments.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        channel: 'web',
        payer_user_id: null,
        source_id: 'l1',
      }),
    });
    expect(prisma.business_payment_links.update).not.toHaveBeenCalled();
    expect(webhooks.emit).toHaveBeenCalledWith(
      'biz',
      'live',
      'payment_link.paid',
      expect.any(Object),
    );
  });

  it('does not double-record when another worker already claimed the checkout', async () => {
    const { svc, prisma } = make(base, 'completed');
    prisma.business_web_checkouts.updateMany.mockResolvedValue({ count: 0 });
    await svc.reconcile('QR-1');
    expect(prisma.business_payments.create).not.toHaveBeenCalled();
  });

  it('marks an invoice paid on completion', async () => {
    const { svc, prisma } = make(
      { ...base, source: 'invoice', source_id: 'i1' },
      'completed',
    );
    await svc.reconcile('QR-1');
    expect(prisma.business_invoices.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'i1' }) }),
    );
  });

  it('leaves pending checkouts alone and marks failures', async () => {
    const p = make(base, 'pending');
    expect(await p.svc.reconcile('QR-1')).toBe('pending');
    expect(p.prisma.business_web_checkouts.updateMany).not.toHaveBeenCalled();
    const f = make(base, 'failed');
    expect(await f.svc.reconcile('QR-1')).toBe('failed');
    expect(f.prisma.business_payments.create).not.toHaveBeenCalled();
  });
});

describe('Phase 2b: share URLs and invoice email', () => {
  it('builds public pay URLs', () => {
    expect(linkUrl('AB12')).toMatch(/^https:\/\/farmpay.africa\/pay\/l\/AB12$/);
    expect(invoiceUrl('INV-1')).toMatch(
      /^https:\/\/farmpay.africa\/pay\/i\/INV-1$/,
    );
  });

  function make(email: string | null, sent = true) {
    const prisma: any = {
      business_invoices: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'i1',
          invoice_number: 'INV-1',
          total: 25,
          currency: 'FARM',
          due_date: null,
          items: [{ description: '<b>Seeds</b>', quantity: 1, amount: 25 }],
          customer: { name: 'Ann', email },
          business: { trading_name: 'Shamba', legal_name: 'Shamba Ltd' },
        }),
        update: jest.fn(),
      },
    };
    const notif: any = { sendEmail: jest.fn().mockResolvedValue(sent) };
    const svc = new BusinessCommerceService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      notif,
    );
    return { svc, prisma, notif };
  }

  it('emails the customer a pay link and records last_emailed_at', async () => {
    const { svc, prisma, notif } = make('ann@example.com');
    expect(await svc.emailInvoice('biz', 'i1')).toBe(true);
    const [to, subject, html] = notif.sendEmail.mock.calls[0];
    expect(to).toBe('ann@example.com');
    expect(subject).toContain('INV-1');
    expect(html).toContain('https://farmpay.africa/pay/i/INV-1');
    expect(html).toContain('&lt;b&gt;Seeds');
    expect(prisma.business_invoices.update).toHaveBeenCalled();
  });

  it('skips customers without email and does not record a failed send', async () => {
    const a = make(null);
    expect(await a.svc.emailInvoice('biz', 'i1')).toBe(false);
    expect(a.notif.sendEmail).not.toHaveBeenCalled();
    const b = make('ann@example.com', false);
    expect(await b.svc.emailInvoice('biz', 'i1')).toBe(false);
    expect(b.prisma.business_invoices.update).not.toHaveBeenCalled();
  });
});
