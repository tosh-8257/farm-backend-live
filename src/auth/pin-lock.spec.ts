import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('verifyPin attempt slot', () => {
  function build(claimed: number) {
    const prisma: any = {
      users: {
        findUnique: jest.fn().mockResolvedValue({
          pin_hash: bcrypt.hashSync('1234', 4),
          failed_pin_attempts: 0,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      $executeRaw: jest.fn().mockResolvedValue(claimed),
    };
    const svc = new AuthService(
      prisma,
      {} as any,
      { get: () => undefined } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { svc, prisma };
  }

  it('locks without comparing when no attempt slot is left', async () => {
    const { svc, prisma } = build(0);
    await expect(svc.verifyPin('user-1', '1234')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.users.update).not.toHaveBeenCalled();
  });

  it('rejects a wrong PIN after consuming one slot', async () => {
    const { svc } = build(1);
    await expect(svc.verifyPin('user-1', '0000')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
