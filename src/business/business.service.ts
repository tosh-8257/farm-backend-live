import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { paginationParams, paginate } from '../common/utils/pagination.util';
import {
  REQUIRED_DOCUMENT_TYPES,
  ReviewBusinessDto,
  SaveBusinessDraftDto,
} from './business.dto';

export type BusinessStatus =
  | 'draft'
  | 'under_review'
  | 'more_information_required'
  | 'approved'
  | 'rejected';

/** Statuses in which the owner may still edit the application. */
const EDITABLE: BusinessStatus[] = [
  'draft',
  'more_information_required',
  'rejected',
];

const DETAIL_INCLUDE = {
  persons: { orderBy: { created_at: 'asc' as const } },
  documents: { orderBy: { created_at: 'asc' as const } },
  verifications: { orderBy: { submitted_at: 'desc' as const }, take: 10 },
};

@Injectable()
export class BusinessService {
  private readonly logger = new Logger(BusinessService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- owner

  async getMine(userId: string) {
    const business = await this.prisma.businesses.findUnique({
      where: { owner_user_id: userId },
      include: DETAIL_INCLUDE,
    });
    const merchant = await this.prisma.merchants.findFirst({
      where: { user_id: userId },
      select: { id: true, status: true, business_name: true },
    });
    return {
      data: {
        business: business ? this.ownerView(this.serialize(business)) : null,
        eligibility: this.eligibility(merchant, business),
      },
    };
  }

  async getStatus(userId: string) {
    const business = await this.prisma.businesses.findUnique({
      where: { owner_user_id: userId },
      select: {
        id: true,
        status: true,
        review_notes: true,
        submitted_at: true,
        reviewed_at: true,
        approved_at: true,
        didit_kyb_status: true,
        didit_kyb_session_id: true,
      },
    });
    return {
      data: business
        ? {
            ...business,
            is_active: business.status === 'approved',
            verification_method: 'didit',
            manual_kyb_enabled: process.env.MANUAL_KYB_ENABLED === 'true',
          }
        : {
            status: 'not_started',
            is_active: false,
            verification_method: 'didit',
            manual_kyb_enabled: process.env.MANUAL_KYB_ENABLED === 'true',
          },
    };
  }

  /**
   * Merchant -> Business upgrade. Creates a Draft business prefilled from the
   * user's approved merchant record. Never approves anything.
   */
  async upgradeFromMerchant(userId: string) {
    const existing = await this.prisma.businesses.findUnique({
      where: { owner_user_id: userId },
      include: DETAIL_INCLUDE,
    });
    if (existing) {
      return {
        data: this.ownerView(this.serialize(existing)),
        message: 'Business application already exists.',
      };
    }

    const merchant = await this.prisma.merchants.findFirst({
      where: { user_id: userId },
    });
    if (!merchant) {
      throw new BadRequestException(
        'Set up a merchant account before upgrading to a business account.',
      );
    }
    if (merchant.status !== 'approved') {
      throw new ForbiddenException(
        'Your merchant account must be approved before upgrading to a business account.',
      );
    }

    const business = await this.prisma.businesses.create({
      data: {
        owner_user_id: userId,
        merchant_id: merchant.id,
        legal_name: merchant.business_name,
        trading_name: merchant.business_name,
        registration_number: merchant.business_registration_number,
        business_type: merchant.business_type,
        country: merchant.country,
        city: merchant.city,
        address: merchant.address,
        business_email: merchant.business_email,
        business_phone: merchant.business_phone,
        status: 'draft',
      },
      include: DETAIL_INCLUDE,
    });
    await this.audit(userId, 'business.upgrade_started', business.id);
    return {
      data: this.ownerView(this.serialize(business)),
      message: 'Business draft created.',
    };
  }

  async saveDraft(userId: string, dto: SaveBusinessDraftDto) {
    const business = await this.requireOwned(userId);
    if (!EDITABLE.includes(business.status)) {
      throw new ConflictException(
        business.status === 'approved'
          ? 'Approved business details can no longer be edited here.'
          : 'This application is under review and cannot be edited.',
      );
    }

    const { persons, documents, incorporation_date, ...fields } = dto;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (persons) {
        await tx.business_persons.deleteMany({
          where: { business_id: business.id },
        });
        if (persons.length) {
          await tx.business_persons.createMany({
            data: persons.map((p) => ({
              business_id: business.id,
              role: p.role,
              full_name: p.full_name.trim(),
              nationality: p.nationality ?? null,
              date_of_birth: p.date_of_birth ? new Date(p.date_of_birth) : null,
              id_number: p.id_number ?? null,
              email: p.email ?? null,
              phone: p.phone ?? null,
              ownership_percent: p.ownership_percent ?? null,
            })),
          });
        }
      }
      if (documents) {
        await tx.business_documents.deleteMany({
          where: { business_id: business.id },
        });
        if (documents.length) {
          await tx.business_documents.createMany({
            data: documents.map((d) => ({
              business_id: business.id,
              doc_type: d.doc_type,
              file_url: d.file_url,
              file_name: d.file_name ?? null,
            })),
          });
        }
      }
      return tx.businesses.update({
        where: { id: business.id },
        data: {
          ...fields,
          ...(incorporation_date !== undefined
            ? {
                incorporation_date: incorporation_date
                  ? new Date(incorporation_date)
                  : null,
              }
            : {}),
          // Editing a rejected application starts a fresh draft.
          ...(business.status === 'rejected' ? { status: 'draft' } : {}),
        },
        include: DETAIL_INCLUDE,
      });
    });
    return {
      data: this.ownerView(this.serialize(updated)),
      message: 'Draft saved.',
    };
  }

  async submit(userId: string) {
    if (process.env.MANUAL_KYB_ENABLED !== 'true') {
      throw new ForbiddenException(
        'Manual business verification is disabled. Start the Didit KYB workflow.',
      );
    }
    const business = await this.prisma.businesses.findUnique({
      where: { owner_user_id: userId },
      include: DETAIL_INCLUDE,
    });
    if (!business)
      throw new NotFoundException('No business application found.');
    if (!EDITABLE.includes(business.status)) {
      throw new ConflictException(
        'This application has already been submitted.',
      );
    }

    const missing = this.missingRequirements(business);
    if (missing.length) {
      throw new BadRequestException({
        message: 'Business application is incomplete.',
        missing,
      });
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Guarded transition so double-taps cannot create two submissions.
      const res = await tx.businesses.updateMany({
        where: { id: business.id, status: { in: EDITABLE } },
        data: { status: 'under_review', submitted_at: now, review_notes: null },
      });
      if (res.count !== 1)
        throw new ConflictException(
          'This application has already been submitted.',
        );
      await tx.business_verifications.create({
        data: {
          business_id: business.id,
          status: 'under_review',
          submitted_at: now,
          snapshot: this.snapshot(business),
        },
      });
      return tx.businesses.findUniqueOrThrow({
        where: { id: business.id },
        include: DETAIL_INCLUDE,
      });
    });
    await this.audit(userId, 'business.submitted', business.id);
    return {
      data: this.ownerView(this.serialize(updated)),
      message: 'Submitted for review.',
    };
  }

  // ---------------------------------------------------------------- admin

  async adminList(query: { status?: string; page?: any; limit?: any }) {
    const { page, limit, skip } = paginationParams(query.page, query.limit);
    const statuses: BusinessStatus[] = [
      'draft',
      'under_review',
      'more_information_required',
      'approved',
      'rejected',
    ];
    if (query.status && !statuses.includes(query.status as BusinessStatus)) {
      throw new BadRequestException('Unknown status filter.');
    }
    const where = query.status
      ? { status: query.status as BusinessStatus }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.businesses.findMany({
        where,
        orderBy: [{ submitted_at: 'desc' }, { created_at: 'desc' }],
        skip,
        take: limit,
        include: {
          owner: {
            select: {
              id: true,
              username: true,
              first_name: true,
              last_name: true,
              kyc_status: true,
            },
          },
        },
      }),
      this.prisma.businesses.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.serialize(r)),
      meta: paginate(total, page, limit),
    };
  }

  async adminGet(id: string) {
    const business = await this.prisma.businesses.findUnique({
      where: { id },
      include: {
        ...DETAIL_INCLUDE,
        owner: {
          select: {
            id: true,
            username: true,
            first_name: true,
            last_name: true,
            email: true,
            phone: true,
            kyc_status: true,
          },
        },
        merchant: { select: { id: true, status: true, business_name: true } },
      },
    });
    if (!business) throw new NotFoundException('Business not found.');
    const out = this.serialize(business);
    // Advisory Didit KYB result for the reviewer. Never auto-approves.
    out.didit_kyb = {
      session_id: business.didit_kyb_session_id ?? null,
      status: business.didit_kyb_status ?? 'none',
      entity_status: business.didit_kyb_entity_status ?? null,
      updated_at: business.didit_kyb_updated_at ?? null,
      result: business.didit_kyb_result ?? null,
    };
    return { data: out };
  }

  async adminReview(adminId: string, id: string, dto: ReviewBusinessDto) {
    if (process.env.MANUAL_KYB_ENABLED !== 'true') {
      throw new ForbiddenException(
        'Manual KYB decisions are disabled. Business status follows the Didit workflow.',
      );
    }
    const business = await this.prisma.businesses.findUnique({ where: { id } });
    if (!business) throw new NotFoundException('Business not found.');
    if (business.status !== 'under_review') {
      throw new ConflictException(
        'Only applications under review can be decided.',
      );
    }
    if (business.owner_user_id === adminId) {
      throw new ForbiddenException('You cannot review your own business.');
    }
    if (dto.decision !== 'approve' && !dto.notes?.trim()) {
      throw new BadRequestException(
        'A reason is required when requesting information or rejecting.',
      );
    }

    const next: BusinessStatus =
      dto.decision === 'approve'
        ? 'approved'
        : dto.decision === 'reject'
          ? 'rejected'
          : 'more_information_required';
    const now = new Date();
    const notes = dto.notes?.trim() || null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.businesses.updateMany({
        where: { id, status: 'under_review' },
        data: {
          status: next,
          reviewed_by: adminId,
          reviewed_at: now,
          review_notes: notes,
          ...(next === 'approved' ? { approved_at: now } : {}),
        },
      });
      if (res.count !== 1)
        throw new ConflictException('This application was already decided.');
      const latest = await tx.business_verifications.findFirst({
        where: { business_id: id, reviewed_at: null },
        orderBy: { submitted_at: 'desc' },
      });
      if (latest) {
        await tx.business_verifications.update({
          where: { id: latest.id },
          data: {
            status: next,
            reviewed_by: adminId,
            reviewed_at: now,
            decision_notes: notes,
          },
        });
      }
      await tx.notifications.create({
        data: {
          user_id: business.owner_user_id,
          type: 'merchant',
          title: 'Business verification update',
          body:
            next === 'approved'
              ? 'Your business account has been approved.'
              : next === 'rejected'
                ? 'Your business application was not approved.'
                : 'More information is needed for your business application.',
          metadata: {
            kind: 'business_verification',
            business_id: id,
            status: next,
          },
        },
      });
      return tx.businesses.findUniqueOrThrow({
        where: { id },
        include: DETAIL_INCLUDE,
      });
    });
    await this.audit(adminId, `business.review.${dto.decision}`, id);
    return {
      data: this.serialize(updated),
      message: `Business ${next.replace(/_/g, ' ')}.`,
    };
  }

  // ---------------------------------------------------------------- helpers

  missingRequirements(b: any): string[] {
    const missing: string[] = [];
    const required = [
      'legal_name',
      'registration_number',
      'registration_country',
      'sector',
      'country',
      'address',
      'business_email',
      'business_phone',
    ];
    for (const key of required)
      if (!String(b[key] ?? '').trim()) missing.push(key);
    const persons = b.persons ?? [];
    if (!persons.some((p: any) => p.role === 'director'))
      missing.push('directors');
    if (!persons.some((p: any) => p.role === 'beneficial_owner'))
      missing.push('beneficial_owners');
    const docTypes = new Set((b.documents ?? []).map((d: any) => d.doc_type));
    for (const t of REQUIRED_DOCUMENT_TYPES)
      if (!docTypes.has(t)) missing.push(`document:${t}`);
    return missing;
  }

  private eligibility(merchant: { status: any } | null, business: any) {
    if (business) return { can_upgrade: false, reason: 'exists' };
    if (!merchant) return { can_upgrade: false, reason: 'merchant_required' };
    if (merchant.status !== 'approved')
      return { can_upgrade: false, reason: 'merchant_not_approved' };
    return { can_upgrade: true, reason: null };
  }

  private async requireOwned(userId: string) {
    const business = await this.prisma.businesses.findUnique({
      where: { owner_user_id: userId },
    });
    if (!business)
      throw new NotFoundException(
        'No business application found. Start the upgrade first.',
      );
    return business;
  }

  /** Owners see their KYB status but not the raw provider payload. */
  private ownerView(b: any) {
    const out = { ...b };
    delete out.didit_kyb_result;
    return out;
  }

  private snapshot(b: any) {
    const rest = { ...b };
    delete rest.verifications;
    delete rest.owner;
    delete rest.merchant;
    return JSON.parse(JSON.stringify(rest));
  }

  private serialize(b: any) {
    const out: any = { ...b };
    if (Array.isArray(out.persons)) {
      out.persons = out.persons.map((p: any) => ({
        ...p,
        ownership_percent:
          p.ownership_percent == null ? null : Number(p.ownership_percent),
      }));
    }
    if (Array.isArray(out.verifications)) {
      out.verifications = out.verifications.map((v: any) => {
        const copy = { ...v };
        delete copy.snapshot;
        return copy;
      });
    }
    if (EDITABLE.includes(out.status) && out.persons && out.documents) {
      out.missing = this.missingRequirements(out);
    }
    return out;
  }

  private async audit(userId: string, action: string, businessId: string) {
    try {
      await this.prisma.audit_logs.create({
        data: {
          user_id: userId,
          action,
          entity_type: 'business',
          entity_id: businessId,
        } as any,
      });
    } catch (e: any) {
      this.logger.warn(`audit log failed for ${action}: ${e?.message}`);
    }
  }
}
