// Local, source-neutral Personal-only clearance. No vectors, labels or weights leave this process.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeFileDurablySync, writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { ingestionTurn } from '../control-path-headroom.ts';
import { snifferMaterialCarriesSecret } from './sniffer.ts';
import type { SnifferQuestion, TierSnifferStore } from './sniffer-store.ts';
import { tierLedgerIdentityKey, type TierLedger, type TierLedgerRecord, type TierPlacementPlan } from './tier-ledger.ts';
import { TIER_CLASSIFIER_VERSION, PERSONAL_FIRST_REASON, HELD_UNTIL_JUDGED_REASON, contentDigestReason, normalizedContentHash, type TierDecision, type TierSnifferSubject } from './tier-classifier.ts';
import { EMBEDDING_PREFILTER_MODEL_ID, EMBEDDING_PREFILTER_DIMENSIONS, EMBEDDING_PREFILTER_MIN_PER_CLASS,
  trainLogistic, privateProbability, type LogisticModel, type LogisticExample } from './embedding-logistic.ts';

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
  private attemptedAt = -Infinity;
  private readonly auditState: Audit;
  private readonly path: string;
  constructor(private readonly options: {
    ledger: TierLedger; sniffer: TierSnifferStore; stateLedger?: TierLedger; sharedWith?: EmbeddingPrefilter;
    copyFor: (subject: TierSnifferSubject) => PrefilterCopy | undefined;
    placementFor?: (decision: TierDecision) => TierPlacementPlan;
    enabled?: () => boolean; random?: () => number; now?: () => number;
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
    if (!this.saved) return `Embedding clearing waits for ${EMBEDDING_PREFILTER_MIN_PER_CLASS} judge verdicts per class with complete stored vectors.`;
    return `Embedding clearing is on; ${this.audit.misses.length} of 200 spot checks collected.`;
  }
  setPlacementFor(placementFor: ((decision: TierDecision) => TierPlacementPlan) | undefined): void {
    if (placementFor) this.options.placementFor = placementFor;
    else delete this.options.placementFor;
  }
  /** Recovery cannot depend on the judge being available or approved. */
  recover(): void {
    if (this.audit.stopped || !this.enabled()) for (const member of this.owner.members) member.rollback();
  }
  /** Scheduled daily; never learn from this filter's predictions, rules, overrides or fail-safes. */
  async prepare(judge: string): Promise<void> {
    if (this.owner !== this) return this.owner.prepare(judge);
    if (this.audit.stopped) { for (const member of this.members) member.rollback(); return; }
    if (!this.enabled()) { for (const member of this.members) member.rollback(); return; }
    if (this.saved && (this.saved.judge !== judge || !/^[0-9a-f-]{36}$/.test(this.saved.version) || !Number.isFinite(this.saved.trainedAt)
      || privateProbability(this.saved.model, [1, ...new Array(EMBEDDING_PREFILTER_DIMENSIONS - 1).fill(0)]) === undefined)) this.saved = undefined;
    if (this.saved && (this.saved.revisions !== this.revisions() || !existsSync(this.path))) {
      if (existsSync(this.path)) removeFileDurablySync(this.path);
      this.saved = undefined; this.attemptedAt = -Infinity;
    }
    const now = this.now();
    if ((this.saved && now - this.saved.trainedAt < RETRAIN_MS) || now - this.attemptedAt < RETRAIN_MS) return;
    this.attemptedAt = now;
    const revisions = this.revisions();
    const examples: LogisticExample[] = [];
    const counts = [0, 0];
    for (const member of this.members) {
      let after: TierSnifferSubject | undefined;
      while (true) {
        const rows = member.options.ledger.listRouted({ ...(after ? { after } : {}), limit: 500 });
        if (!rows.length) break;
        for (const row of rows) {
          if (row.state !== 'current' || row.metadataPending || row.contentPending
            || row.metadataTier !== 'private' || !['private', 'secure'].includes(row.contentTier) || row.metadataForced
            || !row.modelId || row.decidedBy === 'owner_rule' || row.decidedBy === 'override'
            || row.reasons.some(reason => reason.startsWith('metadata:owner_rule:') || reason.startsWith('content:embedding_prefilter:'))
            || !row.reasons.some(reason => reason.startsWith(`content:sniffer:${judge}:`)
              && !/:rule:|:unresolved:|:fail_safe:|:injection:/.test(reason))) continue;
          const copy = member.options.copyFor(subjectOf(row));
          if (!copy || !row.reasons.includes(contentDigestReason(copy.chunks.map(chunk => chunk.boundedText).join('')))) continue;
          const label = member.options.sniffer.judgedContentLabel(subjectOf(row), row.modelId, normalizedContentHash(copy.chunks.map(chunk => chunk.boundedText).join('')));
          if (!label) continue;
          const isPrivate = label === 'private';
          const index = Number(isPrivate);
          if (counts[index]! >= MAX_PER_CLASS) continue;
          const vector = prefilterVector(copy);
          if (!vector) continue;
          examples.push({ vector, private: isPrivate }); counts[index]!++;
        }
        after = subjectOf(rows[rows.length - 1]!);
        if (counts.every(count => count >= MAX_PER_CLASS)) break;
        await ingestionTurn();
      }
    }
    const model = trainLogistic(examples);
    if (!model || revisions !== this.revisions() || this.control.dbPath === ':memory:') return;
    const directory = embeddingPrefilterDirectory(this.control.dbPath);
    if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const saved: SavedModel = { model, judge, revisions, trainedAt: now, version: randomUUID() };
    writePrivateFileAtomicSync(this.path, JSON.stringify(saved));
    this.saved = saved;
  }
  /** Called even for settled queue entries: they carry the rollback material until a good check. */
  retained(question: SnifferQuestion): boolean {
    const raw = this.options.ledger.readMeta(RECEIPTS + tierLedgerIdentityKey(question));
    if (!raw) return false;
    const receipt = JSON.parse(raw) as Receipt;
    const row = this.options.ledger.getCurrent(question);
    if (receipt.hash === question.materialHash && row?.reasons.includes(receipt.reason)) return true;
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
