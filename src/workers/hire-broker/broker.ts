import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import type { A2aTransport } from './a2a.ts';
import type { CounterpartyIdentityResolver } from './identity.ts';
import { HireLedger, type LedgerSummary } from './ledger.ts';
import { HostileInputMembrane, type BoundedConsultantReport, type QuotedRawReport } from './membrane.ts';
import type { PaymentProvider, PaymentReceipt } from './payment.ts';
import { CounterpartyRegistry } from './registry.ts';
import { assertOutboundReleaseAllowed, evaluateOutboundRelease } from './release.ts';
import { atomicWritePrivate, readPrivateFile, secureDirectory } from './secure-files.ts';
import type {
  CounterpartyCandidate,
  HireBudget,
  HireListing,
  SpendRecord,
} from './types.ts';
import {
  HireBrokerError,
  parseHireBudget,
  parseHireListing,
  requiredString,
} from './types.ts';

export interface ExpertHireRequest {
  listing: unknown;
  brief: string;
  context?: string;
  budget: unknown;
  ownerConfirmed?: boolean;
  ownerAuthorized?: boolean;
}

export interface OwnerConfirmationRequired {
  status: 'needs_owner_confirm';
  confirmation: {
    counterparty: string;
    endpoint: string;
    identity_status: 'verified' | 'unverified_identity';
    reasons: string[];
    amount: number;
    currency: string;
    identity?: {
      chain: string;
      agent_id: string;
      owner: string;
      token_uri: string;
    };
  };
}

export interface ExpertHireSubmitted {
  status: 'submitted';
  handle: string;
  counterparty: string;
  identity_status: 'verified' | 'unverified_identity';
  spend: {
    amount: number;
    currency: string;
    outcome: 'submitted';
  };
}

export type ExpertHireResult = OwnerConfirmationRequired | ExpertHireSubmitted;

export type ExpertReportResult =
  | BoundedConsultantReport
  | { handle: string; status: 'pending' | 'failed' };

export interface HireBrokerOptions {
  registry: CounterpartyRegistry;
  ledger: HireLedger;
  jobs: HireJobStore;
  identityResolver: CounterpartyIdentityResolver;
  paymentProvider?: PaymentProvider;
  transport: A2aTransport;
  membrane: HostileInputMembrane;
  now?: () => Date;
}

export class HireBroker {
  private readonly registry: CounterpartyRegistry;
  private readonly ledger: HireLedger;
  private readonly jobs: HireJobStore;
  private readonly identityResolver: CounterpartyIdentityResolver;
  private readonly paymentProvider: PaymentProvider | undefined;
  private readonly transport: A2aTransport;
  private readonly membrane: HostileInputMembrane;
  private readonly now: () => Date;
  private operationGate: Promise<void> = Promise.resolve();

  constructor(options: HireBrokerOptions) {
    this.registry = options.registry;
    this.ledger = options.ledger;
    this.jobs = options.jobs;
    this.identityResolver = options.identityResolver;
    this.paymentProvider = options.paymentProvider;
    this.transport = options.transport;
    this.membrane = options.membrane;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.registry.initialize();
    await this.ledger.initialize();
    await this.jobs.initialize();
  }

  async hire(request: ExpertHireRequest): Promise<ExpertHireResult> {
    return this.serialized(async () => {
      const listing = parseHireListing(request.listing);
      const budget = parseHireBudget(request.budget);
      const release = evaluateOutboundRelease({
        brief: request.brief,
        ...(request.context !== undefined ? { context: request.context } : {}),
      });
      await this.ledger.append({
        at: this.now().toISOString(),
        event: 'release_decided',
        counterparty: listing.name,
        endpoint: listing.endpoint,
        gateDecision: release.gate.decision,
      });
      assertOutboundReleaseAllowed(release);

      if (!this.paymentProvider) {
        throw new HireBrokerError(
          'payment_provider_unavailable',
          'Hire Broker has no payment provider configured.',
          503,
        );
      }

      const candidate = await this.identityResolver.resolve(listing);
      await this.ledger.append(identityLedgerEntry(this.now, candidate, 'hire_requested'));
      const counterparty = await this.registry.evaluate(candidate);
      if (counterparty.kind === 'needs_owner_confirm') {
        if (request.ownerConfirmed !== true) {
          await this.ledger.append({
            ...identityLedgerEntry(this.now, candidate, 'owner_confirmation_required'),
            outcome: counterparty.reasons.join(','),
          });
          return confirmationResult(candidate, counterparty.reasons, budget);
        }
        if (request.ownerAuthorized !== true) {
          throw new HireBrokerError(
            'owner_confirmation_denied',
            'Counterparty approval requires trusted owner confirmation.',
            403,
          );
        }
        await this.registry.approve(candidate);
        await this.ledger.append(identityLedgerEntry(this.now, candidate, 'owner_approved'));
      }

      return this.submitHire(listing, candidate, request, budget, this.paymentProvider);
    }).catch(async (error) => {
      await this.recordRefusal(error).catch(() => undefined);
      throw error;
    });
  }

