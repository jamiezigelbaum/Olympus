// Local, source-neutral Personal-only clearance. No vectors, labels or weights leave this process.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeFileDurablySync, writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { ingestionTurn } from '../control-path-headroom.ts';
import { SNIFFER_RECORD_HELD_CODE_PREFIX, snifferMaterialCarriesSecret } from './sniffer.ts';
import type { SnifferQuestion, TierSnifferStore } from './sniffer-store.ts';
import { tierLedgerIdentityKey, type TierLedger, type TierLedgerRecord, type TierPlacementPlan } from './tier-ledger.ts';
import { TIER_CLASSIFIER_VERSION, PERSONAL_FIRST_REASON, HELD_UNTIL_JUDGED_REASON, contentDigestReason, type TierDecision, type TierSnifferSubject } from './tier-classifier.ts';
import { EMBEDDING_PREFILTER_MODEL_ID, EMBEDDING_PREFILTER_DIMENSIONS, EMBEDDING_PREFILTER_MIN_PER_CLASS,
  trainLogisticSteps, privateProbability, type LogisticModel, type LogisticExample } from './embedding-logistic.ts';

/** The shared store's read-only projection; no source policy or retrieval access. */
interface PrefilterCopy {
  chunks: ReadonlyArray<{ chunkIndex: number; boundedText: string; embeddingInputHash: string | null; mediaPath?: string | null; mediaSha256?: string | null }>;
  vectors: ReadonlyArray<{ chunkIndex: number; modelId: string; contentHash: string; embedding: Uint8Array }>;
}
const PREFIX = 'embedding-prefilter:';
const RECEIPTS = `${PREFIX}clear:`;
const CHECKS = `${PREFIX}check:`;
const WINDOW = 200;
const RETRAIN_MS = 24 * 60 * 60 * 1000;
const MAX_PER_CLASS = 5000;
const TRAINING_SLICE_MS = 200;
const FAILED_RETRY_MS = 3 * 60 * 60 * 1000;
const NEW_VERDICTS = 1000;
const TRAINING = `${PREFIX}training-v1`;
const SCAN = `${PREFIX}training-scan-v1`;
interface TrainingAttempt {
  id: string; revisions: string; judge: string; startedAt: number; elapsedMs: number;
  rows: number; counts: [number, number]; nextAt: number;
  outcome: 'scanning' | 'fitting' | 'trained' | 'too_few' | 'failed';
  reason?: string; version?: string; verdicts?: number;
}
// Only references, beside the source's own ledger. No text or vectors are persisted.
interface TrainingScan {
  attempt: string; after?: TierSnifferSubject; done: boolean; rows: number;
  samples: Array<{ subject: TierSnifferSubject; private: boolean }>;
}
interface TrainingRun {
  id: string; scans: Array<{ member: EmbeddingPrefilter; scan: TrainingScan; dirty: boolean; revision: string }>;
  examples: LogisticExample[]; memberIndex: number; sampleIndex: number;
  fit?: Generator<void, LogisticModel | undefined>;
}
interface SavedModel { revisions: string; version: string; trainedAt: number; judge: string; model: LogisticModel }
interface Receipt { subject: TierSnifferSubject; hash: string; reason: string; original: TierDecision }
interface Audit { misses: boolean[]; stopped: boolean; reason?: 'audit_unreadable' }
import { embeddingPrefilterDirectory } from './tier-ledger-path.ts';
export { embeddingPrefilterDirectory } from './tier-ledger-path.ts';

