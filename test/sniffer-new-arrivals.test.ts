import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem } from '../src/core/contracts.ts';
import type { AnalystModel } from '../src/core/analyst.ts';
import { decideItemTiers } from '../src/workers/connector-store/tier-placement.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { NEW_ARRIVAL_PRIORITY } from '../src/workers/classification/tier-classifier.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture } from './helpers/tier-fixtures.ts';

const lane: SnifferLane = {
  kind: 'local', profileId: 'fixture', modelId: 'fixture',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' },
};
const connector = { classificationSignals: (value: RawItem) => ({ title: String(value.metadata.title) }) };

let clock = Date.parse('2026-11-14T00:00:00Z');
const now = () => new Date(clock);
const tick = (ms = 1_000) => { clock += ms; };
const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const handle of opened.splice(0)) handle.close(); });

function source(provider: string) {
  const ledger = new TierLedger({ dbPath: ':memory:', now });
  const sniffer = new TierSnifferStore({ dbPath: ':memory:', now });
  opened.push(sniffer, ledger);
  const place = (id: string, options: { archive?: true } = {}) => {
    tick();
    const raw: RawItem = {
      identity: { family: 'mail', provider, accountScope: 'owner', providerItemId: id, localItemId: id },
      mimeType: 'text/plain', content: { kind: 'text', text: `Lunch by the park on Friday. ${id}` },
      fetchedAt: now().toISOString(), metadata: { title: id },
      ...(options.archive ? { holdContentUntilJudged: true } : {}),
    };
    const decision = decideItemTiers(connector, raw, raw.content.kind === 'text' ? raw.content.text : undefined,
      { sniffer: new CachedTierSniffer(sniffer, lane) }, ledger);
    ledger.recordDecision(raw.identity, decision);
  };
  return { ledger, sniffer, place, caughtUp: () => { tick(); ledger.markListingCaughtUp(provider, 'owner'); } };
}

function recordingModel(prompts: string[]): AnalystModel {
  return { async complete(request) {
    prompts.push(request.prompt);
    return { modelId: lane.modelId, text: JSON.stringify({ verdicts: [{
      i: 1, tier: 'personal', category: 'ordinary', ownRecord: false, privateKind: 'none', confidence: 1,
    }] }) };
  } };
}

const asked = (prompt: string) => prompt.match(/\b(?:backlog|new|archive)-[a-z0-9-]+/)?.[0];

test('an item first seen after its account\'s first full listing is judged ahead of every store\'s backlog, newest first', async () => {
  const mail = source('mail-fixture');
  const files = source('files-fixture');
  for (const id of ['backlog-m1', 'backlog-m2', 'backlog-m3']) mail.place(id);
  for (const id of ['backlog-f1', 'backlog-f2', 'backlog-f3']) files.place(id);
  mail.caughtUp();
  files.caughtUp();
  // An archive imported into the same account after the live listing stays backlog.
  mail.place('archive-a1', { archive: true });
  files.place('new-f-older');
  mail.place('new-m-newest');

  expect(mail.sniffer.questionFor(mail.ledger.getCurrent({ provider: 'mail-fixture', accountScope: 'owner', providerItemId: 'new-m-newest' })!, 'content')?.priority)
    .toBe(NEW_ARRIVAL_PRIORITY);
  expect(mail.ledger.isNewArrival({ provider: 'mail-fixture', accountScope: 'owner', providerItemId: 'backlog-m1' })).toBe(false);
  expect(mail.ledger.isNewArrival({ provider: 'mail-fixture', accountScope: 'owner', providerItemId: 'archive-a1' })).toBe(true);

  const prompts: string[] = [];
  await runSnifferPass({ targets: [{ ledger: files.ledger, sniffer: files.sniffer }, { ledger: mail.ledger, sniffer: mail.sniffer }],
    lane, model: recordingModel(prompts), maxCallsPerPass: 3 });
  expect(prompts.map(asked).slice(0, 2)).toEqual(['new-m-newest', 'new-f-older']);
  expect(prompts.map(asked)[2]).not.toContain('new-');
});

test('without a full listing yet, nothing is a new arrival', () => {
  const mail = source('mail-fixture');
  mail.place('backlog-1');
  mail.place('backlog-2');
  expect(mail.ledger.isNewArrival({ provider: 'mail-fixture', accountScope: 'owner', providerItemId: 'backlog-2' })).toBe(false);
  expect(mail.ledger.isNewArrival({ provider: 'mail-fixture', accountScope: 'owner', providerItemId: 'unseen' })).toBe(false);
  expect(mail.sniffer.listQuestions().every(question => question.priority < NEW_ARRIVAL_PRIORITY)).toBe(true);
});

test('a steady stream of new arrivals still leaves every fifth local dispatch to the oldest backlog question', async () => {
  const mail = source('mail-fixture');
  mail.place('backlog-oldest');
  mail.caughtUp();
  tick(10 * 60_000);
  for (let i = 1; i <= 8; i++) mail.place(`new-${i}`);
  const prompts: string[] = [];
  await runSnifferPass({ targets: [{ ledger: mail.ledger, sniffer: mail.sniffer }], lane, model: recordingModel(prompts), maxCallsPerPass: 5 });
  expect(prompts.map(asked)).toEqual(['new-8', 'new-7', 'new-6', 'new-5', 'backlog-oldest']);
});

test('a store listing that reaches the end of the data closes the first import for its accounts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-new-arrivals-'));
  const fixture = openTierFixture(root, { embed: false });
  opened.push({ close: () => { fixture.close(); rmSync(root, { recursive: true, force: true }); } });
  const listed: Array<{ id: string; name: string; text: string }> = [{ id: 'first', name: 'first.txt', text: 'Garden notes.' }];
  await fixture.set.sync(fixtureConnector(() => listed), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  expect(fixture.ledger.isNewArrival(identityOf('first'))).toBe(false);
  expect(fixture.ledger.isNewArrival(identityOf('later'))).toBe(true);
});
