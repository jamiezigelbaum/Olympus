/** Driver-only adapter. Bundles and private scratch are created under /tmp and removed on every exit. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine } from './machine.ts';
import type { LimitsMachine } from './fresh-limits.ts';

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** A failure whose message is safe for the report: fixed text and a step name, never machine output. */
export class LimitsReason extends Error {}
const PROBE_STEP = /^[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*)?(?: \((?:CLI exit \d{1,3}|CLI timed out)\))?$/;
/** Names where the probe stopped, from its one-line `{ failed }` reply; anything else stays unnamed. */
export function probeFailure(result: { code: number; stdout: string; timedOut: boolean }): LimitsReason {
  if (result.timedOut) return new LimitsReason('limits probe timed out');
  if (result.code === 97) return new LimitsReason('limits probe found no Olympus runtime to run under');
  let reply: { failed?: unknown; why?: unknown } = {};
  try { reply = JSON.parse(result.stdout.trim().split('\n').pop() ?? ''); } catch { /* no reply: unnamed */ }
  if (typeof reply.failed !== 'string' || !PROBE_STEP.test(reply.failed)) return new LimitsReason(`limits probe failed before it answered (exit ${result.code})`);
  // The cause comes from a throwaway machine holding only synthetic items; paths and control characters still stay out.
  const why = typeof reply.why === 'string'
    ? reply.why.replace(/[\p{Cc}]+/gu, ' ').replace(/(?:~|\.{0,2})?\/[^\s'"`,;)]+/g, '<path>').replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  return new LimitsReason(`limits probe failed at ${reply.failed}${why ? `: ${why}` : ''}`);
}
export async function openLimitsMachine(machine: Machine, transport: Machine = machine): Promise<LimitsMachine> {
  if (!machine.disposable || !transport.disposable) throw new Error('limits requires driver provision');
  const work = mkdtempSync(join(tmpdir(), 'olympus-limits-'));
  const remote = `/tmp/olympus-limits-${crypto.randomUUID()}.js`;
  const scratch = `${remote}.work`;
  const call = async (command: string): Promise<any> => {
    const result = await machine.exec(`set -euo pipefail
rc_bun=$(command -v bun 2>/dev/null || { ls -d ~/.local/share/olympus-engine/generations/*/runtime/bun "$HOME/Library/Application Support/Olympus/runtime/bun" 2>/dev/null || true; } | tail -1)
[ -n "$rc_bun" ] || exit 97
printf '%s' ${quote(JSON.stringify({ command, scratch }))} | "$rc_bun" --no-env-file ${quote(remote)}`, { timeoutMs: 240_000 });
    // Neither stderr nor free stdout belongs in a report: the machine may print credentials or paths on failure.
    if (result.code !== 0 || result.timedOut) throw probeFailure(result);
    return JSON.parse(result.stdout);
  };
  try {
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'limits-probe.ts')], target: 'bun', outdir: work, naming: 'probe.js' });
    if (!build.success) throw new Error('limits probe build failed');
    await transport.put(join(work, 'probe.js'), remote);
    if (transport !== machine) {
      const readable = await transport.exec(`chmod 644 ${quote(remote)}`, { timeoutMs: 30_000 });
      if (readable.code !== 0) throw new Error('limits probe transfer failed');
    }
  } catch (error) {
    await transport.exec(`rm -f ${quote(remote)}`, { timeoutMs: 30_000 }).catch(() => {});
    rmSync(work, { recursive: true, force: true }); throw error;
  }
  return {
    prepare: async () => { await call('prepare'); },
    // The synthetic source is registered before restart so the running worker opens its stores at boot.
    seed: async () => (await call('seed')).count,
    snapshot: () => call('snapshot'),
    marker: async action => (await call(`marker-${action}`)).exists,
    hasVeniceCredential: async () => (await call('credential')).present,
    close: async () => {
      try { await call('restore'); }
      finally {
        try {
          const removed = await transport.exec(`rm -f ${quote(remote)}`, { timeoutMs: 30_000 });
          if (removed.code !== 0) throw new Error('limits probe cleanup failed');
        } finally { rmSync(work, { recursive: true, force: true }); }
      }
    },
  };
}
