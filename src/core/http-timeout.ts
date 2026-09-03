export type TimeoutFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchWithTimeout(
  fetchImpl: TimeoutFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamSignal = init.signal;
  let removeUpstreamAbortListener: (() => void) | undefined;

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort(upstreamSignal.reason);
    } else {
      const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
      removeUpstreamAbortListener = () => upstreamSignal.removeEventListener('abort', abortFromUpstream);
    }
  }

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    removeUpstreamAbortListener?.();
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
