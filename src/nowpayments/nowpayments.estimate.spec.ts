import { BadRequestException } from '@nestjs/common';
import { NowpaymentsService } from './nowpayments.service';

describe('NowpaymentsService checkout estimate', () => {
  const make = () => {
    const service = new NowpaymentsService({} as any);
    jest.spyOn(service, 'getAvailableCurrencies').mockResolvedValue(['btc', 'usdttrc20']);
    jest.spyOn(service, 'getMinimumPaymentAmount').mockResolvedValue({
      currency: 'btc', minimumAmount: 0.0001, minimumUsd: 8,
    });
    return service;
  };

  it('estimates and reports whether the minimum is met', async () => {
    const service = make();
    jest.spyOn(service, 'estimateAmount').mockResolvedValue(0.00002);
    await expect(service.estimateCheckout(1.53, 'BTC')).resolves.toMatchObject({
      pay_currency: 'btc', estimated_amount: 0.00002, meets_minimum: false,
    });
  });

  it('rejects unknown currencies and invalid amounts', async () => {
    const service = make();
    await expect(service.estimateCheckout(10, 'doge')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.estimateCheckout(-1, 'btc')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.estimateCheckout(Number.NaN, 'btc')).rejects.toBeInstanceOf(BadRequestException);
  });

});
