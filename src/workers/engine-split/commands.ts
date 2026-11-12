/**
 * The engine split's private commands, front to background
 * (docs/design/engine-split.md, part 3, "Commands from front to background").
 *
 * The front never writes a background-owned store. Where an owner action
 * needs the background to act (re-read a config file the front wrote, sync
 * a source now, start an approved source, step the judge aside for the
 * owner's own answer, judge question-matched items first), the front sends
 * one command over the background's private unix socket, authenticated with
 * the worker bearer token like the worker socket.
 *
 * Every command carries an id. The background acknowledges receipt at once
 * and records the result when the command has been applied; the same id
 * sent again (a retry after a lost answer) returns that record and is never
 * applied twice. Commands about one source run in arrival order; the rest
 * run in arrival order per kind. The record lives as long as the background
 * process: after a background restart an unknown id is applied once by the
 * new process, which is safe for every command in this set (each is a wake
 * or a state the background re-derives).
 */
import { randomUUID } from 'node:crypto';
import { ENGINE_COMMANDS_PATH, ENGINE_MODEL_COMPLETE_PATH, ENGINE_READY_PATH, type EngineReadyBody } from '../../core/engine-split.ts';
import type { AnalystModelCompletion, AnalystModelRequest } from '../../core/analyst.ts';
import { OperationError } from '../../core/operation-error.ts';
import { hasValidWorkerBearerToken } from '../http.ts';
import { runAtLocalInferencePriority, type LocalInferencePriority } from '../answer-activity.ts';

/** Config files the front writes and the background re-reads (design, "Writes the front still needs", B). */
export const ENGINE_RELOAD_KINDS = ['sources', 'scope', 'exclusions', 'embedding', 'models', 'archive', 'extraction', 'pacing'] as const;
export type EngineReloadKind = typeof ENGINE_RELOAD_KINDS[number];

/** As judge-boost.ts (#1062): at most this many matched items per question. */
export const ENGINE_JUDGE_BOOST_MAX_IDS = 20;
/** As judge-boost.ts: a raise lasts this long. */
export const ENGINE_JUDGE_BOOST_TTL_MS = 15 * 60_000;

export interface EngineItemIdentity {
  provider: string;
  accountScope: string;
  providerItemId: string;
  providerConversationId?: string;
}

/**
 * Owner actions that write background-owned data run in the background as
 * the very route that served them before: the front forwards the request
 * (path, headers, body) and the background runs it through its own handler,
 * which repeats every authorization and validation check it makes today, and
 * answers with the response. Each kind names the routes it may carry.
 */
export const ENGINE_FORWARDED_ROUTES = {
  delete_source_data: ['/dashboard/delete-source-data', '/v1/cli/data-delete'],
  // Every per-item override: the CLI's tier set, and the one-item privacy change
  // from the dashboard and from an agent (tier-owner-items.ts). Finding items stays a read.
  // Check the judge (judge-check.ts) records the owner's answer and, where it
  // differs, the same per-item override, so it runs with the ledgers (#1224).
  tier_override: ['/v1/cli/tier', '/dashboard/privacy/items/set', '/v1/privacy-item/raise', '/dashboard/privacy/judge-check'],
  // People's corrections write the people index the background rebuilds (#1224).
  people: ['/dashboard/people'],
  // A sync asked for by path (an agent, the CLI) and X's content recovery run
  // the lanes' syncs, which write their stores (#1224).
  source_sync: ['/v1/source/index/sync', '/v1/source/index/x-bookmarks/content/recover'],
  storage_registry: ['/v1/cli/pairing-placement', '/v1/cli/pairing-account'],
  // Pairing state lives with the background's capture service: every pairing route goes there.
  capture: [
    '/dashboard/messaging/start', '/dashboard/messaging/status', '/dashboard/messaging/respond',
    '/dashboard/messaging/cancel', '/dashboard/messaging/chats', '/dashboard/messaging/scope',
  ],
  embed_chunks: ['/v1/source/index/embed'],
  // The CLI's export (and so its backup): the background takes the snapshots
  // on the writer's own loop, between its writes (#1224).
  data_export: ['/v1/cli/data-export'],
  // The background runs source watches' passes and owns their store.
  source_watch: ['/v1/source/watch/create', '/v1/source/watch/cancel'],
  // The extraction queue's writes, under the generic path or a family's alias.
  extraction_queue: [
    '/v1/source/index/files/plan', '/v1/source/index/files/transcribe', '/v1/source/index/files/recycle-leases',
    '/v1/source/index/files/janitor-requeue', '/v1/source/index/files/extract-pdfs', '/v1/source/index/files/extract',
    '/v1/source/index/dropbox/content/plan', '/v1/source/index/dropbox/content/recycle-leases',
    '/v1/source/index/dropbox/content/janitor-requeue', '/v1/source/index/dropbox/content/extract', '/v1/source/index/dropbox/transcribe',
  ],
} as const;
export type EngineForwardedKind = keyof typeof ENGINE_FORWARDED_ROUTES;