  async report(handleValue: unknown): Promise<ExpertReportResult> {
    const handle = parseHandle(handleValue);
    return this.serialized(async () => {
      const job = await this.jobs.get(handle);
      if (job.boundedReport) return job.boundedReport;
      if (job.status === 'failed') return { handle, status: 'failed' };
      const remote = await this.transport.getReport(job.endpoint, job.remoteTaskId);
      if (remote.status === 'pending') return { handle, status: 'pending' };
      if (remote.status === 'failed') {
        const spend = await this.settleJob(job, 'failed');
        await this.registry.recordSpend(job.counterpartyName, spend);
        await this.jobs.finish(handle, { status: 'failed', spend });
        return { handle, status: 'failed' };
      }
      const rawReport = remote.report;
      if (!rawReport) throw new HireBrokerError('report_unavailable', 'Consultant report is unavailable.', 502);
      await this.jobs.writeRawReport(handle, rawReport);
      const spend = await this.settleJob(job, 'completed');
      const bounded = await this.membrane.process({
        handle,
        counterpartyName: job.counterpartyName,
        endpoint: job.endpoint,
        agentCardHash: job.agentCardHash,
        report: rawReport,
        spend,
        receivedAt: this.now().toISOString(),
      });
      await this.ledger.append({
        at: this.now().toISOString(),
        event: 'report_received',
        handle,
        counterparty: job.counterpartyName,
        endpoint: job.endpoint,
        amount: spend.amount,
        currency: spend.currency,
        outcome: 'completed',
      });
      await this.registry.recordSpend(job.counterpartyName, spend);
      await this.jobs.finish(handle, { status: 'completed', spend, boundedReport: bounded });
      return bounded;
    });
  }

  async rawReport(handleValue: unknown, ownerAuthorized: boolean): Promise<QuotedRawReport> {
    const handle = parseHandle(handleValue);
    return this.membrane.quoteRawReport(handle, await this.jobs.readRawReport(handle), ownerAuthorized);
  }

  async ledgerSummary(): Promise<LedgerSummary> {
    return this.ledger.summary();
  }

  private async submitHire(
    listing: HireListing,
    candidate: CounterpartyCandidate,
    request: ExpertHireRequest,
    budget: HireBudget,
    paymentProvider: PaymentProvider,
  ): Promise<ExpertHireSubmitted> {
    const handle = `hire_${randomUUID()}`;
    const quote = await paymentProvider.quote({
      handle,
      counterparty: listing.name,
      endpoint: listing.endpoint,
      budget,
    });
    const reservation = await paymentProvider.reserveCaps(quote);
    await this.ledger.append({
      ...identityLedgerEntry(this.now, candidate, 'payment_intent'),
      handle,
      amount: quote.amount,
      currency: quote.currency,
      outcome: 'authorized',
    });
    await this.jobs.plan({
      handle,
      counterpartyName: listing.name,
      endpoint: listing.endpoint,
      agentCardHash: candidate.agentCardHash,
      identityStatus: candidate.identity.status,
      amount: quote.amount,
      currency: quote.currency,
    });
    const receipt = await paymentProvider.pay(quote, reservation);
    try {
      const submission = await this.transport.submit({
        endpoint: listing.endpoint,
        brief: request.brief,
        ...(request.context ? { context: request.context } : {}),
      });
      const spend: SpendRecord = {
        handle,
        amount: receipt.amount,
        currency: receipt.currency,
        recordedAt: this.now().toISOString(),
        outcome: 'submitted',
        paymentReference: receipt.paymentReference,
      };
      await this.jobs.submit(handle, submission.remoteTaskId, receipt, spend);
      await this.registry.recordSpend(listing.name, spend);
      await this.ledger.append({
        at: this.now().toISOString(),
        event: 'task_submitted',
        handle,
        counterparty: listing.name,
        endpoint: listing.endpoint,
        identityStatus: candidate.identity.status,
        amount: spend.amount,
        currency: spend.currency,
        outcome: submission.status,
      });
      return {
        status: 'submitted',
        handle,
        counterparty: listing.name,
        identity_status: candidate.identity.status,
        spend: { amount: spend.amount, currency: spend.currency, outcome: 'submitted' },
      };
    } catch (error) {
      const failedSpend = await paymentProvider.settle(receipt, 'failed');
      failedSpend.handle = handle;
      await this.jobs.finish(handle, { status: 'failed', spend: failedSpend });
      await this.registry.recordSpend(listing.name, failedSpend);
      throw error;
    }
  }

