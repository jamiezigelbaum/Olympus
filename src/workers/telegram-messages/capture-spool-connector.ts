// Contract 1 adapter for the append-only Telegram capture spool. The Telethon
// helper owns provider/session semantics and writes validated-scope records;
// this connector owns only durable local listing, normalization and trust.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceSensitivity,
} from '../../core/source-index/types.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  type TelegramMessagesCorpusId,
  type TelegramMessagesCorpusTrustDomain,
} from './corpus-adapter.ts';

// Product capture and migration replay are independent writers with
// independent cursors. Reusing the historical `telegram_spool_replay_*`
// owner ids lets a replay run advance the product scheduler past unread live
// capture (or vice versa), so the product lane has its own stable lineage.
export const TELEGRAM_CAPTURE_CONNECTOR_ID = 'telegram_capture_spool';
export const TELEGRAM_CAPTURE_CONNECTOR_IDS = {
  internal: `${TELEGRAM_CAPTURE_CONNECTOR_ID}_internal`,
  secure_local: `${TELEGRAM_CAPTURE_CONNECTOR_ID}_secure_local`,
} as const;
// Removing the internal lane's copy of a reclassified message is a local write,
// not a traversal. It gets its own run lineage because a completed run under
// the lane's own id carries no cursor, and the lane would resume from that
// emptiness — a full spool rescan — on its very next pull.
export const TELEGRAM_TRUST_EVICTION_CONNECTOR_ID = `${TELEGRAM_CAPTURE_CONNECTOR_ID}_trust_eviction`;
// The one-time sweep over duplication that predates the trust invariant keeps
// its resume cursor in the internal store's run history. It cannot share the
// eviction lineage: eviction runs carry no cursor, so one inline eviction
// would erase the sweep's durable position.
export const TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID = `${TELEGRAM_CAPTURE_CONNECTOR_ID}_trust_reconciliation`;

const MAX_SPOOL_BYTES = 768_000_000;
const MAX_RECORDS = 1_000_000;
const MAX_TEXT_CHARS = 4_000_000;
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 10_000;

export interface TelegramCaptureSpoolRecord {
  captureId: string;
  capturedAt: string;
  capturedItem: {
    item: RawItem;
    trustDomain: TelegramMessagesCorpusTrustDomain;
  };
}

export interface TelegramCaptureSpoolReadResult {
  records: TelegramCaptureSpoolRecord[];
  malformedRecords: number;
  /**
   * localItemId -> the one trust domain this read resolved the item to, for
   * items whose spool records disagreed. Only conflicted items appear here.
   */
  trustConflicts: ReadonlyMap<string, TelegramMessagesCorpusTrustDomain>;
  resumeCursor?: string;
  exhausted: boolean;
}

export function defaultTelegramCaptureSpoolDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const home = env.HOME?.trim() || homedir();
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  return env.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR?.trim()
    || env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR?.trim()
    || join(dataHome, 'olympus', 'telegram-capture', 'spool');
}

