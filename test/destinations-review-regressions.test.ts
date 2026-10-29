import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analyst } from '../src/core/contracts.ts';
import type { LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import type { SourceIndexCorpusSearchAdapter, SourceIndexRouterAdapterMap } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { openWaitingPrivateQuestionStore } from '../src/core/waiting-private-questions.ts';
import { openV3Inbox as openBaseStore } from './fixtures/waiting-private-questions-v3.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  type SovereigntyAnalystRoutePlan,
  type SovereigntyAnalystRouteStep,
} from '../src/workers/source-index/analyst-answer.ts';
import { checkLocalEvidenceItems } from '../src/workers/source-index/local-answer.ts';
import { createVeniceInboxAnswer } from '../src/workers/email-source/venice-inbox-answer.ts';
import { askWithAnonymousInbox, createLocalPrivateAnswers, anonymousInboxConnectionId, localInboxLabel } from '../src/workers/email-source/local-private-answers.ts';

const SECURE = 'secure_local.test.pool';
const NAMES = 'internal.test.names';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'review-destinations-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function item(id: string) {
  return { family: 'file' as const, provider: 'test', accountScope: 'personal', providerItemId: id, localItemId: id };
}
function adapterFor(id: string): SourceIndexCorpusSearchAdapter {
  return () => ({
    hits: [{ sourceItem: item(id), provenance: { sourceItem: item(id), citation: { title: `title of ${id}` } }, score: 1, rawExposed: false }],
    latencyMs: 1, laneAudits: [], rawExposed: false,
  });
}
/** A Private content copy plus the Personal "name copy" the tier ledger leaves behind (contentPrivate). */
function lanes() {
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
    defineSourceIndexCorpus({ corpusId: NAMES, family: 'file', trustDomain: 'internal' }),
  ]);
  return {
    registry,
    adapters: { [SECURE]: adapterFor('secure-item'), [NAMES]: adapterFor('names-item') } as SourceIndexRouterAdapterMap,
    contentProviders: {
      [SECURE]: {
        contentServable: () => true,
        async fetchLocalContent() {
          return { sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }), chunks: ['SYNTHETIC_PRIVATE_PASSAGE'] };
        },
      },
      [NAMES]: {
        // What the connector-store provider does for a name-only copy of Private content.
        contentServable: () => false,
        async fetchLocalContent() {
          return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: [], contentPrivate: true };
        },
      },
    } as unknown as LocalContentProviderMap,
  };
}
function step(id: string, analyst: Analyst): SovereigntyAnalystRouteStep {
  return {
    profile: { id, profile: { provider: 'venice', trust: 'encrypted_cloud', model: 'kimi-k3', purpose: 'analyst' } },
    backend: 'venice', analyst,
  };
}
function route(steps: SovereigntyAnalystRouteStep[]): SovereigntyAnalystRoutePlan {
  return { poolId: 'secure_local', trustDomain: 'secure_local', selection: 'explicit_order', steps };
}
function wire(venice: Analyst | Analyst[], dir: string, allowed = () => true, ownerAllowed = allowed) {
  const l = lanes();
  const analysts = Array.isArray(venice) ? venice : [venice];
  const handler = createAnalystSourceIndexAnswerHandler({
    analyst: analysts[0]!,
    lanes: () => l,
    releaseCheck: {
      inputs: inputs => inputs.map(input => ({ tier: JSON.stringify(input).includes(NAMES) ? 'public_or_personal' as const : 'private' as const, gone: false })),
      secureDerivativeDefault: () => 'allow',
    },
    sovereigntyAnalystRoute: () => route(analysts.map((analyst, i) => step(`venice-${i}`, analyst))),
  });
  const store = openWaitingPrivateQuestionStore(join(dir, 'inbox.sqlite'));
  cleanups.push(() => store.close());
  const eligible = async (items: readonly Record<string, unknown>[]) => allowed() ? checkLocalEvidenceItems({ lanes: () => l, items: items as never }) : items.map(() => false);
  const veniceAnswer = createVeniceInboxAnswer({
    state: () => 'ready', handler, corpusIds: () => [SECURE, NAMES], eligible,
  });
  const api = createLocalPrivateAnswers({
    localConnectionId: '@local:You', store: () => store, answer: async () => ({ status: 'failed' }),
    destinations: () => ({ computer: 'ready', venice: 'ready' }), veniceAnswer,
    eligible: async (items: readonly Record<string, unknown>[]) => ownerAllowed() ? eligible(items) : items.map(() => false),
  } as never);
  cleanups.push(() => api.close());
  return { store, api };
}

