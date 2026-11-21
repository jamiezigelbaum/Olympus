import type { ModelSetupView } from '../../src/core/model-setup.ts';
import { DEFAULT_VENICE_ANALYST_MODEL } from '../../src/core/analyst-venice.ts';
import { buildEnvBridgeSovereigntyConfig, loadSovereigntyEngine, type SovereigntyResolvedProfile } from '../../src/core/sovereignty.ts';
import { STRONGEST_MODEL, validModelId } from '../../src/core/model-choices.ts';
import { secretLabelsInText } from '../../src/core/opsec.ts';
import { factsIn } from './inbox-page.ts';
import { evaluateSmokeVerdict } from './suite.ts';
import { forbiddenFor, redactForbidden, type ClientQuestion } from './client-questions.ts';
import type { CheckResult } from './report.ts';

const STALL_MS = 5 * 60_000;
const MODEL_WAIT_MS = 30 * 60_000;
const POLL_MS = 3_000;

type ModelReadiness = Pick<ModelSetupView, 'ready' | 'private_model'>;

/** A retry resets the byte count. Only forward movement or the start of verification resets the stall clock. */
export async function waitForCanaryModels(
  probe: (remainingMs: number) => Promise<ModelReadiness | undefined>,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<{ ms: number; problem?: string }> {
  const started = clock.now();
  let lastProgress = started;
  let bytes = 0;
  let verifying = false;
  for (;;) {
    const deadline = Math.min(started + MODEL_WAIT_MS, lastProgress + STALL_MS);
    const before = clock.now();
    if (before < deadline) {
      const setup = await probe(deadline - before);
      const now = clock.now();
      if (now < started + MODEL_WAIT_MS) {
        if (setup?.ready) return { ms: now - started };
        const state = setup?.private_model;
        const done = state?.bytesDone ?? 0;
        if (done > bytes || (state?.state === 'verifying' && !verifying)) lastProgress = now;
        if (state?.bytesDone !== undefined) bytes = done;
        if (state?.state === 'verifying') verifying = true;
      }
    }
    const now = clock.now();
    const ms = now - started;
    if (ms >= MODEL_WAIT_MS) return { ms, problem: 'Private models were not ready within 30 minutes' };
    if (now - lastProgress >= STALL_MS) return { ms, problem: `Private models made no progress for 5 minutes (${bytes} download bytes seen)` };
    await clock.sleep(Math.min(POLL_MS, started + MODEL_WAIT_MS - now, lastProgress + STALL_MS - now));
  }
}

export interface CanarySmokeSettings {
  private_answer_mode?: { id?: string };
  models?: { local?: { current?: string }; venice?: { current?: string; strongest_now?: string } } | null;
}

export function canaryPrivateRoute(settings: CanarySmokeSettings | undefined, env: Record<string, string | undefined>) {
  let routes: readonly SovereigntyResolvedProfile[] = [];
  let configured: ReturnType<typeof loadSovereigntyEngine>['config']['modelProfiles'] = {};
  try {
    const engine = loadSovereigntyEngine({ env });
    configured = engine.config.modelProfiles;
    const pool = engine.resolveAnalystPool({ trustDomain: 'secure_local' });
    routes = pool.explicitOrder ?? pool.members;
  } catch { /* no-sensitive and pending setup have no routable pool */ }
  if (routes[0]) return { routes, model: routes[0] };
  const bridge = buildEnvBridgeSovereigntyConfig(env).modelProfiles;
  const local = settings?.models?.local?.current;
  const venice = settings?.models?.venice?.current;
  if (local?.startsWith('builtin:') && settings?.private_answer_mode?.id !== 'private-cloud-only') return { routes, model: undefined };
  const externalLocal = local || env.OLYMPUS_ARGUS_SOURCE_ANSWER_BASE_URL?.trim() || env.OLYMPUS_ARGUS_SOURCE_ANSWER_MODEL?.trim()
    || env.OLYMPUS_ARGUS_FAST_BASE_URL?.trim() || env.OLYMPUS_ARGUS_FAST_MODEL?.trim();
  const configuredVenice = configured['venice-private'] ?? bridge['venice-private'] ?? (venice
    ? { provider: 'venice' as const, trust: 'encrypted_cloud' as const, model: DEFAULT_VENICE_ANALYST_MODEL } : undefined);
  if (configuredVenice && (!externalLocal || settings?.private_answer_mode?.id === 'private-cloud-only')) {
    return { routes, model: { id: 'venice-private', profile: configuredVenice } };
  }
  const profile = configured['local-source-answer'] ?? bridge['local-source-answer'];
  return { routes, model: externalLocal && profile ? { id: 'local-source-answer', profile } : undefined };
}

const safeModelId = (value: unknown): value is string => validModelId(value) && !value.includes('://')
  && !/:[^/]*@/.test(value) && secretLabelsInText(value).length === 0;

/** Report only the selected model, mode and endpoint host. Credentials in a URL never cross the machine boundary. */
export function describeCanaryPrivateModel(settings: CanarySmokeSettings | undefined, member: SovereigntyResolvedProfile | undefined, installedBuiltIn?: string): string {
  const mode = settings?.private_answer_mode?.id || 'unknown';
  const profile = member?.profile;
  const local = settings?.models?.local?.current;
  const venice = settings?.models?.venice;
  const builtIn = profile?.provider === 'built-in' ? profile.model
    : local?.startsWith('builtin:') && (!profile || profile.provider === 'local-openai-compatible') ? installedBuiltIn ?? local
    : !profile && !local ? installedBuiltIn : undefined;
  if (safeModelId(builtIn)) return `${builtIn} (built into Olympus on this machine; mode ${mode})`;
  const selected = profile?.provider === 'venice' ? venice?.strongest_now || (venice?.current !== STRONGEST_MODEL ? venice?.current : undefined)
    : profile?.provider === 'local-openai-compatible' ? local : undefined;
  const model = selected || profile?.model;
  let host: string | undefined;
  try {
    host = profile?.baseUrl ? new URL(profile.baseUrl).host : profile?.provider === 'venice' ? 'api.venice.ai' : undefined;
  } catch { /* no usable endpoint */ }
  return `${safeModelId(model) ? model : 'unknown'} (${[profile?.provider, host].filter(Boolean).join(' via ') || 'endpoint unknown'}; mode ${mode})`;
}

export interface CanarySmokeRow {
  id: string;
  isError?: boolean;
  searchMs?: number;
  factsStated: boolean[];
  forbiddenStated: boolean[];
  cited: boolean;
  noteKind?: string;
  secretPointer: boolean;
  privateAnswer?: { factsStated: boolean[]; cited: boolean };
  panel?: { totalMs: number; status?: string };
}

export function canarySmokeChecks(questions: readonly ClientQuestion[], receipt: {
  ok?: boolean; exit?: number; detail?: string; smokeChecks?: string[]; results?: CanarySmokeRow[];
} | undefined, code: number): CheckResult[] {
  const forbidden = questions.flatMap(q => [...q.forbid ?? [], ...q.panel_expect ?? []]);
  const safe = (value: string) => redactForbidden(value, forbidden);
  const rows = receipt?.results;
  if (!receipt?.ok || !rows?.length) {
    const detail = receipt?.detail || receipt?.smokeChecks?.join('; ') || `no results (exit ${code})`;
    return [{ id: 'protocol.ran', title: 'The ChatGPT-protocol pass ran', status: 'fail', detail: safe(detail) }];
  }
  const checks = [evaluateSmokeVerdict(receipt.exit, (receipt.smokeChecks ?? []).map(safe), [])];
  for (const q of questions) {
    const row = rows.find(row => row.id === q.id);
    const add = (id: string, title: string, ok: boolean, detail: string, ms = row?.searchMs) => {
      checks.push({ id: `canary.smoke.${q.id}.${id}`, title: `${q.id}: ${title}`, status: ok ? 'pass' : 'fail', detail, ...(ms !== undefined ? { ms } : {}) });
    };
    if (!row || row.isError) add('ran', 'the tool answered', false, row ? 'the tool returned an error' : 'no result for this question');
    if (!row) continue;
    const leaked = row.forbiddenStated.filter(Boolean).length;
    add('no-leak', 'the tool kept forbidden content private', leaked === 0, `${leaked} of ${row.forbiddenStated.length} forbidden string(s) appeared`);
    if (q.expect?.length) {
      const stated = row.factsStated.filter(Boolean).length;
      add('facts', 'the tool returned the expected facts', !row.isError && stated === q.expect.length, `${stated} of ${q.expect.length} expected fact(s) stated`);
    }
    if (q.kind === 'private') {
      add('private-note', 'the tool gave the Private pointer', !!row.noteKind, row.noteKind ?? 'no Private pointer');
      const stated = row.privateAnswer?.factsStated.filter(Boolean).length ?? 0;
      const expected = q.panel_expect?.length ?? 0;
      add('local-private-answer', 'the private answer panel states the expected facts', !!row.privateAnswer && stated === expected,
        row.privateAnswer ? `${stated} of ${expected} expected fact(s) stated` : `no private answer was produced (${row.panel?.status ?? row.noteKind ?? 'no panel'})`, row.panel?.totalMs);
    }
    if (q.kind === 'secret') add('refused', 'the tool gave the Secret pointer', row.secretPointer, row.secretPointer ? 'Secret pointer returned' : 'no Secret pointer');
    if (q.cite?.length) {
      const cited = q.kind === 'private' ? row.privateAnswer?.cited === true : row.cited;
      add('cited', 'an expected source item is cited', !row.isError && cited, cited ? 'matched an expected citation' : 'no expected citation matched');
    }
  }
  return checks;
}

export function canarySmokeExpectations(q: ClientQuestion, questions: readonly ClientQuestion[]) {
  const shared = questions.flatMap(other => other.forbid ?? []);
  return {
    publicFacts: q.expect ?? [],
    forbidden: forbiddenFor(q, shared),
    privateFacts: q.panel_expect ?? [],
    citations: q.cite ?? [],
  };
}

export function canaryCitationMatches(citations: readonly { title?: string; source?: string }[], expected: readonly string[]): boolean {
  return citations.some(({ title, source }) => [title, source].some(value => !!value && factsIn(value, expected).some(Boolean)));
}