  private async settleJob(job: HireJobRecord, outcome: 'completed' | 'failed'): Promise<SpendRecord> {
    if (!this.paymentProvider) {
      throw new HireBrokerError('payment_provider_unavailable', 'Hire Broker payment provider is unavailable.', 503);
    }
    if (!job.paymentReceipt) throw new HireBrokerError('payment_failed', 'Hire job payment receipt is missing.', 503);
    // A report is polled, and every step after settlement can fail on an
    // ordinary condition a counterparty controls. The settlement is recorded
    // against the job before that work runs, so a retry reuses it rather than
    // spending the same receipt again.
    if (job.settledSpend) return job.settledSpend;
    const receipt = job.paymentReceipt;
    // A crash between the provider's commit and `recordSettlement` leaves no
    // settledSpend, and the PaymentProvider contract promises no idempotency,
    // so an unguarded retry executes the external settlement twice. The attempt
    // is written ahead of the call and survives the crash; a standing attempt
    // therefore means "may already have executed" and refuses rather than
    // spending the receipt again. An in-process refusal clears it below,
    // because that error proves the provider decided not to execute.
    if (job.pendingSettlement?.paymentReference === receipt.paymentReference) {
      throw new HireBrokerError(
        'payment_failed',
        'Hire settlement may already have executed and was never recorded; reconcile the payment reference with the provider before retrying.',
        409,
      );
    }
    await this.jobs.beginSettlement(job.handle, {
      paymentReference: receipt.paymentReference,
      outcome,
      attemptedAt: this.now().toISOString(),
    });
    let spend: SpendRecord;
    try {
      spend = await this.paymentProvider.settle(receipt, outcome);
    } catch (error) {
      if (error instanceof HireBrokerError) await this.jobs.clearSettlementAttempt(job.handle);
      throw error;
    }
    spend.handle = job.handle;
    await this.jobs.recordSettlement(job.handle, spend);
    return spend;
  }

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.operationGate;
    let release = () => {};
    this.operationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async recordRefusal(error: unknown): Promise<void> {
    if (!(error instanceof HireBrokerError)) return;
    await this.ledger.append({
      at: this.now().toISOString(),
      event: 'hire_refused',
      reasonCode: error.code,
      outcome: 'refused',
    });
  }
}

interface HireSettlementAttempt {
  paymentReference: string;
  outcome: 'completed' | 'failed';
  attemptedAt: string;
}

interface HireJobRecord {
  handle: string;
  counterpartyName: string;
  endpoint: string;
  agentCardHash: string;
  identityStatus: 'verified' | 'unverified_identity';
  amount: number;
  currency: string;
  status: 'planned' | 'submitted' | 'completed' | 'failed';
  remoteTaskId: string;
  paymentReceipt?: PaymentReceipt;
  spend?: SpendRecord;
  /** The one settlement this receipt is allowed, persisted before report work. */
  settledSpend?: SpendRecord;
  /** Written ahead of the provider call so a crash cannot hide the attempt. */
  pendingSettlement?: HireSettlementAttempt;
  boundedReport?: BoundedConsultantReport;
}

interface HireJobsFile {
  version: 1;
  jobs: HireJobRecord[];
}

export class HireJobStore {
  constructor(
    private readonly path: string,
    private readonly rawReportDir: string,
  ) {}

  async initialize(): Promise<void> {
    await secureDirectory(dirname(this.path));
    await secureDirectory(this.rawReportDir);
    await this.load();
  }

  async plan(input: Omit<HireJobRecord, 'status' | 'remoteTaskId'>): Promise<void> {
    const state = await this.load();
    if (state.jobs.some((job) => job.handle === input.handle)) throw jobsCorrupt();
    state.jobs.push({ ...input, status: 'planned', remoteTaskId: '' });
    await this.save(state);
  }

  async submit(handle: string, remoteTaskId: string, paymentReceipt: PaymentReceipt, spend: SpendRecord): Promise<void> {
    const state = await this.load();
    const job = requiredJob(state, handle);
    if (job.status !== 'planned') throw jobsCorrupt();
    Object.assign(job, { status: 'submitted' as const, remoteTaskId, paymentReceipt, spend });
    await this.save(state);
  }

  async beginSettlement(handle: string, attempt: HireSettlementAttempt): Promise<void> {
    const state = await this.load();
    requiredJob(state, handle).pendingSettlement = attempt;
    await this.save(state);
  }

