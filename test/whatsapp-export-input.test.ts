// A WhatsApp chat export as an input of the WhatsApp connector
// (docs/design/archive-live-one-dataset.md, sections 1, 4, 5 and 7): one
// dataset with live capture, matched by counted keys in the zone under which
// they match, with chats joined by name and media as children. Every name,
// time and sentence here is made up.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchiveImportFinding } from '../src/core/archive-formats.ts';
import type { SourceConnector } from '../src/core/contracts.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archiveFileEntries, archiveManifestSha256, buildArchiveManifest } from '../src/workers/archive-import/manifest.ts';
import { holdingItems } from '../src/workers/archive-import/source-input.ts';
import { WHATSAPP_ARCHIVE_FORMAT } from '../src/core/archive-formats.ts';
import '../src/workers/archive-import/whatsapp/connector.ts';
import { parseArchiveInputMedia } from '../src/workers/archive-import/input-media.ts';
import type { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createWhatsAppExportInput, WHATSAPP_INPUT_FINDINGS } from '../src/workers/whatsapp/archive-input.ts';
import { WHATSAPP_LANE_SYNC, whatsAppConnectorWithInputs } from '../src/workers/whatsapp/archive-target.ts';
import { chooseExportTimeZone, wallTimeToUtcMs } from '../src/workers/whatsapp/export-zone.ts';
import { WHATSAPP_LIVE_CORPUS_ID, createWhatsAppTierLane } from '../src/workers/whatsapp/store-sync.ts';
import { chatText, notice, type SyntheticMessage } from './support/archive-fixtures-whatsapp.ts';
import { WHATSAPP_FIXTURES } from '../scripts/release-check/archive-fixtures.ts';
import { WHATSAPP_BESIDE_CHAT, WHATSAPP_BESIDE_SHARED } from '../scripts/release-check/archive-live-seed-whatsapp.ts';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'whatsapp-export-input-'));
  roots.push(root);
  return root;
}

const ROWAN = '15550001111@s.whatsapp.net';
const OTHER = '15550002222@s.whatsapp.net';
const ZONES = ['UTC', 'America/New_York', 'Europe/Lisbon', 'Asia/Tokyo'];

/** A bridge spool line. */
function spoolLine(fields: Record<string, unknown>): string {
  return `${JSON.stringify({
    chat_jid: ROWAN,
    chat_name: 'Rowan Hale',
    sender_jid: ROWAN,
    sender_name: 'ro',
    sender_contact_name: 'Rowan Hale',
    from_me: false,
    text: '',
    ...fields,
  })}\n`;
}

interface Lane {
  root: string;
  spoolDir: string;
  exportDir: string;
  set: TieredStoreSet;
  store: LocalConnectorStore;
  connector: SourceConnector;
}

