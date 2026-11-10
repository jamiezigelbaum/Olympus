/**
 * The one setup checklist (#1077): the list of setup steps, their states, and
 * the one way forward from each. The CLI (`olympus setup status`), the local
 * agent tool (`olympus_setup_status`) and the dashboard's Home all show what
 * this module builds, so the owner's agent and the dashboard never disagree
 * about what is done and what is next.
 *
 * Deterministic: facts in, checklist out. Reading the facts is the caller's
 * job (the worker reads them from the same places the dashboard does:
 * the first-run privacy policy, the judge's spending record, the dashboard
 * view's sources and counts, and the remote connections registry).
 *
 * Names and states only. A step never carries item content, file names,
 * keys or tokens; names that look like a credential are replaced.
 *
 * Who may change what does not move here: a step whose way forward changes
 * what is private, who has access or what Olympus spends points at the
 * dashboard (`kind: 'owner'`), where only the owner's click applies it. An
 * agent may run a `kind: 'command'` step itself; those commands only read or
 * diagnose.
 */

export const SETUP_STEP_IDS = [
  'installed',
  'private_answers',
  'privacy_judge',
  'sources',
  'messaging_chats',
  'ai_app',
  'first_items',
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
export type SetupStepState = 'done' | 'next' | 'todo' | 'skipped';

/** Why a step needs the owner's click. One of three, never free text. */
export type SetupOwnerReason = 'privacy' | 'access' | 'spending';

export const SETUP_OWNER_WHY: Readonly<Record<SetupOwnerReason, string>> = {
  privacy: 'Needs your click because it changes what is private.',
  access: 'Needs your click because it changes who has access.',
  spending: 'Needs your click because it changes what Olympus spends.',
};

/** Dashboard addresses each owner step opens: the page and the exact section. */
export const SETUP_DASHBOARD_LINKS = {
  privateAnswers: '/dashboard?keys#private-routing',
  privacyJudge: '/dashboard?keys#privacy-judge',
  addSource: '/dashboard?connect#add-source',
  sources: '/dashboard?connect#sources',
  agents: '/dashboard?settings#agents',
} as const;

export type SetupWayForward =
  | { kind: 'command'; command: string }
  | { kind: 'owner'; link: string; reason: SetupOwnerReason; why: string };

export type SetupSourceState = 'connected' | 'needs_you' | 'skipped';

export interface SetupSourceEntry {
  id: string;
  name: string;
  state: SetupSourceState;
}

export interface SetupStep {
  id: SetupStepId;
  title: string;
  state: SetupStepState;
  detail: string;
  forward: SetupWayForward;
  /** The sources step only: every source the dashboard offers, by name and state. */
  sources?: SetupSourceEntry[];
}

export interface SetupChecklist {
  kind: 'olympus_setup_status';
  /** Steps done, out of the steps that apply (skipped ones are left out of both). */
  done: number;
  total: number;
  complete: boolean;
  next?: { id: SetupStepId; title: string };
  steps: SetupStep[];
}

/** What a messaging source says about its pairing and its chat choice. */
export interface SetupMessagingFact {
  name: string;
  paired: boolean;
  chatsChosen: boolean;
}

/**
 * Everything the checklist is built from. `undefined` means "not known"
 * (Olympus is not running, or that part could not be read): the step stays
 * to do and says so, rather than claiming done or skipped.
 */
export interface SetupFacts {
  version: string;
  /** The running Olympus answered. */
  running: boolean;
  privateAnswers?: { chosen: boolean; label?: string };
  judge?: { chosen: boolean; choice?: 'local' | 'local-then-venice' | 'venice'; limitDollars?: number | null };
  sources?: readonly SetupSourceEntry[];
  messaging?: readonly SetupMessagingFact[];
  /** Agent names: approved connections, and the host agent Olympus runs inside. */
  aiApps?: readonly string[];
  /** Items Olympus has indexed across every source. */
  findableItems?: number;
}

const NOT_RUNNING = 'Start Olympus to check this.';

/** Strings that look like a credential never reach the checklist. */
const CREDENTIAL_SHAPES = [
  /dash_[A-Za-z0-9_-]{6,}/,
  /olympus_conn_[A-Za-z0-9_-]*/i,
  /\bbearer\s+\S+/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\b[A-Za-z0-9_-]{32,}\b/,
];

export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_SHAPES.some((pattern) => pattern.test(value));
}

