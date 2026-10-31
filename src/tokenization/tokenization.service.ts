import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business-ops/business-access.service';
import { AlgorandAsaClient } from './algorand-asa.client';
import { algorandConfig, explorerAsset, explorerTx } from './algorand-config';
import { ON_INVEST_REQUESTABLE, onInvestConfig, unitsFor } from './on-invest';

/** 1 token unit represents 1 FARM of principal invested (whole units only). */
export const UNIT_PRICE = 1;
const TOKENIZABLE = ['funded', 'closed'];
const HOLDING = ['committed', 'active'];

const shape = (t: any) =>
  t && {
    ...t,
    unit_price: Number(t.unit_price),
    total_units: t.total_units?.toString(),
    asset_id: t.asset_id?.toString() ?? null,
    confirmed_round: t.confirmed_round?.toString() ?? null,
    farm_asset_id: t.farm_asset_id?.toString() ?? null,
    explorer_url: t.asset_id ? explorerAsset(t.network, t.asset_id) : null,
    tx_url: t.create_tx_id ? explorerTx(t.network, t.create_tx_id) : null,
  };

@Injectable()
export class TokenizationService {
  private readonly log = new Logger(TokenizationService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly chain: AlgorandAsaClient,
  ) {}

  status() {
    const c = algorandConfig();
    return {
      data: {
        enabled: c.enabled,
        on_invest_enabled: onInvestConfig().enabled,
        network: c.network,
        missing: c.missing,
        problems: c.problems,
      },
    };
  }

  // ---------- Business ----------
  async businessGet(userId: string, projectId: string) {
    const actor = await this.access.resolve(userId, 'projects:read');
    const p = await this.prisma.investment_projects.findFirst({
      where: { id: projectId, business_id: actor.business.id },
      include: { token: true },
    });
    if (!p) throw new NotFoundException('Project not found');
    return {
      data: shape(p.token) ?? null,
      enabled: algorandConfig().enabled,
      on_invest_enabled: onInvestConfig().enabled,
      progress: p.token ? await this.progress(p.token.id, p.token) : null,
    };
  }

  /** Units by allocation status, for the owner's progress view. */
  async progress(tokenId: string, t?: any) {
    const g = await this.prisma.token_allocations.groupBy({
      by: ['status'],
      where: { project_token_id: tokenId },
      _sum: { units: true },
      _count: { _all: true },
    });
    const by: Record<string, string> = {};
    let allocated = 0n;
    for (const r of g as any[]) {
      const u = BigInt(r._sum?.units ?? 0);
      by[r.status] = u.toString();
      if (!['cancelled', 'clawed_back'].includes(r.status)) allocated += u;
    }
    const total = BigInt(t?.total_units ?? 0);
    return {
      total_units: total.toString(),
      allocated_units: allocated.toString(),
      remaining_units: (total > allocated ? total - allocated : 0n).toString(),
      delivered_units: by.delivered ?? '0',
      owed_units: (BigInt(by.owed ?? 0) + BigInt(by.sending ?? 0)).toString(),
      by_status: by,
    };
  }

  async request(
    userId: string,
    projectId: string,
    dto: { asset_name: string; unit_name: string; mode?: string },
  ) {
    const onInvest = dto.mode === 'on_invest';
    const actor = await this.access.resolve(userId, 'projects:manage');
    const p = await this.prisma.investment_projects.findFirst({
      where: { id: projectId, business_id: actor.business.id },
      include: { token: true },
    });
    if (!p) throw new NotFoundException('Project not found');
    if (onInvest) {
      if (!onInvestConfig().enabled)
        throw new BadRequestException(
          'Tokenize-as-you-invest is not switched on yet',
        );
      if (!ON_INVEST_REQUESTABLE.includes(p.status ?? ''))
        throw new BadRequestException(
          'Request tokenization before the project is listed',
        );
      if (unitsFor(p.target_amount as any) < 1n)
        throw new BadRequestException('Set a funding target first');
    } else {
      if (!TOKENIZABLE.includes(p.status ?? ''))
        throw new BadRequestException(
          'Only funded or closed projects can be tokenized',
        );
      if (!(Number(p.raised_amount ?? 0) >= UNIT_PRICE))
        throw new BadRequestException('Nothing was raised for this project');
    }
    if (p.token && p.token.status !== 'rejected')
      throw new BadRequestException('Tokenization was already requested');
    const name = dto.asset_name?.trim();
    const unit = dto.unit_name?.trim().toUpperCase();
    if (!name || Buffer.byteLength(name) > 32)
      throw new BadRequestException('asset_name must be 1-32 bytes');
    if (!unit || !/^[A-Z0-9]{1,8}$/.test(unit))
      throw new BadRequestException('unit_name must be 1-8 letters or digits');
    const data = {
      status: 'requested',
      mode: onInvest ? 'on_invest' : 'post_funding',
      network: algorandConfig().network,
      asset_name: name,
      unit_name: unit,
      unit_price: UNIT_PRICE,
      total_units: BigInt(0),
      requested_by: userId,
      notes: null,
      error: null,
    };
    const t = p.token
      ? await this.prisma.project_tokens.update({
          where: { id: p.token.id },
          data,
        })
      : await this.prisma.project_tokens.create({
          data: { ...data, project_id: projectId },
        });
    return { data: shape(t) };
  }

