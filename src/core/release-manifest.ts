/**
 * The release manifest of a source answer: every item the analyst read to
 * write it (cited or not), with its account, and the release rules it was
 * written under. Internal only: it is never serialized, never part of a
 * worker response and never part of any surface's output.
 *
 * Why it exists: a remote agent can collect an answer minutes after it was
 * written (a handed-off `source_answer`, core/source-answer-jobs.ts). By then
 * an item the analyst read may have been reclassified to Secret or Private.
 * The answer's citations name only the items it cites, so an uncited item's
 * text could still be in the answer. The manifest names them all, and the
 * remote output boundary (core/remote-result.ts) revalidates it against the
 * current tiers and the current release rules before the answer leaves.
 *
 * How it travels: the remote surface opens a sink for one tool call
 * (`runWithReleaseManifestSink`). The answer pipeline runs in-process inside
 * that call, so the analyst handler's `recordReleaseManifest` lands in the
 * call's sink. A handed-off answer runs in its own per-job sink, which the job
 * keeps; the call that collects the job adopts it. A pipeline run outside any
 * sink records nothing. ChatGPT opens a sink at its release boundary; the
 * worker keeps content-free manifests behind opaque tickets for stdio's
 * trusted local transport and delayed collection.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** One item the analyst read, identified down to its account. */
export interface ReleaseInput {
  corpusId: string;
  provider: string;
  /** Empty when the item came without one; such an input in a tiered corpus cannot be proven. */
  accountScope: string;
  providerItemId: string;
  providerConversationId?: string;
  /** Private (secure_local, or an S4 item) when the answer was written. */
  privateAtAnswer: boolean;
  /** Raw Personal pages require a settled Personal row, including the live owner override. */
  personalContent?: true;
  /**
   * Absent: the item itself was read. `names`: only the item's NAMES were in
   * front of a model, as a child citation's parent label (core/parent-label.ts).
   * Such an input is judged on the item's names tier alone, and its content
   * never limits the answer. A names-only evidence candidate (a Private file
   * whose names stay Personal) is one too, and it may be cited.
   */
  layer?: 'names';
  /** Stored chunks whose text contributed to this output, never snippet hashes. */
  chunkHashes?: readonly string[];
  /**
   * `parent_label`: the input is a child citation's parent label, a
   * dependency of the answer that never stands for a cited item (its names
   * may be in the prose, so its loss withholds the whole answer).
   */
  dependency?: 'parent_label';
}

/** The release rules in force when the answer was written. */
export interface ReleaseConstraints {
  /** The worker's posture for Private derivatives: `allow` releases them by default, `approval` does not. */
  secureDerivativeDefault: 'allow' | 'approval';
  /** The request asked for Private content explicitly (`include_secure_local_content`). */
  includeSecureLocalContent: boolean;
}

export interface ReleaseManifest {
  inputs: readonly ReleaseInput[];
  constraints: ReleaseConstraints;
}

/**
 * An input's tier now, and whether it is gone.
 * - `legacy`: no per-item tier exists (a corpus no tier ledger governs, or an
 *   item the ledger never classified); its tier is still its corpus's.
 * - `public_or_personal`: classified below Private.
 * - `private`: classified Private, or moving to Private.
 * - `secret`: classified Secret, or moving to Secret.
 * - `unknown`: cannot be proven (no account scope in a tiered corpus).
 * `gone`: routed, with no current copy left anywhere.
 * `hiddenByParent`: a child item whose parent may not be seen any more (it is
 * also `gone`). Unlike an item that moved or left, what an answer said about
 * such a child may sit in its prose and not in a citation, so a collector
 * withholds the whole answer rather than dropping the citation.
 */
export interface ReleaseInputVerdict {
  tier: 'legacy' | 'public_or_personal' | 'private' | 'secret' | 'unknown';
  gone: boolean;
  hiddenByParent?: boolean;
}

/** The worker's current tiers and release rules, read when an answer is collected. */
export interface ReleaseCheck {
  /** One verdict per input, in order, from one read of each ledger. Throws when a ledger cannot be read. */
  inputs(inputs: readonly ReleaseInput[]): readonly ReleaseInputVerdict[];
  /** The awaiting Ask path uses the same check on the read pool. */
  inputsOffThread?(inputs: readonly ReleaseInput[]): Promise<readonly ReleaseInputVerdict[]>;
  /** One shared, fail-closed chunk gate for remote evidence and model dispatch. */
  chunks?(inputs: readonly ReleaseInput[], options?: { budgetMs?: number }): Promise<ChunkReleaseResult>;
  /** The posture for Private derivatives in force now. */
  secureDerivativeDefault(): 'allow' | 'approval';
}

export interface ChunkReleaseResult {
  /** Allowed hashes per input, in request order. */
  allowed: readonly (readonly string[])[];
  withheldPassages: number;
  withheldDocuments: number;
}

// Provisional: set from measured built-in 4B time per chunk.
export const RELEASE_CHUNK_JUDGE_BUDGET_MS = 8_000;

