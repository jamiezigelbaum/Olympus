/**
 * The live-accounts canary (release testing design, layer 5): the canary machine's Olympus connected to real test accounts
 * (Gmail, Dropbox, Telegram, WhatsApp, whatever the accounts file lists), asked the way a connected agent asks it, over the
 * engine's own MCP endpoint on the machine.
 *
 * For each source:
 *   - status: `source_index_status` has it set up with items indexed, and its newest refresh finished recently, not failed;
 *   - known item: `olympus_search` for the source's known question returns an item labelled with the source that holds
 *     every expected string (the accounts were loaded with that data once, by hand);
 *   - fresh item (optional): a command on this computer plants a new item carrying a one-time word through the real
 *     account (an email sent, a file uploaded), and a search must find it, labelled with the source, within the bound.
 *     It proves live sync after an update; it is off unless the source names a `plant` command.
 * The connection the checks use is made for the run (`olympus connections add`) and revoked at its end.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';

export interface LiveSourceSpec {
  /** Short id for the checks, for example "gmail". */
  id: string;
  /** The source's label as Olympus shows it and cites it: "Gmail", "Dropbox", "Telegram", "WhatsApp". */
  label: string;
  /** How old the last sync may be (hours); 24 when left out. */
  maxSyncAgeH?: number;
  known?: { question: string; expect: string[] };
  plant?: {
    /** Run on this computer with OLYMPUS_CANARY_WORD, OLYMPUS_CANARY_SUBJECT and OLYMPUS_CANARY_BODY set; exit 0 when planted. */
    argv: string[];
    /** How long the planted item may take to become searchable (seconds); 900 when left out. */
    withinS?: number;
  };
}

export interface SearchEvidence { source: string; title: string; excerpt: string }

/** Talks to the engine's MCP endpoint on the machine, as a connected agent does. */
export interface EngineMcp {
  call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; structured: unknown; error?: string }>;
  close(): Promise<void>;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const fold = (text: string): string => text.replace(/[  \s]+/g, ' ').toLowerCase();

/**
 * One MCP request on the machine: initialize, then the call, with the run's connection token. macOS: the engine's loopback
 * port; Linux: the worker's owner socket (the engine listens on no port there). Prints the call's raw response body.
 */
export function mcpCallScript(os: 'linux' | 'macos', tokenPath: string, body: unknown): string {
  const via = os === 'linux' ? '--unix-socket "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/olympus/worker.sock"' : '';
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-canary', version: '1' } } };
  return `set -euo pipefail
token="$(cat "$HOME/${tokenPath}")"
h="$(mktemp)"; trap 'rm -f "$h"' EXIT
post() { curl -sS --max-time 120 ${via} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "authorization: Bearer $token" "$@" http://127.0.0.1:8010/mcp; }
post -D "$h" -o /dev/null --data ${shellQuote(JSON.stringify(init))}
# The endpoint is stateless today and issues no session; one that does gets it back. (The guarded expansion keeps macOS's
# bash 3.2 from calling an empty array unbound.)
sid="$(tr -d '\\r' < "$h" | awk 'tolower($1)=="mcp-session-id:" {print $2}')"
session=(); [ -z "$sid" ] || session=(-H "mcp-session-id: $sid")
post \${session[@]+"\${session[@]}"} -o /dev/null --data '{"jsonrpc":"2.0","method":"notifications/initialized"}'
post \${session[@]+"\${session[@]}"} --data ${shellQuote(JSON.stringify(body))}`;
}

/** The JSON-RPC message in a response body, plain or as server-sent events. */
export function parseRpc(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).pop();
  return data ? JSON.parse(data) : {};
}

const TOKEN_PATH = '.olympus-canary/mcp-token';

