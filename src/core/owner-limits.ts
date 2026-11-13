import { raiseSourceSizeLimit } from '../workers/file-extraction/size-limit-stops.ts';
import type { LocalFileExtractionJobStore } from '../workers/file-extraction/job-store.ts';
import { providerWaitMessage } from './provider-rate-limits.ts';
import './consult-transport-zkapi.ts';
import { JudgeSpending } from '../workers/classification/judge-spending.ts';
import '../workers/google-connectors/gmail-import-allowance.ts';
import { GMAIL_IMPORT_MIN_DAILY_BUDGET } from '../workers/google-connectors/gmail-import-allowance.ts';
import { isSizeLimitKey, saveOwnerLimitOverride, type OwnerLimitKey } from './owner-limit-settings.ts';
import './provider-credit-status.ts';
import '../workers/classification/sniffer-resolver.ts';
import { limitStopReference, registeredLimits, type LimitStop } from './limit-stops.ts';
import { withOwnerLimitStore, clearOwnerLimitStop, ownerLimitStopHooks } from './owner-limit-state.ts';
import { recheckVeniceCredit, type FetchVeniceCreditStatusOptions } from './provider-credit-status.ts';
import { OperationError } from './operation-error.ts';

/** A run_once subject is a scheduler identity; the operator sync names the source. */
export function limitRunOnceSource(subject: string): string {
  let identity: unknown;
  try { identity = JSON.parse(subject); } catch { throw new OperationError('invalid_params', 'This stop has no scheduler identity.'); }
  if (!Array.isArray(identity) || identity.length !== 3 || !identity.every(part => typeof part === 'string')) throw new OperationError('invalid_params', 'Invalid scheduler stop subject.');
  const source = ({ 'x.bookmarks': 'x', 'readwise.library': 'readwise', 'gmail.email': 'gmail', 'google_drive.docs': 'google-drive' } as Record<string, string>)[identity[0]!];
  if (!source) throw new OperationError('invalid_params', 'This source has no run-once action.');
  return source;
}

export interface OwnerLimitsDependencies {
  now?: () => Date;
  credit?: FetchVeniceCreditStatusOptions;
  runOnce?: (subject: string, stop: LimitStop) => Promise<unknown>;
  wake?: (id?: string) => void;
  /** The engine's extraction queue, for size-stop Raise. */
  extractionJobs?: () => LocalFileExtractionJobStore | undefined;
}

/**
 * The one owner operation. It runs in the engine (Bun, beside the stores); the
 * CLI, local MCP and Home reach it through the worker's /limits route.
 */
