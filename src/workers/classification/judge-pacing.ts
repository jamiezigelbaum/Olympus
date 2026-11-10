// Paces cloud judge calls to the provider's own request limit (#884).
//
// Venice sets a per-model request limit on each key and reports it on every
// inference response: `x-ratelimit-remaining-requests` and
// `x-ratelimit-reset-requests` (Unix ms by which the window has fully
// cleared). https://github.com/veniceai/api-docs (api-reference/api-spec.mdx,
// api-reference/rate-limiting.mdx). Calls wait while the window is spent, and
// a 429 waits for the reset and retries the same item instead of counting as
// a transport failure. The waits sit outside the analyst's request timeout.
// Content-free: only status codes and rate-limit headers are read.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AnalystModel } from '../../core/analyst.ts';
import type { OpenAIAnalystFetch } from '../../core/analyst-openai.ts';
import { SNIFFER_SYSTEM_PROMPT } from './sniffer.ts';

/**
 * Venice's cache-routing hint (`prompt_cache_key`): requests with one key tend
 * to reach a server whose cache holds the shared instructions. Derived from
 * the fixed instructions only, so it names no owner, item or account.
 */
export const JUDGE_PROMPT_CACHE_KEY = `olympus-judge-${createHash('sha256').update(SNIFFER_SYSTEM_PROMPT).digest('hex').slice(0, 16)}`;

/** Calls in flight for a Venice judge when the owner sets nothing (local lanes stay at 1). */
export const DEFAULT_VENICE_JUDGE_CONCURRENT_CALLS = 16;
/** 429 retries per item before the call counts as a transport failure. */
export const JUDGE_RATE_LIMIT_RETRIES = 6;
const FALLBACK_BACKOFF_MS = 1_000;
/** A window is a minute; a longer wait means a misread header, so it is bounded. */
const MAX_WAIT_MS = 65_000;

export interface JudgePacerClock {
  /** Wall-clock milliseconds since the epoch (the reset header is an epoch time). */
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const realClock: JudgePacerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  }),
};

function header(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface PacedCall { seq: number; limited: boolean; retryAt?: number }

export class JudgeRateLimitPacer {
  private remaining: number | undefined;
  private resetAt = 0;
  /** Calls are numbered at dispatch; a report covers calls up to the one whose reply carried it. */
  private lastSeq = 0;
  private reportSeq = 0;
  private blockedUntil = 0;
  private readonly calls = new AsyncLocalStorage<PacedCall>();

  constructor(private readonly clock: JudgePacerClock = realClock) {}

  /** Wait until the reported window has room, then number this call against it. */
  private async acquire(signal?: AbortSignal): Promise<number> {
    for (;;) {
      const now = this.clock.now();
      if (this.blockedUntil > now) { await this.clock.sleep(Math.min(MAX_WAIT_MS, this.blockedUntil - now), signal); continue; }
      // Calls dispatched after the report's own call are not in its count yet.
      if (this.remaining !== undefined && this.resetAt > now && this.remaining - (this.lastSeq - this.reportSeq) <= 0) {
        await this.clock.sleep(Math.min(MAX_WAIT_MS, this.resetAt - now), signal);
        continue;
      }
      if (this.resetAt <= now) this.remaining = undefined;
      this.lastSeq += 1;
      return this.lastSeq;
    }
  }

  private observeHeaders(response: Response, seq: number): void {
    const remaining = header(response, 'x-ratelimit-remaining-requests');
    const resetAt = header(response, 'x-ratelimit-reset-requests');
    const now = this.clock.now();
    if (remaining === undefined || resetAt === undefined || resetAt <= now) return;
    // Replies race, and dispatch order is not the provider's admission order.
    // While the current report is live, a reply to an older call may only
    // lower the allowance (calls sent after it still count), never raise it
    // or clear newer reservations. An expired report yields to any report.
    if (seq <= this.reportSeq && this.remaining !== undefined && this.resetAt > now) {
      this.remaining = Math.min(this.remaining, remaining - (this.reportSeq - seq));
      return;
    }
    this.remaining = remaining;
    this.resetAt = resetAt;
    this.reportSeq = seq;
  }

  /** Reads the limit headers and marks a 429 for the call that made it. Returns the response untouched. */
  fetch(fetchImpl: OpenAIAnalystFetch): OpenAIAnalystFetch {
    return async (url, init) => {
      const response = await fetchImpl(url, init);
      const call = this.calls.getStore();
      // Only paced calls carry a dispatch number to place their report.
      if (call) this.observeHeaders(response, call.seq);
      if (response.status === 429) {
        const now = this.clock.now();
        const reset = header(response, 'x-ratelimit-reset-requests');
        const retryAfter = header(response, 'retry-after');
        const until = reset !== undefined && reset > now ? reset
          : retryAfter !== undefined ? now + retryAfter * 1_000 : undefined;
        if (call) { call.limited = true; if (until !== undefined) call.retryAt = until; }
        if (until !== undefined) this.blockedUntil = Math.max(this.blockedUntil, Math.min(until, now + MAX_WAIT_MS));
        this.remaining = 0;
      }
      return response;
    };
  }

  /** Wraps the judge model: wait for room before each call, and retry an item the provider rate-limited. */
  model(model: AnalystModel, retries = JUDGE_RATE_LIMIT_RETRIES): AnalystModel {
    return {
      complete: async (request) => {
        for (let attempt = 0; ; attempt++) {
          const call: PacedCall = { seq: await this.acquire(request.signal), limited: false };
          try {
            return await this.calls.run(call, () => model.complete(request));
          } catch (error) {
            if (!call.limited || attempt >= retries || request.signal?.aborted) throw error;
            // No usable reset time: back off exponentially before the window check.
            if (call.retryAt === undefined) {
              await this.clock.sleep(Math.min(MAX_WAIT_MS, FALLBACK_BACKOFF_MS * 2 ** attempt), request.signal);
            }
          }
        }
      },
    };
  }
}