/**
 * Every other POST route the worker serves (test/engine-split-route-guard.test.ts
 * holds the two lists to the worker's routes): in the split it runs in the
 * front, and the reason says why that is safe. A route that writes data the
 * background owns (stores, tier ledgers, the people index, the extraction
 * queue, watches, capture) is forwarded instead; one that writes a file the
 * front owns says how the background learns of it. Every key is one exact route: a prefix
 * route's actions each have their own (write-routes.ts).
 */
export const ENGINE_FRONT_ONLY_ROUTES: Readonly<Record<string, string>> = {
  '/dashboard/control/launch': 'Dashboard sign-in: sessions the front holds.',
  '/dashboard/control/launch/redeem': 'Dashboard sign-in: sessions the front holds.',
  '/dashboard/control/session': 'Dashboard sign-in: sessions the front holds.',
  '/dashboard/control/session/local': 'Dashboard sign-in: sessions the front holds.',
  '/dashboard/connect/oauth/start': 'Credential custody and the handle registry (owner files); lanes follow the registry on reload sources.',
  '/dashboard/connect/oauth/cancel': 'Cancels a pending sign-in the front started.',
  '/dashboard/connect/api-key': 'Credential custody and the handle registry (owner files); lanes follow the registry on reload sources.',
  '/dashboard/connect/this-computer': 'Credential custody and the handle registry (owner files); lanes follow the registry on reload sources.',
  '/dashboard/disconnect': 'Credential teardown, after the background confirms the capture stopped (capture_stop).',
  '/dashboard/unpair': 'Credential teardown, after the background confirms the capture stopped (capture_stop).',
  '/dashboard/dispositions': 'Source scope and ingestion choices (owner files); an approval sends reload scope to the background.',
  '/dashboard/sync-now': 'The front scheduler posts sync_now; the background runs the pass.',
  '/dashboard/embedding-priority': 'The overnight guard\'s operator override file, read by the embedding drain.',
  '/dashboard/models/check': 'Probes a model; writes nothing.',
  '/dashboard/models/local/discover': 'Lists local models; writes nothing.',
  '/dashboard/models/local/test': 'Probes a local model; writes nothing.',
  '/dashboard/models/addable': 'Lists models; writes nothing.',
  '/dashboard/models/first-run-privacy': 'A settings file; a model or judge change restarts the background too (reload models).',
  '/dashboard/models/judge': 'A settings file; a model or judge change restarts the background too (reload models).',
  '/dashboard/models/local/save': 'A settings file; a model or judge change restarts the background too (reload models).',
  '/dashboard/models/choice': 'A settings file; a model or judge change restarts the background too (reload models).',
  '/dashboard/settings/proposal/apply': 'Settings files; a model or judge change restarts the background too (reload models).',
  '/dashboard/settings/proposal/discard': 'Drops a settings proposal the front holds.',
  '/dashboard/engine/computer-use': 'A settings file read by the front\'s answer tools.',
  '/dashboard/engine/go-easy': 'go-easy.json; the background reads it again (reload pacing).',
  '/dashboard/engine/update': 'Updates the installed package and restarts the host.',
  '/dashboard/engine/update/status': 'Reads the update\'s progress.',
  '/dashboard/backup/status': 'Reads backup state.',
  '/dashboard/backup/settings': 'Backup settings, a file the front owns.',
  '/dashboard/backup/passphrase': 'The backup key file the front owns.',
  '/dashboard/backup/browse': 'Lists folders; writes nothing.',
  '/dashboard/backup/run': 'Exports read-only snapshots, checked against one generation of the background\'s writes (backup-service.ts).',
  '/dashboard/backup/restore': 'Writes the pending-restore marker; the restore runs at the background\'s boot, after it stops answering ready.',
  '/dashboard/tools/call': 'Panel tools run in process through the forwarding fetch.',
  '/dashboard/archive-import/upload-start': 'Archive uploads, requests and state files; archive_changed hands them to the background.',
  '/dashboard/archive-import/upload-file': 'Archive uploads, requests and state files; archive_changed hands them to the background.',
  '/dashboard/archive-import/upload-status': 'Reads an upload\'s progress.',
  '/dashboard/archive-import/upload-cancel': 'Archive uploads, requests and state files; archive_changed hands them to the background.',
  '/dashboard/archive-import/approve': 'Archive uploads, requests and state files; archive_changed hands them to the background.',
  '/dashboard/archive-import/decline': 'Archive uploads, requests and state files; archive_changed hands them to the background.',
  '/dashboard/archive-import/remove': 'Archive uploads, requests and state files; archive_changed hands them to the background.',
  '/dashboard/archive-import/stop': 'Archive uploads, requests and state files; archive_changed hands them to the background.',
  '/dashboard/privacy/items/find': 'Reads the tier ledgers read-only.',
  '/dashboard/agents/pairing-code': 'Remote connections and keys, in the front\'s connection store.',
  '/dashboard/agents/keys': 'Remote connections and keys, in the front\'s connection store.',
  '/dashboard/agents/revoke': 'Remote connections and keys, in the front\'s connection store.',
  '/dashboard/agents/remote-access': 'Remote access settings the front serves.',
  '/dashboard/consult': 'Outside-help settings, written by the front.',
  '/dashboard/consult/route': 'Outside-help settings, written by the front.',
  '/dashboard/consult/route/add': 'Outside-help settings, written by the front.',
  '/dashboard/consult/recover': 'Outside-help settings, written by the front.',
  '/dashboard/consult/abandon': 'Outside-help settings, written by the front.',
  '/dashboard/consult/tools/install': 'Outside-help settings, written by the front.',
  '/dashboard/consult/writer': 'Outside-help settings, written by the front.',
  '/dashboard/consult/writer/test': 'Outside-help settings, written by the front.',
  '/dashboard/consult/standard': 'Outside-help settings, written by the front.',
  '/dashboard/private-answers': 'The waiting-question queue, consumed only by the front.',
  '/dashboard/apps-received': 'The app release log the front records; Make Private goes to the background (tier_set_recorded).',
  '/v1/archive-import/start': 'An agent\'s archive request (request files); archive_changed hands it to the background.',
  '/v1/archive-import/status': 'An agent\'s archive request (request files); archive_changed hands it to the background.',
  '/v1/archive-import/remove': 'An agent\'s archive request (request files); archive_changed hands it to the background.',
  '/v1/consult/ask': 'Asks an outside consultant; writes nothing the background owns.',
  '/v1/privacy-item/find': 'Reads the tier ledgers read-only; raise is forwarded (tier_override).',
  '/v1/source/answer': 'Answers from read-only stores.',
  '/v1/source/answer/received': 'An answer receipt, recorded where the front released it.',
  '/v1/source/answer/release': 'Checks a release ticket the front holds.',
  '/v1/source/credentials/recheck': 'Re-reads credential state; writes nothing.',
  '/v1/source/export': 'Copies source files out; reads only.',
  '/v1/source/index/dropbox/content/export-eval-shard': 'Exports an eval shard from read-only stores.',
  '/v1/source/index/files/status': 'Reads the extraction queue.',
  '/v1/source/index/search': 'Searches read-only stores.',
  '/v1/source/index/status': 'Reads status.',
  '/v1/source/scheduler/status': 'Reads the background\'s snapshot.',
  '/v1/source/watches': 'Lists watches read-only.',
  '/v1/cli/ingestion-status': 'Reads status.',
  '/v1/cli/setup-status': 'Reads status.',
  '/v1/cli/settings': 'Settings files; a model or judge change restarts the background too (reload models).',
  '/v1/cli/settings-propose': 'Records a settings proposal the front holds.',
};



