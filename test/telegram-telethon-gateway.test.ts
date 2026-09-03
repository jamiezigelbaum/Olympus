import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'telegram-telethon-reader.py');
const ORDINARY_SCOPE = 'telegram.personal:chat:101';
const PROTECTED_SCOPE = 'telegram.personal:chat:202';
const SAVED_MESSAGES_SCOPE = 'telegram.personal:chat:me';
const SECRET_TEXT = 'TELEGRAM_GATEWAY_SECRET_CONTENT';
const PYTHON = Bun.which('python3');
const pythonTest = test.skipIf(!PYTHON);

describe('long-lived read-only Telethon capture gateway', () => {
  pythonTest('connects once, captures exact approved chats, tags protected records, and keeps forward/backfill cursors separate', async () => {
    const fixture = gatewayFixture();
    try {
      writeFileSync(fixture.backfillPath, `${JSON.stringify({
        request_id: 'history-window-1',
        chat_scope: PROTECTED_SCOPE,
        provider_cursor: 'offset_id:50',
        max_messages: 5,
      })}\n`);

      const first = await runGateway(fixture);
      expect(first.code).toBe(0);
      const report = JSON.parse(first.stdout.trim());
      expect(report).toMatchObject({
        kind: 'telegram_capture_gateway_report',
        status: 'ok',
        credential_endpoint_id: 'telegram_local_telethon_reader',
        approved_chats: 2,
        protected_chats: 1,
        records_captured: 4,
        spool_records: 4,
        spool_newest_age_seconds: 0,
        spool_freshness_status: 'fresh',
        backfill_requests_processed: 1,
        policy: { read_only: true, send: false, connector_store_writes: false, content_logged: false },
      });
      expect(first.stdout).not.toContain(SECRET_TEXT);
      expect(first.stderr).not.toContain(SECRET_TEXT);
      expect(readFileSync(fixture.reportPath, 'utf8')).not.toContain(SECRET_TEXT);

      const calls = readJsonLines(fixture.callLog);
      expect(calls.filter((call) => call.event === 'connect')).toHaveLength(1);
      const reads = calls.filter((call) => call.event === 'read');
      expect(reads).toHaveLength(3);
      expect(reads.map((call) => ({ min_id: call.min_id, offset_id: call.offset_id }))).toEqual([
        { min_id: 0, offset_id: 0 },
        { min_id: 0, offset_id: 0 },
        { min_id: 0, offset_id: 50 },
      ]);
      expect(reads.every((call) => !(call.min_id > 0 && call.offset_id > 0))).toBe(true);

      const spoolPath = join(fixture.spoolDir, '2026-07-22.jsonl');
      const firstSpool = readFileSync(spoolPath, 'utf8');
      const records = readJsonLines(spoolPath);
      expect(records).toHaveLength(4);
      expect(records.filter((record) => record.trust_domain === 'internal')).toHaveLength(2);
      const protectedRecords = records.filter((record) => record.trust_domain === 'secure_local');
      expect(protectedRecords).toHaveLength(2);
      expect(protectedRecords[0]).toMatchObject({
        corpus_id: 'secure_local.telegram.protected.messages',
        classification: { reason: 'lawyer', owner: 'owner' },
      });
      expect(protectedRecords[1]).toMatchObject({ sync_direction: 'backfill', backfill_request_id: 'history-window-1' });
      expect(records.find((record) => record.message.id === '101')).toMatchObject({
        message: {
          senderId: '7',
          senderDisplayName: 'Sam',
          senderIsOwner: true,
          attachments: [{
            attachmentId: 'document:9001',
            type: 'file',
            name: 'quarterly-plan.pdf',
            mimeType: 'application/pdf',
          }],
        },
      });
      expect(new Set(records.map((record) => record.capture_id)).size).toBe(4);
      expect(statSync(fixture.spoolDir).mode & 0o777).toBe(0o700);
      expect(statSync(spoolPath).mode & 0o777).toBe(0o600);
      expect(statSync(fixture.statePath).mode & 0o777).toBe(0o600);

      writeFileSync(fixture.callLog, '');
      const second = await runGateway(fixture);
      expect(second.code).toBe(0);
      expect(JSON.parse(second.stdout.trim())).toMatchObject({ records_captured: 0, spool_records: 4 });
      expect(readFileSync(spoolPath, 'utf8')).toBe(firstSpool);
      const restartReads = readJsonLines(fixture.callLog).filter((call) => call.event === 'read');
      expect(restartReads).toEqual([
        expect.objectContaining({ entity: 101, min_id: 102, offset_id: 0, reverse: true }),
        expect.objectContaining({ entity: 202, min_id: 202, offset_id: 0, reverse: true }),
      ]);
      expect(JSON.parse(readFileSync(fixture.statePath, 'utf8'))).toMatchObject({
        forward_cursors: { [ORDINARY_SCOPE]: 'min_id:102', [PROTECTED_SCOPE]: 'min_id:202' }, backfill_request_line: 1,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  pythonTest('captures new-message events before the reconcile sweep, caches sender names, and advances the cursor monotonically', async () => {
    const fixture = gatewayFixture();
    try {
      const result = await runGateway(fixture, {
        FAKE_TELETHON_SWEEP_EMPTY: 'true',
        FAKE_TELETHON_EVENTS_JSON: JSON.stringify([
          { chat_id: 101, message_id: 103 },
          { chat_id: 101, message_id: 104 },
        ]),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(SECRET_TEXT);
      expect(result.stderr).not.toContain(SECRET_TEXT);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        records_captured: 2,
        spool_records: 2,
        event_lane: {
          events_seen: 2,
          events_appended: 2,
          events_dropped_unapproved: 0,
          errors: 0,
        },
      });
      const spoolPath = join(fixture.spoolDir, '2026-07-22.jsonl');
      const records = readJsonLines(spoolPath);
      expect(records.map((record) => record.message.id)).toEqual(['103', '104']);
      expect(new Set(records.map((record) => record.capture_id)).size).toBe(2);
      expect(JSON.parse(readFileSync(fixture.statePath, 'utf8'))).toMatchObject({
        forward_cursors: { [ORDINARY_SCOPE]: 'min_id:104' },
      });

      const calls = readJsonLines(fixture.callLog);
      expect(calls.filter((call) => call.event === 'sender')).toHaveLength(1);
      expect(calls.filter((call) => call.event === 'read')).toEqual([
        expect.objectContaining({ entity: 101, min_id: 104, offset_id: 0, reverse: true }),
        expect.objectContaining({ entity: 202, min_id: 0, offset_id: 0, reverse: false }),
      ]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  pythonTest('drops unapproved events without provider amplification and routes protected events to secure-local', async () => {
    const fixture = gatewayFixture();
    try {
      const result = await runGateway(fixture, {
        FAKE_TELETHON_SWEEP_EMPTY: 'true',
        OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: `${ORDINARY_SCOPE},${SAVED_MESSAGES_SCOPE}`,
        OLYMPUS_TELEGRAM_CHAT_CLASSIFICATIONS_JSON: JSON.stringify([{
          chatScope: SAVED_MESSAGES_SCOPE,
          trustDomain: 'secure_local',
          reason: 'saved_messages',
        }]),
        FAKE_TELETHON_EVENTS_JSON: JSON.stringify([
          { chat_id: 303, message_id: 303 },
          { chat_id: 999, message_id: 203 },
        ]),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(SECRET_TEXT);
      expect(result.stderr).not.toContain(SECRET_TEXT);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        records_captured: 1,
        spool_records: 1,
        event_lane: {
          events_seen: 2,
          events_appended: 1,
          events_dropped_unapproved: 1,
          errors: 0,
        },
      });
      const records = readJsonLines(join(fixture.spoolDir, '2026-07-22.jsonl'));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        chat_scope: SAVED_MESSAGES_SCOPE,
        conversation_id: 'me',
        trust_domain: 'secure_local',
        corpus_id: 'secure_local.telegram.protected.messages',
        message: { id: '203' },
      });
      const calls = readJsonLines(fixture.callLog);
      expect(calls).not.toContainEqual(expect.objectContaining({ event: 'entity', chat_id: '303' }));
      expect(calls.filter((call) => call.event === 'sender')).toHaveLength(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  pythonTest('contains event-lane failures and lets the reconcile sweep continue', async () => {
    const fixture = gatewayFixture();
    try {
      const result = await runGateway(fixture, {
        FAKE_TELETHON_SWEEP_EMPTY: 'true',
        FAKE_TELETHON_EVENTS_JSON: JSON.stringify([
          { chat_id: 101, message_id: 103, fail_normalize: true },
          { chat_id: 101, message_id: 104 },
        ]),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(SECRET_TEXT);
      expect(result.stderr).not.toContain(SECRET_TEXT);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        records_captured: 1,
        spool_records: 1,
        event_lane: {
          events_seen: 2,
          events_appended: 1,
          events_dropped_unapproved: 0,
          errors: 1,
        },
      });
      expect(readJsonLines(join(fixture.spoolDir, '2026-07-22.jsonl'))).toHaveLength(1);
      expect(readJsonLines(fixture.callLog).filter((call) => call.event === 'read')).toHaveLength(2);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  pythonTest('captures a reaction on an already-swept message without reading or moving the forward cursor', async () => {
    const fixture = gatewayFixture();
    try {
      const swept = await runGateway(fixture);
      expect(swept.code).toBe(0);
      const sweptRecords = readJsonLines(join(fixture.spoolDir, '2026-07-22.jsonl'));
      expect(sweptRecords.map((record) => record.message.id)).toEqual(['101', '102', '202']);
      // An ordinary message the provider said nothing about carries no
      // reaction key and today's source version, byte for byte.
      const original = sweptRecords.find((record) => record.message.id === '101')!;
      expect(original.message).not.toHaveProperty('reactions');
      expect(original.message.sourceVersion).toBe('telegram.personal:101:101:2026-07-22T11:00:00Z');

      // 101 is BELOW the forward cursor the sweep just set: the new-message
      // lane would drop it as "not new". The reaction lane must not.
      const reacted = await runGateway(fixture, {
        FAKE_TELETHON_SWEEP_EMPTY: 'true',
        FAKE_TELETHON_REACTION_UPDATES_JSON: JSON.stringify([{
          chat_id: 101,
          msg_id: 101,
          reactions: [
            { emoticon: '👍', count: 2, actors: [9, 7] },
            { document_id: 5544332211, count: 1, actors: [7] },
          ],
        }]),
      });

      expect(reacted.code).toBe(0);
      expect(reacted.stdout).not.toContain(SECRET_TEXT);
      expect(reacted.stderr).not.toContain(SECRET_TEXT);
      expect(readFileSync(fixture.reportPath, 'utf8')).not.toContain(SECRET_TEXT);
      expect(JSON.parse(reacted.stdout.trim())).toMatchObject({
        records_captured: 1,
        spool_records: 4,
        event_lane: {
          events_appended: 0,
          reactions_seen: 1,
          reactions_appended: 1,
          reactions_dropped_unapproved: 0,
          reactions_dropped_unresolved: 0,
          errors: 0,
        },
      });

      const records = readJsonLines(join(fixture.spoolDir, '2026-07-22.jsonl'));
      expect(records).toHaveLength(4);
      const capture = records[3]!;
      expect(capture).toMatchObject({
        chat_scope: ORDINARY_SCOPE,
        conversation_id: '101',
        sync_direction: 'forward',
        trust_domain: 'internal',
        message: {
          id: '101',
          chatTitle: 'Approved chat',
          chatType: 'group',
          senderId: '7',
          senderDisplayName: 'Sam',
          // The full original text rides the reaction capture: the store
          // replaces an item's representation, so an empty re-emit would
          // delete the chunks of the message the reaction confirms.
          boundedText: `${SECRET_TEXT} 101`,
          attachments: [{ attachmentId: 'document:9001', name: 'quarterly-plan.pdf' }],
          reactions: [
            { key: '👍', count: 2, actors: [{ providerActorId: '7' }, { providerActorId: '9' }] },
            { key: 'custom:5544332211', count: 1, actors: [{ providerActorId: '7' }] },
          ],
        },
      });
      // The aggregate moves the source version, so the capture id moves with
      // it and the re-capture is visible instead of colliding.
      expect(capture.message.sourceVersion).toBe(
        `${original.message.sourceVersion}:r${reactionDigest(capture.message.reactions)}`,
      );
      expect(capture.capture_id).not.toBe(original.capture_id);

      // The cursor is the sweep's alone: untouched by the lane that bypassed it.
      expect(JSON.parse(readFileSync(fixture.statePath, 'utf8')).forward_cursors).toEqual({
        [ORDINARY_SCOPE]: 'min_id:102',
        [PROTECTED_SCOPE]: 'min_id:202',
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  pythonTest('says removal with an explicit empty aggregate and drops unapproved or unfetchable targets', async () => {
    const fixture = gatewayFixture();
    try {
      const result = await runGateway(fixture, {
        FAKE_TELETHON_SWEEP_EMPTY: 'true',
        FAKE_TELETHON_REACTION_UPDATES_JSON: JSON.stringify([
          { chat_id: 101, msg_id: 102 },
          { chat_id: 999, msg_id: 5, reactions: [{ emoticon: '👍', count: 1 }] },
          { chat_id: 202, msg_id: 7, missing: true },
          { chat_id: 202, msg_id: 8, fail_fetch: true },
        ]),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(SECRET_TEXT);
      expect(result.stderr).not.toContain(SECRET_TEXT);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        records_captured: 1,
        spool_records: 1,
        event_lane: {
          reactions_seen: 4,
          reactions_appended: 1,
          reactions_dropped_unapproved: 1,
          reactions_dropped_unresolved: 1,
          errors: 1,
        },
      });

      const records = readJsonLines(join(fixture.spoolDir, '2026-07-22.jsonl'));
      expect(records).toHaveLength(1);
      // The provider now reports no aggregate at all for a message it just
      // told us about: that is a removal, and only an explicit empty list
      // carries it to the store. The strip filter must let it through.
      expect(records[0]!.message.reactions).toEqual([]);
      expect(records[0]!.message.boundedText).toBe(`${SECRET_TEXT} 102`);
      expect(records[0]!.message.sourceVersion).toBe(
        `telegram.personal:101:102:2026-07-22T11:00:00Z:r${reactionDigest([])}`,
      );
      // Nothing was fetched for the unapproved chat.
      const calls = readJsonLines(fixture.callLog);
      expect(calls).not.toContainEqual(expect.objectContaining({ event: 'get_messages', entity: 999 }));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  pythonTest('bounds an oversized aggregate by truncation instead of refusing the capture', async () => {
    const fixture = gatewayFixture();
    try {
      // 40 tokens, the largest carrying 40 reactors: past both the token cap
      // and the per-token actor cap the store enforces.
      const wide = Array.from({ length: 40 }, (_, index) => ({
        emoticon: `r${index}`,
        count: 40 - index,
        actors: index === 0 ? Array.from({ length: 40 }, (_, actor) => 100 + actor) : [],
      }));
      // 32 tokens each with 32 reactors: inside every count bound, past the
      // serialized-size bound.
      const heavy = Array.from({ length: 32 }, (_, index) => ({
        emoticon: `h${index}`,
        count: 32 - index,
        actors: Array.from({ length: 32 }, (_, actor) => 200 + actor),
      }));
      const result = await runGateway(fixture, {
        FAKE_TELETHON_SWEEP_EMPTY: 'true',
        FAKE_TELETHON_REACTION_UPDATES_JSON: JSON.stringify([
          { chat_id: 101, msg_id: 101, reactions: wide },
          { chat_id: 101, msg_id: 102, reactions: heavy },
        ]),
      });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        records_captured: 2,
        event_lane: { reactions_seen: 2, reactions_appended: 2, errors: 0 },
      });

      const records = readJsonLines(join(fixture.spoolDir, '2026-07-22.jsonl'));
      const wideReactions = records[0]!.message.reactions;
      expect(wideReactions).toHaveLength(32);
      expect(wideReactions.map((entry: any) => entry.key)).toEqual(
        Array.from({ length: 32 }, (_, index) => `r${index}`),
      );
      // The count stays the provider's TRUE total even though the listed
      // reactors were capped: a capped list is partial, not a smaller count.
      expect(wideReactions[0]).toMatchObject({ key: 'r0', count: 40 });
      expect(wideReactions[0].actors).toHaveLength(32);

      const heavyReactions = records[1]!.message.reactions;
      expect(JSON.stringify(heavyReactions).length).toBeLessThanOrEqual(4_000);
      expect(heavyReactions.length).toBeGreaterThan(0);
      expect(heavyReactions.length).toBeLessThan(32);
      // Truncation drops the smallest counts, never the largest.
      expect(heavyReactions[0]).toMatchObject({ key: 'h0', count: 32 });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  pythonTest('ignores partial requests and rejects wildcard or unapproved classification scope before provider access', async () => {
    const fixture = gatewayFixture();
    try {
      writeFileSync(fixture.backfillPath, JSON.stringify({ request_id: 'partial', chat_scope: ORDINARY_SCOPE, provider_cursor: 'offset_id:50' }));
      const partial = await runGateway(fixture);
      expect(partial.code).toBe(0);
      expect(JSON.parse(partial.stdout.trim())).toMatchObject({ backfill_requests_processed: 0 });
      const denied = await runGateway(fixture, {
        OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: 'telegram.personal:chat:*', OLYMPUS_TELEGRAM_API_ID: '',
        OLYMPUS_TELEGRAM_API_HASH: '', OLYMPUS_TELEGRAM_SESSION_PATH: '',
      });
      expect(denied.code).toBe(2);
      expect(lastLine(denied.stderr)).toBe('{"error":"wildcard_chat_scope_denied"}');
      expect(denied.stderr).not.toContain(SECRET_TEXT);

      writeFileSync(fixture.callLog, '');
      const unapprovedClassification = await runGateway(fixture, {
        OLYMPUS_TELEGRAM_CHAT_CLASSIFICATIONS_JSON: JSON.stringify([{
          chatScope: 'telegram.personal:chat:303',
          trustDomain: 'secure_local',
          reason: 'protected',
        }]),
      });
      expect(unapprovedClassification.code).toBe(2);
      expect(lastLine(unapprovedClassification.stderr)).toBe('{"error":"classification_scope_not_approved"}');
      expect(unapprovedClassification.stderr).not.toContain(SECRET_TEXT);
      expect(readJsonLines(fixture.callLog)).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);
});

function gatewayFixture() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-gateway-'));
  const fakeModuleDir = join(root, 'fake-python');
  const stateDir = join(root, 'state');
  const spoolDir = join(root, 'spool');
  const reportPath = join(root, 'report', 'current.json');
  const callLog = join(root, 'telethon-calls.jsonl');
  const backfillPath = join(stateDir, 'backfill-requests.jsonl');
  mkdirSync(join(fakeModuleDir, 'telethon', 'tl'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  chmodSync(stateDir, 0o700);
  writeFileSync(callLog, '');
  // A package rather than a single module: the gateway imports the raw update
  // type it filters reactions on from telethon.tl.types, exactly as the live
  // library exposes it.
  writeFileSync(join(fakeModuleDir, 'telethon', '__init__.py'), fakeTelethonModule());
  writeFileSync(join(fakeModuleDir, 'telethon', 'tl', '__init__.py'), '');
  writeFileSync(join(fakeModuleDir, 'telethon', 'tl', 'types.py'), fakeTelethonTypesModule());
  return {
    root,
    fakeModuleDir,
    callLog,
    stateDir,
    statePath: join(stateDir, 'state.json'),
    spoolDir,
    reportPath,
    backfillPath,
  };
}

async function runGateway(fixture: ReturnType<typeof gatewayFixture>, overrides: Record<string, string> = {}) {
  const proc = Bun.spawn([PYTHON ?? 'python3', SCRIPT, '--gateway', '--once', '--report', fixture.reportPath], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      PYTHONPATH: fixture.fakeModuleDir,
      FAKE_TELETHON_CALL_LOG: fixture.callLog,
      OLYMPUS_TELEGRAM_API_ID: '12345',
      OLYMPUS_TELEGRAM_API_HASH: 'hash',
      OLYMPUS_TELEGRAM_SESSION_PATH: join(fixture.root, 'telegram.session'),
      OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: `${ORDINARY_SCOPE},${PROTECTED_SCOPE}`,
      OLYMPUS_TELEGRAM_CHAT_CLASSIFICATIONS_JSON: JSON.stringify([{
        chatScope: PROTECTED_SCOPE,
        trustDomain: 'secure_local',
        reason: 'lawyer',
        owner: 'owner',
        reviewedAt: '2026-07-22',
      }]),
      OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: fixture.stateDir,
      OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: fixture.spoolDir,
      OLYMPUS_TELEGRAM_GATEWAY_BACKFILL_REQUESTS_PATH: fixture.backfillPath,
      OLYMPUS_TELEGRAM_GATEWAY_NOW: '2026-07-22T12:00:00Z',
      ...overrides,
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function readJsonLines(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function lastLine(value: string): string {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

/**
 * The digest the gateway appends to a source version, recomputed here over the
 * SAME canonical serialization the shared store writes into its column — field
 * order included, which the sorted-key spool line does not preserve.
 */
function reactionDigest(reactions: ReadonlyArray<Record<string, any>>): string {
  const canonical = JSON.stringify(reactions.map((reaction) => ({
    key: reaction.key,
    count: reaction.count,
    ...(reaction.actors?.length ? { actors: reaction.actors } : {}),
  })));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

function fakeTelethonTypesModule(): string {
  return `
class PeerUser:
    def __init__(self, user_id):
        self.user_id = user_id

class PeerChannel:
    def __init__(self, channel_id):
        self.channel_id = channel_id

class ReactionEmoji:
    def __init__(self, emoticon):
        self.emoticon = emoticon

class ReactionCustomEmoji:
    def __init__(self, document_id):
        self.document_id = document_id

class ReactionCount:
    def __init__(self, reaction, count):
        self.reaction = reaction
        self.count = count

class MessagePeerReaction:
    def __init__(self, peer_id, reaction):
        self.peer_id = peer_id
        self.reaction = reaction

class MessageReactions:
    def __init__(self, results, recent_reactions=None):
        self.results = results
        self.recent_reactions = recent_reactions or []

class UpdateMessageReactions:
    def __init__(self, peer, msg_id, reactions):
        self.peer = peer
        self.msg_id = msg_id
        self.reactions = reactions

def reactions_from_spec(entries):
    """Build a provider aggregate the way Telegram delivers one: complete
    results plus a partial, recent-only actor list."""
    if entries is None:
        return None
    results = []
    recent = []
    for entry in entries:
        if "document_id" in entry:
            reaction = ReactionCustomEmoji(entry["document_id"])
        else:
            reaction = ReactionEmoji(entry["emoticon"])
        results.append(ReactionCount(reaction, entry["count"]))
        for actor in entry.get("actors", []):
            recent.append(MessagePeerReaction(PeerUser(actor), reaction))
    return MessageReactions(results, recent)
`;
}

function fakeTelethonModule(): string {
  return `
import datetime as dt
import asyncio
import json
import os

from .tl.types import PeerChannel, UpdateMessageReactions, reactions_from_spec

def log(event):
    with open(os.environ["FAKE_TELETHON_CALL_LOG"], "a", encoding="utf-8") as output:
        output.write(json.dumps(event, separators=(",", ":")) + "\\n")

def reaction_specs():
    return json.loads(os.environ.get("FAKE_TELETHON_REACTION_UPDATES_JSON", "[]"))

class Entity:
    def __init__(self, entity_id):
        self.id = entity_id
        self.title = "Approved chat"
        self.megagroup = True
        self.broadcast = False
        self.bot = False

class Sender:
    first_name = "Sam"
    last_name = ""

class DocumentAttributeFilename:
    file_name = "quarterly-plan.pdf"

class Document:
    id = 9001
    mime_type = "application/pdf"
    size = 1234
    attributes = [DocumentAttributeFilename()]

class Message:
    def __init__(self, message_id, fail_normalize=False, reactions=None):
        self.id = message_id
        self.date = dt.datetime(2026, 7, 22, 11, 0, tzinfo=dt.timezone.utc)
        self.edit_date = None
        self.sender_id = 7
        self.out = True
        self._fail_normalize = fail_normalize
        self.reply_to_msg_id = None
        self.forward = None
        self.document = Document() if message_id == 101 else None
        self.media = self.document
        self.photo = None
        self.reactions = reactions
    @property
    def raw_text(self):
        if self._fail_normalize:
            raise RuntimeError("fake_event_normalize_failed")
        return "${SECRET_TEXT} " + str(self.id)
    async def get_sender(self):
        log({"event":"sender","sender_id":self.sender_id})
        return Sender()

class Event:
    def __init__(self, spec):
        self.chat_id = spec["chat_id"]
        self.chat = Entity(self.chat_id)
        self.message = Message(spec["message_id"], bool(spec.get("fail_normalize", False)))

class NewMessage:
    pass

class Raw:
    def __init__(self, types=None):
        self.types = types or []

class Events:
    NewMessage = NewMessage
    Raw = Raw

events = Events()

class TelegramClient:
    def __init__(self, session_path, api_id, api_hash):
        self.session_path = session_path
        self._event_tasks = []
    async def __aenter__(self):
        log({"event":"connect"})
        return self
    async def __aexit__(self, exc_type, exc, tb):
        if self._event_tasks:
            await asyncio.gather(*self._event_tasks)
        return False
    async def get_entity(self, chat_id):
        log({"event":"entity","chat_id":str(chat_id)})
        return Entity(999 if chat_id == "me" else int(chat_id))
    async def get_peer_id(self, peer):
        for attribute in ("user_id", "channel_id", "chat_id", "id"):
            value = getattr(peer, attribute, None)
            if isinstance(value, int):
                return value
        return int(peer)
    async def get_messages(self, entity, ids=None):
        log({"event":"get_messages","entity":getattr(entity, "id", entity),"ids":ids})
        for spec in reaction_specs():
            if spec["chat_id"] != getattr(entity, "id", entity) or spec["msg_id"] != ids:
                continue
            if spec.get("fail_fetch"):
                raise RuntimeError("fake_reaction_fetch_failed")
            if spec.get("missing"):
                return None
            return Message(ids, reactions=reactions_from_spec(spec.get("reactions")))
        return None
    def add_event_handler(self, callback, event_builder):
        if isinstance(event_builder, Raw):
            assert UpdateMessageReactions in event_builder.types
            async def emit_raw():
                for spec in reaction_specs():
                    await callback(UpdateMessageReactions(
                        PeerChannel(spec["chat_id"]),
                        spec["msg_id"],
                        reactions_from_spec(spec.get("reactions")),
                    ))
            self._event_tasks.append(asyncio.create_task(emit_raw()))
            return
        specs = json.loads(os.environ.get("FAKE_TELETHON_EVENTS_JSON", "[]"))
        async def emit():
            for spec in specs:
                await callback(Event(spec))
        self._event_tasks.append(asyncio.create_task(emit()))
    async def iter_messages(self, entity, limit, offset_id=0, min_id=0, reverse=False):
        log({"event":"read","entity":entity.id,"limit":limit,"offset_id":offset_id,"min_id":min_id,"reverse":reverse})
        if os.environ.get("FAKE_TELETHON_SWEEP_EMPTY") == "true":
            ids = []
        elif offset_id:
            ids = [offset_id - 1]
        elif entity.id == 101:
            ids = [101, 102]
        else:
            ids = [202]
        for message_id in ids:
            if message_id > min_id:
                yield Message(message_id)
`;
}
