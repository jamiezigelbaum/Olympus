/**
 * Sealing a private answer to the panel that asked for it.
 *
 * The panel generates an ephemeral ECDH P-256 key pair in WebCrypto (private
 * key non-extractable) and sends only its public key. The engine generates its
 * own ephemeral pair per answer, and both sides derive the same AES-256-GCM
 * key:
 *
 *   shared  = ECDH(P-256)                      256 bits
 *   key     = HKDF-SHA256(ikm = shared, salt = empty, info = UTF-8(job id))
 *   sealed  = AES-256-GCM(key, iv = 12 random bytes, aad = UTF-8(job id), plaintext)
 *
 * Wire values are base64url without padding: `macPublicKey` (raw uncompressed
 * point, 65 bytes), `iv` (12 bytes), `ciphertext` (ciphertext plus the 16-byte
 * tag). The panel's copy of this algorithm is in private-answer-resource.ts;
 * test/chatgpt-private-answer.test.ts holds the two together.
 */

export const PRIVATE_ANSWER_CURVE = 'P-256';
const RAW_PUBLIC_KEY_BYTES = 65;
const IV_BYTES = 12;

export interface SealedPrivateAnswer {
  macPublicKey: string;
  iv: string;
  ciphertext: string;
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const utf8 = (value: string) => new TextEncoder().encode(value);

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(value: unknown, expectedBytes?: number): Uint8Array<ArrayBuffer> | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000_000 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const bytes = new Uint8Array(Buffer.from(value, 'base64url'));
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) return undefined;
  return bytes;
}

/**
 * A panel public key from the wire, checked: a 65-byte uncompressed point that
 * WebCrypto accepts as a P-256 public key (on the curve). Undefined otherwise.
 */
export async function importPanelPublicKey(value: unknown): Promise<{ key: CryptoKey; raw: string } | undefined> {
  const raw = fromBase64Url(value, RAW_PUBLIC_KEY_BYTES);
  if (!raw || raw[0] !== 0x04) return undefined;
  try {
    const key = await subtle().importKey('raw', raw, { name: 'ECDH', namedCurve: PRIVATE_ANSWER_CURVE }, false, []);
    return { key, raw: toBase64Url(raw) };
  } catch {
    return undefined;
  }
}

async function aesKey(privateKey: CryptoKey, peerPublicKey: CryptoKey, jobId: string, usage: KeyUsage): Promise<CryptoKey> {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256);
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(jobId) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** Plaintext sizes the sealed answer is padded to, so its length tells the relay only the bucket. */
export const PRIVATE_ANSWER_PAD_BUCKETS = [1024, 4096, 16_384, 65_536] as const;

/**
 * Pads a JSON plaintext with trailing spaces to the next bucket (UTF-8 bytes;
 * beyond the largest, the next multiple of it). JSON.parse ignores trailing
 * whitespace, so the panel reads the same value.
 */
export function padPrivateAnswerPlaintext(json: string): string {
  const bytes = utf8(json).byteLength;
  const largest = PRIVATE_ANSWER_PAD_BUCKETS[PRIVATE_ANSWER_PAD_BUCKETS.length - 1]!;
  const target = PRIVATE_ANSWER_PAD_BUCKETS.find((bucket) => bytes <= bucket) ?? Math.ceil(bytes / largest) * largest;
  return json + ' '.repeat(target - bytes);
}

/** Seals `plaintext` to the panel's public key with a fresh engine key pair. */
export async function sealPrivateAnswer(jobId: string, panelPublicKey: CryptoKey, plaintext: string): Promise<SealedPrivateAnswer> {
  const mac = await subtle().generateKey({ name: 'ECDH', namedCurve: PRIVATE_ANSWER_CURVE }, false, ['deriveBits']) as CryptoKeyPair;
  const key = await aesKey(mac.privateKey, panelPublicKey, jobId, 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(jobId) }, key, utf8(plaintext));
  const macPublicKey = new Uint8Array(await subtle().exportKey('raw', mac.publicKey));
  return { macPublicKey: toBase64Url(macPublicKey), iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}

/** The panel side, for tests and tools: opens a sealed answer with the panel's private key. */
export async function openPrivateAnswer(jobId: string, panelPrivateKey: CryptoKey, sealed: SealedPrivateAnswer): Promise<string> {
  const macRaw = fromBase64Url(sealed.macPublicKey, RAW_PUBLIC_KEY_BYTES);
  const iv = fromBase64Url(sealed.iv, IV_BYTES);
  const ciphertext = fromBase64Url(sealed.ciphertext);
  if (!macRaw || !iv || !ciphertext) throw new Error('malformed sealed answer');
  const macKey = await subtle().importKey('raw', macRaw, { name: 'ECDH', namedCurve: PRIVATE_ANSWER_CURVE }, false, []);
  const key = await aesKey(panelPrivateKey, macKey, jobId, 'decrypt');
  const plaintext = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8(jobId) }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

/** A panel key pair as the panel makes it: private key non-extractable. */
export async function generatePanelKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: PRIVATE_ANSWER_CURVE }, false, ['deriveBits']) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: toBase64Url(new Uint8Array(await subtle().exportKey('raw', pair.publicKey))) };
}

/**
 * The engine's key pair for one private question job: the panel seals the
 * question to its public key (private-question-contract.ts). Same curve and
 * derivation as the answer's seal, with the panel's claim key on the other
 * side; the derived AES key differs from the answer's (a fresh engine key
 * seals each answer), so nothing is encrypted twice under one key.
 */
export async function generateEngineKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  return generatePanelKeyPair();
}

/** A sealed question: the panel's AES-GCM output under its claim key and the engine's job key. */
export interface SealedPrivateQuestion {
  iv: string;
  ciphertext: string;
}

/** The panel side (and tests): seals a question to the engine's job key with the panel's own private key. */
export async function sealPrivateQuestion(jobId: string, panelPrivateKey: CryptoKey, engineKey: CryptoKey, plaintext: string): Promise<SealedPrivateQuestion> {
  const key = await aesKey(panelPrivateKey, engineKey, jobId, 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(jobId) }, key, utf8(plaintext));
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}

/** The engine side: opens a sealed question with the job's private key and the panel's public key. Throws when malformed. */
export async function openPrivateQuestion(jobId: string, enginePrivateKey: CryptoKey, panelKey: CryptoKey, sealed: { iv: unknown; ciphertext: unknown }): Promise<string> {
  const iv = fromBase64Url(sealed.iv, IV_BYTES);
  const ciphertext = fromBase64Url(sealed.ciphertext);
  if (!iv || !ciphertext || ciphertext.byteLength > 32_768) throw new Error('malformed sealed question');
  const key = await aesKey(enginePrivateKey, panelKey, jobId, 'decrypt');
  const plaintext = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8(jobId) }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
