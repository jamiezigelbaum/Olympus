import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HireLedger } from '../src/workers/hire-broker/ledger.ts';
import { MockPaymentProvider } from '../src/workers/hire-broker/payment.ts';
import { CounterpartyRegistry } from '../src/workers/hire-broker/registry.ts';
import type { CounterpartyCandidate } from '../src/workers/hire-broker/types.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Hire Broker private state substrate', () => {
  test('writes a chained append-only 0600 ledger and returns content-free summaries', async () => {
    const root = fixtureRoot();
    const path = join(root, 'state', 'ledger.jsonl');
    const ledger = new HireLedger(path);
    await ledger.initialize();
    const first = await ledger.append({ at: '2026-07-22T12:00:00.000Z', event: 'hire_requested', counterparty: 'fixture' });
    const second = await ledger.append({
      at: '2026-07-22T12:00:01.000Z',
      event: 'payment_intent',
      amount: 5,
      currency: 'USDC',
      outcome: 'authorized',
    });

    expect(second.previousHash).toBe(first.entryHash);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await ledger.summary()).toMatchObject({
      entries: 2,
      lastSequence: 2,
      totals: { USDC: 5 },
      outcomes: { authorized: 1 },
    });
  });

  test('refuses truncated, tampered, or over-permissive ledger state', async () => {
    const root = fixtureRoot();
    const path = join(root, 'ledger.jsonl');
    writeFileSync(path, '{"version":1}', { mode: 0o600 });
    await expect(new HireLedger(path).initialize()).rejects.toMatchObject({ code: 'ledger_corrupt' });

    writeFileSync(path, `${JSON.stringify({
      version: 1,
      sequence: 1,
      previousHash: '0'.repeat(64),
      at: '2026-07-22T12:00:00.000Z',
      event: 'hire_requested',
      entryHash: 'a'.repeat(64),
    })}\n`, { mode: 0o600 });
    await expect(new HireLedger(path).initialize()).rejects.toMatchObject({ code: 'ledger_corrupt' });

    chmodSync(path, 0o644);
    await expect(new HireLedger(path).initialize()).rejects.toMatchObject({ code: 'state_write_failed' });
  });

  test('refuses a corrupt registry instead of treating it as empty', async () => {
    const root = fixtureRoot();
    const path = join(root, 'registry.json');
    writeFileSync(path, '{"version":1,"counterparties":[', { mode: 0o600 });
    await expect(new CounterpartyRegistry(path).initialize()).rejects.toMatchObject({ code: 'registry_corrupt' });
  });

  test('requires first approval, then stays silent until a pinned identity field drifts', async () => {
    const root = fixtureRoot();
    const path = join(root, 'registry.json');
    const registry = new CounterpartyRegistry(path, () => new Date('2026-07-22T12:00:00.000Z'));
    const candidate = verifiedCandidate();
    if (candidate.identity.status !== 'verified') throw new Error('fixture identity must be verified');
    const identity = candidate.identity;

    expect(await registry.evaluate(candidate)).toMatchObject({
      kind: 'needs_owner_confirm',
      reasons: ['new_counterparty'],
    });
    await registry.approve(candidate);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await registry.evaluate(candidate)).toMatchObject({ kind: 'approved', reasons: [] });

    expect(await registry.evaluate({ ...candidate, endpoint: 'https://expert.example/v2' }))
      .toMatchObject({ kind: 'needs_owner_confirm', reasons: ['endpoint_drift'] });
    expect(await registry.evaluate({ ...candidate, agentCardHash: 'b'.repeat(64) }))
      .toMatchObject({ kind: 'needs_owner_confirm', reasons: ['agent_card_hash_drift'] });
    expect(await registry.evaluate({
      ...candidate,
      identity: { ...identity, owner: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    })).toMatchObject({ kind: 'needs_owner_confirm', reasons: ['erc8004_owner_drift'] });
    expect(await registry.evaluate({
      ...candidate,
      identity: { ...identity, tokenURI: 'https://cards.example/new.json' },
    })).toMatchObject({ kind: 'needs_owner_confirm', reasons: ['erc8004_token_uri_drift'] });
  });

  test('mock payment records quote, cap, pay, and settlement intent without a network dependency', async () => {
    const provider = new MockPaymentProvider({
      now: () => new Date('2026-07-22T12:00:00.000Z'),
      quotedAmount: 3,
    });
    const quote = await provider.quote({
      handle: 'hire_fixture',
      counterparty: 'fixture',
      endpoint: 'https://expert.example/a2a',
      budget: { amount: 5, currency: 'USDC' },
    });
    const reservation = await provider.reserveCaps(quote);
    const receipt = await provider.pay(quote, reservation);
    const spend = await provider.settle(receipt, 'completed');

    expect(provider.intents.map((intent) => intent.operation)).toEqual([
      'quote',
      'reserve_caps',
      'pay',
      'settle',
    ]);
    expect(spend).toMatchObject({ amount: 3, currency: 'USDC', outcome: 'completed' });
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-hire-broker-state-'));
  roots.push(root);
  return root;
}

function verifiedCandidate(): CounterpartyCandidate {
  return {
    name: 'Fixture Expert',
    endpoint: 'https://expert.example/a2a',
    agentCardHash: 'a'.repeat(64),
    identity: {
      status: 'verified',
      chain: 'base',
      agentId: '42',
      owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tokenURI: 'https://cards.example/42.json',
      registeredEndpoint: 'https://expert.example/a2a',
    },
  };
}
