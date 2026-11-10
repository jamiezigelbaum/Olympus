import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mainSurface from '../connect-relay/server/generated/chatgpt-tools.json';
import mainDashboard from '../connect-relay/server/generated/chatgpt-dashboard.json';
import mainAnswer from '../connect-relay/server/generated/chatgpt-private-answer.json';
import mainQuestion from '../connect-relay/server/generated/chatgpt-private-question.json';
import { claudeAppDomain } from '../connect-relay/shared/mcp-app-client.ts';
import { configFromPluginConfig, defaultConfig, loadConfig, NATIVE_REMOTE_CONFIG_ENV, parseRemoteConfig } from '../src/core/config.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { parseRemotePublicBaseUrl, remoteMcpResource, type RemotePublicUrls } from '../src/core/remote-public-url.ts';
import { createInProcessOperationContext, createRemoteMcpHandler } from '../src/workers/remote-mcp.ts';
import { grantMcpSurface, isChatGptGrant, CHATGPT_CLIENT_ID, CLAUDE_CLIENT_ID, GROK_CLIENT_ID, CURSOR_CLIENT_ID } from '../src/workers/remote-oauth/pinned-clients.ts';
import { PrivateAnswerJobs } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { PrivateQuestionJobs } from '../src/workers/chatgpt/private-question-jobs.ts';
import { PRIVATE_ANSWER_META_KEY } from '../src/workers/chatgpt/private-answer-contract.ts';
import { PRIVATE_QUESTION_META_KEY } from '../src/workers/chatgpt/private-question-contract.ts';
import { PRIVACY_META_KEY, type PrivacySettings } from '../src/workers/chatgpt/dashboard-contract.ts';
import { NO_SECRET_LOCATIONS } from '../src/workers/chatgpt/scope-privacy.ts';
import type { ChatGptSetupBackend } from '../src/workers/chatgpt/setup-tools.ts';
import type { SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';

const CONNECTOR = 'https://mcp.olympusplugin.ai/mcp';
const DOMAIN = '910049601f0d72593570f870cb6fbf2b.claudemcpcontent.com';
let dir: string;
let store: RemoteConnectionStore;
let urls: RemotePublicUrls;
let enabled: boolean;
let relayed: boolean;
let handler: (request: Request) => Promise<Response>;
let privacy: PrivacySettings;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-claude-app-'));
  store = openRemoteConnectionStore(join(dir, 'connections.sqlite'));
  const resolved = parseRemotePublicBaseUrl('https://mcp.olympusplugin.ai');
  if (!resolved.enabled) throw new Error('test URL');
  urls = resolved.urls;
  enabled = false;
  relayed = true;
  privacy = { configured: true, description: 'ChatGPT is an owner-entered name.', rules: [], pendingCount: 0, revision: 'fixture-revision' };
  const setup = {
    privacySettings: () => privacy,
    secretLocations: () => NO_SECRET_LOCATIONS,
    savePrivacy: (update: { description?: string }) => (privacy = { ...privacy, ...update }),
  } as ChatGptSetupBackend;
  const config = defaultConfig();
  config.sourceIndex.enabled = true;
  handler = createRemoteMcpHandler({
    connections: () => store, publicUrls: urls,
    isRelayed: () => relayed,
    makeOperationContext: (caller, signal) => createInProcessOperationContext({
      config, caller, signal, sourceIndexReadEnabled: true,
      workerFetch: async () => new Response('{}'),
    }),
    claudeApp: { enabled: () => enabled },
    chatgpt: {
      servesRequest: (_request, connection) => relayed && isChatGptGrant(connection),
      dashboardView: async () => ({ sources: [] }) as unknown as SourceDashboardViewModel,
      setup,
      evidenceSearch: async () => ({ evidence: [] }),
      privateMatchProbe: async () => ({ count: 1, evidence: [{ title: 'PRIVATE_ITEM_SENTINEL', trust_domain: 'secure_local' }] }),
      privateAnswers: new PrivateAnswerJobs({
        installId: () => 'a'.repeat(32), eligible: async items => items.map(() => true),
        model: () => ({ status: () => ({ state: 'ready' }), answerPrivately: async () => ({ answer: 'PRIVATE_ANSWER_SENTINEL', citations: [] }) }),
      }),
      privateQuestions: new PrivateQuestionJobs({
        installId: () => 'a'.repeat(32),
        ask: async () => ({ ok: false, code: 'unused', message: 'unused' }),
        choice: () => ({ level: 'standard', cleanup: 'light_cleanup', customInstruction: false }),
        connectionActive: id => store.list().some(connection => connection.id === id && connection.revokedAt === null),
      }),
    },
  });
});

afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function grant(clientId: string, directory = false) {
  return store.oauth.createGrant({ clientId, displayName: 'test connector', resource: remoteMcpResource(urls, directory ? 'directory' : 'default').resource }).tokens.accessToken;
}

async function request(token: string, method: string, params: Record<string, unknown> = {}, directory = false) {
  const response = await handler(new Request(`http://127.0.0.1${directory ? '/openai/mcp' : '/mcp'}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  return { response, body: await response.json() as any };
}

async function listing(token: string): Promise<{ tools: any[]; resources?: any[]; resourceError?: any }> {
  const tools = (await request(token, 'tools/list')).body;
  const resources = (await request(token, 'resources/list')).body;
  return { tools: tools.result.tools, ...(resources.error ? { resourceError: resources.error } : { resources: resources.result.resources }) };
}

describe('Claude MCP App opt-in', () => {
  test('setting defaults off and follows plugin, standalone and native remote configuration', () => {
    expect(defaultConfig().remote?.claudeAppEnabled === true).toBe(false);
    expect(parseRemoteConfig({ enabled: true }).claudeAppEnabled === true).toBe(false);
    for (const value of [false, 'true', 1, null]) expect(parseRemoteConfig({ claudeAppEnabled: value }).claudeAppEnabled).toBe(false);
    expect(configFromPluginConfig({ remote: { claudeAppEnabled: true } }).remote?.claudeAppEnabled).toBe(true);
    mkdirSync(join(dir, '.olympus'));
    writeFileSync(join(dir, '.olympus', 'engine.json'), JSON.stringify({ remote: { claudeAppEnabled: true } }));
    expect(loadConfig({ HOME: dir, OLYMPUS_ENGINE_HOST: '1' }).remote?.claudeAppEnabled).toBe(true);
    expect(loadConfig({ OLYMPUS_CONFIG: join(dir, 'absent.json'), [NATIVE_REMOTE_CONFIG_ENV]: '{"claudeAppEnabled":true}' }, { nativeRemoteHandoff: true }).remote?.claudeAppEnabled).toBe(true);
  });

  test('Claude off, Grok, Cursor, unknown clients and bearer connections keep the remote list', async () => {
    const claude = grant(CLAUDE_CLIENT_ID);
    const baseline = await listing(claude);
    expect(baseline.resourceError.code).toBe(-32601);
    expect(baseline.tools.some((tool: any) => tool.name === 'olympus_dashboard')).toBe(false);
    enabled = true;
    for (const clientId of [GROK_CLIENT_ID, CURSOR_CLIENT_ID, 'unknown-client']) {
      expect(await listing(grant(clientId))).toEqual(baseline);
      expect(grantMcpSurface({ clientId }, true)).toBe('remote');
    }
    expect(await listing(store.create('bearer').token)).toEqual(baseline);
    // A public relay marker is still required, even with a pinned grant.
    relayed = false;
    expect(await listing(claude)).toEqual(baseline);
  });

  test('Claude on gets all App resources, app-only visibility and its exact sandbox domain', async () => {
    enabled = true;
    const token = grant(CLAUDE_CLIENT_ID);
    const surface = await listing(token);
    const dashboard = surface.tools.find((tool: any) => tool.name === 'olympus_dashboard');
    expect(dashboard._meta.ui.resourceUri).toBe(mainSurface.tools[0]!._meta!.ui!.resourceUri!);
    expect(surface.resources).toEqual(mainSurface.resources);
    expect(claudeAppDomain(CONNECTOR)).toBe(DOMAIN);
    expect(claudeAppDomain('https://another.example/mcp')).not.toBe(DOMAIN);
    for (const original of mainSurface.tools) {
      const actual = surface.tools.find((tool: any) => tool.name === original.name);
      expect(actual, original.name).toBeDefined();
      expect(actual._meta).toEqual(original._meta);
      if ((original._meta as any)?.ui?.visibility?.includes('app') && !(original._meta as any)?.ui?.visibility?.includes('model')) {
        expect(actual._meta.ui.visibility).toEqual(['app']);
      }
    }
    expect(JSON.stringify(surface.tools)).not.toContain('ChatGPT');
    for (const resource of surface.resources!) {
      const read = await request(token, 'resources/read', { uri: resource.uri });
      const content = read.body.result.contents[0];
      expect(content._meta.ui.domain).toBe(DOMAIN);
      expect(content.text).not.toContain('ChatGPT');
      expect(content.text.includes('the .zip from Settings, Data controls, Export data')).toBe(false);
      expect(content.text).toContain('ui/initialize');
    }
    const dashboardResult = await request(token, 'tools/call', { name: 'olympus_dashboard', arguments: {} });
    expect(dashboardResult.body.result.structuredContent.v).toBe(1);
    const search = (await request(token, 'tools/call', { name: 'olympus_search', arguments: { question: 'test' } })).body.result;
    expect(search._meta[PRIVATE_ANSWER_META_KEY].jobId).toMatch(/^oly2p\./);
    expect(JSON.stringify([search.content, search.structuredContent])).not.toContain(search._meta[PRIVATE_ANSWER_META_KEY].jobId);
    expect(JSON.stringify(search)).not.toContain('PRIVATE_ITEM_SENTINEL');
    expect(JSON.stringify(search)).not.toContain('PRIVATE_ANSWER_SENTINEL');
    const question = (await request(token, 'tools/call', { name: 'open_private_question', arguments: {} })).body.result;
    expect(JSON.stringify(question)).not.toContain('connect ChatGPT');
    expect(question._meta[PRIVATE_QUESTION_META_KEY].jobId).toMatch(/^oly2p\./);
    expect(JSON.stringify([question.content, question.structuredContent])).not.toContain(question._meta[PRIVATE_QUESTION_META_KEY].jobId);
    expect((await request(token, 'tools/list')).response.headers.get('x-olympus-surface')).toBe('claude-app');
  });

  test('privacy confirmation stays widget-only, retains owner data verbatim and still authorizes a save', async () => {
    enabled = true;
    const token = grant(CLAUDE_CLIENT_ID);
    const got = (await request(token, 'tools/call', { name: 'olympus_privacy_get', arguments: {} })).body.result;
    const meta = got._meta[PRIVACY_META_KEY];
    expect(meta.confirmation).toMatch(/^opc_[A-Za-z0-9_-]{32}$/);
    expect(meta.description).toBe(privacy.description);
    expect(JSON.stringify([got.content, got.structuredContent])).not.toContain(meta.confirmation);
    const saved = (await request(token, 'tools/call', { name: 'olympus_privacy_set', arguments: {
      confirmation: meta.confirmation, revision: meta.revision, description: 'ChatGPT stays verbatim.',
    } })).body.result;
    expect(saved.isError).toBeFalsy();
    expect(saved._meta[PRIVACY_META_KEY].description).toBe('ChatGPT stays verbatim.');
  });

  test('ChatGPT tools/list and all resources/read are byte-identical to the committed main assets with either setting', async () => {
    const token = grant(CHATGPT_CLIENT_ID);
    for (const setting of [false, true]) {
      enabled = setting;
      expect(JSON.stringify(await listing(token))).toBe(JSON.stringify(mainSurface));
      for (const expected of [mainDashboard, mainAnswer, mainQuestion]) {
        const got = await request(token, 'resources/read', { uri: expected.contents[0]!.uri });
        expect(JSON.stringify(got.body.result)).toBe(JSON.stringify(expected));
      }
    }
  });

  test('Claude never gains access to the directory endpoint', async () => {
    enabled = true;
    expect((await request(grant(CLAUDE_CLIENT_ID, true), 'tools/list', {}, true)).response.status).toBe(404);
    expect((await request(grant(CLAUDE_CLIENT_ID), 'tools/list', {}, true)).response.status).toBe(401);
  });
});
