/** Private document jobs for agents without an encrypted widget. Only the
 * local control-session page may collect them; callers receive a fixed notice. */
import { randomBytes } from 'node:crypto';
import { CONSULT_DOCUMENTS_PRIVATE_NOTICE, type ConsultAskResult } from './consult-ask.ts';

export interface PrivateDocumentControl {
  signal: AbortSignal;
  onProgress(progress: { state: 'reading' | 'summarizing' | 'writing' | 'answering'; documentsRead: number; documentsTotal: number }): void;
  registerDocumentGuard(guard: () => Promise<boolean>): void;
}
export interface PrivateDocumentView {
  id: string;
  question: string;
  progress: { state: string; documentsRead: number; documentsTotal: number };
  result?: ConsultAskResult;
}
interface Job extends PrivateDocumentView {
  expires: number;
  abort: AbortController;
  guard?: () => Promise<boolean>;
  authorized: () => boolean;
  running: boolean;
  deadline?: ReturnType<typeof setTimeout>;
}
const changed = (): ConsultAskResult => ({ ok: false, privateDocuments: true, code: 'documents_changed', message: 'The documents or their privacy settings changed. Ask again.' });

export function createPrivateDocumentRequests(options: { now?: () => number; maxJobs?: number; ttlMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Job>();
  const drop = (id: string, job: Job) => {
    if (jobs.get(id) !== job) return;
    if (job.deadline) clearTimeout(job.deadline);
    job.abort.abort();
    jobs.delete(id);
  };
  const sweep = () => {
    for (const [id, job] of jobs) if (job.expires <= now()) drop(id, job);
  };
  const allowed = async (job: Job) => {
    try { return job.authorized() && await job.guard?.() === true && job.authorized() && !job.abort.signal.aborted; }
    catch { return false; }
  };
  return {
    start(question: string, work: (control: PrivateDocumentControl) => Promise<ConsultAskResult>, authorized: () => boolean = () => true): ConsultAskResult {
      sweep();
      if (jobs.size >= (options.maxJobs ?? 8)) return { ok: false, code: 'documents_busy', message: 'There are already document questions open in Private answers. Read them there before asking another.' };
      const job: Job = {
        id: randomBytes(24).toString('base64url'), question,
        progress: { state: 'reading', documentsRead: 0, documentsTotal: 0 },
        expires: now() + (options.ttlMs ?? 30 * 60_000), abort: new AbortController(), authorized, running: true,
      };
      jobs.set(job.id, job);
      job.deadline = setTimeout(() => drop(job.id, job), options.ttlMs ?? 30 * 60_000);
      job.deadline.unref?.();
      void (async () => {
        try {
          const result = await work({
            signal: job.abort.signal,
            onProgress(progress) {
              if (jobs.get(job.id) !== job || job.abort.signal.aborted) return;
              job.progress = { state: progress.state, documentsRead: Math.max(0, Math.floor(progress.documentsRead)), documentsTotal: Math.max(0, Math.floor(progress.documentsTotal)) };
            },
            registerDocumentGuard(guard) { job.guard = guard; },
          });
          // A preflight refusal contains no document-derived result. Any
          // prepared request or successful answer needs the source guard.
          job.result = result.ok || 'sent' in result ? await allowed(job) ? result : changed() : result;
        } catch {
          job.result = { ok: false, privateDocuments: true, code: 'documents_failed', message: 'The document question could not be completed. Nothing private was returned to your agent.' };
        } finally { job.running = false; }
      })();
      return { ok: false, privateDocuments: true, code: 'private_documents_pending', message: CONSULT_DOCUMENTS_PRIVATE_NOTICE };
    },
    async list(): Promise<PrivateDocumentView[]> {
      sweep();
      const views: PrivateDocumentView[] = [];
      for (const job of jobs.values()) {
        if (job.result && (job.result.ok || 'sent' in job.result) && !await allowed(job)) job.result = changed();
        if (jobs.get(job.id) !== job || job.abort.signal.aborted) continue;
        views.push({ id: job.id, question: job.question, progress: { ...job.progress }, ...(job.result ? { result: structuredClone(job.result) } : {}) });
      }
      return views;
    },
  };
}