export interface EngineForwardedRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface EngineForwardedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const ENGINE_BODY_MAX_BYTES = 16 * 1024 * 1024;
export const ENGINE_DASHBOARD_SAMPLES_MAX = 500;

export type EngineCommand =
  /** frontPid (models only): the background restarts once that front has ended, so its answer gets through. */
  | { kind: 'reload'; target: EngineReloadKind; corpora?: string[]; frontPid?: number }
  | { kind: 'archive_changed' }
  /** Install or re-arm the built-in private model: only the background installs it (a wake). */
  | { kind: 'model_prepare' }
  | { kind: 'dashboard_samples'; samples: Record<string, unknown>[] }
  | { kind: EngineForwardedKind; request: EngineForwardedRequest; frontPid?: number }
  | { kind: 'sync_now'; source: string; manual: boolean }
  | { kind: 'start_approved'; source: string }
  /**
   * front names the front process that sent it and seq counts that front's
   * busy/idle changes, so a delayed or retried delivery never overrides a
   * newer one (OwnerBusyMarks, runtime.ts).
   */
  | { kind: 'owner_busy'; resource: string; front: string; seq: number }
  | { kind: 'owner_idle'; resource: string; front: string; seq: number }
  /** "Make Private" from the apps-received panel: the recorded item's override, written by the background. */
  | { kind: 'tier_set_recorded'; locator: string; expected: EngineRecordedItem }
  /** Stop a messaging capture before Disconnect or Unpair tears down its grant; done means stopped. */
  | { kind: 'capture_stop'; source: 'telegram' | 'whatsapp' }
  | { kind: 'judge_boost'; identities: EngineItemIdentity[] }
  /**
   * A backup's export, written by the background into the front's staging
   * folder: the snapshots are taken between the background's writes, so the
   * stores and ledgers agree; the front packs and encrypts them (#1224).
   */
  | { kind: 'export_data'; destination: string };

