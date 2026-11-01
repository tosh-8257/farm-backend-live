import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { WithdrawService } from '../withdraw/withdraw.service';
import { BusinessWebhooksService } from '../business-ops/business-webhooks.service';
import { ApiPayoutDto } from './business-api.dto';
import {
  businessWalletEnabled,
  internalMove,
  personalWalletOf,
  settlementWalletFor,
} from '../business-ops/business-wallet';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_\-:.]{8,255}$/;

/**
 * Live payouts requested through the business API. They go through
 * WithdrawService.createWithdrawal exactly like an app withdrawal (atomic
 * balance lock, daily limits, address validation, automatic payout, no admin
 * step). The live API key with payouts:write replaces the PIN. Every request
 * needs an Idempotency-Key; repeats return the original result.
 */
@Injectable()
export class ApiPayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly withdraw: WithdrawService,
    private readonly webhooks: BusinessWebhooksService,
  ) {}

  static hash(dto: ApiPayoutDto) {
    const keys = Object.keys(dto).sort();
    return createHash('sha256')
      .update(JSON.stringify(keys.map((k) => [k, (dto as any)[k]])))
      .digest('hex');
  }

  /**
   * Dashboard payouts: same automatic pipeline, no admin step. Only roles
   * with payouts:create (Owner, Finance) and the actor's own PIN.
   */
  async createFromDashboard(
    access: { resolve: (u: string, p: 'payouts:create') => Promise<any> },
    verifyPin: (u: string, pin: string) => Promise<unknown>,
    userId: string,
    dto: ApiPayoutDto & { pin: string },
    idempotencyKey?: string,
  ) {
    const a = await access.resolve(userId, 'payouts:create');
    await verifyPin(userId, dto.pin);
    const { pin: _pin, ...rest } = dto;
    return this.create(
      {
        businessId: a.business.id,
        ownerUserId: a.business.owner_user_id,
        actorUserId: userId,
      },
      rest,
      idempotencyKey,
    );
  }

  async create(
    ctx: {
      businessId: string;
      ownerUserId: string;
      keyId?: string;
      actorUserId?: string;
    },
    dto: ApiPayoutDto,
    idempotencyKey?: string,
  ) {
    if (!ctx.keyId && !ctx.actorUserId)
      throw new ForbiddenException('Payout is not authorised');
    if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey))
      throw new BadRequestException(
        'An Idempotency-Key header (8-255 letters, digits, - _ : .) is required for live payouts',
      );
    const biz = await this.prisma.businesses.findUnique({
      where: { id: ctx.businessId },
      select: {
        status: true,
        merchant_id: true,
        merchant: { select: { status: true } },
      },
    });
    if (biz?.status !== 'approved' || biz.merchant?.status !== 'approved')
      throw new ForbiddenException(
        'Live payouts need an approved business and merchant account',
      );

    const requestHash = ApiPayoutsService.hash(dto);
    const where = {
      business_id_idempotency_key: {
        business_id: ctx.businessId,
        idempotency_key: idempotencyKey,
      },
    };
    // Claim the idempotency key atomically (unique index).
    let record: any;
    try {
      record = await this.prisma.business_api_payouts.create({
        data: {
          business_id: ctx.businessId,
          api_key_id: ctx.keyId ?? null,
          source: ctx.keyId ? 'api' : 'dashboard',
          actor_user_id: ctx.actorUserId ?? null,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
        },
      });
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
      const existing = await this.prisma.business_api_payouts.findUnique({
        where,
      });
      if (!existing) throw new ConflictException('Try again');
      if (existing.request_hash !== requestHash)
        throw new ConflictException(
          'This Idempotency-Key was used with a different request',
        );
      if (existing.status === 'submitted')
        return { ...(existing.response as any), idempotent_replay: true };
      if (existing.status === 'processing')
        throw new ConflictException(
          'A payout with this Idempotency-Key is still being processed',
        );
      // failed before any money moved: allow a retry, but only one at a time
      const retry = await this.prisma.business_api_payouts.updateMany({
        where: { id: existing.id, status: 'failed' },
        data: { status: 'processing', error: null },
      });
      if (!retry.count)
        throw new ConflictException(
          'A payout with this Idempotency-Key is still being processed',
        );
      record = existing;
    }

    // BUSINESS_WALLET_ENABLED: the payout is funded from the business wallet.
    // The withdrawal pipeline debits the owner's personal wallet, so first move
    // the amount business -> personal (free), and move it back if the
    // withdrawal is rejected before any money leaves.
    let funded: { bizId: string; personalId: string } | null = null;
    if (businessWalletEnabled()) {
      const biz = await settlementWalletFor(this.prisma, {
        businessId: ctx.businessId,
      });
      const me = await personalWalletOf(this.prisma, ctx.ownerUserId);
      if (biz?.wallet_type === 'merchant' && me) {
        try {
          await internalMove(this.prisma, {
            fromId: biz.id,
            toId: me.id,
            amount: Number(dto.amount),
            kind: 'business_payout_funding',
            description: 'Business payout funding',
            metadata: { business_id: ctx.businessId, payout_record: record.id },
          });
        } catch {
          await this.prisma.business_api_payouts.update({
            where: { id: record.id },
            data: { status: 'failed', error: 'Insufficient business balance' },
          });
          throw new BadRequestException('Insufficient business balance');
        }
        funded = { bizId: biz.id, personalId: me.id };
      }
    }

    try {
      const res: any = await this.withdraw.createWithdrawal(
        ctx.ownerUserId,
        {
          amount: dto.amount,
          method: dto.method,
          accountName: dto.account_name,
          accountNumber: dto.account_number,
          bankName: dto.bank_name,
          phoneNumber: dto.phone_number,
          cryptoAddress: dto.crypto_address,
          cryptoAsset: dto.crypto_currency,
          network: dto.network,
          extra_id: dto.extra_id,
        },
        {
          preAuthorized: ctx.keyId
            ? `business_api_key:${ctx.keyId}`
            : `business_member_pin:${ctx.actorUserId}`,
        },
      );
      const w = res?.withdrawal ?? {};
      const response = {
        data: {
          id: w.id ?? null,
          reference: res?.reference,
          amount: Number(w.amount ?? dto.amount),
          fee: Number(w.fee ?? 0),
          settlement: Number(w.settlement ?? 0),
          method: dto.method,
          status: res?.status ?? 'PROCESSING',
        },
        message: 'Payout submitted for automatic processing',
      };
      await this.prisma.business_api_payouts.update({
        where: { id: record.id },
        data: {
          status: 'submitted',
          withdrawal_reference: res?.reference ?? null,
          response,
        },
      });
      await this.prisma.audit_logs
        .create({
          data: {
            user_id: ctx.actorUserId ?? ctx.ownerUserId,
            action: ctx.keyId
              ? 'business.api_payout'
              : 'business.dashboard_payout',
            entity_type: 'business',
            entity_id: ctx.businessId,
            new_values: {
              reference: res?.reference,
              amount: dto.amount,
              api_key_id: ctx.keyId ?? null,
              source: ctx.keyId ? 'api' : 'dashboard',
              actor_user_id: ctx.actorUserId ?? null,
            },
          } as any,
        })
        .catch(() => undefined);
      this.webhooks.emit(ctx.businessId, 'live', 'payout.requested', {
        reference: res?.reference,
        amount: dto.amount,
        method: dto.method,
        status: response.data.status,
      });
      return response;
    } catch (e: any) {
      if (funded) {
        // Withdrawal rejected: return the funding to the business wallet.
        await internalMove(this.prisma, {
          fromId: funded.personalId,
          toId: funded.bizId,
          amount: Number(dto.amount),
          kind: 'business_payout_funding_reversal',
          description: 'Business payout not sent; returned',
          metadata: { business_id: ctx.businessId, payout_record: record.id },
        }).catch(() => undefined);
      }
      await this.prisma.business_api_payouts.update({
        where: { id: record.id },
        data: {
          status: 'failed',
          error: String(e?.message ?? e).slice(0, 500),
          // keep what was asked for so the payouts list can show it
          response: {
            data: {
              amount: dto.amount,
              method: dto.method,
              status: 'FAILED',
            },
          },
        },
      });
      throw e;
    }
  }
}
