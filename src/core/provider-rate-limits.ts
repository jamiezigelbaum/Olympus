/** Provider-owned waits: shared reporting, with persistence installed by the worker. */
import { createLimitStopReporter, registerLimit } from './limit-stops.ts';

registerLimit({ id: 'x.rate_limit', kind: 'requests', scope: 'source', label: 'X is limiting requests', unit: 'requests', continue: 'none' });
registerLimit({ id: 'evernote.rate_limit', kind: 'requests', scope: 'source', label: 'Evernote is limiting requests', unit: 'requests', continue: 'none' });
registerLimit({ id: 'readwise.rate_limit', kind: 'requests', scope: 'source', label: 'Readwise is limiting requests', unit: 'requests', continue: 'none' });

const PROVIDERS = {
  x: { id: 'x.rate_limit', subject: 'x.bookmarks', name: 'X' },
  evernote: { id: 'evernote.rate_limit', subject: 'evernote.notes', name: 'Evernote' },
  readwise: { id: 'readwise.rate_limit', subject: 'readwise.library', name: 'Readwise' },
} as const;
export type RateLimitedProvider = keyof typeof PROVIDERS;
/** Legacy categorical codes remain compatible with persisted scheduler and dashboard state. */
export const SOURCE_RATE_LIMITED = 'rate_limited';
export const X_PROVIDER_RATE_LIMIT = 'provider_rate_limit';

/** Numeric Retry-After is seconds; HTTP dates are absolute. Invalid/missing values use the caller's retry policy. */
export function providerRetryTime(value: string | undefined, now: Date, fallbackMs: number): string {
  const seconds = value?.trim() ? Number(value) : NaN;
  const timestamp = Number.isFinite(seconds)
    ? seconds >= 0 ? now.getTime() + seconds * 1_000 : NaN
    : Date.parse(value ?? '');
  const retry = new Date(timestamp);
  return Number.isFinite(retry.getTime()) ? retry.toISOString() : new Date(now.getTime() + fallbackMs).toISOString();
}

const reporters: Partial<Record<RateLimitedProvider, ReturnType<typeof buildProviderRateLimitReporter>>> = {};
export function createProviderRateLimitReporter(provider: RateLimitedProvider) {
  return reporters[provider] ??= buildProviderRateLimitReporter(provider);
}
function buildProviderRateLimitReporter(provider: RateLimitedProvider) {
  const registration = PROVIDERS[provider];
  const stops = createLimitStopReporter();
  let resumesAt: string | undefined;
  return {
    report(at: string, now: Date, amounts?: { limit?: number | null | undefined; used?: number | null | undefined }) {
      if (!Number.isFinite(Date.parse(at)) || Date.parse(at) - now.getTime() <= 60_000) return;
      resumesAt = at;
      stops.report({ id: registration.id, subject: registration.subject, since: now.toISOString(),
        resumesAt: at, limit: amounts?.limit ?? null, used: amounts?.used ?? null });
    },
    success() { stops.clear(registration.id, registration.subject); resumesAt = undefined; },
    resume(now: Date) { if (resumesAt && Date.parse(resumesAt) <= now.getTime()) this.success(); },
  };
}

export function providerWaitMessage(id: string, resumesAt: string | undefined): string | undefined {
  const provider = Object.values(PROVIDERS).find(provider => provider.id === id);
  return provider && resumesAt ? `${provider.name} sets this wait; it resumes at ${resumesAt} on its own.` : undefined;
}
