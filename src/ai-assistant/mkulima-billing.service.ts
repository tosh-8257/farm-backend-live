import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { CurrencyConversionService } from '../currency/currency-conversion.service';
import { generateTxReference } from '../common/utils/reference.util';
import { ProviderUsage } from './ai-provider';

/** USD prices per 1M tokens for one chat model. */
export interface ModelPrice {
  input: number;
  cached_input?: number;
  output: number;
}
/** Price table from MKULIMA_PRICE_TABLE (JSON). No built-in prices. */
export interface PriceTable {
  models: Record<string, ModelPrice>;
  stt: Record<string, { per_minute: number }>;
}

export interface UsageCost {
  cost_usd: number;
  source: 'provider' | 'price_table';
}

export const LOW_BALANCE_MESSAGE =
  'Your FARM balance is too low to use Mkulima right now. Top up your wallet to continue.';

const round8 = (n: number) => Math.round(n * 1e8) / 1e8;

/**
 * Silent pay-as-you-go billing for Mkulima. Each use is charged from the
 * user's FARM wallet at the real provider cost x (1 + margin). The margin is
 * booked as the `fee` on a `mkulima_usage` transaction, so it shows up as a
 * revenue stream for super admin. Off unless MKULIMA_BILLING_ENABLED=true.
 */
@Injectable()
export class MkulimaBillingService {
  private readonly log = new Logger(MkulimaBillingService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly fx?: CurrencyConversionService,
  ) {}

  enabled(): boolean {
    return this.config.get<string>('MKULIMA_BILLING_ENABLED') === 'true';
  }

  marginPct(): number {
    const v = Number(this.config.get<string>('MKULIMA_MARGIN_PCT') ?? 25);
    return Number.isFinite(v) && v >= 0 ? v : 25;
  }

  minBalance(): number {
    const v = Number(this.config.get<string>('MKULIMA_MIN_BALANCE_FARM') ?? 1);
    return Number.isFinite(v) && v >= 0 ? v : 1;
  }