export type EngineCommandKind = EngineCommand['kind'];

/** The item a correction was recorded for; the background checks the locator still names it. */
export interface EngineRecordedItem {
  provider: string;
  providerItemId: string;
  providerConversationId?: string;
}

export interface EngineCommandEnvelope {
  id: string;
  command: EngineCommand;
}

export type EngineCommandState = 'received' | 'done' | 'failed';

export interface EngineCommandReceipt {
  id: string;
  state: EngineCommandState;
  /** The background process that holds this record; a new one means it restarted. */
  instance_id: string;
  result?: unknown;
  error?: string;
}

export class EngineCommandError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'EngineCommandError';
  }
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const RESOURCE = /^[\x21-\x7e]{1,200}$/;

export function newEngineCommandId(): string {
  return randomUUID();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedString(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** A dashboard progress sample: ids, a time and counts; never text. */
function dashboardSample(value: unknown): boolean {
  const sample = asRecord(value);
  if (!sample) return false;
  for (const [key, entry] of Object.entries(sample)) {
    if (key === 'source_id' || key === 'corpus_id' || key === 'sampled_at') {
      if (!boundedString(entry, 200)) return false;
    } else if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return false;
    } else if (typeof entry !== 'boolean') {
      return false;
    }
  }
  return typeof sample.corpus_id === 'string' && typeof sample.source_id === 'string';
}

function forwardedRequest(kind: EngineForwardedKind, value: unknown): EngineForwardedRequest {
  const request = asRecord(value);
  const path = request?.path;
  if (typeof path !== 'string' || !(ENGINE_FORWARDED_ROUTES[kind] as readonly string[]).includes(path)) {
    throw new EngineCommandError(400, `${kind} does not carry that route.`);
  }
  const headers = asRecord(request!.headers);
  if (!headers || Object.values(headers).some((entry) => typeof entry !== 'string')) throw new EngineCommandError(400, 'Forwarded headers must be strings.');
  const body = request!.body;
  if (typeof body !== 'string') throw new EngineCommandError(400, 'A forwarded body is text.');
  if (body.length > ENGINE_BODY_MAX_BYTES) throw new EngineCommandError(413, 'The command body is too large.');
  return { path, headers: headers as Record<string, string>, body };
}

/** The route a forwarded command carries, as a request the background's own handler serves. */
export function forwardedRequestToRequest(origin: string, forwarded: EngineForwardedRequest): Request {
  return new Request(origin + forwarded.path, { method: 'POST', headers: forwarded.headers, body: forwarded.body });
}

/**
 * The id a forwarded create writes under, made from the command id: a retry
 * or a resubmission after a background restart carries the same command id,
 * so it lands on the record the first attempt wrote instead of a second one.
 * Only the background attaches it, to the Request object it built; nothing a
 * client sends can set it.
 */
const forwardedRecordIds = new WeakMap<Request, string>();

export function tagForwardedRequest(request: Request, commandId: string): Request {
  forwardedRecordIds.set(request, `engine-${commandId}`);
  return request;
}

export function forwardedRecordId(request: Request): string | undefined {
  return forwardedRecordIds.get(request);
}

/** Headers that belong to the hop, not to the request. */
const HOP_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade']);

export async function requestToForwarded(request: Request): Promise<EngineForwardedRequest> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => { if (!HOP_HEADERS.has(name.toLowerCase())) headers[name] = value; });
  return { path: new URL(request.url).pathname, headers, body: await request.text() };
}