export function createTelegramCaptureSpoolConnector(options: {
  spoolDir: string;
  trustDomain: TelegramMessagesCorpusTrustDomain;
  /**
   * Trust resolutions computed over a wider window than one page of this lane
   * can see — the pull preflight reads the whole unread spool window. Applying
   * them here is what keeps a message whose classification changed in exactly
   * one lane even when only its looser copy falls inside this lane's page.
   */
  resolvedTrustByItemId?: ReadonlyMap<string, TelegramMessagesCorpusTrustDomain>;
  /**
   * The last spool position those resolutions were computed over. The spool is
   * appended to while a pull runs, so without this bound a lane would index a
   * record that no resolution ever saw. `null` bounds the lane to nothing.
   */
  admitThroughCursor?: string | null;
}): SourceConnector {
  const spoolDir = requiredString(options.spoolDir, 'spool directory');
  const trustDomain = options.trustDomain;
  const resolved = options.resolvedTrustByItemId
    ? { resolvedTrustByItemId: options.resolvedTrustByItemId }
    : {};
  const bound = options.admitThroughCursor === undefined
    ? {}
    : { admitThroughCursor: options.admitThroughCursor };
  return {
    id: TELEGRAM_CAPTURE_CONNECTOR_IDS[trustDomain],
    family: 'chat',

    async authenticate(): Promise<void> {
      assertTelegramCaptureSpoolDirectory(spoolDir);
    },

    // The spool is a durable backlog, not a live tail: a migration replay or a
    // reconnected gateway can leave hundreds of thousands of unread records.
    // Yielding a single page per run capped every sync at one page — a 200k
    // backlog then needed weeks of scheduler intervals, and a max-items budget
    // larger than one page silently delivered one page. Keep paging until the
    // spool is exhausted or the run's budget is spent.
    listItems(listOptions: SourceConnectorListOptions = {}): AsyncIterable<SourceConnectorListPage> {
      const budget = normalizeBudget(listOptions.limit);
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        let cursor = listOptions.cursor;
        let remaining = budget;
        for (;;) {
          // Every page re-reads the spool from its cursor, so the page limit
          // is what bounds one read's memory AND how often that re-read
          // happens. The default keeps the per-page cost unchanged; a run with
          // a budget spends it in whole pages so the spine never has to
          // abandon one mid-page.
          const result = readTelegramCaptureSpool({
            spoolDir,
            trustDomain,
            limit: remaining === undefined ? DEFAULT_PAGE_LIMIT : Math.min(remaining, MAX_PAGE_LIMIT),
            malformedPolicy: 'skip',
            ...(cursor ? { cursor } : {}),
            ...resolved,
            ...bound,
          });
          if (remaining !== undefined) remaining -= result.records.length;
          yield {
            items: result.records.map((record) => record.capturedItem.item),
            ...(result.resumeCursor ? { nextCursor: result.resumeCursor } : {}),
            done: result.exhausted,
          };
          if (result.exhausted) return;
          if (remaining !== undefined && remaining <= 0) return;
          // A page that stopped short of the spool always carries the resume
          // point that produced it. Refusing to loop without a NEW one keeps a
          // future reader from spinning on the same window forever.
          if (!result.resumeCursor || result.resumeCursor === cursor) return;
          cursor = result.resumeCursor;
        }
      })();
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      const result = readTelegramCaptureSpool({
        spoolDir,
        trustDomain,
        malformedPolicy: 'skip',
        ...resolved,
        ...bound,
      });
      let found: RawItem | undefined;
      for (const record of result.records) {
        if (record.capturedItem.item.identity.localItemId === localItemId) {
          found = record.capturedItem.item;
        }
      }
      if (!found) throw new Error('Telegram capture spool cannot fetch an unknown item.');
      return found;
    },

    classify(): SourceSensitivity {
      return buildSourceSensitivity({
        trustTier: trustDomain === 'secure_local' ? 'S4' : 'S3',
        trustDomain,
      });
    },
  };
}

