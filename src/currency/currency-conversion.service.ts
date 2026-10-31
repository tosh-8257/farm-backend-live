import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { LiveFxService } from './live-fx.service';

@Injectable()
export class CurrencyConversionService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly liveFx?: LiveFxService,
  ) {}

  private toNumber(value: any, fallback = 0): number {
    const parsed = Number(value ?? fallback);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private round(value: number, digits = 8): number {
    return Number(value.toFixed(digits));
  }

  private currencyRatesTableReady = false;

  private async ensureCurrencyRatesTable(): Promise<void> {
    if (this.currencyRatesTableReady) return;
    try {
      // Cast regclass to text: Prisma can't deserialize the regclass type, which
      // made this check throw (and log prisma:error) on every rate lookup.
      const rows = await this.prisma.$queryRaw<
        Array<{ exists: string | null }>
      >`
        SELECT to_regclass('public.currency_rates')::text AS exists;
      `;
      const exists = Boolean(rows?.[0]?.exists);

      if (exists) {
        await this.ensureSourceColumns();
        this.currencyRatesTableReady = true;
        return;
      }

      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "currency_rates" (
          "id" UUID NOT NULL DEFAULT gen_random_uuid(),
          "usd_kes_rate" DECIMAL(30,8) NOT NULL,
          "farm_kes_rate" DECIMAL(30,8) NOT NULL DEFAULT 1,
          "is_active" BOOLEAN NOT NULL DEFAULT true,
          "effective_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
          "updated_by" UUID,
          CONSTRAINT "currency_rates_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "currency_rates_updated_by_fkey"
            FOREIGN KEY ("updated_by") REFERENCES "users"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION
        );
      `;

      await this.prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS "idx_currency_rates_active"
        ON "currency_rates" ("is_active");
      `;
      await this.ensureSourceColumns();
      this.currencyRatesTableReady = true;
    } catch {
      // The table may be absent only in a partially migrated environment. Remaining
      // errors are still surfaced by the actual Prisma query call below.
    }
  }

  private async ensureSourceColumns(): Promise<void> {
    // Mirrors migration 20261121090000_currency_rate_source (additive).
    await this.prisma.$executeRaw`
      ALTER TABLE "currency_rates" ADD COLUMN IF NOT EXISTS "source" VARCHAR(32);
    `;
    await this.prisma.$executeRaw`
      ALTER TABLE "currency_rates" ADD COLUMN IF NOT EXISTS "is_override" BOOLEAN NOT NULL DEFAULT false;
    `;
  }

  private async activeRecord(): Promise<any> {
    return this.prisma.currency_rates.findFirst({
      where: { is_active: true },
      orderBy: { effective_at: 'desc' },
    });
  }

  /**
   * When live FX is enabled and no manual override is active, refresh the
   * stored rate from the market feed once the last live snapshot is older
   * than the TTL. Failures keep the last stored rate (marked stale).
   */
  private async resolveRecord(): Promise<{ record: any; stale: boolean }> {
    let record = await this.activeRecord();
    if (!LiveFxService.isEnabled() || !this.liveFx || record?.is_override) {
      return { record, stale: false };
    }
    const age = record?.effective_at
      ? Date.now() - new Date(record.effective_at).getTime()
      : Infinity;
    if (record?.source === 'live' && age < LiveFxService.ttlMs()) {
      return { record, stale: false };
    }
    const quote = await this.liveFx.fetchUsdKes();
    if (!quote) return { record, stale: true };
    // Re-check for an override set while we were fetching.
    const latest = await this.activeRecord();
    if (latest?.is_override) return { record: latest, stale: false };
    await this.prisma.currency_rates.updateMany({
      where: { is_active: true },
      data: { is_active: false },
    });
    record = await this.prisma.currency_rates.create({
      data: {
        usd_kes_rate: quote.rate,
        farm_kes_rate: 1,
        is_active: true,
        effective_at: new Date(quote.fetched_at),
        source: 'live',
        is_override: false,
      },
    });
    return { record, stale: false };
  }

  async getCurrentRate(): Promise<any> {
    await this.ensureCurrencyRatesTable();
    const { record, stale } = await this.resolveRecord();

    const usdKesRate = this.toNumber(record?.usd_kes_rate ?? 150, 150);
    const farmKesRate = this.toNumber(record?.farm_kes_rate ?? 1, 1);
    const farmUsdRate = this.round(farmKesRate / usdKesRate, 8);

    return {
      id: record?.id ?? null,
      usd_kes_rate: usdKesRate,
      farm_kes_rate: farmKesRate,
      farm_usd_rate: farmUsdRate,
      farm_usdc_rate: farmUsdRate,
      farm_usdt_rate: farmUsdRate,
      is_active: record?.is_active ?? true,
      effective_at: record?.effective_at ?? new Date(),
      updated_at: record?.effective_at ?? null,
      source: record ? (record.source ?? 'manual') : 'default',
      is_override: Boolean(record?.is_override),
      live_enabled: LiveFxService.isEnabled(),
      live_provider: this.liveFx ? 'open.er-api.com' : null,
      live_last_error: this.liveFx?.lastError ?? null,
      stale,
    };
  }

  async getCurrentUsdKesRate(): Promise<number> {
    const rate = await this.getCurrentRate();
    return this.toNumber(rate.usd_kes_rate, 150);
  }

  async farmToKes(amount: number): Promise<number> {
    const current = await this.getCurrentRate();
    return this.round(
      this.toNumber(amount) * this.toNumber(current.farm_kes_rate, 1),
    );
  }

  async farmToUsd(amount: number): Promise<number> {
    const current = await this.getCurrentRate();
    return this.round(
      this.toNumber(amount) * this.toNumber(current.farm_usd_rate, 0),
    );
  }

  async farmToUsdc(amount: number): Promise<number> {
    return this.farmToUsd(amount);
  }

  async farmToUsdt(amount: number): Promise<number> {
    return this.farmToUsd(amount);
  }

  async usdToFarm(amount: number): Promise<number> {
    const current = await this.getCurrentRate();
    const usdKesRate = this.toNumber(current.usd_kes_rate, 150);
    const farmKesRate = this.toNumber(current.farm_kes_rate, 1);
    return this.round((this.toNumber(amount) * usdKesRate) / farmKesRate);
  }

  async ensureRateExists(): Promise<any> {
    await this.ensureCurrencyRatesTable();
    const existing = await this.prisma.currency_rates.findFirst({
      where: { is_active: true },
      orderBy: { effective_at: 'desc' },
    });

    if (existing) return existing;

    return this.prisma.currency_rates.create({
      data: {
        usd_kes_rate: 150,
        farm_kes_rate: 1,
        is_active: true,
        effective_at: new Date(),
      },
    });
  }

  /** Drop the manual override so the live market rate is used again. */
  async clearOverride(): Promise<any> {
    await this.ensureCurrencyRatesTable();
    await this.prisma.currency_rates.updateMany({
      where: { is_active: true, is_override: true },
      data: { is_active: false },
    });
    return this.getCurrentRate();
  }

  async updateActiveRate(usdKesRate: number, adminId?: string): Promise<any> {
    await this.ensureCurrencyRatesTable();
    const parsedRate = Number(usdKesRate);
    if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
      throw new BadRequestException(
        'USD/KES conversion rate must be a positive number',
      );
    }

    await this.prisma.currency_rates.updateMany({
      where: { is_active: true },
      data: { is_active: false },
    });

    return this.prisma.currency_rates.create({
      data: {
        usd_kes_rate: parsedRate,
        farm_kes_rate: 1,
        is_active: true,
        effective_at: new Date(),
        updated_by: adminId ?? null,
        source: 'manual',
        is_override: true,
      },
    });
  }
}