/** A name fit for the checklist: one line, short, and never a credential. */
export function setupSafeName(value: string, fallback: string): string {
  const oneLine = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!oneLine || looksLikeCredential(oneLine)) return fallback;
  return oneLine;
}

function owner(link: string, reason: SetupOwnerReason): SetupWayForward {
  return { kind: 'owner', link, reason, why: SETUP_OWNER_WHY[reason] };
}

function command(text: string): SetupWayForward {
  return { kind: 'command', command: text };
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function dollars(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

type Draft = Omit<SetupStep, 'state'> & { status: 'done' | 'open' | 'skipped' };

function installedStep(facts: SetupFacts): Draft {
  return facts.running
    ? { id: 'installed', title: 'Olympus installed', status: 'done', detail: `Version ${facts.version}`, forward: command('olympus doctor') }
    : {
        id: 'installed',
        title: 'Start Olympus',
        status: 'open',
        detail: `Version ${facts.version} is installed, but Olympus is not running.`,
        forward: command('olympus doctor'),
      };
}

function privateAnswersStep(facts: SetupFacts): Draft {
  const fact = facts.privateAnswers;
  const forward = owner(SETUP_DASHBOARD_LINKS.privateAnswers, 'privacy');
  if (!fact) return { id: 'private_answers', title: 'Private answers', status: 'open', detail: NOT_RUNNING, forward };
  if (fact.chosen) return { id: 'private_answers', title: 'Private answers', status: 'done', detail: fact.label ?? 'Chosen', forward };
  return { id: 'private_answers', title: 'Choose how Private items are answered', status: 'open', detail: 'Not chosen yet.', forward };
}

function judgeStep(facts: SetupFacts): Draft {
  const fact = facts.judge;
  const forward = owner(SETUP_DASHBOARD_LINKS.privacyJudge, 'spending');
  if (!fact) return { id: 'privacy_judge', title: 'Privacy judge', status: 'open', detail: NOT_RUNNING, forward };
  if (!fact.chosen) {
    return { id: 'privacy_judge', title: 'Choose your privacy judge', status: 'open', detail: 'Not chosen yet: on this computer for free, or Venice.', forward };
  }
  const limit = typeof fact.limitDollars === 'number' ? `up to ${dollars(fact.limitDollars)}` : 'no spending limit set';
  const detail = fact.choice === 'venice' ? `Venice, ${limit}`
    : fact.choice === 'local-then-venice' ? `This computer, then Venice double-checks, ${limit}`
      : 'On this computer, free';
  return { id: 'privacy_judge', title: 'Privacy judge', status: 'done', detail, forward };
}

function sourcesStep(facts: SetupFacts): Draft {
  const sources = facts.sources?.map((source) => ({ ...source, name: setupSafeName(source.name, source.id) }));
  if (!sources) return { id: 'sources', title: 'Connect a source', status: 'open', detail: NOT_RUNNING, forward: owner(SETUP_DASHBOARD_LINKS.addSource, 'access') };
  const connected = sources.filter((source) => source.state === 'connected').map((source) => source.name);
  const needsYou = sources.filter((source) => source.state === 'needs_you').map((source) => source.name);
  if (connected.length > 0) {
    return {
      id: 'sources',
      title: `${listNames(connected)} connected`,
      status: 'done',
      detail: needsYou.length > 0 ? `${listNames(needsYou)} needs you.` : `${connected.length} ${connected.length === 1 ? 'source' : 'sources'} connected.`,
      forward: owner(needsYou.length > 0 ? SETUP_DASHBOARD_LINKS.sources : SETUP_DASHBOARD_LINKS.addSource, 'access'),
      sources,
    };
  }
  return {
    id: 'sources',
    title: 'Connect a source',
    status: 'open',
    detail: needsYou.length > 0 ? `${listNames(needsYou)} needs you to finish connecting.` : 'Nothing connected yet.',
    forward: owner(needsYou.length > 0 ? SETUP_DASHBOARD_LINKS.sources : SETUP_DASHBOARD_LINKS.addSource, 'access'),
    sources,
  };
}

function messagingStep(facts: SetupFacts): Draft {
  const forward = owner(SETUP_DASHBOARD_LINKS.sources, 'access');
  if (!facts.messaging) return { id: 'messaging_chats', title: 'Choose your chats', status: 'open', detail: NOT_RUNNING, forward };
  const paired = facts.messaging.filter((fact) => fact.paired).map((fact) => ({ ...fact, name: setupSafeName(fact.name, 'Chat app') }));
  if (paired.length === 0) {
    return { id: 'messaging_chats', title: 'Choose your chats', status: 'skipped', detail: 'No chat app is paired.', forward: owner(SETUP_DASHBOARD_LINKS.addSource, 'access') };
  }
  const waiting = paired.filter((fact) => !fact.chatsChosen).map((fact) => fact.name);
  if (waiting.length === 0) {
    return { id: 'messaging_chats', title: `${listNames(paired.map((fact) => fact.name))} chats chosen`, status: 'done', detail: 'Olympus keeps the chats you chose.', forward };
  }
  return { id: 'messaging_chats', title: `Choose your ${listNames(waiting)} chats`, status: 'open', detail: 'Paired. Pick which chats Olympus keeps.', forward };
}

function aiAppStep(facts: SetupFacts): Draft {
  const forward = owner(SETUP_DASHBOARD_LINKS.agents, 'access');
  if (!facts.aiApps) return { id: 'ai_app', title: 'Connect an AI app', status: 'open', detail: NOT_RUNNING, forward };
  const names = [...new Set(facts.aiApps.map((name) => setupSafeName(name, 'An agent')))];
  if (names.length === 0) return { id: 'ai_app', title: 'Connect an AI app', status: 'open', detail: 'ChatGPT, Claude, Grok or your own agent', forward };
  return { id: 'ai_app', title: 'AI app connected', status: 'done', detail: listNames(names), forward };
}

function firstItemsStep(facts: SetupFacts): Draft {
  const forward = command('olympus source index status');
  if (facts.findableItems === undefined) return { id: 'first_items', title: 'First items findable', status: 'open', detail: NOT_RUNNING, forward };
  if (facts.findableItems > 0) {
    const count = Math.floor(facts.findableItems).toLocaleString('en-US');
    return { id: 'first_items', title: 'First items findable', status: 'done', detail: `${count} ${facts.findableItems === 1 ? 'item' : 'items'} findable`, forward };
  }
  return { id: 'first_items', title: 'First items findable', status: 'open', detail: 'Starts by itself after your first source is read.', forward };
}

/** Build the checklist. The first open step is `next`; later open ones are `todo`. */
export function buildSetupChecklist(facts: SetupFacts): SetupChecklist {
  const drafts = [
    installedStep(facts),
    privateAnswersStep(facts),
    judgeStep(facts),
    sourcesStep(facts),
    messagingStep(facts),
    aiAppStep(facts),
    firstItemsStep(facts),
  ];
  let nextTaken = false;
  const steps: SetupStep[] = drafts.map(({ status, id, title, detail, forward, sources }) => {
    let state: SetupStepState;
    if (status === 'done') state = 'done';
    else if (status === 'skipped') state = 'skipped';
    else if (!nextTaken) { state = 'next'; nextTaken = true; }
    else state = 'todo';
    return { id, title, state, detail, forward, ...(sources ? { sources } : {}) };
  });
  const applicable = steps.filter((step) => step.state !== 'skipped');
  const done = applicable.filter((step) => step.state === 'done').length;
  const next = steps.find((step) => step.state === 'next');
  return {
    kind: 'olympus_setup_status',
    done,
    total: applicable.length,
    complete: next === undefined,
    ...(next ? { next: { id: next.id, title: next.title } } : {}),
    steps,
  };
}

/**
 * Read back a checklist another process sent (the worker's answer to the CLI):
 * only the known fields, rebuilt, so nothing else rides along.
 */
export function parseSetupChecklist(value: unknown): SetupChecklist | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'olympus_setup_status' || !Array.isArray(record.steps)) return undefined;
  const steps: SetupStep[] = [];
  for (const raw of record.steps) {
    if (!raw || typeof raw !== 'object') return undefined;
    const step = raw as Record<string, unknown>;
    if (!SETUP_STEP_IDS.includes(step.id as SetupStepId)) return undefined;
    if (!['done', 'next', 'todo', 'skipped'].includes(step.state as string)) return undefined;
    if (typeof step.title !== 'string' || typeof step.detail !== 'string') return undefined;
    const forward = parseForward(step.forward);
    if (!forward) return undefined;
    const sources = Array.isArray(step.sources)
      ? step.sources.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const source = entry as Record<string, unknown>;
          if (typeof source.id !== 'string' || typeof source.name !== 'string') return [];
          if (!['connected', 'needs_you', 'skipped'].includes(source.state as string)) return [];
          return [{ id: setupSafeName(source.id, 'source'), name: setupSafeName(source.name, 'A source'), state: source.state as SetupSourceState }];
        })
      : undefined;
    steps.push({
      id: step.id as SetupStepId,
      title: setupSafeName(step.title, 'Setup step'),
      state: step.state as SetupStepState,
      detail: setupSafeName(step.detail, ''),
      forward,
      ...(sources ? { sources } : {}),
    });
  }
  const applicable = steps.filter((step) => step.state !== 'skipped');
  const next = steps.find((step) => step.state === 'next');
  return {
    kind: 'olympus_setup_status',
    done: applicable.filter((step) => step.state === 'done').length,
    total: applicable.length,
    complete: next === undefined,
    ...(next ? { next: { id: next.id, title: next.title } } : {}),
    steps,
  };
}

