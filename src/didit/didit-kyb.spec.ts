import { createHmac } from 'node:crypto';
import {
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import {
  canonicalizeDiditPayload,
  diditTimestampSeconds,
  DiditService,
  flattenDiditPayload,
  isDiditKybEvent,
  normalizeDiditStatus,
} from './didit.service';

const secret = 'didit-test-webhook-secret';
const BUSINESS_ID = 'b0a80101-0000-4000-8000-0000000000b1';
const USER_ID = 'c0a80101-0000-4000-8000-000000000001';

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function sign(payload: unknown) {
  return createHmac('sha256', secret)
    .update(canonicalizeDiditPayload(payload), 'utf8')
    .digest('hex');
}

function webhookHarness(business: Record<string, unknown> | null) {
  const tx = {
    didit_webhook_events: { create: jest.fn().mockResolvedValue({}) },
    users: { updateMany: jest.fn() },
    businesses: {
      findUnique: jest.fn().mockResolvedValue(business),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  const service = new DiditService(
    config({ DIDIT_WEBHOOK_SECRET: secret }),
    prisma,
  );
  return { tx, service };
}

describe('Didit KYB helpers', () => {
  it('normalises session status labels', () => {
    expect(normalizeDiditStatus('Approved')).toBe('approved');
    expect(normalizeDiditStatus('IN_REVIEW')).toBe('in_review');
    expect(normalizeDiditStatus('In Review')).toBe('in_review');
    expect(normalizeDiditStatus(5)).toBeUndefined();
    expect(normalizeDiditStatus('<script>')).toBeUndefined();
  });

  it('accepts unix and ISO timestamps', () => {
    expect(diditTimestampSeconds(1774970000)).toBe(1774970000);
    expect(diditTimestampSeconds('1774970000')).toBe(1774970000);
    expect(diditTimestampSeconds('2026-04-18T12:30:00Z')).toBe(1776515400);
    expect(diditTimestampSeconds('nope')).toBeNaN();
  });

  it('detects KYB events in flat and nested envelopes', () => {
    expect(
      isDiditKybEvent(
        flattenDiditPayload({ webhook_type: 'business.status.updated' }),
      ),
    ).toBe(true);
    expect(
      isDiditKybEvent(
        flattenDiditPayload({
          event: 'status.updated',
          data: { session_kind: 'business' },
        }),
      ),
    ).toBe(true);
    expect(
      isDiditKybEvent(flattenDiditPayload({ webhook_type: 'status.updated' })),
    ).toBe(false);
  });
});

describe('DiditService.createKybSession', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns 503 and calls nothing when DIDIT_KYB_WORKFLOW_ID is unset', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const findUnique = jest.fn();
    const service = new DiditService(config({ DIDIT_API_KEY: 'k' }), {
      businesses: { findUnique },
    } as unknown as PrismaService);
    await expect(service.createKybSession(USER_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('creates a session with the KYB workflow and business id as vendor_data', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        url: 'https://verify.didit.me/session/kyb',
        session_id: 'kyb-session-1',
      }),
    } as Response);
    const update = jest.fn().mockResolvedValue({});
    const service = new DiditService(
      config({ DIDIT_API_KEY: 'k', DIDIT_KYB_WORKFLOW_ID: 'wf-kyb' }),
      {
        businesses: {
          findUnique: jest.fn().mockResolvedValue({
            id: BUSINESS_ID,
            status: 'draft',
            didit_kyb_status: null,
          }),
          update,
        },
      } as unknown as PrismaService,
    );

    await expect(service.createKybSession(USER_ID)).resolves.toEqual({
      url: 'https://verify.didit.me/session/kyb',
      session_id: 'kyb-session-1',
    });
    const body = JSON.parse(
      (fetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ workflow_id: 'wf-kyb', vendor_data: BUSINESS_ID });
    expect(update).toHaveBeenCalledWith({
      where: { id: BUSINESS_ID },
      data: expect.objectContaining({
        didit_kyb_session_id: 'kyb-session-1',
        didit_kyb_status: 'not_started',
      }),
    });
    // Never touches the manual review status.
    expect(update.mock.calls[0][0].data.status).toBeUndefined();
  });

  it.each(['approved', 'in_review'])(
    'refuses to restart when Didit KYB is %s',
    async (kyb) => {
      const fetch = jest.spyOn(global, 'fetch');
      const service = new DiditService(
        config({ DIDIT_API_KEY: 'k', DIDIT_KYB_WORKFLOW_ID: 'wf' }),
        {
          businesses: {
            findUnique: jest.fn().mockResolvedValue({
              id: BUSINESS_ID,
              status: 'draft',
              didit_kyb_status: kyb,
            }),
          },
        } as unknown as PrismaService,
      );
      await expect(service.createKybSession(USER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('refuses an already approved business', async () => {
    const service = new DiditService(
      config({ DIDIT_API_KEY: 'k', DIDIT_KYB_WORKFLOW_ID: 'wf' }),
      {
        businesses: {
          findUnique: jest.fn().mockResolvedValue({
            id: BUSINESS_ID,
            status: 'approved',
            didit_kyb_status: null,
          }),
        },
      } as unknown as PrismaService,
    );
    await expect(service.createKybSession(USER_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('DiditService KYB webhooks', () => {
  const base = () => ({
    event_id: `evt-${Math.random()}`,
    timestamp: Math.floor(Date.now() / 1000),
  });

  it('approves the business when Didit KYB is approved', async () => {
    const { tx, service } = webhookHarness({
      id: BUSINESS_ID,
      didit_kyb_session_id: 'kyb-session-1',
      status: 'draft',
      owner_user_id: USER_ID,
    });
    const payload = {
      ...base(),
      webhook_type: 'status.updated',
      session_kind: 'business',
      session_id: 'kyb-session-1',
      vendor_data: BUSINESS_ID,
      status: 'Approved',
      decision: { registry_checks: [{ status: 'Approved' }] },
    };
    await service.processWebhook(payload, sign(payload));

    const data = tx.businesses.update.mock.calls[0][0].data;
    expect(data.didit_kyb_status).toBe('approved');
    expect(data.didit_kyb_result.decision).toEqual(payload.decision);
    expect(data.status).toBe('approved');
    expect(data.approved_at).toBeInstanceOf(Date);
    expect(tx.users.updateMany).not.toHaveBeenCalled();
  });

  it('handles the nested envelope with an ISO timestamp', async () => {
    const { tx, service } = webhookHarness({
      id: BUSINESS_ID,
      didit_kyb_session_id: 'bs-1',
    });
    const payload = {
      event: 'status.updated',
      event_id: 'evt-nested',
      timestamp: new Date().toISOString(),
      data: {
        session_id: 'bs-1',
        session_kind: 'business',
        vendor_data: BUSINESS_ID,
        status: 'DECLINED',
      },
    };
    await service.processWebhook(payload, sign(payload));
    expect(tx.businesses.update.mock.calls[0][0].data.didit_kyb_status).toBe(
      'declined',
    );
  });

  it('records business.status.updated as the entity status', async () => {
    const { tx, service } = webhookHarness({
      id: BUSINESS_ID,
      didit_kyb_session_id: 'kyb-session-1',
    });
    const payload = {
      ...base(),
      webhook_type: 'business.status.updated',
      vendor_data: BUSINESS_ID,
      status: 'FLAGGED',
      previous_status: 'ACTIVE',
    };
    await service.processWebhook(payload, sign(payload));
    const data = tx.businesses.update.mock.calls[0][0].data;
    expect(data.didit_kyb_entity_status).toBe('FLAGGED');
    expect(data.didit_kyb_status).toBeUndefined();
  });

  it('merges business.data.updated into the stored result', async () => {
    const { tx, service } = webhookHarness({
      id: BUSINESS_ID,
      didit_kyb_session_id: 'kyb-session-1',
    });
    tx.businesses.findUnique
      .mockResolvedValueOnce({ id: BUSINESS_ID, didit_kyb_session_id: 's' })
      .mockResolvedValueOnce({ didit_kyb_result: { decision: { a: 1 } } });
    const payload = {
      ...base(),
      webhook_type: 'business.data.updated',
      vendor_data: BUSINESS_ID,
      status: 'ACTIVE',
      legal_name: 'Acme Ltd',
    };
    await service.processWebhook(payload, sign(payload));
    const result = tx.businesses.update.mock.calls[0][0].data.didit_kyb_result;
    expect(result.decision).toEqual({ a: 1 });
    expect(result.business_entity.legal_name).toBe('Acme Ltd');
  });

  it('ignores a session event whose session id does not match the business', async () => {
    const { tx, service } = webhookHarness({
      id: BUSINESS_ID,
      didit_kyb_session_id: 'kyb-session-1',
    });
    const payload = {
      ...base(),
      webhook_type: 'status.updated',
      session_kind: 'business',
      session_id: 'someone-else',
      vendor_data: BUSINESS_ID,
      status: 'Approved',
    };
    await service.processWebhook(payload, sign(payload));
    expect(tx.didit_webhook_events.create).toHaveBeenCalled();
    expect(tx.businesses.update).not.toHaveBeenCalled();
  });

  it('rejects unsigned and stale KYB events', async () => {
    const { tx, service } = webhookHarness(null);
    const payload = {
      ...base(),
      webhook_type: 'business.status.updated',
      vendor_data: BUSINESS_ID,
      status: 'BLOCKED',
    };
    await expect(
      service.processWebhook(payload, 'a'.repeat(64)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const stale = { ...payload, timestamp: payload.timestamp - 3600 };
    await expect(
      service.processWebhook(stale, sign(stale)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.didit_webhook_events.create).not.toHaveBeenCalled();
  });

  it('treats a replayed KYB event id as an idempotent no-op', async () => {
    const { tx, service } = webhookHarness(null);
    tx.didit_webhook_events.create.mockRejectedValue({ code: 'P2002' });
    const payload = {
      ...base(),
      webhook_type: 'business.status.updated',
      vendor_data: BUSINESS_ID,
      status: 'ACTIVE',
    };
    await expect(
      service.processWebhook(payload, sign(payload)),
    ).resolves.toBeUndefined();
    expect(tx.businesses.update).not.toHaveBeenCalled();
  });
});
