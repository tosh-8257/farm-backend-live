import { BadRequestException } from '@nestjs/common';
import { SecurityController } from './security.controller';

describe('biometric enrollment', () => {
  it('requires the account PIN before a fingerprint can skip the PIN on send', async () => {
    const security = {
      enableBiometrics: jest.fn().mockResolvedValue({ ok: true }),
    };
    const auth = { verifyPin: jest.fn().mockResolvedValue(undefined) };
    const controller = new SecurityController(security as any, auth as any);

    await expect(
      controller.createBiometrics(
        { id: 'user-1' } as any,
        {
          deviceFingerprint: 'device-a',
        } as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(security.enableBiometrics).not.toHaveBeenCalled();

    await controller.createBiometrics({ id: 'user-1' } as any, {
      deviceFingerprint: 'device-a',
      pin: '1234',
    });
    expect(auth.verifyPin).toHaveBeenCalledWith('user-1', '1234');
    expect(security.enableBiometrics).toHaveBeenCalledWith(
      'user-1',
      'device-a',
      undefined,
    );
  });
});
