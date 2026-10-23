// The stand-ins for the Telegram and WhatsApp capture daemons write the lines the daemons write: the product's own connectors read
// them, the directories match the product's, and nothing in them is a fixture marker.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRIVATE_FACTS, PRIVATE_MARKER, SECRET_MARKER } from '../scripts/release-check/fixture.ts';
import { TELEGRAM_ACCOUNT, TELEGRAM_INTERNAL_CORPUS, clearSpool, syntheticMessages, telegramSpoolDir, telegramSpoolLines, whatsappSpoolDir, whatsappSpoolLines, writeSpool } from '../scripts/release-check/capture-standin.ts';
import { defaultTelegramCaptureSpoolDir, readTelegramCaptureSpool } from '../src/workers/telegram-messages/capture-spool-connector.ts';
import { INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID } from '../src/workers/telegram-messages/corpus-adapter.ts';
import { TELEGRAM_PERSONAL_ACCOUNT_SCOPE } from '../src/workers/telegram-messages/store-sync.ts';
import { createWhatsAppLiveSourceConnector, readWhatsAppLiveSpoolStatus } from '../src/workers/whatsapp/live-connector.ts';
import { WHATSAPP_PERSONAL_ACCOUNT_SCOPE, defaultWhatsAppSpoolDir } from '../src/workers/whatsapp/store-sync.ts';

const dirs: string[] = [];
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'rc-standin-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('capture stand-ins', () => {
  test('the Telegram spool is read by the product\'s own reader, whole and without a malformed line', () => {
    const dir = join(temp(), 'spool');
    const messages = syntheticMessages(6, 'tg');
    writeSpool(dir, telegramSpoolLines('chat-1', messages));
    const read = readTelegramCaptureSpool({ spoolDir: dir, trustDomain: 'internal' });
    expect(read.malformedRecords).toBe(0);
    expect(read.records).toHaveLength(6);
    expect(read.records.map((record) => record.capturedItem.item.identity.providerItemId)).toEqual(messages.map((message) => message.id));
    expect(read.records[0]!.capturedItem.item.identity.accountScope).toBe(TELEGRAM_ACCOUNT);
    expect(read.exhausted).toBe(true);
  });

  test('the WhatsApp spool is read by the product\'s own connector, whole and without a malformed line', async () => {
    const dir = join(temp(), 'spool');
    writeSpool(dir, whatsappSpoolLines('15550100099@s.whatsapp.net', syntheticMessages(5, 'wa')));
    const status = readWhatsAppLiveSpoolStatus(dir);
    expect(status).toMatchObject({ files: 1, messages: 5, malformedLines: 0 });
    const connector = createWhatsAppLiveSourceConnector({ spoolDir: dir, account: WHATSAPP_PERSONAL_ACCOUNT_SCOPE });
    let items = 0;
    for await (const page of connector.listItems()) items += page.items.length;
    expect(items).toBe(5);
  });

  test('writing the same messages again leaves one copy; clearing removes only the day files', () => {
    const dir = join(temp(), 'spool');
    const lines = telegramSpoolLines('chat-1', syntheticMessages(3, 'tg'));
    const first = writeSpool(dir, lines);
    writeSpool(dir, lines);
    expect(readFileSync(first, 'utf8').trim().split('\n')).toHaveLength(3);
    clearSpool(dir);
    expect(readdirSync(dir)).toEqual([]);
    expect(() => clearSpool(join(dir, 'missing'))).not.toThrow();
  });

  test('the account, corpus and directories are the product\'s', () => {
    expect(TELEGRAM_ACCOUNT).toBe(TELEGRAM_PERSONAL_ACCOUNT_SCOPE);
    expect(TELEGRAM_INTERNAL_CORPUS).toBe(INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID);
    const envs: Array<Record<string, string>> = [
      { HOME: '/home/tester' },
      { HOME: '/home/tester', XDG_DATA_HOME: '/data' },
      { HOME: '/home/tester', OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: '/spool/a' },
      { HOME: '/home/tester', OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR: '/spool/b' },
      { HOME: '/home/tester', OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR: '/spool/c' },
      { HOME: '/home/tester', OLYMPUS_WHATSAPP_STATE_DIR: '/state/w' },
    ];
    for (const env of envs) {
      expect(telegramSpoolDir(env)).toBe(defaultTelegramCaptureSpoolDir(env));
      expect(whatsappSpoolDir(env)).toBe(defaultWhatsAppSpoolDir(env));
    }
  });

  test('the messages carry no fixture marker (the leak scan has nothing to find in them)', () => {
    const text = [...telegramSpoolLines('c', syntheticMessages(6, 'x')), ...whatsappSpoolLines('j@s.whatsapp.net', syntheticMessages(6, 'y'))].join('\n');
    for (const marker of [PRIVATE_MARKER, SECRET_MARKER, ...PRIVATE_FACTS]) expect(text).not.toContain(marker);
  });
});
