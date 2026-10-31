import {
  RecoveryOwnerMatchService,
  namesMatch,
  nameTokens,
  normalizeDocNumber,
} from './recovery-owner-match.service';

const USER = '11111111-1111-4111-8111-111111111111';
const REF = 'ref-session';
const NOW = 'recovery-session';

function idv(doc: string, name: string) {
  return {
    document_number: doc,
    full_name: name,
    portrait_image: 'https://media.example/portrait.jpg',
  };
}

function decisionBody(doc: string, name: string, live = true) {
  return {
    status: 'Approved',
    id_verifications: [idv(doc, name)],
    liveness_checks: live
      ? [{ reference_image: 'https://media.example/live.jpg' }]
      : [],
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function build(opts: {
  ref?: boolean;
  orig?: unknown;
  now?: unknown;
  face?: unknown;
  faceStatus?: number;
  threshold?: string;
}) {
  const prisma = {
    kyc_identity_references: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.ref === false ? null : { user_id: USER, didit_session_id: REF },
        ),
    },
    users: {
      findUnique: jest.fn().mockResolvedValue({
        first_name: 'Amani',
        last_name: 'Wanjiku',
        kyc_status: 'verified',
      }),
    },
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'DIDIT_API_KEY'
        ? 'test-key'
        : k === 'DEVICE_RECOVERY_FACE_MATCH_THRESHOLD'
          ? opts.threshold
          : undefined,
    ),
  };
  const fetchMock = jest
    .spyOn(global, 'fetch')
    .mockImplementation((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes(`/session/${REF}/decision/`)) {
        return Promise.resolve(
          json(opts.orig ?? decisionBody('A1234567', 'Amani Wanjiku')),
        );
      }
      if (url.includes(`/session/${NOW}/decision/`)) {
        return Promise.resolve(
          json(opts.now ?? decisionBody('a1234-567', 'AMANI WANJIKU')),
        );
      }
      if (url.includes('/v3/face-match/')) {
        return Promise.resolve(
          json(
            opts.face ?? { face_match: { status: 'Approved', score: 92.5 } },
            opts.faceStatus ?? 200,
          ),
        );
      }
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/jpeg' },
        }),
      );
    });
  const svc = new RecoveryOwnerMatchService(config as never, prisma as never);
  return { svc, fetchMock };
}

afterEach(() => jest.restoreAllMocks());

describe('owner-match helpers', () => {
  it('normalizes document numbers and names', () => {
    expect(normalizeDocNumber(' ab 12-345 ')).toBe('AB12345');
    expect(normalizeDocNumber('12')).toBeNull();
    expect(nameTokens('María  García-López')).toEqual([
      'maria',
      'garcia',
      'lopez',
    ]);
    expect(namesMatch(['amani'], ['amani', 'wanjiku'])).toBe(true);
    expect(namesMatch(['amani', 'otieno'], ['amani', 'wanjiku'])).toBe(false);
    expect(namesMatch([], ['x'])).toBe(false);
  });
});

describe('RecoveryOwnerMatchService', () => {
  it('matches when face, document and name all agree', async () => {
    const { svc, fetchMock } = build({});
    const r = await svc.check(USER, NOW);
    expect(r).toEqual({ matched: true, reasons: [], score: 92.5 });
    const faceCall = fetchMock.mock.calls.find(
      ([u]) => typeof u === 'string' && u.includes('/v3/face-match/'),
    );
    expect(faceCall).toBeDefined();
  });

  it('fails closed without an original KYC reference', async () => {
    const { svc, fetchMock } = build({ ref: false });
    const r = await svc.check(USER, NOW);
    expect(r.matched).toBe(false);
    expect(r.reasons).toEqual(['NO_KYC_REFERENCE']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails when the face score is below the threshold', async () => {
    const { svc } = build({
      face: { face_match: { status: 'Approved', score: 60 } },
    });
    const r = await svc.check(USER, NOW);
    expect(r.matched).toBe(false);
    expect(r.reasons).toContain('FACE_MATCH_BELOW_THRESHOLD');
    expect(r.score).toBe(60);
  });

  it('fails when Didit declines the face pair', async () => {
    const { svc } = build({
      face: { face_match: { status: 'Declined', score: null } },
    });
    expect((await svc.check(USER, NOW)).reasons).toContain(
      'FACE_MATCH_BELOW_THRESHOLD',
    );
  });

  it('fails on a different document number or name', async () => {
    const { svc } = build({ now: decisionBody('ZZ999999', 'Jane Doe') });
    const r = await svc.check(USER, NOW);
    expect(r.matched).toBe(false);
    expect(r.reasons).toEqual(
      expect.arrayContaining(['DOCUMENT_NUMBER_MISMATCH', 'NAME_MISMATCH']),
    );
  });

  it('fails closed on Didit errors', async () => {
    const { svc } = build({ faceStatus: 500 });
    expect(await svc.check(USER, NOW)).toEqual({
      matched: false,
      reasons: ['CHECK_ERROR'],
      score: null,
    });
  });

  it('fails without a live face image', async () => {
    const { svc } = build({
      now: decisionBody('A1234567', 'Amani Wanjiku', false),
    });
    expect((await svc.check(USER, NOW)).reasons).toContain('NO_LIVE_FACE');
  });

  it('rejects reuse of the original KYC session and weak thresholds', async () => {
    const { svc } = build({ threshold: '10' });
    expect(svc.threshold()).toBe(75);
    expect((await svc.check(USER, REF)).reasons).toEqual([
      'SAME_SESSION_REUSED',
    ]);
  });
});