/** Complete, current own-text vectors only. A partial document never authorizes clearance. */
export function prefilterVector(copy: PrefilterCopy | undefined): number[] | undefined {
  if (!copy || copy.chunks.length === 0 || copy.chunks.some(chunk => chunk.mediaSha256 || chunk.mediaPath)
    || snifferMaterialCarriesSecret(copy.chunks.map(chunk => chunk.boundedText).join(''))) return undefined;
  const vectors = copy.vectors.filter(vector => vector.modelId === EMBEDDING_PREFILTER_MODEL_ID);
  if (vectors.length !== copy.chunks.length) return undefined;
  const mean = new Array<number>(EMBEDDING_PREFILTER_DIMENSIONS).fill(0);
  for (const chunk of copy.chunks) {
    const matching = vectors.filter(vector => vector.chunkIndex === chunk.chunkIndex && vector.contentHash === chunk.embeddingInputHash);
    if (matching.length !== 1 || matching[0]!.embedding.byteLength !== EMBEDDING_PREFILTER_DIMENSIONS * 4) return undefined;
    const bytes = matching[0]!.embedding;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < mean.length; i++) {
      const value = view.getFloat32(i * 4, true);
      if (!Number.isFinite(value)) return undefined;
      mean[i] = mean[i]! + value / vectors.length;
    }
  }
  return mean;
}
function subjectOf(row: TierLedgerRecord): TierSnifferSubject {
  return { provider: row.provider, accountScope: row.accountScope, providerItemId: row.providerItemId,
    ...(row.conversationKey ? { providerConversationId: row.conversationKey } : {}) };
}
function decisionOf(row: TierLedgerRecord): TierDecision {
  return { ...row, state: row.metadataPending || row.contentPending ? 'pending' : 'current', decidedBy: row.decidedBy as TierDecision['decidedBy'], snifferId: 'embedding-prefilter' };
}

