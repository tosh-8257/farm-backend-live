import { Injectable, Logger } from '@nestjs/common';

export interface LiveUsdKesQuote {
  rate: number;
  provider: string;
  provider_updated_at: string | null;
  fetched_at: string;
}

/**
 * Fetches the market USD/KES rate from a public FX feed (no API key).
 * Enabled with FX_LIVE_RATE_ENABLED=true (default off).
 */
@Injectable()
export class LiveFxService {
  private readonly logger = new Logger(LiveFxService.name);
  private inFlight: Promise<LiveUsdKesQuote | null> | null = null;
  lastError: string | null = null;
  lastSuccessAt: string | null = null;

  static isEnabled(): boolean {
    return (process.env.FX_LIVE_RATE_ENABLED ?? '').toLowerCase() === 'true';
  }

  static ttlMs(): number {
    const minutes = Number(process.env.FX_LIVE_RATE_TTL_MINUTES ?? 60);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
  }

  url(): string {
    return (
      process.env.FX_LIVE_RATE_URL || 'https://open.er-api.com/v6/latest/USD'
    );
  }

  /** Single-flight fetch; returns null on any failure. */
  fetchUsdKes(): Promise<LiveUsdKesQuote | null> {
    if (!this.inFlight) {
      this.inFlight = this.doFetch().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doFetch(): Promise<LiveUsdKesQuote | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(this.url(), { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      const rate = Number(body?.rates?.KES);
      if (!Number.isFinite(rate) || rate < 50 || rate > 1000) {
        throw new Error('KES rate missing or out of range');
      }
      const now = new Date().toISOString();
      this.lastError = null;
      this.lastSuccessAt = now;
      return {
        rate,
        provider: 'open.er-api.com',
        provider_updated_at: body?.time_last_update_utc
          ? new Date(body.time_last_update_utc).toISOString()
          : null,
        fetched_at: now,
      };
    } catch (e: any) {
      this.lastError = e?.message ?? String(e);
      this.logger.warn(`Live USD/KES fetch failed: ${this.lastError}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
