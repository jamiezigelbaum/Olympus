/** One local evidence preparation path for explicitly requested private providers. */
import type { ConsultAskInput, ConsultAskResult } from '../../core/consult-ask.ts';
import { consultWriterContextFromPack } from '../../core/consult-gate.ts';
import { consultWriterEvidence } from '../../core/consult-writer.ts';
import type { EvidencePack } from '../../core/contracts.ts';
import { runWithDocumentDispatch } from '../../core/document-dispatch.ts';
import type { PreparedDocumentDigest } from './document-digest.ts';

export interface DocumentConsultInput extends Omit<ConsultAskInput, 'question' | 'documents'> {
  question: string;
  provider?: 'zkapi' | 'venice';
  registerDocumentGuard?: (guard: () => Promise<boolean>) => void;
  onProgress?: (progress: { state: 'reading' | 'summarizing' | 'writing' | 'answering'; documentsRead: number; documentsTotal: number }) => void;
}
export interface DocumentConsultDependencies {
  preflight(input: DocumentConsultInput): ConsultAskResult | undefined;
  prepare(input: DocumentConsultInput): Promise<PreparedDocumentDigest>;
  ask(input: ConsultAskInput): Promise<ConsultAskResult>;
  venice?: (pack: EvidencePack, current: () => boolean, input: DocumentConsultInput, dispatched: (body: string) => void) => Promise<{ reply: string; sent: string; model: string }>;
}

export async function runDocumentConsult(input: DocumentConsultInput, deps: DocumentConsultDependencies): Promise<ConsultAskResult> {
  const refuse = (code: string, message: string): ConsultAskResult => ({ ok: false, privateDocuments: true, code, message });
  if (!input.question.trim() || input.question.length > 4_000) return refuse('invalid_params', 'Use a question of 1 to 4,000 characters.');
  const originCurrent = () => {
    try { return !input.signal?.aborted && (!input.stillAuthorized || input.stillAuthorized()); } catch { return false; }
  };
  input.registerDocumentGuard?.(async () => originCurrent());
  let before: ConsultAskResult | undefined;
  try { before = deps.preflight(input); }
  catch { return refuse('settings_invalid', 'The private provider settings could not be read. Nothing was sent.'); }
  if (before) return { ...before, privateDocuments: true };
  if (!originCurrent()) return refuse('cancelled', 'The document question is no longer authorized.');
  input.onProgress?.({ state: 'reading', documentsRead: 0, documentsTotal: 0 });
  let prepared: PreparedDocumentDigest;
  try { prepared = await deps.prepare(input); }
  catch { return refuse('documents_unavailable', 'The matching documents could not be read completely. Nothing was sent.'); }
  if (prepared.kind === 'refused') return refuse('documents_unavailable', `The document digest could not be completed (${prepared.reason.replace(/[^a-z_]/g, '').slice(0, 80)}). Nothing was sent.`);
  const current = () => {
    try { return originCurrent() && prepared.current(); } catch { return false; }
  };
  input.registerDocumentGuard?.(async () => current());
  if (!current()) return refuse('documents_changed', 'The documents or their privacy settings changed. Ask again.');
  if (prepared.snapshot.candidates.length === 0) return refuse('documents_not_found', 'No readable matching documents were found. Nothing was sent.');
  const count = prepared.snapshot.candidates.length;
  input.onProgress?.({ state: 'writing', documentsRead: count, documentsTotal: count });
  let attempted: string | undefined;
  try {
    let result: ConsultAskResult;
    if (input.provider === 'venice') {
      if (!deps.venice) return refuse('venice_unavailable', 'Set up an approved Venice Private model on this computer first.');
      // A wording question retains the established excerpt path. The whole
      // source set stays bound by current(), even when only excerpts fit.
      const pack = prepared.kind === 'digest' ? prepared.pack : excerptPack(prepared.snapshot);
      input.onProgress?.({ state: 'answering', documentsRead: count, documentsTotal: count });
      const answered = await runWithDocumentDispatch(current, () => deps.venice!(pack, current, input, body => { attempted = body; }));
      result = { ok: true, privateDocuments: true, reply: answered.reply, sent: answered.sent, model: answered.model, route: 'Venice Private', networkIdentity: 'not_verified', level: 'standard', cleanup: 'as_written', rewritten: true, remembered: false };
    } else {
      const context = consultWriterContextFromPack(prepared.snapshot, { writerVisibleTexts: [input.question] });
      const documents: NonNullable<ConsultAskInput['documents']> = {
        context, current,
        ...(prepared.kind === 'digest'
          ? { digest: JSON.stringify(prepared.pack.candidates.map(candidate => JSON.parse(candidate.chunks[0] ?? '[]'))) }
          : { evidence: consultWriterEvidence(prepared.snapshot) }),
      };
      result = await runWithDocumentDispatch(current, () => deps.ask({ ...input, documents }));
    }
    if (!current()) return refuse('documents_changed', 'The documents or their privacy settings changed. The result was withheld; ask again.');
    return { ...result, privateDocuments: true };
  } catch {
    if (!current()) return refuse('documents_changed', 'The documents or their privacy settings changed. The result was withheld.');
    if (attempted !== undefined) return { ok: false, privateDocuments: true, code: 'documents_failed', message: 'The provider did not return an answer. The request may have been sent; the exact attempted request is shown here.', sent: attempted, outcome: 'unknown' };
    return refuse('documents_failed', 'The private provider could not complete this document question. No private result was returned to your agent.');
  }
}

function excerptPack(snapshot: EvidencePack): EvidencePack {
  let remaining = 40_000;
  return {
    ...snapshot,
    candidates: snapshot.candidates.slice(0, 48).map(candidate => {
      const text = candidate.chunks.join('\n');
      // Byte fitting is conservative for multi-byte text and never presents
      // the fallback as a complete read by the answering provider.
      let excerpt = text.slice(0, Math.min(3_000, remaining));
      while (new TextEncoder().encode(excerpt).length > remaining) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));
      remaining -= new TextEncoder().encode(excerpt).length;
      return { ...candidate, chunks: excerpt ? [excerpt] : [] };
    }),
    coverage: { ...snapshot.coverage, extractionGaps: [...snapshot.coverage.extractionGaps, 'This question needs original wording; the answering model received bounded excerpts.'] },
  };
}
