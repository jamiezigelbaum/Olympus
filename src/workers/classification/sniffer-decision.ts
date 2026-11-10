// Native llama.cpp decision transport. The full adapter remains the fallback.
// Endpoint state serializes every probe, prime and decision across clients.
import type { AnalystModel, AnalystModelCompletion, AnalystModelRequest } from '../../core/analyst.ts';
import { fetchModelEndpoint } from '../../core/model-transport.ts';
import { assertSnifferProfileAllowed, initialSnifferMode, snifferLaneOffersDecision, type SnifferLane } from './sniffer-lane.ts';
import { buildSnifferBatchPrompt, measuredSnifferDecisionBar, SNIFFER_DECISION_CATEGORY, SNIFFER_SYSTEM_PROMPT, snifferDecisionBar } from './sniffer.ts';
import type { SnifferPass, StoredSnifferVerdict } from './sniffer-store.ts';
import { privateChance, SNIFFER_DECISION_PRIVATE_BAR, tierMass, type TokenChance } from './sniffer-decision-mass.ts';

export const REPLY_TO_TIER = '{"verdicts":[{"i":1,"tier":"';
const PLACEHOLDER = 'CALIBRATION_ITEM_PLACEHOLDER';
export type DecisionPost = <T>(path: string, body: unknown) => Promise<T>;

/** Shared with the eval: the server must render both the shape and its escaping probe. */
export async function decisionPromptShape(format: (material: string) => Promise<string>) {
  const formatted = await format(PLACEHOLDER);
  if (typeof formatted !== 'string') throw new Error('The sniffer chat template gave no prompt.');
  const at = formatted.indexOf(PLACEHOLDER);
  if (at < 0) throw new Error('The sniffer chat template changed the item.');
  const before = formatted.slice(0, at);
  const after = formatted.slice(at + PLACEHOLDER.length);
  const render = (material: string) => `${before}${JSON.stringify(material).slice(1, -1)}${after}`;
  const probe = 'Names: a "quoted" name\nExcerpt: a line\twith é and \\ in it';
  if (render(probe) !== await format(probe)) throw new Error('The sniffer prompt shape does not match the chat template.');
  return { shared: before, render };
}

/** Some tokenizers give both words the same first token; ask at their divergence. */
export async function decisionDivergence(post: DecisionPost): Promise<string> {
  const first = async (word: string) => {
    const { tokens } = await post<{ tokens: Array<{ piece: string | number[] }> }>('/tokenize', { content: word, with_pieces: true });
    const piece = tokens[0]?.piece;
    if (typeof piece !== 'string') throw new Error('The sniffer tokenizer gave no text piece.');
    return piece;
  };
  const personal = await first('personal');
  const privateWord = await first('private');
  return personal === privateWord ? personal : '';
}

export interface SnifferModelRequest extends AnalystModelRequest {
  snifferItem?: { pass: SnifferPass; material: string; ownerContext?: string | undefined };
}
export interface SnifferModelCompletion extends AnalystModelCompletion {
  decisionVerdict?: Omit<StoredSnifferVerdict, 'decidedAt'>;
  /** Content-free native decoder diagnostics, including rejected coverage. */
  decisionMetrics?: { privateProbability: number | null; coverage: number };
}
export interface SnifferModel extends AnalystModel {
  /** Content-free probe, before cache/re-judge identity is read. Starts a new run. */
  prepareSniffer?(signal?: AbortSignal): Promise<void>;
}
function replyTokens(reply: unknown): TokenChance[] {
  if (!reply || typeof reply !== 'object') return [];
  const probabilities = (reply as Reply).completion_probabilities;
  if (!Array.isArray(probabilities)) return [];
  const tokens = probabilities[0]?.top_logprobs;
  if (!Array.isArray(tokens) || !tokens.every(token => token && typeof token.token === 'string'
    && typeof token.logprob === 'number' && Number.isFinite(token.logprob) && token.logprob <= 0)) return [];
  return tokens;
}

