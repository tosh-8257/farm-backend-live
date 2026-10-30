import { WebhookService } from './webhook.service';

describe('WebhookService webhook event deduplication', () => {
  it('distinguishes status events for the same provider transaction', () => {
    const service = Object.create(WebhookService.prototype) as WebhookService;
    const pending = {
      event: 'cryptoPayout.pending',
      data: {
        id: 'payout-id',
        reference: 'withdrawal-reference',
        status: 'PENDING',
      },
    };
    const success = {
      event: 'cryptoPayout.success',
      data: {
        id: 'payout-id',
        reference: 'withdrawal-reference',
        status: 'SUCCESS',
      },
    };

    expect((service as any).getEventId('ivorypay', pending)).not.toBe(
      (service as any).getEventId('ivorypay', success),
    );
    expect((service as any).getEventId('ivorypay', pending)).toBe(
      (service as any).getEventId('ivorypay', pending),
    );
  });
});

describe('WebhookService Paystack deposit processing', () => {
  const createService = () => {
    const finalizeSuccessfulDeposit = jest.fn().mockResolvedValue(true);
    const verifyTransaction = jest.fn();
    const prisma = {
      transactions: {
        findUnique: jest.fn().mockResolvedValue({
          transaction_type: 'deposit',
          metadata: { amount_fiat: 50, provider: 'paystack' },
        }),
      },
      deposit: { findFirst: jest.fn() },
      withdrawal: { findUnique: jest.fn() },
    };
    const service = new WebhookService(
      prisma as any,
      { finalizeSuccessfulDeposit } as any,
      {} as any,
      {} as any,
      {} as any,
      { get: jest.fn().mockReturnValue(60000) } as any,
      { verifyTransaction } as any,
      {} as any,
      {} as any,
    );

    jest.spyOn(service as any, 'acquireLock').mockResolvedValue(true);
    jest.spyOn(service as any, 'releaseLock').mockResolvedValue(undefined);

    return { service, prisma, finalizeSuccessfulDeposit, verifyTransaction };
  };

  it('credits immediately from a signed success event after reference and amount validation', async () => {
    const { service, finalizeSuccessfulDeposit, verifyTransaction } = createService();

    await service.handlePaystackWebhookProcessing({
      event: 'charge.success',
      data: {
        reference: 'deposit-reference',
        amount: 5000,
        status: 'success',
        channel: 'card',
      },
    });

    expect(finalizeSuccessfulDeposit).toHaveBeenCalledWith('deposit-reference', {
      reference: 'deposit-reference',
      amount: 5000,
      status: 'success',
      channel: 'card',
    });
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it('tries synchronous processing before using the queue fallback', async () => {
    const { service, prisma } = createService();
    const processSynchronously = jest
      .spyOn(service, 'handlePaystackWebhookProcessing')
      .mockResolvedValue(undefined);
    prisma.transactions.findUnique.mockResolvedValue({
      transaction_type: 'deposit',
      status: 'completed',
    });

    await expect(
      (service as any).tryProcessWebhookSynchronously(
        'paystack',
        'charge.success',
        'deposit-reference',
        {
          event: 'charge.success',
          data: { reference: 'deposit-reference', status: 'success' },
        },
      ),
    ).resolves.toBe(true);

    expect(processSynchronously).toHaveBeenCalledTimes(1);
  });

  it('does not credit when the signed success event amount differs from the deposit', async () => {
    const { service, finalizeSuccessfulDeposit } = createService();

    await service.handlePaystackWebhookProcessing({
      event: 'charge.success',
      data: {
        reference: 'deposit-reference',
        amount: 4999,
        status: 'success',
      },
    });

    expect(finalizeSuccessfulDeposit).not.toHaveBeenCalled();
  });

  it('does not credit when the reference belongs to another payment provider', async () => {
    const { service, prisma, finalizeSuccessfulDeposit } = createService();
    prisma.transactions.findUnique.mockResolvedValue({
      transaction_type: 'deposit',
      metadata: { amount_fiat: 50, provider: 'ivorypay' },
    });

    await service.handlePaystackWebhookProcessing({
      event: 'charge.success',
      data: {
        reference: 'deposit-reference',
        amount: 5000,
        status: 'success',
      },
    });

    expect(finalizeSuccessfulDeposit).not.toHaveBeenCalled();
  });

  it('does not credit a success event without a matching local deposit transaction', async () => {
    const { service, prisma, finalizeSuccessfulDeposit } = createService();
    prisma.transactions.findUnique.mockResolvedValue(null);

    await service.handlePaystackWebhookProcessing({
      event: 'charge.success',
      data: {
        reference: 'unknown-reference',
        amount: 5000,
        status: 'success',
      },
    });

    expect(finalizeSuccessfulDeposit).not.toHaveBeenCalled();
  });

  it('does not credit a charge.success event with a non-success transaction status', async () => {
    const { service, finalizeSuccessfulDeposit } = createService();

    await service.handlePaystackWebhookProcessing({
      event: 'charge.success',
      data: {
        reference: 'deposit-reference',
        amount: 5000,
        status: 'failed',
      },
    });

    expect(finalizeSuccessfulDeposit).not.toHaveBeenCalled();
  });
});

describe('WebhookService NOWPayments deposits', () => {
  it('credits a deposit after the authenticated provider status is finished', async () => {
    const finalizeSuccessfulDeposit = jest.fn().mockResolvedValue(true);
    const transaction = {
      id: 'transaction-1',
      transaction_type: 'deposit',
      transaction_reference: 'deposit-reference',
      metadata: {
        provider: 'nowpayments',
        amount_usd: 2,
        pay_currency: 'btc',
      },
    };
    const service = Object.create(WebhookService.prototype) as any;
    service.prisma = {
      transactions: {
        findFirst: jest.fn().mockResolvedValue(transaction),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    service.nowpayments = {
      getPayment: jest.fn().mockResolvedValue({
        payment_id: '12345',
        order_id: 'deposit-reference',
        payment_status: 'finished',
        price_amount: 2,
        price_currency: 'usd',
        pay_currency: 'btc',
      }),
    };
    service.depositService = { finalizeSuccessfulDeposit };

    await expect(
      service.handleNowpaymentsWebhook({
        payment_id: '12345',
        order_id: 'deposit-reference',
      }),
    ).resolves.toEqual({
      received: true,
      processed: true,
      status: 'finished',
    });

    expect(service.nowpayments.getPayment).toHaveBeenCalledWith('12345');
    expect(finalizeSuccessfulDeposit).toHaveBeenCalledWith(
      'deposit-reference',
    );
  });
});

describe('WebhookService IvoryPay webhook processing', () => {
  it('validates crypto webhook amounts against USD metadata, not the FARM credit', () => {
    const service = Object.create(WebhookService.prototype) as WebhookService;

    expect(
      (service as any).getExpectedIvorypayWebhookAmount({
        amount: 250,
        metadata: {
          amount_usd: 2.5,
          amount_farm: 250,
        },
      }),
    ).toBe(2.5);
  });

  it('marks a failed crypto payout as failed and releases the withdrawal funds', async () => {
    const transaction = {
      id: 'transaction-id',
      transaction_reference: 'withdrawal-reference',
      transaction_type: 'withdrawal',
      status: 'pending',
      amount: 100,
      metadata: {},
    };
    const rejectWithdrawal = jest.fn().mockResolvedValue(true);
    const failDeposit = jest.fn().mockResolvedValue(true);
    const service = new WebhookService(
      {
        $transaction: jest.fn((callback) =>
          callback({ transactions: { update: jest.fn() } }),
        ),
      } as any,
      { failDeposit } as any,
      { rejectWithdrawal } as any,
      {} as any,
      {} as any,
      { get: jest.fn().mockReturnValue(60000) } as any,
      {} as any,
      { extractProviderIdentifiers: jest.fn().mockReturnValue({}) } as any,
      {} as any,
    );

    jest.spyOn(service as any, 'resolveIvorypayInternalReference').mockResolvedValue('withdrawal-reference');
    jest.spyOn(service as any, 'resolveIvorypayDepositAndTransaction').mockResolvedValue({
      transaction,
      deposit: null,
      resolvedReference: 'withdrawal-reference',
      matchedReference: 'withdrawal-reference',
    });
    jest.spyOn(service as any, 'acquireLock').mockResolvedValue(true);
    jest.spyOn(service as any, 'releaseLock').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'emitWithdrawalUpdate').mockResolvedValue(undefined);

    await service.handleIvorypayWebhookProcessing({
      event: 'cryptoPayout.failed',
      data: {
        reference: 'withdrawal-reference',
        status: 'FAILED',
        failureReason: 'Provider rejected payout',
      },
    });

    expect(rejectWithdrawal).toHaveBeenCalledWith(
      'withdrawal-reference',
      'Provider rejected payout',
    );
    expect(rejectWithdrawal).toHaveBeenCalledTimes(1);
    expect(failDeposit).not.toHaveBeenCalled();
  });
});
