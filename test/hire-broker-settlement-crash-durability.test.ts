// The settlement guard that survives an ordinary in-process failure is the
// persisted `settledSpend`. It cannot survive a crash: the provider commits the
// external settlement and returns, and the process dies before the record is
// written. A retry then finds no settledSpend and spends the same payment
// receipt a second time, which no PaymentProvider in this contract promises to
// deduplicate. The write-ahead attempt below is what makes the second execution
// impossible rather than merely unlikely.

import { afterEach, expect, test } from 'bun:test';
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
const NOW = () => new Date('2026-08-18T11:00:00.000Z');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('a crash between provider settlement and its record does not settle the receipt twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-hire-settlement-crash-'));
  roots.push(root);
  const payment = new MockPaymentProvider({ now: NOW, quotedAmount: 3 });

  const crashing = new CrashingJobStore(join(root, 'jobs.json'), join(root, 'reports'));
  const first = makeBroker(root, payment, crashing);
  await first.initialize();
  const submitted = await first.hire({
    listing: { name: 'Fixture Expert', endpoint: 'https://expert.example/a2a' },
    brief: 'Recommend a durable operating model for three overlapping launch checklists.',
    budget: { amount: 5, currency: 'USDC' },
    ownerConfirmed: true,
    ownerAuthorized: true,
  });
  if (submitted.status !== 'submitted') throw new Error('expected a submitted hire');

  await expect(first.report(submitted.handle)).rejects.toThrow('simulated crash');
  expect(settlements(payment)).toHaveLength(1);

  // The process is gone; a fresh broker reloads the same durable job file.
  const second = makeBroker(root, payment, new HireJobStore(join(root, 'jobs.json'), join(root, 'reports')));
  await second.initialize();
  await expect(second.report(submitted.handle)).rejects.toMatchObject({ code: 'payment_failed' });

  expect(settlements(payment)).toHaveLength(1);
  const job = storedJob(root, submitted.handle);
  expect(job.pendingSettlement).toMatchObject({
    paymentReference: settlements(payment)[0]!.paymentReference,
    outcome: 'completed',
  });
  expect(job.settledSpend).toBeUndefined();
});

test('a provider refusal clears the attempt so the next poll may settle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-hire-settlement-refusal-'));
  roots.push(root);
  const payment = new RefusingOncePaymentProvider({ now: NOW, quotedAmount: 3 });
  const broker = makeBroker(root, payment, new HireJobStore(join(root, 'jobs.json'), join(root, 'reports')));
  await broker.initialize();
  const submitted = await broker.hire({
    listing: { name: 'Fixture Expert', endpoint: 'https://expert.example/a2a' },
    brief: 'Recommend a durable operating model for three overlapping launch checklists.',
    budget: { amount: 5, currency: 'USDC' },
    ownerConfirmed: true,
    ownerAuthorized: true,
  });
  if (submitted.status !== 'submitted') throw new Error('expected a submitted hire');

  await expect(broker.report(submitted.handle)).rejects.toMatchObject({ code: 'payment_provider_unavailable' });
  const bounded = await broker.report(submitted.handle);
  if (!('summary' in bounded)) throw new Error('expected a bounded consultant report');

  expect(bounded).toMatchObject({ handle: submitted.handle, status: 'completed' });
  expect(settlements(payment)).toHaveLength(1);
});

class CrashingJobStore extends HireJobStore {
  override async recordSettlement(): Promise<void> {
    throw new Error('simulated crash before the settlement was recorded');
  }
}

class RefusingOncePaymentProvider extends MockPaymentProvider {
  private refused = false;

  override async settle(receipt: Parameters<MockPaymentProvider['settle']>[0], outcome: 'completed' | 'failed') {
    if (!this.refused) {
      this.refused = true;
      throw new HireBrokerError('payment_provider_unavailable', 'Payment provider refused the settlement.', 503);
    }
    return super.settle(receipt, outcome);
  }
}

function makeBroker(root: string, payment: MockPaymentProvider, jobs: HireJobStore): HireBroker {
  return new HireBroker({
    registry: new CounterpartyRegistry(join(root, 'registry.json'), NOW),
    ledger: new HireLedger(join(root, 'ledger.jsonl')),
    jobs,
    identityResolver: new CounterpartyIdentityResolver(
      { resolve: async (endpoint) => ({ cardHash: 'a'.repeat(64), declaredEndpoint: endpoint }) },
      { verify: async () => { throw new Error('unexpected identity claim'); } },
    ),
    paymentProvider: payment,
    transport: new CompletedTransport(),
    membrane: new HostileInputMembrane({
      summarize: async () => 'The consultant recommends one shared checklist owner and a weekly reconciliation.',
    }),
    now: NOW,
  });
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
  return payment.intents.flatMap((intent) => (intent.operation === 'settle' ? [intent] : []));
}

function storedJob(root: string, handle: string) {
  const state = JSON.parse(readFileSync(join(root, 'jobs.json'), 'utf8')) as {
    jobs: {
      handle: string;
      settledSpend?: Record<string, unknown>;
      pendingSettlement?: Record<string, unknown>;
    }[];
  };
  const job = state.jobs.find((entry) => entry.handle === handle);
  if (!job) throw new Error('expected the hire job to be persisted');
  return job;
}