export async function responseToForwarded(response: Response): Promise<EngineForwardedResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { if (!HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') headers[name] = value; });
  return { status: response.status, headers, body: await response.text() };
}

/** Validate one envelope from the wire. Anything unexpected is a 400; nothing is coerced. */
export function parseEngineCommandEnvelope(value: unknown): EngineCommandEnvelope {
  const record = asRecord(value);
  const id = record?.id;
  if (typeof id !== 'string' || !ID.test(id)) throw new EngineCommandError(400, 'A command needs an id.');
  const command = asRecord(record?.command);
  const kind = command?.kind;
  const fail = (message: string): never => { throw new EngineCommandError(400, message); };
  switch (kind) {
    case 'reload': {
      const target = command!.target;
      if (!ENGINE_RELOAD_KINDS.includes(target as EngineReloadKind)) fail('reload needs a known kind.');
      const corpora = command!.corpora;
      if (corpora !== undefined && (!Array.isArray(corpora) || corpora.length > 200 || corpora.some((entry) => typeof entry !== 'string' || !SOURCE.test(entry)))) {
        fail('reload corpora must be corpus ids.');
      }
      const frontPid = command!.frontPid;
      if (frontPid !== undefined && (target !== 'models' || !Number.isSafeInteger(frontPid) || (frontPid as number) <= 0)) fail('frontPid is a process id, carried by a models reload.');
      return { id, command: {
        kind, target: target as EngineReloadKind,
        ...(Array.isArray(corpora) ? { corpora: corpora as string[] } : {}),
        ...(frontPid !== undefined ? { frontPid: frontPid as number } : {}),
      } };
    }
    case 'archive_changed':
    case 'model_prepare':
      return { id, command: { kind } };
    case 'dashboard_samples': {
      const samples = command!.samples;
      if (!Array.isArray(samples) || samples.length > ENGINE_DASHBOARD_SAMPLES_MAX || samples.some((sample) => !dashboardSample(sample))) {
        fail('dashboard_samples takes count samples only.');
      }
      return { id, command: { kind, samples: samples as Record<string, unknown>[] } };
    }
    case 'delete_source_data':
    case 'tier_override':
    case 'storage_registry':
    case 'capture':
    case 'embed_chunks':
    case 'source_watch':
    case 'extraction_queue':
    case 'people':
    case 'source_sync':
    case 'data_export':
    {
      const frontPid = command!.frontPid;
      if (frontPid !== undefined && (kind !== 'delete_source_data' || !Number.isSafeInteger(frontPid) || (frontPid as number) <= 0)) fail('frontPid is a process id, carried by a delete.');
      return { id, command: { kind, request: forwardedRequest(kind, command!.request), ...(frontPid !== undefined ? { frontPid: frontPid as number } : {}) } };
    }
    case 'sync_now':
    case 'start_approved': {
      const source = command!.source;
      if (typeof source !== 'string' || !SOURCE.test(source)) fail(`${kind} needs a source.`);
      if (kind === 'start_approved') return { id, command: { kind, source: source as string } };
      return { id, command: { kind, source: source as string, manual: command!.manual === true } };
    }
    case 'tier_set_recorded': {
      const locator = boundedString(command!.locator, 2048);
      const expected = asRecord(command!.expected);
      const provider = boundedString(expected?.provider, 64);
      const providerItemId = boundedString(expected?.providerItemId);
      const conversation = expected?.providerConversationId;
      if (!locator || !provider || !providerItemId || (conversation !== undefined && !boundedString(conversation))) {
        fail('tier_set_recorded needs a locator and the recorded provider and item.');
      }
      return { id, command: { kind, locator: locator!, expected: {
        provider: provider!, providerItemId: providerItemId!,
        ...(typeof conversation === 'string' ? { providerConversationId: conversation } : {}),
      } } };
    }
    case 'export_data': {
      const destination = boundedString(command!.destination, 4096);
      if (!destination || !destination.startsWith('/')) fail('export_data needs an absolute destination.');
      return { id, command: { kind, destination: destination! } };
    }
    case 'capture_stop': {
      const source = command!.source;
      if (source !== 'telegram' && source !== 'whatsapp') fail('capture_stop needs telegram or whatsapp.');
      return { id, command: { kind, source: source as 'telegram' | 'whatsapp' } };
    }
    case 'owner_busy':
    case 'owner_idle': {
      const resource = command!.resource;
      if (typeof resource !== 'string' || !RESOURCE.test(resource)) fail(`${kind} needs a resource.`);
      const front = boundedString(command!.front, 64);
      const seq = command!.seq;
      if (!front || !Number.isSafeInteger(seq) || (seq as number) < 1) fail(`${kind} needs its front and a sequence number.`);
      return { id, command: { kind, resource: resource as string, front: front!, seq: seq as number } };
    }
    case 'judge_boost': {
      const raw = command!.identities;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > ENGINE_JUDGE_BOOST_MAX_IDS) {
        fail(`judge_boost takes 1 to ${ENGINE_JUDGE_BOOST_MAX_IDS} items.`);
      }
      const identities = (raw as unknown[]).map((entry) => {
        const item = asRecord(entry);
        const provider = boundedString(item?.provider, 64);
        const accountScope = boundedString(item?.accountScope);
        const providerItemId = boundedString(item?.providerItemId);
        const conversation = item?.providerConversationId;
        if (!provider || !accountScope || !providerItemId || (conversation !== undefined && !boundedString(conversation))) {
          fail('judge_boost items need provider, accountScope and providerItemId.');
        }
        return {
          provider: provider!, accountScope: accountScope!, providerItemId: providerItemId!,
          ...(typeof conversation === 'string' ? { providerConversationId: conversation } : {}),
        };
      });
      return { id, command: { kind, identities } };
    }
    default:
      return fail('Unknown command.');
  }
}

