/**
 * Deep read: the owner names a set (one document, or one conversation over an
 * optional span) and the owner's private model reads ALL of it, a section at
 * a time, then answers from what it noted. Design:
 * /mnt/project-files/release-1.5/deep-read-and-follow-ups-design.md (1.5 item 8).
 *
 * Map: each section is an ordinary EvidencePack answered by the one Analyst
 * (same generic prompt: answer from this evidence only, cite each claim). A
 * section's cited claims are its notes, each keeping the provenance of the
 * item it came from. Reduce: the notes become the evidence of one more
 * Analyst call; when they outgrow one prompt they are answered in batches and
 * the batches' cited claims are reduced again. No per-question logic and no
 * second prompt: the Analyst is the only answer path (docs/CONTRACTS.md).
 *
 * Sections are sized with the Analyst's own prompt measure, so the Analyst's
 * prompt fit never has to trim a section. No clock cancels a section in
 * progress: the caller's signal (owner cancel, or a stall detected by the
 * model transport) is the only stop. A section the model fails on is named in
 * the answer's coverage, never dropped silently.
 */
import type { AnalystCitation, AnalystResult, Analyst, EvidenceCandidate, EvidencePack } from './contracts.ts';
import { analystPromptBytes, type AnalystEvidenceFormat } from './analyst.ts';

export interface DeepReadNote {
  /** Index of the set candidate the claim cites (into the job's candidate list). */
  candidate: number;
  claim: string;
}

export interface DeepReadState {
  /** Sections read so far, in order; a resumed job starts at the next one. */
  sectionsDone: number;
  notes: DeepReadNote[];
  /** Sections the model could not read, by index. */
  failedSections: number[];
}

export interface DeepReadProgress {
  phase: 'reading' | 'answering' | 'done';
  sectionsTotal: number;
  sectionsDone: number;
  notes: number;
}

export interface DeepReadInput {
  question: string;
  /** Every readable piece of the set, in reading order (authored order for a conversation, chunk order for a document). */
  candidates: readonly EvidenceCandidate[];
  corpusIds: readonly string[];
  analyst: Analyst;
  /** Most prompt bytes one call may take, from the model's served window (localAnalystPromptBudget). */
  promptBytes: number;
  evidenceFormat?: AnalystEvidenceFormat;
  state?: DeepReadState;
  signal?: AbortSignal;
  onProgress?: (progress: DeepReadProgress, state: DeepReadState) => void | Promise<void>;
  /** Awaited before each model call: lets privacy judging, which shares the model's one slot, go first. */
  beforeModelCall?: () => Promise<void>;
  /** What the read left out on purpose (a relevant-days read), stated in the final pack's coverage so the answer says it. */
  coverageNotes?: readonly string[];
  now?: () => Date;
}

export interface DeepReadResult extends AnalystResult {
  sectionsTotal: number;
  sectionsRead: number;
  failedSections: number[];
  notes: number;
}

/** Packs candidates in order into sections whose Analyst prompt fits `promptBytes`. A candidate never spans two sections. */
export function planDeepReadSections(
  question: string,
  candidates: readonly EvidenceCandidate[],
  corpusIds: readonly string[],
  promptBytes: number,
  evidenceFormat: AnalystEvidenceFormat = 'full',
): number[][] {
  const sections: number[][] = [];
  let current: number[] = [];
  const fits = (indexes: number[]) => analystPromptBytes(sectionPack(question, candidates, indexes, corpusIds), { localOnly: true }, evidenceFormat) <= promptBytes;
  for (let index = 0; index < candidates.length; index += 1) {
    const next = [...current, index];
    if (current.length === 0 || fits(next)) { current = next; continue; }
    sections.push(current);
    current = [index];
  }
  if (current.length) sections.push(current);
  return sections;
}

function sectionPack(question: string, candidates: readonly EvidenceCandidate[], indexes: readonly number[], corpusIds: readonly string[], builtAt = new Date(0).toISOString()): EvidencePack {
  return {
    question,
    candidates: indexes.map(index => candidates[index]!),
    coverage: { searchedCorpora: [...corpusIds], skippedCorpora: [], extractionGaps: [] },
    builtAt,
  };
}

function provenanceKey(candidate: Pick<EvidenceCandidate, 'provenance'> | Pick<AnalystCitation, 'provenance'>): string {
  const { sourceItem, chunk } = candidate.provenance;
  return JSON.stringify([sourceItem.localItemId, chunk ?? null]);
}

function itemKey(candidate: Pick<EvidenceCandidate, 'provenance'> | Pick<AnalystCitation, 'provenance'>): string {
  return candidate.provenance.sourceItem.localItemId;
}

