import { WebhookService } from '../src/webhook/webhook.service';

describe('WebhookService processing', () => {
  let svc: WebhookService;
  const mockPrisma: any = {};
  const mockDepositService: any = {
    failDeposit: jest.fn().mockResolvedValue(true),
    finalizeSuccessfulDeposit: jest.fn().mockResolvedValue(true),
  };
  const mockWithdrawService: any = {};
  const mockWebsocket: any = { emitBalanceUpdate: jest.fn(), emitTransactionUpdate: jest.fn(), server: { emit: jest.fn() } };
  const mockCfg: any = { get: (k: string, d?: any) => d };
  const mockPaystackService: any = { verifyTransaction: jest.fn() };
  const mockIvorypayService: any = {};
  const mockQueue: any = { add: jest.fn().mockResolvedValue(true) };
  const mockRedis: any = { set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) };

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new WebhookService(
      mockPrisma,
      mockDepositService,
      mockWithdrawService,
      mockWebsocket,
      mockCfg,
      mockPaystackService,
      mockIvorypayService,
      mockQueue,
      mockRedis,
    );
  });

  it('calls failDeposit on failure event', async () => {
    const payload = { event: 'charge.failed', data: { reference: 'ref-1', gateway_response: 'declined' } } as any;
    // acquireLock uses redis.set; ensure it returns OK
    await svc.handlePaystackWebhookProcessing(payload);
    expect(mockDepositService.failDeposit).toHaveBeenCalledWith('ref-1', expect.any(String));
    expect(mockDepositService.finalizeSuccessfulDeposit).not.toHaveBeenCalled();
  });

  it('skips finalize when paystack verify reports non-success', async () => {
    mockPaystackService.verifyTransaction.mockResolvedValue({ status: 'failed' });
    const payload = { event: 'charge.success', data: { reference: 'ref-2', amount: 1000 } } as any;
    await svc.handlePaystackWebhookProcessing(payload);
    expect(mockPaystackService.verifyTransaction).toHaveBeenCalledWith('ref-2');
    expect(mockDepositService.finalizeSuccessfulDeposit).not.toHaveBeenCalled();
  });

  it('calls finalize when paystack verify reports success', async () => {
    mockPaystackService.verifyTransaction.mockResolvedValue({ status: 'success' });
    const payload = { event: 'charge.success', data: { reference: 'ref-3', amount: 1000 } } as any;
    await svc.handlePaystackWebhookProcessing(payload);
    expect(mockPaystackService.verifyTransaction).toHaveBeenCalledWith('ref-3');
    expect(mockDepositService.finalizeSuccessfulDeposit).toHaveBeenCalledWith('ref-3');
  });
});
