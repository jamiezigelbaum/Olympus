/** A best-effort, content-free read of the installer users would rerun. No disk state. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { olympusPackageRoot } from './package-root.ts';

// Keep identical to VERSION_PATTERN in scripts/publish-release-to-site.ts.
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
export const UPDATE_MAX_BYTES = 512 * 1024;
export const UPDATE_TIMEOUT_MS = 10_000;
export interface UpdateAvailable { version: string }

export function installerForPlatform(platform: string): { url: string; command: string } | undefined {
  // Linux reads the installer the site publishes with 1.0.0; until it is
  // served, the check fails quietly like any other failed check.
  if (platform === 'darwin') return {
    url: 'https://olympusplugin.ai/install.sh',
    command: 'curl -fsSL https://olympusplugin.ai/install.sh | sh',
  };
  if (platform === 'linux') return {
    url: 'https://olympusplugin.ai/install-linux.sh',
    command: 'curl -fsSL https://olympusplugin.ai/install-linux.sh | sh',
  };
  return undefined;
}

function semver(version: string): { core: bigint[]; pre: string[] } | undefined {
  if (version.length > 64 || !VERSION_PATTERN.test(version)) return undefined;
  const [core, suffix] = version.split('-');
  const numbers = core!.split('.');
  const pre = suffix?.split('.') ?? [];
  if ([...numbers, ...pre.filter(part => /^\d+$/.test(part))].some(part => part.length > 1 && part.startsWith('0'))) return undefined;
  return { core: numbers.map(BigInt), pre };
}

export function parseInstallerVersion(script: string): string | undefined {
  if (new TextEncoder().encode(script).byteLength > UPDATE_MAX_BYTES) return undefined;
  // Inspect the FIRST assignment, even when malformed: never find a later pin.
  const version = /^OLYMPUS_VERSION=([^\r\n]*)\r?$/m.exec(script)?.[1];
  return version && semver(version) ? version : undefined;
}

export function newerVersion(remote: string, running: string): boolean {
  const next = semver(remote);
  const current = semver(running);
  if (!next || !current || (current.pre.length === 0 && next.pre.length > 0)) return false;
  for (let i = 0; i < 3; i++) {
    if (next.core[i] !== current.core[i]) return next.core[i]! > current.core[i]!;
  }
  if (next.pre.length === 0 || current.pre.length === 0) return next.pre.length === 0 && current.pre.length > 0;
  for (let i = 0; i < Math.max(next.pre.length, current.pre.length); i++) {
    const a = next.pre[i], b = current.pre[i];
    if (a === undefined || b === undefined) return b === undefined;
    if (a === b) continue;
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
    return an && bn ? BigInt(a) > BigInt(b) : an !== bn ? !an : a > b;
  }
  return false;
}

/** Read the running package, from source or bundled dist, just as engine build identity does. */
export function runningOlympusVersion(): string {
  try {
    const value = JSON.parse(readFileSync(join(olympusPackageRoot(), 'package.json'), 'utf8')).version;
    return typeof value === 'string' ? value : 'unknown';
  } catch { return 'unknown'; }
}

interface UpdateCheckOptions {
  runningVersion: string;
  platform: string;
  env: Record<string, string | undefined>;
  fileEnv: () => Record<string, string | undefined> | undefined;
  fetchImpl?: typeof fetch;
  debug?: (line: string) => void;
  /** Test seams for the clock; production always uses ten seconds. */
  timeoutMs?: number;
  random?: () => number;
  schedule?: (callback: () => void, delay: number) => () => void;
}

export function createUpdateChecker(options: UpdateCheckOptions) {
  const installer = installerForPlatform(options.platform);
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay); timer.unref(); return () => clearTimeout(timer);
  });
  let result: UpdateAvailable | undefined;
  let cancelTimer: (() => void) | undefined;
  let controller: AbortController | undefined;
  let started = false;
  let stopped = false;
  // The shipped Bun runtime inherits proxy environment variables and has no
  // reliable per-request bypass. Skip rather than route this check via a proxy.
  const proxied = () => ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .some(key => Boolean(options.env[key]?.trim()));
  const off = (value: string | undefined) => ['off', '0', 'false', 'no'].includes(value?.trim().toLowerCase() ?? '');
  const enabled = () => Boolean(installer) && !proxied() && !off(options.env.OLYMPUS_UPDATE_CHECK)
    && !off(options.fileEnv()?.OLYMPUS_UPDATE_CHECK);
  async function check(): Promise<void> {
    // Everything, including reading worker.env and calling the debug sink, is
    // advisory. Neither a timer nor a request failure may reject into the worker.
    if (controller) return;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (stopped || !enabled()) { result = undefined; return; }
      controller = new AbortController();
      timeout = setTimeout(() => controller?.abort(), options.timeoutMs ?? UPDATE_TIMEOUT_MS);
      const response = await (options.fetchImpl ?? fetch)(installer!.url, {
        method: 'GET', headers: { 'User-Agent': 'Olympus' }, credentials: 'omit', redirect: 'error',
        signal: controller.signal,
      });
      reader = response.body?.getReader();
      if (!response.ok || Number(response.headers.get('content-length')) > UPDATE_MAX_BYTES || !reader) throw new Error('unavailable');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > UPDATE_MAX_BYTES) throw new Error('oversized');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const version = parseInstallerVersion(new TextDecoder().decode(bytes));
      result = !stopped && enabled() && version && newerVersion(version, options.runningVersion) ? { version } : undefined;
    } catch {
      result = undefined;
      try { options.debug?.('[update] check unavailable'); } catch { /* Silent even if logging fails. */ }
    } finally {
      if (timeout) clearTimeout(timeout);
      // Do not wait for an uncooperative body's cancellation.
      void reader?.cancel().catch(() => undefined);
      controller = undefined;
    }
  }
  function tick(): void {
    void check().finally(() => {
      if (!stopped) cancelTimer = schedule(tick, 86_400_000 * (0.95 + (options.random ?? Math.random)() * 0.1));
    });
  }
  return {
    check,
    available(): UpdateAvailable | undefined {
      try { return enabled() && !stopped ? result : undefined; } catch { return undefined; }
    },
    start(): void {
      if (started || stopped || !installer) return;
      started = true;
      cancelTimer = schedule(tick, 120_000);
    },
    stop(): void { stopped = true; result = undefined; cancelTimer?.(); controller?.abort(); },
  };
}
