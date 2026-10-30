import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { OWNERSHIP_KEY, OwnershipConfig } from '../decorators/ownership.decorator';
import { UserRole } from '../enums';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prismaService?: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    // JwtGuard (passport-jwt + JwtStrategy) always runs before this guard and has
    // already verified the token and loaded the user's current role from the DB.
    // Re-verifying here and overwriting req.user would replace that fresh,
    // DB-checked identity with stale token claims, so we only normalize it.
    if (!request.user) {
      throw new UnauthorizedException('Authentication token is required');
    }
    const user = this.normalizeUser(request.user);
    request.user = user;

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredRoles && requiredRoles.length > 0) {
      const role = String(user?.role || 'user').toLowerCase();
      const allowed = requiredRoles.map((item) => String(item).toLowerCase());
      const privilegedRoleBypass =
        (role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN) &&
        !allowed.includes(UserRole.SUPER_ADMIN);
      if (!allowed.includes(role) && !privilegedRoleBypass) {
        throw new ForbiddenException('Insufficient role permissions');
      }
    }

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredPermissions && requiredPermissions.length > 0) {
      const role = String(user?.role || 'user').toLowerCase();
      if (role !== UserRole.ADMIN && role !== UserRole.SUPER_ADMIN) {
        const granted = await this.getEffectivePermissions(user, requiredPermissions);
        const missing = requiredPermissions.filter((permission) => !granted.includes(permission));
        if (missing.length > 0) {
          throw new ForbiddenException('Insufficient permissions');
        }
      }
    }

    const ownership = this.reflector.getAllAndOverride<OwnershipConfig>(OWNERSHIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (ownership) {
      const ownerId = this.resolveOwnerId(user, ownership);
      const resourceId = this.resolveResourceId(request, ownership);
      if (!ownerId || !resourceId || String(ownerId) !== String(resourceId)) {
        throw new ForbiddenException('Resource ownership check failed');
      }
    }

    return true;
  }

  private normalizeUser(payload: any) {
    const role = payload.role || payload.user_role || 'user';
    return {
      ...payload,
      id: payload.id || payload.sub || payload.userId,
      userId: payload.id || payload.sub || payload.userId,
      role: String(role).toLowerCase(),
    };
  }

  private getPermissionsForRole(role: string): string[] {
    const normalizedRole = String(role).toLowerCase();

    const basePermissions = [
      'profile:read',
      'profile:write',
      'wallet:read',
      'wallet:write',
      'payments:read',
      'payments:write',
      'transactions:read',
      'transfer:read',
      'transfer:write',
      'escrow:read',
      'escrow:write',
      'withdraw:read',
      'withdraw:write',
      'kyc:read',
      'kyc:write',
      'sessions:read',
      'sessions:write',
      'auth:write',
      'notifications:read',
      'notifications:write',
      'security:read',
      'security:write',
      'settings:read',
      'settings:write',
      'analytics:read',
      'investments:read',
      'investments:write',
      'projects:read',
      'projects:write',
      'qr:read',
      'qr:write',
    ];

    switch (normalizedRole) {
      case String(UserRole.SUPER_ADMIN).toLowerCase():
      case String(UserRole.ADMIN).toLowerCase():
        return ['*', ...basePermissions, 'admin:read', 'admin:write', 'audit:read', 'audit:write', 'superadmin:read', 'superadmin:write'];
      case String(UserRole.MERCHANT).toLowerCase():
        return [
          ...basePermissions,
          'merchant:read',
          'merchant:write',
          'payments:read',
          'payments:write',
        ];
      default:
        return basePermissions;
    }
  }

  private async getEffectivePermissions(user: any, requiredPermissions: string[]): Promise<string[]> {
    const granted = this.getPermissionsForRole(String(user?.role || 'user').toLowerCase());
    if (requiredPermissions.some((permission) => permission.startsWith('merchant:')) && await this.userHasMerchantRecord(user?.id || user?.userId)) {
      return [...new Set([...granted, 'merchant:read', 'merchant:write'])];
    }
    return granted;
  }

  private async userHasMerchantRecord(userId?: string): Promise<boolean> {
    if (!userId || !this.prismaService) {
      return false;
    }

    const merchant = await this.prismaService.merchants.findFirst({
      where: { user_id: userId },
      select: { id: true },
    });

    return Boolean(merchant);
  }

  private resolveOwnerId(user: any, ownership: OwnershipConfig): string | null {
    const candidate = user?.[ownership.userProperty || 'id'] || user?.id || user?.sub || user?.userId;
    return candidate ? String(candidate) : null;
  }

  private resolveResourceId(request: any, ownership: OwnershipConfig): string | null {
    const source = ownership.source || 'params';
    const location = source === 'body'
      ? request.body
      : source === 'query'
        ? request.query
        : request.params;

    const value = location?.[ownership.param || 'id'];
    return value ? String(value) : null;
  }
}