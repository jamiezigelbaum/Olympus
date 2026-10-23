import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity } from '../client/identity.ts';
import { formatUsage, runAdmin } from '../server/admin.ts';
import { countInstallers, installerKind, readInstallerCounts } from '../server/installer-counts.ts';
import { FileInstallRegistry, MemoryInstallRegistry } from '../server/registry.ts';
import { UsageLedger } from '../server/usage.ts';

const DAY = 24 * 60 * 60_000;
const MIDDAY = Date.parse('2026-10-20T12:00:00Z');

function installs(dir: string, count: number) {
  return Array.from({ length: count }, (_, index) => loadOrCreateIdentity(join(dir, `install-${index}`)));
}

describe('daily usage totals', () => {
  test('count each install once a day, leave out internal and demo installs, and roll over at UTC midnight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-usage-'));
    try {
      let at = MIDDAY;
      const registry = new MemoryInstallRegistry(100, () => at);
      const [a, b, team, demo] = installs(dir, 4);
      for (const install of [a!, b!, team!, demo!]) registry.register(install.installId, install.publicKeySpki);
      expect(await registry.setInternal(team!.installId, true)).toBe(true);
      expect(await registry.setInternal(team!.installId, true)).toBe(false);
      const usage = new UsageLedger(registry, (id) => registry.isInternal(id) || id === demo!.installId, undefined, () => at);

      usage.registered(a!.installId, false);
      usage.registered(b!.installId, true);
      usage.registered(team!.installId, false);
      for (const install of [a!, a!, b!, team!, demo!]) usage.active(install.installId);
      usage.request(a!.installId);
      usage.request(team!.installId);
      usage.request(demo!.installId);

      let [today] = usage.snapshot().slice(-1);
      expect(today).toMatchObject({ day: '2026-10-20', active: 2, newInstalls: 1, returning: 1, requests: 1, registered: 2, active7: 2, active30: 2 });

      at = MIDDAY + DAY;
      usage.active(b!.installId);
      const days = usage.snapshot();
      expect(days.map((day) => day.day)).toEqual(['2026-10-20', '2026-10-21']);
      expect(days[1]).toMatchObject({ active: 1, newInstalls: 0, requests: 0 });

      // Marking an install external puts it back in the totals.
      expect(await registry.setInternal(team!.installId, false)).toBe(true);
      [today] = usage.snapshot().slice(-1);
      expect(today!.registered).toBe(3);
      expect(formatUsage(days)).toContain('2026-10-21');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a restart keeps the day\'s counters and does not count an install twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-usage-'));
    try {
      const at = MIDDAY;
      const path = join(dir, 'state', 'usage.json');
      const registry = new FileInstallRegistry(join(dir, 'state', 'registry.jsonl'), 100, () => at);
      const [a] = installs(dir, 1);
      registry.register(a!.installId, a!.publicKeySpki);
      registry.seen(a!.installId);
      const first = new UsageLedger(registry, () => false, path, () => at);
      first.active(a!.installId);
      first.request(a!.installId);
      first.persist();
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // Counts only: the file names no install.
      expect(readFileSync(path, 'utf8')).not.toContain(a!.installId);

      const second = new UsageLedger(registry, () => false, path, () => at);
      second.active(a!.installId);
      second.request(a!.installId);
      expect(second.snapshot().slice(-1)[0]).toMatchObject({ active: 1, requests: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the internal mark survives the registry being reloaded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-usage-'));
    try {
      const path = join(dir, 'registry.jsonl');
      const [a] = installs(dir, 1);
      const registry = new FileInstallRegistry(path);
      registry.register(a!.installId, a!.publicKeySpki);
      await registry.setInternal(a!.installId, true);
      await registry.flush();
      const reloaded = new FileInstallRegistry(path);
      expect(reloaded.isInternal(a!.installId)).toBe(true);
      expect(reloaded.counts().internal).toBe(1);
      // Compaction on load kept it too.
      expect(new FileInstallRegistry(path).isInternal(a!.installId)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the admin command reads saved totals while the relay is stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-usage-'));
    try {
      const state = join(dir, 'state');
      mkdirSync(state, { mode: 0o700 });
      const registry = new FileInstallRegistry(join(state, 'registry.jsonl'));
      const ledger = new UsageLedger(registry, () => false, join(state, 'usage.json'));
      ledger.persist();
      const env = { RELAY_REGISTRY_PATH: join(state, 'registry.jsonl'), RELAY_ADMIN_SOCKET: join(state, 'none.sock') };
      const json = await runAdmin(['usage', '--json'], env);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.out)).toMatchObject({ running: false, days: [{ active: 0 }] });
      expect((await runAdmin(['usage', 'extra'], env)).code).toBe(2);
      expect((await runAdmin(['internal'], env)).code).toBe(2);
      expect((await runAdmin(['internal', 'abcdefghijklmnopqrstuvwxyz234567'], env)).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installer download counts', () => {
  test('count complete GETs of the installers by day, then empty the log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-installer-counts-'));
    try {
      const log = join(dir, 'downloads.log');
      const out = join(dir, 'state', 'counts.json');
      const ts = Date.parse('2026-10-20T10:00:00Z') / 1000;
      const line = (uri: string, extra: Record<string, unknown> = {}) =>
        JSON.stringify({ ts, status: 200, request: { method: 'GET', uri }, ...extra });
      writeFileSync(log, [
        line('/install.sh'),
        line('/install.sh?ref=x'),
        line('/install-linux.sh'),
        line('/releases/1.1.0/olympus-1.1.0.tgz'),
        line('/uninstall.sh', { ts: ts + 86_400 }),
        line('/install.sh', { status: 404 }),
        JSON.stringify({ ts, status: 200, request: { method: 'HEAD', uri: '/install.sh' } }),
        line('/index.html'),
        'not json',
      ].join('\n'));
      expect(installerKind('/releases/1.1.0/olympus-1.1.0.tgz.sha256')).toBeUndefined();
      countInstallers(log, out);
      expect(readFileSync(log, 'utf8')).toBe('');
      // A second run adds to the saved days.
      writeFileSync(log, `${line('/install.sh')}\n`);
      const days = countInstallers(log, out);
      expect(days).toEqual([
        { day: '2026-10-20', macScript: 3, linuxScript: 1, release: 1, macUninstall: 0, linuxUninstall: 0 },
        { day: '2026-10-21', macScript: 0, linuxScript: 0, release: 0, macUninstall: 1, linuxUninstall: 0 },
      ]);
      expect(readInstallerCounts(out)).toEqual(days);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
