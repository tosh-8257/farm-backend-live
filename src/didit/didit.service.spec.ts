import { createHmac } from 'node:crypto';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import {
  canonicalizeDiditPayload,
  DiditService,
  kycStatusForDiditStatus,
} from './didit.service';

describe('DiditService', () => {
  const secret = 'didit-test-webhook-secret';

  it('canonicalizes recursively sorted objects while preserving array order', () => {
    expect(
      canonicalizeDiditPayload({
        z: 1.0,
        a: [{ z: true, b: 'café' }, 2],
      }),
    ).toBe('{"a":[{"b":"café","z":true},2],"z":1}');
  });

  it.each([
    ['Not Started', 'pending'],
    ['In Progress', 'pending'],
    ['Awaiting User', 'pending'],
    ['In Review', 'under_review'],
    ['Approved', 'verified'],
    ['Declined', 'rejected'],
    ['Resubmitted', 'additional_info_required'],
    ['Abandoned', 'pending'],
    ['Expired', 'pending'],
    ['Kyc Expired', 'none'],
  ] as const)('maps exact status %s to %s', (status, expected) => {
    expect(kycStatusForDiditStatus(status)).toBe(expected);
  });

  it('does not normalize case-sensitive Didit statuses', () => {
    expect(kycStatusForDiditStatus('approved')).toBeUndefined();
  });

  it('creates a session with the code workflow and authenticated user ID', async () => {
    const userId = 'c0a80101-0000-4000-8000-000000000001';
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        url: 'https://verify.didit.me/session/example',
        session_id: 'didit-session-1',
        session_token: 'session-token',
      }),
    } as Response);
    const config = {
      get: jest.fn().mockReturnValue('test-api-key'),
    } as unknown as ConfigService;
    const service = new DiditService(config, {
      users: {
        findUnique: jest.fn().mockResolvedValue({ kyc_status: 'rejected' }),
      },
    } as unknown as PrismaService);

    await expect(service.createSession(userId)).resolves.toEqual({
      url: 'https://verify.didit.me/session/example',
      session_id: 'didit-session-1',
      session_token: 'session-token',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://verification.didit.me/v3/session/',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'x-api-key': 'test-api-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflow_id: '9d75ebb3-2dbe-410e-9062-5c84c41af087',
          vendor_data: userId,
        }),
      }),
    );
    fetch.mockRestore();
  });

  it('logs Didit rejection details without logging the API key', async () => {
    const apiKey = 'test-api-key-secret';
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        `{"detail":"callback domain rejected","debug":"${apiKey}"}`,
    } as Response);
    const config = {
      get: jest.fn().mockReturnValue(apiKey),
    } as unknown as ConfigService;
    const service = new DiditService(config, {
      users: {
        findUnique: jest.fn().mockResolvedValue({ kyc_status: 'none' }),
      },
    } as unknown as PrismaService);
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await expect(
      service.createSession('c0a80101-0000-4000-8000-000000000001'),
    ).rejects.toThrow(
      'Didit rejected the workflow or session configuration. Check that the configured workflow exists, is published, and is a KYC workflow in the same application as the API key.',
    );

    expect(errorLog).toHaveBeenCalledWith(
      'Didit session request returned HTTP 400: {"detail":"callback domain rejected","debug":"[redacted]"}',
    );
    fetch.mockRestore();
    errorLog.mockRestore();
  });

  it('verifies the signature and updates the authenticated user status', async () => {
    const userId = 'c0a80101-0000-4000-8000-000000000001';
    const payload = {
      event_id: 'didit-event-1',
      webhook_type: 'status.updated',
      timestamp: Date.now() / 1000,
      session_id: 'didit-session-1',
      vendor_data: userId,
      status: 'Approved',
      decision: { id_verifications: [{ node_id: 'identity', score: 1.0 }] },
    };
    const tx = {
      didit_webhook_events: { create: jest.fn().mockResolvedValue({}) },
      users: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      kyc_documents: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      kyc_identity_references: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn().mockReturnValue(secret),
    } as unknown as ConfigService;
    const service = new DiditService(config, prisma);
    const signature = createHmac('sha256', secret)
      .update(canonicalizeDiditPayload(payload), 'utf8')
      .digest('hex');

    await service.processWebhook(payload, signature);

    expect(tx.didit_webhook_events.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event_id: 'didit-event-1',
        status: 'Approved',
      }),
    });
    expect(tx.users.updateMany).toHaveBeenCalledWith({
      where: { id: userId },
      data: { kyc_status: 'verified' },
    });
    // Historical manual KYC rows are no longer rewritten by Didit events.
    expect(tx.kyc_documents.updateMany).not.toHaveBeenCalled();
    // First approved session becomes the device-recovery identity reference.
    expect(tx.kyc_identity_references.upsert).toHaveBeenCalledWith({
      where: { user_id: userId },
      create: { user_id: userId, didit_session_id: 'didit-session-1' },
      update: {},
    });
  });

  it('rejects invalid signatures and stale signed timestamps', async () => {
    const tx = {
      didit_webhook_events: { create: jest.fn() },
      users: { updateMany: jest.fn() },
      kyc_documents: { updateMany: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn().mockReturnValue(secret),
    } as unknown as ConfigService;
    const service = new DiditService(config, prisma);
    const payload = {
      event_id: 'didit-event-2',
      timestamp: Date.now() / 1000,
      status: 'Approved',
    };

    await expect(
      service.processWebhook(payload, '0'.repeat(64)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const stalePayload = { ...payload, timestamp: 1 };
    const staleSignature = createHmac('sha256', secret)
      .update(canonicalizeDiditPayload(stalePayload), 'utf8')
      .digest('hex');
    await expect(
      service.processWebhook(stalePayload, staleSignature),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.didit_webhook_events.create).not.toHaveBeenCalled();
  });

  it('treats a previously committed event ID as an idempotent retry', async () => {
    const tx = {
      didit_webhook_events: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
      },
      users: { updateMany: jest.fn() },
      kyc_documents: { updateMany: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn().mockReturnValue(secret),
    } as unknown as ConfigService;
    const service = new DiditService(config, prisma);
    const payload = {
      event_id: 'didit-event-duplicate',
      timestamp: Date.now() / 1000,
      vendor_data: 'c0a80101-0000-4000-8000-000000000001',
      status: 'Approved',
    };
    const signature = createHmac('sha256', secret)
      .update(canonicalizeDiditPayload(payload), 'utf8')
      .digest('hex');

    await expect(
      service.processWebhook(payload, signature),
    ).resolves.toBeUndefined();
    expect(tx.users.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a new Didit session for an already verified user', async () => {
    const config = { get: jest.fn().mockReturnValue('key') } as any;
    const prisma = {
      users: {
        findUnique: jest.fn().mockResolvedValue({ kyc_status: 'verified' }),
      },
    } as unknown as PrismaService;
    const service = new DiditService(config, prisma);
    await expect(service.createSession('u-1')).rejects.toThrow(
      'Identity is already verified',
    );
  });
});
