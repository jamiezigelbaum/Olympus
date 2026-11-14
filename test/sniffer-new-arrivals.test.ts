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
import { TIERED_STORE_SET_HANDOFF_CONNECTOR_ID } from '../src/workers/connector-store/local-index.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, openTierFixture } from './helpers/tier-fixtures.ts';

const lane: SnifferLane = {
  kind: 'local', profileId: 'fixture', modelId: 'fixture',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' },
};
const signals = { classificationSignals: (value: RawItem) => ({ title: String(value.metadata.title) }) };

let clock = Date.parse('2026-11-14T00:00:00Z');
const now = () => new Date(clock);
const tick = (ms = 1_000) => { clock += ms; };
const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const handle of opened.splice(0)) handle.close(); });

const identity = (provider: string, id: string) => ({ family: 'email' as const, provider, accountScope: 'owner', providerItemId: id, localItemId: id });

function source(provider: string) {
  const ledger = new TierLedger({ dbPath: ':memory:', now });
  const sniffer = new TierSnifferStore({ dbPath: ':memory:', now });
  opened.push(sniffer, ledger);
  /** One item placed by the listing of `connectorId` (the live reader unless an archive input is named). */
  const place = (id: string, options: { connectorId?: string; textLater?: true } = {}) => {
    tick();
    const connectorId = options.connectorId ?? 'live';
    const raw: RawItem = {
      identity: identity(provider, id), mimeType: 'text/plain',
      content: { kind: 'text', text: `Lunch by the park on Friday. ${id}` },
      fetchedAt: now().toISOString(), metadata: { title: `${id} notes` },
    };
    const text = options.textLater ? undefined : `Lunch by the park on Friday. ${id}`;
    const decision = decideItemTiers(signals, raw, text, { sniffer: new CachedTierSniffer(sniffer, lane) }, ledger,
      { afterFirstImport: ledger.listingCaughtUp(connectorId) });
    ledger.recordDecision(raw.identity, decision);
  };
  return { ledger, sniffer, place, caughtUp: (connectorId = 'live') => { tick(); ledger.markListingCaughtUp(connectorId); } };
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

test('what a listing places after its first import is judged ahead of every store\'s backlog, newest first', async () => {
  const mail = source('mail-fixture');
  const files = source('files-fixture');
  for (const id of ['backlog-m1', 'backlog-m2', 'backlog-m3']) mail.place(id);
  for (const id of ['backlog-f1', 'backlog-f2', 'backlog-f3']) files.place(id);
  mail.caughtUp();
  files.caughtUp();
  // An archive is its own input, with its own listing: still its first import.
  mail.place('archive-a1', { connectorId: 'archive:takeout' });
  files.place('new-f-older');
  mail.place('new-m-newest');
  expect(mail.sniffer.questionFor(identity('mail-fixture', 'new-m-newest'), 'content')?.priority).toBe(NEW_ARRIVAL_PRIORITY);
  expect(mail.sniffer.questionFor(identity('mail-fixture', 'archive-a1'), 'content')?.priority).toBeLessThan(NEW_ARRIVAL_PRIORITY);
  expect(mail.sniffer.questionFor(identity('mail-fixture', 'backlog-m1'), 'content')?.priority).toBeLessThan(NEW_ARRIVAL_PRIORITY);

  const prompts: string[] = [];
  await runSnifferPass({ targets: [{ ledger: files.ledger, sniffer: files.sniffer }, { ledger: mail.ledger, sniffer: mail.sniffer }],
    lane, model: recordingModel(prompts), maxCallsPerPass: 3 });
  expect(prompts.map(asked).slice(0, 2)).toEqual(['new-m-newest', 'new-f-older']);
  expect(prompts.map(asked)[2]).not.toContain('new-');
});

test('an item already placed is not a new arrival when it is listed again, and text read later keeps the mark once', () => {
  const mail = source('mail-fixture');
  mail.place('backlog-1');
  mail.caughtUp();
  mail.place('backlog-1');
  expect(mail.sniffer.questionFor(identity('mail-fixture', 'backlog-1'), 'content')?.priority).toBeLessThan(NEW_ARRIVAL_PRIORITY);
  mail.place('new-file', { textLater: true });
  expect(mail.ledger.newArrival(identity('mail-fixture', 'new-file'), { consume: true })).toBe(true);
  expect(mail.ledger.newArrival(identity('mail-fixture', 'new-file'))).toBe(false);
  expect(mail.ledger.newArrival(identity('mail-fixture', 'backlog-1'))).toBe(false);
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

test('a store listing that reaches the end of the data closes that connector\'s first import; a handoff never does', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-new-arrivals-'));
  const fixture = openTierFixture(root, { embed: false });
  opened.push({ close: () => { fixture.close(); rmSync(root, { recursive: true, force: true }); } });
  expect(fixture.ledger.listingCaughtUp('fixture_lane')).toBe(false);
  await fixture.set.sync(fixtureConnector(() => [{ id: 'first', name: 'first.txt', text: 'Garden notes.' }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  expect(fixture.ledger.listingCaughtUp('fixture_lane')).toBe(true);
  expect(fixture.ledger.listingCaughtUp(TIERED_STORE_SET_HANDOFF_CONNECTOR_ID)).toBe(false);
});

test('a new arrival asked about again (a sweep, a re-judge) keeps its place ahead of the backlog', () => {
  const store = new TierSnifferStore({ dbPath: ':memory:', now });
  opened.push(store);
  const subject = identity('mail-fixture', 'new-1');
  const question = { subject, pass: 'content' as const, material: 'same text', mapRevision: 'none', flags: [] };
  store.enqueue({ ...question, priority: NEW_ARRIVAL_PRIORITY });
  store.enqueue({ ...question, priority: -1 });
  expect(store.questionFor(subject, 'content')?.priority).toBe(NEW_ARRIVAL_PRIORITY);
  const backlog = identity('mail-fixture', 'backlog-1');
  store.enqueue({ ...question, subject: backlog, priority: 10 });
  store.enqueue({ ...question, subject: backlog, priority: -1 });
  expect(store.questionFor(backlog, 'content')?.priority).toBe(-1);
});