function lane(): Lane {
  const root = workspace();
  const spoolDir = join(root, 'spool');
  const exportDir = join(root, 'Exports');
  mkdirSync(spoolDir, { recursive: true });
  mkdirSync(exportDir, { recursive: true });
  const store = new LocalConnectorStore({ dbPath: join(root, 'whatsapp.db'), corpusId: WHATSAPP_LIVE_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
  const tier = createWhatsAppTierLane({
    store,
    env: { OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'whatsapp-internal.db') },
  });
  closers.push(() => {
    tier.newStores.internal?.current()?.close();
    store.close();
  });
  return { root, spoolDir, exportDir, set: tier.set, store, connector: whatsAppConnectorWithInputs({ spoolDir }) };
}

async function pullLive(target: Lane): Promise<void> {
  const cursor = target.set.committedCursor(target.connector.id)?.cursor ?? undefined;
  await target.set.sync(target.connector, { ...WHATSAPP_LANE_SYNC, ...(cursor ? { cursor } : {}) });
}

/** Imports an export file through the connector's archive input, as the archive layer does, to its end. */
async function importExport(target: Lane, name: string, text: string | Uint8Array, findings: ArchiveImportFinding[] = [], extra: Record<string, string> = {}) {
  mkdirSync(join(target.exportDir, name, '..'), { recursive: true });
  writeFileSync(join(target.exportDir, name), text);
  for (const [file, body] of Object.entries(extra)) writeFileSync(join(target.exportDir, file), body);
  const root = ScopeRoot.open(target.exportDir);
  closers.push(() => root.close());
  const manifest = buildArchiveManifest(root, [name]);
  const archiveId = `wa-${roots.length}-${name.length}`;
  const input = createWhatsAppExportInput({
    archive: {
      archiveId,
      connectorId: `archive.${archiveId}`,
      accountScope: archiveId,
      format: WHATSAPP_ARCHIVE_FORMAT,
      root,
      files: archiveFileEntries(manifest),
      manifestSha256: archiveManifestSha256(manifest),
      report: (finding) => { findings.push(finding); },
      shouldContinue: () => true,
      pageSize: 3,
      media: {
        bind: (relPath) => ({ ok: true, bindingId: `mb-${relPath.replace(/[^A-Za-z0-9]/gu, '')}`.slice(0, 60), sizeBytes: 9 }),
        open: () => { throw new Error('not read here'); },
        read: () => { throw new Error('not read here'); },
      },
    },
    spoolDir: target.spoolDir,
    zones: ZONES,
  });
  const connector = holdingItems(target.connector.forInput!(input));
  for (let pass = 0; pass < 50; pass += 1) {
    const cursor = target.set.committedCursor(connector.id)?.cursor ?? undefined;
    await target.set.sync(connector, { ...WHATSAPP_LANE_SYNC, maxItems: 4, ...(cursor ? { cursor } : {}) });
    if (pass > 0 && target.set.committedCursor(connector.id)?.cursor === cursor) break;
  }
  return findings;
}

interface Row {
  id: string;
  conversation: string | null;
  version: string | null;
  parent: string | null;
  locator: string | null;
  tombstoned: number;
}

function rows(target: Lane): Row[] {
  const db = new Database(join(target.root, 'whatsapp.db'), { readonly: true });
  try {
    return db.query(`
      SELECT provider_item_id AS id, provider_conversation_id AS conversation, source_version AS version,
        parent_local_item_id AS parent, deferred_locator AS locator, tombstoned
      FROM items ORDER BY item_pk
    `).all() as Row[];
  } finally {
    db.close();
  }
}

function activeIds(target: Lane): string[] {
  return rows(target).filter((row) => row.tombstoned === 0).map((row) => row.id);
}

describe('export time zones', () => {
  test('a wall time is read with the rules of its own date', () => {
    // Lisbon is UTC+1 in summer and UTC+0 in winter.
    expect(new Date(wallTimeToUtcMs('2026-07-01T12:00:00', 'Europe/Lisbon')!).toISOString()).toBe('2026-07-01T11:00:00.000Z');
    expect(new Date(wallTimeToUtcMs('2026-01-01T12:00:00', 'Europe/Lisbon')!).toISOString()).toBe('2026-01-01T12:00:00.000Z');
    // The hour repeated when clocks go back is read as its first occurrence.
    expect(new Date(wallTimeToUtcMs('2026-10-25T01:30:00', 'Europe/Lisbon')!).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  test('the zone under which most keys match is kept; with none, the first is assumed', () => {
    const chosen = chooseExportTimeZone(['2026-07-01'], (zone) => (zone === 'Asia/Tokyo' ? 3 : zone === 'Europe/Lisbon' ? 1 : 0), ZONES);
    expect(chosen).toEqual({ zone: 'Asia/Tokyo', matches: 3, assumed: false });
    expect(chooseExportTimeZone(['2026-07-01'], () => 0, ZONES)).toEqual({ zone: 'UTC', matches: 0, assumed: true });
  });
});

describe('a WhatsApp export beside live capture', () => {
  // Live capture (UTC instants) and the same chat exported on a phone set to New York (UTC-4 in July).
  const liveLines = [
    spoolLine({ id: 'L1', timestamp: '2026-07-01T13:00:21Z', text: 'Ferry at nine?' }),
    spoolLine({ id: 'L2', timestamp: '2026-07-01T13:01:05Z', from_me: true, sender_jid: '', sender_name: '', sender_contact_name: undefined, text: 'Yes, see you there' }),
    // One "ok" live captured, where the export holds two.
    spoolLine({ id: 'L3', timestamp: '2026-07-01T13:02:40Z', text: 'ok' }),
    spoolLine({ id: 'L4', timestamp: '2026-07-01T13:05:00Z', media_type: 'image', text: '' }),
    // Another chat with the same words at the same time stays apart.
    spoolLine({ id: 'O1', chat_jid: OTHER, chat_name: 'Harbour club', sender_jid: OTHER, sender_contact_name: 'Kit', timestamp: '2026-07-01T13:00:30Z', text: 'Ferry at nine?' }),
  ];
  const exported: SyntheticMessage[] = [
    notice('2026-06-30T08:00:00'),
    { at: '2026-06-30T08:10:00', sender: 'Rowan Hale', text: 'Packing the tent tonight' },
    { at: '2026-07-01T09:00:00', sender: 'Rowan Hale', text: 'Ferry at nine?' },
    { at: '2026-07-01T09:01:00', sender: 'Jamie Owner', text: 'Yes, see you there' },
    { at: '2026-07-01T09:02:00', sender: 'Rowan Hale', text: 'ok' },
    { at: '2026-07-01T09:02:00', sender: 'Rowan Hale', text: 'ok' },
    { at: '2026-07-01T09:05:00', sender: 'Rowan Hale', text: 'IMG-20260701-WA0001.jpg (file attached)' },
    { at: '2026-07-01T09:06:00', sender: 'Rowan Hale', text: '<Media omitted>' },
  ];
  const exportText = chatText(exported, { style: 'android-24-dmy' });

  test('matched messages are stored once, the rest once each, and live keeps its own copy', async () => {
    const target = lane();
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), liveLines.join(''));
    await pullLive(target);
    expect(activeIds(target).sort()).toEqual(['L1', 'L2', 'L3', 'L4', 'O1']);

    const findings = await importExport(target, 'WhatsApp Chat with Rowan Hale.txt', exportText, [], { 'IMG-20260701-WA0001.jpg': 'jpeg bytes' });
    const active = rows(target).filter((row) => row.tombstoned === 0);
    const ids = active.map((row) => row.id);
    // Live's five, the earlier message, the second "ok", the photo the export carries, and the left-out media's message.
    expect(ids.filter((id) => !id.startsWith('wx') && !id.includes('#child:')).sort()).toEqual(['L1', 'L2', 'L3', 'L4', 'O1']);
    const own = active.filter((row) => row.id.startsWith('wx') && !row.id.includes('#child:'));
    expect(own).toHaveLength(3);
    // Each item has one row: nothing was stored twice.
    expect(new Set(ids).size).toBe(ids.length);
    // The photo is a child of live's L4, readable by its locator; the left-out one is a child that cannot be read.
    const photo = active.find((row) => row.id === 'L4#child:IMG-20260701-WA0001.jpg');
    expect(photo?.parent).toContain(':L4');
    expect(parseArchiveInputMedia(photo!.locator!)?.kind).toBe('binding');
    expect(active.some((row) => row.id.endsWith('#child:media'))).toBe(true);
    // The export's own messages are in the live chat's conversation.
    expect(new Set(own.map((row) => row.conversation))).toEqual(new Set([ROWAN]));
    // The zone was found, not assumed; the notice stayed out.
    expect(findings.some((finding) => finding.kind === 'time_zone_assumed')).toBe(false);
    expect(findings.some((finding) => finding.kind === 'system_message')).toBe(true);
  });

  test('a second import of the same export adds nothing', async () => {
    const target = lane();
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), liveLines.join(''));
    await pullLive(target);
    await importExport(target, 'WhatsApp Chat with Rowan Hale.txt', exportText, [], { 'IMG-20260701-WA0001.jpg': 'jpeg bytes' });
    const first = activeIds(target).sort();
    await importExport(target, 'again/WhatsApp Chat with Rowan Hale.txt', exportText, [], { 'again/IMG-20260701-WA0001.jpg': 'jpeg bytes' });
    expect(activeIds(target).sort()).toEqual(first);
  });

  test('with nothing live to match, the zone is assumed and every message is its own', async () => {
    const target = lane();
    const findings = await importExport(target, 'WhatsApp Chat with Rowan Hale.txt', exportText);
    expect(findings.some((finding) => finding.kind === 'time_zone_assumed')).toBe(true);
    const own = rows(target).filter((row) => row.tombstoned === 0 && !row.id.includes('#child:'));
    expect(own).toHaveLength(7);
    // No live chat has that name, so it is a conversation of its own.
    expect(new Set(own.map((row) => row.conversation)).size).toBe(1);
    expect(own[0]!.conversation).toEndWith('@export.whatsapp');
  });

  test('a contact shown differently in the export is a near-miss, kept as its own message', async () => {
    const target = lane();
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), liveLines.join(''));
    await pullLive(target);
    const renamed: SyntheticMessage[] = [
      { at: '2026-07-01T09:00:00', sender: 'Rowan Hale', text: 'Ferry at nine?' },
      { at: '2026-07-01T09:01:00', sender: 'Jamie Owner', text: 'Yes, see you there' },
      { at: '2026-07-01T09:02:00', sender: 'R. Hale', text: 'ok' },
    ];
    const findings = await importExport(target, 'WhatsApp Chat with Rowan Hale.txt', chatText(renamed, { style: 'android-24-dmy' }));
    expect(findings.filter((finding) => finding.kind === WHATSAPP_INPUT_FINDINGS.nearMiss)).toHaveLength(1);
    expect(activeIds(target).filter((id) => id.startsWith('wx'))).toHaveLength(1);
  });

  test('a chat whose name two live chats share is not merged into either', async () => {
    const target = lane();
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), [
      ...liveLines,
      spoolLine({ id: 'T1', chat_jid: '15550003333@s.whatsapp.net', chat_name: 'Rowan Hale', timestamp: '2026-07-01T10:00:00Z', text: 'hello' }),
    ].join(''));
    await pullLive(target);
    await importExport(target, 'WhatsApp Chat with Rowan Hale.txt', exportText);
    const own = rows(target).filter((row) => row.tombstoned === 0 && row.id.startsWith('wx') && !row.id.includes('#child:'));
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) expect(row.conversation).toEndWith('@export.whatsapp');
  });
});

