// The engine's directory endpoint (`/openai/mcp`) serves the listing submitted
// to OpenAI (connect-relay/server/directory/approved.ts) while its calls run
// the current code (src/workers/chatgpt/directory-surface.ts):
//
// - The pin: the allowlist names exactly the submitted tools, and each
//   submitted page's `?v=` is its own content hash.
// - The listing: tools/list serves the submitted definitions of the tools the
//   surface lists in every conditional state, and tools/list, resources/list
//   and resources/read equal the relay's own answers on that endpoint, so an
//   engine coming online or going offline changes nothing OpenAI scans.
//   `/mcp` keeps the current listing.
// - The contract: every submitted tool still has a current handler with the
//   same annotations and auth, whose input schema accepts everything the
//   submitted schema allows; every value the submitted schemas enumerate
//   reaches the handler without an invalid_params refusal.
// - The pages: the submitted dashboard, private answer panel and private
//   question panel, run in happy-dom against results from the current surface
//   and the current private job handlers, still render them end to end.
//
// A failure here means an engine change would change the reviewed listing or
// break the reviewed pages: keep the change on `/mcp` only, or make it a new
// submission (chatgpt-plugin/SUBMISSION.md).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  APPROVED_DASHBOARD_CONTENTS,
  APPROVED_PRIVATE_ANSWER_CONTENTS,
  APPROVED_PRIVATE_QUESTION_CONTENTS,
  APPROVED_RESOURCES,
  APPROVED_TOOLS,
} from '../connect-relay/server/directory/approved.ts';
import { relayMcpResponse } from '../connect-relay/server/relay-mcp.ts';
import { DIRECTORY_TOOL_NAMES } from '../connect-relay/shared/directory-tools.ts';
import generatedSurface from '../connect-relay/server/generated/chatgpt-tools.json';
import { answerPrivately, type BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { defaultConfig } from '../src/core/config.ts';
import type { DashboardSourceCard, SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { DASHBOARD_RESOURCE_URI } from '../src/workers/chatgpt/dashboard-contract.ts';
import { versionedResourceUri } from '../src/workers/chatgpt/dashboard-resource.ts';
import { createChatGptDirectoryMcpServer, withApprovedPages } from '../src/workers/chatgpt/directory-surface.ts';
import { CHATGPT_TOOLS, createChatGptMcpServer, type ChatGptSurfaceOptions } from '../src/workers/chatgpt/mcp-surface.ts';
import { PRIVATE_ANSWER_META_KEY, PRIVATE_ANSWER_RESOURCE_URI, type PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';
import { PrivateAnswerJobs, createPrivateAnswerHandler, type PrivateAnswerWaitingRef } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { generatePanelKeyPair } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { createBuiltInPrivateAnswerModel } from '../src/workers/chatgpt/private-answer-model.ts';
import { PRIVATE_QUESTION_META_KEY, PRIVATE_QUESTION_RESOURCE_URI } from '../src/workers/chatgpt/private-question-contract.ts';
import { PrivateQuestionJobs, type PrivateQuestionAskInput } from '../src/workers/chatgpt/private-question-jobs.ts';
import { ChatGptSurfaceError } from '../src/workers/chatgpt/response-builder.ts';
import { NO_SECRET_LOCATIONS } from '../src/workers/chatgpt/scope-privacy.ts';
import type { ChatGptSetupBackend } from '../src/workers/chatgpt/setup-tools.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createInProcessOperationContext } from '../src/workers/remote-mcp.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';

const INSTALL_ID = 'abcdefghijklmnopqrstuvwxyz234567';
const PANEL_ORIGIN = 'https://web-sandbox.oaiusercontent.com';
const PRIVATE_PASSAGE = 'The lease on the flat ends on 31 May 2027.';
const PRIVATE_HITS: PrivateEvidenceItem[] = [{
  sourceItem: { family: 'email', provider: 'gmail', accountScope: 'personal', providerItemId: 'm-1', localItemId: 'personal:m-1' },
  provenance: { citation: { title: 'Lease renewal', sourceLabel: 'Gmail', authoredAt: '2026-04-01' } },
  internalContent: { kind: 'bounded_item_passage', passage: PRIVATE_PASSAGE, passageChars: PRIVATE_PASSAGE.length, truncated: false, sourceTextReturned: true },
  selected_item: { corpus_id: 'secure_local.email' },
  rawExposed: false,
}];
const QUESTION = 'My landlord wants 40% more rent next year. What are my options?';
const ANONYMOUS_ANSWER = 'A tenant can usually negotiate, invoke a renewal clause, or move.';

type Tool = { name: string; inputSchema: JsonSchema; annotations?: unknown; securitySchemes?: unknown; _meta?: Record<string, unknown> };
type ToolResult = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, any>; _meta?: Record<string, any>; isError?: boolean };

/* ------------------------------------------------------------------ */
/* The surface under test                                              */
/* ------------------------------------------------------------------ */

let answerModel: boolean;
let readOnly: boolean;
let dashboardView: SourceDashboardViewModel;
let jobs: PrivateAnswerJobs;
let questions: PrivateQuestionJobs;
let asked: PrivateQuestionAskInput[];
let setup: ChatGptSetupBackend;
/** Waiting questions recorded at a Private match, and those a panel's answer acknowledged. */
let waitingRecorded: PrivateAnswerWaitingRef[];
let acknowledged: PrivateAnswerWaitingRef[];

function stubPanelModel() {
  const model: BuiltInAnalystModel = {
    name: 'built_in',
    spec: QWEN35_4B,
    async prepare() {},
    status: () => ({ state: 'ready', modelId: QWEN35_4B.modelId, percent: 100, label: '', bytesDone: 0, bytesTotal: 0, updatedAt: new Date(0).toISOString() }),
    async stop() {},
    async complete() {
      return {
        text: JSON.stringify({ answer: 'The lease ends on 31 May 2027 [1].', citations: [{ evidence: 1, claim: 'The lease ends on 31 May 2027.' }], unanswered: [], sufficient: true }),
        modelId: `built_in/${QWEN35_4B.modelId}`,
      };
    },
  };
  return createBuiltInPrivateAnswerModel({ eligible: async (items) => items.map(() => true), model, available: () => true, answer: answerPrivately });
}

/** A setup backend whose every method answers "unavailable": a call that reaches it got past argument checks. */
const unreachableBackend = new Proxy({}, {
  get: (_target, key) => (key === 'directSignIn' || key === 'privacyConfirmationScope' || key === 'then' ? undefined : () => { throw new ChatGptSurfaceError('unavailable'); }),
}) as ChatGptSetupBackend;

function surface(): ChatGptSurfaceOptions {
  return {
    dashboardView: async () => dashboardView,
    answerModelAvailable: () => answerModel,
    readOnly,
    privateAnswers: jobs,
    privateQuestions: questions,
    privateMatchProbe: async () => ({ count: 1, evidence: PRIVATE_HITS }),
    evidenceSearch: async () => ({
      evidence: [{ trust_domain: 'internal', family: 'file', provider: 'google_drive', title: 'Flat inventory', excerpt: 'Two chairs and a table.' }],
      coverage: { searched_corpora: 1, unreadable_items: 0, partially_read_items: 0, unclassified_items: 0 },
    }),
    setup,
    waitingQuestions: () => ({
      ticket: (connectionId) => ({ connectionId, revocation: 0 }),
      record: (ticket) => {
        const ref = { id: `w-${waitingRecorded.length + 1}`, generation: 1, connectionId: ticket.connectionId };
        waitingRecorded.push(ref);
        return ref;
      },
    }),
  };
}

beforeEach(() => {
  answerModel = true;
  readOnly = false;
  dashboardView = sampleView();
  const panelModel = stubPanelModel();
  waitingRecorded = [];
  acknowledged = [];
  jobs = new PrivateAnswerJobs({
    eligible: async (items) => items.map(() => true),
    model: () => panelModel,
    installId: () => INSTALL_ID,
    claimHoldMs: 0,
    acknowledge: (ref) => { acknowledged.push(ref); },
  });
  asked = [];
  setup = unreachableBackend;
  questions = new PrivateQuestionJobs({
    installId: () => INSTALL_ID,
    ask: async (input) => {
      asked.push(input);
      return { ok: true, sent: input.question, reply: ANONYMOUS_ANSWER, route: 'zkapi', networkIdentity: 'hidden', level: 'standard', cleanup: 'as_written', rewritten: false, remembered: false, model: 'anthropic/claude-sonnet-5.5' };
    },
    choice: () => ({ level: 'standard', cleanup: 'as_written', customInstruction: false }),
    connectionActive: () => true,
    dailyLimit: () => 'available',
  });
});

type Endpoint = (method: string, params?: Record<string, unknown>) => Promise<{ result?: any; error?: { code: number; message: string } }>;

/**
 * One endpoint, as the remote handler serves a ChatGPT connection: a fresh
 * server per request, and the raw JSON-RPC answer (an SDK client would drop
 * fields it does not know, such as securitySchemes).
 */
function connect(endpoint: 'directory' | 'mcp'): Endpoint {
  const worker = createEmailSourceWorker({});
  const config = { ...defaultConfig(), sourceIndex: { ...defaultConfig().sourceIndex, enabled: true } };
  const ctx = () => createInProcessOperationContext({
    config,
    sourceIndexReadEnabled: true,
    workerFetch: worker.fetch,
    caller: { surface: 'remote', connectionId: 'conn-1', displayName: 'ChatGPT' },
  });
  return async (method, params = {}) => {
    const server: Server = endpoint === 'directory' ? createChatGptDirectoryMcpServer(ctx, surface(), ctx) : createChatGptMcpServer(ctx, surface(), ctx);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const reply = new Promise<any>((resolve) => { clientSide.onmessage = resolve; });
    await clientSide.start();
    await clientSide.send({ jsonrpc: '2.0', id: 1, method, params });
    const message = await reply;
    await server.close();
    return message;
  };
}

async function listTools(endpoint: Endpoint): Promise<Tool[]> {
  return (await endpoint('tools/list')).result.tools;
}

async function call(endpoint: Endpoint, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await endpoint('tools/call', { name, arguments: args })).result;
}

/** The relay's own answer on the directory endpoint (the Mac offline, a ChatGPT credential). */
async function relayAnswer(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const response = relayMcpResponse({
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    now: Date.now(),
    surface: 'directory',
    state: 'mac_offline',
    lastSeenAt: undefined,
    credentialSurface: 'chatgpt',
  });
  return ((await response.json()) as { result: unknown }).result;
}

const names = (tools: ReadonlyArray<{ name: string }>) => tools.map((tool) => tool.name);
const approvedNamed = (listed: string[]) => APPROVED_TOOLS.filter((tool) => listed.includes(tool.name));

/* ------------------------------------------------------------------ */
/* The pin                                                             */
/* ------------------------------------------------------------------ */

describe('the submitted listing', () => {
  test('names exactly the directory allowlist, and every tool has a current handler', () => {
    expect(names(APPROVED_TOOLS)).toEqual([...DIRECTORY_TOOL_NAMES]);
    for (const tool of APPROVED_TOOLS) expect(names(CHATGPT_TOOLS)).toContain(tool.name);
  });

  test('each page is served under its own content hash, and every tool names a listed page', () => {
    const pages = [
      [DASHBOARD_RESOURCE_URI, APPROVED_DASHBOARD_CONTENTS],
      [PRIVATE_ANSWER_RESOURCE_URI, APPROVED_PRIVATE_ANSWER_CONTENTS],
      [PRIVATE_QUESTION_RESOURCE_URI, APPROVED_PRIVATE_QUESTION_CONTENTS],
    ] as const;
    expect(APPROVED_RESOURCES.map((resource) => resource.uri)).toEqual(pages.map(([base, contents]) => versionedResourceUri(base, contents[0]!.text)));
    const listed = new Set(APPROVED_RESOURCES.map((resource) => resource.uri));
    for (const tool of APPROVED_TOOLS as readonly Tool[]) {
      const meta = tool._meta as { ui?: { resourceUri?: string }; 'openai/outputTemplate'?: string } | undefined;
      if (meta?.ui?.resourceUri) expect(listed.has(meta.ui.resourceUri)).toBe(true);
      if (meta?.['openai/outputTemplate']) expect(meta['openai/outputTemplate']).toBe(meta.ui?.resourceUri as string);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The listing                                                         */
/* ------------------------------------------------------------------ */

describe('/openai/mcp lists what the surface decides, as submitted', () => {
  test('every state lists the submitted definitions of the tools /mcp lists', async () => {
    for (const state of [{ answerModel: true, readOnly: false }, { answerModel: false, readOnly: false }, { answerModel: true, readOnly: true }]) {
      ({ answerModel, readOnly } = state);
      const onMcp = await listTools(connect('mcp'));
      const onDirectory = await listTools(connect('directory'));
      expect(names(onDirectory)).toEqual(names(onMcp));
      expect(onDirectory).toEqual(approvedNamed(names(onMcp)) as unknown as Tool[]);
      // /mcp keeps the current definitions.
      expect(onMcp).toEqual(CHATGPT_TOOLS.filter((tool) => names(onMcp).includes(tool.name)) as unknown as Tool[]);
    }
    // The states differ the way the surface decides.
    ({ answerModel, readOnly } = { answerModel: false, readOnly: false });
    expect(names(await listTools(connect('directory')))).not.toContain('source_answer');
    ({ answerModel, readOnly } = { answerModel: true, readOnly: true });
    expect(names(await listTools(connect('directory')))).not.toContain('ask_anonymously');
  });

  test('tools, resources and every page read equal the relay\'s answers on the same endpoint', async () => {
    const directory = connect('directory');
    expect((await directory('tools/list')).result).toEqual(await relayAnswer('tools/list'));
    expect((await directory('resources/list')).result).toEqual(await relayAnswer('resources/list'));
    const current = generatedSurface.resources.map((resource) => resource.uri);
    const asked = [
      ...APPROVED_RESOURCES.map((resource) => resource.uri),
      ...APPROVED_RESOURCES.map((resource) => resource.uri.split('?')[0]!),
      // A result cached from /mcp names the current page; the directory still reads the submitted one.
      ...current,
      `${DASHBOARD_RESOURCE_URI}?v=000000000000`,
    ];
    for (const uri of asked) {
      const read = (await directory('resources/read', { uri })).result;
      expect(read).toEqual(await relayAnswer('resources/read', { uri }));
      const base = uri.split('?')[0];
      const approved = [APPROVED_DASHBOARD_CONTENTS, APPROVED_PRIVATE_ANSWER_CONTENTS, APPROVED_PRIVATE_QUESTION_CONTENTS].find((contents) => contents[0]!.uri.startsWith(`${base}?`))!;
      expect(read.contents).toEqual(approved);
    }
    expect((await directory('resources/read', { uri: 'ui://olympus/unknown' })).error).toBeDefined();
  });

  test('/mcp still lists and reads the current pages', async () => {
    const mcp = connect('mcp');
    expect((await mcp('resources/list')).result.resources).toEqual(generatedSurface.resources);
    for (const { uri } of generatedSurface.resources) {
      expect((await mcp('resources/read', { uri })).result.contents[0].uri).toBe(uri);
    }
  });

  test('a result naming a page names the submitted page there, the current one on /mcp', async () => {
    const onDirectory = await call(connect('directory'), 'open_private_question');
    const onMcp = await call(connect('mcp'), 'open_private_question');
    const approvedUri = APPROVED_RESOURCES.find((resource) => resource.uri.startsWith(`${PRIVATE_QUESTION_RESOURCE_URI}?`))!.uri;
    const currentUri = generatedSurface.resources.find((resource) => resource.uri.startsWith(`${PRIVATE_QUESTION_RESOURCE_URI}?`))!.uri;
    expect(onDirectory._meta).toMatchObject({ ui: { resourceUri: approvedUri }, 'openai/outputTemplate': approvedUri });
    expect(onMcp._meta).toMatchObject({ ui: { resourceUri: currentUri }, 'openai/outputTemplate': currentUri });
    expect(onDirectory._meta![PRIVATE_QUESTION_META_KEY]).toBeDefined();
    expect(Object.keys(onDirectory._meta!).sort()).toEqual(Object.keys(onMcp._meta!).sort());

    // Every page, any version; anything else is left as it is.
    for (const resource of APPROVED_RESOURCES) {
      const base = resource.uri.split('?')[0]!;
      const rewritten = withApprovedPages({ content: [], _meta: { ui: { resourceUri: `${base}?v=0123456789ab`, prefersBorder: false }, 'openai/outputTemplate': base, other: 1 } });
      expect(rewritten._meta).toEqual({ ui: { resourceUri: resource.uri, prefersBorder: false }, 'openai/outputTemplate': resource.uri, other: 1 });
    }
    const untouched = { content: [], _meta: { ui: { resourceUri: 'ui://other/page?v=0123456789ab' }, 'openai/outputTemplate': 'ui://other/page' } };
    expect(withApprovedPages(untouched)).toEqual(untouched);
    expect(withApprovedPages({ content: [] })).toEqual({ content: [] });
  });
});

/* ------------------------------------------------------------------ */
/* The contract                                                        */
/* ------------------------------------------------------------------ */

interface JsonSchema {
  type?: string;
  enum?: readonly unknown[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/**
 * Where `current` refuses something `submitted` allows, as readable paths.
 * Covers the keywords these schemas use; an unknown keyword in either is
 * itself reported, so a new kind of constraint cannot pass unchecked.
 */
function narrowings(submitted: JsonSchema, current: JsonSchema, path = '$'): string[] {
  const known = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description']);
  const issues: string[] = [];
  for (const key of new Set([...Object.keys(submitted), ...Object.keys(current)])) if (!known.has(key)) issues.push(`${path}: unchecked keyword ${key}`);
  if (current.type !== undefined && current.type !== submitted.type) issues.push(`${path}: type ${submitted.type} became ${current.type}`);
  if (current.enum) {
    if (!submitted.enum) issues.push(`${path}: now limited to ${current.enum.join(', ')}`);
    else for (const value of submitted.enum) if (!current.enum.includes(value)) issues.push(`${path}: ${String(value)} no longer accepted`);
  }
  for (const [low, high] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems']] as const) {
    if (current[low] !== undefined && !(submitted[low] !== undefined && submitted[low]! >= current[low]!)) issues.push(`${path}: ${low} raised to ${current[low]}`);
    if (current[high] !== undefined && !(submitted[high] !== undefined && submitted[high]! <= current[high]!)) issues.push(`${path}: ${high} lowered to ${current[high]}`);
  }
  for (const name of current.required ?? []) if (!(submitted.required ?? []).includes(name)) issues.push(`${path}.${name}: now required`);
  // What each schema accepts for a key it does not name: anything (absent or true), nothing (false), or a schema.
  const extra = (schema: JsonSchema): JsonSchema | boolean => schema.additionalProperties ?? true;
  const submittedExtra = extra(submitted);
  const currentExtra = extra(current);
  /** Where `now` refuses a value `before` accepted for one key. */
  const keyNarrowings = (before: JsonSchema | boolean, now: JsonSchema | boolean, at: string): string[] => {
    if (before === false || now === true) return [];
    if (now === false) return [`${at}: no longer accepted`];
    if (before === true) return [`${at}: now constrained`];
    return narrowings(before, now, at);
  };
  for (const [name, property] of Object.entries(submitted.properties ?? {})) {
    issues.push(...keyNarrowings(property, current.properties?.[name] ?? currentExtra, `${path}.${name}`));
  }
  for (const [name, property] of Object.entries(current.properties ?? {})) {
    if (!submitted.properties?.[name]) issues.push(...keyNarrowings(submittedExtra, property, `${path}.${name}`));
  }
  issues.push(...keyNarrowings(submittedExtra, currentExtra, `${path}.*`).map((issue) => issue.replace(/\.\*: no longer accepted$/, ': extra properties now refused')));
  if (submitted.items && current.items) issues.push(...narrowings(submitted.items, current.items, `${path}[]`));
  else if (current.items) issues.push(`${path}[]: items now constrained`);
  return issues;
}

const PRIVACY_REVISION = 'rev-1';

/**
 * A value of `schema` a real caller would send. Strings the handlers read for
 * meaning (addresses, picker cursors) get realistic values by property name;
 * everything else is a plain value of its type, with every property filled.
 */
function sampleValue(schema: JsonSchema, name: string, siblings: Record<string, unknown> = {}): unknown {
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      if (/senders$/.test(name)) return 'friend@example.com';
      // A picker cursor is the one olympus_scope_list issued for the same parent.
      if (name === 'cursor') return `olysort1.${Buffer.from(JSON.stringify({ p: siblings.parent_key ?? '', n: 'A', k: 'id-a' })).toString('base64url')}`;
      if (name === 'revision') return PRIVACY_REVISION;
      return 'x';
    case 'integer': case 'number': return schema.minimum ?? 1;
    case 'boolean': return true;
    case 'array': return [sampleValue(schema.items ?? {}, name)];
    case 'object': {
      const value: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(schema.properties ?? {})) value[key] = sampleValue(property, key, value);
      return value;
    }
    default: return undefined;
  }
}

/**
 * Values of `schema` that together send every value it enumerates, at any
 * depth, and both ends of every integer range: each varies one place of the
 * full sample.
 */
function variants(schema: JsonSchema, name: string, fixed: Record<string, unknown> = {}, siblings: Record<string, unknown> = {}): unknown[] {
  if (schema.enum) return [...schema.enum];
  if (schema.type === 'integer' && schema.maximum !== undefined) return [schema.minimum ?? 1, schema.maximum];
  if (schema.type === 'array') return variants(schema.items ?? {}, name).map((item) => [item]);
  if (schema.type !== 'object') return [sampleValue(schema, name, siblings)];
  const base = { ...(sampleValue(schema, name) as Record<string, unknown>), ...fixed };
  const out: unknown[] = [base];
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (key in fixed) continue;
    for (const value of variants(property, key, {}, base)) out.push({ ...base, [key]: value });
  }
  return out;
}

/** Every enumerated value in a schema, at any depth. */
function enumerated(schema: JsonSchema): unknown[] {
  return [
    ...(schema.enum ?? []),
    ...Object.values(schema.properties ?? {}).flatMap(enumerated),
    ...(schema.items ? enumerated(schema.items) : []),
  ];
}

/**
 * Arguments whose meaning ties fields together, sent whole instead of varied
 * field by field: one privacy rule of each kind on each source it applies to.
 * Each must cover every value its submitted schema enumerates.
 */
const FIXED_ARGUMENTS: Record<string, Record<string, unknown>> = {
  olympus_privacy_set: {
    rules: [
      { kind: 'folder', source_id: 'dropbox.files', key: '/Medical', display: 'Medical' },
      { kind: 'folder', source_id: 'google_drive.docs', key: 'folder-id-1', display: 'Taxes' },
      { kind: 'label', source_id: 'gmail.email', key: 'Label_7', value: 'Lawyer' },
      { kind: 'sender', source_id: 'gmail.email', value: 'doctor@example.com' },
    ],
  },
};

/**
 * The scope tools route on source_id: Gmail reads the mail fields, the folder
 * sources the folder fields, and each ignores the other's (the submitted
 * dashboard never sends both). They are swept once per source with only that
 * branch's fields; Gmail's scope_set needs its mail draft.
 */
const SOURCE_ROUTED = new Set(['olympus_scope_list', 'olympus_scope_set']);
const MAIL_FIELDS = ['draft', 'mail'];
const FOLDER_FIELDS = ['parent_key', 'ancestor_keys', 'cursor', 'selections', 'whole_account_selected', 'confirm_whole_account'];

function routed(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
  if (!SOURCE_ROUTED.has(tool.name)) return args;
  const mail = args.source_id === 'gmail.email';
  const out = Object.fromEntries(Object.entries(args).filter(([key]) => !(mail ? FOLDER_FIELDS : MAIL_FIELDS).includes(key)));
  if (mail && tool.name === 'olympus_scope_set' && out.mail === undefined) out.mail = sampleValue(tool.inputSchema.properties!.mail!, 'mail');
  return out;
}

/** The backend operation each setup tool ends in once its arguments are parsed. */
const SETUP_OPERATION: Record<string, RegExp> = {
  olympus_connect_source: /^startOAuth$/,
  olympus_scope_list: /^browse(Mail|Folders)$/,
  olympus_scope_set: /^approve(Mail|Folders)$/,
  olympus_disconnect_source: /^disconnect$/,
  olympus_model_set: /^setModels$/,
  olympus_model_retry: /^retryModel$/,
  olympus_privacy_set: /^savePrivacy$/,
  olympus_sync_source: /^syncSource$/,
};

interface Recorded { method: string; args: unknown[] }

/**
 * A setup backend for an install with nothing saved: its reads answer (no
 * Secrets locations, no privacy settings at PRIVACY_REVISION, no saved
 * choices); every operation is recorded and then answers "unavailable".
 */
function recordingBackend(recorded: Recorded[]): ChatGptSetupBackend {
  const reads: Record<string, unknown> = {
    secretLocations: () => NO_SECRET_LOCATIONS,
    privacySettings: () => ({ configured: false, description: '', rules: [], pendingCount: 0, revision: PRIVACY_REVISION }),
    savedFolderSelections: () => [],
    savedMailDraft: () => undefined,
  };
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== 'string' || key === 'then' || key === 'directSignIn' || key === 'privacyConfirmationScope') return undefined;
      if (key in reads) return reads[key];
      return (...args: unknown[]) => {
        recorded.push({ method: key, args });
        throw new ChatGptSurfaceError('unavailable');
      };
    },
  }) as ChatGptSetupBackend;
}

interface Leaf { path: Array<string | number>; value: unknown }

function leaves(value: unknown, path: Array<string | number> = []): Leaf[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, [...path, index]));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key]));
  return [{ path, value }];
}