export function readTelegramCaptureSpool(options: {
  spoolDir: string;
  cursor?: string;
  trustDomain?: TelegramMessagesCorpusTrustDomain;
  limit?: number;
  /** Product capture advances past damaged records; migration remains strict. */
  malformedPolicy?: 'reject' | 'skip';
  /** Trust resolutions observed over a wider window than this read's own. */
  resolvedTrustByItemId?: ReadonlyMap<string, TelegramMessagesCorpusTrustDomain>;
  /**
   * Highest spool position this read may admit, as a `<file>:<lines>` cursor.
   * Records past it are left for a later read; `null` admits none at all.
   * Unset reads the spool to its tail, which is what an unresolved caller —
   * a preflight, a migration replay — wants.
   */
  admitThroughCursor?: string | null;
}): TelegramCaptureSpoolReadResult {
  assertTelegramCaptureSpoolDirectory(options.spoolDir);
  const cursor = parseTelegramCaptureSpoolCursor(options.cursor);
  // An empty resolved window and a resolved window ending mid-file are the same
  // rule: `''` sorts before every dated spool name, so nothing is admissible.
  const admitThrough = options.admitThroughCursor === null
    ? { file: '', line: 0 }
    : parseTelegramCaptureSpoolCursor(options.admitThroughCursor);
  const limit = options.limit === undefined ? undefined : normalizeLimit(options.limit);
  const names = readdirSync(options.spoolDir)
    .filter((value) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(value))
    .sort();
  if (cursor && !names.includes(cursor.file) && names.some((name) => name < cursor.file)) {
    throw new Error('Telegram capture spool cursor file is missing.');
  }

  const records: TelegramCaptureSpoolRecord[] = [];
  const trustByIdentity = new Map<string, TelegramMessagesCorpusTrustDomain>();
  const trustConflicts = new Map<string, TelegramMessagesCorpusTrustDomain>();
  let recordsSeen = 0;
  let malformedRecords = 0;
  let bytes = 0;
  let resumeCursor = options.cursor;
  let exhausted = true;
  outer: for (const [fileIndex, name] of names.entries()) {
    if (cursor && name < cursor.file) continue;
    // Spool names sort by date, so a file past the admissible bound ends the
    // read: it is neither opened nor charged against the byte ceiling.
    if (admitThrough && name > admitThrough.file) break;
    const path = join(options.spoolDir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Telegram capture spool refuses non-regular JSONL files.');
    }
    bytes += stat.size;
    if (bytes > MAX_SPOOL_BYTES) throw new Error('Telegram capture spool exceeds its bounded byte capacity.');
    const payload = readFileSync(path, 'utf8');
    const complete = payload.endsWith('\n') ? payload : payload.slice(0, payload.lastIndexOf('\n') + 1);
    const lines = complete ? complete.slice(0, -1).split('\n') : [];
    const startLine = cursor?.file === name ? cursor.line : 0;
    if (startLine > lines.length) throw new Error('Telegram capture spool cursor is beyond the durable spool tail.');
    // The bound stops the read inside the file that holds it. `resumeCursor` is
    // only ever assigned for a line this read consumed, so the position handed
    // back is the bound rather than the file's growing tail.
    const admitLine = admitThrough && name === admitThrough.file
      ? Math.min(lines.length, admitThrough.line)
      : lines.length;

    for (let lineIndex = startLine; lineIndex < admitLine; lineIndex += 1) {
      const line = lines[lineIndex]!;
      resumeCursor = `${name}:${lineIndex + 1}`;
      if (!line.trim()) continue;
      recordsSeen += 1;
      if (recordsSeen > MAX_RECORDS) {
        throw new Error('Telegram capture spool exceeds its bounded record capacity.');
      }
      let record: TelegramCaptureSpoolRecord;
      try {
        record = parseTelegramCaptureSpoolRecord(line);
      } catch {
        if (options.malformedPolicy !== 'skip') {
          throw new Error('Telegram capture spool found a malformed record.');
        }
        // A damaged append-only record cannot be repaired in place and must
        // not wedge every later message forever. Advance past it, count it in
        // the product receipt, and expose none of its contents or parse error.
        malformedRecords += 1;
        continue;
      }
      const identityKey = record.capturedItem.item.identity.localItemId;
      const observedTrust = record.capturedItem.trustDomain;
      const priorTrust = trustByIdentity.get(identityKey);
      // A conversation reclassified between live capture and backfill writes
      // the same message into the append-only spool under both trust domains.
      // Refusing the window was fail-STOP: every later preflight re-read the
      // same disagreement, neither lane ever wrote again, and the spool cannot
      // be edited to repair it. Resolve it fail-safe instead — the more
      // restrictive domain wins, so a message can only ever move INTO the
      // stricter lane, never out of it — and count it so the disagreement
      // stays visible in the pull receipt.
      const resolvedTrust = mostRestrictiveTrust(
        observedTrust,
        priorTrust,
        options.resolvedTrustByItemId?.get(identityKey),
      );
      if (resolvedTrust !== observedTrust || (priorTrust !== undefined && priorTrust !== observedTrust)) {
        trustConflicts.set(identityKey, resolvedTrust);
      }
      if (priorTrust !== undefined && priorTrust !== resolvedTrust) {
        // Copies already collected under the looser domain belong to no lane.
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (records[index]!.capturedItem.item.identity.localItemId === identityKey) {
            records.splice(index, 1);
          }
        }
      }
      trustByIdentity.set(identityKey, resolvedTrust);
      if (resolvedTrust !== observedTrust) continue;
      if (options.trustDomain === undefined || resolvedTrust === options.trustDomain) {
        records.push(record);
        if (limit !== undefined && records.length >= limit) {
          const isLastLine = lineIndex === lines.length - 1;
          const isLastFile = fileIndex === names.length - 1;
          exhausted = isLastLine && isLastFile;
          break outer;
        }
      }
    }
  }
  return {
    records,
    malformedRecords,
    trustConflicts,
    ...(resumeCursor ? { resumeCursor } : {}),
    exhausted,
  };
}

