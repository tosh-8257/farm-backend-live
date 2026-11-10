import { redactAuditBody } from './audit.middleware';

describe('audit log redaction', () => {
  it('removes PINs, passwords, OTPs and fingerprints before they are stored', () => {
    expect(
      redactAuditBody({
        amount: 10,
        new_pin: '1234',
        old_pin: '9999',
        password: 'secret',
        otp_code: '123456',
        deviceFingerprint: 'abc',
        tokens_bought: 2,
      }),
    ).toEqual({
      amount: 10,
      new_pin: '[REDACTED]',
      old_pin: '[REDACTED]',
      password: '[REDACTED]',
      otp_code: '[REDACTED]',
      deviceFingerprint: '[REDACTED]',
      tokens_bought: 2,
    });
  });
});
