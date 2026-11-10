// The judge's order (sniffer-resolver.ts): items a question matched go first
// (#1062), every store takes turns whatever its questions' priority (#866),
// and every fifth dispatch still goes to an aged question. Order only.

import { afterEach, describe, expect, test } from 'bun:test';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';
import type { SourceIndexRoutedSearchHit } from '../src/core/source-index/router.ts';
import { JUDGE_BOOST_MAX_ITEMS, JUDGE_BOOST_PER_QUESTION, JUDGE_BOOST_TTL_MS, JudgeBoosts } from '../src/workers/classification/judge-boost.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { HELD_RECORD_PRIORITY, HELD_UNTIL_JUDGED_PRIORITY, classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';

const LANE: SnifferLane = {
  kind: 'local', modelId: 'fixture-local-sniffer', profileId: 'local-sniffer',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-local-sniffer' },
};
// Structured identifiers in names always ask the names question.
const FLAGGED = 'SSN 123-45-6789';
const START = Date.parse('2026-11-10T08:00:00Z');

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** One store's lane on a clock the test moves. */
function lane(provider: string, clock: { ms: number }) {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const sniffer = new TierSnifferStore({ dbPath: ':memory:', now: () => new Date(clock.ms) });
  cleanups.push(() => { sniffer.close(); ledger.close(); });
  return {
    target: { ledger, sniffer },
    sniffer,
    /** Queue a names question for one item; `held` gives it the import hold's priority. */
    add(name: string, options: { held?: boolean } = {}) {
      const subject = { provider, accountScope: 'owner', providerItemId: name };
      ledger.recordDecision(subject, classifyItemTiers(
        { signals: { title: `${name} file`, labels: [FLAGGED] }, subject, ...(options.held ? { holdUntilJudged: true } : {}) },
        { sniffer: new CachedTierSniffer(sniffer, LANE) },
      ));
      return subject;
    },
  };
}

/** A model that answers Private and records which item each call was about. */
function recording(): AnalystModel & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async complete(request: AnalystModelRequest) {
      const item = request.prompt.split('\n').find((line) => line.startsWith('{'))!;
      asked.push(/"names":"([^"]*?) file/u.exec(item)?.[1] ?? item);
      return { modelId: LANE.modelId, text: JSON.stringify({ verdicts: [{ i: 1, tier: 'private', category: 'financial', confidence: 0.9, ownRecord: false, privateKind: 'none' }] }) };
    },
  };
}