export async function ownerLimits(params: Record<string, unknown>, deps: OwnerLimitsDependencies = {}) {
  const now = deps.now?.() ?? new Date();
  const action = params.action ?? 'list';
  if (action !== 'list' && action !== 'continue') throw new OperationError('invalid_params', 'Use list or continue.');
  for (const key of Object.keys(params)) if (!['action', 'id', 'subject', 'to', 'keep'].includes(key)) throw new OperationError('invalid_params', `Unknown limits option: ${key}`);
  const stops = withOwnerLimitStore(store => store.openLimitStops(now));
  const registrations = registeredLimits();
  if (action === 'list') {
    if (['id', 'subject', 'to', 'keep'].some(key => params[key] !== undefined)) throw new OperationError('invalid_params', 'List takes no continuation options.');
    return { stops: stops.map(stop => ({ ...registrations.find(limit => limit.id === stop.id)!, ...stop })) };
  }
  if (typeof params.id !== 'string' || (params.subject !== undefined && typeof params.subject !== 'string')) throw new OperationError('invalid_params', 'Continue needs a limit id and an optional subject.');
  if (params.keep !== undefined && typeof params.keep !== 'boolean') throw new OperationError('invalid_params', 'keep must be true or false.');
  const matches = stops.filter(stop => stop.id === params.id && (params.subject === undefined || stop.subject === params.subject || limitStopReference(stop) === params.subject));
  if (matches.length !== 1) throw new OperationError('invalid_params', matches.length ? 'More than one stop matches; choose --subject from olympus limits.' : 'No open stop matches this id and subject.');
  const stop = matches[0]!;
  const registration = { ...registrations.find(limit => limit.id === stop.id)!, ...(stop.continue ? { continue: stop.continue } : {}) };
  if (registration.continue !== 'raise' && (params.to !== undefined || params.keep !== undefined)) throw new OperationError('invalid_params', '--to and --keep apply only to Raise.');
  if (registration.continue === 'none') throw new OperationError('invalid_params', providerWaitMessage(stop.id, stop.resumesAt) ?? 'This stop resumes on its own.');
  if (registration.continue === 'raise') {
    const integer = registration.unit !== 'usd';
    const size = isSizeLimitKey(stop.id);
    const minimum = size ? (stop.limit ?? 0) : Math.max(stop.limit ?? 0, stop.used ?? 0);
    if (typeof params.to !== 'number' || !Number.isFinite(params.to) || (integer && !Number.isSafeInteger(params.to)) || params.to <= minimum
      || (!size && params.to < (stop.toContinue?.raiseTo ?? 0))) throw new OperationError('invalid_params', size
        ? '--to must be a whole number greater than the current file size limit, in bytes.'
        : '--to must cover the next step and be greater than the current limit and usage, in the reported unit.');
    const keys: Record<string, OwnerLimitKey> = { 'judge.daily_calls': 'judge.dailyCalls', 'zkapi.daily_requests': 'zkapi.dailyRequests', 'zkapi.daily_spend': 'zkapi.dailySpend', 'gmail.import_allowance': 'gmail.dailyRequests' };
    if (size) {
      raiseSourceSizeLimit(stop.id, params.to, params.keep === true, now, deps.extractionJobs?.());
    } else if (stop.id === 'judge.spend_cap') {
      // This is a cumulative archive spending cap, rather than a per-day allowance.
      new JudgeSpending(stop.subject).raise(params.to);
    } else if (keys[stop.id]) {
      if (stop.id === 'gmail.import_allowance' && params.to < GMAIL_IMPORT_MIN_DAILY_BUDGET) throw new OperationError('invalid_params', 'The Gmail day budget must hold one complete import step.');
      saveOwnerLimitOverride(keys[stop.id]!, params.to, params.keep === true, now);
    } else throw new OperationError('invalid_params', 'This limit has no Raise action.');
    if (!size) clearOwnerLimitStop(stop.id, stop.subject);
    deps.wake?.(stop.id);
    return { ok: true, id: stop.id, subject: stop.subject, action: 'raise', to: params.to, unit: registration.unit, keep: params.keep === true,
      status_message: stop.id === 'judge.spend_cap' ? 'Spending cap raised. Judging can continue.'
        : size ? `File size limit raised ${params.keep === true ? 'for good' : 'for the held files'}. Files within the new limit are queued.`
        : params.keep === true ? 'Limit raised for good. Work can continue.' : 'Limit raised for this UTC day. Work can continue.' };
  }
  if (registration.continue === 'refill' && stop.id === 'judge.payment') {
    new JudgeSpending(stop.subject).refill();
    clearOwnerLimitStop(stop.id, stop.subject);
    deps.wake?.(stop.id);
    return { ok: true, id: stop.id, subject: stop.subject, action: 'refill', status_message: 'Payment stop lifted. The next judge call will re-check payment.' };
  }
  if (registration.continue === 'refill' && stop.id === 'venice.credit') {
    const resumed = await recheckVeniceCredit(stop.subject, deps.credit, ownerLimitStopHooks);
    if (resumed) {
      clearOwnerLimitStop(stop.id, stop.subject);
      deps.wake?.(stop.id);
    }
    return { ok: resumed, id: stop.id, subject: stop.subject, action: 'refill', status_message: resumed ? 'Venice can consume again. Work can continue.' : 'Venice billing has not confirmed canConsume=true. The stop remains; Olympus will re-check automatically.' };
  }
  if (registration.continue === 'run_once' && deps.runOnce) {
    const result = await deps.runOnce(stop.subject, stop);
    const status = (result as { status?: string } | undefined)?.status;
    const ok = status !== 'busy' && status !== 'too_soon' && status !== 'deferred' && status !== 'failed';
    return { ok, id: stop.id, subject: stop.subject, action: 'run_once', result,
      status_message: status === 'busy' ? 'This source already has a run in progress.'
        : status === 'too_soon' ? 'This source was just started. Check its progress on Home.'
        : status === 'deferred' ? 'The run is still deferred; its retry time is reported in the result.'
        : status === 'failed' ? 'The operator run failed. Check source status before continuing.'
        : 'One operator run requested. Usage stays counted.' };
  }
  throw new OperationError('invalid_params', 'This stop has no continuation available on this surface.');
}
