// #599 part 2: the owner can keep a whole chat Private from the privacy
// profile. It is the owner's own rule, written through the shared owner tier
// rules (the same rule `olympus tier rules add --match chat=<id>` writes), so
// it is the one group decision the per-item rule allows. Every other chat is
// still judged message by message.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privacyToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { readChatGptPrivacySettings } from '../src/workers/chatgpt/setup-backend.ts';
import { loadSecretLocations } from '../src/workers/chatgpt/scope-privacy.ts';
import { isSecretPrivacyRule, lowersPrivacy, visiblePrivacy } from '../src/workers/dashboard/shared-privacy.ts';
import { parsePrivacyProfileInput, readPrivacyProfile, writePrivacyProfile } from '../src/workers/classification/privacy-profile.ts';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { loadOwnerTierRules, writeOwnerTierRules } from '../src/workers/classification/tier-rules.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { sweepOwnerRuleRaises } from '../src/workers/connector-store/tier-rules-sweep.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { createTelegramConnectorStoreSyncHandler, INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID } from '../src/workers/telegram-messages/index.ts';
import { liveSpoolLine } from './support/telegram-spool-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-chat-rule-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: dir, OLYMPUS_PRIVACY_PROFILE_PATH: join(dir, 'privacy.json'), OLYMPUS_TIER_RULES_PATH: join(dir, 'tier-rules.json') };
  return { dir, env };
}

const doctor = { kind: 'chat', source_id: 'telegram.messages', key: 'dr-lee', display: 'Dr. Lee' } as const;

test('a chat rule names a chat source and its conversation id', () => {
  expect(parsePrivacyProfileInput({ rules: [doctor, { kind: 'chat', source_id: 'whatsapp.personal.messages', key: '15550001111@s.whatsapp.net' }] }).rules)
    .toEqual([doctor, { kind: 'chat', source_id: 'whatsapp.personal.messages', key: '15550001111@s.whatsapp.net' }]);
  for (const bad of [
    { kind: 'chat', source_id: 'gmail.email', key: 'x' },
    { kind: 'chat', source_id: 'telegram.messages' },
    { kind: 'chat', source_id: 'telegram.messages', key: 'dr-lee', value: 'Dr. Lee' },
    { kind: 'folder', source_id: 'telegram.messages', key: 'dr-lee' },
  ]) expect(() => parsePrivacyProfileInput({ rules: [bad] })).toThrow();
});

test('saving a chat rule writes the shared owner chat rule and leaves other owner rules alone', () => {
  const { env } = home();
  writeOwnerTierRules([{ id: 'cli.keep', match: { kind: 'chat', value: 'other' }, tier: 'secure', strength: 'prior' }], { env });
  writePrivacyProfile({ rules: [doctor] }, { env });
  const rules = loadOwnerTierRules({ env });
  expect(rules.find((rule) => rule.id === 'cli.keep')).toBeDefined();
  expect(rules.filter((rule) => rule.id.startsWith('privacy-chat-'))).toEqual([
    expect.objectContaining({ source: 'telegram', match: { kind: 'chat', value: 'dr-lee' }, tier: 'secure', strength: 'prior' }),
  ]);
  expect(readPrivacyProfile({ env })?.rules).toEqual([doctor]);
  // Removing it from the profile removes the rule it owns, nothing else.
  writePrivacyProfile({ rules: [] }, { env });
  expect(loadOwnerTierRules({ env }).map((rule) => rule.id)).toEqual(['cli.keep']);
});

test('the panel reads a saved chat rule back, so a save that drops it counts as lowering protection', () => {
  const { env } = home();
  writePrivacyProfile({ rules: [doctor] }, { env });
  const settings = readChatGptPrivacySettings(env, 0);
  expect(settings.rules).toEqual([doctor]);
  const meta = (privacyToolResult(settings, 'current')._meta as Record<string, unknown>)['olympus/privacy'] as { rules: unknown[] };
  expect(meta.rules).toEqual([doctor]);
  expect(lowersPrivacy({ rules: [] }, settings)).toBe(true);
  expect(lowersPrivacy({ rules: [doctor] }, settings)).toBe(false);
});