interface Reply {
  completion_probabilities?: Array<{ top_logprobs?: TokenChance[] }>;
  tokens_cached?: number;
}
/** Capability absence differs from an unavailable server; never includes response text. */
export class NativeRequestError extends Error {
  constructor(readonly unsupported = false, readonly timedOut = false) { super('The native privacy sniffer request failed.'); }
}
interface EndpointState {
  tail: Promise<unknown>;
  supported?: boolean | undefined;
  rejudgeReady?: boolean;
  probedAt?: number;
  primed?: string | undefined;
  /** The served weights file's base name, from `/props` (undefined when not reported). */
  weights?: string | undefined;
  weightsRead?: boolean;
  /** The no-measured-bar note is logged once per endpoint. */
  barNoted?: boolean;
}
const endpoints = new Map<string, EndpointState>();
async function exclusive<T>(state: EndpointState, run: () => Promise<T>): Promise<T> {
  const result = state.tail.then(run, run);
  state.tail = result.catch(() => undefined);
  return result;
}

/** Base name of a served weights path, the only part of `/props` the judge keeps. */
export function servedWeightsName(props: unknown): string | undefined {
  const path = props && typeof props === 'object' ? (props as { model_path?: unknown }).model_path : undefined;
  if (typeof path !== 'string' || !path.trim()) return undefined;
  const name = path.trim().split(/[\\/]/).pop();
  return name ? name.slice(0, 200) : undefined;
}

