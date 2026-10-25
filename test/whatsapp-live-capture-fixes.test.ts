// Live WhatsApp capture fixes (docs/design/archive-live-one-dataset.md, "Best
// of both", step 3): bounded streaming spool reads, cursor recovery, counted
// bridge drops, captions, and freshness told apart from a quiet account. Every
// fixture is synthetic.

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnectorListPage } from '../src/core/contracts.ts';
import {
  createWhatsAppLiveSourceConnector,
  emptyWhatsAppSpoolPassFindings,
  redactWhatsAppLiveSpoolSecrets,
} from '../src/workers/whatsapp/live-connector.ts';
import { newestSpoolRecord, spoolRecords } from '../src/workers/whatsapp/spool-reader.ts';
import { captureFreshnessCounts, captureLiveness } from '../src/workers/connector-store/capture-freshness.ts';
import {
  WHATSAPP_CAPTURE_DROPPED_WARNING,
  WHATSAPP_CAPTURE_STALE_WARNING,
  WHATSAPP_OVERSIZED_SPOOL_WARNING,
  WHATSAPP_SPOOL_CURSOR_RECOVERED_WARNING,
  createWhatsAppConnectorStore,
  createWhatsAppConnectorStoreSyncHandler,
} from '../src/workers/whatsapp/store-sync.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function line(id: string, fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    id,
    chat_jid: 'chat-1@s.whatsapp.net',
    chat_name: 'Harbour club',
    sender_jid: 'sender-1@s.whatsapp.net',
    sender_name: 'Rowan',
    from_me: false,
    timestamp: '2026-10-25T09:00:00Z',
    text: `message ${id}`,
    ...fields,
  })}\n`;
}

function spoolDir(files: Record<string, string>): string {
  const dir = tempDir('whatsapp-fixes-spool-');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

async function drain(pages: AsyncIterable<SourceConnectorListPage>): Promise<SourceConnectorListPage[]> {
  const collected: SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

function ids(pages: readonly SourceConnectorListPage[]): string[] {
  return pages.flatMap((page) => page.items.map((item: RawItem) => item.identity.providerItemId));
}

describe('captureLiveness', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');

  test('ages a feed by the newer of its newest record and its heartbeat', () => {
    expect(captureLiveness('2026-10-25T10:00:00Z', '2026-10-25T11:58:00Z', now, 3_600))
      .toEqual({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 120, quiet: true });
    expect(captureLiveness('2026-10-25T11:59:00Z', '2026-10-25T11:58:00Z', now, 3_600))
      .toEqual({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 60, quiet: false });
    expect(captureLiveness(undefined, '2026-10-25T11:58:00Z', now, 3_600))
      .toEqual({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 120, quiet: true });
    expect(captureLiveness('2026-10-25T08:00:00Z', undefined, now, 3_600))
      .toEqual({ status: 'stale', threshold_seconds: 3_600, age_seconds: 14_400, quiet: false });
    expect(captureLiveness(undefined, undefined, now, 3_600))
      .toEqual({ status: 'unavailable', threshold_seconds: 3_600, quiet: false });
  });

  test('a liveness verdict carries capture_quiet; a plain one does not', () => {
    expect(captureFreshnessCounts(captureLiveness(undefined, '2026-10-25T11:58:00Z', now, 3_600)).capture_quiet).toBe(1);
    expect('capture_quiet' in captureFreshnessCounts({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 1 })).toBe(false);
  });
});

describe('bounded streaming spool reads', () => {
  test('a record over the per-record bound is skipped, counted, and never stalls the cursor', async () => {
    const huge = line('huge', { text: 'x'.repeat(5_000) });
    const dir = spoolDir({ '2026-10-25.jsonl': line('a') + huge + line('b') });
    const findings = emptyWhatsAppSpoolPassFindings();
    const connector = createWhatsAppLiveSourceConnector({ spoolDir: dir, findings, maxRecordBytes: 1_000 });
    const pages = await drain(connector.listItems());
    expect(ids(pages)).toEqual(['a', 'b']);
    expect(findings.oversizedRecords).toBe(1);
    expect(pages.at(-1)?.nextCursor).toBe('2026-10-25.jsonl:3');
  });

  test('one listing stops at its byte budget with a cursor, and the next goes on without repeats', async () => {
    const body = Array.from({ length: 10 }, (_, index) => line(`m${index}`)).join('');
    const dir = spoolDir({ '2026-10-25.jsonl': body });
    const seen: string[] = [];
    let cursor: string | undefined;
    let passes = 0;
    for (;;) {
      passes += 1;
      const findings = emptyWhatsAppSpoolPassFindings();
      // Room for about three records a pass.
      const connector = createWhatsAppLiveSourceConnector({ spoolDir: dir, findings, passByteBudget: 3 * line('m0').length });
      const pages = await drain(connector.listItems(cursor ? { cursor } : {}));
      seen.push(...ids(pages));
      cursor = pages.at(-1)?.nextCursor;
      if (pages.at(-1)?.done) break;
      expect(findings.passBudgetReached).toBe(1);
      expect(passes).toBeLessThan(10);
    }
    expect(seen).toEqual(Array.from({ length: 10 }, (_, index) => `m${index}`));
    expect(passes).toBeGreaterThan(2);
  });

  test('records are read whole across chunk boundaries, multi-byte text included', () => {
    const dir = tempDir('whatsapp-fixes-chunks-');
    const path = join(dir, '2026-10-25.jsonl');
    // Longer than one 256 KiB read chunk, with four-byte characters throughout.
    const long = `${'🌊 wave '.repeat(40_000)}end`;
    writeFileSync(path, `first\n${long}\nlast\nunterminated`);
    const read = [...spoolRecords(path)].map((record) => (record.kind === 'line' ? record.text : '<oversized>'));
    expect(read).toEqual(['first', long, 'last']);
  });

  test('the newest message is found from the end of the spool, past a torn tail and unreadable lines', () => {
    const dir = spoolDir({
      '2026-10-24.jsonl': line('older', { timestamp: '2026-10-24T20:00:00Z' }),
      '2026-10-25.jsonl':
        line('newest', { timestamp: '2026-10-25T08:00:00Z' })
        + '{broken\n'.repeat(50_000)
        + line('torn', { timestamp: '2026-10-25T09:00:00Z' }).trimEnd(),
    });
    const newest = newestSpoolRecord(dir, ['2026-10-24.jsonl', '2026-10-25.jsonl'], (text) => {
      try {
        const parsed = JSON.parse(text) as { timestamp?: string };
        return parsed.timestamp;
      } catch {
        return undefined;
      }
    });
    expect(newest).toBe('2026-10-25T08:00:00Z');
  });
});

describe('cursor recovery', () => {
  test('a file holding fewer lines than its cursor was replaced, and is read again from its start', async () => {
    // Capture started again the same day after the spool folder was removed:
    // the day's file is new and shorter than the stored cursor.
    const dir = spoolDir({ '2026-10-25.jsonl': line('new-1') + line('new-2') });
    const findings = emptyWhatsAppSpoolPassFindings();
    const connector = createWhatsAppLiveSourceConnector({ spoolDir: dir, findings });
    const pages = await drain(connector.listItems({ cursor: '2026-10-25.jsonl:40' }));
    expect(ids(pages)).toEqual(['new-1', 'new-2']);
    expect(findings.cursorsRecovered).toBe(1);
    expect(pages.at(-1)?.nextCursor).toBe('2026-10-25.jsonl:2');
  });

  test('a cursor at the end of its file is not a recovery', async () => {
    const dir = spoolDir({ '2026-10-25.jsonl': line('a') + line('b') });
    const findings = emptyWhatsAppSpoolPassFindings();
    const connector = createWhatsAppLiveSourceConnector({ spoolDir: dir, findings });
    const pages = await drain(connector.listItems({ cursor: '2026-10-25.jsonl:2' }));
    expect(ids(pages)).toEqual([]);
    expect(findings).toEqual(emptyWhatsAppSpoolPassFindings());
  });

  test('a cursor whose file has gone is counted, and listing goes on at the next file', async () => {
    const dir = spoolDir({ '2026-10-26.jsonl': line('next-day') });
    const findings = emptyWhatsAppSpoolPassFindings();
    const connector = createWhatsAppLiveSourceConnector({ spoolDir: dir, findings });
    const pages = await drain(connector.listItems({ cursor: '2026-10-25.jsonl:7' }));
    expect(ids(pages)).toEqual(['next-day']);
    expect(findings.cursorFilesMissing).toBe(1);
  });
});

describe('captions', () => {
  test('a captioned photo is read by its caption; one without a caption stays metadata only', async () => {
    const dir = spoolDir({
      '2026-10-25.jsonl':
        line('photo-captioned', { media_type: 'image', text: 'the harbour at dusk' })
        + line('photo-plain', { media_type: 'image', text: '' }),
    });
    const items = (await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems())).flatMap((page) => [...page.items]);
    const captioned = items.find((item) => item.identity.providerItemId === 'photo-captioned');
    const plain = items.find((item) => item.identity.providerItemId === 'photo-plain');
    expect(captioned?.content).toEqual({ kind: 'text', text: 'the harbour at dusk' });
    expect(captioned?.metadata['mediaType']).toBe('image');
    expect(plain?.content).toEqual({ kind: 'metadata_only' });
  });

  test('a caption is judged for Secrets by its own text, and cleared from the spool', () => {
    const dir = spoolDir({
      '2026-10-25.jsonl': line('photo-secret', { media_type: 'image', text: 'door code 4471' }),
    });
    const judged: Array<string | undefined> = [];
    const result = redactWhatsAppLiveSpoolSecrets({
      spoolDir: dir,
      judge: (_identity, text) => {
        judged.push(text);
        return text?.includes('door code') ? 'content' : undefined;
      },
    });
    expect(judged).toEqual(['door code 4471']);
    expect(result.recordsRedacted + result.recordsBlanked).toBe(1);
  });
});

describe('the pull receipt', () => {
  function captureStatus(dir: string, fields: Record<string, unknown>): void {
    writeFileSync(join(dir, 'capture-status.json'), `${JSON.stringify({ kind: 'whatsapp_capture_status', ...fields })}\n`);
  }

  async function pull(files: Record<string, string>, status?: Record<string, unknown>, cursorFile?: string) {
    const stateDir = tempDir('whatsapp-fixes-state-');
    const dir = join(stateDir, 'spool');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    if (status) captureStatus(dir, status);
    const env = { OLYMPUS_WHATSAPP_STATE_DIR: stateDir };
    const store = createWhatsAppConnectorStore(env);
    try {
      const sync = createWhatsAppConnectorStoreSyncHandler({
        store,
        env,
        spoolStaleThresholdSeconds: 3_600,
        now: () => new Date('2026-10-25T12:00:00Z'),
      });
      const first = await sync.pull();
      if (cursorFile === undefined) return { first };
      // Capture is restarted the same day on an empty spool folder.
      rmSync(join(dir, cursorFile));
      writeFileSync(join(dir, cursorFile), line('after-restart', { timestamp: '2026-10-25T11:59:00Z' }));
      const second = await sync.pull();
      return { first, second, items: store.status().counts.items };
    } finally {
      store.close();
    }
  }

  test('a quiet account whose bridge is connected reads fresh and quiet, not stale', async () => {
    const { first } = await pull(
      { '2026-10-25.jsonl': line('old', { timestamp: '2026-10-25T06:00:00Z' }) },
      { connected: true, connected_through: '2026-10-25T11:59:00Z', dropped_messages: 0 },
    );
    expect(first.counts).toMatchObject({ capture_fresh: 1, capture_stale: 0, capture_quiet: 1, capture_age_seconds: 60 });
    expect(first.warnings ?? []).not.toContain(WHATSAPP_CAPTURE_STALE_WARNING);
  });

  test('a bridge that stopped reads stale one threshold after it stopped', async () => {
    const { first } = await pull(
      { '2026-10-25.jsonl': line('old', { timestamp: '2026-10-25T06:00:00Z' }) },
      { connected: false, connected_through: '2026-10-25T08:00:00Z', dropped_messages: 0 },
    );
    expect(first.counts).toMatchObject({ capture_stale: 1, capture_quiet: 0, capture_age_seconds: 4 * 3_600 });
    expect(first.warnings).toContain(WHATSAPP_CAPTURE_STALE_WARNING);
  });

  test('without a capture status receipt the newest message decides, as before', async () => {
    const { first } = await pull({ '2026-10-25.jsonl': line('old', { timestamp: '2026-10-25T06:00:00Z' }) });
    expect(first.counts).toMatchObject({ capture_stale: 1, capture_quiet: 0, capture_dropped_messages: 0 });
  });

  test('messages the bridge dropped are counted, and warned about while recent', async () => {
    const recent = await pull(
      { '2026-10-25.jsonl': line('a', { timestamp: '2026-10-25T11:30:00Z' }) },
      { connected: true, connected_through: '2026-10-25T11:59:00Z', dropped_messages: 3, last_dropped_at: '2026-10-25T11:00:00Z' },
    );
    expect(recent.first.counts.capture_dropped_messages).toBe(3);
    expect(recent.first.warnings).toContain(WHATSAPP_CAPTURE_DROPPED_WARNING);

    const old = await pull(
      { '2026-10-25.jsonl': line('a', { timestamp: '2026-10-25T11:30:00Z' }) },
      { connected: true, connected_through: '2026-10-25T11:59:00Z', dropped_messages: 3, last_dropped_at: '2026-10-20T11:00:00Z' },
    );
    expect(old.first.counts.capture_dropped_messages).toBe(3);
    expect(old.first.warnings ?? []).not.toContain(WHATSAPP_CAPTURE_DROPPED_WARNING);
  });

  test('a pull counts the lines it skipped, not the whole spool again', async () => {
    const stateDir = tempDir('whatsapp-fixes-state-');
    const dir = join(stateDir, 'spool');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '2026-10-25.jsonl');
    writeFileSync(file, line('a', { timestamp: '2026-10-25T11:30:00Z' }) + '{broken\n' + line('b', { text: 'y'.repeat(2 * 1024 * 1024) }));
    const env = { OLYMPUS_WHATSAPP_STATE_DIR: stateDir };
    const store = createWhatsAppConnectorStore(env);
    try {
      const sync = createWhatsAppConnectorStoreSyncHandler({ store, env, now: () => new Date('2026-10-25T12:00:00Z') });
      const first = await sync.pull();
      expect(first.counts).toMatchObject({ malformed_spool_lines: 1, oversized_spool_records: 1, items_seen: 1 });
      expect(first.warnings).toContain(WHATSAPP_OVERSIZED_SPOOL_WARNING);
      appendFileSync(file, line('c', { timestamp: '2026-10-25T11:40:00Z' }));
      const second = await sync.pull();
      expect(second.counts).toMatchObject({ malformed_spool_lines: 0, oversized_spool_records: 0, items_seen: 1 });
    } finally {
      store.close();
    }
  });

  test('a spool file replaced under its cursor is read again instead of skipping its first lines', async () => {
    const day = '2026-10-25.jsonl';
    const { first, second, items } = await pull(
      { [day]: line('a', { timestamp: '2026-10-25T11:00:00Z' }) + line('b', { timestamp: '2026-10-25T11:01:00Z' }) },
      undefined,
      day,
    );
    expect(first.counts.spool_cursor_recovered).toBe(0);
    expect(second!.counts.spool_cursor_recovered).toBe(1);
    expect(second!.warnings).toContain(WHATSAPP_SPOOL_CURSOR_RECOVERED_WARNING);
    expect(items).toBe(3);
  });
});