/** Commands about one source keep their order; the rest keep order per kind. */
function orderKey(command: EngineCommand): string {
  return 'source' in command ? `source:${command.source}` : `kind:${command.kind}`;
}

/** What a handler knows besides the command: its id, the same on every retry and resubmission. */
export interface EngineCommandContext {
  id: string;
}

export type EngineCommandHandlers = {
  [K in EngineCommandKind]?: (command: Extract<EngineCommand, { kind: K }>, context: EngineCommandContext) => Promise<unknown> | unknown;
};

interface LedgerEntry {
  body: string;
  receipt: EngineCommandReceipt;
  settled: Promise<void>;
  settledAt?: number;
}

export interface EngineCommandLedgerOptions {
  instanceId: string;
  handlers: EngineCommandHandlers;
  now?: () => number;
  /** Settled records kept for retries. */
  maxSettled?: number;
  /** A settled record is forgotten after this long. */
  retentionMs?: number;
}

/**
 * The background's record of commands: receipt at once, the result once
 * applied, and each id applied at most once while this process lives.
 */
export class EngineCommandLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly maxSettled: number;
  private readonly retentionMs: number;

  constructor(private readonly options: EngineCommandLedgerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxSettled = options.maxSettled ?? 1_000;
    this.retentionMs = options.retentionMs ?? 60 * 60_000;
  }

  get instanceId(): string { return this.options.instanceId; }

  /** Record and queue a command, or return the record of the same id. A different command under a used id is refused. */
  submit(envelope: EngineCommandEnvelope): EngineCommandReceipt {
    this.prune();
    const body = JSON.stringify(envelope.command);
    const existing = this.entries.get(envelope.id);
    if (existing) {
      if (existing.body !== body) throw new EngineCommandError(409, 'That command id was used for a different command.');
      return { ...existing.receipt };
    }
    const receipt: EngineCommandReceipt = { id: envelope.id, state: 'received', instance_id: this.options.instanceId };
    const key = orderKey(envelope.command);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const entry: LedgerEntry = { body, receipt, settled: Promise.resolve() };
    const settled = previous.then(() => this.apply(entry, envelope.command));
    entry.settled = settled;
    this.entries.set(envelope.id, entry);
    this.chains.set(key, settled);
    void settled.then(() => { if (this.chains.get(key) === settled) this.chains.delete(key); });
    return { ...receipt };
  }

  get(id: string): EngineCommandReceipt | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry.receipt } : undefined;
  }

  /** The record once settled, or as it stands when `wait` resolves first. */
  async settled(id: string, wait: Promise<void>): Promise<EngineCommandReceipt | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    await Promise.race([entry.settled, wait]);
    return { ...entry.receipt };
  }

  private async apply(entry: LedgerEntry, command: EngineCommand): Promise<void> {
    const handler = this.options.handlers[command.kind] as ((value: EngineCommand, context: EngineCommandContext) => unknown) | undefined;
    try {
      if (!handler) throw new Error(`${command.kind} is not handled by this background.`);
      const result = await handler(command, { id: entry.receipt.id });
      entry.receipt.state = 'done';
      if (result !== undefined) entry.receipt.result = result;
    } catch (error) {
      entry.receipt.state = 'failed';
      entry.receipt.error = error instanceof Error ? error.message : 'The command failed.';
    }
    entry.settledAt = this.now();
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    let settled = 0;
    for (const entry of this.entries.values()) if (entry.settledAt !== undefined) settled += 1;
    for (const [id, entry] of this.entries) {
      if (entry.settledAt === undefined) continue;
      if (entry.settledAt >= cutoff && settled <= this.maxSettled) break;
      this.entries.delete(id);
      settled -= 1;
    }
  }
}