describe('R1: Venice dispatch with a name-only (contentPrivate) hit beside the Private content copy', () => {
  test('Private content is answered and disclosed without the name-only copy', async () => {
    const dir = tmp();
    let veniceCalls = 0; let packSeen = '';
    const venice: Analyst = { async analyze(pack) {
      veniceCalls++; packSeen = JSON.stringify(pack);
      return { answer: 'A synthetic Venice answer.', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'x' }], unanswered: [] };
    } };
    const { store, api } = wire(venice, dir);
    const response = await api.handle({ action: 'ask_venice', question: 'What does the synthetic renewal say?' }, 'owner');
    // The Private passage and the question were sent to Venice ...
    expect(veniceCalls).toBe(1);
    expect(packSeen).toContain('SYNTHETIC_PRIVATE_PASSAGE');
    expect(response.body).toMatchObject({ ok: true, status: 'answered', sent_items: [{ title: 'title of secure-item', source: 'test' }] });
    expect(store.list().questions).toHaveLength(1);
  });

  test('control: without the name-only hit the same path answers and records what was sent', async () => {
    const dir = tmp();
    const venice: Analyst = { async analyze(pack) {
      return { answer: 'A synthetic Venice answer.', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'x' }], unanswered: [] };
    } };
    const l = lanes();
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: venice, lanes: () => l,
      releaseCheck: { inputs: inputs => inputs.map(() => ({ tier: 'private' as const, gone: false })), secureDerivativeDefault: () => 'allow' },
      sovereigntyAnalystRoute: () => route([step('venice-0', venice)]),
    });
    const answer = createVeniceInboxAnswer({
      state: () => 'ready', handler, corpusIds: () => [SECURE],
      eligible: async items => checkLocalEvidenceItems({ lanes: () => l, items: items as never }),
    });
    const result = await answer({ question: 'What does the synthetic renewal say?' });
    expect(result.status).toBe('answered');
  });
});

describe('R3: two approved Venice members, the first fails', () => {
  test('retries disclose each item only once', async () => {
    const dir = tmp();
    let first = 0;
    const failing: Analyst = { async analyze() { first++; throw new Error('provider down'); } };
    const working: Analyst = { async analyze(pack) {
      return { answer: 'A synthetic Venice answer.', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'x' }], unanswered: [] };
    } };
    const l = lanes();
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: working, lanes: () => l,
      releaseCheck: { inputs: inputs => inputs.map(() => ({ tier: 'private' as const, gone: false })), secureDerivativeDefault: () => 'allow' },
      sovereigntyAnalystRoute: () => route([step('venice-a', failing), step('venice-b', working)]),
    });
    const answer = createVeniceInboxAnswer({
      state: () => 'ready', handler, corpusIds: () => [SECURE],
      eligible: async items => checkLocalEvidenceItems({ lanes: () => l, items: items as never }),
    });
    const result = await answer({ question: 'What does the synthetic renewal say?' });
    expect(first).toBe(1);
    expect(result.status).toBe('answered');
    if (result.status === 'answered') {
      expect(result.read).toHaveLength(1);
    }
  });
});

describe('R2: a genuine v3 inbox (created by the 7a1c09b7 module) opens at head', () => {
  test('migrates v3 to v5 keeping rows', () => {
    const dir = tmp();
    const path = join(dir, 'v3.sqlite');
    const base = openBaseStore(path);
    const ref = base.record(base.ticket('old-agent'), { question: 'Old private question', state: 'waiting', surface: 'remote' })!;
    expect(base.saveAnswer(ref, { status: 'answered', answer: 'Old local reply', citations: [], read: [], leftOut: [], unanswered: [] })).toBe(true);
    base.close();
    const upgraded = openWaitingPrivateQuestionStore(path);
    cleanups.push(() => upgraded.close());
    expect(upgraded.get(ref.id)).toMatchObject({ path: 'private', question: 'Old private question', result: { answer: 'Old local reply' } });
    const venice = upgraded.record(upgraded.ticket('@local:You'), { question: 'v', state: 'waiting', surface: 'remote', path: 'venice', retainEachAsk: true })!;
    expect(upgraded.get(venice.id)?.path).toBe('venice');
  });
});

describe('R5: remote and page asks carry no revocation/delete check into the zkAPI preparation window', () => {
  test('a revoke during preparation stops the send', async () => {
    const dir = tmp();
    const store = openWaitingPrivateQuestionStore(join(dir, 'inbox.sqlite'));
    cleanups.push(() => store.close());
    let seen: unknown = 'unset'; let sent = 0;
    const result = await askWithAnonymousInbox({ question: 'A general question?' } as never, {
      store: () => store, connectionId: 'conn-1',
      ask: async input => {
        seen = input.stillAuthorized;
        store.revokeConnection('conn-1'); // revoked while the question is being prepared
        if (!input.stillAuthorized?.()) return { ok: false, code: 'transport_unavailable', message: 'Revoked' };
        sent++;
        return { ok: true, reply: 'r', sent: 'A general question?', model: 'm' } as never;
      },
    });
    expect(typeof seen).toBe('function');
    expect(sent).toBe(0);
    expect(result.ok).toBe(false);
  });
});