export function chunkCoverageNote(result: Pick<ChunkReleaseResult, 'withheldPassages' | 'withheldDocuments'>): string | undefined {
  return result.withheldPassages > 0
    ? `${result.withheldPassages} passages from ${result.withheldDocuments} documents are still being checked for privacy and weren't shared. Ask again in a minute.` : undefined;
}

/** Missing chunk support is never permission to release text. */
export async function checkReleaseChunks(check: ReleaseCheck | undefined, inputs: readonly ReleaseInput[], options?: { budgetMs?: number }): Promise<ChunkReleaseResult> {
  try {
    const result = await check?.chunks?.(inputs, options);
    if (result && result.allowed.length === inputs.length) return result;
  } catch { /* Withhold on unavailable stores or judge. */ }
  return {
    allowed: inputs.map(() => []),
    withheldPassages: inputs.reduce((n, input) => n + (input.layer === 'names' ? 0 : Math.max(1, input.chunkHashes?.length ?? 0)), 0),
    withheldDocuments: inputs.filter(input => input.layer !== 'names').length,
  };
}

/** Revalidate each search hit independently after a delayed probe or privacy judgment. */
export async function recheckSearchEvidence(
  raw: Record<string, unknown>, manifests: readonly ReleaseManifest[], check: ReleaseCheck | undefined,
): Promise<{ raw: Record<string, unknown>; withheldAfter: boolean }> {
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  if (!evidence.length) return { raw, withheldAfter: false };
  const inputs = manifests.flatMap(manifest => manifest.inputs);
  let report: ChunkReleaseResult | undefined;
  let verdicts: readonly ReleaseInputVerdict[] = [];
  try {
    if (check && manifests.length) {
      report = await checkReleaseChunks(check, inputs);
      // Judging can raise a whole item; read tiers after it finishes.
      verdicts = await (check.inputsOffThread?.(inputs) ?? check.inputs(inputs));
    }
  } catch { /* A missing proof drops only the evidence it cannot verify. */ }
  const cleared = (index: number): boolean => {
    const input = inputs[index]!;
    const verdict = verdicts[index];
    return !!verdict && !verdict.gone && ['public_or_personal', 'legacy'].includes(verdict.tier)
      && (input.layer === 'names' || (!!input.chunkHashes?.length
        && input.chunkHashes.every(hash => report?.allowed[index]?.includes(hash))));
  };
  const parentsCleared = inputs.every((input, index) => input.dependency !== 'parent_label' || cleared(index));
  const kept = evidence.filter(value => {
    if (!parentsCleared || !value || typeof value !== 'object') return false;
    const hit = value as Record<string, unknown>;
    const matches = inputs.flatMap((input, index) => input.dependency !== 'parent_label'
      && input.corpusId === hit.corpus_id && input.provider === hit.provider
      && input.accountScope === hit.account_scope && input.providerItemId === hit.provider_item_id
      && input.providerConversationId === hit.provider_conversation_id ? [index] : []);
    return matches.length > 0 && matches.every(cleared);
  });
  const dropped = evidence.length - kept.length;
  if (!dropped) return { raw, withheldAfter: false };
  const coverage = raw.coverage && typeof raw.coverage === 'object' ? raw.coverage as Record<string, unknown> : {};
  const note = report && chunkCoverageNote(report);
  const priorNotes = Array.isArray(coverage.cut_short) ? coverage.cut_short : [];
  const withheld = typeof raw.withheld === 'number' && Number.isFinite(raw.withheld) ? Math.max(0, raw.withheld) : 0;
  return { raw: { ...raw, evidence: kept, withheld: withheld + Math.max(dropped, report?.withheldPassages ?? 0),
    ...(note ? { coverage: { ...coverage, cut_short: [...new Set([...priorNotes, note])] } } : {}),
  }, withheldAfter: true };
}

// Internal provenance survives prompt fitting (which keeps provenance identity).
// Neither the hashes nor the local text map is serialized onto EvidencePack.
const chunkProvenance = new WeakMap<object, readonly { text: string; hashes: readonly string[] }[]>();
export function bindReleaseChunks(provenance: object, chunks: readonly string[], hashes: readonly (readonly string[])[]): void {
  chunkProvenance.set(provenance, chunks.map((text, index) => ({ text, hashes: hashes[index] ?? [] })));
}
export function copyReleaseChunks(from: object, into: object): void {
  const chunks = chunkProvenance.get(from);
  if (chunks) chunkProvenance.set(into, chunks);
}
export function releasePassageHashes(provenance: object, text: string): readonly string[] {
  return [...new Set((chunkProvenance.get(provenance) ?? []).filter(entry => entry.text.includes(text)).flatMap(entry => entry.hashes))];
}
export function releaseCandidateHashes(candidate: { provenance: object; chunks: readonly string[] }): readonly string[] {
  return [...new Set(candidate.chunks.flatMap(text => releasePassageHashes(candidate.provenance, text)))];
}

export interface ReleaseManifestSink {
  readonly manifests: ReleaseManifest[];
}

const storage = new AsyncLocalStorage<ReleaseManifestSink>();