/** Makes the run's connection on the machine and keeps its token there (never here). */
export async function openEngineMcp(machine: Machine): Promise<EngineMcp> {
  const made = await machine.exec(`set -euo pipefail
mkdir -p "$HOME/.olympus-canary"; umask 077
out="$("$HOME/.local/bin/olympus" connections add release-canary)"
printf '%s' "$out" | sed -n 's/.*"token": *"\\([^"]*\\)".*/\\1/p' | head -1 > "$HOME/${TOKEN_PATH}"
[ -s "$HOME/${TOKEN_PATH}" ] || { echo "connections add printed no token"; exit 1; }
printf '%s' "$out" | tr -d '\\n' | sed -n 's/.*"connection": *{[^}]*"id": *"\\([^"]*\\)".*/\\1/p'`, { timeoutMs: 60_000 });
  if (made.code !== 0) throw new Error(`olympus connections add failed: ${(made.stdout + made.stderr).trim().slice(-300)}`);
  const connectionId = made.stdout.trim();
  let nextId = 2;
  return {
    call: async (tool, args) => {
      const result = await machine.exec(mcpCallScript(machine.os, TOKEN_PATH, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: tool, arguments: args } }), { timeoutMs: 180_000 });
      if (result.code !== 0) return { ok: false, text: '', structured: null, error: (result.stderr.trim() || `exit ${result.code}`).slice(0, 300) };
      let message: any;
      try { message = parseRpc(result.stdout); } catch { return { ok: false, text: '', structured: null, error: `the engine answered something that is not JSON: ${result.stdout.slice(0, 160)}` }; }
      const out = message.result ?? {};
      const text = ((out.content ?? []) as Array<{ type: string; text?: string }>).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
      const error = message.error?.message ?? (out.isError ? text.slice(0, 300) : undefined);
      return { ok: !error, text, structured: out.structuredContent ?? null, ...(error ? { error: String(error) } : {}) };
    },
    close: async () => {
      const revoke = /^[A-Za-z0-9_-]+$/.test(connectionId) ? `"$HOME/.local/bin/olympus" connections revoke ${connectionId} >/dev/null 2>&1 || true; ` : '';
      await machine.exec(`${revoke}rm -f "$HOME/${TOKEN_PATH}"`, { timeoutMs: 60_000 });
    },
  };
}

/** One corpus as the remote `source_index_status` reports it (core/remote-result.ts): a source has one per tier it writes. */
export interface CorpusRow {
  corpus_id: string;
  label: string;
  configured: boolean;
  retrieval?: { mode: string; state: string };
  last_refresh?: { status: string; completed_at?: string };
  counts?: { indexed_items: number };
}

export function corpusRows(structured: unknown): CorpusRow[] {
  const rows = (structured as { corpora?: unknown } | null)?.corpora;
  return Array.isArray(rows) ? rows.filter((row): row is CorpusRow => typeof row?.label === 'string' && typeof row?.corpus_id === 'string') : [];
}

export function evidenceOf(structured: unknown): SearchEvidence[] {
  const rows = (structured as { evidence?: unknown } | null)?.evidence;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({ source: String(row?.source ?? ''), title: String(row?.title ?? ''), excerpt: String(row?.excerpt ?? '') }));
}

/** Connected and syncing: a configured corpus of the source holds items, and its newest refresh finished recently and did not fail. */
export function statusCheck(spec: LiveSourceSpec, rows: readonly CorpusRow[], now = Date.now()): CheckResult {
  const id = `live.${spec.id}.status`;
  const title = `${spec.label}: connected and syncing`;
  const own = rows.filter((row) => fold(row.label) === fold(spec.label) && row.configured);
  if (own.length === 0) return { id, title, status: 'fail', detail: `Olympus has no ${spec.label} source set up (it has ${[...new Set(rows.filter((r) => r.configured).map((r) => r.label))].join(', ') || 'none'})` };
  const items = own.reduce((sum, row) => sum + (row.counts?.indexed_items ?? 0), 0);
  const refreshed = own.map((row) => row.last_refresh).filter((r): r is NonNullable<CorpusRow['last_refresh']> => Boolean(r));
  const newest = refreshed.filter((r) => r.completed_at).sort((a, b) => Date.parse(b.completed_at!) - Date.parse(a.completed_at!))[0];
  const said = `${own.length} corpus(es), ${items} item(s) indexed${newest ? `, last refresh ${newest.status} at ${newest.completed_at}` : ''}`;
  if (items === 0) return { id, title, status: 'fail', detail: `${said}: nothing indexed yet` };
  if (refreshed.length > 0 && refreshed.every((r) => r.status === 'failed')) return { id, title, status: 'fail', detail: `${said}: every refresh failed` };
  const maxAgeH = spec.maxSyncAgeH ?? 24;
  const running = refreshed.some((r) => r.status === 'running');
  if (!running && newest && now - Date.parse(newest.completed_at!) > maxAgeH * 3_600_000) return { id, title, status: 'fail', detail: `${said}: more than ${maxAgeH} h ago` };
  const degraded = own.some((row) => row.retrieval?.state === 'degraded');
  return { id, title, status: degraded ? 'warn' : 'pass', detail: `${said}${running ? '; a refresh is running' : ''}${degraded ? '; search is degraded' : ''}` };
}

