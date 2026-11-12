/** Opt-in, sequential end-to-end reads over the canary's real MCP connection. */
import type { EngineMcp } from './live-accounts.ts';
import type { CheckResult } from './report.ts';
import type { SeedFolder, TimingFile, TimingSeeds } from './on-demand-seeds.ts';

export type FolderMode = '' | 'ingest' | 'metadata_only' | 'on_demand' | 'exclude';
export interface TimingDashboard {
  folderMode(folder: SeedFolder): Promise<FolderMode>;
  setFolderMode(folder: SeedFolder, mode: FolderMode): Promise<void>;
  sync(folder: SeedFolder): Promise<void>;
  /** Locate the names-only row first; the returned action presses its real Read this file button. */
  prepareRead(name: string, requireUnread?: boolean): Promise<() => Promise<string>>;
}
export interface TimingDiagnostics {
  preflight(): Promise<string>;
  enableSplit?(): Promise<void>;
  resolve?(file: TimingFile): Promise<TimingFile>;
  begin(file: TimingFile): Promise<void>;
  finish(file: TimingFile): Promise<{ indexed: boolean; jobIds: string[]; log: string; attribution: string }>;
  close(): Promise<void>;
}
export interface TimingReply {
  atSeconds: number; tool: string; text: string; namesFile: boolean; answers: boolean; cited: boolean; reading: boolean;
}
export interface OnDemandTimingRow {
  id: string; file: string; source: string; action: 'question' | 'owner'; t0: string;
  foundFile: boolean; indexed: boolean; foundParagraph: boolean; secondsToAnswer: number | null; elapsedSeconds: number;
  asks: number; firstReply: string; waitMessage: string; replies: TimingReply[];
  jobIds: string[]; steps: Partial<Record<'fetch' | 'extract' | 'judge' | 'embed', number>>;
  timingLog: string; attribution: string; error?: string;
}
export interface OnDemandNotRun { id: string; file: string; source: string; reason: string }
export interface OnDemandTimingResult { notRun?: OnDemandNotRun[]; rows: OnDemandTimingRow[]; checks: CheckResult[]; preflight?: string }
export interface TimingClock { now(): number; sleep(ms: number): Promise<void> }
const realClock: TimingClock = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
const folded = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');

function timingRow(file: TimingFile, started: number, owner: boolean): OnDemandTimingRow {
  return { id: file.id, file: file.name, source: file.source, action: owner ? 'owner' : 'question', t0: new Date(started).toISOString(),
    foundFile: false, indexed: false, foundParagraph: false, secondsToAnswer: null, elapsedSeconds: 0, asks: 0, firstReply: '', waitMessage: '', replies: [], jobIds: [], steps: {}, timingLog: '', attribution: 'not collected' };
}

export function timingSteps(log: string): OnDemandTimingRow['steps'] {
  const steps: OnDemandTimingRow['steps'] = {};
  for (const match of log.matchAll(/\[olympus:on-demand\] step=(fetch|extract|judge|embed) count=\d+ ms=(\d+(?:\.\d+)?)/g)) {
    const step = match[1] as keyof typeof steps;
    steps[step] = (steps[step] ?? 0) + Number(match[2]);
  }
  return steps;
}

/** Check only the answer, never an evidence excerpt, a question echo, or the expected fact in fixture metadata. */
export function timingReply(file: TimingFile, response: Awaited<ReturnType<EngineMcp['call']>>, tool: string, atSeconds: number): TimingReply {
  const result = response.structured as { answer?: unknown; message?: unknown; citations?: Array<{ title?: string }> } | null;
  const text = typeof result?.answer === 'string' ? result.answer : typeof result?.message === 'string' ? result.message : response.text;
  const answers = response.ok && typeof result?.answer === 'string' && folded(result.answer).includes(folded(file.fact));
  const cited = answers && !!result?.citations?.some(c => typeof c.title === 'string' && folded(c.title).includes(folded(file.name)));
  return { atSeconds, tool, text, answers, cited,
    namesFile: folded(text).includes(folded(file.name)) || !!result?.citations?.some(c => typeof c.title === 'string' && folded(c.title).includes(folded(file.name))),
    // A generic "working" message does not tell the user that a file is being read.
    reading: /\b(?:reading|reading\s+\d+|queued\s+(?:to|for)\s+read)\b[^.!?\n]*(?:file|document)|\b(?:file|document)[^.!?\n]*\b(?:being read|reading)\b|^Reading\./i.test(text),
  };
}