/**
 * The enumerated values in `sent` that did not reach the operation where they
 * were sent. A nested value must arrive at the same place: the same field
 * names and array positions below the top-level argument (the operation may
 * rename that, as mail becomes draft), each received value used once. A
 * top-level value may arrive anywhere, once.
 */
function undelivered(sent: Record<string, unknown>, received: unknown[], options: ReadonlySet<unknown>, skip: readonly string[] = []): string[] {
  const wanted = leaves(sent).filter((leaf) => options.has(leaf.value) && !skip.includes(String(leaf.path[0])));
  const available = leaves(received);
  const used = new Set<Leaf>();
  const lost: string[] = [];
  for (const leaf of [...wanted].sort((a, b) => b.path.length - a.path.length)) {
    const below = leaf.path.slice(1);
    const match = available.find((candidate) => !used.has(candidate) && candidate.value === leaf.value
      && (below.length === 0 || (candidate.path.length > below.length && below.every((segment, index) => candidate.path[candidate.path.length - below.length + index] === segment))));
    if (match) used.add(match);
    else lost.push(`${leaf.path.join('.')}=${String(leaf.value)}`);
  }
  return lost;
}

/**
 * Sends every argument set `tools`' schemas allow to the directory endpoint:
 * the required arguments alone, then the variants. A setup tool passes only
 * when its backend operation ran and received every enumerated value sent; any
 * other tool only when it was not refused. Returns what failed.
 */
