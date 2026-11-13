import { rpcCallNames } from './mcp-log.ts';

/** Content-free request metadata. No arbitrary client text crosses this boundary. */
export interface RequestLogEntry {
  at: string;
  surface: 'default' | 'directory';
  install?: string;
  credential?: string;
  lane?: 'owner' | 'unverified' | 'control';
  calls: string;
  status: number;
  ms: number;
}

/** Copy only the permitted fields, validating even an authenticated peer. */
export function parseRequestLogEntry(raw: unknown): RequestLogEntry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== 'string' || r.at.length > 30 || !Number.isFinite(Date.parse(r.at))) return undefined;
  if (r.surface !== 'default' && r.surface !== 'directory') return undefined;
  if (typeof r.calls !== 'string' || r.calls.length > 700) return undefined;
  const calls = r.calls === '' ? [] : r.calls.split(',');
  if (calls.length > 8 || calls.some(call => {
    if (call === '?') return false;
    const [method, name] = call.split(':');
    return rpcCallNames({ method, params: { name } })[0] !== call;
  })) return undefined;
  if (typeof r.status !== 'number' || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) return undefined;
  if (typeof r.ms !== 'number' || !Number.isSafeInteger(r.ms) || r.ms < 0) return undefined;
  for (const key of ['install', 'credential']) if (r[key] !== undefined && (typeof r[key] !== 'string' || !/^[a-f0-9]{8}$/.test(r[key] as string))) return undefined;
  if (r.lane !== undefined && r.lane !== 'owner' && r.lane !== 'unverified' && r.lane !== 'control') return undefined;
  return {
    at: r.at, surface: r.surface, calls: r.calls, status: r.status, ms: r.ms,
    ...(r.install === undefined ? {} : { install: r.install as string }),
    ...(r.credential === undefined ? {} : { credential: r.credential as string }),
    ...(r.lane === undefined ? {} : { lane: r.lane as NonNullable<RequestLogEntry['lane']> }),
  };
}
