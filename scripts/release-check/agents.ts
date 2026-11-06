/**
 * Agents for the release check, and the xAI API agent in particular.
 *
 * The suite asks each configured agent the same short question list and
 * checks what it saw and said. Three kinds run real models:
 *   - `claude-code` and `codex`: the subscription command-line agents
 *     (cli-agents.ts), given the engine's MCP endpoint through the loopback
 *     proxy (mcp-proxy.ts).
 *   - `xai-api`: xAI's Responses API, billed per call, run as a function-tool
 *     loop whose only tools are the engine's read-only MCP tools (no web or X
 *     search tool is ever offered), so a run costs cents. Each call and its
 *     token counts are reported.
 * The ChatGPT-protocol pass is separate (it needs no model key).
 *
 * xAI's Responses API takes `tools: [{type:'function', name, description,
 * parameters}]` and answers with `function_call` items that the next request
 * answers with `function_call_output` items (`previous_response_id`). Its
 * hosted `{type:'mcp', server_url, server_label, authorization}` tool exists
 * too (checked against xAI's documentation on 2026-10-14) but needs a public
 * HTTPS server, so the loop above is what runs.
 */

export type AgentKind = 'xai-api' | 'claude-code' | 'codex';

export interface AgentSpec {
  id: string;
  label: string;
  kind: AgentKind;
  /** Model id; empty means the agent's own default. The run's configuration owns it. */
  model?: string;
  /** Command that prints the credential on stdout (run at start, never logged). */
  keyCommand?: string[];
  /** False leaves the agent out of the run; omitted means on. */
  enabled?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolOutput {
  text: string;
  isError: boolean;
  /** The tool's structured result, when it returned one. */
  structured?: unknown;
  /** Which fixed Private note the result carried, when it carried one. */
  noteKind?: string | null;
}

export interface ToolBridge {
  call(name: string, args: Record<string, unknown>): Promise<ToolOutput>;
}

export interface ApiUsage {
  /** Requests made to the provider. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentTranscript {
  finalText: string;
  /** Every tool call the model made, with its arguments and what came back. */
  calls: Array<{ name: string; args: Record<string, unknown>; output: ToolOutput }>;
  usage: ApiUsage;
}

/** A provider failure that keeps the calls and tokens already used by the question. */
export class AgentApiError extends Error {
  constructor(message: string, readonly usage: ApiUsage, readonly calls: AgentTranscript['calls']) {
    super(message);
    this.name = 'AgentApiError';
  }
}

export const AGENT_INSTRUCTIONS = [
  'You help a person with questions about their own records, which are available through the olympus_search tool (from the olympus tool server).',
  'For anything about their own information, call olympus_search first and answer only from the evidence it returns.',
  'Name the source and title for each claim and cite the evidence id in brackets, like [E1]. If the evidence does not answer the question, say briefly what you could not find.',
  'If a tool result says the answer is in Olympus on their computer, tell the person that, pass its private_note on as written (its Open link included), and do not guess at the content.',
  'Keep the answer short. Use no other tool.',
].join(' ');

const MAX_TURNS = 6;
const XAI_BASE = 'https://api.x.ai/v1';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RunApiOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

async function postJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    // Provider error bodies can echo request content; keep only the status and the error type.
    let kind = '';
    try {
      const parsed = JSON.parse(text) as any;
      kind = String(parsed?.error?.type ?? parsed?.error?.code ?? '');
      // A request-shape refusal (400/422) names the offending argument and nothing of the person's data; other statuses may echo credentials.
      if (!kind && (response.status === 400 || response.status === 422) && typeof parsed?.error === 'string') {
        kind = parsed.error.replace(/\b(xai|sk)-[A-Za-z0-9_-]{8,}/g, '[key]').slice(0, 160);
      }
    } catch { /* not JSON */ }
    throw new Error(`provider answered ${response.status}${kind ? ` (${kind})` : ''}`);
  }
  return JSON.parse(text);
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** xAI: the Responses API as a function-tool loop over the engine's read-only tools. */
export async function runXaiAgent(
  spec: AgentSpec,
  key: string,
  question: string,
  tools: readonly ToolDefinition[],
  bridge: ToolBridge,
  options: RunApiOptions = {},
): Promise<AgentTranscript> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const headers = { authorization: `Bearer ${key}` };
  const toolSpecs = tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema }));
  const calls: AgentTranscript['calls'] = [];
  const usage: ApiUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let previous: string | undefined;
  let input: unknown[] = [{ role: 'user', content: question }];
  let finalText = '';
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    // xAI refuses `instructions` together with `previous_response_id`: the follow-up turns inherit them.
    const response = await postJson(fetchImpl, `${XAI_BASE}/responses`, headers, {
      model: spec.model,
      input,
      tools: toolSpecs,
      ...(previous ? { previous_response_id: previous } : { instructions: AGENT_INSTRUCTIONS }),
    }, timeoutMs).catch((error: Error) => {
      // What was already spent still counts, so a failed question is reported with its calls.
      throw new AgentApiError(error.message, usage, calls);
    });
    usage.calls += 1;
    usage.inputTokens += Number(response.usage?.input_tokens ?? 0);
    usage.outputTokens += Number(response.usage?.output_tokens ?? 0);
    previous = String(response.id);
    const output = (response.output ?? []) as any[];
    const functionCalls = output.filter((item) => item.type === 'function_call');
    const messageText = output
      .filter((item) => item.type === 'message')
      .flatMap((item) => (item.content ?? []) as any[])
      .filter((part) => part.type === 'output_text')
      .map((part) => String(part.text ?? ''))
      .join('\n');
    if (functionCalls.length === 0) {
      finalText = messageText;
      break;
    }
    input = [];
    for (const call of functionCalls) {
      const args = parseArgs(call.arguments);
      const result = await bridge.call(String(call.name), args);
      calls.push({ name: String(call.name), args, output: result });
      input.push({ type: 'function_call_output', call_id: call.call_id, output: result.text });
    }
  }
  return { finalText, calls, usage };
}

/** Reads a credential from the run's configured command. Returns undefined when it is not there; the value is never logged. */
export async function readAgentKey(spec: Pick<AgentSpec, 'keyCommand'>): Promise<string | undefined> {
  if (!spec.keyCommand || spec.keyCommand.length === 0) return undefined;
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    let out = '';
    const child = spawn(spec.keyCommand![0]!, spec.keyCommand!.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const key = out.trim();
      resolve(code === 0 && key.length > 0 ? key : undefined);
    });
  });
}
