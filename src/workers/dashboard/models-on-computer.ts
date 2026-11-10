/**
 * Settings › Models on this computer (owner, 2026-11-10, lane 4 mockup 8;
 * #1043, #1085): which models answer Private questions, in the saved route's
 * order; the built-in model's download state and whether that route uses it;
 * and transcription, with the one cause that applies when it is off.
 *
 * The private-answer line is read from the saved route, never from what
 * could run here: a built-in model that is downloaded but not in the route is
 * not the model that answers (#1043).
 */
import type { SovereigntyConfig } from '../../core/sovereignty.ts';
import type { LocalModelReadiness } from '../../core/linux-model-readiness.ts';

export interface DashboardModelsOnComputer {
  /**
   * `off`: Private items are never answered (the route is disabled).
   * `first`/`fallback`: an explicit fallback chain (the pool's `order`, or a legacy `analyst` list).
   * `any`: a pool with no `order`, where each question goes to the healthiest, fastest member.
   */
  privateAnswers: { off: true } | { first: string; fallback?: string } | { any: string[] } | { unknown: true };
  builtIn?: { name: string; state: string; used: boolean };
  transcription?: { line: string };
}

export interface DashboardModelsOnComputerInput {
  config: SovereigntyConfig | undefined;
  /**
   * The built-in model answers for the route's local member now (its own
   * model server is not running): model-choices' local picker lists built-in
   * sizes exactly then.
   */
  builtInAnswers: boolean;
  /** The worker's built-in model readiness rows (Linux), when this worker reports them. */
  readiness?: readonly LocalModelReadiness[];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/**
 * The saved Private route's members, and whether they are tried in that order.
 * As the engine dispatches (sovereignty.ts resolveAnalystPool, and
 * source-dashboard.ts modelLaneLabels): a pool's `order` (kept to its members)
 * is a fallback chain, a legacy `analyst` list is ordered, and a pool with no
 * `order` picks by health and latency, so none of its members is "first".
 */
function routeMembers(config: SovereigntyConfig): { ids: string[]; ordered: boolean } {
  const route = config.routes?.secure_local;
  if (route?.pool) {
    const members = route.pool.members ?? [];
    if (route.pool.order) return { ids: route.pool.order.filter((id) => members.includes(id)), ordered: true };
    return { ids: [...members], ordered: members.length <= 1 };
  }
  return { ids: [...(route?.analyst ?? [])], ordered: true };
}

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const host = new URL(baseUrl).hostname;
    return host && !LOOPBACK_HOSTS.has(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** One route member in the owner's words: "Qwen 3.6 35B on delphi.local", "Venice". */
function memberName(config: SovereigntyConfig, id: string, builtIn: { answers: boolean; name?: string }): string | undefined {
  const profile = config.modelProfiles?.[id];
  if (!profile) return undefined;
  const model = 'model' in profile && typeof profile.model === 'string' && profile.model.trim() ? profile.model.trim() : undefined;
  switch (profile.provider) {
    case 'local-openai-compatible': {
      if (builtIn.answers) return `${builtIn.name ?? 'the built-in model'} on this computer`;
      const host = hostOf(profile.baseUrl);
      return `${model ?? 'your model server'} on ${host ?? 'this computer'}`;
    }
    case 'venice':
      return 'Venice';
    case 'openclaw-infer':
      return model ?? "your OpenClaw agent's model";
    default:
      return model ?? String(profile.provider);
  }
}

const BUILT_IN_STATES: Readonly<Record<string, string>> = {
  ready: 'downloaded',
  loading: 'downloaded',
  not_started: 'not downloaded',
  downloading: 'downloading',
  verifying: 'checking the download',
  failed: 'download failed',
};

const TRANSCRIPTION_STATES: Readonly<Record<string, string>> = {
  ready: 'ready',
  loading: 'starting',
  not_needed: 'not downloaded: it downloads when you add audio',
  not_downloaded: 'not downloaded',
  interrupted: 'download interrupted',
  downloading: 'downloading',
  verifying: 'checking the download',
  failed: 'download failed',
  load_failed: "couldn't start",
};

export function dashboardModelsOnComputer(input: DashboardModelsOnComputerInput): DashboardModelsOnComputer {
  const rows = input.readiness ?? [];
  const privateRow = rows.find((row) => row.name === 'Private answers');
  const transcriptionRow = rows.find((row) => row.name === 'Transcription');
  const config = input.config;
  let privateAnswers: DashboardModelsOnComputer['privateAnswers'] = { unknown: true };
  let usesLocal = false;
  if (config) {
    if (config.routes?.secure_local?.mode === 'disabled') privateAnswers = { off: true };
    else {
      const { ids, ordered } = routeMembers(config);
      usesLocal = ids.some((id) => config.modelProfiles?.[id]?.provider === 'local-openai-compatible');
      const names = ids
        .map((id) => memberName(config, id, { answers: input.builtInAnswers, ...(privateRow?.model ? { name: privateRow.model } : {}) }))
        .filter((name): name is string => !!name);
      if (!ordered && names.length > 1) privateAnswers = { any: names };
      else if (names.length) privateAnswers = { first: names[0]!, ...(names[1] ? { fallback: names[1] } : {}) };
    }
  }
  const out: DashboardModelsOnComputer = { privateAnswers };
  if (privateRow) {
    const state = privateRow.state === 'unavailable'
      ? `not available: ${privateRow.cause ?? privateRow.detail}`
      : BUILT_IN_STATES[privateRow.state] ?? privateRow.state;
    out.builtIn = { name: privateRow.model ?? 'Built-in private model', state, used: usesLocal && input.builtInAnswers };
  }
  if (transcriptionRow) {
    const line = transcriptionRow.state === 'unavailable'
      ? (transcriptionRow.cause ? `off: ${transcriptionRow.cause}` : transcriptionRow.detail)
      : TRANSCRIPTION_STATES[transcriptionRow.state] ?? transcriptionRow.state;
    out.transcription = { line };
  }
  return out;
}