  // ---------- Admin ----------
  async adminList(status?: string) {
    const rows = await this.prisma.project_tokens.findMany({
      where: status ? { status } : {},
      orderBy: { created_at: 'desc' },
      take: 100,
      include: {
        project: {
          select: { project_name: true, status: true, raised_amount: true },
        },
      },
    });
    return { data: rows.map(shape), config: this.status().data };
  }

  async reject(adminId: string, tokenId: string, notes: string) {
    if (!notes?.trim()) throw new BadRequestException('Notes are required');
    const r = await this.prisma.project_tokens.updateMany({
      where: { id: tokenId, status: { in: ['requested', 'failed'] } },
      data: { status: 'rejected', notes: notes.trim(), reviewed_by: adminId },
    });
    if (!r.count) throw new BadRequestException('Request is not pending');
    return { data: { id: tokenId, status: 'rejected' } };
  }

  /**
   * Approve and create the ASA on Algorand TestNet. Allocations mirror the
   * investments held at that moment (FARM custody). Only a confirmed algod
   * response is stored - nothing is written on failure except the error.
   */
  async approveAndMint(adminId: string, tokenId: string) {
    const cfg = algorandConfig();
    if (!cfg.enabled)
      throw new ServiceUnavailableException({
        message:
          'Tokenization is disabled until Algorand TestNet is configured',
        missing: cfg.missing,
        problems: cfg.problems,
      });
    const pre = await this.prisma.project_tokens.findUnique({
      where: { id: tokenId },
      select: { mode: true },
    });
    if (pre?.mode === 'on_invest') return this.mintOnInvest(adminId, tokenId);
    const claim = await this.prisma.project_tokens.updateMany({
      where: { id: tokenId, status: { in: ['requested', 'failed'] } },
      data: { status: 'creating', reviewed_by: adminId, error: null },
    });
    if (!claim.count) throw new BadRequestException('Request is not pending');
    const t = await this.prisma.project_tokens.findUnique({
      where: { id: tokenId },
      include: { project: true },
    });
    if (!t) throw new NotFoundException('Token request not found');
    try {
      if (!TOKENIZABLE.includes(t.project.status ?? ''))
        throw new BadRequestException('Project is no longer funded/closed');
      const invs = await this.prisma.user_investments.findMany({
        where: { project_id: t.project_id, status: { in: HOLDING } },
        select: { id: true, user_id: true, amount: true },
      });
      const allocs = invs
        .map((i) => ({
          investment_id: i.id,
          user_id: i.user_id!,
          units: BigInt(Math.floor(Number(i.amount ?? 0) / UNIT_PRICE)),
        }))
        .filter((a) => a.user_id && a.units > 0n);
      const total = allocs.reduce((s, a) => s + a.units, 0n);
      if (total <= 0n)
        throw new BadRequestException('No investments to tokenize');

      const res = await this.chain.createAsset({
        assetName: t.asset_name,
        unitName: t.unit_name,
        total,
        note: `farm:project:${t.project_id}`,
      });
      await this.prisma.$transaction(async (tx) => {
        await tx.project_tokens.update({
          where: { id: tokenId },
          data: {
            status: 'created',
            total_units: total,
            asset_id: res.assetId,
            create_tx_id: res.txId,
            confirmed_round: res.confirmedRound,
            issuer_address: res.issuer,
            farm_asset_id: /^\d+$/.test(process.env.FARM_ASA_ID ?? '')
              ? BigInt(process.env.FARM_ASA_ID!)
              : null,
          },
        });
        await tx.token_allocations.createMany({
          data: allocs.map((a) => ({ ...a, project_token_id: tokenId })),
        });
        await tx.blockchain_transactions.create({
          data: {
            blockchain_name: 'algorand',
            tx_hash: res.txId,
            sender_address: res.issuer,
            asset_id: res.assetId.toString(),
            amount: total.toString(),
            confirmations: 1,
            status: 'confirmed',
            raw_response: {
              type: 'asset_create',
              network: cfg.network,
              confirmed_round: res.confirmedRound.toString(),
              project_id: t.project_id,
            },
          },
        });
        await tx.project_reviews.create({
          data: {
            project_id: t.project_id,
            actor_id: adminId,
            action: 'tokenized',
            from_status: t.project.status,
            to_status: t.project.status ?? 'funded',
            notes: `ASA ${res.assetId} (${cfg.network})`,
          },
        });
      });
      return {
        data: shape(
          await this.prisma.project_tokens.findUnique({
            where: { id: tokenId },
          }),
        ),
      };
    } catch (e: any) {
      const msg = String(e?.message ?? 'Asset creation failed').slice(0, 500);
      this.log.warn(`Tokenization ${tokenId} failed: ${msg}`);
      await this.prisma.project_tokens.update({
        where: { id: tokenId },
        data: { status: 'failed', error: msg },
      });
      throw e instanceof BadRequestException
        ? e
        : new ServiceUnavailableException(
            'Asset creation failed; you can retry',
          );
    }
  }

