import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CacheService } from '../common/cache/cache.service';
import { paginationParams, paginate } from '../common/utils/pagination.util';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  async getProfile(userId: string) {
    const cacheKey = `dashboard:${userId}`;
    const cached = await this.cache.cacheGet<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true, first_name: true, last_name: true, username: true,
        email: true, phone: true, role: true, kyc_status: true, kyc_level: true,
        phone_verified: true, email_verified: true, profile_image: true,
        bio: true, country: true, city: true, referral_code: true, created_at: true,
        wallets: { select: { wallet_address: true, balance: true, currency: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const payload = { data: user };
    await this.cache.cacheSet(cacheKey, payload, 60);
    return payload;
  }

  async updateProfile(userId: string, dto: {
    first_name?: string; last_name?: string;
    username?: string;
    bio?: string; country?: string; city?: string;
  }) {
    if (dto.username != null) {
      const normalized = dto.username.trim().toLowerCase();
      if (normalized.length < 3) {
        throw new BadRequestException('Username must be at least 3 characters');
      }
      const existing = await this.prisma.users.findFirst({
        where: {
          username: normalized,
          NOT: { id: userId },
        },
      });
      if (existing) {
        throw new ConflictException('Username taken');
      }
      dto.username = normalized;
    }

    const user = await this.prisma.users.update({
      where: { id: userId },
      data: dto,
      select: {
        id: true, first_name: true, last_name: true, username: true,
        bio: true, country: true, city: true, profile_image: true,
      },
    });

    await Promise.all([
      this.cache.cacheDelete(`dashboard:${userId}`),
      this.cache.cacheInvalidatePattern(`wallet:${userId}:balance`),
      this.cache.cacheInvalidatePattern(`transactions:${userId}:*`),
    ]);

    return { data: user, message: 'Profile updated' };
  }

  async searchUsers(query: string) {
    const normalized = (query ?? '').trim().toLowerCase();
    if (!normalized || normalized.length < 2) return { data: [] };

    const searchTerms = normalized.split(/\s+/).filter(Boolean);
    const searchValue = searchTerms.join(' ');

    const users = await this.prisma.users.findMany({
      where: {
        is_deleted: false,
        is_active: true,
        OR: [
          { username: { contains: searchValue, mode: 'insensitive' } },
          { phone: { contains: searchValue } },
          { first_name: { contains: searchValue, mode: 'insensitive' } },
          { last_name: { contains: searchValue, mode: 'insensitive' } },
          {
            AND: searchTerms.slice(1).map((term) => ({
              OR: [
                { first_name: { contains: term, mode: 'insensitive' } },
                { last_name: { contains: term, mode: 'insensitive' } },
                { username: { contains: term, mode: 'insensitive' } },
              ],
            })),
          },
        ],
      },
      select: {
        id: true,
        username: true,
        first_name: true,
        last_name: true,
        phone: true,
        profile_image: true,
        wallets: { select: { wallet_address: true }, take: 1 },
      },
      orderBy: [
        { username: 'asc' },
        { first_name: 'asc' },
      ],
      take: 10,
    });

    return { data: users };
  }

  async getContacts(userId: string) {
    const contacts = await this.prisma.contacts.findMany({
      where: { owner_id: userId },
      include: {
        users_contacts_contact_user_idTousers: {
          select: {
            id: true, username: true, first_name: true, last_name: true,
            profile_image: true,
            wallets: { select: { wallet_address: true }, take: 1 },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
    return { data: contacts };
  }

  async addContact(ownerId: string, identifier: string, nickname?: string) {
    const target = await this.prisma.users.findFirst({
      where: { OR: [{ username: identifier }, { phone: identifier }], is_deleted: false },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.id === ownerId) throw new ConflictException('Cannot add yourself as a contact');

    const exists = await this.prisma.contacts.findFirst({
      where: { owner_id: ownerId, contact_user_id: target.id },
    });
    if (exists) throw new ConflictException('Contact already added');

    const contact = await this.prisma.contacts.create({
      data: { owner_id: ownerId, contact_user_id: target.id, nickname },
    });
    return { data: contact, message: 'Contact added' };
  }

  async removeContact(ownerId: string, contactId: string) {
    await this.prisma.contacts.deleteMany({ where: { id: contactId, owner_id: ownerId } });
    return { message: 'Contact removed' };
  }

  async getNotifications(userId: string, query: any) {
    const { skip, take, page, limit } = paginationParams(query.page, query.limit);
    const [items, total] = await Promise.all([
      this.prisma.notifications.findMany({
        where: { user_id: userId }, skip, take, orderBy: { created_at: 'desc' },
      }),
      this.prisma.notifications.count({ where: { user_id: userId } }),
    ]);
    return { data: items, meta: paginate(total, page, limit) };
  }

  async markNotificationRead(userId: string, notifId: string) {
    await this.prisma.notifications.updateMany({
      where: { id: notifId, user_id: userId }, data: { is_read: true },
    });
    return { message: 'Notification marked as read' };
  }

  async markAllNotificationsRead(userId: string) {
    await this.prisma.notifications.updateMany({
      where: { user_id: userId, is_read: false }, data: { is_read: true },
    });
    return { message: 'All notifications marked as read' };
  }

  async deleteNotification(userId: string, notifId: string) {
    const result = await this.prisma.notifications.deleteMany({
      where: { id: notifId, user_id: userId },
    });
    if (result.count === 0) {
      throw new NotFoundException('Notification not found');
    }
    return { message: 'Notification deleted' };
  }

  async deleteAllNotifications(userId: string) {
    const result = await this.prisma.notifications.deleteMany({
      where: { user_id: userId },
    });
    return { message: 'All notifications deleted', deletedCount: result.count };
  }

  async changeEmail(userId: string, dto: { new_email: string; current_password: string }) {
    // Validate new email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(dto.new_email)) {
      throw new BadRequestException('Invalid email format');
    }

    // Check if new email already exists
    const existingUser = await this.prisma.users.findFirst({
      where: { email: dto.new_email, is_deleted: false },
    });
    if (existingUser && existingUser.id !== userId) {
      throw new ConflictException('Email already in use');
    }

    // Verify current password
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const passwordMatches = await bcrypt.compare(dto.current_password, user.password_hash);
    if (!passwordMatches) {
      throw new BadRequestException('Incorrect current password');
    }

    // Update email
    const updated = await this.prisma.users.update({
      where: { id: userId },
      data: { email: dto.new_email, email_verified: false },
      select: { id: true, email: true, email_verified: true },
    });

    return { data: updated, message: 'Email updated successfully. Please verify your new email.' };
  }

  async changePhone(userId: string, dto: { new_phone: string; current_password: string }) {
    // Validate phone format (basic: digits, +, and hyphens)
    const phoneRegex = /^[\d+\-() ]{7,20}$/;
    if (!phoneRegex.test(dto.new_phone)) {
      throw new BadRequestException('Invalid phone number format');
    }

    // Check if new phone already exists
    const existingUser = await this.prisma.users.findFirst({
      where: { phone: dto.new_phone, is_deleted: false },
    });
    if (existingUser && existingUser.id !== userId) {
      throw new ConflictException('Phone number already in use');
    }

    // Verify current password
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const passwordMatches = await bcrypt.compare(dto.current_password, user.password_hash);
    if (!passwordMatches) {
      throw new BadRequestException('Incorrect current password');
    }

    // Update phone
    const updated = await this.prisma.users.update({
      where: { id: userId },
      data: { phone: dto.new_phone, phone_verified: false },
      select: { id: true, phone: true, phone_verified: true },
    });

    return { data: updated, message: 'Phone number updated successfully. Please verify your new phone.' };
  }
}