import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { notifyProjectOwner } from './project-owner-notify';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business-ops/business-access.service';
import {
  MAX_MILESTONES,
  RELEASABLE,
  DOCUMENT_KINDS,
  DOCUMENT_VISIBILITY,
  EDITABLE,
  INSTRUMENT_TYPES,
  REQUIRED_DOCUMENTS,
  SECTORS,
} from './project-rules';
import { presentProject } from './marketplace.service';

export interface ProjectInput {
  project_name?: string;
  sector?: string;
  summary?: string;
  description?: string;
  location?: string;
  country?: string;
  banner_image?: string;
  gallery_images?: string[];
  target_amount?: number;
  minimum_investment?: number;
  maximum_investment?: number | null;
  instrument_type?: string;
  duration_months?: number;
  use_of_funds?: string;
  risk_factors?: string;
  team?: string;
  starts_at?: string | null;
  ends_at?: string | null;
}

const TEXT_LIMITS: Record<string, number> = {
  project_name: 255,
  summary: 500,
  location: 255,
  banner_image: 2000,
  description: 20000,
  use_of_funds: 20000,
  risk_factors: 20000,
  team: 20000,
};

/** Whitelist + validate project fields (never spread raw input into Prisma). */
export function cleanProjectInput(dto: ProjectInput) {
  const d: Record<string, any> = {};
  for (const [k, max] of Object.entries(TEXT_LIMITS)) {
    const v = (dto as any)[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string')
      throw new BadRequestException(`${k} must be text`);
    if (v && v.length > max) throw new BadRequestException(`${k} is too long`);
    d[k] = v?.trim() || null;
  }
  if (d.banner_image && !/^https:\/\/\S+$/.test(d.banner_image)) {
    throw new BadRequestException(
      'banner_image must be an https URL. Upload the cover photo first.',
    );
  }
  if (dto.gallery_images !== undefined) {
    if (!Array.isArray(dto.gallery_images) || dto.gallery_images.length > 8) {
      throw new BadRequestException('gallery_images accepts at most 8 URLs');
    }
    const urls = dto.gallery_images.map((url) => String(url ?? '').trim());
    if (urls.some((url) => !/^https:\/\/\S+$/.test(url) || url.length > 2000)) {
      throw new BadRequestException(
        'Each gallery image must be an https URL. Upload the photos first.',
      );
    }
    d.gallery_images = urls;
  }
  if (dto.sector !== undefined) {
    if (!(SECTORS as readonly string[]).includes(dto.sector))
      throw new BadRequestException('Unknown sector');
    d.sector = dto.sector;
    d.category = dto.sector;
  }
  if (dto.instrument_type !== undefined) {
    if (!(INSTRUMENT_TYPES as readonly string[]).includes(dto.instrument_type))
      throw new BadRequestException('Unknown instrument type');
    d.instrument_type = dto.instrument_type;
  }
  if (dto.country !== undefined) {
    if (dto.country && !/^[A-Z]{2}$/.test(dto.country))
      throw new BadRequestException('country must be ISO-2');
    d.country = dto.country || null;
  }
  for (const k of [
    'target_amount',
    'minimum_investment',
    'maximum_investment',
  ] as const) {
    const v = dto[k];
    if (v === undefined) continue;
    if (v === null && k === 'maximum_investment') {
      d[k] = null;
      continue;
    }
    const num = Number(v);
    if (!Number.isFinite(num) || num <= 0 || num > 1e12)
      throw new BadRequestException(`${k} must be a positive number`);
    d[k] = num;
  }
  if (dto.duration_months !== undefined) {
    const m = Number(dto.duration_months);
    if (!Number.isInteger(m) || m < 1 || m > 360)
      throw new BadRequestException('duration_months must be 1-360');
    d.duration_months = m;
  }
  for (const k of ['starts_at', 'ends_at'] as const) {
    if (dto[k] === undefined) continue;
    if (dto[k] === null) d[k] = null;
    else {
      const t = new Date(dto[k]);
      if (isNaN(t.getTime()))
        throw new BadRequestException(`${k} is not a valid date`);
      d[k] = t;
    }
  }
  return d;
}

@Injectable()
export class BusinessProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  private async own(
    userId: string,
    id: string,
    perm: 'projects:read' | 'projects:manage',
  ) {
    const actor = await this.access.resolve(userId, perm);
    const p = await this.prisma.investment_projects.findFirst({
      where: { id, business_id: actor.business.id },
      include: {
        documents: { orderBy: { created_at: 'asc' } },
        updates: { orderBy: { created_at: 'desc' } },
        milestones: { orderBy: { position: 'asc' } },
        reviews: {
          orderBy: { created_at: 'desc' },
          select: {
            action: true,
            to_status: true,
            notes: true,
            created_at: true,
          },
        },
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    return { actor, p };
  }

  private shape(p: any) {
    return {
      ...presentProject(p),
      review_notes: p.review_notes ?? null,
      legacy: false,
    };
  }

  async list(userId: string) {
    const actor = await this.access.resolve(userId, 'projects:read');
    const rows = await this.prisma.investment_projects.findMany({
      where: { business_id: actor.business.id },
      orderBy: { created_at: 'desc' },
    });
    return { data: rows.map((r) => this.shape(r)) };
  }

  async get(userId: string, id: string) {
    const { p } = await this.own(userId, id, 'projects:read');
    const investors = await this.prisma.user_investments.groupBy({
      by: ['status'],
      where: { project_id: id },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return {
      data: {
        ...this.shape(p),
        documents: p.documents,
        updates: p.updates,
        reviews: p.reviews,
        released_amount: Number(p.released_amount ?? 0),
        milestones: p.milestones.map((m) => ({
          ...m,
          amount: Number(m.amount),
          released_amount:
            m.released_amount == null ? null : Number(m.released_amount),
        })),
        investment_summary: investors.map((g) => ({
          status: g.status,
          count: g._count._all,
          amount: Number(g._sum.amount ?? 0),
        })),
        required_documents: REQUIRED_DOCUMENTS,
      },
    };
  }

  /** Public API (read-only): a business's own projects. */
  async listForBusiness(businessId: string) {
    const rows = await this.prisma.investment_projects.findMany({
      where: { business_id: businessId },
      orderBy: { created_at: 'desc' },
    });
    return rows.map((r) => this.apiShape(r));
  }

  async getForBusiness(businessId: string, id: string) {
    const p = await this.prisma.investment_projects.findFirst({
      where: { id, business_id: businessId },
      include: {
        documents: {
          select: {
            id: true,
            kind: true,
            title: true,
            visibility: true,
            created_at: true,
          },
        },
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    return { ...this.apiShape(p), documents: p.documents };
  }

  private apiShape(p: any) {
    const s = presentProject(p);
    return {
      id: s.id,
      object: 'project',
      name: s.project_name,
      sector: s.sector,
      status: s.status,
      summary: s.summary,
      location: s.location,
      country: s.country,
      currency: s.currency,
      instrument_type: s.instrument_type,
      target_amount: s.target_amount,
      raised_amount: s.raised_amount,
      minimum_investment: s.minimum_investment,
      maximum_investment: s.maximum_investment,
      funding_progress: s.funding_progress,
      total_backers: s.total_backers ?? 0,
      submitted_at: s.submitted_at,
      listed_at: s.listed_at,
      created_at: s.created_at,
    };
  }

  async create(userId: string, dto: ProjectInput) {
    const actor = await this.access.resolve(userId, 'projects:manage');
    const d = cleanProjectInput(dto);
    if (!d.project_name)
      throw new BadRequestException('project_name is required');
    if (!d.sector) throw new BadRequestException('sector is required');
    if (!d.target_amount)
      throw new BadRequestException('target_amount is required');
    const p = await this.prisma.investment_projects.create({
      data: {
        ...d,
        project_name: d.project_name,
        target_amount: d.target_amount,
        roi_percent: 0,
        business_id: actor.business.id,
        created_by: userId,
        status: 'draft',
      } as any,
    });
    return { data: this.shape(p) };
  }

  async update(userId: string, id: string, dto: ProjectInput) {
    const { p } = await this.own(userId, id, 'projects:manage');
    if (!EDITABLE.includes(p.status ?? ''))
      throw new BadRequestException(
        'Only draft projects (or ones needing more info) can be edited',
      );
    const d = cleanProjectInput(dto);
    const u = await this.prisma.investment_projects.update({
      where: { id },
      data: d,
    });
    return { data: this.shape(u) };
  }

  async addDocument(
    userId: string,
    id: string,
    dto: { kind: string; title: string; url: string; visibility?: string },
  ) {
    const { p } = await this.own(userId, id, 'projects:manage');
    if (['rejected', 'closed', 'cancelled'].includes(p.status ?? ''))
      throw new BadRequestException('Project is closed');
    if (!(DOCUMENT_KINDS as readonly string[]).includes(dto.kind))
      throw new BadRequestException('Unknown document kind');
    const vis = dto.visibility ?? 'investors';
    if (!(DOCUMENT_VISIBILITY as readonly string[]).includes(vis))
      throw new BadRequestException('Unknown visibility');
    if (!dto.title?.trim() || dto.title.length > 255)
      throw new BadRequestException('title is required');
    if (!/^https:\/\/\S{4,1990}$/.test(dto.url ?? ''))
      throw new BadRequestException(
        'url must be an https link (upload the file first)',
      );
    const doc = await this.prisma.project_documents.create({
      data: {
        project_id: id,
        kind: dto.kind,
        title: dto.title.trim(),
        url: dto.url,
        visibility: vis,
        uploaded_by: userId,
      },
    });
    return { data: doc };
  }

  async removeDocument(userId: string, id: string, docId: string) {
    const { p } = await this.own(userId, id, 'projects:manage');
    if (!EDITABLE.includes(p.status ?? ''))
      throw new BadRequestException(
        'Documents are locked once the project is submitted',
      );
    const r = await this.prisma.project_documents.deleteMany({
      where: { id: docId, project_id: id },
    });
    if (!r.count) throw new NotFoundException('Document not found');
    return { data: { removed: true } };
  }

  /** draft / more_info_required -> submitted (Under Review). Admin review is always manual. */
  async submit(userId: string, id: string) {
    const { p } = await this.own(userId, id, 'projects:manage');
    if (!EDITABLE.includes(p.status ?? ''))
      throw new BadRequestException('Project has already been submitted');
    const missing: string[] = [];
    for (const f of [
      'project_name',
      'sector',
      'summary',
      'description',
      'use_of_funds',
      'risk_factors',
      'instrument_type',
      'location',
    ])
      if (!(p as any)[f]) missing.push(f);
    if (!p.target_amount || Number(p.target_amount) <= 0)
      missing.push('target_amount');
    if (!p.minimum_investment || Number(p.minimum_investment) <= 0)
      missing.push('minimum_investment');
    if (
      p.maximum_investment &&
      Number(p.maximum_investment) < Number(p.minimum_investment)
    )
      missing.push('maximum_investment (below minimum)');
    if (Number(p.minimum_investment ?? 0) > Number(p.target_amount))
      missing.push('minimum_investment (above target)');
    const ms = p.milestones ?? [];
    if (!ms.length) missing.push('milestones');
    else if (
      Math.abs(
        ms.reduce((t, m) => t + Number(m.amount), 0) - Number(p.target_amount),
      ) > 0.005
    )
      missing.push('milestones (amounts must add up to the target)');
    const kinds = new Set(p.documents.map((d) => d.kind));
    for (const k of REQUIRED_DOCUMENTS)
      if (!kinds.has(k)) missing.push(`document:${k}`);
    if (missing.length)
      throw new BadRequestException({
        message: 'Project is incomplete',
        missing,
      });
    const from = p.status;
    const claimed = await this.prisma.investment_projects.updateMany({
      where: { id, status: { in: EDITABLE } },
      data: { status: 'submitted', submitted_at: new Date() },
    });
    if (!claimed.count)
      throw new BadRequestException('Project has already been submitted');
    await this.prisma.project_reviews.create({
      data: {
        project_id: id,
        actor_id: userId,
        action: 'submit',
        from_status: from,
        to_status: 'submitted',
      },
    });
    await notifyProjectOwner(
      this.prisma,
      this.notifications,
      p,
      'Project submitted for review',
      `${p.project_name} is in the review queue. It appears on the marketplace only after it is approved and listed.`,
    );
    return { data: { id, status: 'submitted' } };
  }

  /** Replace the milestone plan (only while the project is editable). */
  async setMilestones(
    userId: string,
    id: string,
    items: { title: string; description?: string; amount: number }[],
  ) {
    const { p } = await this.own(userId, id, 'projects:manage');
    if (!EDITABLE.includes(p.status ?? ''))
      throw new BadRequestException(
        'Milestones are locked once the project is submitted',
      );
    if (!Array.isArray(items) || !items.length || items.length > MAX_MILESTONES)
      throw new BadRequestException(`Add 1-${MAX_MILESTONES} milestones`);
    for (const m of items) {
      if (!m.title?.trim() || m.title.length > 255)
        throw new BadRequestException('Each milestone needs a title');
      if (!(Number(m.amount) > 0))
        throw new BadRequestException('Each milestone needs a positive amount');
    }
    await this.prisma.$transaction([
      this.prisma.project_milestones.deleteMany({ where: { project_id: id } }),
      this.prisma.project_milestones.createMany({
        data: items.map((m, i) => ({
          project_id: id,
          position: i + 1,
          title: m.title.trim(),
          description: m.description?.trim() || null,
          amount: Number(m.amount),
        })),
      }),
    ]);
    return this.get(userId, id);
  }

  /**
   * Ask FARM to release the next milestone. Milestones are released in order,
   * only after the funding round has ended. The admin decides.
   */
  async requestMilestone(
    userId: string,
    id: string,
    milestoneId: string,
    dto: { evidence: string; evidence_url?: string },
  ) {
    const { p } = await this.own(userId, id, 'projects:manage');
    if (!RELEASABLE.includes(p.status ?? ''))
      throw new BadRequestException(
        'Milestones can be requested once the funding round has ended',
      );
    const m = p.milestones.find((x) => x.id === milestoneId);
    if (!m) throw new NotFoundException('Milestone not found');
    const earlier = p.milestones.filter((x) => x.position < m.position);
    if (earlier.some((x) => x.status !== 'released'))
      throw new BadRequestException(
        'Earlier milestones must be released first',
      );
    if (!dto.evidence?.trim() || dto.evidence.length > 5000)
      throw new BadRequestException('Describe the progress for this milestone');
    if (dto.evidence_url && !/^https:\/\/\S{4,1990}$/.test(dto.evidence_url))
      throw new BadRequestException('evidence_url must be an https link');
    const r = await this.prisma.project_milestones.updateMany({
      where: { id: milestoneId, status: { in: ['planned', 'returned'] } },
      data: {
        status: 'requested',
        evidence: dto.evidence.trim(),
        evidence_url: dto.evidence_url ?? null,
        requested_at: new Date(),
        requested_by: userId,
      },
    });
    if (!r.count)
      throw new BadRequestException('This milestone was already requested');
    await this.prisma.project_reviews.create({
      data: {
        project_id: id,
        actor_id: userId,
        action: 'milestone_requested',
        from_status: p.status,
        to_status: p.status ?? 'funded',
        notes: `Milestone ${m.position}: ${m.title}`,
      },
    });
    return { data: { id: milestoneId, status: 'requested' } };
  }

  async postUpdate(
    userId: string,
    id: string,
    dto: { title: string; body: string },
  ) {
    const { p } = await this.own(userId, id, 'projects:manage');
    if (!['listed', 'funded', 'closed', 'open'].includes(p.status ?? ''))
      throw new BadRequestException(
        'Updates can be posted once the project is listed',
      );
    if (!dto.title?.trim() || dto.title.length > 255)
      throw new BadRequestException('title is required');
    if (!dto.body?.trim() || dto.body.length > 20000)
      throw new BadRequestException('body is required');
    const u = await this.prisma.project_updates.create({
      data: {
        project_id: id,
        author_id: userId,
        title: dto.title.trim(),
        body: dto.body.trim(),
      },
    });
    return { data: u };
  }
}
