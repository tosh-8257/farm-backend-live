import { sign } from 'jsonwebtoken';
import { rateLimitTracker } from './user-throttler.guard';

describe('rateLimitTracker', () => {
  const accessSecret = 'access-secret';
  const refreshSecret = 'refresh-secret';
  const prev = {
    access: process.env.JWT_ACCESS_SECRET,
    refresh: process.env.JWT_REFRESH_SECRET,
  };

  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = accessSecret;
    process.env.JWT_REFRESH_SECRET = refreshSecret;
  });
  afterAll(() => {
    if (prev.access === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = prev.access;
    if (prev.refresh === undefined) delete process.env.JWT_REFRESH_SECRET;
    else process.env.JWT_REFRESH_SECRET = prev.refresh;
  });

  it('counts a signed access token per user, even after it expires', () => {
    const token = sign({ sub: 'user-1' }, accessSecret, { expiresIn: -10 });
    const req = {
      ip: '102.0.0.1',
      headers: { authorization: `Bearer ${token}` },
      body: {},
    } as any;
    expect(rateLimitTracker(req)).toBe('user:user-1');
  });

  it('counts a refresh token per user so carrier NAT does not share the bucket', () => {
    const token = sign({ sub: 'user-2' }, refreshSecret, { expiresIn: '90d' });
    const req = {
      ip: '102.0.0.1',
      headers: {},
      body: { refresh_token: token },
    } as any;
    expect(rateLimitTracker(req)).toBe('user:user-2');
  });

  it('falls back to the proxy-resolved IP when the token is not signed by us', () => {
    const req = {
      ip: '203.0.113.5',
      ips: ['203.0.113.5'],
      headers: { authorization: 'Bearer not-a-token' },
      body: {},
    } as any;
    expect(rateLimitTracker(req)).toBe('ip:203.0.113.5');
  });
});