export function onDemandChecks(row: OnDemandTimingRow): CheckResult[] {
  const check = (suffix: string, title: string, ok: boolean, detail: string): CheckResult => ({ id: `ondemand.${row.id}.${suffix}`, title: `${row.file}: ${title}`, status: ok ? 'pass' : 'fail', detail });
  return [
    check('slow', 'answer within 30 s', row.secondsToAnswer !== null && row.secondsToAnswer <= 30,
      row.secondsToAnswer === null ? `no answer after ${row.elapsedSeconds.toFixed(1)} s${row.error ? `: ${row.error}` : ''}` : `${row.secondsToAnswer.toFixed(1)} s, ${row.asks} ask(s)`),
    check('silent', 'every reply answers or says a file is being read', row.replies.length > 0 && row.replies.every(reply => reply.answers || reply.reading),
      row.replies.filter(reply => !reply.answers && !reply.reading).map(reply => `${reply.atSeconds.toFixed(1)} s: ${reply.text || '(empty reply)'}`).join('\n') || (row.replies.length ? 'every reply explained the wait or answered' : 'no reply')),
    check('file', 'found the file', row.foundFile, row.foundFile ? 'named in a reply or citation' : 'no reply or citation named the file'),
    check('read', 'read job indexed', row.indexed, row.jobIds.length ? row.jobIds.join(', ') : 'no indexed read job for this provider item and version'),
    check('paragraph', 'fact in answer, cited to this file', row.foundParagraph, row.foundParagraph ? 'fact in answer and file in citations' : 'fact missing or file not cited'),
    check('timings', 'read timings attributable to this file', row.attribution === 'single read in log interval' && Object.keys(row.steps).length === 4,
      `${row.attribution}; ${(['fetch', 'extract', 'judge', 'embed'] as const).map(step => `${step}=${row.steps[step] === undefined ? 'missing' : `${row.steps[step]} ms`}`).join(', ')}`),
  ];
}

export async function timeOnDemandFile(file: TimingFile, engine: EngineMcp, diagnostics: TimingDiagnostics,
  ownerRead?: () => Promise<string>, clock: TimingClock = realClock): Promise<OnDemandTimingRow> {
  await diagnostics.begin(file);
  const started = clock.now();
  const row = timingRow(file, started, !!ownerRead);
  const record = (reply: TimingReply) => {
    row.replies.push(reply);
    row.foundFile ||= reply.namesFile;
    row.foundParagraph ||= reply.cited;
    if (reply.answers && row.secondsToAnswer === null) row.secondsToAnswer = reply.atSeconds;
    row.firstReply = row.replies[0]!.text;
    row.waitMessage = row.replies.filter(r => r.reading).map(r => r.text).filter((v, i, all) => all.indexOf(v) === i).join('\n');
  };
  try {
    if (ownerRead) {
      const text = await ownerRead();
      const reply = timingReply(file, { ok: true, text, structured: null }, 'dashboard:Read this file', (clock.now() - started) / 1000);
      record({ ...reply, namesFile: true });
    }
    let pending: string | undefined;
    for (;;) {
      const remainingMs = 180_000 - (clock.now() - started);
      if (remainingMs <= 0) break;
      const tool = pending ? 'source_answer_result' : 'source_answer';
      if (!pending) row.asks++;
      const response = await engine.call(tool, pending ? { job_id: pending } : { question: file.question }, { timeoutMs: remainingMs });
      if (!response.ok) row.error = response.error ?? 'MCP call failed';
      record(timingReply(file, response, tool, (clock.now() - started) / 1000));
      const result = response.structured as { status?: string; job_id?: string } | null;
      pending = response.ok && result?.status === 'working' && typeof result.job_id === 'string' ? result.job_id : undefined;
      const elapsed = clock.now() - started;
      if (row.secondsToAnswer !== null || elapsed >= 180_000) break;
      const next = Math.min(180_000, Math.floor(elapsed / 10_000 + 1) * 10_000);
      await clock.sleep(next - elapsed);
      if (clock.now() - started >= 180_000) break;
    }
  } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
  row.elapsedSeconds = (clock.now() - started) / 1000;
  try {
    const proof = await diagnostics.finish(file);
    row.indexed = proof.indexed; row.jobIds = proof.jobIds; row.timingLog = proof.log; row.attribution = proof.attribution;
    // Preserve ambiguous raw lines as evidence, without presenting their combined durations as this file's timings.
    row.steps = proof.attribution === 'single read in log interval' ? timingSteps(proof.log) : {};
  } catch (error) { row.error = [row.error, `diagnostics: ${String(error)}`].filter(Boolean).join('; '); }
  return row;
}