async function sweep(tools: readonly Tool[]): Promise<{ failures: string[]; sent: number }> {
  const recorded: Recorded[] = [];
  setup = recordingBackend(recorded);
  const directory = connect('directory');
  const failures: string[] = [];
  let sent = 0;
  for (const tool of tools) {
    const schema = tool.inputSchema;
    const fixed = FIXED_ARGUMENTS[tool.name] ?? {};
    for (const [key, value] of Object.entries(fixed)) {
      const missing = enumerated(schema.properties![key]!).filter((option) => !JSON.stringify(value).includes(JSON.stringify(option)));
      if (missing.length) failures.push(`${tool.name}.${key}: fixture never sends ${missing.join(', ')}`);
    }
    const runs = SOURCE_ROUTED.has(tool.name)
      ? (schema.properties!.source_id!.enum as string[]).map((sourceId) => ({ ...fixed, source_id: sourceId }))
      : [fixed];
    const sets = runs.flatMap((run) => {
      const all = variants(schema, tool.name, run) as Array<Record<string, unknown>>;
      const required = Object.fromEntries(Object.entries(all[0]!).filter(([key]) => (schema.required ?? []).includes(key)));
      return [required, ...all].map((args) => routed(tool, args));
    });
    for (const args of sets) {
      // A save that lowers protection carries the panel's confirmation, issued by olympus_privacy_get.
      if ('confirmation' in args) args.confirmation = (await call(directory, 'olympus_privacy_get'))._meta?.['olympus/privacy']?.confirmation;
      recorded.length = 0;
      const result = await call(directory, tool.name, args);
      sent += 1;
      const label = `${tool.name} ${JSON.stringify(args)}`;
      const error = result.structuredContent?.error;
      const operation = SETUP_OPERATION[tool.name];
      if (!operation) {
        if (error === 'invalid_params' || error === 'unknown_tool') failures.push(`${label}: ${error}`);
        continue;
      }
      const ran = recorded.find((entry) => operation.test(entry.method));
      if (!ran) {
        failures.push(`${label}: ${error ?? 'answered'} before ${operation.source}`);
        continue;
      }
      // Gmail's own operations take no source id: the route is the value.
      const lost = undelivered(args, ran.args, new Set(enumerated(schema)), /Mail$/.test(ran.method) ? ['source_id'] : []);
      if (lost.length) failures.push(`${label}: ${ran.method} never received ${lost.join(', ')}`);
    }
  }
  return { failures, sent };
}

