import './provider-credit-status.ts';
import '../workers/classification/sniffer-resolver.ts';
import { limitStopReference, registeredLimits } from './limit-stops.ts';
import { withOwnerLimitStore, saveJudgeCallOverride } from './owner-limit-state.ts';
import { recheckVeniceCredit, type FetchVeniceCreditStatusOptions } from './provider-credit-status.ts';
import { OperationError } from './operation-error.ts';

export interface OwnerLimitsDependencies {
  now?: () => Date;
  credit?: FetchVeniceCreditStatusOptions;
  runOnce?: (subject: string) => Promise<unknown>;
  wake?: () => void;
}

/** The one owner operation: the CLI, local MCP and Home all call this handler. */
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
  const registration = registrations.find(limit => limit.id === stop.id)!;
  if (registration.continue !== 'raise' && (params.to !== undefined || params.keep !== undefined)) throw new OperationError('invalid_params', '--to and --keep apply only to Raise.');
  if (registration.continue === 'raise' && stop.id === 'judge.daily_calls') {
    if (typeof params.to !== 'number' || !Number.isSafeInteger(params.to) || params.to <= Math.max(stop.limit ?? 0, stop.used ?? 0)) throw new OperationError('invalid_params', '--to must be a whole number greater than the current limit and used calls.');
    saveJudgeCallOverride(params.to, params.keep === true, now);
    withOwnerLimitStore(store => store.clearLimitStop(stop.id, stop.subject));
    deps.wake?.();
    return { ok: true, id: stop.id, subject: stop.subject, action: 'raise', to: params.to, unit: registration.unit, keep: params.keep === true,
      status_message: params.keep === true ? 'Daily call limit raised for good. Judging can continue.' : 'Call limit raised for this UTC day. Judging can continue.' };
  }
  if (registration.continue === 'refill' && stop.id === 'venice.credit') {
    const resumed = await recheckVeniceCredit(stop.subject, deps.credit);
    if (resumed) {
      withOwnerLimitStore(store => store.clearLimitStop(stop.id, stop.subject));
      deps.wake?.();
    }
    return { ok: resumed, id: stop.id, subject: stop.subject, action: 'refill', status_message: resumed ? 'Venice can consume again. Work can continue.' : 'Venice billing has not confirmed canConsume=true. The stop remains; Olympus will re-check automatically.' };
  }
  if (registration.continue === 'run_once' && deps.runOnce) {
    const result = await deps.runOnce(stop.subject);
    const status = (result as { status?: string } | undefined)?.status;
    const ok = status !== 'busy' && status !== 'too_soon';
    return { ok, id: stop.id, subject: stop.subject, action: 'run_once', result,
      status_message: status === 'busy' ? 'This source already has a run in progress.'
        : status === 'too_soon' ? 'This source was just started. Check its progress on Home.'
        : 'One operator run requested. Usage stays counted.' };
  }
  throw new OperationError('invalid_params', 'This stop has no continuation available on this surface.');
}
