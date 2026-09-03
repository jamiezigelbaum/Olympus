// Email ingest curation filter.
//
// Two classes of mail carry zero (or negative) knowledge value and are
// skipped at ingest, BEFORE anything is stored:
//
// - OTP / verification-code mail: pure authentication material. Storing it
//   would accumulate exactly the kind of content an aggregated knowledge
//   system must not hold (see the identity-air-gap doctrine: recovery
//   channels stay outside Olympus).
// - Bulk marketing mail: Gmail's own classifier already labels it
//   (CATEGORY_PROMOTIONS etc.); we trust that signal rather than growing a
//   parallel heuristic.
//
// Skips are COUNTED on every sync result — coverage stays honest; nothing is
// dropped silently. The filter never touches mail already in the index.

export interface EmailIngestFilterOptions {
  // Gmail category labels to skip (default: CATEGORY_PROMOTIONS).
  skipCategories?: readonly string[];
  // Skip verification-code/OTP mail (default: true).
  skipOtp?: boolean;
}

export interface EmailIngestFilterCandidate {
  subject?: string;
  from?: string;
  body?: string;
  labels?: readonly string[];
}

export type EmailIngestSkipReason = 'otp' | `category:${string}`;

const DEFAULT_SKIP_CATEGORIES = ['CATEGORY_PROMOTIONS'];

// High-precision subject signals for authentication mail.
const OTP_SUBJECT = new RegExp(
  [
    'verification code',
    'security code',
    'one[- ]?time (pass)?(word|code)',
    'login code',
    'sign[- ]?in code',
    'access code',
    'confirmation code',
    'your (\\w+ )?code is',
    '\\botp\\b',
    '2fa code',
  ].join('|'),
  'i',
);

// Short body whose payload is essentially a bare numeric code.
const OTP_BODY_CODE = /\b\d{4,8}\b/;
const OTP_BODY_HINT = /\b(code|verification|expires? in|valid for)\b/i;
const OTP_BODY_MAX_CHARS = 900;

export function classifyEmailIngestSkip(
  candidate: EmailIngestFilterCandidate,
  options: EmailIngestFilterOptions = {},
): EmailIngestSkipReason | undefined {
  const skipOtp = options.skipOtp ?? true;
  if (skipOtp && isOtpMail(candidate)) return 'otp';
  const skipCategories = options.skipCategories ?? DEFAULT_SKIP_CATEGORIES;
  if (skipCategories.length > 0 && candidate.labels) {
    const skip = new Set(skipCategories.map((label) => label.trim().toUpperCase()).filter(Boolean));
    for (const label of candidate.labels) {
      if (skip.has(label.toUpperCase())) {
        return `category:${label.toUpperCase()}`;
      }
    }
  }
  return undefined;
}

function isOtpMail(candidate: EmailIngestFilterCandidate): boolean {
  if (candidate.subject && OTP_SUBJECT.test(candidate.subject)) return true;
  const body = candidate.body?.trim();
  if (
    body
    && body.length > 0
    && body.length <= OTP_BODY_MAX_CHARS
    && OTP_BODY_CODE.test(body)
    && OTP_BODY_HINT.test(body)
  ) {
    return true;
  }
  return false;
}

export function parseEmailIngestFilterOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmailIngestFilterOptions {
  const categoriesRaw = env.OLYMPUS_EMAIL_INGEST_SKIP_CATEGORIES;
  const skipOtpRaw = env.OLYMPUS_EMAIL_INGEST_SKIP_OTP;
  return {
    ...(categoriesRaw !== undefined
      ? { skipCategories: categoriesRaw.split(',').map((label) => label.trim()).filter(Boolean) }
      : {}),
    ...(skipOtpRaw !== undefined ? { skipOtp: skipOtpRaw === 'true' } : {}),
  };
}

export function tallyEmailIngestSkips(
  reasons: readonly EmailIngestSkipReason[],
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const reason of reasons) {
    tally[reason] = (tally[reason] ?? 0) + 1;
  }
  return tally;
}