test('a chat rule on a Secrets chat never leaves the computer', () => {
  const { env } = home();
  writeOwnerTierRules([{ id: 'cli.vault', source: 'telegram', match: { kind: 'chat', value: 'DR-LEE' }, tier: 'secrets', strength: 'force' }], { env });
  const other = { kind: 'chat', source_id: 'whatsapp.personal.messages', key: 'tiago' } as const;
  writePrivacyProfile({ rules: [doctor, other] }, { env });
  const secrets = loadSecretLocations(env);
  expect(isSecretPrivacyRule(secrets, doctor)).toBe(true);
  expect(isSecretPrivacyRule(secrets, other)).toBe(false);
  const visible = visiblePrivacy(readChatGptPrivacySettings(env, 0), secrets);
  expect(visible.rules).toEqual([other]);
  const meta = JSON.stringify(privacyToolResult(visible, 'current'));
  expect(meta).not.toContain('dr-lee');
  expect(meta).not.toContain('Dr. Lee');
});

test('a chat held Secrets through a folder-key rule hides its chat rule too', () => {
  const { env } = home();
  // The classifier matches folderKey and chat rules alike against an item's folder keys, where chats publish their id.
  writeOwnerTierRules([{ id: 'cli.vault', match: { kind: 'folderKey', value: 'Dr-Lee' }, tier: 'secrets', strength: 'force' }], { env });
  writePrivacyProfile({ rules: [doctor] }, { env });
  const secrets = loadSecretLocations(env);
  expect(isSecretPrivacyRule(secrets, doctor)).toBe(true);
  const meta = JSON.stringify(privacyToolResult(visiblePrivacy(readChatGptPrivacySettings(env, 0), secrets), 'current'));
  expect(meta).not.toContain('dr-lee');
  expect(meta).not.toContain('Dr. Lee');
});

const personal: TierSniffer = { id: 'personal-content', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) };

test('a profile chat rule keeps that chat Private, raises messages already stored, and no other chat', async () => {
  const { dir, env } = home();
  const spoolDir = join(dir, 'spool'); mkdirSync(spoolDir);
  writeFileSync(join(spoolDir, '2026-11-01.jsonl'), [
    liveSpoolLine({ chat: 'dr-lee', id: '1', text: 'See you Tuesday at ten.', chatTitle: 'Dr. Lee', sentAt: '2026-11-01T09:00:00Z', trust: 'internal' }),
    liveSpoolLine({ chat: 'tiago', id: '2', text: 'Duque is the name of the café.', chatTitle: 'Tiago', sentAt: '2026-11-01T09:01:00Z', trust: 'internal' }),
  ].join(''));
  const internal = new LocalConnectorStore({ dbPath: join(dir, 'internal.sqlite'), corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'internal' });
  const secureLocal = new LocalConnectorStore({ dbPath: join(dir, 'secure.sqlite'), corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
  const classification = { sniffer: personal, rules: loadOwnerTierRules({ env, allowMissing: true }) };
  const set = createLaneTieredStoreSet({ setId: 'telegram.messages', internalStore: internal, secureStore: secureLocal, splitLayers: false, tierClassification: classification });
  const handler = createTelegramConnectorStoreSyncHandler({ stores: { internal, secureLocal }, spoolDir, tierSet: set });
  cleanup.push(() => { internal.close(); secureLocal.close(); set.ledger.close(); });
  const at = (chat: string, id: string) => set.ledger.getCurrent({ provider: 'telegram', accountScope: 'telegram.personal', providerConversationId: chat, providerItemId: id });

  // No rule yet: both messages are judged by content.
  await handler.pull();
  expect(at('dr-lee', '1')).toMatchObject({ metadataTier: 'private', contentTier: 'private' });

  // The owner marks the chat always Private in the profile; the sweep raises what is stored.
  writePrivacyProfile({ rules: [doctor] }, { env });
  classification.rules = loadOwnerTierRules({ env });
  expect(sweepOwnerRuleRaises({ set })).toMatchObject({ raised: 1, complete: true });
  // The raise is queued, hidden first (the move executor carries it to the Private store).
  expect(at('dr-lee', '1')).toMatchObject({ state: 'moving', targetMetadataTier: 'secure', targetContentTier: 'secure', decidedBy: 'owner_rule' });
  expect(at('dr-lee', '1')!.reasons.some((reason) => reason.startsWith('metadata:owner_rule:chat:'))).toBe(true);
  expect(at('tiago', '2')).toMatchObject({ state: 'current', metadataTier: 'private', contentTier: 'private' });

  // A WhatsApp chat rule with the same id never reaches a Telegram chat.
  writePrivacyProfile({ rules: [doctor, { kind: 'chat', source_id: 'whatsapp.personal.messages', key: 'tiago' }] }, { env });
  classification.rules = loadOwnerTierRules({ env });
  expect(sweepOwnerRuleRaises({ set })).toMatchObject({ raised: 0, complete: true });
  expect(at('tiago', '2')).toMatchObject({ state: 'current', metadataTier: 'private' });
});
