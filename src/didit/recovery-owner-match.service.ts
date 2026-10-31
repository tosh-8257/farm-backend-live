import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';

const DIDIT_BASE = 'https://verification.didit.me';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_THRESHOLD = 75;

export type OwnerMatchResult = {
  /** true only when every check positively passed. */
  matched: boolean;
  /** Reason codes; non-empty whenever matched is false. */
  reasons: string[];
  score: number | null;
};

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Rec)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function first(decision: Rec, key: string): Rec | null {
  const arr = decision[key];
  return Array.isArray(arr) && arr.length ? asRecord(arr[0]) : null;
}

/** Uppercase alphanumerics only, so "AB 123-45" == "ab12345". */
export function normalizeDocNumber(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const n = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n.length >= 4 ? n : null;
}

/** Lowercase, accent-free name tokens. */
export function nameTokens(v: unknown): string[] {
  const s = str(v);
  if (!s) return [];
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2);
}

function idName(idv: Rec): string[] {
  const full = nameTokens(idv.full_name);
  if (full.length) return full;
  return [...nameTokens(idv.first_name), ...nameTokens(idv.last_name)];
}

/** Every token of `required` must appear in `candidate`. */
export function namesMatch(required: string[], candidate: string[]): boolean {
  if (!required.length || !candidate.length) return false;
  const set = new Set(candidate);
  return required.every((t) => set.has(t));
}

/**
 * Fail-closed check that a device-recovery Didit session belongs to the
 * account owner: the recovery session's live face is compared (Didit Face
 * Match API) with the portrait from the user's original approved KYC
 * session, and the document number and name must match the original KYC
 * data and the profile. Any missing data, error or mismatch => not matched.
 */
@Injectable()
export class RecoveryOwnerMatchService {
  private readonly logger = new Logger(RecoveryOwnerMatchService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  threshold(): number {
    const raw = Number(
      this.config.get<string>('DEVICE_RECOVERY_FACE_MATCH_THRESHOLD'),
    );
    // Never allow a configuration weaker than the default floor of 50.
    return Number.isFinite(raw) && raw >= 50 && raw <= 100
      ? raw
      : DEFAULT_THRESHOLD;
  }

  async check(
    userId: string,
    recoverySessionId: string | null,
  ): Promise<OwnerMatchResult> {
    try {
      return await this.run(userId, recoverySessionId);
    } catch (error) {
      this.logger.warn(
        `owner match error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { matched: false, reasons: ['CHECK_ERROR'], score: null };
    }
  }

  private async run(
    userId: string,
    recoverySessionId: string | null,
  ): Promise<OwnerMatchResult> {
    const apiKey = this.config.get<string>('DIDIT_API_KEY')?.trim();
    if (!apiKey) return fail('DIDIT_NOT_CONFIGURED');
    if (!recoverySessionId) return fail('NO_RECOVERY_SESSION');

    const ref = await this.prisma.kyc_identity_references.findUnique({
      where: { user_id: userId },
    });
    if (!ref) return fail('NO_KYC_REFERENCE');
    if (ref.didit_session_id === recoverySessionId) {
      return fail('SAME_SESSION_REUSED');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { first_name: true, last_name: true, kyc_status: true },
    });
    if (!user || user.kyc_status !== 'verified') return fail('USER_NOT_KYC');

    const [orig, now] = await Promise.all([
      this.decision(apiKey, ref.didit_session_id),
      this.decision(apiKey, recoverySessionId),
    ]);
    if (str(orig.status) !== 'Approved') return fail('KYC_REFERENCE_INVALID');
    if (str(now.status) !== 'Approved') return fail('RECOVERY_NOT_APPROVED');

    const origId = first(orig, 'id_verifications');
    const nowId = first(now, 'id_verifications');
    if (!origId) return fail('NO_KYC_REFERENCE_DOCUMENT');
    if (!nowId) return fail('NO_RECOVERY_DOCUMENT');

    const reasons: string[] = [];

    const origDoc = normalizeDocNumber(origId.document_number);
    const nowDoc = normalizeDocNumber(nowId.document_number);
    const origPn = normalizeDocNumber(origId.personal_number);
    const nowPn = normalizeDocNumber(nowId.personal_number);
    const docOk =
      (origDoc !== null && origDoc === nowDoc) ||
      (origPn !== null && origPn === nowPn);
    if (!docOk) reasons.push('DOCUMENT_NUMBER_MISMATCH');

    const nowName = idName(nowId);
    const nameOk =
      namesMatch(idName(origId), nowName) &&
      namesMatch(
        [...nameTokens(user.first_name), ...nameTokens(user.last_name)],
        nowName,
      );
    if (!nameOk) reasons.push('NAME_MISMATCH');

    const refImageUrl = str(origId.portrait_image);
    const live = first(now, 'liveness_checks');
    const liveImageUrl =
      str(live?.reference_image) ??
      str(first(now, 'face_matches')?.target_image);
    if (!refImageUrl)
      return {
        matched: false,
        reasons: [...reasons, 'NO_REFERENCE_PORTRAIT'],
        score: null,
      };
    if (!liveImageUrl)
      return {
        matched: false,
        reasons: [...reasons, 'NO_LIVE_FACE'],
        score: null,
      };

    const threshold = this.threshold();
    const face = await this.faceMatch(
      apiKey,
      await this.image(liveImageUrl),
      await this.image(refImageUrl),
      threshold,
      userId,
    );
    if (
      face.status !== 'Approved' ||
      face.score === null ||
      face.score < threshold
    ) {
      reasons.push('FACE_MATCH_BELOW_THRESHOLD');
    }
    return { matched: reasons.length === 0, reasons, score: face.score };
  }

  private async decision(apiKey: string, sessionId: string): Promise<Rec> {
    const res = await fetch(
      `${DIDIT_BASE}/v3/session/${encodeURIComponent(sessionId)}/decision/`,
      {
        headers: { 'x-api-key': apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`decision HTTP ${res.status}`);
    const body = asRecord(await res.json());
    if (!body) throw new Error('decision body invalid');
    return body;
  }

  private async image(url: string): Promise<Blob> {
    if (!url.startsWith('https://')) throw new Error('image url not https');
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('image size invalid');
    }
    const type = res.headers.get('content-type') ?? 'image/jpeg';
    return new Blob([buf], { type });
  }

  private async faceMatch(
    apiKey: string,
    userImage: Blob,
    refImage: Blob,
    threshold: number,
    userId: string,
  ): Promise<{ status: string | null; score: number | null }> {
    const ext = (b: Blob) =>
      b.type.includes('png') ? 'png' : b.type.includes('webp') ? 'webp' : 'jpg';
    const form = new FormData();
    form.append('user_image', userImage, `user.${ext(userImage)}`);
    form.append('ref_image', refImage, `ref.${ext(refImage)}`);
    form.append('face_match_score_decline_threshold', String(threshold));
    form.append('vendor_data', `devrec-match:${userId}`);
    const res = await fetch(`${DIDIT_BASE}/v3/face-match/`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`face-match HTTP ${res.status}`);
    const fm = asRecord(asRecord(await res.json())?.face_match);
    if (!fm) throw new Error('face-match body invalid');
    return {
      status: str(fm.status),
      score: typeof fm.score === 'number' ? fm.score : null,
    };
  }
}

function fail(reason: string): OwnerMatchResult {
  return { matched: false, reasons: [reason], score: null };
}