export async function runOnDemandTiming(engine: EngineMcp, seeds: TimingSeeds, dashboard: TimingDashboard,
  diagnostics: TimingDiagnostics, clock: TimingClock = realClock, requireUnread = false): Promise<OnDemandTimingResult> {
  const result: OnDemandTimingResult = { rows: [], checks: [] };
  const restore: Array<{ folder: SeedFolder; mode: FolderMode }> = [];
  try {
    result.preflight = await diagnostics.preflight();
    const folders = await seeds.folders();
    const files: TimingFile[] = [];
    for (const folder of folders) {
      // Register recovery before the save: the server may save even when the browser loses its reply.
      restore.push({ folder, mode: await dashboard.folderMode(folder) });
      await dashboard.setFolderMode(folder, 'on_demand');
      files.push(...await seeds.upload(folder));
      await dashboard.sync(folder);
    }
    // On a fresh store, finish listing the entire seed set before the first question can request a read.
    const unavailable = new Map<string, unknown>();
    if (requireUnread) for (const file of files) {
      try { await dashboard.prepareRead(file.name, true); }
      catch (error) { unavailable.set(file.id, error); }
    }
    for (const file of files) {
      try {
        if (unavailable.has(file.id)) throw unavailable.get(file.id);
        // Require an unread row: token seeds have new revisions; browser seeds use a new store.
        if (file.owner) await dashboard.setFolderMode(folders.find(folder => folder.source === file.source)!, 'metadata_only');
        const action = await dashboard.prepareRead(file.name, requireUnread || file.owner === true);
        const resolved = file.providerItemId ? file : await diagnostics.resolve?.(file);
        if (!resolved?.providerItemId || !resolved.version) throw new Error('seed metadata has no provider identity/version');
        const row = await timeOnDemandFile(resolved, engine, diagnostics, file.owner ? action : undefined, clock);
        result.rows.push(row); result.checks.push(...onDemandChecks(row));
        if (file.owner) await dashboard.setFolderMode(folders.find(folder => folder.source === file.source)!, 'on_demand');
      } catch (error) {
        if (!result.rows.some(row => row.id === file.id)) result.rows.push({ ...timingRow(file, clock.now(), file.owner === true), error: `not asked: ${String(error)}` });
        result.checks.push({ id: `ondemand.${file.id}.setup`, title: `${file.name}: names-only file available`, status: 'fail', detail: String(error) });
      }
    }
  } catch (error) {
    result.checks.push({ id: 'ondemand.setup', title: 'Read-on-demand timing setup', status: 'fail', detail: String(error) });
  } finally {
    for (const entry of restore.reverse()) {
      try {
        await dashboard.setFolderMode(entry.folder, entry.mode);
        result.checks.push({ id: `ondemand.${entry.folder.source}.restore`, title: `${entry.folder.source}: previous folder mode restored`, status: 'pass', detail: entry.mode || 'inherited (no explicit selection)' });
      } catch (error) { result.checks.push({ id: `ondemand.${entry.folder.source}.restore`, title: `${entry.folder.source}: previous folder mode restored`, status: 'fail', detail: String(error) }); }
    }
  }
  return result;
}