/** Each cited claim, tied back to the set candidate it cites; a citation matching no candidate of the call is not a note. */
function notesFrom(result: AnalystResult, callCandidates: readonly number[], candidates: readonly EvidenceCandidate[]): DeepReadNote[] {
  const exact = new Map<string, number>();
  const byItem = new Map<string, number>();
  for (const index of callCandidates) {
    exact.set(provenanceKey(candidates[index]!), index);
    if (!byItem.has(itemKey(candidates[index]!))) byItem.set(itemKey(candidates[index]!), index);
  }
  const notes: DeepReadNote[] = [];
  for (const citation of result.citations) {
    const claim = citation.claim.trim();
    if (!claim) continue;
    const index = exact.get(provenanceKey(citation)) ?? byItem.get(itemKey(citation));
    if (index !== undefined) notes.push({ candidate: index, claim });
  }
  return notes;
}

/** Notes as evidence: one candidate per cited set piece, its claims as the passages, its tier and provenance unchanged. */
function notesAsCandidates(notes: readonly DeepReadNote[], candidates: readonly EvidenceCandidate[]): { candidates: EvidenceCandidate[]; origin: number[] } {
  const grouped = new Map<number, string[]>();
  for (const note of notes) {
    const claims = grouped.get(note.candidate) ?? [];
    if (!claims.includes(note.claim)) claims.push(note.claim);
    grouped.set(note.candidate, claims);
  }
  const origin = [...grouped.keys()].sort((a, b) => a - b);
  return {
    origin,
    candidates: origin.map(index => {
      const { score: _score, tables: _tables, facts: _facts, ...source } = candidates[index]!;
      return { ...source, chunks: grouped.get(index)! };
    }),
  };
}

export async function runDeepRead(input: DeepReadInput): Promise<DeepReadResult> {
  const format = input.evidenceFormat ?? 'full';
  const now = input.now ?? (() => new Date());
  const sections = planDeepReadSections(input.question, input.candidates, input.corpusIds, input.promptBytes, format);
  const state: DeepReadState = input.state
    ? { sectionsDone: input.state.sectionsDone, notes: [...input.state.notes], failedSections: [...input.state.failedSections] }
    : { sectionsDone: 0, notes: [], failedSections: [] };
  const progress = async (phase: DeepReadProgress['phase']) => input.onProgress?.({
    phase, sectionsTotal: sections.length, sectionsDone: state.sectionsDone, notes: state.notes.length,
  }, state);
  const call = async (pack: EvidencePack): Promise<AnalystResult> => {
    input.signal?.throwIfAborted();
    await input.beforeModelCall?.();
    input.signal?.throwIfAborted();
    return input.analyst.analyze(pack, { localOnly: true });
  };

  await progress('reading');
  for (let index = state.sectionsDone; index < sections.length; index += 1) {
    const section = sections[index]!;
    try {
      const result = await call(sectionPack(input.question, input.candidates, section, input.corpusIds, now().toISOString()));
      state.notes.push(...notesFrom(result, section, input.candidates));
    } catch (error) {
      if (input.signal?.aborted) throw error;
      state.failedSections.push(index);
    }
    state.sectionsDone = index + 1;
    await progress('reading');
  }

  await progress('answering');
  const gaps = [
    ...(input.coverageNotes ?? []),
    ...(state.failedSections.length ? [`${state.failedSections.length} of ${sections.length} sections of the set could not be read by the model.`] : []),
  ];
  let notes = state.notes;
  let unanswered: string[] = [];
  // Reduce rounds: answer the notes in batches that fit one prompt until one call holds them all.
  for (;;) {
    const evidence = notesAsCandidates(notes, input.candidates);
    const pack: EvidencePack = {
      question: input.question,
      candidates: evidence.candidates,
      coverage: { searchedCorpora: [...input.corpusIds], skippedCorpora: [], extractionGaps: gaps },
      builtAt: now().toISOString(),
    };
    const batches = planDeepReadSections(input.question, evidence.candidates, input.corpusIds, input.promptBytes, format);
    if (batches.length <= 1) {
      const result = await call(pack);
      await progress('done');
      return {
        ...result,
        sectionsTotal: sections.length,
        sectionsRead: sections.length - state.failedSections.length,
        failedSections: [...state.failedSections],
        notes: state.notes.length,
        unanswered: [...new Set([...result.unanswered, ...unanswered])],
      };
    }
    const reduced: DeepReadNote[] = [];
    for (const batch of batches) {
      const result = await call(sectionPack(input.question, evidence.candidates, batch, input.corpusIds, now().toISOString()));
      unanswered = [...unanswered, ...result.unanswered];
      reduced.push(...notesFrom(result, batch, evidence.candidates).map(note => ({ candidate: evidence.origin[note.candidate]!, claim: note.claim })));
    }
    // A round that does not shrink the notes would loop: answer from the notes it kept instead, and say so.
    if (reduced.length === 0 || reduced.length >= notes.length) {
      notes = reduced.length ? reduced : notes;
      const kept = notesAsCandidates(notes, input.candidates);
      const fitted = planDeepReadSections(input.question, kept.candidates, input.corpusIds, input.promptBytes, format)[0] ?? [];
      if (fitted.length < kept.candidates.length) gaps.push(`Notes from ${kept.candidates.length - fitted.length} pieces of the set did not fit the final answer.`);
      notes = notes.filter(note => fitted.some(position => kept.origin[position] === note.candidate));
      continue;
    }
    notes = reduced;
  }
}