export function createReleaseManifestSink(): ReleaseManifestSink {
  return { manifests: [] };
}

/** Runs `fn` with `sink` as the current sink: manifests recorded inside it land there. */
export function runWithReleaseManifestSink<T>(sink: ReleaseManifestSink, fn: () => T): T {
  return storage.run(sink, fn);
}

export function currentReleaseManifestSink(): ReleaseManifestSink | undefined {
  return storage.getStore();
}

/** Records a manifest in the current sink; a no-op outside one. */
export function recordReleaseManifest(manifest: ReleaseManifest): void {
  storage.getStore()?.manifests.push({
    inputs: manifest.inputs.map((input) => ({ ...input, ...(input.chunkHashes ? { chunkHashes: [...input.chunkHashes] } : {}) })),
    constraints: { ...manifest.constraints },
  });
}

/** Copies `from`'s manifests into `into` (a collecting call adopting its job's). */
export function adoptReleaseManifests(into: ReleaseManifestSink, from: ReleaseManifestSink): void {
  into.manifests.push(...from.manifests);
}

/** A stale Personal answer never inherits permission to disclose newly Private text. */
export const ANSWER_BECAME_PRIVATE = 'Olympus withheld this answer because an item became Private.';
export const ANSWER_RELEASE_UNVERIFIED = 'Olympus withheld this answer because its current privacy classification could not be verified.';

/** Shared with remote output: explicit consent or today's posture permits a Private derivative. */
export function privateInputReleaseAllowed(
  input: ReleaseInput,
  verdict: ReleaseInputVerdict,
  constraints: ReleaseConstraints,
  postureNow: 'allow' | 'approval',
): boolean {
  const privateNow = verdict.tier === 'private' || (verdict.tier === 'legacy' && input.privateAtAnswer);
  const authorized = constraints.includeSecureLocalContent || postureNow === 'allow';
  // A parent label was cleared for the names tier of its time. Names that became Private since
  // are covered by neither the posture nor a request for Private content: the answer carried
  // them at a tier they no longer have. Names that were Private then still need today's
  // authorization, exactly as any Private text does: the posture may have tightened since.
  if (input.layer === 'names') return !privateNow || (input.privateAtAnswer && authorized);
  return !privateNow || authorized;
}

/** Await current tiers before release without holding the Ask thread in SQL. */
export async function answerReleaseWithheldReasonOffThread(
  manifests: readonly ReleaseManifest[],
  check: ReleaseCheck,
  ceiling: 'personal' | 'private' = 'private',
  options: { chunks?: boolean } = {},
): Promise<string | undefined> {
  try {
    const inputs = manifests.flatMap((manifest) => manifest.inputs);
    const verdicts = await (check.inputsOffThread?.(inputs) ?? check.inputs(inputs));
    const reason = answerReleaseWithheldReason(manifests, { inputs: () => verdicts, secureDerivativeDefault: () => check.secureDerivativeDefault() }, ceiling);
    if (reason) return reason;
    if (options.chunks && (await checkReleaseChunks(check, inputs)).withheldPassages > 0) return ANSWER_RELEASE_UNVERIFIED;
    return undefined;
  } catch {
    return ANSWER_RELEASE_UNVERIFIED;
  }
}

export function answerReleaseWithheldReason(
  manifests: readonly ReleaseManifest[],
  check: ReleaseCheck,
  ceiling: 'personal' | 'private' = 'private',
): string | undefined {
  if (manifests.length === 0) return ANSWER_RELEASE_UNVERIFIED;
  const entries = manifests.flatMap((manifest) => manifest.inputs.map((input) => ({ input, constraints: manifest.constraints })));
  const inputs = entries.map(({ input }) => input);
  try {
    const verdicts = check.inputs(inputs);
    if (verdicts.length !== inputs.length) return ANSWER_RELEASE_UNVERIFIED;
    const postureNow = check.secureDerivativeDefault();
    for (const [index, verdict] of verdicts.entries()) {
      if (verdict.tier === 'unknown' || verdict.gone) return ANSWER_RELEASE_UNVERIFIED;
      if (verdict.tier === 'secret') return ANSWER_RELEASE_UNVERIFIED;
      const { input, constraints } = entries[index]!;
      if (verdict.tier === 'private' && (ceiling === 'personal' || !input.privateAtAnswer)) return ANSWER_BECAME_PRIVATE;
      if (!privateInputReleaseAllowed(input, verdict, constraints, postureNow)) {
        return 'Olympus withheld this answer because current settings require approval for Private content.';
      }
    }
  } catch {
    return ANSWER_RELEASE_UNVERIFIED;
  }
  return undefined;
}

// Only local, content-free refusals are trusted here; a serialized worker result cannot forge membership.
const withheldAnswers = new WeakSet<object>();

export function isWithheldSourceAnswer(result: object): boolean {
  return withheldAnswers.has(result);
}

export function withheldSourceAnswer(reason: string): { answer: string; evidence: never[] } {
  const result = { answer: reason, evidence: [] };
  withheldAnswers.add(result);
  return result;
}
