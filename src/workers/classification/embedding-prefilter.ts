// Local, source-neutral Personal-only clearance. No vectors, labels or weights leave this process.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { removeFileDurablySync, writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { ingestionTurn } from '../control-path-headroom.ts';
import { SNIFFER_RECORD_HELD_CODE_PREFIX, snifferMaterialCarriesSecret } from './sniffer.ts';
import type { SnifferQuestion, TierSnifferStore } from './sniffer-store.ts';
import { copyServingLayer, tierLedgerIdentityKey, type TierLedger, type TierLedgerRecord, type TierPlacementPlan } from './tier-ledger.ts';
import { TIER_CLASSIFIER_VERSION, PERSONAL_FIRST_REASON, HELD_UNTIL_JUDGED_REASON, contentDigestReason, contentJudgeVerdictReason, normalizedContentHash, type TierDecision, type TierSnifferSubject } from './tier-classifier.ts';
import { EMBEDDING_PREFILTER_MODEL_ID, EMBEDDING_PREFILTER_DIMENSIONS, EMBEDDING_PREFILTER_MIN_PER_CLASS,
  trainLogisticSteps, privateProbability, type LogisticModel, type LogisticExample } from './embedding-logistic.ts';

/** The shared store's read-only projection; no source policy or retrieval access. */
export interface PrefilterCopy {
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
  labelVersion: 3;
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
interface TrainingExample extends LogisticExample { current: (checkLedger: boolean) => boolean }
interface TrainingRun {
  id: string; scans: Array<{ member: EmbeddingPrefilter; scan: TrainingScan; dirty: boolean; revision: string }>;
  scanIndex: number; examples: TrainingExample[]; memberIndex: number; sampleIndex: number;
  fit?: Generator<void, LogisticModel | undefined>;
  model?: LogisticModel;
  finalValidation?: { index: number; markers: string };
  markers?: string[];
  validationIndex: number; validationRemaining: number;
}
interface SavedModel { revisions: string; version: string; trainedAt: number; judge: string; model: LogisticModel }
interface Receipt { subject: TierSnifferSubject; hash: string; reason: string; original: TierDecision }
interface Audit { misses: boolean[]; stopped: boolean; reason?: 'audit_unreadable' }
import { embeddingPrefilterDirectory } from './tier-ledger-path.ts';
export { embeddingPrefilterDirectory } from './tier-ledger-path.ts';

/** Complete, current own-text vectors only. A partial document never authorizes clearance. */
export const PREFILTER_TRAINING_REJECTIONS = [
  'not_routed', 'not_current', 'metadata_pending', 'content_pending', 'content_unread',
  'metadata_tier', 'content_tier', 'metadata_forced', 'model_missing', 'owner_decision',
  'override_decision', 'item_override', 'rejudge_open', 'metadata_owner_rule', 'metadata_floor',
  'metadata_secret', 'override_reason', 'judge_code_empty', 'judge_code_held', 'judge_code_unsafe',
  'judge_duplicate', 'content_reason_unknown', 'judge_missing', 'copy_missing', 'digest_missing',
  'verdict_missing', 'legacy_store_missing', 'legacy_verdict_missing', 'legacy_verdict_ambiguous',
  'legacy_verdict_time', 'legacy_verdict_tier', 'legacy_verdict_content', 'legacy_verdict_unreadable',
  'chunks_empty', 'media_present', 'secret_material', 'vector_count',
  'vector_match', 'vector_bytes', 'vector_nonfinite', 'vector_zero',
  'judge_id_invalid', 'judge_model_mismatch',
] as const;
export type PrefilterTrainingRejection = typeof PREFILTER_TRAINING_REJECTIONS[number];
type Reject = (reason: PrefilterTrainingRejection) => undefined;

export function prefilterVector(copy: PrefilterCopy | undefined, reject: Reject = () => undefined): number[] | undefined {
  if (!copy) return reject('copy_missing');
  if (copy.chunks.length === 0) return reject('chunks_empty');
  if (copy.chunks.some(chunk => chunk.mediaSha256 || chunk.mediaPath)) return reject('media_present');
  if (snifferMaterialCarriesSecret(copy.chunks.map(chunk => chunk.boundedText).join(''))) return reject('secret_material');
  const vectors = copy.vectors.filter(vector => vector.modelId === EMBEDDING_PREFILTER_MODEL_ID);
  if (vectors.length !== copy.chunks.length) return reject('vector_count');
  const mean = new Array<number>(EMBEDDING_PREFILTER_DIMENSIONS).fill(0);
  for (const chunk of copy.chunks) {
    const matching = vectors.filter(vector => vector.chunkIndex === chunk.chunkIndex && vector.contentHash === chunk.embeddingInputHash);
    if (matching.length !== 1) return reject('vector_match');
    if (matching[0]!.embedding.byteLength !== EMBEDDING_PREFILTER_DIMENSIONS * 4) return reject('vector_bytes');
    const bytes = matching[0]!.embedding;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < mean.length; i++) {
      const value = view.getFloat32(i * 4, true);
      if (!Number.isFinite(value)) return reject('vector_nonfinite');
      mean[i] = mean[i]! + value / vectors.length;
    }
  }
  return mean;
}
function copyFingerprint(copy: PrefilterCopy): string {
  const hash = createHash('sha256').update(JSON.stringify(copy.chunks));
  for (const vector of copy.vectors) {
    hash.update(JSON.stringify([vector.chunkIndex, vector.modelId, vector.contentHash, vector.embedding.byteLength]));
    hash.update(vector.embedding);
  }
  return hash.digest('hex');
}
function subjectOf(row: TierLedgerRecord): TierSnifferSubject {
  return { provider: row.provider, accountScope: row.accountScope, providerItemId: row.providerItemId,
    ...(row.conversationKey ? { providerConversationId: row.conversationKey } : {}) };
}
function decisionOf(row: TierLedgerRecord): TierDecision {
  return { ...row, state: row.metadataPending || row.contentPending ? 'pending' : 'current', decidedBy: row.decidedBy as TierDecision['decidedBy'], snifferId: 'embedding-prefilter' };
}