/** The search found an item of this source holding every needle. */
export function searchCheck(id: string, title: string, label: string, needles: readonly string[], search: { ok: boolean; structured: unknown; error?: string }): CheckResult {
  if (!search.ok) return { id, title, status: 'fail', detail: `the search failed: ${search.error ?? 'no answer'}` };
  const evidence = evidenceOf(search.structured);
  const own = evidence.filter((item) => fold(item.source) === fold(label));
  const hit = own.find((item) => needles.every((needle) => fold(`${item.title} ${item.excerpt}`).includes(fold(needle))));
  if (hit) return { id, title, status: 'pass', detail: `"${hit.title.slice(0, 80)}", labelled ${label}` };
  return { id, title, status: 'fail', detail: `${evidence.length} item(s) came back, ${own.length} labelled ${label}, none holding all ${needles.length} expected string(s)${evidence.length ? `; sources: ${[...new Set(evidence.map((item) => item.source))].join(', ')}` : ''}` };
}

export interface LiveAccountsOptions {
  sources: LiveSourceSpec[];
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Runs a plant command; tests replace it. */
  runPlant?: (argv: readonly string[], env: Record<string, string>) => { code: number; output: string };
}

const defaultPlant = (argv: readonly string[], env: Record<string, string>): { code: number; output: string } => {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
};

export async function runLiveAccounts(engine: EngineMcp, options: LiveAccountsOptions): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const pollMs = options.pollMs ?? 30_000;
  const runPlant = options.runPlant ?? defaultPlant;
  let started = Date.now();
  const status = await engine.call('source_index_status', {});
  const rows = status.ok ? corpusRows(status.structured) : [];
  for (const spec of options.sources) {
    checks.push(status.ok ? { ...statusCheck(spec, rows), ms: Date.now() - started } : { id: `live.${spec.id}.status`, title: `${spec.label}: connected and syncing`, status: 'fail', detail: `source_index_status failed: ${status.error ?? 'no answer'}` });
  }
  for (const spec of options.sources) {
    if (!spec.known) continue;
    started = Date.now();
    const search = await engine.call('olympus_search', { question: spec.known.question, limit: 24 });
    checks.push({ ...searchCheck(`live.${spec.id}.known`, `${spec.label}: a known item is found and cited as ${spec.label}`, spec.label, spec.known.expect, search), ms: Date.now() - started });
  }
  // Fresh items: every plant first, then one search loop, so the sources' sync intervals overlap instead of adding up.
  const planted: Array<{ spec: LiveSourceSpec; word: string; deadline: number; started: number }> = [];
  for (const spec of options.sources) {
    if (!spec.plant) continue;
    started = Date.now();
    const word = `olycanary${randomBytes(5).toString('hex')}`;
    const env = { OLYMPUS_CANARY_WORD: word, OLYMPUS_CANARY_SUBJECT: `Release canary ${word}`, OLYMPUS_CANARY_BODY: `Release canary check ${word}. Olympus test data; safe to delete.` };
    const result = runPlant(spec.plant.argv, env);
    if (result.code !== 0) {
      checks.push({ id: `live.${spec.id}.fresh`, title: `${spec.label}: a new item is found within the bound`, status: 'skip', detail: `Inconclusive: the plant command failed (exit ${result.code}): ${result.output.slice(-200)}` });
      continue;
    }
    planted.push({ spec, word, deadline: Date.now() + (spec.plant.withinS ?? 900) * 1000, started });
  }
  const waiting = new Set(planted);
  while (waiting.size > 0) {
    for (const row of [...waiting]) {
      const search = await engine.call('olympus_search', { question: row.word, limit: 24 });
      const title = `${row.spec.label}: a new item is found within ${row.spec.plant!.withinS ?? 900} s`;
      const result = searchCheck(`live.${row.spec.id}.fresh`, title, row.spec.label, [row.word], search);
      if (result.status === 'pass' || Date.now() >= row.deadline) {
        const ms = Date.now() - row.started;
        checks.push({ ...result, detail: result.status === 'pass' ? `found after ${Math.round(ms / 1000)} s: ${result.detail}` : `not found after ${Math.round(ms / 1000)} s: ${result.detail}`, ms });
        waiting.delete(row);
      }
    }
    if (waiting.size > 0) await sleep(pollMs);
  }
  return checks;
}
