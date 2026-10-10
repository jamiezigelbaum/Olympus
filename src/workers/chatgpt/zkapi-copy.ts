/**
 * How anonymous answers (zkAPI) read inside ChatGPT: tool descriptions, tool
 * results and the private question panel.
 *
 * Owner decision 2026-10-10, for the ChatGPT plugin directory: the money side
 * of zkAPI lives outside ChatGPT, in Olympus on the user's computer, and
 * ChatGPT-facing copy mentions it as little as possible without hiding the one
 * real side effect. So inside ChatGPT:
 *
 * - zkAPI is "the user's own zkAPI account, set up outside ChatGPT"; the only
 *   side-effect statement is that each question uses a little of its balance.
 * - No money words (CHATGPT_ZKAPI_FORBIDDEN_TERMS), no amounts, and no link
 *   or call to add money. A problem says what it is and that Olympus on the
 *   user's computer has the details.
 *
 * The Mac dashboard's own Anonymous answers card is not ChatGPT and keeps the
 * costs and risks fully stated. The engine's messages stay as they are; this
 * module rewords the few that carry money words on the way into ChatGPT.
 */
import { CONSULT_ASK_MESSAGES } from '../../core/consult-ask.ts';
import { ZKAPI_CONSULT_ERROR_MESSAGES, type ZkapiConsultErrorCode } from '../../core/consult-transport-zkapi.ts';

/**
 * Words that never appear in ChatGPT-facing zkAPI copy (test/chatgpt-zkapi-copy.test.ts
 * holds the tool descriptions, the panel's words and every refusal to it).
 */
export const CHATGPT_ZKAPI_FORBIDDEN_TERMS: RegExp =
  /\b(?:paid|pay|pays|paying|payment|payments|price|prices|priced|cost|costs|charge|charged|charges|fee|fees|eth|ether|crypto\w*|on-?chain|chain|wallet|wallets|deposit\w*|fund|funds|funded|funding|top(?:ping)?[ -]?up|add money|money|dollars?|usd|spend\w*|spent|lease\w*|ledgers?|reserved?|holds?|withdraw\w*|credits?)\b|\$/i;

/** The one side-effect statement in a tool description. */
export const CHATGPT_ZKAPI_TOOL_ACCOUNT_SENTENCE =
  'Uses the user\'s own zkAPI account, set up outside ChatGPT in Olympus on their computer; each question uses a little of its balance.';

/** Where every zkAPI problem is explained: the Olympus dashboard on the user's computer (never the add-money step). */
const DETAILS = 'Olympus on your computer has the details.';

/** The daemon's insufficient-balance answer (HTTP 402, zkapi-clientd `funding_required`). */
export const CHATGPT_ZKAPI_BALANCE_RUN_OUT = `Your zkAPI balance has run out. ${DETAILS}`;

interface ChatGptRefusal {
  readonly code: string;
  readonly message: string;
}

/** Engine refusals whose words carry money terms, reworded for ChatGPT (code and message). */
const TRANSPORT_REFUSALS: Readonly<Partial<Record<ZkapiConsultErrorCode, ChatGptRefusal>>> = {
  funding_date_missing: { code: 'zkapi_needs_attention', message: `Your zkAPI account needs attention, so nothing was sent. ${DETAILS}` },
  funding_date_invalid: { code: 'zkapi_needs_attention', message: `Your zkAPI account needs attention, so nothing was sent. ${DETAILS}` },
  note_expired: { code: 'zkapi_needs_attention', message: `Your zkAPI account needs attention, so nothing was sent. ${DETAILS}` },
  unresolved_session: { code: 'unresolved_session', message: `An earlier zkAPI question was not finished, so nothing was sent. ${DETAILS}` },
  unresolved_session_other_wallet: { code: 'unresolved_session', message: `An earlier zkAPI question from another zkAPI setup was not finished, so nothing was sent. ${DETAILS}` },
  daemon_keyless: { code: 'daemon_keyless', message: `The zkAPI daemon accepts requests without a local API key, so Olympus refuses to send. ${DETAILS}` },
  spend_cap_reached: { code: 'daily_limit_reached', message: 'The daily zkAPI limit you set is reached.' },
  state_unavailable: { code: 'state_unavailable', message: `Olympus could not read or write its zkAPI session record. ${DETAILS}` },
  timeout: { code: 'timeout', message: 'The zkAPI question timed out; it may still have used some of your zkAPI balance.' },
  aborted: { code: 'aborted', message: 'The zkAPI question was cancelled; it may still have used some of your zkAPI balance.' },
  authorization_refused: { code: 'authorization_refused', message: 'The final check just before sending refused the question; nothing was sent.' },
};

/** The ask lane's own refusals that carry money words or need a route to their details inside ChatGPT. */
const ASK_REFUSALS: Readonly<Record<string, { readonly original: string } & ChatGptRefusal>> = {
  route_not_configured: { original: CONSULT_ASK_MESSAGES.noRoute, code: 'route_not_configured', message: `Anonymous answers are not set up yet. ${DETAILS}` },
  cancelled: { original: CONSULT_ASK_MESSAGES.cancelled, code: 'cancelled', message: 'The request was cancelled before the question was sent.' },
};

/**
 * A refusal from the ask lane (core/consult-ask.ts) as ChatGPT tells it. A
 * code this module does not reword passes through unchanged. Anything the
 * engine appended after its fixed sentence (a failed "remember" note) is kept.
 */
export function chatgptZkapiRefusal(code: string, message: string, daemonCode?: unknown): ChatGptRefusal {
  if (code === 'daemon_error' && daemonCode === 'funding_required') {
    return { code: 'balance_run_out', message: reworded(message, ZKAPI_CONSULT_ERROR_MESSAGES.daemon_error, CHATGPT_ZKAPI_BALANCE_RUN_OUT) };
  }
  const ask = ASK_REFUSALS[code];
  if (ask) return { code: ask.code, message: reworded(message, ask.original, ask.message) };
  const transport = TRANSPORT_REFUSALS[code as ZkapiConsultErrorCode];
  if (transport) return { code: transport.code, message: reworded(message, ZKAPI_CONSULT_ERROR_MESSAGES[code as ZkapiConsultErrorCode], transport.message) };
  return { code, message };
}

function reworded(message: string, original: string, replacement: string): string {
  return message.startsWith(original) ? `${replacement}${message.slice(original.length)}` : replacement;
}

/**
 * The route label (zkapiRouteLabel) as ChatGPT reads it: the network facts
 * without the payment-privacy and settlement clauses. A label that still
 * carries a money word falls back to what the network identity says.
 */
export function chatgptZkapiRouteLabel(route: string, networkIdentity?: unknown): string {
  const label = route
    .replace('anonymous route (payment, key and network identity hidden)', 'anonymous route (key and network identity hidden)')
    .replace(/payment privacy only \(network address visible\)/, 'network address visible')
    .replace(/payment privacy only: /, 'network address visible: ')
    .replace(/payment privacy; /, '')
    .replace(/; lease settlement (?:not confirmed|pending)$/, '');
  if (!CHATGPT_ZKAPI_FORBIDDEN_TERMS.test(label)) return label;
  return networkIdentity === 'hidden' ? 'anonymous route' : networkIdentity === 'visible' ? 'network address visible' : 'network route not verified';
}
