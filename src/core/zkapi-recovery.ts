/** Explicit owner recovery actions, shared by the dashboard and local CLI.
 * No setting is written and no owner question is sent by either action. */
import {
  abandonZkapiFence,
  zkapiFenceScope,
  zkapiOutstandingFences,
  type ZkapiConsultResult,
  type ZkapiConsultTransportOptions,
} from './consult-transport-zkapi.ts';

export const ZKAPI_RECOVER_CONFIRM = 'Recovery sends one fixed request with no content through the same route and reserves up to $6. Continue?';
export const ZKAPI_ABANDON_CONFIRM = 'Abandoning means the unsettled request may later settle under another session\'s network identity, linking the two. It stops blocking consults and stays in the ledger as a record. Continue?';

export type ZkapiRecoveryOutcome =
  | { ok: true; status_message: string }
  | { ok: false; httpStatus: number; code: string; message: string };

const refused = (httpStatus: number, code: string, message: string): ZkapiRecoveryOutcome => ({ ok: false, httpStatus, code, message });

export async function recoverHeldZkapiRequest(input: {
  confirm: boolean;
  statePath: string;
  env: Record<string, string | undefined>;
  route: ZkapiConsultTransportOptions | undefined;
  secretRef: string | undefined;
  recoverSession: (route: ZkapiConsultTransportOptions, secretRef: string | undefined) => Promise<ZkapiConsultResult>;
}): Promise<ZkapiRecoveryOutcome> {
  if (!input.confirm) return refused(400, 'confirmation_required', 'This action needs your confirmation.');
  if (!input.route) return refused(409, 'route_not_configured', 'Add zkAPI before turning anonymous answers on.');
  let scopes: string[];
  try { scopes = Object.keys(zkapiOutstandingFences(input.statePath)); }
  catch { return refused(500, 'state_unavailable', 'The consult ledger on this computer could not be read.'); }
  if (scopes.length === 0) return refused(409, 'no_unresolved_session', 'There is no held request to recover.');
  if (!scopes.includes(zkapiFenceScope({ env: input.env }))) return refused(409, 'unresolved_session_other_wallet', 'The held request belongs to another wallet folder. Recover it there, or abandon it.');
  let result: ZkapiConsultResult;
  try { result = await input.recoverSession(input.route, input.secretRef); }
  catch { return refused(502, 'recovery_failed', 'The recovery session did not complete. The request is still held.'); }
  if (!result.ok) return refused(502, result.error.code, 'The recovery session did not complete. The request is still held.');
  if (result.receipt?.fence !== 'clear' || result.receipt.settlement !== 'confirmed') {
    return refused(502, 'recovery_incomplete', 'The recovery session ran, but settlement was not confirmed. The request is still held; try again later.');
  }
  return { ok: true, status_message: 'Recovered: the held request settled and consults can run again.' };
}

export function abandonHeldZkapiRequest(input: { confirm: boolean; statePath: string; scope: unknown; now: Date }): ZkapiRecoveryOutcome {
  if (!input.confirm) return refused(400, 'confirmation_required', 'This action needs your confirmation.');
  if (typeof input.scope !== 'string' || !/^[0-9a-f]{32}$/.test(input.scope)) return refused(400, 'scope_invalid', 'Name which held request to abandon.');
  let found: boolean;
  try { found = abandonZkapiFence(input.statePath, input.scope, input.now); }
  catch { return refused(500, 'state_unavailable', 'The consult ledger on this computer could not be written.'); }
  if (!found) return refused(409, 'no_unresolved_session', 'There is no held request to recover.');
  return { ok: true, status_message: 'The held request is marked abandoned. It no longer blocks consults and stays in the ledger as a record.' };
}