/**
 * The safe reading of a disagreement: content may only be pulled toward the
 * stricter lane. `secure_local` therefore wins over `internal` no matter which
 * record was written first.
 */
function mostRestrictiveTrust(
  observed: TelegramMessagesCorpusTrustDomain,
  ...others: readonly (TelegramMessagesCorpusTrustDomain | undefined)[]
): TelegramMessagesCorpusTrustDomain {
  return observed === 'secure_local' || others.includes('secure_local') ? 'secure_local' : 'internal';
}

function assertTelegramCaptureSpoolDirectory(spoolDir: string): void {
  if (!existsSync(spoolDir)) throw new Error('Telegram capture spool directory does not exist.');
  const dir = lstatSync(spoolDir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) {
    throw new Error('Telegram capture spool requires a real directory.');
  }
}

function parseTelegramCaptureSpoolCursor(value: string | undefined): { file: string; line: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}\.jsonl):([0-9]+)$/.exec(value);
  const line = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(line)) {
    throw new Error('Telegram capture spool cursor must look like <YYYY-MM-DD.jsonl>:<line-count>.');
  }
  return { file: match[1]!, line };
}

function parseTelegramCaptureSpoolRecord(line: string): TelegramCaptureSpoolRecord {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error('Telegram capture spool found invalid JSON.'); }
  const record = requireObject(value, 'record');
  if (record.schema_version !== 1 || record.provider !== 'telegram') {
    throw new Error('Telegram capture spool found an unsupported record.');
  }
  const account = requiredString(record.account, 'account');
  const conversationId = requiredString(record.conversation_id, 'conversation id');
  const chatScope = requiredString(record.chat_scope, 'chat scope');
  if (chatScope !== `${account}:chat:${conversationId}`) {
    throw new Error('Telegram capture spool found a record outside its declared conversation.');
  }
  const trustDomain = telegramTrust(record.trust_domain);
  const corpusId = telegramCorpus(record.corpus_id);
  assertTrustCorpus(trustDomain, corpusId);
  const classification = requireObject(record.classification, 'classification');
  if (classification.trust_domain !== trustDomain || !requiredString(classification.reason, 'classification reason')) {
    throw new Error('Telegram capture spool found inconsistent classification inputs.');
  }
  if (record.sync_direction !== 'forward' && record.sync_direction !== 'backfill') {
    throw new Error('Telegram capture spool found an invalid sync direction.');
  }
  const message = requireObject(record.message, 'message');
  const messageId = requiredString(message.id, 'message id');
  if (requiredString(message.conversationId ?? message.chatId, 'message conversation') !== conversationId) {
    throw new Error('Telegram capture spool found a message outside its declared conversation.');
  }
  const capturedAt = timestamp(record.captured_at, 'capture timestamp');
  const sourceVersion = optionalString(message.sourceVersion);
  const captureId = requiredSha256(record.capture_id, 'capture id');
  const expected = sha256([account, conversationId, messageId, sourceVersion ?? ''].join('\x1f'));
  if (captureId !== expected) throw new Error('Telegram capture spool found a capture identity mismatch.');
  return {
    captureId,
    capturedAt,
    capturedItem: messageToCapturedItem({
      account,
      conversationId,
      trustDomain,
      corpusId,
      message,
      fetchedAt: capturedAt,
    }),
  };
}