describe('items a question matched are judged first (#1062)', () => {
  test('a matched pending item is dispatched ahead of newer unmatched ones, and the aged slot still fires', async () => {
    const clock = { ms: START };
    const store = lane('fixture', clock);
    store.add('aged');
    clock.ms += 10 * 60_000;
    const matched = store.add('matched');
    clock.ms += 1_000;
    for (let n = 0; n < 6; n += 1) { store.add(`newer-${n}`); clock.ms += 1_000; }
    const boosts = new JudgeBoosts({ now: () => clock.ms });
    boosts.raise([matched]);
    const model = recording();
    await runSnifferPass({ targets: [store.target], lane: LANE, model, boosts, maxCallsPerPass: 5 });
    // Without the raise the newest goes first; with it the match does.
    expect(model.asked[0]).toBe('matched');
    expect(model.asked.slice(1, 4)).toEqual(['newer-5', 'newer-4', 'newer-3']);
    // The fifth dispatch is the aged question's, not the next newest.
    expect(model.asked[4]).toBe('aged');
  });

  test('the aged slot comes before a raised item when it falls due', async () => {
    const clock = { ms: START };
    const store = lane('fixture', clock);
    store.add('aged');
    clock.ms += 10 * 60_000;
    const raised = Array.from({ length: 6 }, (_, n) => store.add(`matched-${n}`));
    const boosts = new JudgeBoosts({ now: () => clock.ms });
    boosts.raise(raised);
    const model = recording();
    await runSnifferPass({ targets: [store.target], lane: LANE, model, boosts, maxCallsPerPass: 5 });
    expect(model.asked.slice(0, 4).every((name) => name.startsWith('matched-'))).toBe(true);
    expect(model.asked[4]).toBe('aged');
  });

  test('a matched item past the bounded page is still read and asked first', async () => {
    const clock = { ms: START };
    const store = lane('fixture', clock);
    const old = store.add('old-match');
    clock.ms += 1_000;
    for (let n = 0; n < 8; n += 1) { store.add(`newer-${n}`); clock.ms += 1_000; }
    const boosts = new JudgeBoosts({ now: () => clock.ms });
    boosts.raise([old]);
    const model = recording();
    await runSnifferPass({ targets: [store.target], lane: LANE, model, boosts, maxCallsPerPass: 1, pendingPageSize: 3 });
    expect(model.asked).toEqual(['old-match']);
    // Judged: nothing left to raise.
    await runSnifferPass({ targets: [store.target], lane: LANE, model, boosts, maxCallsPerPass: 1 });
    expect(boosts.live()).toEqual([]);
  });

  test('raises are capped per question and in all, and expire', () => {
    const clock = { ms: START };
    const boosts = new JudgeBoosts({ now: () => clock.ms });
    const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, n) => ({ provider: 'p', accountScope: 'a', providerItemId: `${prefix}-${n}` }));
    boosts.raise(ids('q', 50));
    expect(boosts.size).toBe(JUDGE_BOOST_PER_QUESTION);
    expect(boosts.has({ provider: 'p', accountScope: 'a', providerItemId: 'q-19' })).toBe(true);
    expect(boosts.has({ provider: 'p', accountScope: 'a', providerItemId: 'q-20' })).toBe(false);
    for (let n = 0; n < 20; n += 1) boosts.raise(ids(`question-${n}`, JUDGE_BOOST_PER_QUESTION));
    expect(boosts.size).toBe(JUDGE_BOOST_MAX_ITEMS);
    clock.ms += JUDGE_BOOST_TTL_MS;
    expect(boosts.live()).toEqual([]);
  });

  test('the visibility gate reports held matches in rank order and keeps the same hits', () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    cleanups.push(() => ledger.close());
    const item = (id: string) => ({ provider: 'fixture', accountScope: 'owner', providerItemId: id });
    const place = (id: string, embedHold: boolean) => {
      const decision = classifyItemTiers({ signals: { title: id }, subject: item(id) });
      ledger.recordRoutedPlacement(item(id), decision, { copies: [{ corpusId: 'private', trustDomain: 'secure_local', layers: 'both' }], embedHold });
    };
    place('settled', false);
    place('held-b', true);
    place('held-a', true);
    const hit = (id: string) => ({ corpusId: 'private', sourceItem: { family: 'files', ...item(id) } }) as unknown as SourceIndexRoutedSearchHit;
    const hits = [hit('held-a'), hit('settled'), hit('held-b')];
    const heard: string[][] = [];
    const scopes = () => [{ ledger, corpusIds: new Set(['private']) }];
    const gate = createTierVisibilityGate(scopes, (identities) => heard.push(identities.map((identity) => identity.providerItemId)));
    const plain = createTierVisibilityGate(scopes);
    expect(gate(hits)).toEqual(plain(hits));
    expect(heard).toEqual([['held-a', 'held-b']]);
  });

  test('held matches from several corpora share the allowance: each corpus takes turns', () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    cleanups.push(() => ledger.close());
    const item = (id: string) => ({ provider: 'fixture', accountScope: 'owner', providerItemId: id });
    const hold = (corpusId: string, id: string) => {
      ledger.recordRoutedPlacement(item(id), classifyItemTiers({ signals: { title: id }, subject: item(id) }), {
        copies: [{ corpusId, trustDomain: 'secure_local', layers: 'both' }], embedHold: true });
      return { corpusId, sourceItem: { family: 'files', ...item(id) } } as unknown as SourceIndexRoutedSearchHit;
    };
    // The router's order: every hit of the first corpus, then the second's.
    const hits = [
      ...Array.from({ length: 25 }, (_, n) => hold('mail', `mail-${n}`)),
      ...Array.from({ length: 3 }, (_, n) => hold('files', `doc-${n}`)),
    ];
    const boosts = new JudgeBoosts();
    const gate = createTierVisibilityGate(() => [{ ledger, corpusIds: new Set(['mail', 'files']) }], (identities) => boosts.raise(identities));
    gate(hits);
    for (let n = 0; n < 3; n += 1) expect(boosts.has(item(`doc-${n}`))).toBe(true);
    expect(boosts.has(item('mail-0'))).toBe(true);
    expect(boosts.size).toBe(JUDGE_BOOST_PER_QUESTION);
  });
});

describe('every source takes turns, whatever its priority (#866)', () => {
  test('with a Gmail backlog at a higher priority, a new Dropbox item is asked within a few picks', async () => {
    const clock = { ms: START };
    const gmail = lane('gmail', clock);
    const dropbox = lane('dropbox', clock);
    for (let n = 0; n < 30; n += 1) { gmail.add(`mail-${n}`); clock.ms += 1_000; }
    for (let n = 0; n < 5; n += 1) { dropbox.add(`older-doc-${n}`, { held: true }); clock.ms += 1_000; }
    const fresh = dropbox.add('new-doc', { held: true });
    expect(gmail.sniffer.questionFor({ provider: 'gmail', accountScope: 'owner', providerItemId: 'mail-0' }, 'metadata')?.priority).toBe(HELD_RECORD_PRIORITY);
    expect(dropbox.sniffer.questionFor(fresh, 'metadata')?.priority).toBe(HELD_UNTIL_JUDGED_PRIORITY);
    const model = recording();
    await runSnifferPass({ targets: [gmail.target, dropbox.target], lane: LANE, model, boosts: new JudgeBoosts(), maxCallsPerPass: 4 });
    expect(model.asked.indexOf('new-doc')).toBeGreaterThanOrEqual(0);
    expect(model.asked.indexOf('new-doc')).toBeLessThan(2);
  });

  test('a cloud lane takes turns too', async () => {
    const clock = { ms: START };
    const gmail = lane('gmail', clock);
    const dropbox = lane('dropbox', clock);
    for (let n = 0; n < 10; n += 1) { gmail.add(`mail-${n}`); clock.ms += 1_000; }
    dropbox.add('new-doc', { held: true });
    const venice: SnifferLane = { kind: 'venice', modelId: 'fixture-venice-sniffer', profileId: 'venice-sniffer',
      profile: { provider: 'venice', trust: 'encrypted_cloud', model: 'fixture-venice-sniffer' } } as SnifferLane;
    const model = recording();
    await runSnifferPass({ targets: [gmail.target, dropbox.target], lane: venice, model, boosts: new JudgeBoosts(), maxCallsPerPass: 2 });
    expect(model.asked).toContain('new-doc');
  });
});