describe('the release check\'s beside-live fixture', () => {
  test('the WhatsApp fixture joins the seeded chat: four messages read, two of them already there', async () => {
    const target = lane();
    // The seed hook's spool, as archive-live-seed-whatsapp.ts writes it (the instants are the wall times in UTC).
    writeFileSync(join(target.spoolDir, '2024-04-14.jsonl'), WHATSAPP_BESIDE_SHARED.map(([at, sender, text], index) => spoolLine({
      id: `RCSEED${index}`,
      chat_jid: '15550100001@s.whatsapp.net',
      chat_name: WHATSAPP_BESIDE_CHAT,
      sender_jid: sender === undefined ? '' : '15550100001@s.whatsapp.net',
      sender_name: sender === undefined ? '' : 'sam',
      sender_contact_name: sender,
      from_me: sender === undefined,
      timestamp: `${at}Z`,
      text,
    })).join(''));
    await pullLive(target);
    const fixture = WHATSAPP_FIXTURES.besideLive!.small('rcarchtoken0123');
    expect(fixture.expect).toMatchObject({ read: 4, alreadyThere: 2 });
    const findings = await importExport(target, 'rc-beside-whatsapp_chat.zip', fixture.bytes);
    const active = rows(target).filter((row) => row.tombstoned === 0 && !row.id.includes('#child:'));
    expect(active.filter((row) => row.id.startsWith('RCSEED'))).toHaveLength(2);
    const own = active.filter((row) => row.id.startsWith('wx'));
    expect(own).toHaveLength(2);
    expect(new Set(own.map((row) => row.conversation))).toEqual(new Set(['15550100001@s.whatsapp.net']));
    expect(findings.some((finding) => finding.kind === 'time_zone_assumed')).toBe(false);
  });
});

describe('live status posts', () => {
  test('a status post is an item of its own kind in the status updates conversation', async () => {
    const target = lane();
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({
      id: 'S1', chat_jid: 'status@broadcast', chat_name: '', timestamp: '2026-07-01T10:00:00Z', text: 'Off to the coast',
    }));
    await pullLive(target);
    const row = rows(target).find((entry) => entry.id === 'S1');
    expect(row?.conversation).toBe('status@broadcast');
  });
});
