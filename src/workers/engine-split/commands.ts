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
import { ENGINE_COMMANDS_PATH, ENGINE_READY_PATH, type EngineReadyBody } from '../../core/engine-split.ts';
import { hasValidWorkerBearerToken } from '../http.ts';

/** Config files the front writes and the background re-reads (design, "Writes the front still needs", B). */
export const ENGINE_RELOAD_KINDS = ['sources', 'scope', 'exclusions', 'embedding', 'models', 'archive', 'extraction'] as const;
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

export type EngineCommand =
  | { kind: 'reload'; target: EngineReloadKind }
  | { kind: 'sync_now'; source: string; manual: boolean }
  | { kind: 'start_approved'; source: string }
  | { kind: 'owner_busy'; resource: string }
  | { kind: 'owner_idle'; resource: string }
  | { kind: 'judge_boost'; identities: EngineItemIdentity[] };

export type EngineCommandKind = EngineCommand['kind'];

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
      return { id, command: { kind, target: target as EngineReloadKind } };
    }
    case 'sync_now':
    case 'start_approved': {
      const source = command!.source;
      if (typeof source !== 'string' || !SOURCE.test(source)) fail(`${kind} needs a source.`);
      if (kind === 'start_approved') return { id, command: { kind, source: source as string } };
      return { id, command: { kind, source: source as string, manual: command!.manual === true } };
    }
    case 'owner_busy':
    case 'owner_idle': {
      const resource = command!.resource;
      if (typeof resource !== 'string' || !RESOURCE.test(resource)) fail(`${kind} needs a resource.`);
      return { id, command: { kind, resource: resource as string } };
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

export type EngineCommandHandlers = {
  [K in EngineCommandKind]?: (command: Extract<EngineCommand, { kind: K }>) => Promise<unknown> | unknown;
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
    const handler = this.options.handlers[command.kind] as ((value: EngineCommand) => unknown) | undefined;
    try {
      if (!handler) throw new Error(`${command.kind} is not handled by this background.`);
      const result = await handler(command);
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
