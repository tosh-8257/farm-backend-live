import { Logger } from '@nestjs/common';
import { scheduleCustodialWallet } from './schedule-custodial-wallet';

describe('scheduleCustodialWallet', () => {
  const log = new Logger('test');

  it('does nothing when chain wallets are not registered', () => {
    expect(() =>
      scheduleCustodialWallet(
        {
          get: () => {
            throw new Error('missing');
          },
        } as any,
        log,
        'user-1',
      ),
    ).not.toThrow();
  });

  it('starts mine without waiting, and a rejection does not escape', async () => {
    const mine = jest.fn().mockRejectedValue(new Error('chain down'));
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    scheduleCustodialWallet({ get: () => ({ mine }) } as any, log, 'user-1');
    expect(mine).toHaveBeenCalledWith('user-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
