import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../../database/prisma.service';

export interface JwtPayload {
  sub: string;
  role: string;
  wallet_id?: string;
  jti: string;
}

import { requireJwtAccessSecret } from '../jwt-secret';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private cfg: ConfigService, private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireJwtAccessSecret(cfg),
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload) {
    const user = await this.prisma.users.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, is_active: true, is_suspended: true, is_deleted: true },
    });

    if (!user || !user.is_active || user.is_suspended || user.is_deleted)
      throw new UnauthorizedException('Account unavailable');

    // Check if the token's JTI is still valid (not revoked)
    if (payload.jti) {
      const session = await this.prisma.user_sessions.findFirst({
        where: {
          jwt_id: payload.jti,
          user_id: payload.sub,
          OR: [
            { is_revoked: false },
            { is_revoked: null },
          ],
        },
      });

      if (!session) {
        // Token has been revoked - possible theft
        await this.prisma.security_events.create({
          data: {
            user_id: payload.sub,
            event_type: 'REVOKED_TOKEN_USED',
            description: `Attempted use of revoked JWT token (JTI: ${payload.jti}) from IP ${req.ip || 'unknown'} UA: ${req.headers['user-agent'] || 'unknown'}`,
            severity: 'high',
          },
        });
        throw new UnauthorizedException('Token has been revoked');
      }
    }

    return { id: user.id, role: user.role, wallet_id: payload.wallet_id, jti: payload.jti };
  }
}