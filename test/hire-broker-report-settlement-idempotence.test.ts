// expert_report is polled: the agent calls it repeatedly until the consultant
// task is done. Everything between the payment provider and the persisted job
// record therefore has to survive a repeat call, because the untrusted work
// that runs after settlement — the hostile-input membrane, and the local
// summarizer it depends on — fails for ordinary reasons a counterparty can
// provoke on every poll.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { A2aTaskReport, A2aTransport } from '../src/workers/hire-broker/a2a.ts';
import { HireBroker, HireJobStore } from '../src/workers/hire-broker/broker.ts';
import { CounterpartyIdentityResolver } from '../src/workers/hire-broker/identity.ts';
import { HireLedger } from '../src/workers/hire-broker/ledger.ts';
import { HostileInputMembrane } from '../src/workers/hire-broker/membrane.ts';
import { MockPaymentProvider } from '../src/workers/hire-broker/payment.ts';
import { CounterpartyRegistry } from '../src/workers/hire-broker/registry.ts';
import { HireBrokerError } from '../src/workers/hire-broker/types.ts';

const roots: string[] = [];
const NOW = () => new Date('2026-08-18T09:00:00.000Z');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Hire Broker report settlement', () => {
  test('a failing summarizer does not settle the same receipt on every retry', async () => {
    const fixture = await makeFixture();
    const handle = await fixture.submit();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(fixture.broker.report(handle)).rejects.toMatchObject({ code: 'report_unavailable' });
    }

    expect(settlements(fixture.payment)).toEqual([{ operation: 'settle', paymentReference: fixture.paymentReference(), outcome: 'completed' }]);
    // The job is still open for a later poll, and it carries the settlement it
    // already spent so that poll cannot spend the receipt a second time.
    const job = storedJob(fixture.root, handle);
    expect(job.status).toBe('submitted');
    expect(job.settledSpend).toMatchObject({ handle, amount: 3, currency: 'USDC', outcome: 'completed' });
  });

  test('the settled amount is reused once the summarizer recovers', async () => {
    const fixture = await makeFixture();
    const handle = await fixture.submit();

    await expect(fixture.broker.report(handle)).rejects.toMatchObject({ code: 'report_unavailable' });
    fixture.summarizerHealthy = true;
    const bounded = await fixture.broker.report(handle);
    if (!('summary' in bounded)) throw new Error('expected a bounded consultant report');

    expect(bounded).toMatchObject({ handle, status: 'completed' });
    expect(settlements(fixture.payment)).toHaveLength(1);
    expect(bounded.spend).toMatchObject({ amount: 3, currency: 'USDC', outcome: 'completed' });
    expect(completedSpendRecords(fixture.registryPath)).toHaveLength(1);
  });
});

async function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-hire-settlement-'));
  roots.push(root);
  const registryPath = join(root, 'registry.json');
  const payment = new MockPaymentProvider({ now: NOW, quotedAmount: 3 });
  const fixture = {
    root,
    registryPath,
    payment,
    summarizerHealthy: false,
    broker: undefined as unknown as HireBroker,
    submit: async (): Promise<string> => {
      const submitted = await fixture.broker.hire({
        listing: { name: 'Fixture Expert', endpoint: 'https://expert.example/a2a' },
        brief: 'Recommend a durable operating model for three overlapping launch checklists.',
        budget: { amount: 5, currency: 'USDC' },
        ownerConfirmed: true,
        ownerAuthorized: true,
      });
      if (submitted.status !== 'submitted') throw new Error('expected a submitted hire');
      return submitted.handle;
    },
    paymentReference: (): string => {
      const receipt = payment.intents.find((intent) => intent.operation === 'settle');
      if (!receipt || receipt.operation !== 'settle') throw new Error('expected a settlement intent');
      return receipt.paymentReference;
    },
  };
  fixture.broker = new HireBroker({
    registry: new CounterpartyRegistry(registryPath, NOW),
    ledger: new HireLedger(join(root, 'ledger.jsonl')),
    jobs: new HireJobStore(join(root, 'jobs.json'), join(root, 'reports')),
    identityResolver: new CounterpartyIdentityResolver(
      { resolve: async (endpoint) => ({ cardHash: 'a'.repeat(64), declaredEndpoint: endpoint }) },
      { verify: async () => { throw new Error('unexpected identity claim'); } },
    ),
    paymentProvider: payment,
    transport: new CompletedTransport(),
    membrane: new HostileInputMembrane({
      summarize: async () => {
        if (!fixture.summarizerHealthy) {
          throw new HireBrokerError('report_unavailable', 'Trusted local report summarizer is unavailable.', 503);
        }
        return 'The consultant recommends one shared checklist owner and a weekly reconciliation.';
      },
    }),
    now: NOW,
  });
  await fixture.broker.initialize();
  return fixture;
}

class CompletedTransport implements A2aTransport {
  async submit() {
    return { remoteTaskId: 'remote_1', status: 'working' };
  }

  async getReport(): Promise<A2aTaskReport> {
    return { status: 'completed', report: 'A bounded consultant report.\n\nA second evidence block.' };
  }
}

function settlements(payment: MockPaymentProvider) {
  return payment.intents.filter((intent) => intent.operation === 'settle');
}

function completedSpendRecords(registryPath: string) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    counterparties: { spendHistory?: { outcome: string }[] }[];
  };
  return registry.counterparties.flatMap((entry) => entry.spendHistory ?? [])
    .filter((spend) => spend.outcome === 'completed');
}

function storedJob(root: string, handle: string) {
  const state = JSON.parse(readFileSync(join(root, 'jobs.json'), 'utf8')) as {
    jobs: { handle: string; status: string; settledSpend?: Record<string, unknown> }[];
  };
  const job = state.jobs.find((entry) => entry.handle === handle);
  if (!job) throw new Error('expected the hire job to be persisted');
  return job;
}