describe('the current handlers honour the submitted contract', () => {
  test('same annotations and auth, and every input the submitted schema allows is still accepted', () => {
    const issues: string[] = [];
    for (const submitted of APPROVED_TOOLS as unknown as Tool[]) {
      const current = CHATGPT_TOOLS.find((tool) => tool.name === submitted.name)!;
      expect({ name: current.name, annotations: current.annotations, securitySchemes: current.securitySchemes })
        .toEqual({ name: submitted.name, annotations: submitted.annotations as never, securitySchemes: submitted.securitySchemes as never });
      issues.push(...narrowings(submitted.inputSchema, current.inputSchema as JsonSchema, submitted.name));
    }
    expect(issues).toEqual([]);
  });

  test('the narrowing check catches a refused value, a new requirement and a tighter bound', () => {
    const submitted: JsonSchema = { type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] }, n: { type: 'integer', minimum: 1, maximum: 48 } }, additionalProperties: false };
    expect(narrowings(submitted, submitted)).toEqual([]);
    expect(narrowings(submitted, { ...submitted, properties: { ...submitted.properties, a: { type: 'string', enum: ['x', 'y', 'z'] } } })).toEqual([]);
    expect(narrowings(submitted, { ...submitted, properties: { ...submitted.properties, a: { type: 'string', enum: ['x'] } } })).toEqual(['$.a: y no longer accepted']);
    expect(narrowings(submitted, { ...submitted, required: ['a'] })).toEqual(['$.a: now required']);
    expect(narrowings(submitted, { ...submitted, properties: { ...submitted.properties, n: { type: 'integer', minimum: 1, maximum: 24 } } })).toEqual(['$.n: maximum lowered to 24']);
    expect(narrowings(submitted, { ...submitted, properties: { n: submitted.properties!.n! } })).toEqual(['$.a: no longer accepted']);
    expect(narrowings(submitted, { ...submitted, properties: { ...submitted.properties, a: { type: 'string', pattern: '^x$' } as JsonSchema } })).toEqual(['$.a: unchecked keyword pattern']);
    // Extra keys: a key the submitted schema left open may not gain a type, and open extras may not close or narrow.
    const open: JsonSchema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    expect(narrowings(open, { ...open, properties: { ...open.properties, tag: { type: 'string' } } })).toEqual(['$.tag: now constrained']);
    expect(narrowings(open, { ...open, additionalProperties: false })).toEqual(['$: extra properties now refused']);
    expect(narrowings(open, { ...open, additionalProperties: { type: 'string' } })).toEqual(['$.*: now constrained']);
    const typedExtras: JsonSchema = { ...open, additionalProperties: { type: 'string', maxLength: 10 } };
    expect(narrowings(typedExtras, { ...open, additionalProperties: { type: 'string', maxLength: 5 } })).toEqual(['$.*: maxLength lowered to 5']);
    expect(narrowings(typedExtras, { ...open, properties: { ...open.properties, tag: { type: 'string', maxLength: 5 } } })).toEqual(['$.tag: maxLength lowered to 5']);
    // A closed submitted schema: new optional properties are fine (no submitted caller sends them).
    expect(narrowings(submitted, { ...submitted, properties: { ...submitted.properties, extra: { type: 'string' } } })).toEqual([]);
  });

  test('every argument set the submitted schemas allow is parsed and reaches the backend with its values', async () => {
    // These run an engine operation end to end; their arguments are held by the schema check above.
    const operations = new Set(['source_answer', 'source_answer_result', 'ask_anonymously']);
    const { failures, sent } = await sweep((APPROVED_TOOLS as unknown as Tool[]).filter((tool) => !operations.has(tool.name)));
    expect(failures).toEqual([]);
    expect(sent).toBeGreaterThan(80);
  });

  test('the delivery check finds a value lost from one place although the same value arrived elsewhere', () => {
    const rules = [
      { kind: 'label', source_id: 'gmail.email', key: 'Label_7', value: 'Lawyer' },
      { kind: 'sender', source_id: 'gmail.email', value: 'doctor@example.com' },
    ];
    const options = new Set(['label', 'sender', 'gmail.email', 'dropbox']);
    expect(undelivered({ rules }, [{ description: 'x', rules }], options)).toEqual([]);
    const dropped = [{ kind: 'label', key: 'Label_7', value: 'Lawyer' }, rules[1]];
    expect(undelivered({ rules }, [{ rules: dropped }], options)).toEqual(['rules.0.source_id=gmail.email']);
    const swapped = [{ ...rules[0], kind: 'sender' }, rules[1]];
    expect(undelivered({ rules }, [{ rules: swapped }], options)).toEqual(['rules.0.kind=label']);
    // A top-level value may arrive under another name, but must arrive.
    expect(undelivered({ source: 'dropbox' }, ['dropbox'], options)).toEqual([]);
    expect(undelivered({ source: 'dropbox' }, ['google-drive'], options)).toEqual(['source=dropbox']);
    expect(undelivered({ source_id: 'gmail.email' }, [{}], options, ['source_id'])).toEqual([]);
  });

  test('the sweep fails when a handler refuses a value the submitted schema allows, at any depth', async () => {
    const tool = (name: string) => structuredClone((APPROVED_TOOLS as unknown as Tool[]).find((entry) => entry.name === name)!);
    const connectSource = tool('olympus_connect_source');
    (connectSource.inputSchema.properties!.source as { enum: string[] }).enum.push('icloud');
    const scopeSet = tool('olympus_scope_set');
    (scopeSet.inputSchema.properties!.mail!.properties!.window as { enum: string[] }).enum.push('10y');
    const { failures } = await sweep([connectSource, scopeSet]);
    expect(failures.some((failure) => failure.includes('"icloud"') && failure.includes('invalid_params'))).toBe(true);
    expect(failures.some((failure) => failure.includes('"10y"') && failure.includes('invalid_params'))).toBe(true);
    expect(failures).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* The pages                                                           */
/* ------------------------------------------------------------------ */

const NOW = new Date();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function card(sourceId: string, patch: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return {
    corpus_id: 'internal.email',
    source_id: sourceId,
    label: sourceId,
    provider: sourceId.split('.')[0]!,
    family: 'email',
    trust_domain: 'secure_local',
    configured: true,
    freshness: { label: 'Last checked less than 1 hour ago', stale: false, hours: 0.2 },
    coverage: { indexed_items: 100, content_ready_items: 100, embedded_items: 200, needs_review_items: 0 },
    ingestion_health: { coverage_percent: 100, stuck_count: 0, drain_state: 'enabled', label: 'ok' },
    tier_composition: [],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: { state: 'synced', label: 'synced less than 1 hour ago', action: { kind: 'none' }, handles: [] },
    ...patch,
  } as DashboardSourceCard;
}

function sampleView(): SourceDashboardViewModel {
  const sources = [
    card('gmail.email'),
    card('google_drive.docs', {
      family: 'file',
      coverage: { indexed_items: 10, content_ready_items: 2, embedded_items: 0 },
      connection: { state: 'syncing', label: 'syncing', action: { kind: 'none' }, handles: [] },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
      queue_health: { label: 'Working now', waiting: 3, active: 1, needs_attention: 0 },
    } as unknown as Partial<DashboardSourceCard>),
    card('dropbox.files', {
      family: 'file',
      configured: false,
      coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0 },
      connection: { state: 'not_connected', label: 'not connected', action: { kind: 'oauth', source: 'dropbox', label: 'Connect' }, handles: [] },
    } as unknown as Partial<DashboardSourceCard>),
  ];
  return {
    kind: 'source_dashboard',
    generated_at: NOW.toISOString(),
    summary: { configured_sources: 3, connected_sources: 2, answer_ready_sources: 1, needs_attention_sources: 0, total_indexed_items: 110, total_content_ready_items: 102 },
    onboarding: { steps: [], ask_first_question: { enabled: false, label: 'Ask your first question', suggestion: 'x' } },
    answer_lanes: [],
    where_your_data_lives: [],
    unassigned_corpora: { corpus_count: 0, indexed_items: 0, content_ready_items: 0, entries: [] },
    excluded_by_configuration: { rules: 0, prefixes: 0, items_present: 0, items_unevaluable: 0, entries: [] },
    folder_picker: { available: false, label: 'Choose folders', path: '/dashboard/dispositions', rules: 0 },
    sources,
    history: { sample_count: 0, eta_available: false },
  } as unknown as SourceDashboardViewModel;
}

interface Page {
  win: Window;
  sent: any[];
  calls: Array<[string, unknown]>;
  text(): string;
  buttons(): HTMLButtonElement[];
  push(result: unknown): void;
  respond(request: { id: number }, result: unknown): void;
  until(check: () => boolean, label: string, ms?: number): Promise<void>;
}

const pages: Page[] = [];
afterEach(async () => {
  while (pages.length) await pages.pop()!.win.happyDOM.close();
});

/**
 * A submitted page in happy-dom under a fake MCP Apps host (JSON-RPC over
 * postMessage, plus window.openai), its relay requests answered by `relay`.
 */
function mountSubmitted(html: string, root: string, relay?: (request: Request) => Promise<Response>): Page {
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: `${PANEL_ORIGIN}/` });
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: any[] = [];
  const calls: Page['calls'] = [];
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const parent = {
    postMessage: (message: any) => {
      sent.push(message);
      if (message.method === 'ui/initialize') setTimeout(() => dispatch({ jsonrpc: '2.0', id: message.id, result: { hostContext: { theme: 'light' } } }), 0);
    },
  };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  Object.defineProperty(win, 'crypto', { value: globalThis.crypto, configurable: true });
  // No IndexedDB here: the panels keep their key in memory, as in a frame without storage.
  Object.defineProperty(win, 'indexedDB', { value: undefined, configurable: true });
  Object.defineProperty(win, 'fetch', {
    configurable: true,
    // The relay forwards the panel's request to the engine as it came, Origin included.
    value: async (url: string, init: any) => relay
      ? relay(new Request(url, { method: init.method, headers: { ...init.headers, origin: PANEL_ORIGIN }, body: init.body }))
      : new Response(null, { status: 404 }),
  });
  (win as any).openai = {
    notifyIntrinsicHeight: (height: number) => calls.push(['notifyIntrinsicHeight', height]),
    requestDisplayMode: (args: unknown) => calls.push(['requestDisplayMode', args]),
    openExternal: (args: unknown) => calls.push(['openExternal', args]),
    setWidgetState: (args: unknown) => calls.push(['setWidgetState', args]),
    sendFollowUpMessage: (args: unknown) => calls.push(['sendFollowUpMessage', args]),
    requestClose: () => calls.push(['requestClose', undefined]),
  };
  new Function('window', 'document', script)(win, win.document);
  const node = () => win.document.getElementById(root)!;
  const page: Page = {
    win,
    sent,
    calls,
    text: () => node().textContent ?? '',
    buttons: () => Array.from(node().querySelectorAll('button')) as unknown as HTMLButtonElement[],
    push: (result) => dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    respond: (request, result) => dispatch({ jsonrpc: '2.0', id: request.id, result }),
    until: async (check, label, ms = 5_000) => {
      for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(10)) if (check()) return;
      throw new Error(`timed out waiting for ${label}; the page says: ${page.text()}`);
    },
  };
  pages.push(page);
  return page;
}