/** Same serving-copy choice for training and offline inspection; never fall back for a routed row. */
export function prefilterTrainingCopy(subject: TierSnifferSubject,
  ledger: Pick<TierLedger, 'copies' | 'getCurrent'>,
  setCopyFor: ((corpusId: string) => PrefilterCopy | undefined) | undefined,
  legacyCopyFor: () => PrefilterCopy | undefined,
): PrefilterCopy | undefined {
  const serving = copyServingLayer(ledger.copies(subject), 'content');
  if (setCopyFor && serving) return setCopyFor(serving.corpusId);
  if (ledger.getCurrent(subject)?.routed) return undefined;
  return legacyCopyFor();
}

/** Shared by live training and the counts-only diagnostic. First failure wins. */
export function prefilterTrainingExample(row: TierLedgerRecord, judge: string, options: {
  ledger: Pick<TierLedger, 'getOverride' | 'rejudgeQuestion'>;
  sniffer?: Pick<TierSnifferStore, 'trainingVerdict'>;
  copyFor: (subject: TierSnifferSubject) => PrefilterCopy | undefined;
}, reject: Reject = () => undefined): { vector: number[]; copy: PrefilterCopy; private: boolean; provenance: 'judge_receipt' | 'legacy_sniffer' } | undefined {
  if (!row.routed) return reject('not_routed');
  if (row.state !== 'current') return reject('not_current');
  if (row.metadataPending) return reject('metadata_pending');
  if (row.contentPending) return reject('content_pending');
  if (!row.contentRead) return reject('content_unread');
  if (row.metadataTier !== 'private') return reject('metadata_tier');
  if (!['private', 'secure'].includes(row.contentTier)) return reject('content_tier');
  if (row.metadataForced) return reject('metadata_forced');
  if (!row.modelId) return reject('model_missing');
  if (row.decidedBy === 'owner_rule') return reject('owner_decision');
  if (row.decidedBy === 'override') return reject('override_decision');
  if (options.ledger.getOverride(subjectOf(row))) return reject('item_override');
  if (options.ledger.rejudgeQuestion(subjectOf(row))) return reject('rejudge_open');
  for (const [prefix, reason] of [
    ['metadata:owner_rule:', 'metadata_owner_rule'], ['metadata:floor:', 'metadata_floor'],
    ['metadata:secret:', 'metadata_secret'], ['override:', 'override_reason'],
  ] as const) if (row.reasons.some(value => value.startsWith(prefix))) return reject(reason);
  // snifferId = <lane>:<prompt-version>.m<sha256(cache-model-id)[0:16]>.
  // Prompt/template/owner-context changes do not change the judge's model.
  const model = /^[^:]+:[^:]+\.m([0-9a-f]{16})$/.exec(judge)?.[1];
  if (!model) return reject('judge_id_invalid');
  let judged: string | undefined;
  for (const reason of row.reasons) {
    if (!reason.startsWith('content:')) continue;
    if (reason.startsWith('content:sniffer:')) {
      const verdict = /^content:sniffer:[^:]+:[^:]+\.m([0-9a-f]{16}):(.*)$/.exec(reason);
      if (!verdict) return reject('judge_id_invalid');
      if (verdict[1] !== model) return reject('judge_model_mismatch');
      const code = verdict[2]!;
      if (!code) return reject('judge_code_empty');
      if (code.startsWith(SNIFFER_RECORD_HELD_CODE_PREFIX)) return reject('judge_code_held');
      if (/(?:^|:)(?:rule|unresolved|fail_safe|injection|undecided)(?::|$)/.test(code)) return reject('judge_code_unsafe');
      if (judged) return reject('judge_duplicate');
      judged = reason;
    // Known non-raising receipts only. Unknown content reasons are excluded too.
    } else if (!(reason.startsWith('content:judge_verdict:') || reason.startsWith('content:sha256:') || reason.startsWith('content:names:')
      || reason.startsWith('content:borderline:') || ['content:text_only', 'content:provenance:model',
        'content:no_raise', HELD_UNTIL_JUDGED_REASON, PERSONAL_FIRST_REASON].includes(reason))) return reject('content_reason_unknown');
  }
  if (!judged) return reject('judge_missing');
  const copy = options.copyFor(subjectOf(row));
  if (!copy) return reject('copy_missing');
  const digest = contentDigestReason(copy.chunks.map(chunk => chunk.boundedText).join(''));
  if (!row.reasons.includes(digest)) return reject('digest_missing');
  let provenance: 'judge_receipt' | 'legacy_sniffer' = 'judge_receipt';
  if (!row.reasons.includes(contentJudgeVerdictReason(judged, row.contentTier, digest))) {
    // A mismatched modern receipt is evidence against the label, never a legacy row.
    if (row.reasons.some(reason => reason.startsWith('content:judge_verdict:'))) return reject('verdict_missing');
    // The content-pass reason and matching ledger digest prove an old label
    // without requiring a surviving subject-cache entry. A metadata verdict
    // cannot supply that proof. Keep the cache's exact content binding when
    // it could explain a retained Private tier after a names-only raise.
    const metadataJudge = row.reasons.some(reason => reason.startsWith('metadata:sniffer:'));
    if (metadataJudge && !options.sniffer) return reject('legacy_store_missing');
    let verdict;
    try { verdict = options.sniffer?.trainingVerdict(subjectOf(row), row.modelId); }
    catch { return reject('legacy_verdict_unreadable'); }
    if (metadataJudge || (verdict && row.contentTier === 'secure')) {
      if (!verdict) return reject('legacy_verdict_missing');
      if (verdict.ambiguous) return reject('legacy_verdict_ambiguous');
      const time = Date.parse(verdict.decidedAt), decisionTime = Date.parse(row.decidedAt);
      if (!Number.isFinite(time) || !Number.isFinite(decisionTime) || time > decisionTime) return reject('legacy_verdict_time');
      if ((verdict.tier === 'personal' ? 'private' : verdict.tier === 'private' ? 'secure' : undefined) !== row.contentTier)
        return reject('legacy_verdict_tier');
      if (verdict.contentHash !== normalizedContentHash(copy.chunks.map(chunk => chunk.boundedText).join('')))
        return reject('legacy_verdict_content');
    }
    provenance = 'legacy_sniffer';
  }
  const vector = prefilterVector(copy, reject);
  if (!vector) return undefined;
  if (Math.hypot(...vector) === 0) return reject('vector_zero');
  return { vector, copy, private: row.contentTier === 'secure', provenance };
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
  private preparing: Promise<void> | undefined;
  get trainingPending(): boolean {
    return this.owner.enabled() && !this.owner.audit.stopped
      && (this.owner.attempt?.outcome === 'scanning' || this.owner.attempt?.outcome === 'fitting');
  }
  get trainingOwner(): EmbeddingPrefilter { return this.owner; }
  private readonly auditState: Audit;
  private readonly path: string;
  constructor(private readonly options: {
    ledger: TierLedger; sniffer: TierSnifferStore; stateLedger?: TierLedger; sharedWith?: EmbeddingPrefilter;
    copyFor: (subject: TierSnifferSubject) => PrefilterCopy | undefined;
    copyChangeMarker: () => string;
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
  private trainingFingerprint(row: TierLedgerRecord): string {
    const subject = subjectOf(row);
    return createHash('sha256').update(JSON.stringify([row, this.options.ledger.copies(subject),
      this.options.ledger.getOverride(subject), this.options.ledger.rejudgeQuestion(subject),
      row.modelId && !row.reasons.some(reason => reason.startsWith('content:judge_verdict:'))
        ? this.options.sniffer.trainingVerdict(subject, row.modelId) : null])).digest('hex');
  }
  /** A ledger label is usable only when this judge alone decided the content tier. */
  private trainingExample(row: TierLedgerRecord, judge: string): TrainingExample | undefined {
    const eligible = prefilterTrainingExample(row, judge, this.options);
    if (!eligible) return undefined;
    const { vector, copy } = eligible;
    const fingerprint = this.trainingFingerprint(row);
    const copied = copyFingerprint(copy);
    const subject = subjectOf(row);
    return { vector, private: row.contentTier === 'secure', current: checkLedger => {
      const currentCopy = this.options.copyFor(subject);
      if (!currentCopy || copyFingerprint(currentCopy) !== copied) return false;
      if (!checkLedger) return true;
      const current = this.options.ledger.getCurrent(subject);
      return !!current && this.trainingFingerprint(current) === fingerprint;
    } };
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
  /** Serialize tick and idle work; each slice yields and can be interrupted between units. */
  async prepare(judge: string, shouldYield: () => boolean = () => false): Promise<void> {
    if (this.owner !== this) return this.owner.prepare(judge, shouldYield);
    if (this.preparing) return this.preparing;
    if (shouldYield()) return;
    const pending = this.prepareSlice(judge, shouldYield);
    this.preparing = pending;
    try { await pending; } finally { this.preparing = undefined; }
  }
  /** Cooperative 200 ms including scan, fit and validation; one synchronous unit may overrun. */
  private async prepareSlice(judge: string, shouldYield: () => boolean): Promise<void> {
    if (this.audit.stopped || !this.enabled()) { for (const member of this.members) member.rollback(); return; }
    const clock = this.options.monotonicNow ?? (() => performance.now());
    const started = clock();
    const deadline = started + TRAINING_SLICE_MS;
    let attempt = this.attempt;
    // Old scans excluded other prompts and required a surviving legacy cache.
    if (attempt && attempt.labelVersion !== 3) { attempt = this.attempt = undefined; this.training = undefined; }
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
        attempt = this.attempt = { labelVersion: 3, id: randomUUID(), revisions, judge, startedAt: this.now(), elapsedMs: 0,
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
        this.training = { id: attempt.id, scans, scanIndex: 0, examples: [], memberIndex: 0, sampleIndex: 0, validationIndex: 0, validationRemaining: 0 };
        // A restart resumes the durable scan, then rehydrates references and refits in slices.
        attempt.counts = [0, 0];
        attempt.rows = 0;
        for (const { scan } of scans) {
          attempt.rows += scan.rows;
          for (const sample of scan.samples) attempt.counts[Number(sample.private)]!++;
        }
      }
      const run = this.training;
      const markers = run.scans.map(({ member }) => member.options.ledger.changeMarker());
      const ledgerChanged = !run.markers || markers.some((marker, index) => marker !== run.markers![index]);
      run.markers = markers;
      if (ledgerChanged) run.validationRemaining = run.examples.length;
      let worked = false;
      const hasTime = () => !shouldYield() && (!worked || clock() < deadline);
      const full = () => attempt!.counts.every(count => count >= MAX_PER_CLASS);
      // One bounded window per ledger, rotating even when a slice ends mid-window.
      // No source-specific ranking or extra full-ledger candidate count is needed.
      while (attempt.outcome !== 'fitting' && !full() && run.scans.some(({ scan }) => !scan.done) && hasTime()) {
        const entry = run.scans[run.scanIndex]!;
        run.scanIndex = (run.scanIndex + 1) % run.scans.length;
        const { member, scan } = entry;
        if (scan.done) continue;
        const rows = member.options.ledger.listItemWindow({ ...(scan.after ? { after: scan.after } : {}),
          limit: Math.min(32, MAX_PER_CLASS * 2 - attempt.counts[0] - attempt.counts[1]) });
        if (!rows.length) { scan.done = true; entry.dirty = true; continue; }
        for (const row of rows) {
          if (!hasTime() || full()) break;
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
            // Circular early-abort checks get half the tick; unrelated writes
            // request another full ledger cycle without rewinding or starving fit.
            const validationDeadline = started + TRAINING_SLICE_MS / 2;
            let checked = 0;
            while (!run.model && checked < run.examples.length && !shouldYield() && clock() < validationDeadline) {
              worked = true;
              if (!run.examples[run.validationIndex]!.current(run.validationRemaining > 0)) {
                stage = 'ledger_or_judge_changed';
                throw new Error();
              }
              run.validationIndex = (run.validationIndex + 1) % run.examples.length;
              run.validationRemaining = Math.max(0, run.validationRemaining - 1);
              checked++;
              await ingestionTurn();
            }
            while (!run.model && hasTime()) {
              worked = true;
              const step = run.fit.next();
              if (step.done) {
                if (!step.value) { this.finishTraining(attempt, 'too_few'); break; }
                run.model = step.value;
                break;
              }
              await ingestionTurn();
            }
            if (run.model) {
              const changeMarkers = () => JSON.stringify(run.scans.map(({ member }) => [
                member.options.ledger.changeMarker(true), member.options.copyChangeMarker(), member.options.sniffer.changeMarker(),
              ]));
              const currentMarkers = changeMarkers();
              if (!run.finalValidation || run.finalValidation.markers !== currentMarkers) {
                run.finalValidation = { index: 0, markers: currentMarkers };
              }
              const validation = run.finalValidation;
              while (validation.index < run.examples.length && hasTime()) {
                worked = true;
                if (!run.examples[validation.index++]!.current(true)) {
                  stage = 'ledger_or_judge_changed';
                  throw new Error();
                }
                await ingestionTurn();
              }
              // No yield between the marker/revision fence and publication. A write
              // during any validation slice requires a fresh pass, including copies.
              if (validation.index === run.examples.length && hasTime()
                && validation.markers === changeMarkers() && attempt.revisions === this.revisions()) {
                stage = 'weights_write_failed';
                if (this.control.dbPath === ':memory:') throw new Error();
                const directory = embeddingPrefilterDirectory(this.control.dbPath);
                if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error();
                mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
                const saved: SavedModel = { model: run.model, judge, revisions, trainedAt: this.now(), version: randomUUID() };
                writePrivateFileAtomicSync(this.path, JSON.stringify(saved));
                this.saved = saved; attempt.version = saved.version;
                this.finishTraining(attempt, 'trained');
              }
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
      // Yields may let a decision writer run inside this tick as well.
      if (run.scans.some(({ member }, index) => member.options.ledger.changeMarker() !== markers[index])) {
        run.validationRemaining = run.examples.length;
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
      if (!attempt) attempt = this.attempt = { labelVersion: 3, id: randomUUID(), judge, revisions: '', startedAt: this.now(), elapsedMs: 0, rows: 0, counts: [0, 0], nextAt: this.now(), outcome: 'scanning' };
      if (attempt.outcome === 'scanning' || attempt.outcome === 'fitting') this.finishTraining(attempt, 'failed', stage);
    }
    if (attempt && attempt.id !== finishedAtStart) {
      attempt.elapsedMs += clock() - started;
      this.control.writeMeta(TRAINING, JSON.stringify(attempt));
      // Our checkpoints change SQLite too; only subsequent changes require row reads.
      if (this.training) this.training.markers = this.training.scans.map(({ member }, index) => {
        const marker = member.options.ledger.changeMarker();
        const previous = this.training!.markers?.[index];
        return previous && previous.split(':')[0] !== marker.split(':')[0] ? previous : marker;
      });
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
    if (!this.enabled() || this.audit.stopped || !this.saved || !/^[0-9a-f-]{36}$/.test(this.saved.version)
      || !Number.isFinite(this.saved.trainedAt) || !existsSync(this.path) || this.saved.revisions !== this.revisions() || this.saved.judge !== judge || question.pass !== 'content') return false;
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