  /**
   * On-invest mode: admin approval (alone or as part of listing) creates the
   * ASA with total supply = funding target (1 token per FARM). The issuer
   * holds every unit; tokens are delivered per investment by the delivery job.
   * Only a confirmed algod response is stored.
   */
  async mintOnInvest(adminId: string, tokenId: string) {
    const cfg = onInvestConfig();
    if (!cfg.enabled)
      throw new ServiceUnavailableException({
        message: 'Tokenize-as-you-invest is switched off',
        missing: cfg.missing,
        problems: cfg.problems,
      });
    const claim = await this.prisma.project_tokens.updateMany({
      where: {
        id: tokenId,
        mode: 'on_invest',
        status: { in: ['requested', 'failed'] },
      },
      data: { status: 'creating', reviewed_by: adminId, error: null },
    });
    if (!claim.count) throw new BadRequestException('Request is not pending');
    const t = await this.prisma.project_tokens.findUnique({
      where: { id: tokenId },
      include: { project: true },
    });
    if (!t) throw new NotFoundException('Token request not found');
    try {
      if (!['approved', 'listed'].includes(t.project.status ?? ''))
        throw new BadRequestException(
          'Approve the project before creating its token',
        );
      if (Number(t.project.raised_amount ?? 0) > 0)
        throw new BadRequestException(
          'Project already has investments; use post-funding tokenization',
        );
      const total = unitsFor(t.project.target_amount as any);
      if (total < 1n) throw new BadRequestException('Project has no target');
      const res = await this.chain.createAsset({
        assetName: t.asset_name,
        unitName: t.unit_name,
        total,
        note: `farm:project:${t.project_id}:on_invest`,
      });
      await this.prisma.$transaction(async (tx) => {
        await tx.project_tokens.update({
          where: { id: tokenId },
          data: {
            status: 'created',
            total_units: total,
            asset_id: res.assetId,
            create_tx_id: res.txId,
            confirmed_round: res.confirmedRound,
            issuer_address: res.issuer,
          },
        });
        await tx.blockchain_transactions.create({
          data: {
            blockchain_name: 'algorand',
            tx_hash: res.txId,
            sender_address: res.issuer,
            asset_id: res.assetId.toString(),
            amount: total.toString(),
            confirmations: 1,
            status: 'confirmed',
            raw_response: {
              type: 'asset_create',
              mode: 'on_invest',
              network: cfg.network,
              confirmed_round: res.confirmedRound.toString(),
              project_id: t.project_id,
            },
          },
        });
        await tx.project_reviews.create({
          data: {
            project_id: t.project_id,
            actor_id: adminId,
            action: 'tokenized',
            from_status: t.project.status,
            to_status: t.project.status ?? 'approved',
            notes: `ASA ${res.assetId} (${cfg.network}), supply ${total}`,
          },
        });
      });
      return {
        data: shape(
          await this.prisma.project_tokens.findUnique({
            where: { id: tokenId },
          }),
        ),
      };
    } catch (e: any) {
      const msg = String(e?.message ?? 'Asset creation failed').slice(0, 500);
      this.log.warn(`On-invest tokenization ${tokenId} failed: ${msg}`);
      await this.prisma.project_tokens.update({
        where: { id: tokenId },
        data: { status: 'failed', error: msg },
      });
      throw e instanceof BadRequestException
        ? e
        : new ServiceUnavailableException(
            'Asset creation failed; you can retry',
          );
    }
  }

  /**
   * Called by the admin 'list' action BEFORE the status changes. If the
   * project has a pending on-invest token, it is created now; a failure
   * blocks the listing so no one can invest without a token.
   */
  async ensureTokenForListing(adminId: string, projectId: string) {
    const t = await this.prisma.project_tokens.findUnique({
      where: { project_id: projectId },
    });
    if (!t || t.mode !== 'on_invest' || t.status === 'rejected') return null;
    if (t.status === 'created') return t;
    return (await this.mintOnInvest(adminId, t.id)).data;
  }

  // ---------- Investor ----------
  async myTokens(userId: string) {
    const rows = await this.prisma.token_allocations.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      include: {
        token: {
          include: { project: { select: { id: true, project_name: true } } },
        },
      },
    });
    return {
      data: rows.map((a) => ({
        id: a.id,
        investment_id: a.investment_id,
        units: a.units.toString(),
        custody: a.custody,
        status: a.status,
        delivered: a.status === 'delivered',
        address: a.address,
        tx_url:
          a.tx_id && a.status === 'delivered'
            ? explorerTx(a.token.network, a.tx_id)
            : null,
        project: a.token.project,
        token: shape({ ...a.token, project: undefined }),
      })),
    };
  }
}