function parseForward(value: unknown): SetupWayForward | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const forward = value as Record<string, unknown>;
  if (forward.kind === 'command' && typeof forward.command === 'string' && /^olympus [a-z][a-z -]*$/.test(forward.command)) {
    return command(forward.command);
  }
  if (forward.kind === 'owner' && typeof forward.link === 'string' && (Object.values(SETUP_DASHBOARD_LINKS) as string[]).includes(forward.link)
    && (forward.reason === 'privacy' || forward.reason === 'access' || forward.reason === 'spending')) {
    return owner(forward.link, forward.reason);
  }
  return undefined;
}

const STATE_MARKS: Readonly<Record<SetupStepState, string>> = { done: '[x]', next: '[>]', todo: '[ ]', skipped: '[-]' };

/** The readable form (`olympus setup status --text`): the same checklist, one step a line. */
export function renderSetupChecklistText(checklist: SetupChecklist): string {
  const lines = [`Setup: ${checklist.done} of ${checklist.total} done`];
  if (checklist.next) lines.push(`Next: ${checklist.next.title}`);
  lines.push('');
  for (const step of checklist.steps) {
    lines.push(`${STATE_MARKS[step.state]} ${step.title}${step.detail ? ` - ${step.detail}` : ''}`);
    if (step.state === 'done' || step.state === 'skipped') continue;
    if (step.forward.kind === 'command') lines.push(`    You can run this: ${step.forward.command}`);
    else lines.push(`    Needs the owner: ${step.forward.link}`, `    ${step.forward.why}`);
  }
  lines.push('', 'Dashboard links open in the Olympus dashboard on this computer (olympus dashboard).');
  return lines.join('\n');
}
