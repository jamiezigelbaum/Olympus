/**
 * Daily download counts for the installers and uninstallers on
 * olympusplugin.ai, for the usage dashboard.
 *
 * Caddy writes one line per download of those files only, with the path, the
 * method, the status and the time and nothing else: no address, no headers
 * (site/deploy/Caddyfile.site). Once an hour `olympus-relay count-installers`
 * (deploy/olympus-installer-counts.service, as the caddy user) adds the
 * lines to the daily counts and empties the log, so a download's line lives
 * an hour at most. A line Caddy writes between the read and the truncation
 * is lost; at a few downloads a day that is noise.
 *
 *   olympus-relay count-installers [--log <file>] [--out <file>]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_INSTALLER_LOG = '/var/log/caddy/olympus-installers.log';
export const DEFAULT_INSTALLER_COUNTS = '/var/lib/olympus-installer-counts/counts.json';

export type InstallerKind = 'macScript' | 'linuxScript' | 'release' | 'macUninstall' | 'linuxUninstall';

export interface InstallerDay {
  readonly day: string;
  macScript: number;
  linuxScript: number;
  /** Release tarballs: an installer that got past its first step. */
  release: number;
  macUninstall: number;
  linuxUninstall: number;
}

export function installerKind(uri: string): InstallerKind | undefined {
  const path = uri.split('?')[0]!;
  if (path === '/install.sh') return 'macScript';
  if (path === '/install-linux.sh') return 'linuxScript';
  if (path === '/uninstall.sh') return 'macUninstall';
  if (path === '/uninstall-linux.sh') return 'linuxUninstall';
  if (/^\/releases\/[^/]+\/[^/]+\.tgz$/.test(path)) return 'release';
  return undefined;
}

function emptyDay(day: string): InstallerDay {
  return { day, macScript: 0, linuxScript: 0, release: 0, macUninstall: 0, linuxUninstall: 0 };
}

/** Adds the downloads in `log` (Caddy JSON lines) to `days`; only complete GETs count. */
export function addDownloads(days: InstallerDay[], log: string): InstallerDay[] {
  const byDay = new Map(days.map((day) => [day.day, { ...day }]));
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    let entry: { ts?: unknown; status?: unknown; request?: { method?: unknown; uri?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.request?.method !== 'GET' || entry.status !== 200 || typeof entry.request.uri !== 'string' || typeof entry.ts !== 'number') continue;
    const kind = installerKind(entry.request.uri);
    if (!kind) continue;
    const day = new Date(entry.ts * 1000).toISOString().slice(0, 10);
    const row = byDay.get(day) ?? emptyDay(day);
    row[kind] += 1;
    byDay.set(day, row);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function readInstallerCounts(path: string): InstallerDay[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { days?: unknown };
    return Array.isArray(parsed.days)
      ? parsed.days.filter((row): row is InstallerDay => typeof (row as InstallerDay)?.day === 'string').map((row) => ({ ...emptyDay(row.day), ...row }))
      : [];
  } catch {
    return [];
  }
}

export function countInstallers(logPath: string, outPath: string): InstallerDay[] {
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const days = addDownloads(readInstallerCounts(outPath), log);
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o755 });
  const temporary = `${outPath}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, days })}\n`, { mode: 0o644 });
  renameSync(temporary, outPath);
  // Counted: the lines go.
  if (log) truncateSync(logPath, 0);
  return days;
}

export function runCountInstallers(argv: readonly string[]): { code: number; out: string } {
  let log = DEFAULT_INSTALLER_LOG;
  let out = DEFAULT_INSTALLER_COUNTS;
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (value === undefined) return { code: 2, out: 'Usage: olympus-relay count-installers [--log <file>] [--out <file>]\n' };
    if (argv[index] === '--log') log = value;
    else if (argv[index] === '--out') out = value;
    else return { code: 2, out: 'Usage: olympus-relay count-installers [--log <file>] [--out <file>]\n' };
  }
  const days = countInstallers(log, out);
  return { code: 0, out: `Counted downloads for ${days.length} day(s) into ${out}.\n` };
}