describe('post-send Venice disclosure survives withdrawal', () => {
  for (const stage of ['provider', 'final_check', 'later_read', 'exception'] as const) {
    test(stage, async () => {
      const dir = tmp();
      let allowed = true;
      let ownerAllowed = true;
      const { store, api } = wire({ async analyze(pack) {
        if (stage === 'provider') allowed = false;
        if (stage === 'final_check') ownerAllowed = false;
        if (stage === 'exception') throw new Error('synthetic outage');
        return { answer: 'ANSWER_MUST_BE_WITHDRAWN', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'x' }], unanswered: [] };
      } }, dir, () => allowed, () => ownerAllowed);
      let response = await api.handle({ action: 'ask_venice', question: 'Synthetic question' }, 'owner');
      const row = store.list().questions[0]!;
      expect(row).toBeDefined();
      if (stage === 'later_read') {
        expect(response.body.status).toBe('answered');
        allowed = false;
        response = await api.handle({ action: 'read', id: row.id }, 'owner');
      }
      expect(response.body).toMatchObject({ status: 'withdrawn', sent_items: [{ title: 'title of secure-item', source: 'test' }] });
      expect(response.body.reason).toMatch(/Sent to Venice/);
      const kept = store.get(row.id)!;
      expect(kept.result).toMatchObject({ status: 'withdrawn', read: [], citations: [], sentItems: [{ title: 'title of secure-item', source: 'test' }] });
      expect(JSON.stringify(kept)).not.toContain('ANSWER_MUST_BE_WITHDRAWN');
      expect(JSON.stringify(kept)).not.toContain('SYNTHETIC_PRIVATE_PASSAGE');
      // The disclosure remains readable, including from a separately opened store.
      const reopened = openWaitingPrivateQuestionStore(join(dir, 'inbox.sqlite'));
      try { expect(reopened.get(row.id)?.result?.sentItems).toHaveLength(1); } finally { reopened.close(); }
      expect((await api.handle({ action: 'read', id: row.id }, 'owner')).body).toMatchObject({ status: 'withdrawn', sent_items: [{ title: 'title of secure-item', source: 'test' }] });
      await api.handle({ action: 'delete', id: row.id }, 'owner');
      expect(store.get(row.id)).toBeUndefined();
    });
  }
});

describe('anonymous send authorization and server-owned local quotas', () => {
  for (const change of ['delete', 'delete_all', 'revoke', 'inactive', 'caller_refused', 'closed_store'] as const) {
    test(`preparation: ${change} fences the send`, async () => {
      const store = openWaitingPrivateQuestionStore(join(tmp(), 'inbox.sqlite'));
      cleanups.push(() => { try { store.close(); } catch {} });
      let active = true;
      let sent = 0;
      const result = await askWithAnonymousInbox({ question: 'q', stillAuthorized: () => change !== 'caller_refused' }, {
        store: () => store, connectionId: 'remote', isActive: () => active,
        ask: async input => {
          if (change === 'delete') store.dismiss(store.list().questions[0]!.id);
          if (change === 'delete_all') store.dismissAll();
          if (change === 'revoke') store.revokeConnection('remote');
          if (change === 'inactive') active = false;
          if (change === 'closed_store') store.close();
          if (!input.stillAuthorized?.()) return { ok: false, code: 'transport_unavailable', message: 'Refused' };
          sent++;
          return { ok: true, reply: 'r', sent: 'q', model: 'm' } as never;
        },
      });
      expect(result.ok).toBe(false);
      expect(sent).toBe(0);
    });
  }
  test('fresh claimed names cannot take the owner label or bucket', async () => {
    const store = openWaitingPrivateQuestionStore(join(tmp(), 'inbox.sqlite'));
    cleanups.push(() => store.close());
    let sent = 0;
    const owner = store.record(store.ticket('@local:You'), { question: 'Owner question', surface: 'remote', state: 'waiting' })!;
    for (const display_name of ['You', 'ChatGPT', '<img src=x onerror=alert(1)>', 'fresh-a', 'fresh-b', 'fresh-c']) {
      const id = anonymousInboxConnectionId({ display_name });
      expect(id).toBe('@local:agents');
      expect(localInboxLabel(id)).toBe('Local agent');
      await askWithAnonymousInbox({ question: 'q' }, { store: () => store, connectionId: id, ask: async () => {
        sent++;
        return { ok: true, reply: 'r', sent: 'q', model: 'm' } as never;
      } });
    }
    expect(sent).toBe(6);
    expect(store.get(owner.id)?.question).toBe('Owner question');
    expect(anonymousInboxConnectionId({ connection_id: 'authenticated-remote', display_name: 'You' })).toBe('authenticated-remote');
    expect(localInboxLabel('@local:You')).toBe('You');
    expect(localInboxLabel('@local:ChatGPT')).toBe('Local agent: ChatGPT');
    const server = readFileSync(new URL('../src/workers/email-source/server.ts', import.meta.url), 'utf8');
    expect(server).toContain('connectionId: anonymousInboxConnectionId(caller)');
    expect(server).not.toContain('@local:${caller?.display_name');
  });
});
