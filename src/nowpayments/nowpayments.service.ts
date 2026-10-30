import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as QRCode from 'qrcode';
import { createHmac } from 'crypto';

type NowPaymentsRecord = Record<string, any>;

@Injectable()
export class NowpaymentsService {
  private readonly logger = new Logger(NowpaymentsService.name);
  private readonly http: AxiosInstance;
  private payoutToken: string | null = null;
  private payoutTokenExpiresAt = 0;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: 'https://api.nowpayments.io/v1',
      timeout: 20_000,
    });
  }

  private getApiKey(): string {
    const key = this.config.get<string>('NOWPAYMENTS_API_KEY')?.trim();
    if (!key) {
      throw new ServiceUnavailableException(
        'NOWPayments is not configured on the server',
      );
    }
    return key;
  }

  private getIpnCallbackUrl(): string {
    const callback = this.config
      .get<string>('NOWPAYMENTS_IPN_CALLBACK_URL')
      ?.trim();
    if (!callback || !/^https:\/\//i.test(callback)) {
      throw new ServiceUnavailableException(
        'A public HTTPS NOWPAYMENTS_IPN_CALLBACK_URL is required',
      );
    }
    return callback;
  }

  private getPayoutIpnCallbackUrl(): string {
    const callback = this.config
      .get<string>('NOWPAYMENTS_PAYOUT_IPN_CALLBACK_URL')
      ?.trim();
    if (callback && /^https:\/\//i.test(callback)) return callback;
    if (callback) {
      throw new ServiceUnavailableException(
        'NOWPAYMENTS_PAYOUT_IPN_CALLBACK_URL must use HTTPS',
      );
    }
    const paymentCallback = this.getIpnCallbackUrl();
    if (!/\/webhooks\/nowpayments\/?$/.test(paymentCallback)) {
      throw new ServiceUnavailableException(
        'Set NOWPAYMENTS_PAYOUT_IPN_CALLBACK_URL to the public payout webhook URL',
      );
    }
    return paymentCallback.replace(
      /\/webhooks\/nowpayments\/?$/,
      '/webhooks/nowpayments-payout',
    );
  }

  private asRecord(value: unknown, operation: string): NowPaymentsRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadGatewayException(
        `NOWPayments returned an invalid response for ${operation}`,
      );
    }
    return value as NowPaymentsRecord;
  }

  private async request<T = unknown>(
    method: 'get' | 'post',
    path: string,
    data?: Record<string, unknown>,
    params?: Record<string, string | number | boolean>,
    headers: Record<string, string> = {},
  ): Promise<T> {
    try {
      const response = await this.http.request<T>({
        method,
        url: path,
        data,
        params,
        headers: {
          'x-api-key': this.getApiKey(),
          ...(data ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      });
      return response.data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const providerMessage =
          (error.response?.data as any)?.message ??
          (error.response?.data as any)?.status;
        this.logger.error(
          `NOWPayments ${method.toUpperCase()} ${path} failed${status ? ` (HTTP ${status})` : ''}${
            typeof providerMessage === 'string' ? `: ${providerMessage.slice(0, 300)}` : ''
          }`,
        );
        if (status && status >= 400 && status < 500) {
          throw new BadGatewayException(
            typeof providerMessage === 'string'
              ? `NOWPayments rejected the request: ${providerMessage}`
              : 'NOWPayments rejected the request',
          );
        }
      }
      throw new BadGatewayException(
        'NOWPayments is temporarily unavailable; please try again',
      );
    }
  }

  async getAvailableCurrencies(): Promise<string[]> {
    const response = this.asRecord(
      await this.request('get', '/currencies'),
      'currency list',
    );
    const currencies = response.currencies;
    if (!Array.isArray(currencies)) {
      throw new BadGatewayException(
        'NOWPayments returned an invalid currency list',
      );
    }
    return [
      ...new Set(
        currencies
          .filter(
            (currency): currency is string => typeof currency === 'string',
          )
          .map((currency) => currency.trim().toLowerCase())
          .filter((currency) => /^[a-z0-9]{2,20}$/.test(currency)),
      ),
    ].sort();
  }

  async getMinimumPaymentAmount(currency: string): Promise<{
    currency: string;
    minimumAmount: number;
    minimumUsd: number;
  }> {
    const normalizedCurrency = currency.trim().toLowerCase();
    if (!/^[a-z0-9]{2,20}$/.test(normalizedCurrency)) {
      throw new BadGatewayException('Invalid NOWPayments currency');
    }
    const response = this.asRecord(
      await this.request('get', '/min-amount', undefined, {
        currency_from: normalizedCurrency,
        currency_to: normalizedCurrency,
        fiat_equivalent: 'usd',
      }),
      'minimum payment amount',
    );
    const minimumAmount = Number(response.min_amount);
    if (!Number.isFinite(minimumAmount) || minimumAmount <= 0) {
      throw new BadGatewayException(
        'NOWPayments did not return a valid minimum payment amount',
      );
    }
    let minimumUsd = Number(response.fiat_equivalent);
    if (!Number.isFinite(minimumUsd) || minimumUsd <= 0) {
      minimumUsd = await this.estimateAmount(
        minimumAmount,
        normalizedCurrency,
        'usd',
      );
    }
    if (!Number.isFinite(minimumUsd) || minimumUsd <= 0) {
      throw new BadGatewayException(
        'NOWPayments did not return a valid USD equivalent for the minimum payment',
      );
    }
    return {
      currency: normalizedCurrency,
      minimumAmount,
      minimumUsd,
    };
  }

  async createPayment(input: {
    priceAmount: number;
    priceCurrency: string;
    payCurrency: string;
    orderId: string;
    description: string;
  }) {
    const data = this.asRecord(
      await this.request('post', '/payment', {
        price_amount: input.priceAmount,
        price_currency: input.priceCurrency.toLowerCase(),
        pay_currency: input.payCurrency.toLowerCase(),
        ipn_callback_url: this.getIpnCallbackUrl(),
        order_id: input.orderId,
        order_description: input.description,
      }),
      'payment creation',
    );
    const paymentId = data.payment_id?.toString();
    const address = data.pay_address?.toString();
    const amount = Number(data.pay_amount);
    const currency = data.pay_currency?.toString();
    if (
      !paymentId ||
      !address ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !currency
    ) {
      throw new BadGatewayException(
        'NOWPayments did not return complete payment instructions',
      );
    }
    return {
      ...data,
      payment_id: paymentId,
      pay_address: address,
      pay_amount: amount,
      pay_currency: currency,
      payment_status: data.payment_status?.toString() ?? 'waiting',
      expiration_estimate:
        data.expiration_estimate_date ?? data.expiration_estimate ?? null,
      qr_url: await QRCode.toDataURL(address),
    };
  }

  /**
   * Validates a USD price against NOWPayments' minimum for the asset and
   * returns a crypto estimate. Used for in-app checkout previews.
   */
  async estimateCheckout(priceUsd: number, payCurrency: string) {
    const currency = payCurrency?.trim().toLowerCase();
    if (!Number.isFinite(priceUsd) || priceUsd <= 0 || priceUsd > 100_000) {
      throw new BadRequestException('Enter a valid USD amount');
    }
    if (!currency || !/^[a-z0-9]{2,20}$/.test(currency)) {
      throw new BadRequestException('Choose a valid cryptocurrency');
    }
    const available = await this.getAvailableCurrencies();
    if (!available.includes(currency)) {
      throw new BadRequestException(
        'The selected cryptocurrency is not currently available',
      );
    }
    const [estimated, minimum] = await Promise.all([
      this.estimateAmount(priceUsd, 'usd', currency),
      this.getMinimumPaymentAmount(currency),
    ]);
    return {
      price_amount: Number(priceUsd.toFixed(2)),
      price_currency: 'usd',
      pay_currency: currency,
      estimated_amount: estimated,
      minimum_amount: minimum.minimumAmount,
      minimum_usd: minimum.minimumUsd,
      meets_minimum: estimated >= minimum.minimumAmount,
    };
  }

  async createInvoice(input: {
    priceAmount: number;
    priceCurrency: string;
    payCurrency?: string;
    orderId: string;
    description: string;
    successUrl?: string;
    cancelUrl?: string;
  }) {
    const data = this.asRecord(
      await this.request('post', '/invoice', {
        price_amount: input.priceAmount,
        price_currency: input.priceCurrency.toLowerCase(),
        ...(input.payCurrency
          ? { pay_currency: input.payCurrency.toLowerCase() }
          : {}),
        order_id: input.orderId,
        order_description: input.description,
        ipn_callback_url: this.getIpnCallbackUrl(),
        ...(input.successUrl ? { success_url: input.successUrl } : {}),
        ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
      }),
      'invoice creation',
    );
    const invoiceUrl = data.invoice_url?.toString();
    const invoiceId = data.id?.toString();
    if (!invoiceUrl || !/^https:\/\//i.test(invoiceUrl) || !invoiceId) {
      throw new BadGatewayException(
        'NOWPayments did not return a valid invoice checkout',
      );
    }
    return { ...data, invoice_id: invoiceId, invoice_url: invoiceUrl };
  }

  async getPayment(paymentId: string): Promise<NowPaymentsRecord> {
    if (!/^\d+$/.test(paymentId)) {
      throw new BadGatewayException('Invalid NOWPayments payment ID');
    }
    return this.asRecord(
      await this.request('get', `/payment/${encodeURIComponent(paymentId)}`),
      'payment status check',
    );
  }

  async estimateAmount(
    amount: number,
    currencyFrom: string,
    currencyTo: string,
  ): Promise<number> {
    const response = this.asRecord(
      await this.request('get', '/estimate', undefined, {
        amount,
        currency_from: currencyFrom.toLowerCase(),
        currency_to: currencyTo.toLowerCase(),
      }),
      'payout estimate',
    );
    const estimate = Number(response.estimated_amount);
    if (!Number.isFinite(estimate) || estimate <= 0) {
      throw new BadGatewayException(
        'NOWPayments could not estimate this crypto conversion',
      );
    }
    return estimate;
  }

  async getPayoutMinimum(currency: string): Promise<number> {
    const response = this.asRecord(
      await this.request(
        'get',
        `/payout-withdrawal/min-amount/${encodeURIComponent(currency.toLowerCase())}`,
      ),
      'payout minimum',
    );
    const minimum = Number(response.min_amount ?? response.minimum_amount);
    if (!Number.isFinite(minimum) || minimum <= 0) {
      throw new BadGatewayException(
        'NOWPayments did not return a valid payout minimum',
      );
    }
    return minimum;
  }

  async estimatePayoutFee(currency: string, amount: number): Promise<number> {
    const response = this.asRecord(
      await this.request('get', '/payout/fee', undefined, {
        currency: currency.toUpperCase(),
        amount,
      }),
      'payout network fee estimate',
    );
    const fee = Number(response.fee);
    if (!Number.isFinite(fee) || fee < 0) {
      throw new BadGatewayException(
        'NOWPayments did not return a valid network fee estimate',
      );
    }
    return fee;
  }

  private async getPayoutToken(): Promise<string> {
    if (this.payoutToken && Date.now() < this.payoutTokenExpiresAt) {
      return this.payoutToken;
    }
    const email = this.config.get<string>('NOWPAYMENTS_EMAIL')?.trim();
    const password = this.config.get<string>('NOWPAYMENTS_PASSWORD');
    if (!email || !password) {
      throw new ServiceUnavailableException(
        'NOWPayments payout credentials are not configured on the server',
      );
    }
    const response = this.asRecord(
      await this.request('post', '/auth', { email, password }),
      'payout authentication',
    );
    const token = response.token?.toString();
    if (!token) {
      throw new BadGatewayException(
        'NOWPayments did not return a payout authentication token',
      );
    }
    this.payoutToken = token;
    this.payoutTokenExpiresAt = Date.now() + 4 * 60 * 1000;
    return token;
  }

  private async payoutRequest<T = unknown>(
    method: 'get' | 'post',
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const token = await this.getPayoutToken();
    return this.request<T>(method, path, body, params, {
      Authorization: `Bearer ${token}`,
    });
  }

  async createPayout(input: {
    address: string;
    currency: string;
    amount: number;
    reference: string;
  }): Promise<NowPaymentsRecord> {
    return this.asRecord(
      await this.payoutRequest('post', '/payout', {
        ipn_callback_url: this.getPayoutIpnCallbackUrl(),
        withdrawals: [
          {
            address: input.address,
            currency: input.currency.toLowerCase(),
            amount: input.amount,
            ipn_callback_url: this.getPayoutIpnCallbackUrl(),
            payout_description: `FARM crypto withdrawal ${input.reference}`,
            unique_external_id: input.reference,
          },
        ],
      }),
      'payout creation',
    );
  }

  async verifyPayout(payoutId: string, verificationCode: string) {
    return this.asRecord(
      await this.payoutRequest(
        'post',
        `/payout/${encodeURIComponent(payoutId)}/verify`,
        { verification_code: verificationCode },
      ),
      'payout verification',
    );
  }

  async getPayout(payoutId: string) {
    return this.asRecord(
      await this.payoutRequest(
        'get',
        `/payout/${encodeURIComponent(payoutId)}`,
      ),
      'payout status check',
    );
  }

  /**
   * Validates a payout address with NOWPayments. Returns false only when
   * NOWPayments says the address is invalid (HTTP 400); other failures throw
   * so funds are never locked against an unverified address.
   */
  async validatePayoutAddress(
    address: string,
    currency: string,
    extraId?: string | null,
  ): Promise<boolean> {
    try {
      await this.http.request({
        method: 'post',
        url: '/payout/validate-address',
        data: {
          address,
          currency: currency.toLowerCase(),
          ...(extraId ? { extra_id: extraId } : {}),
        },
        headers: {
          'x-api-key': this.getApiKey(),
          'Content-Type': 'application/json',
        },
      });
      return true;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 400) {
        return false;
      }
      this.logger.error(
        `NOWPayments POST /payout/validate-address failed${
          axios.isAxiosError(error) && error.response?.status
            ? ` (HTTP ${error.response.status})`
            : ''
        }`,
      );
      throw new BadGatewayException(
        'Could not verify the destination address right now; please try again',
      );
    }
  }

  /** Finds an existing payout by our unique_external_id (the withdrawal reference). */
  async findPayoutByExternalId(
    externalId: string,
    maxPages = 5,
  ): Promise<NowPaymentsRecord | null> {
    for (let page = 0; page < maxPages; page++) {
      const response: any = await this.payoutRequest(
        'get',
        '/payout',
        undefined,
        {
          limit: 100,
          page,
          order: 'desc',
        },
      );
      const items: any[] = Array.isArray(response)
        ? response
        : (response?.payouts ?? response?.data ?? []);
      if (!Array.isArray(items) || items.length === 0) return null;
      for (const item of items) {
        const withdrawals: any[] = Array.isArray(item?.withdrawals)
          ? item.withdrawals
          : [item];
        const match = withdrawals.find(
          (w) => String(w?.unique_external_id ?? '') === externalId,
        );
        if (match) {
          return {
            ...match,
            id: String(
              item?.batch_withdrawal_id ??
                match.batch_withdrawal_id ??
                item?.id ??
                match.id,
            ),
            status: match.status ?? item?.status,
          } as NowPaymentsRecord;
        }
      }
      if (items.length < 100) return null;
    }
    return null;
  }

  /**
   * TOTP code for automatic payout verification, from NOWPAYMENTS_2FA_SECRET
   * (base32 Google Authenticator secret). Returns null when not configured.
   */
  generatePayoutVerificationCode(now = Date.now()): string | null {
    const secret = this.config
      .get<string>('NOWPAYMENTS_2FA_SECRET')
      ?.replace(/\s+/g, '')
      .toUpperCase();
    if (!secret) return null;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of secret.replace(/=+$/, '')) {
      const v = alphabet.indexOf(ch);
      if (v < 0) return null;
      bits += v.toString(2).padStart(5, '0');
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8)
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
    const hmac = createHmac('sha1', Buffer.from(bytes))
      .update(counter)
      .digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return code.toString().padStart(6, '0');
  }
}