export interface EngineCommandServerOptions {
  authToken: string;
  ledger: EngineCommandLedger;
  /** True once the background's boot work is done and it accepts commands. */
  ready: () => boolean;
  /** Longest a result request may wait for the command to settle. */
  maxWaitMs?: number;
  /** The built-in private model's completion, run by the one process that holds the model. */
  modelComplete?: (request: AnalystModelRequest) => Promise<AnalystModelCompletion>;
  /** Timer seam for the wait. */
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

/**
 * The background's command socket handler:
 * - `GET /engine/ready`: `{ ready, instance_id, schema_current }`.
 * - `POST /engine/commands`: an envelope; 202 with the receipt, or 200 with
 *   the settled record for an id already applied.
 * - `GET /engine/commands/<id>?wait=<ms>`: the record, waiting up to `wait`
 *   for it to settle; 404 for an id this process does not hold.
 * - `POST /engine/model/complete`: one built-in model completion, answered
 *   when it ends. It is not a command: nothing is recorded, and the front
 *   does not retry it. Closing the request aborts the model call.
 * Every route needs the worker bearer token.
 */
export function createEngineCommandHandler(options: EngineCommandServerOptions): (request: Request) => Promise<Response> {
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  return async (request) => {
    if (!hasValidWorkerBearerToken(request.headers.get('authorization'), options.authToken)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === ENGINE_READY_PATH && request.method === 'GET') {
      const ready = options.ready();
      const body: EngineReadyBody = { ready, instance_id: options.ledger.instanceId, schema_current: ready };
      return Response.json(body, { status: ready ? 200 : 503 });
    }
    if (url.pathname === ENGINE_COMMANDS_PATH && request.method === 'POST') {
      if (!options.ready()) return Response.json({ error: 'starting', instance_id: options.ledger.instanceId }, { status: 503 });
      try {
        const envelope = parseEngineCommandEnvelope(await request.json().catch(() => undefined));
        const receipt = options.ledger.submit(envelope);
        return Response.json(receipt, { status: receipt.state === 'received' ? 202 : 200 });
      } catch (error) {
        if (error instanceof EngineCommandError) return Response.json({ error: error.message }, { status: error.status });
        throw error;
      }
    }
    if (url.pathname === ENGINE_MODEL_COMPLETE_PATH && request.method === 'POST') {
      if (!options.ready() || !options.modelComplete) return Response.json({ error: 'model_unavailable' }, { status: 503 });
      const body = await request.json().catch(() => undefined);
      const parsed = parseModelRequest(body);
      const priority = parseModelPriority(asRecord(body)?.priority);
      if (!parsed || !priority) return Response.json({ error: 'invalid_model_request' }, { status: 400 });
      const modelComplete = options.modelComplete;
      try {
        // The front's call keeps its priority here: a background answer stays
        // background, so the judge still gets its fair turn behind it.
        const completion = await runAtLocalInferencePriority(priority, () => modelComplete({ ...parsed, signal: request.signal }));
        return Response.json(completion);
      } catch (error) {
        // The model's own answer, typed as it would be in one process: a
        // download still running or a server that failed to start.
        if (error instanceof OperationError) return Response.json({ operation_error: error.toJSON() }, { status: 503 });
        return Response.json({ error: 'model_failed', message: error instanceof Error ? error.message : 'unknown error' }, { status: 500 });
      }
    }
    if (url.pathname.startsWith(`${ENGINE_COMMANDS_PATH}/`) && request.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice(ENGINE_COMMANDS_PATH.length + 1));
      if (!ID.test(id)) return Response.json({ error: 'not_found' }, { status: 404 });
      const waitMs = Math.max(0, Math.min(maxWaitMs, Number(url.searchParams.get('wait') ?? 0) || 0));
      let timer: unknown;
      const wait = new Promise<void>((resolve) => { timer = setTimer(resolve, waitMs); });
      try {
        const receipt = waitMs > 0 ? await options.ledger.settled(id, wait) : options.ledger.get(id);
        if (!receipt) return Response.json({ error: 'not_found', instance_id: options.ledger.instanceId }, { status: 404 });
        return Response.json(receipt);
      } finally {
        clearTimer(timer);
      }
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
}

/** A completion request from the wire: the fields AnalystModelRequest carries, nothing coerced. */
const MODEL_PRIORITIES: readonly LocalInferencePriority[] = ['owner', 'background', 'maintenance'];

/** The priority the front's call ran at; a front that sends none ran the owner's call. */
export function parseModelPriority(value: unknown): LocalInferencePriority | undefined {
  if (value === undefined) return 'owner';
  return MODEL_PRIORITIES.find((priority) => priority === value);
}

export function parseModelRequest(value: unknown): Omit<AnalystModelRequest, 'signal'> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { system, prompt, localOnly, maxOutputChars, responseSchema } = record;
  if (typeof system !== 'string' || typeof prompt !== 'string' || typeof localOnly !== 'boolean') return undefined;
  if (maxOutputChars !== undefined && (!Number.isSafeInteger(maxOutputChars) || (maxOutputChars as number) < 1)) return undefined;
  if (responseSchema !== undefined && !asRecord(responseSchema)) return undefined;
  return {
    system, prompt, localOnly,
    ...(maxOutputChars !== undefined ? { maxOutputChars: maxOutputChars as number } : {}),
    ...(responseSchema !== undefined ? { responseSchema: responseSchema as Record<string, unknown> } : {}),
  };
}
