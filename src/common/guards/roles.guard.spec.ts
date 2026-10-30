import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RolesGuard } from './roles.guard';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { PrismaService } from '../../database/prisma.service';

describe('RolesGuard', () => {
  it('denies an admin role on a superadmin-only route', async () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === 'roles') return ['super_admin'];
        return undefined;
      }),
    } as unknown as Reflector;
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'admin-1', role: 'admin' }),
    } as unknown as JwtService;
    const configService = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as unknown as ConfigService;
    const guard = new RolesGuard(reflector, jwtService, configService);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer token' },
          user: { id: 'admin-1', role: 'admin' },
          body: {},
          params: {},
          query: {},
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Insufficient role permissions',
    );
  });

  it('allows merchant-read access for a regular user who already has a merchant account', async () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === PERMISSIONS_KEY) return ['merchant:read'];
        return undefined;
      }),
    } as unknown as Reflector;

    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1', role: 'user' }),
    } as unknown as JwtService;

    const configService = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as unknown as ConfigService;

    const prisma = {
      merchants: {
        findFirst: jest.fn().mockResolvedValue({ id: 'merchant-1' }),
      },
    } as unknown as PrismaService;

    const guard = new RolesGuard(reflector, jwtService, configService, prisma);

    const req: any = {
      headers: { authorization: 'Bearer test-token' },
      user: { id: 'user-1', role: 'user' },
      body: {},
      params: {},
      query: {},
    };

    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects when JwtGuard has not populated req.user', async () => {
    const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
    const guard = new RolesGuard(reflector, {} as JwtService, {} as ConfigService);
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer forged' } }) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toThrow('Authentication token is required');
  });
});
