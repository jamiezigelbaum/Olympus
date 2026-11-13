import { createHash as requestsHash } from 'node:crypto';
import { readFileSync as requestsRead, statSync as requestsStat } from 'node:fs';
import { mkdir as requestsMkdir, writeFile as requestsWrite, rename as requestsRename } from 'node:fs/promises';
import { dirname as requestsDirname, join as requestsJoin } from 'node:path';
import { parseRequestLogEntry, type RequestLogEntry } from '../../connect-relay/shared/request-log.ts';

export const RELAY_REQUEST_LOG_PATH = '/relay/request-log';
export const CONNECTION_REQUEST_LIMIT = 200;
export const UNKNOWN_CONNECTION = 'an unknown connection';
export interface ConnectionRequest extends RequestLogEntry {
  source: 'relay' | 'engine';
  app: string;
  relayed?: boolean;
}
export const connectionRequestsPath = (connectionsDbPath: string): string => requestsJoin(requestsDirname(connectionsDbPath), 'connection-requests.json');

/** The same construction as relay server/log.ts, over the stored SHA-256 digest. */
export function requestCredentialTag(digest: Uint8Array): string {
  return requestsHash('sha256').update('olympus-relay-log-credential\n').update(digest).digest('hex').slice(0, 8);
}

export function readConnectionRequests(path: string): ConnectionRequest[] {
  try {
    if (requestsStat(path).size > 512 * 1024) return [];
    const raw: unknown = JSON.parse(requestsRead(path, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.slice(-CONNECTION_REQUEST_LIMIT).flatMap((row: unknown) => {
      const entry = parseRequestLogEntry(row);
      const r = row as Partial<ConnectionRequest> | null;
      if (!entry || !r || (r.source !== 'engine' && r.source !== 'relay') || typeof r.app !== 'string' || r.app.length > 200) return [];
      return [{ ...entry, source: r.source, app: r.app, ...(typeof r.relayed === 'boolean' ? { relayed: r.relayed } : {}) }];
    });
  } catch { return []; }
}

/** One writer (the engine), atomic snapshots for the separate CLI process. */
export class ConnectionRequestStore {
  private entries: ConnectionRequest[];
  private writing: Promise<void> | undefined;
  private dirty = false;
  constructor(readonly path: string, private readonly resolveApp: (credential: string) => string | undefined = () => undefined) {
    this.entries = readConnectionRequests(path);
  }
  list(): ConnectionRequest[] { return this.entries.map(entry => ({ ...entry })); }
  record(entry: RequestLogEntry, source: 'relay' | 'engine', app?: string, relayed?: boolean): void {
    const safe = parseRequestLogEntry(entry);
    if (!safe) return;
    let name = app;
    try { name ??= safe.credential ? this.resolveApp(safe.credential) : undefined; } catch { /* Diagnostics never break a request. */ }
    this.entries.push({ ...safe, source, app: name?.slice(0, 200) || UNKNOWN_CONNECTION, ...(relayed === undefined ? {} : { relayed }) });
    this.entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    this.entries = this.entries.slice(-CONNECTION_REQUEST_LIMIT);
    this.dirty = true;
    if (!this.writing) this.writing = this.persist();
  }
  private async persist(): Promise<void> {
    try {
      await requestsMkdir(requestsDirname(this.path), { recursive: true, mode: 0o700 });
      while (this.dirty) {
        this.dirty = false;
        await requestsWrite(`${this.path}.tmp`, JSON.stringify(this.entries), { mode: 0o600 });
        await requestsRename(`${this.path}.tmp`, this.path);
      }
    } catch { /* Memory history remains available if the state directory is unwritable. */ }
    finally { this.writing = undefined; }
  }
  async flush(): Promise<void> { await this.writing; }
}

export function connectionRequestsView(entries: readonly ConnectionRequest[], apps: readonly string[] = [], now = new Date()): {
  title: string; readings: string[]; requests: Array<ConnectionRequest & { asked: string; result: string }>; summary: string;
} {
  const ordered = [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const readings = [...new Set([...apps, ...ordered.map(e => e.app)])].map(app => {
    const recent = ordered.filter(e => e.app === app && Date.parse(e.at) >= now.getTime() - 3600_000 && Date.parse(e.at) <= now.getTime());
    // Count each relayed request on the relay's side; engine observations remain
    // visible as separate rows. Old relays supply only engine observations.
    const hasRelay = recent.some(e => e.source === 'relay');
    const lists = recent.filter(e => e.calls.split(',').includes('tools/list') && (e.source === 'relay' || !e.relayed || !hasRelay));
    if (!lists.length) return `${app} has not asked for Olympus's tool list in the last hour of recorded history.`;
    const failures = lists.filter(e => e.status >= 400).length;
    return `${app} asked for the tool list ${lists.length} ${lists.length === 1 ? 'time' : 'times'} in the last hour; ${failures ? `${failures} ${failures === 1 ? 'request failed' : 'requests failed'}` : 'all answered'}.`;
  });
  const requests = ordered.slice(0, 20).map(entry => ({ ...entry,
    asked: entry.calls.split(',').filter(Boolean).map(call => call === 'tools/list' ? 'Tool list' : call === 'initialize' ? 'Connect' : call.startsWith('tools/call:') ? `Run ${call.slice(11)}` : call === '?' ? 'Other request' : call).join(', ') || 'Connection request',
    result: `${entry.status < 400 ? 'Answered' : 'Failed'} (${entry.status}) — ${entry.source === 'relay' ? 'relay' : 'engine'}`,
  }));
  return { title: 'Recent requests from your AI apps', readings, requests,
    summary: requests.length ? `${entries.length} recent request ${entries.length === 1 ? 'observation' : 'observations'}; latest ${ordered[0]!.at} (${ordered[0]!.source}).` : 'No requests recorded yet.' };
}
