import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from '../auth/auth.service';
import { BusinessAccessService } from './business-access.service';
import { assignableRoles, BusinessRole, permissionsFor } from './permissions';
import { AddMemberDto, ProfileDto, UpdateMemberDto } from './business-ops.dto';

const userSelect = {
  id: true,
  username: true,
  first_name: true,
  last_name: true,
  phone: true,
  email: true,
} as const;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function presentUser(user: any) {
  if (!user) return null;
  return {
    ...user,
    full_name: [user.first_name, user.last_name].filter(Boolean).join(' '),
  };
}

/** Kenya-first E.164. Other digit strings keep a leading plus. */
export function normalizeTeamPhone(phone?: string | null) {
  if (!phone) return '';
  const digits = phone.toString().replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length === 10)
    return `+254${digits.slice(1)}`;
  if (digits.startsWith('254') && digits.length === 12) return `+${digits}`;
  return `+${digits}`;
}

function phoneLookup(phone: string) {
  const norm = normalizeTeamPhone(phone);
  const digits = norm.replace(/\D/g, '');
  const local =
    digits.startsWith('254') && digits.length === 12
      ? `0${digits.slice(3)}`
      : '';
  return [...new Set([norm, digits, local].filter(Boolean))];
}

@Injectable()
export class BusinessTeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly auth: AuthService,
  ) {}

  async list(userId: string) {
    const a = await this.access.resolve(userId, 'team:read');
    const [owner, members] = await Promise.all([
      this.prisma.users.findUnique({
        where: { id: a.business.owner_user_id },
        select: userSelect,
      }),
      this.prisma.business_members.findMany({
        where: { business_id: a.business.id, is_active: true },
        include: { user: { select: userSelect } },
        orderBy: { created_at: 'asc' },
      }),
    ]);
    return {
      data: [
        {
          id: null,
          role: 'owner',
          user: presentUser(owner),
          permissions: permissionsFor('owner'),
        },
        ...members.map((m) => ({
          id: m.id,
          role: m.role,
          user: presentUser(m.user),
          created_at: m.created_at,
          permissions: permissionsFor(m.role),
        })),
      ],
      invites: await this.pendingInvites(a.business.id),
      meta: { my_role: a.role, assignable_roles: assignableRoles(a.role) },
    };
  }

  private async pendingInvites(businessId: string) {
    const rows = await this.prisma.business_invites.findMany({
      where: {
        business_id: businessId,
        status: 'pending',
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((row) => this.inviteView(row));
  }

  private inviteView(row: any) {
    return {
      id: row.id,
      phone: row.phone,
      role: row.role,
      status: row.status,
      user_id: row.user_id,
      expires_at: row.expires_at,
      created_at: row.created_at,
      permissions: permissionsFor(row.role),
    };
  }

  /** Invite by phone. The person is not a member until they accept. */
  async invite(
    userId: string,
    dto: { phone: string; role: string; pin: string },
  ) {
    const a = await this.access.resolve(userId, 'team:manage');
    this.assertAssignable(a.role, dto.role as BusinessRole);
    await this.auth.verifyPin(userId, dto.pin);
    const phone = normalizeTeamPhone(dto.phone);
    if (!/^\+\d{8,15}$/.test(phone)) {
      throw new BadRequestException('Enter a valid phone number');
    }
    const target = await this.prisma.users.findFirst({
      where: { phone: { in: phoneLookup(phone) }, is_deleted: false },
      select: { id: true, is_active: true },
    });
    if (target && !target.is_active) {
      throw new BadRequestException('That account is inactive');
    }
    if (target?.id === a.business.owner_user_id) {
      throw new BadRequestException('The owner is already on the team');
    }
    if (target) {
      const existing = await this.prisma.business_members.findUnique({
        where: {
          business_id_user_id: {
            business_id: a.business.id,
            user_id: target.id,
          },
        },
      });
      if (existing?.is_active) {
        throw new ConflictException('This user is already a team member');
      }
    }
    const pending = await this.prisma.business_invites.findFirst({
      where: {
        business_id: a.business.id,
        phone,
        status: 'pending',
        expires_at: { gt: new Date() },
      },
    });
    const data = {
      role: dto.role as any,
      invited_by: userId,
      user_id: target?.id ?? null,
      expires_at: new Date(Date.now() + INVITE_TTL_MS),
    };
    const invite = pending
      ? await this.prisma.business_invites.update({
          where: { id: pending.id },
          data,
        })
      : await this.prisma.business_invites.create({
          data: {
            business_id: a.business.id,
            phone,
            status: 'pending',
            ...data,
          },
        });
    if (target) {
      await this.prisma.notifications.create({
        data: {
          user_id: target.id,
          type: 'merchant',
          title: 'Business team invitation',
          body: `${a.business.trading_name || a.business.legal_name} invited you to join as ${dto.role}. Open FARM to accept.`,
        } as any,
      });
    }
    await this.audit(userId, 'business.member_invited', a.business.id, {
      invite_id: invite.id,
      role: dto.role,
    });
    return {
      data: this.inviteView(invite),
      message: target
        ? 'Invitation sent'
        : 'Invitation saved. They can accept after they join FARM with this phone.',
    };
  }

  async revokeInvite(userId: string, inviteId: string) {
    const a = await this.access.resolve(userId, 'team:manage');
    const row = await this.prisma.business_invites.findFirst({
      where: { id: inviteId, business_id: a.business.id, status: 'pending' },
    });
    if (!row) throw new NotFoundException('Invitation not found');
    await this.prisma.business_invites.update({
      where: { id: row.id },
      data: { status: 'revoked' },
    });
    await this.audit(userId, 'business.invite_revoked', a.business.id, {
      invite_id: row.id,
    });
    return { message: 'Invitation revoked' };
  }

  /** Invitations addressed to the signed-in user's phone. */
  async myInvites(userId: string) {
    const me = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    const phones = phoneLookup(me?.phone ?? '');
    if (!phones.length) return { data: [] };
    const rows = await this.prisma.business_invites.findMany({
      where: {
        phone: { in: phones },
        status: 'pending',
        expires_at: { gt: new Date() },
      },
      include: {
        business: {
          select: { id: true, legal_name: true, trading_name: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    return {
      data: rows.map((row) => ({
        ...this.inviteView(row),
        business: {
          id: row.business.id,
          name: row.business.trading_name || row.business.legal_name,
        },
      })),
    };
  }

  async accept(userId: string, inviteId: string) {
    const me = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, is_active: true, is_deleted: true },
    });
    if (!me || me.is_deleted || !me.is_active) {
      throw new ForbiddenException('Account is unavailable');
    }
    const phones = phoneLookup(me.phone);
    const invite = await this.prisma.business_invites.findFirst({
      where: { id: inviteId, status: 'pending' },
      include: {
        business: {
          select: {
            id: true,
            owner_user_id: true,
            trading_name: true,
            legal_name: true,
          },
        },
      },
    });
    if (!invite || !phones.includes(invite.phone)) {
      throw new NotFoundException('Invitation not found');
    }
    if (invite.expires_at <= new Date()) {
      throw new BadRequestException('This invitation has expired');
    }
    if (me.id === invite.business.owner_user_id) {
      throw new BadRequestException('The owner is already on the team');
    }
    const member = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.business_invites.updateMany({
        where: {
          id: invite.id,
          status: 'pending',
          expires_at: { gt: new Date() },
        },
        data: { status: 'accepted', accepted_at: new Date(), user_id: me.id },
      });
      if (!claimed.count) {
        throw new BadRequestException('This invitation is no longer open');
      }
      const existing = await tx.business_members.findUnique({
        where: {
          business_id_user_id: {
            business_id: invite.business_id,
            user_id: me.id,
          },
        },
      });
      if (existing?.is_active) return existing;
      return existing
        ? tx.business_members.update({
            where: { id: existing.id },
            data: {
              is_active: true,
              role: invite.role,
              invited_by: invite.invited_by,
            },
          })
        : tx.business_members.create({
            data: {
              business_id: invite.business_id,
              user_id: me.id,
              role: invite.role,
              invited_by: invite.invited_by,
            },
          });
    });
    await this.audit(userId, 'business.member_accepted', invite.business_id, {
      invite_id: invite.id,
      member_id: member.id,
      role: invite.role,
    });
    return {
      data: {
        id: member.id,
        role: member.role,
        business_id: invite.business_id,
        permissions: permissionsFor(member.role),
      },
      message: 'You joined the business team',
    };
  }

  async decline(userId: string, inviteId: string) {
    const me = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    const phones = phoneLookup(me?.phone ?? '');
    const invite = await this.prisma.business_invites.findFirst({
      where: { id: inviteId, status: 'pending', phone: { in: phones } },
    });
    if (!invite) throw new NotFoundException('Invitation not found');
    await this.prisma.business_invites.update({
      where: { id: invite.id },
      data: { status: 'declined' },
    });
    return { message: 'Invitation declined' };
  }

  async add(userId: string, dto: AddMemberDto) {
    const raw = dto.identifier.trim();
    const looksLikePhone =
      raw.startsWith('+') || /^0\d{8,}$/.test(raw) || /^254\d{8,}$/.test(raw);
    if (looksLikePhone) {
      return this.invite(userId, {
        phone: raw,
        role: dto.role,
        pin: dto.pin,
      });
    }
    const a = await this.access.resolve(userId, 'team:manage');
    this.assertAssignable(a.role, dto.role as BusinessRole);
    await this.auth.verifyPin(userId, dto.pin);
    const ident = dto.identifier.trim();
    const target = await this.prisma.users.findFirst({
      where: {
        OR: [{ username: ident }, { phone: ident }, { email: ident }],
        is_deleted: false,
        is_active: true,
      },
      select: { id: true },
    });
    if (!target)
      throw new NotFoundException(
        'No Farm user found with that username, phone or email',
      );
    if (target.id === a.business.owner_user_id)
      throw new BadRequestException('The owner is already on the team');
    const existing = await this.prisma.business_members.findUnique({
      where: {
        business_id_user_id: { business_id: a.business.id, user_id: target.id },
      },
    });
    if (existing?.is_active)
      throw new ConflictException('This user is already a team member');
    const member = existing
      ? await this.prisma.business_members.update({
          where: { id: existing.id },
          data: { is_active: true, role: dto.role as any, invited_by: userId },
        })
      : await this.prisma.business_members.create({
          data: {
            business_id: a.business.id,
            user_id: target.id,
            role: dto.role as any,
            invited_by: userId,
          },
        });
    await this.prisma.notifications.create({
      data: {
        user_id: target.id,
        type: 'merchant',
        title: 'Added to a business team',
        body: `You were added to ${a.business.trading_name || a.business.legal_name} as ${dto.role}.`,
      } as any,
    });
    await this.audit(userId, 'business.member_added', a.business.id, {
      member_id: member.id,
      role: dto.role,
    });
    return { data: member, message: 'Team member added' };
  }

  async update(userId: string, memberId: string, dto: UpdateMemberDto) {
    const a = await this.access.resolve(userId, 'team:manage');
    const m = await this.memberOf(a.business.id, memberId);
    this.assertAssignable(a.role, m.role);
    this.assertAssignable(a.role, dto.role as BusinessRole);
    if (m.user_id === userId)
      throw new ForbiddenException('You cannot change your own role');
    await this.auth.verifyPin(userId, dto.pin);
    const updated = await this.prisma.business_members.update({
      where: { id: m.id },
      data: { role: dto.role as any },
    });
    await this.audit(userId, 'business.member_role_changed', a.business.id, {
      member_id: m.id,
      from: m.role,
      to: dto.role,
    });
    return { data: updated, message: 'Role updated' };
  }

  async remove(userId: string, memberId: string, pin: string) {
    const a = await this.access.resolve(userId, 'team:manage');
    const m = await this.memberOf(a.business.id, memberId);
    if (m.user_id === userId)
      throw new ForbiddenException('You cannot remove yourself');
    this.assertAssignable(a.role, m.role);
    await this.auth.verifyPin(userId, pin);
    await this.prisma.business_members.update({
      where: { id: m.id },
      data: { is_active: false },
    });
    await this.audit(userId, 'business.member_removed', a.business.id, {
      member_id: m.id,
    });
    return { message: 'Team member removed' };
  }

  async getProfile(userId: string) {
    const a = await this.access.resolve(userId, 'profile:read');
    const b = await this.prisma.businesses.findUnique({
      where: { id: a.business.id },
      select: {
        id: true,
        legal_name: true,
        trading_name: true,
        registration_number: true,
        registration_country: true,
        business_type: true,
        sector: true,
        country: true,
        city: true,
        address: true,
        business_email: true,
        business_phone: true,
        website: true,
        description: true,
        status: true,
        approved_at: true,
      },
    });
    return {
      data: b,
      meta: { can_edit: a.role === 'owner' || a.role === 'admin' },
    };
  }

  /** Only contact/presentation fields are editable; legal fields need a new KYB review. */
  async updateProfile(userId: string, dto: ProfileDto) {
    const a = await this.access.resolve(userId, 'profile:manage');
    const data: Record<string, string> = {};
    for (const k of [
      'trading_name',
      'business_email',
      'business_phone',
      'website',
      'description',
      'address',
    ] as const) {
      if (dto[k] !== undefined) data[k] = dto[k].trim();
    }
    const b = await this.prisma.businesses.update({
      where: { id: a.business.id },
      data,
    });
    await this.audit(userId, 'business.profile_updated', a.business.id, {
      fields: Object.keys(data),
    });
    return { data: b, message: 'Profile updated' };
  }

  private assertAssignable(actor: BusinessRole, role: BusinessRole) {
    if (!assignableRoles(actor).includes(role))
      throw new ForbiddenException(`Your role cannot manage ${role} members`);
  }

  private async memberOf(businessId: string, memberId: string) {
    const m = await this.prisma.business_members.findFirst({
      where: { id: memberId, business_id: businessId, is_active: true },
    });
    if (!m) throw new NotFoundException('Team member not found');
    return m;
  }

  private async audit(
    userId: string,
    action: string,
    businessId: string,
    meta: object,
  ) {
    await this.prisma.audit_logs
      .create({
        data: {
          user_id: userId,
          action,
          entity_type: 'business',
          entity_id: businessId,
          new_values: meta,
        } as any,
      })
      .catch(() => undefined);
  }
}
