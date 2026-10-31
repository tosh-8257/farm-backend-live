import { createPublicKey, verify, type KeyObject } from 'crypto';

export type DeviceKeyAlg = 'ed25519' | 'p256';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const P256_SPKI_PREFIX = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200',
  'hex',
);

/** Message a device signs for a login challenge. */
export function deviceChallengeMessage(
  challengeId: string,
  nonce: string,
  deviceId: string,
): Buffer {
  return Buffer.from(
    `farm-device-login:v1:${challengeId}:${nonce}:${deviceId}`,
    'utf8',
  );
}

/**
 * Parses a base64 public key. Accepts SPKI DER for either algorithm, a raw
 * 32-byte Ed25519 key, or a raw 65-byte uncompressed P-256 point.
 */
export function parseDevicePublicKey(
  alg: DeviceKeyAlg,
  base64: string,
): KeyObject {
  const raw = Buffer.from(base64, 'base64');
  let der: Buffer;
  if (alg === 'ed25519') {
    der = raw.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw;
  } else {
    der =
      raw.length === 65 && raw[0] === 0x04
        ? Buffer.concat([P256_SPKI_PREFIX, raw])
        : raw;
  }
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  const type = key.asymmetricKeyType;
  if (alg === 'ed25519' && type !== 'ed25519') throw new Error('bad key');
  if (alg === 'p256') {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (type !== 'ec' || curve !== 'prime256v1') throw new Error('bad key');
  }
  return key;
}

/** Verifies a base64 signature. P-256 accepts DER or raw r||s (64 bytes). */
export function verifyDeviceSignature(
  alg: DeviceKeyAlg,
  publicKeyB64: string,
  message: Buffer,
  signatureB64: string,
): boolean {
  try {
    const key = parseDevicePublicKey(alg, publicKeyB64);
    const sig = Buffer.from(signatureB64, 'base64');
    if (alg === 'ed25519') return verify(null, message, key, sig);
    return verify(
      'sha256',
      message,
      { key, dsaEncoding: sig.length === 64 ? 'ieee-p1363' : 'der' },
      sig,
    );
  } catch {
    return false;
  }
}
