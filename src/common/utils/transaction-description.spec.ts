import { cleanTransactionDescription as c } from './transaction-description';

describe('cleanTransactionDescription', () => {
  it('drops the Pending prefix and tidies enums', () => {
    expect(c('Pending MOBILE_MONEY deposit via PAYSTACK (KES 20)')).toBe(
      'Mobile money deposit via Paystack (KES 20)',
    );
    expect(c('Pending NOWPayments crypto deposit (2.00 USD)')).toBe(
      'Crypto deposit via NOWPayments (2.00 USD)',
    );
    expect(c('Pending mobile money deposit via Paystack (KES 5)')).toBe(
      'Mobile money deposit via Paystack (KES 5)',
    );
    expect(c('Pending withdrawal')).toBe('Withdrawal');
  });
  it('leaves other text alone', () => {
    expect(c('Transfer to algorand')).toBe('Transfer to algorand');
    expect(c(null)).toBeNull();
  });
});