export class EmbeddingPrefilter {
  private readonly owner: EmbeddingPrefilter;
  private readonly members = new Set<EmbeddingPrefilter>();
  private get control(): TierLedger { return this.owner.options.stateLedger ?? this.owner.options.ledger; }
  private get audit(): Audit { return this.owner.auditState; }
  private get saved(): SavedModel | undefined { return this.owner.savedModel; }
  private set saved(value: SavedModel | undefined) { this.owner.savedModel = value; }
  private savedModel: SavedModel | undefined;
  private attempt: TrainingAttempt | undefined;
  private training: TrainingRun | undefined;
  get trainingOwner(): EmbeddingPrefilter { return this.owner; }
  private readonly auditState: Audit;
  private readonly path: string;
  constructor(private readonly options: {
    ledger: TierLedger; sniffer: TierSnifferStore; stateLedger?: TierLedger; sharedWith?: EmbeddingPrefilter;
    copyFor: (subject: TierSnifferSubject) => PrefilterCopy | undefined;
    placementFor?: (decision: TierDecision) => TierPlacementPlan;
    enabled?: () => boolean; random?: () => number; now?: () => number;
    monotonicNow?: () => number; log?: (line: string) => void;
  }) {
    this.owner = options.sharedWith?.owner ?? this;
    this.owner.members.add(this);
    this.path = join(embeddingPrefilterDirectory(this.control.dbPath), 'weights.json');
    try {
      const audit = this.control.readMeta(`${PREFIX}audit`);
      this.auditState = audit ? JSON.parse(audit) as Audit : { misses: [], stopped: false };
      if (!Array.isArray(this.auditState.misses) || this.auditState.misses.length > WINDOW
        || this.auditState.misses.some(value => typeof value !== 'boolean') || typeof this.auditState.stopped !== 'boolean') throw new Error();
    } catch {
      this.auditState = { misses: [], stopped: true, reason: 'audit_unreadable' };
      this.control.writeMeta(`${PREFIX}audit`, JSON.stringify(this.auditState));
    }
    if (this.owner !== this) return;
    try {
      const raw = this.control.readMeta(TRAINING);
      if (raw) {
        const attempt = JSON.parse(raw) as TrainingAttempt;
        if (typeof attempt.id !== 'string' || !Array.isArray(attempt.counts) || attempt.counts.length !== 2
          || !Number.isFinite(attempt.nextAt) || !Number.isFinite(attempt.elapsedMs)) throw new Error();
        this.attempt = attempt;
      }
    } catch { this.control.deleteMeta(TRAINING); }
    try {
      if (existsSync(this.path) && !lstatSync(this.path).isSymbolicLink()
        && lstatSync(embeddingPrefilterDirectory(this.control.dbPath)).isDirectory()
        && !lstatSync(embeddingPrefilterDirectory(this.control.dbPath)).isSymbolicLink()) {
        chmodSync(embeddingPrefilterDirectory(this.control.dbPath), 0o700);
        chmodSync(this.path, 0o600);
        this.saved = JSON.parse(readFileSync(this.path, 'utf8')) as SavedModel;
      }
    } catch { this.saved = undefined; }
  }
  private revisions(): string {
    return JSON.stringify([...this.owner.members].map(member => [member.options.ledger.ledgerId(), member.options.ledger.readMeta('embedding-prefilter:training-revision') ?? '0']).sort()) + ':' + (this.control.readMeta(`${PREFIX}withdrawal`) ?? '0');
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private enabled(): boolean { return this.options.enabled?.() !== false; }
  status(): string {
    if (this.audit.reason === 'audit_unreadable') return 'Embedding clearing stopped: its audit state could not be read. Cleared items are returning to the privacy judge.';
    if (this.audit.stopped) return 'Embedding clearing stopped: more than 2% of the last 200 checks were Private. Cleared items are returning to the privacy judge.';
    if (!this.enabled()) return 'Embedding clearing is off.';
    const training = this.owner.attempt;
    const failure = training?.reason === 'scan_failed' ? 'could not read training examples'
      : training?.reason === 'training_failed' ? 'could not fit the model'
      : training?.reason === 'weights_write_failed' ? 'could not save the model' : 'the ledgers or judge changed';
    const detail = training ? ` Training ${training.outcome === 'too_few' ? `found too few examples (needs ${EMBEDDING_PREFILTER_MIN_PER_CLASS} per class)`
      : training.outcome === 'trained' ? `completed with model ${training.version}` : training.outcome === 'failed' ? `failed: ${failure}`
      : training.outcome === 'scanning' ? 'is reading the ledger' : 'is fitting the model'}; read ${training.rows} rows, ${training.counts[0]} Personal and ${training.counts[1]} Private examples in ${Math.round(training.elapsedMs)} ms. Next attempt: ${training.outcome === 'scanning' || training.outcome === 'fitting' ? 'continue next tick' : new Date(training.nextAt).toISOString()}${training.outcome === 'too_few' ? ' or after 1,000 new verdicts, whichever comes first' : ''}.` : '';
    if (!this.saved) return detail ? `Embedding clearing waits.${detail}` : `Embedding clearing waits for ${EMBEDDING_PREFILTER_MIN_PER_CLASS} judge verdicts per class with complete stored vectors.`;
    return `Embedding clearing is on; ${this.audit.misses.length} of 200 spot checks collected.${detail}`;
  }
  setPlacementFor(placementFor: ((decision: TierDecision) => TierPlacementPlan) | undefined): void {
    if (placementFor) this.options.placementFor = placementFor;
    else delete this.options.placementFor;
  }
  /** Recovery cannot depend on the judge being available or approved. */
  recover(): void {
    if (this.audit.stopped || !this.enabled()) for (const member of this.owner.members) member.rollback();
  }
  /** A ledger label is usable only when this judge alone decided the content tier. */
  private trainingExample(row: TierLedgerRecord, judge: string): LogisticExample | undefined {
    if (!row.routed || row.state !== 'current' || row.metadataPending || row.contentPending || !row.contentRead
      || row.metadataTier !== 'private' || !['private', 'secure'].includes(row.contentTier) || row.metadataForced
      || !row.modelId || row.decidedBy === 'owner_rule' || row.decidedBy === 'override'
      || this.options.ledger.getOverride(subjectOf(row)) || this.options.ledger.rejudgeQuestion(subjectOf(row))
      || row.reasons.some(reason => reason.startsWith('metadata:owner_rule:') || reason.startsWith('metadata:floor:')
        || reason.startsWith('metadata:secret:') || reason.startsWith('override:'))) return undefined;
    const prefix = `content:sniffer:${judge}:`;
    let judged = false;
    for (const reason of row.reasons) {
      if (!reason.startsWith('content:')) continue;
      if (reason.startsWith(prefix)) {
        const code = reason.slice(prefix.length);
        if (!code || code.startsWith(SNIFFER_RECORD_HELD_CODE_PREFIX)
          || /(?:^|:)(?:rule|unresolved|fail_safe|injection|undecided)(?::|$)/.test(code)) return undefined;
        judged = true;
      // Known non-raising receipts only. Unknown content reasons are excluded too.
      } else if (!(reason.startsWith('content:sha256:') || reason.startsWith('content:names:')
        || reason.startsWith('content:borderline:') || ['content:text_only', 'content:provenance:model',
          'content:no_raise', HELD_UNTIL_JUDGED_REASON, PERSONAL_FIRST_REASON].includes(reason))) return undefined;
    }
    if (!judged) return undefined;
    const copy = this.options.copyFor(subjectOf(row));
    if (!copy || !row.reasons.includes(contentDigestReason(copy.chunks.map(chunk => chunk.boundedText).join('')))) return undefined;
    const vector = prefilterVector(copy);
    return vector && Math.hypot(...vector) > 0 ? { vector, private: row.contentTier === 'secure' } : undefined;
  }
  private verdictCount(): number {
    return [...this.members].reduce((count, member) => count + member.options.sniffer.verdictCount(), 0);
  }
  private finishTraining(attempt: TrainingAttempt, outcome: 'trained' | 'too_few' | 'failed', reason?: string): void {
    // Read the watermark before publishing a completed outcome; failure must remain retryable.
    const verdicts = outcome === 'too_few' ? this.verdictCount() : undefined;
    attempt.outcome = outcome;
    if (reason) attempt.reason = reason;
    attempt.nextAt = this.now() + (reason === 'ledger_or_judge_changed' ? 0 : outcome === 'failed' ? FAILED_RETRY_MS : RETRAIN_MS);
    if (verdicts !== undefined) attempt.verdicts = verdicts;
    this.training = undefined;
  }
  private logTraining(attempt: TrainingAttempt): void {
    // Never log exceptions, subject ids, paths, content, vectors or judge category strings.
    (this.options.log ?? console.log)(`[olympus:embedding-prefilter] rows_read=${attempt.rows} personal=${attempt.counts[0]} private=${attempt.counts[1]} outcome=${attempt.outcome}${attempt.reason ? ` reason=${attempt.reason}` : ''}${attempt.version ? ` model_version=${attempt.version}` : ''} elapsed_ms=${Math.round(attempt.elapsedMs)} next_attempt=${new Date(attempt.nextAt).toISOString()}${attempt.outcome === 'too_few' ? ' or_1000_new_verdicts' : ''}`);
  }
  /** Cooperative 200 ms per tick, including scan and fit; one synchronous unit may overrun. */
  async prepare(judge: string): Promise<void> {
    if (this.owner !== this) return this.owner.prepare(judge);
    if (this.audit.stopped || !this.enabled()) { for (const member of this.members) member.rollback(); return; }
    const clock = this.options.monotonicNow ?? (() => performance.now());
    const started = clock();
    const deadline = started + TRAINING_SLICE_MS;
    let attempt = this.attempt;
    const finishedAtStart = attempt && ['trained', 'too_few', 'failed'].includes(attempt.outcome) ? attempt.id : undefined;
    // A failure before revisions could be read must still honor its retry deadline.
    if (attempt?.outcome === 'failed' && !attempt.revisions && this.now() < attempt.nextAt) return;
    let stage = 'scan_failed';
    try {
      const revisions = this.revisions();
      if (this.saved && (this.saved.judge !== judge || !/^[0-9a-f-]{36}$/.test(this.saved.version) || !Number.isFinite(this.saved.trainedAt)
        || this.saved.revisions !== revisions || !existsSync(this.path)
        || privateProbability(this.saved.model, [1, ...new Array(EMBEDDING_PREFILTER_DIMENSIONS - 1).fill(0)]) === undefined)) {
        if (existsSync(this.path)) removeFileDurablySync(this.path);
        this.saved = undefined;
        if (attempt?.outcome === 'trained') attempt = this.attempt = undefined;
        this.training = undefined;
      }
      if (attempt && (attempt.revisions !== revisions || attempt.judge !== judge)) {
        if (attempt.outcome === 'scanning' || attempt.outcome === 'fitting') {
          this.finishTraining(attempt, 'failed', 'ledger_or_judge_changed');
          this.logTraining(attempt);
        }
        attempt = this.attempt = undefined;
        this.training = undefined;
      }
      if (!attempt && this.saved && this.now() - this.saved.trainedAt < RETRAIN_MS) return;
      if (attempt && ['trained', 'too_few', 'failed'].includes(attempt.outcome)) {
        if (this.now() < attempt.nextAt
          && !(attempt.outcome === 'too_few' && this.verdictCount() >= (attempt.verdicts ?? 0) + NEW_VERDICTS)) return;
        attempt = undefined;
      }
      if (!attempt) {
        attempt = this.attempt = { id: randomUUID(), revisions, judge, startedAt: this.now(), elapsedMs: 0,
          rows: 0, counts: [0, 0], nextAt: this.now(), outcome: 'scanning' };
        this.training = undefined;
      }
      if (!this.training || this.training.id !== attempt.id) {
        const scans = [...this.members].map(member => {
          const raw = member.options.ledger.readMeta(SCAN);
          const previous = raw ? JSON.parse(raw) as TrainingScan : undefined;
          const scan = previous?.attempt === attempt!.id ? previous : { attempt: attempt!.id, done: false, rows: 0, samples: [] };
          if (!Array.isArray(scan.samples) || scan.samples.length > MAX_PER_CLASS * 2 || !Number.isSafeInteger(scan.rows)) throw new Error();
          return { member, scan, dirty: false, revision: member.options.ledger.readMeta(`${PREFIX}training-revision`) ?? '0' };
        });
        this.training = { id: attempt.id, scans, examples: [], memberIndex: 0, sampleIndex: 0 };
        // A restart resumes the durable scan, then rehydrates references and refits in slices.
        attempt.counts = [0, 0];
        attempt.rows = 0;
        for (const { scan } of scans) {
          attempt.rows += scan.rows;
          for (const sample of scan.samples) attempt.counts[Number(sample.private)]!++;
        }
      }
      const run = this.training;
      let worked = false;
      const hasTime = () => !worked || clock() < deadline;
      for (const entry of run.scans) {
        const { member, scan } = entry;
        while (attempt.outcome !== 'fitting' && !scan.done && !attempt.counts.every(count => count >= MAX_PER_CLASS) && hasTime()) {
          const rows = member.options.ledger.listItemWindow({ ...(scan.after ? { after: scan.after } : {}), limit: 32 });
          if (!rows.length) { scan.done = true; entry.dirty = true; break; }
          for (const row of rows) {
            if (!hasTime()) break;
            worked = true;
            entry.dirty = true;
            scan.after = subjectOf(row); scan.rows++; attempt.rows++;
            const index = Number(row.contentTier === 'secure');
            if (attempt.counts[index]! < MAX_PER_CLASS) {
              const example = member.trainingExample(row, judge);
              if (example) { scan.samples.push({ subject: subjectOf(row), private: example.private }); attempt.counts[Number(example.private)]!++; }
            }
            await ingestionTurn();
          }
        }
        if (!hasTime()) break;
      }
      if (attempt.outcome === 'fitting' || run.scans.every(({ scan }) => scan.done) || attempt.counts.every(count => count >= MAX_PER_CLASS)) {
        if (attempt.counts.some(count => count < EMBEDDING_PREFILTER_MIN_PER_CLASS)) this.finishTraining(attempt, 'too_few');
        else {
          stage = 'training_failed';
          attempt.outcome = 'fitting';
          // Recheck references against current decisions/copies; never persist training vectors.
          while (run.memberIndex < run.scans.length && hasTime()) {
            const { member, scan } = run.scans[run.memberIndex]!;
            if (run.sampleIndex >= scan.samples.length) { run.memberIndex++; run.sampleIndex = 0; continue; }
            worked = true;
            const sample = scan.samples[run.sampleIndex++]!;
            const row = member.options.ledger.getCurrent(sample.subject);
            const example = row && member.trainingExample(row, judge);
            if (example) run.examples.push(example);
            await ingestionTurn();
          }
          if (run.memberIndex === run.scans.length) {
            if (!run.fit) {
              attempt.counts = [0, 0];
              for (const example of run.examples) attempt.counts[Number(example.private)]!++;
              run.fit = trainLogisticSteps(run.examples);
            }
            while (hasTime()) {
              worked = true;
              const step = run.fit.next();
              if (step.done) {
                if (!step.value) { this.finishTraining(attempt, 'too_few'); break; }
                stage = 'weights_write_failed';
                if (this.control.dbPath === ':memory:') throw new Error();
                const directory = embeddingPrefilterDirectory(this.control.dbPath);
                if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error();
                if (attempt.revisions !== this.revisions()) break;
                mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
                const saved: SavedModel = { model: step.value, judge, revisions, trainedAt: this.now(), version: randomUUID() };
                writePrivateFileAtomicSync(this.path, JSON.stringify(saved));
                this.saved = saved; attempt.version = saved.version;
                this.finishTraining(attempt, 'trained');
                break;
              }
              await ingestionTurn();
            }
          }
        }
      }
      // Every asynchronous yield can let a withdrawal run. Discard the entire attempt.
      if (attempt.revisions !== this.revisions()) {
        if (existsSync(this.path)) removeFileDurablySync(this.path);
        this.saved = undefined;
        this.finishTraining(attempt, 'failed', 'ledger_or_judge_changed');
      }
      for (const entry of run.scans) {
        if (entry.dirty && attempt.revisions === this.revisions()) {
          if (!entry.member.options.ledger.writeEmbeddingTrainingScan(JSON.stringify(entry.scan), entry.revision)) {
            this.finishTraining(attempt, 'failed', 'ledger_or_judge_changed');
            break;
          }
          entry.dirty = false;
        }
      }
    } catch {
      if (!attempt) attempt = this.attempt = { id: randomUUID(), judge, revisions: '', startedAt: this.now(), elapsedMs: 0, rows: 0, counts: [0, 0], nextAt: this.now(), outcome: 'scanning' };
      if (attempt.outcome === 'scanning' || attempt.outcome === 'fitting') this.finishTraining(attempt, 'failed', stage);
    }
    if (attempt && attempt.id !== finishedAtStart) {
      attempt.elapsedMs += clock() - started;
      this.control.writeMeta(TRAINING, JSON.stringify(attempt));
      if (['trained', 'too_few', 'failed'].includes(attempt.outcome)) this.logTraining(attempt);
    }
  }
  /** Called even for settled queue entries: they carry the rollback material until a good check. */
  retained(question: SnifferQuestion): boolean {
    const raw = this.options.ledger.readMeta(RECEIPTS + tierLedgerIdentityKey(question));
    if (!raw) return false;
    const receipt = JSON.parse(raw) as Receipt;
    const row = this.options.ledger.getCurrent(question);
    if (receipt.hash === question.materialHash && row?.reasons.includes(receipt.reason)) {
      // Dispatch an open rejudge without discarding rollback before its verdict lands.
      return !this.options.ledger.rejudgeQuestion(question);
    }
    this.options.ledger.deleteMeta(RECEIPTS + tierLedgerIdentityKey(question));
    return false;
  }
  tryClear(question: SnifferQuestion, judge: string): boolean {
    if (!this.enabled() || this.audit.stopped || !this.saved || !existsSync(this.path) || this.saved.revisions !== this.revisions() || this.saved.judge !== judge || question.pass !== 'content') return false;
    const row = this.options.ledger.getCurrent(question);
    if (!row || row.state !== 'pending' || row.metadataPending || !row.contentPending || !row.contentRead
      || row.metadataTier !== 'private' || row.contentTier !== 'private' || row.metadataForced
      || row.decidedBy === 'override' || row.decidedBy === 'owner_rule' || this.options.ledger.getOverride(question)
      || row.reasons.some(reason => reason.startsWith('metadata:owner_rule:'))
      || this.options.ledger.rejudgeQuestion(question) || this.options.sniffer.questionFor(question, 'metadata')) return false;
    // An existing audit selection survives retry/restart and never takes a cache shortcut.
    const checkKey = this.checkKey(question);
    if (this.isSpotCheck(question)) return false;
    const copy = this.options.copyFor(question);
    if (!copy || !row.reasons.includes(contentDigestReason(copy.chunks.map(chunk => chunk.boundedText).join('')))) return false;
    const vector = prefilterVector(copy);
    const probability = vector ? privateProbability(this.saved.model, vector) : undefined;
    if (probability === undefined || probability >= 0.05) return false;
    if ((this.options.random?.() ?? Math.random()) < 0.05) {
      this.options.ledger.writeMeta(checkKey, JSON.stringify({ hash: question.materialHash, token: randomUUID() })); return false;
    }
    const reason = `content:embedding_prefilter:${this.saved.version}:${probability.toFixed(8)}`;
    const original = decisionOf(row);
    // A failed audit must hold the item even if its original queue used Personal-first placement.
    original.reasons = [...original.reasons.filter(code => code !== PERSONAL_FIRST_REASON), HELD_UNTIL_JUDGED_REASON];
    const receipt: Receipt = { subject: question, hash: question.materialHash, reason, original };
    // Copy identity only; queued text remains in the existing owner-only sniffer queue.
    receipt.subject = { provider: question.provider, accountScope: question.accountScope, providerItemId: question.providerItemId,
      ...(question.providerConversationId ? { providerConversationId: question.providerConversationId } : {}) };
    const cleared = this.options.ledger.clearEmbeddingQuestion(question, {
      reason, receiptKey: RECEIPTS + tierLedgerIdentityKey(question), receipt: JSON.stringify(receipt), modelId: EMBEDDING_PREFILTER_MODEL_ID,
      questionStillCurrent: () => this.options.sniffer.questionFor(question, 'content')?.materialHash === question.materialHash,
      ...(this.options.placementFor ? { placementFor: this.options.placementFor } : {}),
    });
    if (cleared) this.options.ledger.markJudged(question, { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: judge });
    return cleared;
  }
  private checkKey(question: TierSnifferSubject): string {
    return CHECKS + tierLedgerIdentityKey(question);
  }
  private selection(question: SnifferQuestion): { hash: string; token: string } | undefined {
    const raw = this.options.ledger.readMeta(this.checkKey(question));
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as { hash: string; token: string };
      return value.hash === question.materialHash && /^[0-9a-f-]{36}$/.test(value.token) ? value : undefined;
    } catch { return undefined; }
  }
  isSpotCheck(question: SnifferQuestion): boolean {
    return question.pass === 'content' && this.selection(question) !== undefined;
  }
  observe(question: SnifferQuestion, isPrivate: boolean): void {
    const selection = question.pass === 'content' ? this.selection(question) : undefined;
    if (!selection) return;
    // Only an opaque token crosses into install state. Source deletion removes the selection itself.
    const observedKey = `${PREFIX}observed:${selection.token}`;
    if (!this.control.readMeta(observedKey)) {
      this.audit.misses.push(isPrivate);
      this.audit.misses = this.audit.misses.slice(-WINDOW);
      this.audit.stopped ||= this.audit.misses.filter(Boolean).length > 4;
      // Commit audit and deduplication before deleting the source-owned selection.
      this.control.writeMetaBatch([[`${PREFIX}audit`, JSON.stringify(this.audit)], [observedKey, '1']]);
    }
    this.options.ledger.deleteMeta(this.checkKey(question));
    this.control.deleteMeta(observedKey);
    if (this.audit.stopped) for (const member of this.owner.members) member.rollback();
    else if (this.audit.misses.length === WINDOW) for (const member of this.owner.members) member.acceptClearances();
  }
  private acceptClearances(): void {
      for (const entry of this.options.ledger.metaEntries(RECEIPTS)) {
        const receipt = JSON.parse(entry.value) as Receipt;
        // An open rejudge still needs rollback even after a healthy audit.
        if (this.options.ledger.rejudgeQuestion(receipt.subject)) continue;
        this.options.ledger.deleteMeta(entry.key);
        this.options.sniffer.deleteQuestion(receipt.subject, 'content', receipt.hash);
      }
  }
  private rollback(): void {
    for (const entry of this.options.ledger.metaEntries(RECEIPTS)) {
      const receipt = JSON.parse(entry.value) as Receipt;
      if (this.options.ledger.revokeEmbeddingClearance(receipt.subject, receipt.reason, receipt.original, this.options.placementFor)) {
        this.options.ledger.deleteMeta(entry.key);
      }
    }
  }
}
