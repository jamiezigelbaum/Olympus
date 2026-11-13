/** Host adapter for timing diagnostics and fresh split setup. All scratch lives under /tmp. */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Machine } from './machine.ts';
import type { TimingDiagnostics } from './on-demand-timing.ts';
import type { ReadCursor } from './on-demand-probe.ts';
import type { TimingFile } from './on-demand-seeds.ts';
import { openFreshDashboard } from './fresh-dashboard.ts';

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export async function openTimingDashboard(machine: Machine, endpoint: string, bridgeAgent?: string) {
  const remote = `/tmp/olympus-ondemand-bridge-${crypto.randomUUID()}.js`;
  try {
    if (machine.os === 'linux') {
      if (!bridgeAgent) throw new Error('the Linux timing stage needs this run’s bridgeAgent bundle');
      await machine.put(bridgeAgent, remote);
    }
    const dashboard = await openFreshDashboard(machine, endpoint, { bridge: { agentPath: remote, pidFile: `${remote}.pid`, logTemplate: '/tmp/olympus-ondemand-bridge.XXXXXX' } });
    return { ...dashboard, close: async () => {
      try { await dashboard.close(); }
      finally { if (machine.os === 'linux') await machine.exec(`rm -f ${quote(remote)} ${quote(`${remote}.pid`)}`, { timeoutMs: 30_000 }); }
    } };
  } catch (error) {
    if (machine.os === 'linux') await machine.exec(`rm -f ${quote(remote)} ${quote(`${remote}.pid`)}`, { timeoutMs: 30_000 }).catch(() => {});
    throw error;
  }
}

export async function openTimingDiagnostics(machine: Machine, transport: Machine = machine): Promise<TimingDiagnostics> {
  const work = mkdtempSync(join(tmpdir(), 'olympus-ondemand-'));
  const remote = `/tmp/olympus-ondemand-${crypto.randomUUID()}.js`;
  let cursor: ReadCursor | undefined;
  const call = async (input: unknown, timeoutMs = 60_000): Promise<any> => {
    const result = await machine.exec(`set -euo pipefail
rc_bun=$(command -v bun 2>/dev/null || { ls -d ~/.local/share/olympus-engine/generations/*/runtime/bun "$HOME/Library/Application Support/Olympus/runtime/bun" 2>/dev/null || true; } | tail -1)
[ -n "$rc_bun" ]
printf '%s' ${quote(JSON.stringify(input))} | "$rc_bun" --no-env-file ${quote(remote)}`, { timeoutMs });
    if (result.code !== 0) throw new Error(`timing diagnostics failed: ${result.stderr.slice(-400)}`);
    return JSON.parse(result.stdout);
  };
  try {
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'on-demand-probe.ts')], target: 'bun', outdir: work, naming: 'probe.js' });
    if (!build.success) throw new Error('could not bundle read-on-demand diagnostics');
    await transport.put(join(work, 'probe.js'), remote);
    if (transport !== machine) {
      const readable = await transport.exec(`chmod 644 ${quote(remote)}`, { timeoutMs: 30_000 });
      if (readable.code !== 0) throw new Error('could not make the probe readable by the fresh user');
    }
  } catch (error) {
    await transport.exec(`rm -f ${quote(remote)}`, { timeoutMs: 30_000 }).catch(() => {});
    rmSync(work, { recursive: true, force: true }); throw error;
  }
  return {
    enableSplit: async () => { await call({ command: 'enable-split' }, 200_000); },
    resolve: async file => call({ command: 'resolve', file }),
    preflight: async () => (await call({ command: 'preflight' })).detail,
    begin: async () => { cursor = await call({ command: 'begin' }); },
    finish: async (file: TimingFile) => {
      if (!cursor) throw new Error('no timing cursor');
      return call({ command: 'finish', file: { providerItemId: file.providerItemId, version: file.version }, cursor });
    },
    close: async () => {
      try {
        const removed = await transport.exec(`rm -f ${quote(remote)}`, { timeoutMs: 30_000 });
        if (removed.code !== 0) throw new Error('could not remove timing probe scratch');
      }
      finally { rmSync(work, { recursive: true, force: true }); }
    },
  };
}
