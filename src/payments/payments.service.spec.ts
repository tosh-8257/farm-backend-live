import { PaymentsService } from './payments.service';

describe('PaymentsService.getExchangeRate', () => {
  it('returns cached exchange rates without hitting Prisma when available', async () => {
    const prisma = {
      exchange_rates: {
        findFirst: jest.fn(),
      },
    };
    const cache = {
      cacheGet: jest.fn().mockResolvedValue(130),
      cacheSet: jest.fn().mockResolvedValue(undefined),
    };

    const service = new PaymentsService(
      prisma as any,
      { get: jest.fn() } as any,
      {} as any,
      {} as any,
      cache as any,
    );

    await expect(service.getExchangeRate('USD', 'FARM')).resolves.toBe(130);
    expect(prisma.exchange_rates.findFirst).not.toHaveBeenCalled();
    expect(cache.cacheSet).not.toHaveBeenCalled();
  });
});
