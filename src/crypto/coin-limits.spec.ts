import { BadRequestException } from '@nestjs/common';
import {
  assertCoinAmount,
  configuredCoinLimits,
  resolveCoinBounds,
} from './coin-limits';

const ENV = {
  CRYPTO_COIN_LIMITS: JSON.stringify({
    btc: { min: 0.0002, max: 1.5 },
    usdttrc20: { max: 50000 },
    nope: { min: -1 },
  }),
};

describe('per-coin crypto limits', () => {
  it('ignores invalid JSON and non-positive bounds', () => {
    expect(configuredCoinLimits({})).toEqual({});
    expect(configuredCoinLimits({ CRYPTO_COIN_LIMITS: '{' })).toEqual({});
    expect(configuredCoinLimits(ENV).nope).toBeUndefined();
    expect(configuredCoinLimits(ENV).btc).toEqual({ min: 0.0002, max: 1.5 });
  });

  it('uses the higher of the provider minimum and the configured minimum', () => {
    const prev = process.env.CRYPTO_COIN_LIMITS;
    process.env.CRYPTO_COIN_LIMITS = ENV.CRYPTO_COIN_LIMITS;
    try {
      expect(resolveCoinBounds('btc', 0.001).min_amount).toBe(0.001);
      expect(resolveCoinBounds('btc', 0.0001).min_amount).toBe(0.0002);
      expect(resolveCoinBounds('usdttrc20', 5).max_amount).toBe(50000);
    } finally {
      if (prev === undefined) delete process.env.CRYPTO_COIN_LIMITS;
      else process.env.CRYPTO_COIN_LIMITS = prev;
    }
  });

  it('rejects amounts outside the coin bounds', () => {
    const prev = process.env.CRYPTO_COIN_LIMITS;
    process.env.CRYPTO_COIN_LIMITS = ENV.CRYPTO_COIN_LIMITS;
    try {
      expect(() => assertCoinAmount('btc', 0.00001, 0.00005)).toThrow(
        BadRequestException,
      );
      expect(() => assertCoinAmount('btc', 2, 0.00005)).toThrow(
        /Maximum for BTC/,
      );
      expect(assertCoinAmount('btc', 0.01, 0.00005).max_amount).toBe(1.5);
    } finally {
      if (prev === undefined) delete process.env.CRYPTO_COIN_LIMITS;
      else process.env.CRYPTO_COIN_LIMITS = prev;
    }
  });
});