function messageToCapturedItem(input: {
  account: string;
  conversationId: string;
  trustDomain: TelegramMessagesCorpusTrustDomain;
  corpusId: TelegramMessagesCorpusId;
  message: Record<string, unknown>;
  fetchedAt: string;
}): TelegramCaptureSpoolRecord['capturedItem'] {
  const messageId = requiredString(input.message.id, 'message id');
  const boundedText = optionalString(input.message.boundedText);
  if (boundedText && boundedText.length > MAX_TEXT_CHARS) {
    throw new Error('Telegram capture spool message exceeds its bounded text capacity.');
  }
  const attachmentNames = captureAttachmentNames(input.message);
  const searchText = captureSearchText(boundedText, attachmentNames);
  const identity: SourceItemIdentity = {
    family: 'chat',
    provider: 'telegram',
    accountScope: input.account,
    providerItemId: messageId,
    providerConversationId: input.conversationId,
    localItemId: `${input.account}:${input.conversationId}:${messageId}`,
    ...(optionalString(input.message.threadId) ? { providerThreadId: optionalString(input.message.threadId)! } : {}),
    ...(optionalString(input.message.sourceVersion) ? { sourceVersion: optionalString(input.message.sourceVersion)! } : {}),
  };
  const metadata = {
    title: optionalString(input.message.chatTitle) ?? `Telegram conversation ${sha256(input.conversationId).slice(0, 12)}`,
    ...(searchText ? { searchText } : {}),
    sentAt: optionalTimestamp(input.message.sentAt, 'sent timestamp'),
    editedAt: optionalTimestamp(input.message.editedAt, 'edited timestamp'),
    senderId: optionalString(input.message.senderId),
    senderDisplayName: optionalString(input.message.senderDisplayName),
    senderLabel: optionalString(input.message.senderDisplayName) ?? optionalString(input.message.senderId),
    senderIsOwner: optionalBoolean(input.message.senderIsOwner),
    replyToMessageId: optionalString(input.message.replyToMessageId),
    forwardSource: optionalString(input.message.forwardSource),
    chatType: optionalString(input.message.chatType),
    attachments: Array.isArray(input.message.attachments) ? input.message.attachments : [],
    reactions: input.message.reactions,
    corpusId: input.corpusId,
    trustDomain: input.trustDomain,
  };
  return {
    trustDomain: input.trustDomain,
    item: {
      identity,
      mimeType: 'text/plain; charset=utf-8',
      content: boundedText ? { kind: 'text', text: boundedText } : { kind: 'metadata_only' },
      metadata: Object.freeze(metadata),
      fetchedAt: input.fetchedAt,
    },
  };
}

function captureAttachmentNames(message: Record<string, unknown>): string[] {
  const values: string[] = [];
  if (Array.isArray(message.attachmentNames)) {
    for (const value of message.attachmentNames) {
      const name = optionalString(value);
      if (name) values.push(name);
    }
  }
  if (Array.isArray(message.attachments)) {
    for (const value of message.attachments) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const name = optionalString((value as Record<string, unknown>).name);
      if (name) values.push(name);
    }
  }
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function captureSearchText(boundedText: string | undefined, attachmentNames: readonly string[]): string | undefined {
  const value = [boundedText, ...attachmentNames].filter((part): part is string => Boolean(part)).join('\n');
  if (!value) return undefined;
  if (value.length > MAX_TEXT_CHARS) throw new Error('Telegram capture spool search text exceeds its bounded capacity.');
  return value;
}

function assertTrustCorpus(trust: TelegramMessagesCorpusTrustDomain, corpus: TelegramMessagesCorpusId): void {
  const expected = trust === 'secure_local'
    ? PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID
    : INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID;
  if (corpus !== expected) throw new Error('Telegram capture spool found a corpus/trust mismatch.');
}

function telegramTrust(value: unknown): TelegramMessagesCorpusTrustDomain {
  if (value !== 'internal' && value !== 'secure_local') {
    throw new Error('Telegram capture spool found an invalid trust domain.');
  }
  return value;
}

function telegramCorpus(value: unknown): TelegramMessagesCorpusId {
  if (value !== INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID && value !== PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID) {
    throw new Error('Telegram capture spool found an invalid corpus id.');
  }
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Telegram capture spool ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_CHARS) {
    throw new Error(`Telegram capture spool ${label} is invalid.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function timestamp(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Telegram capture spool ${label} is invalid.`);
  return new Date(result).toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : timestamp(value, label);
}

function requiredSha256(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`Telegram capture spool ${label} is invalid.`);
  return result;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Telegram capture spool limit must be positive.');
  return Math.min(value, MAX_PAGE_LIMIT);
}

/**
 * A listing `limit` is the RUN's item budget, not a page size: the connector
 * spine passes its max-items budget there. Capping it at one page is what made
 * a 50,000-item budget deliver 10,000 items and stop, so the budget keeps its
 * full value and only each page is capped.
 */
function normalizeBudget(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Telegram capture spool limit must be positive.');
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