  async clearSettlementAttempt(handle: string): Promise<void> {
    const state = await this.load();
    delete requiredJob(state, handle).pendingSettlement;
    await this.save(state);
  }

  async recordSettlement(handle: string, spend: SpendRecord): Promise<void> {
    const state = await this.load();
    const job = requiredJob(state, handle);
    job.settledSpend = spend;
    delete job.pendingSettlement;
    await this.save(state);
  }

  async finish(
    handle: string,
    update: Pick<HireJobRecord, 'status' | 'spend'> & { boundedReport?: BoundedConsultantReport },
  ): Promise<void> {
    const state = await this.load();
    const job = requiredJob(state, handle);
    Object.assign(job, update);
    await this.save(state);
  }

  async get(handle: string): Promise<HireJobRecord> {
    return structuredClone(requiredJob(await this.load(), handle));
  }

  async writeRawReport(handle: string, report: string): Promise<void> {
    await atomicWritePrivate(this.rawPath(handle), report);
  }

  async readRawReport(handle: string): Promise<string> {
    await this.get(handle);
    const report = await readPrivateFile(this.rawPath(handle));
    if (report === undefined) throw new HireBrokerError('report_unavailable', 'Raw consultant report is unavailable.', 404);
    return report;
  }

  private rawPath(handle: string): string {
    return join(this.rawReportDir, `${createHash('sha256').update(handle).digest('hex')}.report`);
  }

  private async load(): Promise<HireJobsFile> {
    const raw = await readPrivateFile(this.path);
    if (raw === undefined) return { version: 1, jobs: [] };
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw jobsCorrupt();
      const state = value as HireJobsFile;
      if (state.version !== 1 || !Array.isArray(state.jobs)) throw jobsCorrupt();
      for (const job of state.jobs) validateJob(job);
      if (new Set(state.jobs.map((job) => job.handle)).size !== state.jobs.length) throw jobsCorrupt();
      return structuredClone(state);
    } catch (error) {
      if (error instanceof HireBrokerError) throw error;
      throw jobsCorrupt();
    }
  }

  private async save(state: HireJobsFile): Promise<void> {
    await atomicWritePrivate(this.path, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function confirmationResult(
  candidate: CounterpartyCandidate,
  reasons: string[],
  budget: HireBudget,
): OwnerConfirmationRequired {
  return {
    status: 'needs_owner_confirm',
    confirmation: {
      counterparty: candidate.name,
      endpoint: candidate.endpoint,
      identity_status: candidate.identity.status,
      reasons,
      amount: budget.amount,
      currency: budget.currency,
      ...(candidate.identity.status === 'verified'
        ? {
          identity: {
            chain: candidate.identity.chain,
            agent_id: candidate.identity.agentId,
            owner: candidate.identity.owner,
            token_uri: candidate.identity.tokenURI,
          },
        }
        : {}),
    },
  };
}

function identityLedgerEntry(
  now: () => Date,
  candidate: CounterpartyCandidate,
  event: 'hire_requested' | 'owner_confirmation_required' | 'owner_approved' | 'payment_intent',
) {
  return {
    at: now().toISOString(),
    event,
    counterparty: candidate.name,
    endpoint: candidate.endpoint,
    identityStatus: candidate.identity.status,
    ...(candidate.identity.status === 'verified'
      ? { identityChain: candidate.identity.chain, identityAgentId: candidate.identity.agentId }
      : {}),
  } as const;
}

function parseHandle(value: unknown): string {
  const handle = requiredString(value, 'handle', 100);
  if (!/^hire_[0-9a-f-]{36}$/.test(handle)) {
    throw new HireBrokerError('invalid_request', 'Hire handle is invalid.', 400);
  }
  return handle;
}

function requiredJob(state: HireJobsFile, handle: string): HireJobRecord {
  const job = state.jobs.find((entry) => entry.handle === handle);
  if (!job) throw new HireBrokerError('report_unavailable', 'Hire handle was not found.', 404);
  return job;
}

function validateJob(job: HireJobRecord): void {
  if (!job || typeof job.handle !== 'string'
    || typeof job.counterpartyName !== 'string'
    || typeof job.endpoint !== 'string'
    || !/^[a-f0-9]{64}$/.test(job.agentCardHash)
    || typeof job.amount !== 'number'
    || typeof job.currency !== 'string'
    || !['planned', 'submitted', 'completed', 'failed'].includes(job.status)) {
    throw jobsCorrupt();
  }
}

function jobsCorrupt(): HireBrokerError {
  return new HireBrokerError('registry_corrupt', 'Hire Broker job registry is corrupt.', 503);
}