  priceTable(): PriceTable | null {
    const raw = this.config.get<string>('MKULIMA_PRICE_TABLE');
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as Partial<PriceTable>;
      return { models: t.models ?? {}, stt: t.stt ?? {} };
    } catch {
      this.log.warn('MKULIMA_PRICE_TABLE is not valid JSON');
      return null;
    }
  }

  /** USD cost of a set of chat completions: provider-reported when every call has it, else the price table. */
  chatCostUsd(usages: ProviderUsage[]): UsageCost {
    if (usages.length && usages.every((u) => u.cost_usd !== null))
      return {
        cost_usd: usages.reduce((t, u) => t + (u.cost_usd ?? 0), 0),
        source: 'provider',
      };
    const table = this.priceTable();
    let total = 0;
    for (const u of usages) {
      const p = table?.models[u.model];
      if (!p || !(p.input >= 0) || !(p.output >= 0))
        throw new Error(`No price configured for model ${u.model}`);
      const cached = Math.min(u.cached_tokens, u.prompt_tokens);
      const cachedPrice = p.cached_input ?? p.input;
      total +=
        ((u.prompt_tokens - cached) * p.input +
          cached * cachedPrice +
          u.output_tokens * p.output) /
        1e6;
    }
    return { cost_usd: total, source: 'price_table' };
  }

  sttCostUsd(model: string, seconds: number): UsageCost {
    const p = this.priceTable()?.stt[model];
    if (!p || !(p.per_minute >= 0))
      throw new Error(`No price configured for STT model ${model}`);
    return { cost_usd: (seconds / 60) * p.per_minute, source: 'price_table' };
  }

  /** True when the configured chat model can be priced (or the provider reports cost). */
  canPrice(model: string, kind: 'chat' | 'voice' = 'chat'): boolean {
    if (kind === 'voice') return !!this.priceTable()?.stt[model];
    const p = this.priceTable()?.models[model];
    return (
      !!p || this.config.get<string>('MKULIMA_TRUST_PROVIDER_COST') === 'true'
    );
  }

  /**
   * Gate before spending money with the provider. Throws 402 with a plain
   * top-up message when the wallet is below the minimum, 503 if pricing is
   * missing (fail closed rather than give AI away or invent a price).
   */
  async assertCanUse(
    userId: string,
    model: string,
    kind: 'chat' | 'voice' = 'chat',
  ): Promise<void> {
    if (!this.enabled()) return;
    if (!this.canPrice(model, kind))
      throw new HttpException(
        'Mkulima is temporarily unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    const w = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true },
    });
    const bal = Number(w?.balance ?? 0);
    if (!w || w.is_frozen || bal < Math.max(this.minBalance(), 1e-8))
      throw new HttpException(
        {
          statusCode: 402,
          code: 'MKULIMA_LOW_BALANCE',
          message: LOW_BALANCE_MESSAGE,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
  }

  private async usdKes(): Promise<{ usdKes: number; farmKes: number }> {
    const r = this.fx ? await this.fx.getCurrentRate() : null;
    const usdKes = Number(r?.usd_kes_rate);
    const farmKes = Number(r?.farm_kes_rate ?? 1) || 1;
    if (!(usdKes > 0)) throw new Error('No USD/KES rate available');
    return { usdKes, farmKes };
  }

  /** Price breakdown in FARM for a USD provider cost. */
  async quote(costUsd: number) {
    const { usdKes, farmKes } = await this.usdKes();
    const cost = round8((costUsd * usdKes) / farmKes);
    const margin = round8((cost * this.marginPct()) / 100);
    return {
      usd_kes_rate: usdKes,
      cost_farm: cost,
      margin_farm: margin,
      charge_farm: round8(cost + margin),
    };
  }

  /**
   * Record usage and charge the user's wallet. Never takes more than the
   * wallet holds: any unpaid remainder is recorded as shortfall and the next
   * use is blocked by assertCanUse. Errors are logged, never shown to the user.
   */
  async charge(input: {
    userId: string;
    kind: 'chat' | 'voice';
    model: string;
    conversationId?: string | null;
    usages?: ProviderUsage[];
    audioSeconds?: number;
  }) {
    if (!this.enabled()) return null;
    const usages = input.usages ?? [];
    let usage: UsageCost;
    try {
      usage =
        input.kind === 'voice'
          ? this.sttCostUsd(input.model, input.audioSeconds ?? 0)
          : this.chatCostUsd(usages);
    } catch (e) {
      this.log.error(`Mkulima billing: ${(e as Error).message}`);
      return null;
    }
    if (!(usage.cost_usd > 0)) return null;
    try {
      const q = await this.quote(usage.cost_usd);
      const sum = (k: keyof ProviderUsage) =>
        usages.reduce((t, u) => t + Number(u[k] ?? 0), 0);
      return await this.prisma.$transaction(async (tx: any) => {
        const w = await tx.wallets.findFirst({
          where: { user_id: input.userId, is_active: true },
        });
        const platform = await this.platformWallet(tx);
        const bal = Number(w?.balance ?? 0);
        const paid =
          w && !w.is_frozen ? round8(Math.min(bal, q.charge_farm)) : 0;
        const shortfall = round8(q.charge_farm - paid);
        // Margin is taken first; any shortfall eats into cost recovery.
        const fee = round8(Math.min(q.margin_farm, paid));
        let ref: string | null = null;
        if (paid > 0 && w && platform) {
          const debit = await tx.wallets.updateMany({
            where: { id: w.id, balance: { gte: paid } },
            data: { balance: { decrement: paid } },
          });
          if (debit.count !== 1) throw new Error('balance changed');
          await tx.wallets.update({
            where: { id: platform.id },
            data: { balance: { increment: paid } },
          });
          ref = generateTxReference();
          const t = await tx.transactions.create({
            data: {
              transaction_reference: ref,
              sender_wallet_id: w.id,
              receiver_wallet_id: platform.id,
              transaction_type: 'mkulima_usage',
              status: 'completed',
              amount: paid,
              fee,
              net_amount: round8(paid - fee),
              currency: 'FARM',
              description: 'Mkulima AI',
              processed_at: new Date(),
              metadata: { kind: 'mkulima_usage', usage_kind: input.kind },
            },
          });
          await tx.ledger_entries.create({
            data: {
              transaction_id: t.id,
              wallet_id: w.id,
              entry_type: 'debit',
              amount: paid,
              balance_before: bal,
              balance_after: round8(bal - paid),
              description: 'Mkulima AI',
            },
          });
          const pb = Number(platform.balance ?? 0);
          await tx.ledger_entries.create({
            data: {
              transaction_id: t.id,
              wallet_id: platform.id,
              entry_type: 'credit',
              amount: paid,
              balance_before: pb,
              balance_after: round8(pb + paid),
              description: 'Mkulima AI',
              category: 'mkulima_usage',
            },
          });
        }
        return tx.mkulima_usage.create({
          data: {
            user_id: input.userId,
            conversation_id: input.conversationId ?? null,
            kind: input.kind,
            model: input.model,
            provider_calls: usages.length || 1,
            prompt_tokens: sum('prompt_tokens'),
            cached_tokens: sum('cached_tokens'),
            completion_tokens: sum('output_tokens'),
            audio_seconds: input.audioSeconds ?? 0,
            cost_source: usage.source,
            provider_cost_usd: usage.cost_usd,
            usd_kes_rate: q.usd_kes_rate,
            cost_farm: q.cost_farm,
            margin_farm: fee,
            charge_farm: q.charge_farm,
            transaction_ref: ref,
            status:
              shortfall > 0 ? (paid > 0 ? 'partial' : 'unpaid') : 'charged',
            shortfall_farm: shortfall,
          },
        });
      });
    } catch (e) {
      this.log.error(`Mkulima billing failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async platformWallet(tx: any) {
    const admin = await tx.users.findFirst({
      where: { role: 'super_admin', is_deleted: false },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });
    return admin?.wallets?.[0] ?? null;
  }

  /** Admin view: totals and recent rows with full cost and margin detail. */
  async adminSummary(days = 30) {
    const since = new Date(Date.now() - days * 86400000);
    const where = { created_at: { gte: since } };
    const agg = await (this.prisma as any).mkulima_usage.aggregate({
      where,
      _sum: {
        provider_cost_usd: true,
        cost_farm: true,
        margin_farm: true,
        charge_farm: true,
        shortfall_farm: true,
        prompt_tokens: true,
        completion_tokens: true,
        audio_seconds: true,
      },
      _count: { id: true },
    });
    const recent = await (this.prisma as any).mkulima_usage.findMany({
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    const n = (v: unknown) => Number(v ?? 0);
    return {
      enabled: this.enabled(),
      margin_pct: this.marginPct(),
      days,
      uses: agg._count.id,
      provider_cost_usd: n(agg._sum.provider_cost_usd),
      cost_farm: n(agg._sum.cost_farm),
      margin_farm: n(agg._sum.margin_farm),
      charged_farm: n(agg._sum.charge_farm),
      shortfall_farm: n(agg._sum.shortfall_farm),
      prompt_tokens: n(agg._sum.prompt_tokens),
      completion_tokens: n(agg._sum.completion_tokens),
      audio_seconds: n(agg._sum.audio_seconds),
      recent,
    };
  }
}