export function createDecisionSnifferModel(lane: SnifferLane, full: AnalystModel, options: { apiKey?: string | undefined; log?: (line: string) => void } = {}): SnifferModel {
  lane.snifferMode = initialSnifferMode(lane.profile);
  if (!snifferLaneOffersDecision(lane)) return full;
  assertSnifferProfileAllowed(lane.profileId, lane.profile);
  const endpoint = lane.profile.baseUrl!.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  let state = endpoints.get(endpoint);
  if (!state) { state = { tail: Promise.resolve() }; endpoints.set(endpoint, state); }
  const sharedState = state;
  let signal: AbortSignal | undefined;
  const post: DecisionPost = async <T>(path: string, body: unknown): Promise<T> => {
    const timeout = AbortSignal.timeout(60_000);
    try {
      const response = await fetchModelEndpoint(fetch, `${endpoint}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (!response.ok) throw new NativeRequestError([404, 405, 501].includes(response.status));
      return await response.json() as T;
    } catch (error) {
      // Neither server errors (which can echo a prompt) nor fetch causes escape.
      throw error instanceof NativeRequestError ? error : new NativeRequestError(false, timeout.aborted);
    }
  };
  const readWeights = async (): Promise<string | undefined> => {
    try {
      const response = await fetchModelEndpoint(fetch, `${endpoint}/props`, {
        method: 'GET',
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok ? servedWeightsName(await response.json()) : undefined;
    } catch {
      return undefined;
    }
  };
  const noteBar = () => {
    lane.servedWeights = sharedState.weights;
    if (sharedState.barNoted || lane.snifferMode !== 'decision') return;
    sharedState.barNoted = true;
    if (lane.decisionBar !== undefined || measuredSnifferDecisionBar(lane) !== undefined) return;
    options.log?.(`Olympus privacy judge: no measured decision bar for ${sharedState.weights ? `weights ${sharedState.weights}` : `model ${lane.modelId}`}; items are held Private at P(Private) ${SNIFFER_DECISION_PRIVATE_BAR}. Measure one with eval/calibration (README, "Measuring a new judge model").`);
  };
  let shapeKey = '';
  let shape: Awaited<ReturnType<typeof decisionPromptShape>> | undefined;
  let written: string | undefined;
  const reset = () => { sharedState.primed = undefined; shape = undefined; written = undefined; };
  const format = async (prompt: string) => (await post<{ prompt: string }>('/apply-template', {
    messages: [{ role: 'system', content: SNIFFER_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
    chat_template_kwargs: { enable_thinking: false },
  })).prompt;
  const prepare = async () => {
    if (lane.profile.snifferMode === 'decision') {
      if (!sharedState.weightsRead) { sharedState.weights = await readWeights(); sharedState.weightsRead = true; }
      lane.snifferMode = 'decision'; lane.rejudgeReady = true; noteBar(); return;
    }
    // Successful capability proof is cached; unsupported servers are re-probed
    // once a minute so a server replacement needs no owner action.
    if (sharedState.supported === undefined || (!sharedState.supported && Date.now() - (sharedState.probedAt ?? 0) >= 60_000)) {
      try {
        const prompt = await format(buildSnifferBatchPrompt('content', [{ i: 1, material: 'capability probe' }]));
        if (typeof prompt !== 'string') throw new Error('No template.');
        const reply = await post<Reply>('/completion', { prompt: `${prompt}${REPLY_TO_TIER}`, n_predict: 1, n_probs: 40, temperature: 0, cache_prompt: true, id_slot: 0 });
        sharedState.supported = replyTokens(reply).length > 0;
        if (sharedState.supported) await decisionDivergence(post);
        if (sharedState.supported) { sharedState.weights = await readWeights(); sharedState.weightsRead = true; }
        sharedState.rejudgeReady = true;
      } catch (error) {
        sharedState.supported = false;
        sharedState.rejudgeReady = error instanceof NativeRequestError && error.unsupported;
      }
      sharedState.probedAt = Date.now();
      reset();
    }
    lane.snifferMode = sharedState.supported ? 'decision' : 'full';
    lane.rejudgeReady = sharedState.rejudgeReady !== false;
    noteBar();
  };
  return {
    async prepareSniffer(nextSignal) {
      await exclusive(sharedState, async () => {
        signal = nextSignal;
        await prepare();
        // Every resolver pass is a run, even when another consumer used the slot.
        sharedState.primed = undefined;
      });
    },
    async complete(request: SnifferModelRequest): Promise<SnifferModelCompletion> {
      if (!request.snifferItem || lane.snifferMode === 'full') {
        sharedState.primed = undefined;
        return full.complete(request);
      }
      return exclusive(sharedState, async () => {
        signal = request.signal;
        assertSnifferProfileAllowed(lane.profileId, lane.profile);
        // Freeze the effective mode for a resolver run: its cache/reason id
        // was chosen before dispatch. A failed capability is re-probed next run.
        if (lane.snifferMode === undefined || lane.snifferMode === 'pending') await prepare();
        if (lane.snifferMode !== 'decision') return full.complete(request);
        try {
          const { pass, material, ownerContext } = request.snifferItem!;
          const key = buildSnifferBatchPrompt(pass, [{ i: 1, material: PLACEHOLDER }], ownerContext);
          if (!shape || shapeKey !== key) {
            shape = await decisionPromptShape(value => format(buildSnifferBatchPrompt(pass, [{ i: 1, material: value }], ownerContext)));
            shapeKey = key;
            sharedState.primed = undefined;
          }
          written ??= await decisionDivergence(post);
          if (sharedState.primed !== shape.shared) {
            await post('/completion', { prompt: shape.shared, n_predict: 0, cache_prompt: true, id_slot: 0 });
            sharedState.primed = shape.shared;
          }
          const reply = await post<Reply>('/completion', { prompt: `${shape.render(material)}${REPLY_TO_TIER}${written}`, n_predict: 1, n_probs: 40, temperature: 0, cache_prompt: true, id_slot: 0 });
          const mass = tierMass(replyTokens(reply), written);
          const chance = privateChance(mass);
          const decisionMetrics = { privateProbability: chance ?? null, coverage: mass.private + mass.personal + mass.ambiguous };
          // A cold slot (e.g. a server restart between calls) must be primed again.
          if (reply?.tokens_cached === 0) reset();
          if (chance === undefined || !Number.isFinite(chance)) { reset(); return { text: '', modelId: lane.modelId, decisionMetrics }; }
          // Stored as the tier at this lane's bar with that tier's mass, so
          // P(Private) is recoverable and a later bar re-reads it (sniffer.ts).
          const held = chance >= snifferDecisionBar(lane);
          return { text: '', modelId: lane.modelId, decisionMetrics, decisionVerdict: {
            tier: held ? 'private' : 'personal', category: SNIFFER_DECISION_CATEGORY,
            confidence: held ? chance : 1 - chance, failSafe: false,
          } };
        } catch (error) {
          reset();
          sharedState.supported = undefined;
          throw error instanceof NativeRequestError ? error : new NativeRequestError();
        }
      });
    },
  };
}