/** The engine's panel routes, as the relay reaches them. */
function engineRoutes(): (request: Request) => Promise<Response> {
  const handler = createPrivateAnswerHandler({ jobs, questions, isRelayed: () => true });
  return async (request) => {
    const url = new URL(request.url);
    expect(url.origin).toBe('https://mcp.olympusplugin.ai');
    return handler(new Request(`http://127.0.0.1${url.pathname}`, request));
  };
}

describe('the submitted pages render current results', () => {
  test('the dashboard shows the current dashboard result, and its Connect opens the sign-in the current surface returns', async () => {
    const signIn = `https://mcp.olympusplugin.ai/go/oly2g.${INSTALL_ID}.${'A'.repeat(43)}`;
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    setup = new Proxy(unreachableBackend, {
      get: (target, key) => key === 'startOAuth'
        ? async () => ({ authorizationUrl: 'https://accounts.example.test/authorize', expiresAt })
        : key === 'handoffLink' ? () => ({ url: signIn, expiresAt }) : Reflect.get(target, key),
    });
    const client = connect('directory');
    const result = await call(client, 'olympus_dashboard');
    expect(result.isError).toBeFalsy();
    const page = mountSubmitted(APPROVED_DASHBOARD_CONTENTS[0]!.text, 'app');
    page.push(result);
    const labels = (result.structuredContent!.sources as Array<{ label: string }>).map((source) => source.label);
    expect(labels.length).toBe(3);
    await page.until(() => labels.every((label) => page.text().includes(label)), 'every source');

    // The Off source's Connect: the call the page sends goes to the current surface as sent.
    const connectButton = page.buttons().find((button) => button.textContent === 'Connect');
    expect(connectButton).toBeDefined();
    connectButton!.click();
    await page.until(() => page.sent.some((message) => message.method === 'tools/call'), 'the Connect call');
    const request = page.sent.find((message) => message.method === 'tools/call');
    const submitted = (APPROVED_TOOLS as unknown as Tool[]).find((tool) => tool.name === request.params.name)!;
    expect(submitted.name).toBe('olympus_connect_source');
    expect(Object.keys(request.params.arguments).every((key) => key in submitted.inputSchema.properties!)).toBe(true);
    const answered = await call(client, request.params.name, request.params.arguments);
    expect(answered.isError).toBeFalsy();
    page.respond(request, answered);
    await page.until(() => JSON.stringify(page.calls).includes(signIn) || JSON.stringify(page.sent).includes(signIn), 'the sign-in link opened');
  });

  test('the private answer panel collects and shows a Private answer found by the current search', async () => {
    const client = connect('directory');
    const result = await call(client, 'olympus_search', { question: 'When does the lease end?' });
    expect(result._meta?.[PRIVATE_ANSWER_META_KEY]).toMatchObject({ count: 1 });
    const requests: string[] = [];
    const routes = engineRoutes();
    const page = mountSubmitted(APPROVED_PRIVATE_ANSWER_CONTENTS[0]!.text, 'panel', async (request) => {
      requests.push(new URL(request.url).pathname);
      return routes(request);
    });
    page.push(result);
    // The submitted panel may ask before it reveals: press its one button if it offers one.
    await page.until(() => page.text().includes('31 May 2027') || page.buttons().length > 0, 'the panel', 15_000);
    if (!page.text().includes('31 May 2027')) page.buttons()[0]!.click();
    await page.until(() => page.text().includes('31 May 2027'), 'the private answer', 15_000);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((path) => path.startsWith('/private/'))).toBe(true);
    // Nothing of the answer reached the host.
    expect(JSON.stringify(page.sent)).not.toContain('31 May 2027');
    // The submitted panel cannot acknowledge; the delivered answer did, so the question no longer waits on the computer.
    expect(waitingRecorded).toHaveLength(1);
    expect(acknowledged).toEqual(waitingRecorded);
  }, 30_000);

  test('a delivered answer counts as seen only on the directory; /mcp still waits for the panel\'s acknowledgment', async () => {
    const collect = async (endpoint: 'directory' | 'mcp') => {
      const result = await call(connect(endpoint), 'olympus_search', { question: 'When does the lease end?' });
      const { jobId } = result._meta![PRIVATE_ANSWER_META_KEY] as { jobId: string };
      const panel = await generatePanelKeyPair();
      const routes = engineRoutes();
      const claim = () => routes(new Request(`https://mcp.olympusplugin.ai/private/${jobId}`, {
        method: 'POST',
        headers: { origin: PANEL_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, publicKey: panel.publicKey }),
      }));
      let response = await claim();
      for (let i = 0; i < 200 && response.status === 202; i += 1) {
        await sleep(10);
        response = await claim();
      }
      expect(((await response.json()) as { status: string }).status).toBe('ready');
      // Collecting again (a re-mount) acknowledges nothing more.
      expect((await claim()).status).toBe(200);
    };
    await collect('mcp');
    expect(waitingRecorded).toHaveLength(1);
    expect(acknowledged).toEqual([]);
    await collect('directory');
    expect(waitingRecorded).toHaveLength(2);
    expect(acknowledged).toEqual([waitingRecorded[1]!]);
  }, 15_000);

  test('the private question panel asks through the current job handler and shows the answer', async () => {
    const client = connect('directory');
    const result = await call(client, 'open_private_question');
    expect(result.structuredContent).toEqual({ status: 'opened' });
    const page = mountSubmitted(APPROVED_PRIVATE_QUESTION_CONTENTS[0]!.text, 'panel', engineRoutes());
    page.push(result);
    await page.until(() => page.win.document.querySelector('textarea') !== null, 'the question field');
    const field = page.win.document.querySelector('textarea') as unknown as HTMLTextAreaElement;
    field.value = QUESTION;
    field.dispatchEvent(new page.win.Event('input') as unknown as Event);
    const send = page.buttons().find((button) => !button.disabled && /ask|send/i.test(button.textContent ?? ''));
    expect(send).toBeDefined();
    send!.click();
    await page.until(() => page.text().includes(ANONYMOUS_ANSWER), 'the anonymous answer', 20_000);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe(QUESTION);
    // The question and answer never reached the host.
    const toHost = JSON.stringify(page.sent);
    expect(toHost).not.toContain('40%');
    expect(toHost).not.toContain(ANONYMOUS_ANSWER);
  }, 30_000);
});
