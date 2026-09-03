import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpDomainExpertTransport, DomainExpertClient } from '../src/core/domain-expert-client.ts';
import { domainManifest } from '../src/core/domain-expert.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import {
  createDomainExpertWorker as createDomainExpertWorkerWithGate,
  assertAllowedGcsDestination,
  domainExpertAnnasConfigFromEnv,
  domainExpertGoogleConfigFromEnv,
  domainExpertRootsFromEnv,
  domainExpertWorkerFlagsFromEnv,
  pinnedWebImportLookup,
  reciprocalRankFuse,
  selectWebImportHandler,
  WEB_IMPORT_HANDLERS,
  type DomainExpertWorkerOptions,
  type MediaExec,
  type WebImportHandler,
} from '../src/workers/domain-expert/index.ts';

// The domain expert's cloud tenant is deployment configuration with no
// committed default (see `DOMAIN_GCP_PROJECT_ENV` /
// `DOMAIN_GCS_BUCKET_TEMPLATE_ENV`). These suites exercise a *configured*
// deployment, so they supply invented tenant values; the unconfigured
// fail-closed behaviour has its own test that clears them.
process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT = 'olympus-fixture-project';
process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = 'fixture-{domain}-rag';

function createDomainExpertWorker(options: DomainExpertWorkerOptions = {}) {
  return createDomainExpertWorkerWithGate({
    ...options,
    enabled: true,
    liveToolsEnabled: true,
  });
}

describe('Domain Expert worker', () => {
  test('health reports google credentials and cloud tenant separately', async () => {
    const project = process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT;
    try {
      const worker = createDomainExpertWorker({ google: { accessToken: 'test-google-token' } });

      // Credentials but no tenant is NOT "google configured": this runtime
      // cannot make a single Vertex call.
      delete process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT;
      expect(await getJson(worker, 'http://worker.test/v1/health')).toMatchObject({
        configured: { google: false, google_credentials: true, google_tenant: false },
      });

      // A malformed tenant is not a configured tenant either.
      process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT = '<project-id>';
      expect(await getJson(worker, 'http://worker.test/v1/health')).toMatchObject({
        configured: { google: false, google_credentials: true, google_tenant: false },
      });

      process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT = 'olympus-fixture-project';
      expect(await getJson(worker, 'http://worker.test/v1/health')).toMatchObject({
        configured: { google: true, google_credentials: true, google_tenant: true },
      });

      // A tenant with no credentials is the mirror image.
      const credentialless = createDomainExpertWorker({});
      expect(await getJson(credentialless, 'http://worker.test/v1/health')).toMatchObject({
        configured: { google: false, google_credentials: false, google_tenant: true },
      });
    } finally {
      if (project === undefined) delete process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT;
      else process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT = project;
    }
  });

  test('rejects placeholder cloud-tenant configuration instead of taking it literally', () => {
    const project = process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT;
    const bucketTemplate = process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE;
    try {
      // Shape, plus the strings Google itself reserves — a name that breaks a
      // reserved-string rule is refused at create time, so accepting it here
      // would only move the failure to a live call.
      for (const bad of [
        '<project-id>', 'My Project', 'projects/123456789012', 'ab', 'trailing-',
        'my-google-project', 'my-g00gle-project', 'my-ssl-project',
        'my-null-project', 'my-undefined-project',
      ]) {
        process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT = bad;
        expect(() => domainManifest('governance')).toThrow('OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT is not a Google Cloud project id:');
      }
      process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT = 'olympus-fixture-project';

      for (const bad of [
        '<bucket>', 'gs://<bucket>/with/path', 'UPPERCASE', 'ab', 'dots..double',
        'goog-reserved-prefix', 'my-google-bucket', 'my-g00gle-bucket',
        '192.168.10.20', `${'a'.repeat(64)}-too-long-component.example`,
        // A dotted name is a DNS name, so an underscore is illegal in it even
        // though a flat name may carry one.
        'my_dotted.example.com',
      ]) {
        process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = bad;
        expect(() => domainManifest('governance')).toThrow('does not expand to a GCS bucket name');
      }

      process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = 'fixture-{domain}-rag';
      expect(domainManifest('governance').allowed_gcs_prefixes).toEqual(['gs://fixture-governance-rag']);
      // Dotted, domain-scoped names stay legal, including a one-character
      // leading component: the 3-character floor is on the whole name.
      process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = 'rag.{domain}.example-corp.test';
      expect(domainManifest('governance').allowed_gcs_prefixes).toEqual(['gs://rag.governance.example-corp.test']);
      process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = 'x.example-corp.test';
      expect(domainManifest('governance').allowed_gcs_prefixes).toEqual(['gs://x.example-corp.test']);
      // A flat name may carry an underscore.
      process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = 'fixture_{domain}_rag';
      expect(domainManifest('governance').allowed_gcs_prefixes).toEqual(['gs://fixture_governance_rag']);
    } finally {
      if (project === undefined) delete process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT;
      else process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT = project;
      if (bucketTemplate === undefined) delete process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE;
      else process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = bucketTemplate;
    }
  });

  test('fails closed when the deployment configures no cloud tenant', async () => {
    const project = process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT;
    const bucketTemplate = process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE;
    delete process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT;
    delete process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE;
    try {
      const manifest = domainManifest('governance');
      expect(manifest.gcp_project).toBe('');
      expect(manifest.allowed_gcs_prefixes).toEqual([]);

      // Every live rag_corpus action, including the two that resolve a
      // fully-qualified or numeric resource name and so never consult the
      // project. Before the guard, status/list_files/delete_file/refresh
      // answered 200 and reached Vertex with an empty project.
      const fullResourceName = 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222';
      const liveActions: Array<Record<string, unknown>> = [
        { action: 'create', corpus_id: 'governance-test-corpus' },
        { action: 'status', corpus_id: 'governance-test-corpus' },
        { action: 'status', corpus_id: fullResourceName },
        { action: 'status', corpus_id: '2222222222222222222' },
        { action: 'refresh', corpus_id: 'governance-test-corpus' },
        { action: 'refresh', corpus_id: fullResourceName },
        { action: 'list_files', corpus_id: 'governance-test-corpus' },
        { action: 'list_files', corpus_id: fullResourceName },
        { action: 'list_files', corpus_id: '2222222222222222222' },
        {
          action: 'delete_file',
          corpus_id: fullResourceName,
          rag_file_name: `${fullResourceName}/ragFiles/file-1`,
        },
        {
          action: 'delete_file',
          corpus_id: '2222222222222222222',
          rag_file_name: `${fullResourceName}/ragFiles/file-1`,
        },
        { action: 'import', corpus_id: fullResourceName, gcs_uri: 'gs://fixture-governance-rag/batch-1/book.pdf' },
      ];

      for (const params of liveActions) {
        const calls: CapturedCall[] = [];
        const worker = createDomainExpertWorker({
          google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        });
        const response = await postDomainResponse(worker, 'rag_corpus', {
          domain_id: 'governance',
          dry_run: false,
          ...params,
        });

        expect({ action: params.action, status: response.status }).toEqual({ action: params.action, status: 503 });
        expect(await response.json()).toMatchObject({ error: { code: 'gcp_project_not_configured' } });
        expect(calls).toHaveLength(0);
      }

      // The three import actions dispatch to their own handlers and do outbound
      // work — a source fetch, Notion requests, a staging upload, transcription
      // — before they touch a corpus. Count every outbound surface the worker
      // has, not just the Google one.
      const importActions = [
        { action: 'stage_import', corpus_id: fullResourceName, workspace_relative_path: 'inbox' },
        { action: 'web_import', corpus_id: fullResourceName, urls: ['https://example.com/a'] },
        { action: 'notion_import', corpus_id: fullResourceName, page_ids: ['11111111111111111111111111111111'] },
        // Acquires a file and imports it into a corpus, so it belongs in the
        // same matrix even though it is a different tool.
        { action: 'annas_archive_import' },
      ];
      // Both with no bucket at all and with a bucket but no project: a
      // configured staging destination must not let the import start.
      const importCases = [
        ...importActions.map((params) => ({ params, bucket: undefined })),
        ...importActions.map((params) => ({ params, bucket: 'fixture-{domain}-rag' })),
      ];
      for (const { params, bucket } of importCases) {
        if (bucket === undefined) delete process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE;
        else process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = bucket;
        const outbound: string[] = [];
        const countingFetch = (async (input: any) => {
          outbound.push(String(input?.url ?? input));
          throw new Error('the guard should have refused before any outbound call');
        }) as unknown as typeof fetch;
        const worker = createDomainExpertWorker({
          google: { accessToken: 'test-google-token', fetchImpl: countingFetch },
          notion: { token: 'secret-notion-token', fetchImpl: countingFetch },
          // Fully configured, so a missing-config error cannot stand in for the
          // tenant guard: the guard has to be what refuses.
          annas: {
            apiKey: 'test-annas-token',
            baseUrl: 'https://annas.test',
            importGcsPrefix: 'gs://fixture-governance-rag/approved',
            booksRoot: mkdtempSync(join(tmpdir(), 'olympus-annas-guard-')),
          },
          fetchImpl: countingFetch,
          webImportFetchImpl: async (url) => {
            outbound.push(url.toString());
            throw new Error('the guard should have refused before any web fetch');
          },
          resolveHostImpl: async (hostname) => {
            outbound.push(`dns:${hostname}`);
            return ['203.0.113.1'];
          },
          mediaExec: async (command, args) => {
            outbound.push(`exec:${command} ${args.join(' ')}`);
            return { stdout: '', stderr: '' };
          },
        });
        const response = params.action === 'annas_archive_import'
          ? await postDomainResponse(worker, 'annas_archive_import', {
            domain_id: 'governance',
            annas_archive_id: 'book-1',
            approval_id: 'approval-1',
            copyright_posture: 'public_domain',
            dry_run: false,
          })
          : await postDomainResponse(worker, 'rag_corpus', {
            domain_id: 'governance',
            dry_run: false,
            ...params,
          });

        const label = `${params.action}/${bucket ? 'bucket-set' : 'no-bucket'}`;
        expect({ label, status: response.status }).toEqual({ label, status: 503 });
        expect(await response.json()).toMatchObject({ error: { code: 'gcp_project_not_configured' } });
        expect({ label, outbound }).toEqual({ label, outbound: [] });
      }
      delete process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE;

      // domain_ask resolves corpora before retrieval; it must not list them.
      const askCalls: CapturedCall[] = [];
      const askWorker = createDomainExpertWorker({
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(askCalls) },
      });
      const askResponse = await postDomainResponse(askWorker, 'domain_ask', {
        domain_id: 'governance',
        question: 'What did the charter change?',
        dry_run: false,
      });
      expect(askResponse.status).toBe(503);
      expect(await askResponse.json()).toMatchObject({ error: { code: 'gcp_project_not_configured' } });
      expect(askCalls).toHaveLength(0);
    } finally {
      if (project === undefined) delete process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT;
      else process.env.OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT = project;
      if (bucketTemplate === undefined) delete process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE;
      else process.env.OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE = bucketTemplate;
    }
  });

  test('reports health and bootstraps the bounded Solon governance workspace', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        dataDir: join(base, 'data'),
      });

      const health = await getJson(worker, 'http://worker.test/v1/health');
      expect(health).toMatchObject({
        kind: 'domain_expert_health',
        reachable: true,
        configured: {
          workspace_roots: 1,
          google: false,
        },
        policy: {
          olympus_control_plane_only: true,
          raw_runtime_secrets_exposed: false,
        },
      });

      const bootstrapped = await postDomain(worker, 'domain_agent', {
        action: 'bootstrap',
        domain_id: 'governance',
        dry_run: false,
      });

      expect(bootstrapped).toMatchObject({
        kind: 'domain_agent_result',
        status: 'workspace_bootstrapped',
        domain_id: 'governance',
        root_id: 'castor_workspace',
        workspace_relative_path: 'castor-solon',
      });
      expect(JSON.stringify(bootstrapped)).not.toContain(workspaceRoot);
      expect(existsSync(join(workspaceRoot, 'castor-solon', 'domain.manifest.json'))).toBe(true);
      expect(existsSync(join(workspaceRoot, 'castor-solon', 'templates', 'research-brief.md'))).toBe(true);
      const retrievalCraft = readFileSync(join(workspaceRoot, 'castor-solon', 'references', 'retrieval-craft.md'), 'utf8');
      expect(retrievalCraft).toContain('Name the source, author, or text when you know it.');
      expect(retrievalCraft).toContain('Retrieval misses become eval cases');
      const evalRows = readFileSync(join(workspaceRoot, 'castor-solon', 'eval', 'questions.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      expect(evalRows).toHaveLength(1);
      expect(evalRows[0]).toMatchObject({
        id: 'governance-example-1',
        expected_sources: [],
        tags: ['example'],
      });
      expect(evalRows[0].notes).toContain('retrieval miss');
      expect(readFileSync(auditPath, 'utf8')).toContain('domain_agent_audit');
    } finally {
      cleanup();
    }
  });

  test('delegates domain_ask to resolved Vertex RAG corpora and synthesizes with citations', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      const answer = await postDomain(worker, 'domain_ask', {
        domain_id: 'governance',
        question: 'What should a governance researcher examine?',
        corpora: ['governance-test-corpus', 'governance-jamie-docs'],
        max_results: 4,
      });

      expect(answer).toMatchObject({
        kind: 'domain_answer',
        status: 'answered',
        answer: 'Use the library context [governance-test-corpus:1].',
        citations: [
          {
            citation_id: 'governance-test-corpus:1',
            source_display_name: '2222222222222222222 source',
            source_uri: 'gs://fixture-governance-rag/2222222222222222222.pdf',
          },
          {
            citation_id: 'governance-jamie-docs:1',
            source_display_name: '7777777777777777777 source',
            source_uri: 'gs://fixture-governance-rag/7777777777777777777.pdf',
          },
        ],
        retrieved_context_count: 2,
        resolved_corpora: [
          {
            requested: 'governance-test-corpus',
            corpus_id: '2222222222222222222',
            resource_name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222',
            display_name: 'governance-test-corpus',
          },
          {
            requested: 'governance-jamie-docs',
            corpus_id: '7777777777777777777',
            resource_name: 'projects/123456789012/locations/us-central1/ragCorpora/7777777777777777777',
            display_name: 'governance-jamie-docs',
          },
        ],
        policy: {
          olympus_control_plane_only: true,
          per_question_answer_logic_in_olympus: false,
        },
      });
      expect(calls.filter(isRagCorpusListCall)).toHaveLength(1);
      expect(calls.filter((call) => call.url.endsWith(':retrieveContexts'))).toHaveLength(2);
      expect(calls.filter((call) => call.url.includes(':generateContent'))).toHaveLength(2);
      const firstRetrieveBody = JSON.parse(calls.find((call) => call.url.endsWith(':retrieveContexts'))!.body);
      expect(firstRetrieveBody).toMatchObject({
        vertexRagStore: {
          ragResources: [{ ragCorpus: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222' }],
        },
        query: {
          text: 'What should a governance researcher examine?',
          ragRetrievalConfig: {
            topK: 4,
            ranking: {
              rankService: { modelName: 'semantic-ranker-512@latest' },
            },
          },
        },
      });
    } finally {
      cleanup();
    }
  });

  test('uses env-default native reranking and candidate depth in the retrieveContexts request', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        multiQuery: false,
        fetchImpl: fakeGoogleFetch(calls),
      },
    });

    await postDomain(worker, 'domain_ask', {
      domain_id: 'governance',
      question: 'What should a governance researcher examine?',
      corpus_id: '7777777777777777777',
    });

    const retrieveBody = JSON.parse(calls.find((call) => call.url.endsWith(':retrieveContexts'))!.body);
    expect(retrieveBody.query.ragRetrievalConfig).toEqual({
      topK: 30,
      ranking: {
        rankService: { modelName: 'semantic-ranker-512@latest' },
      },
    });
  });

  test('expands to at most three queries, retrieves each, and fuses duplicate contexts', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls, {
          queryReformulations: ['Nisargadatta outer guru inner guru', 'I Am That guru within teaching'],
          retrieveContexts: (_corpusId, query) => [
            { id: 'shared', text: 'shared context', sourceUri: 'gs://books/i-am-that.pdf', sourceDisplayName: 'I Am That' },
            { id: query, text: `${query} context`, sourceUri: `gs://books/${encodeURIComponent(query)}.md`, sourceDisplayName: query },
          ],
        }),
      },
    });

    const answer = await postDomain(worker, 'domain_ask', {
      domain_id: 'governance',
      question: 'outer guru vs inner guru, Nisargadatta',
      corpus_id: '7777777777777777777',
    });

    const retrieveCalls = calls.filter((call) => call.url.endsWith(':retrieveContexts'));
    expect(retrieveCalls).toHaveLength(3);
    expect(retrieveCalls.map((call) => JSON.parse(call.body).query.text)).toEqual([
      'outer guru vs inner guru, Nisargadatta',
      'Nisargadatta outer guru inner guru',
      'I Am That guru within teaching',
    ]);
    expect(answer.retrieved_context_count).toBe(4);
    const citations = answer.citations as Array<Record<string, unknown>>;
    expect(citations[0]).toMatchObject({
      citation_id: '7777777777777777777:1',
      source_display_name: 'I Am That',
    });
  });

  test('disabled multi-query and reranking degrade to one plain retrieval request', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        multiQuery: false,
        reranker: 'off',
        fetchImpl: fakeGoogleFetch(calls),
      },
    });

    await postDomain(worker, 'domain_ask', {
      domain_id: 'governance',
      question: 'What is in the library?',
      corpus_id: '7777777777777777777',
    });

    expect(calls.filter((call) => call.url.endsWith(':retrieveContexts'))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes(':generateContent'))).toHaveLength(1);
    const retrieveBody = JSON.parse(calls.find((call) => call.url.endsWith(':retrieveContexts'))!.body);
    expect(retrieveBody.query.ragRetrievalConfig).toEqual({ topK: 30 });
  });

  test('bounds the native-reranked candidate set and preserves assigned citation ids', async () => {
    const calls: CapturedCall[] = [];
    const contexts = Array.from({ length: 15 }, (_, index) => ({
      id: `context-${index + 1}`,
      text: `ranked context ${index + 1}`,
      sourceUri: `gs://books/source-${index + 1}.pdf`,
      sourceDisplayName: `Source ${index + 1}`,
      score: 1 - index / 100,
    }));
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        multiQuery: false,
        fetchImpl: fakeGoogleFetch(calls, { retrieveContexts: () => contexts }),
      },
    });

    const answer = await postDomain(worker, 'domain_ask', {
      domain_id: 'governance',
      question: 'What is in the library?',
      corpus_id: '7777777777777777777',
    });

    expect(answer.retrieved_context_count).toBe(12);
    expect(answer.citations).toHaveLength(12);
    const citations = answer.citations as Array<Record<string, unknown>>;
    expect(citations[0]).toMatchObject({ citation_id: '7777777777777777777:1', source_display_name: 'Source 1' });
    expect(citations[11]).toMatchObject({ citation_id: '7777777777777777777:12', source_display_name: 'Source 12' });
    const synthesisBody = calls.filter((call) => call.url.includes(':generateContent')).map((call) => call.body).at(-1)!;
    expect(synthesisBody).toContain('[7777777777777777777:12] Source 12');
    expect(synthesisBody).not.toContain('Source 13');
  });

  test('passes numeric corpus ids through without listing corpora', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls),
      },
    });

    await postDomain(worker, 'rag_corpus', {
      action: 'import',
      domain_id: 'governance',
      corpus_id: '7777777777777777777',
      gcs_uri: 'gs://fixture-governance-rag/batch-1/book.pdf',
      dry_run: false,
    });

    expect(calls.some(isRagCorpusListCall)).toBe(false);
    expect(calls.find((call) => call.url.includes('/ragFiles:import'))?.url)
      .toContain('/ragCorpora/7777777777777777777/ragFiles:import');
  });

  test('honors domain_ask corpus_id instead of falling back to manifest corpora', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls),
      },
    });

    const answer = await postDomain(worker, 'domain_ask', {
      domain_id: 'governance',
      question: 'What is in the Solon seed?',
      corpus_id: '7777777777777777777',
      max_results: 4,
    });

    expect(answer).toMatchObject({
      kind: 'domain_answer',
      retrieved_context_count: 1,
      resolved_corpora: [{
        requested: '7777777777777777777',
        corpus_id: '7777777777777777777',
      }],
    });
    expect(calls.some(isRagCorpusListCall)).toBe(false);
    expect(calls.filter((call) => call.url.endsWith(':retrieveContexts'))).toHaveLength(1);
    const retrieveBody = JSON.parse(calls.find((call) => call.url.endsWith(':retrieveContexts'))!.body);
    expect(retrieveBody.vertexRagStore.ragResources[0].ragCorpus)
      .toBe('projects/olympus-fixture-project/locations/us-central1/ragCorpora/7777777777777777777');
  });

  test('manifest fallback uses the single live governance corpus without missing-corpus warnings', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls, {
            ragCorpora: [{
              name: 'projects/123456789012/locations/us-central1/ragCorpora/7777777777777777777',
              displayName: 'governance-jamie-docs',
            }],
          }),
        },
        dataDir: join(base, 'data'),
      });

      const answer = await postDomain(worker, 'domain_ask', {
        domain_id: 'governance',
        question: 'What is in the available governance corpus?',
      });

      expect(answer).toMatchObject({
        kind: 'domain_answer',
        status: 'answered',
        retrieved_context_count: 1,
        resolved_corpora: [{
          requested: 'governance-jamie-docs',
          corpus_id: '7777777777777777777',
        }],
      });
      expect(answer).not.toHaveProperty('warnings');
      expect(calls.filter((call) => call.url.endsWith(':retrieveContexts'))).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test('returns a clear error when every requested corpus is unresolvable', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls, { ragCorpora: [] }),
        },
        dataDir: join(base, 'data'),
      });

      const response = await postDomainResponse(worker, 'domain_ask', {
        domain_id: 'governance',
        question: 'What is in missing corpora?',
        corpus_id: 'governance-missing',
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'rag_corpus_not_found',
          message: 'Could not resolve RAG corpus "governance-missing" in olympus-fixture-project/us-central1.',
          suggestion: 'Run rag_corpus create with corpus_id "governance-missing" before asking, importing, or checking status.',
        },
      });
    } finally {
      cleanup();
    }
  });

  test('caches display-name corpus resolution and records create mappings in the data dir', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      await postDomain(worker, 'rag_corpus', {
        action: 'status',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        dry_run: false,
      });
      await postDomain(worker, 'rag_corpus', {
        action: 'refresh',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        dry_run: false,
      });
      const created = await postDomain(worker, 'rag_corpus', {
        action: 'create',
        domain_id: 'governance',
        corpus_id: 'governance-new',
        dry_run: false,
      });

      expect(calls.filter(isRagCorpusListCall)).toHaveLength(1);
      expect(created).toMatchObject({
        resolved_corpus: {
          requested: 'governance-new',
          corpus_id: '3333333333333333333',
        },
      });
      const mapping = JSON.parse(readFileSync(join(base, 'data', 'rag-corpus-mapping.json'), 'utf8'));
      expect(mapping.corpora['olympus-fixture-project/us-central1/governance-test-corpus']).toMatchObject({
        corpus_id: '2222222222222222222',
        display_name: 'governance-test-corpus',
      });
      expect(mapping.corpora['olympus-fixture-project/us-central1/governance-new']).toMatchObject({
        corpus_id: '3333333333333333333',
        display_name: 'governance-new',
      });
      expect(readdirSync(join(base, 'data')).filter((entry) => entry.includes('rag-corpus-mapping.json') && entry.endsWith('.tmp'))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('preserves concurrent RAG corpus mapping updates', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      await Promise.all(['governance-alpha', 'governance-beta', 'governance-gamma'].map((corpusId) => postDomain(worker, 'rag_corpus', {
        action: 'create',
        domain_id: 'governance',
        corpus_id: corpusId,
        dry_run: false,
      })));

      const mapping = JSON.parse(readFileSync(join(base, 'data', 'rag-corpus-mapping.json'), 'utf8'));
      expect(Object.keys(mapping.corpora).sort()).toEqual([
        'olympus-fixture-project/us-central1/governance-alpha',
        'olympus-fixture-project/us-central1/governance-beta',
        'olympus-fixture-project/us-central1/governance-gamma',
      ]);
      for (const corpusId of ['governance-alpha', 'governance-beta', 'governance-gamma']) {
        expect(mapping.corpora[`olympus-fixture-project/us-central1/${corpusId}`]).toMatchObject({
          corpus_id: '3333333333333333333',
          display_name: corpusId,
        });
      }
    } finally {
      cleanup();
    }
  });

  test('invalidates stale display-name mappings after Vertex NOT_FOUND, re-lists once, and retries successfully', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const oldCorpusId = '1111111111111111111';
    const newCorpusId = '9999999999999999999';
    const dataDir = join(base, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'rag-corpus-mapping.json'), JSON.stringify({
      version: 1,
      corpora: {
        'olympus-fixture-project/us-central1/governance-test-corpus': {
          display_name: 'governance-test-corpus',
          corpus_id: oldCorpusId,
          resource_name: `projects/123456789012/locations/us-central1/ragCorpora/${oldCorpusId}`,
          project: 'olympus-fixture-project',
          location: 'us-central1',
          updated_at: '2026-07-05T00:00:00.000Z',
        },
      },
    }));
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls, {
            ragCorpora: [{
              name: `projects/123456789012/locations/us-central1/ragCorpora/${newCorpusId}`,
              displayName: 'governance-test-corpus',
            }],
            notFoundCorpusIds: [oldCorpusId],
          }),
        },
        dataDir,
      });

      const answer = await postDomain(worker, 'domain_ask', {
        domain_id: 'governance',
        question: 'What should a governance researcher examine?',
        corpus_id: 'governance-test-corpus',
      });

      expect(answer).toMatchObject({
        kind: 'domain_answer',
        status: 'answered',
        resolved_corpora: [{
          requested: 'governance-test-corpus',
          corpus_id: newCorpusId,
          resource_name: `projects/123456789012/locations/us-central1/ragCorpora/${newCorpusId}`,
        }],
      });
      const retrieveCalls = calls.filter((call) => call.url.endsWith(':retrieveContexts'));
      expect(retrieveCalls).toHaveLength(2);
      expect(retrieveCalls.map((call) => JSON.parse(call.body).vertexRagStore.ragResources[0].ragCorpus.split('/').at(-1)))
        .toEqual([oldCorpusId, newCorpusId]);
      expect(calls.filter(isRagCorpusListCall)).toHaveLength(1);
      const mapping = JSON.parse(readFileSync(join(dataDir, 'rag-corpus-mapping.json'), 'utf8'));
      expect(mapping.corpora['olympus-fixture-project/us-central1/governance-test-corpus']).toMatchObject({
        corpus_id: newCorpusId,
        display_name: 'governance-test-corpus',
      });
    } finally {
      cleanup();
    }
  });

  test('returns rag_corpus_not_found when stale mapping refresh cannot resolve the display name', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const oldCorpusId = '1111111111111111111';
    const dataDir = join(base, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'rag-corpus-mapping.json'), JSON.stringify({
      version: 1,
      corpora: {
        'olympus-fixture-project/us-central1/governance-test-corpus': {
          display_name: 'governance-test-corpus',
          corpus_id: oldCorpusId,
          resource_name: `projects/123456789012/locations/us-central1/ragCorpora/${oldCorpusId}`,
          project: 'olympus-fixture-project',
          location: 'us-central1',
          updated_at: '2026-07-05T00:00:00.000Z',
        },
      },
    }));
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls, {
            ragCorpora: [],
            notFoundCorpusIds: [oldCorpusId],
          }),
        },
        dataDir,
      });

      const response = await postDomainResponse(worker, 'domain_ask', {
        domain_id: 'governance',
        question: 'What should a governance researcher examine?',
        corpus_id: 'governance-test-corpus',
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'rag_corpus_not_found',
          message: 'Could not resolve RAG corpus "governance-test-corpus" in olympus-fixture-project/us-central1.',
          suggestion: 'Run rag_corpus create with corpus_id "governance-test-corpus" before asking, importing, or checking status.',
        },
      });
      expect(calls.filter((call) => call.url.endsWith(':retrieveContexts'))).toHaveLength(1);
      expect(calls.filter(isRagCorpusListCall)).toHaveLength(1);
      const mapping = JSON.parse(readFileSync(join(dataDir, 'rag-corpus-mapping.json'), 'utf8'));
      expect(mapping.corpora['olympus-fixture-project/us-central1/governance-test-corpus']).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('recovers from a corrupt RAG corpus mapping file by warning and rebuilding from list', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const dataDir = join(base, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'rag-corpus-mapping.json'), '{"version":1,"corpora":{');
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir,
      });

      const status = await postDomain(worker, 'rag_corpus', {
        action: 'status',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        dry_run: false,
      });

      expect(status).toMatchObject({
        kind: 'rag_corpus_status',
        resolved_corpus: {
          requested: 'governance-test-corpus',
          corpus_id: '2222222222222222222',
        },
        warnings: [{
          code: 'rag_corpus_mapping_file_unreadable',
          mapping_file: 'rag-corpus-mapping.json',
        }],
      });
      expect(warnings.some((warning) => warning.includes('rag-corpus-mapping.json could not be parsed'))).toBe(true);
      expect(calls.filter(isRagCorpusListCall)).toHaveLength(1);
      const mapping = JSON.parse(readFileSync(join(dataDir, 'rag-corpus-mapping.json'), 'utf8'));
      expect(mapping.corpora['olympus-fixture-project/us-central1/governance-test-corpus']).toMatchObject({
        corpus_id: '2222222222222222222',
      });
      expect(existsSync(join(dataDir, 'rag-corpus-mapping.json'))).toBe(true);
      expect(readFileSync(join(dataDir, 'rag-corpus-mapping.json'), 'utf8')).not.toContain('{"version":1,"corpora":{');
    } finally {
      console.warn = originalWarn;
      cleanup();
    }
  });

  test('selects the first duplicate displayName in Vertex list order and returns a warning naming duplicates', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls, {
            ragCorpora: [
              {
                name: 'projects/123456789012/locations/us-central1/ragCorpora/4444444444444444444',
                displayName: 'governance-test-corpus',
              },
              {
                name: 'projects/123456789012/locations/us-central1/ragCorpora/5555555555555555555',
                displayName: 'governance-test-corpus',
              },
            ],
          }),
        },
        dataDir: join(base, 'data'),
      });

      const status = await postDomain(worker, 'rag_corpus', {
        action: 'status',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        dry_run: false,
      });

      expect(status).toMatchObject({
        kind: 'rag_corpus_status',
        resolved_corpus: {
          requested: 'governance-test-corpus',
          corpus_id: '4444444444444444444',
          resource_name: 'projects/123456789012/locations/us-central1/ragCorpora/4444444444444444444',
        },
        warnings: [{
          code: 'rag_corpus_duplicate_display_name',
          display_name: 'governance-test-corpus',
          selected_resource_name: 'projects/123456789012/locations/us-central1/ragCorpora/4444444444444444444',
          duplicate_resource_names: [
            'projects/123456789012/locations/us-central1/ragCorpora/4444444444444444444',
            'projects/123456789012/locations/us-central1/ragCorpora/5555555555555555555',
          ],
          selection_order: 'Vertex ragCorpora list order; Olympus selects the first matching displayName returned by the API.',
        }],
      });
      const mapping = JSON.parse(readFileSync(join(base, 'data', 'rag-corpus-mapping.json'), 'utf8'));
      expect(mapping.corpora['olympus-fixture-project/us-central1/governance-test-corpus']).toMatchObject({
        corpus_id: '4444444444444444444',
      });
    } finally {
      cleanup();
    }
  });

  test('imports staged files into a Gemini Enterprise RAG corpus', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls),
      },
    });

    const result = await postDomain(worker, 'rag_corpus', {
      action: 'import',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      gcs_uri: 'gs://fixture-governance-rag/batch-1/book.pdf',
      dry_run: false,
    });

    expect(result).toMatchObject({
      kind: 'rag_corpus_result',
      status: 'import_requested',
      operation: { name: 'operations/rag-import-1' },
    });
    const importCall = calls.find((call) => call.url.includes('/ragFiles:import'));
    expect(importCall).toBeDefined();
    expect(importCall!.url).toContain('/ragCorpora/2222222222222222222/ragFiles:import');
    expect(JSON.parse(importCall!.body)).toMatchObject({
      importRagFilesConfig: {
        gcsSource: { uris: ['gs://fixture-governance-rag/batch-1/book.pdf'] },
        ragFileParsingConfig: { layoutParser: {} },
        ragFileTransformationConfig: {
          ragFileChunkingConfig: {
            fixedLengthChunking: {
              chunkSize: 512,
              chunkOverlap: 64,
            },
          },
        },
      },
    });
  });

  test('rejects live RAG imports outside the domain GCS allowlist before Vertex import', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls),
      },
    });

    const response = await postDomainResponse(worker, 'rag_corpus', {
      action: 'import',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      gcs_uri: 'gs://wrong-governance-rag/batch-1/book.pdf',
      dry_run: false,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'domain_expert_policy_violation',
      },
    });
    expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(false);
  });

  test('rejects direct live Drive RAG imports until a reviewed import path exists', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls),
      },
    });

    const response = await postDomainResponse(worker, 'rag_corpus', {
      action: 'import',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      drive_file_id: 'arbitrary-drive-file-id',
      dry_run: false,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'drive_import_review_required',
      },
    });
    expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(false);
  });

  test('list_files returns a paged Vertex ragFiles listing with selected fields', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls, {
          ragFiles: {
            page2: [
              {
                name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222/ragFiles/file-2',
                displayName: 'source-two.md',
                createTime: '2026-07-05T11:00:00Z',
                sourceUri: 'gs://fixture-governance-rag/staged/source-two.md',
                fileStatus: { state: 'ACTIVE' },
              },
              {
                name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222/ragFiles/file-error',
                displayName: 'broken-source.pdf',
                createTime: '2026-07-05T11:05:00Z',
                sourceUri: 'gs://fixture-governance-rag/staged/broken-source.pdf',
                fileStatus: { state: 'ERROR' },
                errorStatus: {
                  code: 3,
                  message: 'Failed to parse PDF.',
                },
              },
            ],
          },
        }),
      },
    });

    const result = await postDomain(worker, 'rag_corpus', {
      action: 'list_files',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      page_token: 'page2',
    });

    expect(result).toMatchObject({
      kind: 'rag_corpus_files',
      resolved_corpus: {
        requested: 'governance-test-corpus',
        corpus_id: '2222222222222222222',
      },
      files: [
        {
          name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222/ragFiles/file-2',
          displayName: 'source-two.md',
          createTime: '2026-07-05T11:00:00Z',
          sourceUri: 'gs://fixture-governance-rag/staged/source-two.md',
          state: 'ACTIVE',
        },
        {
          name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222/ragFiles/file-error',
          displayName: 'broken-source.pdf',
          createTime: '2026-07-05T11:05:00Z',
          sourceUri: 'gs://fixture-governance-rag/staged/broken-source.pdf',
          state: 'ERROR',
          errorStatus: {
            code: 3,
            message: 'Failed to parse PDF.',
          },
        },
      ],
    });
    expect(calls.find((call) => call.url.includes('/ragFiles'))?.url).toContain('pageToken=page2');
    expect(JSON.stringify(result.files)).not.toContain('ignoredField');
  });

  test('delete_file defaults to dry-run and does not call Vertex delete', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
    });

    const result = await postDomain(worker, 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      rag_file_name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222/ragFiles/file-1',
    });

    expect(result).toMatchObject({
      kind: 'rag_corpus_delete_file_plan',
      status: 'dry_run_delete_file_ready',
      rag_file_name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222/ragFiles/file-1',
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  test('delete_file live call deletes one resolved ragFile resource', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
    });

    const result = await postDomain(worker, 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      rag_file_name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222/ragFiles/file-1',
      dry_run: false,
    });

    expect(result).toMatchObject({
      kind: 'rag_corpus_delete_file_result',
      status: 'delete_file_requested',
      operation: { name: 'operations/rag-delete-file-1' },
    });
    const deleteCall = calls.find((call) => call.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.url).toContain('/ragCorpora/2222222222222222222/ragFiles/file-1');
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  test('delete_file accepts list_files project-number ragFile names for bare numeric corpus ids', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
    });

    const listed = await postDomain(worker, 'rag_corpus', {
      action: 'list_files',
      domain_id: 'governance',
      corpus_id: '2222222222222222222',
    });
    const ragFileName = (listed.files as Array<{ name: string }>)[0]!.name;
    expect(ragFileName).toBe('projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222/ragFiles/file-1');

    const deleted = await postDomain(worker, 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'governance',
      corpus_id: '2222222222222222222',
      rag_file_name: ragFileName,
      dry_run: false,
    });

    expect(deleted).toMatchObject({
      kind: 'rag_corpus_delete_file_result',
      status: 'delete_file_requested',
      operation: { name: 'operations/rag-delete-file-1' },
    });
    expect(calls.filter(isRagCorpusListCall)).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  test('delete_file accepts list_files project-number ragFile names for ID-based full corpus resources', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
    });
    const corpusId = 'projects/olympus-fixture-project/locations/us-central1/ragCorpora/2222222222222222222';

    const listed = await postDomain(worker, 'rag_corpus', {
      action: 'list_files',
      domain_id: 'governance',
      corpus_id: corpusId,
    });
    const ragFileName = (listed.files as Array<{ name: string }>)[0]!.name;

    const deleted = await postDomain(worker, 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'governance',
      corpus_id: corpusId,
      rag_file_name: ragFileName,
      dry_run: false,
    });

    expect(deleted).toMatchObject({
      kind: 'rag_corpus_delete_file_result',
      status: 'delete_file_requested',
    });
    expect(calls.filter(isRagCorpusListCall)).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  test('delete_file dry-run accepts the same list_files project-number ragFile names', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
    });

    const listed = await postDomain(worker, 'rag_corpus', {
      action: 'list_files',
      domain_id: 'governance',
      corpus_id: '2222222222222222222',
    });
    const ragFileName = (listed.files as Array<{ name: string }>)[0]!.name;

    const plan = await postDomain(worker, 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'governance',
      corpus_id: '2222222222222222222',
      rag_file_name: ragFileName,
    });

    expect(plan).toMatchObject({
      kind: 'rag_corpus_delete_file_plan',
      status: 'dry_run_delete_file_ready',
      rag_file_name: ragFileName,
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  test('delete_file refuses non-ragFile and foreign-corpus resource names', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
    });

    const nonFile = await postDomainResponse(worker, 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      rag_file_name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222',
      dry_run: false,
    });
    expect(nonFile.status).toBe(400);
    expect(await nonFile.json()).toMatchObject({ error: { code: 'invalid_rag_file_resource' } });

    const foreign = await postDomainResponse(worker, 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      rag_file_name: 'projects/123456789012/locations/us-central1/ragCorpora/7777777777777777777/ragFiles/file-1',
      dry_run: false,
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: 'rag_file_foreign_corpus' } });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  test('delete_file keeps rejecting project, location, and corpus foreign ragFile names after list_files alias learning', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
    });

    await postDomain(worker, 'rag_corpus', {
      action: 'list_files',
      domain_id: 'governance',
      corpus_id: '2222222222222222222',
    });

    for (const ragFileName of [
      'projects/123456789012/locations/us-central1/ragCorpora/7777777777777777777/ragFiles/file-1',
      'projects/123456789012/locations/europe-west1/ragCorpora/2222222222222222222/ragFiles/file-1',
      'projects/987654321098/locations/us-central1/ragCorpora/2222222222222222222/ragFiles/file-1',
    ]) {
      const response = await postDomainResponse(worker, 'rag_corpus', {
        action: 'delete_file',
        domain_id: 'governance',
        corpus_id: '2222222222222222222',
        rag_file_name: ragFileName,
        dry_run: false,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'rag_file_foreign_corpus' } });
    }
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  test('list_files retries stale mapped corpus then surfaces a clear not-found error', async () => {
    const { base, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      mkdirSync(join(base, 'data'), { recursive: true });
      writeFileSync(join(base, 'data', 'rag-corpus-mapping.json'), JSON.stringify({
        version: 1,
        corpora: {
          'olympus-fixture-project/us-central1/governance-test-corpus': {
            display_name: 'governance-test-corpus',
            corpus_id: '9999999999999999999',
            resource_name: 'projects/123456789012/locations/us-central1/ragCorpora/9999999999999999999',
            project: 'olympus-fixture-project',
            location: 'us-central1',
            updated_at: '2026-07-05T00:00:00Z',
          },
        },
      }));
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls, { notFoundCorpusIds: ['9999999999999999999', '2222222222222222222'] }),
        },
        dataDir: join(base, 'data'),
      });

      const response = await postDomainResponse(worker, 'rag_corpus', {
        action: 'list_files',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        dry_run: false,
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'rag_corpus_not_found',
          suggestion: 'Run rag_corpus create with corpus_id "governance-test-corpus" before asking, importing, or checking status.',
        },
      });
      expect(calls.filter((call) => call.url.includes('/ragFiles'))).toHaveLength(2);
      expect(calls.some((call) => call.url.includes('/ragCorpora/9999999999999999999/ragFiles'))).toBe(true);
      expect(calls.some((call) => call.url.includes('/ragCorpora/2222222222222222222/ragFiles'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('stage_import dry-run plans eligible and skipped recursive workspace files under the allowed prefix', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      mkdirSync(join(workspaceRoot, 'castor-solon', 'sources', 'yearn', 'nested'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'yearn', 'index.MD'), 'yearn index');
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'yearn', 'nested', 'thread.html'), '<p>thread</p>');
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'yearn', 'raw.json'), '{}');

      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'stage_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        workspace_relative_path: 'castor-solon/sources/yearn',
        batch_id: 'batch-dry-run',
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_stage_import_plan',
        status: 'dry_run_stage_import_ready',
        destination: {
          gcs_uri_prefix: 'gs://fixture-governance-rag/staged/governance/batch-dry-run/',
          batch_id: 'batch-dry-run',
        },
        resolved_corpus: {
          requested: 'governance-test-corpus',
          corpus_id: '2222222222222222222',
        },
        file_policy: {
          recursive: true,
          allowed_extensions: ['md', 'txt', 'pdf', 'html'],
        },
        eligible_file_count: 2,
        skipped_file_count: 1,
      });
      expect(result.eligible_files).toEqual([
        {
          workspace_relative_path: 'castor-solon/sources/yearn/index.MD',
          upload_relative_path: 'index.md',
          bytes: 11,
          gcs_uri: 'gs://fixture-governance-rag/staged/governance/batch-dry-run/index.md',
        },
        {
          workspace_relative_path: 'castor-solon/sources/yearn/nested/thread.html',
          upload_relative_path: 'nested/thread.html',
          bytes: 13,
          gcs_uri: 'gs://fixture-governance-rag/staged/governance/batch-dry-run/nested/thread.html',
        },
      ]);
      expect(result.skipped_files).toEqual([{
        workspace_relative_path: 'castor-solon/sources/yearn/raw.json',
        reason: 'extension_not_allowed:.json',
        bytes: 2,
      }]);
      expect(calls.filter(isRagCorpusListCall)).toHaveLength(1);
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/'))).toBe(false);
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('stage_import uploads eligible files then imports the staged GCS directory against a display-name corpus', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      mkdirSync(join(workspaceRoot, 'castor-solon', 'sources', 'yearn', 'nested'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'yearn', 'a.md'), 'alpha');
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'yearn', 'nested', 'b.txt'), 'bravo');

      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'stage_import',
        domain_id: 'governance',
        corpus_id: 'governance-jamie-docs',
        workspace_relative_path: 'castor-solon/sources/yearn',
        batch_id: 'batch-live',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_stage_import_result',
        status: 'staged_and_import_requested',
        resolved_corpus: {
          requested: 'governance-jamie-docs',
          corpus_id: '7777777777777777777',
          resource_name: 'projects/123456789012/locations/us-central1/ragCorpora/7777777777777777777',
          display_name: 'governance-jamie-docs',
        },
        operation: { name: 'operations/rag-import-1' },
      });
      expect(result.staged_files).toEqual([
        {
          workspace_relative_path: 'castor-solon/sources/yearn/a.md',
          upload_relative_path: 'a.md',
          gcs_uri: 'gs://fixture-governance-rag/staged/governance/batch-live/a.md',
          bytes: 5,
          sha256: '8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8',
        },
        {
          workspace_relative_path: 'castor-solon/sources/yearn/nested/b.txt',
          upload_relative_path: 'nested/b.txt',
          gcs_uri: 'gs://fixture-governance-rag/staged/governance/batch-live/nested/b.txt',
          bytes: 5,
          sha256: 'f144a6907dc4284d1f9fe6a7d9b9ff53c02c1d07ba68f24d413d7ff7f757a782',
        },
      ]);
      const uploadCalls = calls.filter((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/fixture-governance-rag/o'));
      expect(uploadCalls.map((call) => new URL(call.url).searchParams.get('name'))).toEqual([
        'staged/governance/batch-live/a.md',
        'staged/governance/batch-live/nested/b.txt',
      ]);
      expect(uploadCalls.map((call) => call.body)).toEqual(['alpha', 'bravo']);
      const importCall = calls.find((call) => call.url.includes('/ragFiles:import'));
      expect(importCall).toBeDefined();
      expect(importCall!.url).toContain('/ragCorpora/7777777777777777777/ragFiles:import');
      expect(JSON.parse(importCall!.body)).toMatchObject({
        importRagFilesConfig: {
          gcsSource: { uris: ['gs://fixture-governance-rag/staged/governance/batch-live/'] },
        },
      });
      expect(calls.filter(isRagCorpusListCall)).toHaveLength(1);
      expect(calls.findIndex((call) => call.url.startsWith('https://storage.googleapis.com/upload/')))
        .toBeLessThan(calls.findIndex((call) => call.url.includes('/ragFiles:import')));
    } finally {
      cleanup();
    }
  });

  test('stage_import rejects workspace_relative_path escaping the root before remote calls', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      const response = await postDomainResponse(worker, 'rag_corpus', {
        action: 'stage_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        workspace_relative_path: '../outside',
        batch_id: 'escape-test',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'path_escape_denied' },
      });
      expect(calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('stage_import fails closed when a computed destination is outside allowed GCS prefixes', () => {
    expect(() => assertAllowedGcsDestination(
      'gs://fixture-governance-rag/staged/governance/batch-1/',
      ['gs://other-rag'],
    )).toThrow('GCS destination must be inside one of the domain allowlisted prefixes');
  });

  test('stage_import skips disallowed and oversized files, and throws when no eligible files remain', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      mkdirSync(join(workspaceRoot, 'castor-solon', 'sources', 'mixed'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'mixed', 'good.md'), 'good');
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'mixed', 'bad.bin'), 'bad');
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'mixed', 'large.pdf'), new Uint8Array((10 * 1024 * 1024) + 1));
      mkdirSync(join(workspaceRoot, 'castor-solon', 'sources', 'empty-after-skips'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'empty-after-skips', 'bad.bin'), 'bad');
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'empty-after-skips', 'large.pdf'), new Uint8Array((10 * 1024 * 1024) + 1));

      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      const plan = await postDomain(worker, 'rag_corpus', {
        action: 'stage_import',
        domain_id: 'governance',
        corpus_id: '7777777777777777777',
        workspace_relative_path: 'castor-solon/sources/mixed',
        batch_id: 'skip-test',
      });
      expect(plan).toMatchObject({
        eligible_file_count: 1,
        skipped_file_count: 2,
        total_eligible_bytes: 4,
      });
      expect(plan.skipped_files).toEqual([
        {
          workspace_relative_path: 'castor-solon/sources/mixed/bad.bin',
          reason: 'extension_not_allowed:.bin',
          bytes: 3,
        },
        {
          workspace_relative_path: 'castor-solon/sources/mixed/large.pdf',
          reason: 'file_size_limit_exceeded',
          bytes: (10 * 1024 * 1024) + 1,
        },
      ]);

      const response = await postDomainResponse(worker, 'rag_corpus', {
        action: 'stage_import',
        domain_id: 'governance',
        corpus_id: '7777777777777777777',
        workspace_relative_path: 'castor-solon/sources/empty-after-skips',
        batch_id: 'no-eligible-test',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'no_stage_import_files',
          message: 'stage_import found no eligible files after applying extension and size limits.',
        },
      });
    } finally {
      cleanup();
    }
  });

  test('stage_import skips dotfiles and AppleDouble junk files before extension checks', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      mkdirSync(join(workspaceRoot, 'castor-solon', 'sources', 'junk'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'junk', 'good.md'), 'good');
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'junk', '.DS_Store'), 'junk');
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'junk', '._good.md'), 'junk');
      writeFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'junk', '.hidden.md'), 'junk');

      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      const plan = await postDomain(worker, 'rag_corpus', {
        action: 'stage_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        workspace_relative_path: 'castor-solon/sources/junk',
        batch_id: 'junk-test',
      });

      expect(plan.eligible_file_count).toBe(1);
      expect(plan.skipped_files).toEqual([
        { workspace_relative_path: 'castor-solon/sources/junk/._good.md', reason: 'junk_file', bytes: 4 },
        { workspace_relative_path: 'castor-solon/sources/junk/.DS_Store', reason: 'junk_file', bytes: 4 },
        { workspace_relative_path: 'castor-solon/sources/junk/.hidden.md', reason: 'junk_file', bytes: 4 },
      ]);
    } finally {
      cleanup();
    }
  });

  test('notion_import dry-run probes Notion metadata without workspace writes or token echo', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        notion: {
          token: 'secret-notion-token',
          fetchImpl: fakeNotionFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      const health = await getJson(worker, 'http://worker.test/v1/health');
      expect(health).toMatchObject({
        configured: {
          notion: true,
        },
      });
      expect(JSON.stringify(health)).not.toContain('secret-notion-token');

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'notion_import',
        domain_id: 'governance',
        corpus_id: 'governance-jamie-docs',
        urls: ['https://notion.site/Solon-11111111111111111111111111111111?pvs=4'],
        page_ids: ['22222222-2222-2222-2222-222222222222'],
        database_ids: ['33333333333333333333333333333333'],
        batch_id: 'notion-batch',
        dry_run: true,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_notion_import_plan',
        status: 'dry_run_notion_import_ready',
        source: {
          urls: ['https://notion.site/Solon-11111111111111111111111111111111'],
          page_ids: ['22222222222222222222222222222222'],
          database_ids: ['33333333333333333333333333333333'],
          workspace_relative_path: 'castor-solon/sources/notion-imports/notion-batch',
        },
        api_policy: {
          notion_version: '2022-06-28',
          media_downloads: false,
          retry_429: true,
        },
        object_count: 3,
        skipped_object_count: 0,
      });
      expect(result.derived_files).toEqual([
        expect.objectContaining({
          object_id: '11111111111111111111111111111111',
          object_type: 'page',
          title: 'Solon API Page',
          child_block_count: 2,
          workspace_relative_path: 'castor-solon/sources/notion-imports/notion-batch/solon-api-page-11111111.md',
        }),
        expect.objectContaining({
          object_id: '22222222222222222222222222222222',
          object_type: 'page',
          title: 'Second Page',
          child_block_count: 0,
        }),
        expect.objectContaining({
          object_id: '33333333333333333333333333333333',
          object_type: 'database',
          title: 'Research Database',
          row_page_count: 2,
        }),
      ]);
      expect(JSON.stringify(result)).not.toContain('secret-notion-token');
      expect(existsSync(join(workspaceRoot, 'castor-solon', 'sources', 'notion-imports'))).toBe(false);
      expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toContainEqual(['GET', '/v1/users/me']);
      expect(calls.every((call) => call.headers.authorization === 'Bearer secret-notion-token')).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('notion_import reports configuration and per-object failures honestly', async () => {
    const notConfigured = createDomainExpertWorker();
    const response = await postDomainResponse(notConfigured, 'rag_corpus', {
      action: 'notion_import',
      domain_id: 'governance',
      corpus_id: 'governance-jamie-docs',
      page_ids: ['11111111111111111111111111111111'],
      dry_run: true,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'notion_not_configured',
      },
    });

    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      notion: {
        token: 'secret-notion-token',
        fetchImpl: fakeNotionFetch(calls, { missingPageIds: ['99999999999999999999999999999999'] }),
      },
    });
    const result = await postDomain(worker, 'rag_corpus', {
      action: 'notion_import',
      domain_id: 'governance',
      corpus_id: 'governance-jamie-docs',
      page_ids: [
        '11111111111111111111111111111111',
        '99999999999999999999999999999999',
      ],
      dry_run: true,
    });
    expect(result).toMatchObject({
      kind: 'rag_corpus_notion_import_plan',
      status: 'dry_run_notion_import_ready',
      object_count: 1,
      errors: [{
        object_id: '99999999999999999999999999999999',
        object_type: 'page',
        code: 'notion_api_error',
      }],
    });
  });

  test('notion_import honors 429 Retry-After while probing metadata', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      notion: {
        token: 'secret-notion-token',
        fetchImpl: fakeNotionFetch(calls, { rateLimitFirstPageFetch: true }),
      },
    });

    const result = await postDomain(worker, 'rag_corpus', {
      action: 'notion_import',
      domain_id: 'governance',
      corpus_id: 'governance-jamie-docs',
      page_ids: ['11111111111111111111111111111111'],
      dry_run: true,
    });

    expect(result).toMatchObject({
      kind: 'rag_corpus_notion_import_plan',
      object_count: 1,
    });
    expect(calls.filter((call) => call.url.endsWith('/v1/pages/11111111111111111111111111111111'))).toHaveLength(2);
  });

  test('notion_import live page import writes markdown, stages it, imports it, and appends registry', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const notionCalls: CapturedCall[] = [];
    const googleCalls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(googleCalls),
        },
        notion: {
          token: 'secret-notion-token',
          fetchImpl: fakeNotionFetch(notionCalls, { missingPageIds: ['99999999999999999999999999999999'] }),
        },
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'notion_import',
        domain_id: 'governance',
        corpus_id: 'governance-jamie-docs',
        page_ids: [
          '11111111111111111111111111111111',
          '99999999999999999999999999999999',
        ],
        batch_id: 'notion-live',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_notion_import_result',
        status: 'staged_and_import_requested',
        eligible_file_count: 1,
        staged_files: [expect.objectContaining({
          workspace_relative_path: 'castor-solon/sources/notion-imports/notion-live/solon-api-page-11111111.md',
        })],
        operation: { name: 'operations/rag-import-1' },
        errors: [{
          object_id: '99999999999999999999999999999999',
          object_type: 'page',
          code: 'notion_api_error',
        }],
      });

      const markdownPath = join(workspaceRoot, 'castor-solon', 'sources', 'notion-imports', 'notion-live', 'solon-api-page-11111111.md');
      const markdown = readFileSync(markdownPath, 'utf8');
      expect(markdown).toContain('kind: "notion"');
      expect(markdown).toContain('notion_object_id: "11111111111111111111111111111111"');
      expect(markdown).toContain('parent_database_id: "33333333333333333333333333333333"');
      expect(markdown).toContain('This is imported from Notion.');
      expect(markdown).toContain('Unsupported text still appears.');
      expect(markdown).toContain('notion_block_unsupported:unsupported_block');

      const registryPath = join(workspaceRoot, 'castor-solon', 'references', 'source-registry.jsonl');
      const registry = readFileSync(registryPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(registry).toEqual([expect.objectContaining({
        source_id: 'governance-notion-import-notion-live',
        kind: 'notion_import',
        batch_id: 'notion-live',
        staged_file_count: 1,
        target_corpus_id: 'governance-jamie-docs',
        ingest_status: 'import_requested',
      })]);
      expect(JSON.stringify(result)).not.toContain('secret-notion-token');
      expect(googleCalls.some((call) => call.url.includes('/ragFiles:import'))).toBe(true);
      expect(googleCalls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('notion_import live database import paginates row pages with cap and subdirectory', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const notionCalls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch([]),
        },
        notion: {
          token: 'secret-notion-token',
          maxObjects: 2,
          fetchImpl: fakeNotionFetch(notionCalls, {
            databaseRowBatches: [
              ['44444444444444444444444444444444'],
              ['55555555555555555555555555555555', '66666666666666666666666666666666'],
            ],
          }),
        },
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'notion_import',
        domain_id: 'governance',
        corpus_id: 'governance-jamie-docs',
        database_ids: ['33333333333333333333333333333333'],
        batch_id: 'notion-db',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_notion_import_result',
        status: 'staged_and_import_requested',
        skipped_object_count: 1,
        eligible_file_count: 2,
      });
      expect(result.derived_files).toEqual([
        expect.objectContaining({
          notion_object_id: '44444444444444444444444444444444',
          workspace_relative_path: 'castor-solon/sources/notion-imports/notion-db/research-database/database-row-one-44444444.md',
        }),
        expect.objectContaining({
          notion_object_id: '55555555555555555555555555555555',
          workspace_relative_path: 'castor-solon/sources/notion-imports/notion-db/research-database/database-row-two-55555555.md',
        }),
      ]);
      expect(existsSync(join(workspaceRoot, 'castor-solon', 'sources', 'notion-imports', 'notion-db', 'research-database', 'database-row-one-44444444.md'))).toBe(true);
      expect(notionCalls.filter((call) => call.url.endsWith('/v1/databases/33333333333333333333333333333333/query'))).toHaveLength(4);
      expect(JSON.stringify(result)).toContain('notion_database_row_count_capped');
    } finally {
      cleanup();
    }
  });

  test('web_import derives manual YouTube subtitles through yt-dlp metadata and cleans VTT text', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://www.youtube.com/watch?v=abc123': webFixture({
              body: '<html><title>DAO Talk - YouTube</title></html>',
              headers: { 'content-type': 'text/html' },
            }),
            'https://captions.example/manual.vtt': webFixture({
              body: [
                'WEBVTT',
                '',
                '00:00:00.000 --> 00:00:02.000 align:start',
                'Hello &amp; welcome',
                'Hello &amp; welcome',
                '',
                '00:00:02.000 --> 00:00:04.000',
                '<c>Second line</c>',
              ].join('\n'),
              headers: { 'content-type': 'text/vtt' },
            }),
        }),
        resolveHostImpl: fakeResolveHost(),
        mediaExec: fakeYtDlpExec(execCalls, {
          'https://www.youtube.com/watch?v=abc123': {
            metadata: {
              title: 'DAO Talk',
              channel: 'Governance Channel',
              subtitles: {
                en: [{ ext: 'vtt', url: 'https://captions.example/manual.vtt' }],
              },
            },
          },
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://www.youtube.com/watch?v=abc123'],
        batch_id: 'yt-batch',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_result',
        status: 'staged_and_import_requested',
        eligible_file_count: 1,
      });
      expect(result.url_results).toEqual([
        expect.objectContaining({ source_url: 'https://www.youtube.com/watch?v=abc123', handler: 'youtube', file_count: 1, error_count: 0, expected_path: 'captions', caption_source: 'manual' }),
      ]);
      const transcriptRelativePath = (result.derived_files as Array<{ workspace_relative_path: string }>)[0]!.workspace_relative_path;
      const transcriptPath = join(workspaceRoot, ...transcriptRelativePath.split('/'));
      const transcript = readFileSync(transcriptPath, 'utf8');
      expect(transcript).toContain('source_url: "https://www.youtube.com/watch?v=abc123"');
      expect(transcript).toContain('retrieved_at: "');
      expect(transcript).toContain('kind: "youtube"');
      expect(transcript).toContain('transcript_source: "captions"');
      expect(transcript).toContain('channel: "Governance Channel"');
      expect(transcript).toContain('Hello & welcome\nSecond line');
      expect(transcript).not.toContain('-->');
      expect(transcript.match(/Hello & welcome/g)).toHaveLength(1);
      expect(execCalls).toHaveLength(1);
      expect(execCalls[0]!.args).toContain('--dump-json');
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/'))).toBe(true);
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('web_import falls back to auto-generated YouTube subtitles when manual subtitles are absent', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://youtu.be/auto123': webFixture({ body: '<html>video</html>', headers: { 'content-type': 'text/html' } }),
            'https://captions.example/auto.vtt': webFixture({ body: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAuto line', headers: { 'content-type': 'text/vtt' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        mediaExec: fakeYtDlpExec(execCalls, {
          'https://youtu.be/auto123': {
            metadata: {
              title: 'Auto Talk',
              automatic_captions: { en: [{ ext: 'vtt', url: 'https://captions.example/auto.vtt' }] },
            },
          },
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://youtu.be/auto123'],
        batch_id: 'auto-batch',
        dry_run: false,
      });

      expect(result.url_results).toEqual([
        expect.objectContaining({ expected_path: 'captions', caption_source: 'auto', transcript_source: 'captions' }),
      ]);
      const transcriptRelativePath = (result.derived_files as Array<{ workspace_relative_path: string }>)[0]!.workspace_relative_path;
      const transcript = readFileSync(join(workspaceRoot, ...transcriptRelativePath.split('/')), 'utf8');
      expect(transcript).toContain('transcript_source: "captions"');
      expect(transcript).toContain('Auto line');
    } finally {
      cleanup();
    }
  });

  test('web_import transcript_mode=asr bypasses caption tiers and transcribes audio', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://www.youtube.com/watch?v=forceasr': webFixture({ body: '<html>video</html>', headers: { 'content-type': 'text/html' } }),
            'https://captions.example/manual-force.vtt': webFixture({ body: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nCaption line', headers: { 'content-type': 'text/vtt' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        mediaExec: fakeYtDlpExec(execCalls, {
          'https://www.youtube.com/watch?v=forceasr': {
            metadata: {
              title: 'Force ASR Talk',
              subtitles: { en: [{ ext: 'vtt', url: 'https://captions.example/manual-force.vtt' }] },
              automatic_captions: { en: [{ ext: 'vtt', url: 'https://captions.example/auto-force.vtt' }] },
            },
            download: { fileName: 'audio.m4a', bytes: new TextEncoder().encode('audio-bytes') },
          },
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://www.youtube.com/watch?v=forceasr'],
        batch_id: 'force-asr-batch',
        transcript_mode: 'asr',
        dry_run: false,
      });

      expect(result.url_results).toEqual([
        expect.objectContaining({ expected_path: 'will_transcribe', transcript_mode: 'asr', transcript_source: 'asr' }),
      ]);
      expect(calls.some((call) => call.url === 'https://captions.example/manual-force.vtt')).toBe(false);
      expect(execCalls.some((call) => call.args.includes('-f'))).toBe(true);
      const transcriptRelativePath = (result.derived_files as Array<{ workspace_relative_path: string }>)[0]!.workspace_relative_path;
      const transcript = readFileSync(join(workspaceRoot, ...transcriptRelativePath.split('/')), 'utf8');
      expect(transcript).toContain('transcript_source: "asr"');
      expect(transcript).toContain('Gemini media transcript text.');
    } finally {
      cleanup();
    }
  });

  test('web_import transcript_mode=captions reports a per-URL error without ASR fallback', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://www.youtube.com/watch?v=nocaptions': webFixture({ body: '<html>video</html>', headers: { 'content-type': 'text/html' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        mediaExec: fakeYtDlpExec(execCalls, {
          'https://www.youtube.com/watch?v=nocaptions': {
            metadata: { title: 'No Captions Talk', subtitles: {}, automatic_captions: {} },
            download: { fileName: 'audio.m4a', bytes: new TextEncoder().encode('audio-bytes') },
          },
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://www.youtube.com/watch?v=nocaptions'],
        batch_id: 'captions-only-batch',
        transcript_mode: 'captions',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_result',
        status: 'web_import_no_importable_files',
      });
      expect(result.url_results).toEqual([
        expect.objectContaining({ handler: 'youtube', file_count: 0, error_count: 1, transcript_mode: 'captions' }),
      ]);
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'youtube_captions_unavailable', handler: 'youtube' }),
      ]);
      expect(execCalls.some((call) => call.args.includes('-f'))).toBe(false);
      expect(calls.some((call) => call.url.includes(':generateContent') && call.body.includes('fileData'))).toBe(false);
      expect(existsSync(join(workspaceRoot, 'castor-solon', 'sources', 'web-imports', 'captions-only-batch'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('web_import downloads YouTube audio for Gemini ASR when subtitles are absent', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://www.youtube.com/watch?v=asr123': webFixture({ body: '<html>video</html>', headers: { 'content-type': 'text/html' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        mediaExec: fakeYtDlpExec(execCalls, {
          'https://www.youtube.com/watch?v=asr123': {
            metadata: { title: 'ASR Talk', subtitles: {}, automatic_captions: {} },
            download: { fileName: 'audio.m4a', bytes: new TextEncoder().encode('audio-bytes') },
          },
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://www.youtube.com/watch?v=asr123'],
        batch_id: 'asr-batch',
        dry_run: false,
      });

      expect(result.url_results).toEqual([
        expect.objectContaining({ expected_path: 'will_transcribe', transcript_source: 'asr' }),
      ]);
      const audioUpload = calls.find((call) => call.url.includes('staged%2Fgovernance%2Fmedia%2Fasr-batch%2F'));
      expect(audioUpload).toBeDefined();
      const transcribeCall = calls.find((call) => call.url.includes(':generateContent') && call.body.includes('fileData'));
      expect(transcribeCall).toBeDefined();
      expect(JSON.parse(transcribeCall!.body).contents[0].parts[1].fileData.fileUri).toContain('gs://fixture-governance-rag/staged/governance/media/asr-batch/');
      const transcriptRelativePath = (result.derived_files as Array<{ workspace_relative_path: string }>)[0]!.workspace_relative_path;
      const transcript = readFileSync(join(workspaceRoot, ...transcriptRelativePath.split('/')), 'utf8');
      expect(transcript).toContain('transcript_source: "asr"');
      expect(transcript).toContain('Gemini media transcript text.');
      expect(execCalls.some((call) => call.args.includes('-f'))).toBe(true);
      const downloadCwd = execCalls.find((call) => call.args.includes('-f'))?.cwd;
      expect(downloadCwd).toBeDefined();
      expect(existsSync(downloadCwd!)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('web_import records oversized YouTube audio as a per-URL error without upload', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://youtu.be/huge': webFixture({ body: '<html>video</html>', headers: { 'content-type': 'text/html' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        mediaExec: fakeYtDlpExec(execCalls, {
          'https://youtu.be/huge': {
            metadata: { title: 'Huge Talk', subtitles: {}, automatic_captions: {} },
            download: { fileName: 'audio.m4a', size: (200 * 1024 * 1024) + 1 },
          },
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://youtu.be/huge'],
        batch_id: 'huge-batch',
        dry_run: false,
      });

      expect(result.status).toBe('web_import_no_importable_files');
      expect(result.errors).toEqual([expect.objectContaining({ code: 'media_size_limit_exceeded' })]);
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/'))).toBe(false);
      expect(calls.some((call) => call.url.includes(':generateContent') && call.body.includes('fileData'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('web_import reports missing yt-dlp as media_tooling_not_configured', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://youtu.be/missing-tool': webFixture({ body: '<html>video</html>', headers: { 'content-type': 'text/html' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        mediaExec: async () => {
          const error = new Error('spawn yt-dlp ENOENT') as Error & { code: string };
          error.code = 'ENOENT';
          throw error;
        },
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://youtu.be/missing-tool'],
        batch_id: 'missing-tool',
      });

      expect(result.errors).toEqual([expect.objectContaining({
        code: 'media_tooling_not_configured',
        message: expect.stringContaining('pip3 install --user yt-dlp'),
      })]);
    } finally {
      cleanup();
    }
  });

  test('web_import isolates one failing YouTube URL while importing a succeeding page', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://youtu.be/fails': webFixture({ body: '<html>video</html>', headers: { 'content-type': 'text/html' } }),
            'https://example.com/research': webFixture({ body: richHtml('Research Page'), headers: { 'content-type': 'text/html' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        mediaExec: fakeYtDlpExec(execCalls, {
          'https://youtu.be/fails': {
            error: Object.assign(new Error('yt-dlp failed with HTTP 429'), { stderr: 'line one\nrate limited by youtube' }),
          },
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://youtu.be/fails', 'https://example.com/research'],
        batch_id: 'isolation-batch',
        dry_run: false,
      });

      expect(result).toMatchObject({
        status: 'staged_and_import_requested',
        eligible_file_count: 1,
        errors: [expect.objectContaining({ code: 'yt_dlp_failed', stderr_tail: expect.stringContaining('rate limited') })],
      });
      expect(result.url_results).toEqual([
        expect.objectContaining({ source_url: 'https://youtu.be/fails', error_count: 1 }),
        expect.objectContaining({ source_url: 'https://example.com/research', handler: 'generic-html', file_count: 1, error_count: 0 }),
      ]);
    } finally {
      cleanup();
    }
  });

  test('web_import dry-run probes YouTube metadata only and performs no download, upload, or transcription', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://youtu.be/dry': webFixture({ body: '<html>video</html>', headers: { 'content-type': 'text/html' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        mediaExec: fakeYtDlpExec(execCalls, {
          'https://youtu.be/dry': {
            metadata: { title: 'Dry Talk', subtitles: {}, automatic_captions: {} },
            download: { fileName: 'audio.m4a', bytes: new TextEncoder().encode('should-not-download') },
          },
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://youtu.be/dry'],
        batch_id: 'dry-youtube',
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_plan',
        status: 'dry_run_web_import_no_importable_files',
      });
      expect(result.url_results).toEqual([
        expect.objectContaining({ expected_path: 'will_transcribe', transcript_source: 'asr' }),
      ]);
      expect(execCalls).toHaveLength(1);
      expect(execCalls[0]!.args).toContain('--dump-json');
      expect(execCalls[0]!.args).not.toContain('-f');
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/'))).toBe(false);
      expect(calls.some((call) => call.url.includes(':generateContent') && call.body.includes('fileData'))).toBe(false);
      expect(existsSync(join(workspaceRoot, 'castor-solon', 'sources', 'web-imports', 'dry-youtube'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('web_import media helpers do not inherit raw worker credentials', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const envCapturePath = join(base, 'yt-dlp-env.txt');
    const ytDlpBin = join(base, 'yt-dlp-env-fixture.sh');
    const secretEnv: Record<string, string> = {
      OLYMPUS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key":"secret-google-key"}',
      OLYMPUS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN: 'secret-google-access-token',
      OLYMPUS_DOMAIN_EXPERT_ANNAS_ARCHIVE_API_KEY: 'secret-annas-token',
      OP_SERVICE_ACCOUNT_TOKEN: 'secret-op-token',
      OP_CONNECT_TOKEN: 'secret-op-connect-token',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/secret-google-application-credentials.json',
    };
    const previousEnv = Object.fromEntries(
      Object.keys(secretEnv).map((key) => [key, process.env[key]]),
    ) as Record<string, string | undefined>;
    writeFileSync(ytDlpBin, [
      '#!/bin/sh',
      `env > ${shellSingleQuote(envCapturePath)}`,
      'printf \'%s\\n\' \'{"title":"Secret Probe","subtitles":{},"automatic_captions":{}}\'',
      '',
    ].join('\n'));
    chmodSync(ytDlpBin, 0o700);

    try {
      Object.assign(process.env, secretEnv);
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://youtu.be/env-scrub': webFixture({ body: '<html>video</html>', headers: { 'content-type': 'text/html' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        ytDlpBin,
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://youtu.be/env-scrub'],
        batch_id: 'env-scrub',
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_plan',
        status: 'dry_run_web_import_no_importable_files',
      });
      const helperEnv = readFileSync(envCapturePath, 'utf8');
      for (const key of Object.keys(secretEnv)) {
        expect(helperEnv).not.toContain(`${key}=`);
      }
      expect(helperEnv).toContain('PATH=');
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      cleanup();
    }
  });

  test('stage_import include_media stages raw media and adds a Gemini ASR transcript markdown', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const mediaDir = join(workspaceRoot, 'castor-solon', 'sources', 'media');
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(join(mediaDir, 'talk.mp3'), new TextEncoder().encode('audio-bytes'));
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'stage_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        workspace_relative_path: 'castor-solon/sources/media',
        batch_id: 'workspace-media',
        include_media: true,
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_stage_import_result',
        status: 'staged_and_import_requested',
        staged_files: [
          expect.objectContaining({ workspace_relative_path: 'castor-solon/sources/media/talk.mp3' }),
          expect.objectContaining({
            kind: 'media_transcript',
            transcript_source: 'asr',
            workspace_relative_path: 'castor-solon/sources/media/talk.mp3.transcript.md',
          }),
        ],
      });
      const transcribeCall = calls.find((call) => call.url.includes(':generateContent') && call.body.includes('fileData'));
      expect(transcribeCall).toBeDefined();
      expect(JSON.parse(transcribeCall!.body).contents[0].parts[1].fileData).toMatchObject({
        fileUri: 'gs://fixture-governance-rag/staged/governance/workspace-media/talk.mp3',
        mimeType: 'audio/mpeg',
      });
      const uploadUrls = calls.filter((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/fixture-governance-rag/o'));
      expect(uploadUrls.length).toBeGreaterThanOrEqual(2);
      expect(uploadUrls.some((call) => call.url.includes('talk.mp3.transcript.md'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('web_import extracts rich HTML and warns on short generic extraction', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const richText = Array.from({ length: 18 }, (_, index) => `Governance paragraph ${index} explains durable institutional design.`).join(' ');
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://example.com/research': webFixture({
              body: `<html><head><title>Research Page</title><script>bad()</script></head><body><header>skip</header><nav>nav</nav><main><p>${richText}</p></main><footer>skip</footer></body></html>`,
              headers: { 'content-type': 'text/html' },
            }),
            'https://example.com/short': webFixture({
              body: '<html><title>Short Page</title><main>tiny</main></html>',
              headers: { 'content-type': 'text/html' },
            }),
        }),
        resolveHostImpl: fakeResolveHost(),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://example.com/research', 'https://example.com/short'],
        batch_id: 'html-batch',
      });

      expect(result.derived_files).toEqual([
        expect.objectContaining({ kind: 'html', workspace_relative_path: 'castor-solon/sources/web-imports/html-batch/research-page.md' }),
        expect.objectContaining({ kind: 'html', warnings: ['short_extraction'] }),
      ]);
      const rich = readFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'web-imports', 'html-batch', 'research-page.md'), 'utf8');
      expect(rich).toContain('source_url: "https://example.com/research"');
      expect(rich).toContain('retrieved_at: "');
      expect(rich).toContain('kind: "html"');
      expect(rich).toContain('Governance paragraph 0');
      expect(rich).not.toContain('bad()');
      expect(rich).not.toContain('nav');
    } finally {
      cleanup();
    }
  });

  test('web_import stages direct files and gates media behind include_media', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://files.example/report.pdf': webFixture({
              body: new TextEncoder().encode('%PDF-1.4 test'),
              headers: { 'content-type': 'application/pdf' },
            }),
            'https://files.example/image.png': webFixture({
              body: new Uint8Array([137, 80, 78, 71]),
              headers: { 'content-type': 'image/png' },
            }),
        }),
        resolveHostImpl: fakeResolveHost(),
        dataDir: join(base, 'data'),
      });

      const pdf = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://files.example/report.pdf'],
        batch_id: 'pdf-batch',
      });
      expect(pdf).toMatchObject({
        eligible_file_count: 1,
        derived_files: [expect.objectContaining({ kind: 'file', workspace_relative_path: 'castor-solon/sources/web-imports/pdf-batch/report.pdf' })],
      });
      expect(readFileSync(join(workspaceRoot, 'castor-solon', 'sources', 'web-imports', 'pdf-batch', 'report.pdf'), 'utf8')).toBe('%PDF-1.4 test');

      const mediaSkipped = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://files.example/image.png'],
        batch_id: 'media-skip',
      });
      expect(mediaSkipped).toMatchObject({
        status: 'dry_run_web_import_no_importable_files',
        eligible_file_count: 0,
        errors: [expect.objectContaining({ code: 'media_requires_include_media' })],
      });

      const mediaIncluded = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://files.example/image.png'],
        batch_id: 'media-include',
        include_media: true,
      });
      expect(mediaIncluded).toMatchObject({
        eligible_file_count: 1,
        eligible_files: [expect.objectContaining({
          workspace_relative_path: 'castor-solon/sources/web-imports/media-include/image.png',
          upload_relative_path: 'image.png',
        })],
      });
    } finally {
      cleanup();
    }
  });

  test('web_import rejects http, private IPs, and redirects to private addresses before import', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://redirect.example/start': webFixture({
              status: 302,
              headers: { location: 'https://127.0.0.1/private' },
            }),
            'https://mapped-redirect.example/start': webFixture({
              status: 302,
              headers: { location: 'https://[0:0:0:0:0:ffff:7f00:1]/private' },
            }),
        }),
        resolveHostImpl: fakeResolveHost({
          'mapped.example': ['0:0:0:0:0:ffff:7f00:1'],
          'mapped-private.example': ['0:0:0:0:0:ffff:c0a8:101'],
          'redirect.example': ['93.184.216.34'],
          'mapped-redirect.example': ['93.184.216.34'],
        }),
        dataDir: join(base, 'data'),
      });

      const http = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['http://example.com/page'],
        batch_id: 'http-denied',
      });
      expect(http.status).toBe(400);
      expect(await http.json()).toMatchObject({ error: { code: 'web_import_https_required' } });

      const privateIp = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://127.0.0.1/file.pdf'],
        batch_id: 'private-denied',
      });
      expect(privateIp.status).toBe(400);
      expect(await privateIp.json()).toMatchObject({ error: { code: 'web_import_private_address_denied' } });

      const expandedMappedLiteral = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://[0:0:0:0:0:ffff:7f00:1]/file.pdf'],
        batch_id: 'expanded-mapped-literal-denied',
      });
      expect(expandedMappedLiteral.status).toBe(400);
      expect(await expandedMappedLiteral.json()).toMatchObject({ error: { code: 'web_import_private_address_denied' } });

      const compressedMappedLiteral = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://[::ffff:c0a8:101]/file.pdf'],
        batch_id: 'compressed-mapped-literal-denied',
      });
      expect(compressedMappedLiteral.status).toBe(400);
      expect(await compressedMappedLiteral.json()).toMatchObject({ error: { code: 'web_import_private_address_denied' } });

      const expandedMappedDns = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://mapped.example/file.pdf'],
        batch_id: 'expanded-mapped-dns-denied',
      });
      expect(expandedMappedDns.status).toBe(400);
      expect(await expandedMappedDns.json()).toMatchObject({ error: { code: 'web_import_private_address_denied' } });

      const expandedMappedPrivateDns = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://mapped-private.example/file.pdf'],
        batch_id: 'expanded-mapped-private-dns-denied',
      });
      expect(expandedMappedPrivateDns.status).toBe(400);
      expect(await expandedMappedPrivateDns.json()).toMatchObject({ error: { code: 'web_import_private_address_denied' } });

      const redirect = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://redirect.example/start'],
        batch_id: 'redirect-denied',
      });
      expect(redirect.status).toBe(400);
      expect(await redirect.json()).toMatchObject({ error: { code: 'web_import_private_address_denied' } });

      const mappedRedirect = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://mapped-redirect.example/start'],
        batch_id: 'mapped-redirect-denied',
      });
      expect(mappedRedirect.status).toBe(400);
      expect(await mappedRedirect.json()).toMatchObject({ error: { code: 'web_import_private_address_denied' } });
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('web_import fetch transport receives prevalidated public addresses', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const transportCalls: Array<{ url: string; validatedAddresses: string[] }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: async (url, options) => {
          transportCalls.push({
            url: url.toString(),
            validatedAddresses: [...options.validatedAddresses],
          });
          return new Response(richHtml('Pinned Import'), {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
        resolveHostImpl: fakeResolveHost({
          'rebind.example': ['93.184.216.34'],
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://rebind.example/page'],
        batch_id: 'pinned-fetch',
        dry_run: false,
      });

      expect(result.kind).toBe('rag_corpus_web_import_result');
      expect(transportCalls).toEqual([{
        url: 'https://rebind.example/page',
        validatedAddresses: ['93.184.216.34'],
      }]);
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/fixture-governance-rag/o'))).toBe(true);
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('web_import times out stalled response bodies without import', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    let bodyCanceled = false;
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial body'));
          },
          cancel() {
            bodyCanceled = true;
          },
        }), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
        webImportFetchTimeoutMs: 20,
        resolveHostImpl: fakeResolveHost({
          'stall.example': ['93.184.216.34'],
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://stall.example/page'],
        batch_id: 'stalled-fetch',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_result',
        status: 'web_import_no_importable_files',
      });
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'web_import_fetch_timeout', source_url: 'https://stall.example/page' }),
      ]);
      expect(bodyCanceled).toBe(true);
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/fixture-governance-rag/o'))).toBe(false);
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('web_import does not charge timed-out content-length bodies against the batch budget', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    let canceledBodies = 0;
    try {
      const web: Record<string, WebFixture> = {
        'https://budget.example/valid': webFixture({
          body: richHtml('Budget Valid Import'),
          headers: { 'content-type': 'text/html' },
        }),
      };
      for (let index = 1; index <= 4; index += 1) {
        web[`https://budget.example/stall-${index}`] = webFixture({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`partial body ${index}`));
            },
            cancel() {
              canceledBodies += 1;
            },
          }),
          headers: {
            'content-type': 'text/html',
            'content-length': String(25 * 1024 * 1024),
          },
        });
      }
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: fakeWebImportFetch(calls, web),
        webImportFetchTimeoutMs: 20,
        resolveHostImpl: fakeResolveHost(),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: [
          'https://budget.example/stall-1',
          'https://budget.example/stall-2',
          'https://budget.example/stall-3',
          'https://budget.example/stall-4',
          'https://budget.example/valid',
        ],
        batch_id: 'timeout-budget-released',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_result',
        status: 'staged_and_import_requested',
      });
      expect(result.errors).toHaveLength(4);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'web_import_fetch_timeout', source_url: 'https://budget.example/stall-1' }),
          expect.objectContaining({ code: 'web_import_fetch_timeout', source_url: 'https://budget.example/stall-2' }),
          expect.objectContaining({ code: 'web_import_fetch_timeout', source_url: 'https://budget.example/stall-3' }),
          expect.objectContaining({ code: 'web_import_fetch_timeout', source_url: 'https://budget.example/stall-4' }),
        ]),
      );
      expect(canceledBodies).toBe(4);
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/fixture-governance-rag/o'))).toBe(true);
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('web_import enforces per-fetch and batch fetch caps', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const web: Record<string, WebFixture> = {
        'https://big.example/too-large.pdf': webFixture({
          body: 'x',
          headers: { 'content-type': 'application/pdf', 'content-length': String((25 * 1024 * 1024) + 1) },
        }),
      };
      for (let index = 1; index <= 5; index += 1) {
        web[`https://big.example/batch-${index}.pdf`] = webFixture({
          body: 'x',
          headers: { 'content-type': 'application/pdf', 'content-length': String(25 * 1024 * 1024) },
        });
      }
      for (let index = 1; index <= 126; index += 1) {
        web[`https://redirects.example/start-${index}`] = webFixture({
          status: 302,
          headers: { location: `https://redirects.example/final-${index}` },
        });
        web[`https://redirects.example/final-${index}`] = webFixture({
          body: richHtml(`Redirect ${index}`),
          headers: { 'content-type': 'text/html' },
        });
      }
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: fakeWebImportFetch(calls, web),
        resolveHostImpl: fakeResolveHost(),
        dataDir: join(base, 'data'),
      });

      const perFetch = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://big.example/too-large.pdf'],
        batch_id: 'too-large',
      });
      expect(perFetch.status).toBe(413);
      expect(await perFetch.json()).toMatchObject({ error: { code: 'web_import_fetch_size_limit_exceeded' } });

      const batch = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: [1, 2, 3, 4, 5].map((index) => `https://big.example/batch-${index}.pdf`),
        batch_id: 'batch-too-large',
      });
      expect(batch.status).toBe(413);
      expect(await batch.json()).toMatchObject({ error: { code: 'web_import_batch_size_limit_exceeded' } });

      const fetchLimit = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: Array.from({ length: 126 }, (_, index) => `https://redirects.example/start-${index + 1}`),
        batch_id: 'fetch-count-too-large',
      });
      expect(fetchLimit.status).toBe(400);
      expect(await fetchLimit.json()).toMatchObject({ error: { code: 'web_import_fetch_limit_exceeded' } });
    } finally {
      cleanup();
    }
  });

  test('web_import redacts signed URL material from returned and persisted provenance', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const fetchedUrls: string[] = [];
    const signedSource = 'https://example.com/private/report?token=secret-token&X-Amz-Signature=secret-sig#secret-fragment';
    const signedFinal = 'https://cdn.example/final/report?download_token=secret-final&Signature=secret-final-sig#final-fragment';
    const failingSource = 'https://fail.example/blocked?token=secret-fail#fail-fragment';
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: async (url) => {
          fetchedUrls.push(url.toString());
          if (url.hostname === 'example.com') {
            return new Response('', {
              status: 302,
              headers: { location: signedFinal },
            });
          }
          if (url.hostname === 'cdn.example') {
            return new Response(richHtml('Signed Link Page'), {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          }
          if (url.hostname === 'fail.example') {
            return new Response('denied', {
              status: 403,
              headers: { 'content-type': 'text/plain' },
            });
          }
          return new Response('missing', { status: 404 });
        },
        resolveHostImpl: fakeResolveHost({
          'example.com': ['93.184.216.34'],
          'cdn.example': ['93.184.216.34'],
          'fail.example': ['93.184.216.34'],
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: [signedSource, failingSource],
        batch_id: 'signed-url-redaction',
        dry_run: false,
      });

      expect(fetchedUrls).toEqual([signedSource, signedFinal, failingSource]);
      expect(result).toMatchObject({
        status: 'staged_and_import_requested',
        source: {
          urls: ['https://example.com/private/report', 'https://fail.example/blocked'],
        },
        derived_files: [expect.objectContaining({
          source_url: 'https://example.com/private/report',
          final_url: 'https://cdn.example/final/report',
        })],
        url_results: [
          expect.objectContaining({
            source_url: 'https://example.com/private/report',
            final_url: 'https://cdn.example/final/report',
            error_count: 0,
          }),
          expect.objectContaining({
            source_url: 'https://fail.example/blocked',
            error_count: 1,
          }),
        ],
        errors: [expect.objectContaining({
          source_url: 'https://fail.example/blocked',
          code: 'web_import_fetch_failed',
          message: 'Fetch failed for https://fail.example/blocked with HTTP 403.',
        })],
      });

      const markdownPath = join(workspaceRoot, 'castor-solon', 'sources', 'web-imports', 'signed-url-redaction', 'signed-link-page.md');
      const registryPath = join(workspaceRoot, 'castor-solon', 'references', 'source-registry.jsonl');
      const persisted = [
        JSON.stringify(result),
        readFileSync(markdownPath, 'utf8'),
        readFileSync(registryPath, 'utf8'),
        JSON.stringify(calls),
      ].join('\n');
      for (const leaked of ['secret-token', 'secret-sig', 'secret-fragment', 'secret-final', 'secret-final-sig', 'final-fragment', 'secret-fail', 'fail-fragment']) {
        expect(persisted).not.toContain(leaked);
      }
      expect(persisted).toContain('source_url: "https://example.com/private/report"');
      expect(persisted).toContain('"urls":["https://example.com/private/report","https://fail.example/blocked"]');
    } finally {
      cleanup();
    }
  });

  test('web_import live path uploads/imports and appends registry, while dry-run does not', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        webImportFetchImpl: fakeWebImportFetch(calls, {
            'https://live.example/dry': webFixture({ body: richHtml('Dry Page'), headers: { 'content-type': 'text/html' } }),
            'https://live.example/live': webFixture({ body: richHtml('Live Page'), headers: { 'content-type': 'text/html' } }),
        }),
        resolveHostImpl: fakeResolveHost(),
        dataDir: join(base, 'data'),
      });

      await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://live.example/dry'],
        batch_id: 'dry-registry',
      });
      const registryPath = join(workspaceRoot, 'castor-solon', 'references', 'source-registry.jsonl');
      expect(existsSync(registryPath)).toBe(false);

      const live = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://live.example/live'],
        batch_id: 'live-registry',
        dry_run: false,
      });
      expect(live).toMatchObject({
        kind: 'rag_corpus_web_import_result',
        status: 'staged_and_import_requested',
        operation: { name: 'operations/rag-import-1' },
        staged_files: [expect.objectContaining({
          workspace_relative_path: 'castor-solon/sources/web-imports/live-registry/live-page.md',
        })],
      });
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/'))).toBe(true);
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(true);
      const records = readFileSync(registryPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records).toEqual([expect.objectContaining({
        kind: 'web_import',
        urls: ['https://live.example/live'],
        batch_id: 'live-registry',
        staged_file_count: 1,
        ingest_status: 'import_requested',
      })]);
    } finally {
      cleanup();
    }
  });

  test('domain_source list reads latest records with filters, history, malformed count, and no writes', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    try {
      const registryPath = join(workspaceRoot, 'castor-solon', 'references', 'source-registry.jsonl');
      mkdirSync(join(workspaceRoot, 'castor-solon', 'references'), { recursive: true });
      writeFileSync(registryPath, [
        JSON.stringify({
          source_id: 'source-a',
          domain_id: 'governance',
          kind: 'book',
          title: 'Old title',
          target_corpus_id: 'governance-jamie-docs',
          ingest_status: 'planned',
          registered_at: '2026-07-07T09:00:00.000Z',
        }),
        '{not json',
        JSON.stringify({
          source_id: 'source-b',
          domain_id: 'governance',
          kind: 'blog_post',
          target_corpus_id: 'governance-jamie-docs',
          ingest_status: 'planned',
          registered_at: '2026-07-07T09:05:00.000Z',
        }),
        JSON.stringify({
          source_id: 'source-a',
          domain_id: 'governance',
          kind: 'book',
          title: 'New title',
          target_corpus_id: 'governance-jamie-docs',
          ingest_status: 'import_requested',
          registered_at: '2026-07-07T10:00:00.000Z',
        }),
        JSON.stringify({
          source_id: 'source-c',
          domain_id: 'governance',
          kind: 'pdf',
          target_corpus_id: 'governance-jamie-docs',
          ingest_status: 'removed',
          removed: true,
          registered_at: '2026-07-07T10:05:00.000Z',
        }),
      ].join('\n'));
      const before = readFileSync(registryPath, 'utf8');
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        dataDir: join(base, 'data'),
      });

      const listed = await postDomain(worker, 'domain_source', {
        action: 'list',
        domain_id: 'governance',
        kind: 'book',
        corpus_id: 'governance-jamie-docs',
        include_history: true,
        dry_run: false,
      });

      expect(readFileSync(registryPath, 'utf8')).toBe(before);
      expect(listed).toMatchObject({
        kind: 'domain_source_list',
        registry_relative_path: 'castor-solon/references/source-registry.jsonl',
        total_records: 4,
        malformed_lines: 1,
        filters: {
          kind: 'book',
          corpus_id: 'governance-jamie-docs',
          include_history: true,
          include_removed: false,
        },
      });
      expect(listed.sources).toEqual([
        {
          source_id: 'source-a',
          record_count: 2,
          current: expect.objectContaining({ title: 'New title', ingest_status: 'import_requested' }),
          history: [
            expect.objectContaining({ title: 'Old title' }),
            expect.objectContaining({ title: 'New title' }),
          ],
        },
      ]);

      const withRemoved = await postDomain(worker, 'domain_source', {
        action: 'list',
        domain_id: 'governance',
        include_removed: true,
      });
      expect((withRemoved.sources as unknown[]).map((source) => (source as { source_id: string }).source_id)).toEqual([
        'source-b',
        'source-a',
        'source-c',
      ]);
    } finally {
      cleanup();
    }
  });

  test('domain_source list returns an honest empty result when the registry is missing', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        dataDir: join(base, 'data'),
      });

      const listed = await postDomain(worker, 'domain_source', {
        action: 'list',
        domain_id: 'governance',
        dry_run: false,
      });

      expect(listed).toMatchObject({
        kind: 'domain_source_list',
        total_records: 0,
        malformed_lines: 0,
        sources: [],
        note: 'Source registry castor-solon/references/source-registry.jsonl does not exist yet.',
      });
    } finally {
      cleanup();
    }
  });

  test('domain_source status reads full history, reports removed state, and never writes', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    try {
      const registryPath = join(workspaceRoot, 'castor-solon', 'references', 'source-registry.jsonl');
      mkdirSync(join(workspaceRoot, 'castor-solon', 'references'), { recursive: true });
      writeFileSync(registryPath, [
        JSON.stringify({
          source_id: 'source-a',
          domain_id: 'governance',
          ingest_status: 'planned',
          registered_at: '2026-07-07T09:00:00.000Z',
        }),
        JSON.stringify({
          source_id: 'source-a',
          domain_id: 'governance',
          ingest_status: 'removed',
          removed: true,
          registered_at: '2026-07-07T10:00:00.000Z',
        }),
      ].join('\n'));
      const before = readFileSync(registryPath, 'utf8');
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        dataDir: join(base, 'data'),
      });

      const status = await postDomain(worker, 'domain_source', {
        action: 'status',
        domain_id: 'governance',
        source_id: 'source-a',
        dry_run: false,
      });

      expect(readFileSync(registryPath, 'utf8')).toBe(before);
      expect(status).toMatchObject({
        kind: 'domain_source_status',
        source_id: 'source-a',
        removed: true,
        current: expect.objectContaining({ ingest_status: 'removed', removed: true }),
        history: [
          expect.objectContaining({ ingest_status: 'planned' }),
          expect.objectContaining({ ingest_status: 'removed' }),
        ],
      });

      const notFound = await postDomainResponse(worker, 'domain_source', {
        action: 'status',
        domain_id: 'governance',
        source_id: 'missing-source',
      });
      expect(notFound.status).toBe(404);
      const body = await notFound.json() as Record<string, { code: string; message: string }>;
      expect(body.error).toMatchObject({
        code: 'domain_source_not_found',
        message: 'Source missing-source was not found in castor-solon/references/source-registry.jsonl.',
      });
    } finally {
      cleanup();
    }
  });

  test('domain_source remove plans an existing target and live appends a tombstone plus ingest log', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    try {
      const registryPath = join(workspaceRoot, 'castor-solon', 'references', 'source-registry.jsonl');
      const logPath = join(workspaceRoot, 'castor-solon', 'references', 'ingest-log.md');
      mkdirSync(join(workspaceRoot, 'castor-solon', 'references'), { recursive: true });
      writeFileSync(registryPath, JSON.stringify({
        source_id: 'source-a',
        domain_id: 'governance',
        kind: 'book',
        ingest_status: 'import_requested',
        registered_at: '2026-07-07T10:00:00.000Z',
      }) + '\n');
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        dataDir: join(base, 'data'),
      });

      const dryRun = await postDomain(worker, 'domain_source', {
        action: 'remove',
        domain_id: 'governance',
        source_id: 'source-a',
      });
      expect(dryRun).toMatchObject({
        kind: 'domain_source_plan',
        action: 'remove',
        target_record: expect.objectContaining({ source_id: 'source-a', ingest_status: 'import_requested' }),
        tombstone_record: expect.objectContaining({ source_id: 'source-a', ingest_status: 'removed', removed: true }),
      });
      expect(readFileSync(registryPath, 'utf8').trim().split('\n')).toHaveLength(1);

      const live = await postDomain(worker, 'domain_source', {
        action: 'remove',
        domain_id: 'governance',
        source_id: 'source-a',
        dry_run: false,
      });
      expect(live).toMatchObject({
        kind: 'domain_source_result',
        status: 'removed',
        source_record: expect.objectContaining({ source_id: 'source-a', ingest_status: 'removed', removed: true }),
      });
      const records = readFileSync(registryPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records).toEqual([
        expect.objectContaining({ source_id: 'source-a', ingest_status: 'import_requested' }),
        expect.objectContaining({ source_id: 'source-a', ingest_status: 'removed', removed: true }),
      ]);
      expect(readFileSync(logPath, 'utf8')).toContain('removed source-a (remove)');

      const notFound = await postDomainResponse(worker, 'domain_source', {
        action: 'remove',
        domain_id: 'governance',
        source_id: 'missing-source',
        dry_run: false,
      });
      expect(notFound.status).toBe(404);
    } finally {
      cleanup();
    }
  });

  test('domain_source add keeps the existing planned/live record shape', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        dataDir: join(base, 'data'),
      });

      const planned = await postDomain(worker, 'domain_source', {
        action: 'add',
        domain_id: 'governance',
        source_id: 'source-a',
        kind: 'book',
        title: 'A Book',
        relative_path: 'castor-solon/sources/a-book.md',
        corpus_id: 'governance-jamie-docs',
      });
      expect(planned).toMatchObject({
        kind: 'domain_source_plan',
        source_record: expect.objectContaining({
          source_id: 'source-a',
          kind: 'book',
          title: 'A Book',
          workspace_relative_path: 'castor-solon/sources/a-book.md',
          target_corpus_id: 'governance-jamie-docs',
          ingest_status: 'planned',
        }),
      });

      const live = await postDomain(worker, 'domain_source', {
        action: 'add',
        domain_id: 'governance',
        source_id: 'source-a',
        kind: 'book',
        title: 'A Book',
        relative_path: 'castor-solon/sources/a-book.md',
        corpus_id: 'governance-jamie-docs',
        dry_run: false,
      });
      expect(live).toMatchObject({
        kind: 'domain_source_result',
        status: 'registered',
        source_record: expect.objectContaining({
          source_id: 'source-a',
          ingest_status: 'planned',
        }),
      });
    } finally {
      cleanup();
    }
  });

  test('web_import redirect to YouTube runs yt-dlp only on the validated YouTube final URL', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
          'https://attacker.example/redirect': webFixture({
            status: 302,
            headers: { location: 'https://www.youtube.com/watch?v=redirected123' },
          }),
          'https://www.youtube.com/watch?v=redirected123': webFixture({
            body: '<html>video</html>',
            headers: { 'content-type': 'text/html' },
          }),
        }),
        resolveHostImpl: fakeResolveHost({
          'attacker.example': ['93.184.216.34'],
          'www.youtube.com': ['142.250.72.206'],
        }),
        mediaExec: fakeYtDlpExec(execCalls, {
          'https://www.youtube.com/watch?v=redirected123': {
            metadata: { title: 'Redirected Talk', subtitles: {}, automatic_captions: {} },
          },
        }),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://attacker.example/redirect'],
        batch_id: 'redirect-youtube',
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_plan',
        status: 'dry_run_web_import_no_importable_files',
      });
      expect(result.url_results).toEqual([
        expect.objectContaining({
          source_url: 'https://attacker.example/redirect',
          final_url: 'https://www.youtube.com/watch?v=redirected123',
          handler: 'youtube',
          youtube_metadata_title: 'Redirected Talk',
        }),
      ]);
      expect(execCalls).toHaveLength(1);
      expect(execCalls[0]!.args.at(-1)).toBe('https://www.youtube.com/watch?v=redirected123');
      expect(execCalls[0]!.args.at(-1)).not.toContain('attacker.example');
    } finally {
      cleanup();
    }
  });

  test('web_import refuses yt-dlp when the validated final URL is not an allowlisted YouTube host', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        webImportFetchImpl: fakeWebImportFetch(calls, {
          'https://www.youtube.com/redirect': webFixture({
            status: 302,
            headers: { location: 'https://attacker.example/final' },
          }),
          'https://attacker.example/final': webFixture({
            body: richHtml('Attacker Page'),
            headers: { 'content-type': 'text/html' },
          }),
        }),
        resolveHostImpl: fakeResolveHost({
          'www.youtube.com': ['142.250.72.206'],
          'attacker.example': ['93.184.216.34'],
        }),
        mediaExec: fakeYtDlpExec(execCalls, {}),
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://www.youtube.com/redirect'],
        batch_id: 'youtube-open-redirect',
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_plan',
        status: 'dry_run_web_import_no_importable_files',
      });
      expect(result.url_results).toEqual([
        {
          source_url: 'https://www.youtube.com/redirect',
          final_url: 'https://attacker.example/final',
          handler: 'youtube',
          file_count: 0,
          error_count: 1,
          transcript_mode: 'auto',
        },
      ]);
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'youtube_url_not_allowed', handler: 'youtube' }),
      ]);
      expect(execCalls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('web_import generic fetchImpl fails closed because it cannot enforce DNS pinning', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: { accessToken: 'test-google-token', fetchImpl: fakeGoogleFetch(calls) },
        fetchImpl: fakeGoogleFetch(calls, {
          web: {
            'https://unpinned.example/page': webFixture({
              body: richHtml('Unpinned Page'),
              headers: { 'content-type': 'text/html' },
            }),
          },
        }),
        resolveHostImpl: fakeResolveHost({
          'unpinned.example': ['93.184.216.34'],
        }),
        dataDir: join(base, 'data'),
      });

      const response = await postDomainResponse(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        urls: ['https://unpinned.example/page'],
        batch_id: 'unpinned-fetch',
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: 'web_import_unpinned_fetch_impl' } });
      expect(calls.some((call) => call.url === 'https://unpinned.example/page')).toBe(false);
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/'))).toBe(false);
      expect(existsSync(join(workspaceRoot, 'castor-solon', 'sources', 'web-imports', 'unpinned-fetch'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('web_import detects Notion URLs before fetch and points to notion_import', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        webImportFetchImpl: async (url) => {
          calls.push({ url: url.toString(), method: 'GET', body: '', headers: {} });
          throw new Error('Notion URLs must not be fetched by web_import');
        },
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'governance',
        corpus_id: '7777777777777777777',
        urls: ['https://notion.site/Solon-11111111111111111111111111111111?pvs=4'],
        batch_id: 'notion-web-detect',
        dry_run: true,
      });

      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_plan',
        status: 'dry_run_web_import_no_importable_files',
        handler_table: expect.arrayContaining(['notion', 'generic-html']),
        errors: [{
          source_url: 'https://notion.site/Solon-11111111111111111111111111111111',
          handler: 'notion',
          code: 'notion_requires_api_import',
          suggestion: expect.stringContaining('rag_corpus action=notion_import'),
        }],
        url_results: [{
          source_url: 'https://notion.site/Solon-11111111111111111111111111111111',
          handler: 'notion',
          file_count: 0,
          error_count: 1,
        }],
      });
      expect(calls).toEqual([]);
      expect(existsSync(join(workspaceRoot, 'castor-solon', 'sources', 'web-imports', 'notion-web-detect'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('web_import handler table does not select YouTube for substring-only URLs', () => {
    const selected = selectWebImportHandler({
      sourceUrl: 'https://example.com/watch?source=youtube.com',
      finalUrl: 'https://example.com/articles/youtube-analysis',
      sourceProvenanceUrl: 'https://example.com/watch',
      finalProvenanceUrl: 'https://example.com/articles/youtube-analysis',
      includeMedia: false,
      transcriptMode: 'auto',
      dryRun: true,
      fetchedAt: '2026-07-05T00:00:00.000Z',
      response: {
        url: 'https://example.com/articles/youtube-analysis',
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        bytes: new TextEncoder().encode(richHtml('YouTube Analysis')),
      },
      fetch: async () => {
        throw new Error('not used');
      },
      media: fakeMediaRuntime(),
    });

    expect(selected.id).toBe('generic-html');
  });

  test('web_import handler table dispatch can select a new handler without pipeline changes', () => {
    const customHandler: WebImportHandler = {
      id: 'custom-source',
      detect: (context) => context.finalUrl === 'https://custom.example/source',
      derive: async () => ({ files: [] }),
    };
    const selected = selectWebImportHandler({
      sourceUrl: 'https://custom.example/source',
      finalUrl: 'https://custom.example/source',
      sourceProvenanceUrl: 'https://custom.example/source',
      finalProvenanceUrl: 'https://custom.example/source',
      includeMedia: false,
      transcriptMode: 'auto',
      dryRun: true,
      fetchedAt: '2026-07-05T00:00:00.000Z',
      response: {
        url: 'https://custom.example/source',
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        bytes: new TextEncoder().encode('<html></html>'),
      },
      fetch: async () => {
        throw new Error('not used');
      },
      media: fakeMediaRuntime(),
    }, [customHandler, ...WEB_IMPORT_HANDLERS]);

    expect(selected.id).toBe('custom-source');
  });

  test('web_import handler table places notion before generic-html', () => {
    expect(WEB_IMPORT_HANDLERS.map((handler) => handler.id)).toEqual([
      'youtube',
      'direct-file',
      'notion',
      'generic-html',
    ]);
  });

  test('creates visually marked Google Docs edits with approval and a ledger', async () => {
    const { base, workspaceRoot, auditPath, cleanup } = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        roots: [rootPolicy(workspaceRoot, auditPath)],
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        dataDir: join(base, 'data'),
      });

      const result = await postDomain(worker, 'domain_doc', {
        action: 'visual_insert',
        domain_id: 'governance',
        document_id: 'doc-123',
        text: 'Add this governance paragraph.',
        comment: 'Proposed addition for owner review.',
        approval_id: 'approval-123',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'domain_doc_result',
        status: 'visual_edit_created',
        document_id: 'doc-123',
        visual_review_style: {
          prefix_marker: '[Solon]',
        },
      });
      const batchCall = calls.find((call) => call.url.endsWith('/documents/doc-123:batchUpdate'));
      expect(batchCall).toBeDefined();
      const batchBody = JSON.parse(batchCall!.body);
      expect(batchBody.requests[0]).toMatchObject({
        insertText: {
          text: '[Solon] Add this governance paragraph.',
        },
      });
      expect(batchBody.requests[1]).toMatchObject({
        updateTextStyle: {
          fields: 'foregroundColor,backgroundColor',
        },
      });
      expect(calls.some((call) => call.url.includes('/drive/v3/files/doc-123/comments'))).toBe(true);
      expect(readFileSync(join(base, 'data', 'domain-doc-edits.jsonl'), 'utf8')).toContain('approval-123');
    } finally {
      cleanup();
    }
  });

  test('downloads an approved Anna item to the books folder and optionally requests RAG import', async () => {
    const { base, cleanup } = workspaceFixture();
    const booksRoot = join(base, 'Books');
    mkdirSync(booksRoot, { recursive: true });
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        annas: {
          apiKey: 'test-annas-token',
          baseUrl: 'https://annas.test',
          importGcsPrefix: 'gs://fixture-governance-rag/approved',
          booksRoot,
        },
        fetchImpl: fakeGoogleFetch(calls),
      });

      const result = await postDomain(worker, 'annas_archive_import', {
        domain_id: 'governance',
        annas_archive_id: 'book-1',
        title: 'Governance Book',
        author: 'Ada Author',
        year: '2024',
        topic: 'Governance',
        md5: 'abcdef1234567890',
        format: 'pdf',
        corpus_id: 'governance-test-corpus',
        ingest: true,
        copyright_posture: 'operator-approved private research library import',
        approval_id: 'approval-anna-1',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'annas_archive_import_result',
        status: 'downloaded',
        download: {
          status: 'downloaded',
          bytes: 12,
          format: 'pdf',
          relative_path: 'governance/ada-author-governance-book-2024/ada-author-governance-book-2024-abcdef1234567890.pdf',
        },
        rag_ingest: {
          status: 'import_requested',
          target_corpus_id: 'governance-test-corpus',
          rag_import: {
            kind: 'rag_corpus_result',
            status: 'import_requested',
          },
        },
      });
      expect(existsSync(join(booksRoot, 'governance', 'ada-author-governance-book-2024', 'ada-author-governance-book-2024-abcdef1234567890.pdf'))).toBe(true);
      expect(readFileSync(join(booksRoot, '.olympus-annas-audit.jsonl'), 'utf8')).toContain('approval-anna-1');
      expect(calls.some((call) => call.url.startsWith('https://annas.test/download/book-1'))).toBe(true);
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/fixture-governance-rag/o'))).toBe(true);
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('searches Anna through a configured HTTPS origin and ranks top-N candidates with format preference', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      annas: {
        apiKey: 'test-annas-token',
        baseUrl: 'https://annas.test',
      },
      fetchImpl: fakeGoogleFetch(calls, {
        web: {
          'https://annas.test/search?query=evolutionary+biology&topic=evolutionary+biology&max_results=2': webFixture({
            body: JSON.stringify({ results: [
              { id: 'book-pdf', title: 'Evolutionary Biology', author: 'Author A', year: 2020, extension: 'pdf', md5: 'pdfmd5', filesize: '1234' },
              { id: 'book-epub', title: 'Evolutionary Biology Reader', author: 'Author B', year: 2021, extension: 'epub', md5: 'epubmd5', filesize: '2345' },
            ] }),
            headers: { 'content-type': 'application/json' },
          }),
        },
      }),
    });

    const result = await postDomain(worker, 'annas_archive_search', {
      domain_id: 'governance',
      topic: 'evolutionary biology',
      max_results: 2,
      top_n: 1,
      format_preference: 'text_rag',
    });

    expect(result).toMatchObject({
      kind: 'annas_archive_search_result',
      status: 'candidates_ready',
      search: { top_n: 1, format_preference: 'text_rag' },
      candidates: [{
        annas_archive_id: 'book-epub',
        title: 'Evolutionary Biology Reader',
        author: 'Author B',
        year: '2021',
        format: 'epub',
        md5: 'epubmd5',
        file_size_bytes: 2345,
      }],
      approval_gate: { required_before_download: true },
    });
    expect((result as any).candidates[0].rationale).toContain('EPUB preferred for text-first reading/RAG');
    const annaCall = calls.find((call) => call.url === 'https://annas.test/search?query=evolutionary+biology&topic=evolutionary+biology&max_results=2');
    expect(annaCall?.headers.authorization).toBe('Bearer test-annas-token');
    expect(annaCall?.headers['x-api-key']).toBe('test-annas-token');
  });

  test('fails typed when the Anna search backend is not configured', async () => {
    for (const annas of [
      { baseUrl: 'https://annas.test' },
      { apiKey: 'test-annas-token' },
    ]) {
      const worker = createDomainExpertWorker({ annas });
      const response = await postDomainResponse(worker, 'annas_archive_search', {
        domain_id: 'governance',
        topic: 'evolutionary biology',
        top_n: 7,
        format_preference: 'text_rag',
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'annas_archive_not_configured',
        },
      });
    }
  });

  test('keeps Anna import planning behind an explicit dry-run request without a backend', async () => {
    const worker = createDomainExpertWorker();
    const result = await postDomain(worker, 'annas_archive_import', {
      domain_id: 'governance',
      annas_archive_id: 'book-1',
      title: 'Governance Book',
      format: 'pdf',
      copyright_posture: 'operator-approved private research library import',
      dry_run: true,
    });

    expect(result).toMatchObject({
      kind: 'annas_archive_import_plan',
      status: 'dry_run_acquisition_ready',
    });
  });

  test('rejects Anna search redirects outside the configured origin before forwarding credentials', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      annas: {
        apiKey: 'test-annas-token',
        baseUrl: 'https://annas.test',
      },
      fetchImpl: fakeGoogleFetch(calls, {
        web: {
          'https://annas.test/search?query=governance&max_results=10': webFixture({
            status: 302,
            headers: { location: 'https://evil.test/search' },
          }),
        },
      }),
    });

    const response = await postDomainResponse(worker, 'annas_archive_search', {
      domain_id: 'governance',
      query: 'governance',
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'annas_archive_url_not_allowed',
      },
    });
    expect(calls.map((call) => call.url)).toEqual(['https://annas.test/search?query=governance&max_results=10']);
    expect(calls[0]?.headers.authorization).toBe('Bearer test-annas-token');
    expect(calls.some((call) => call.url.startsWith('https://evil.test'))).toBe(false);
  });

  test('allows approved Anna import from a configured same-origin URL', async () => {
    const { base, cleanup } = workspaceFixture();
    const booksRoot = join(base, 'Books');
    mkdirSync(booksRoot, { recursive: true });
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        annas: {
          apiKey: 'test-annas-token',
          baseUrl: 'https://annas.test',
          importGcsPrefix: 'gs://fixture-governance-rag/approved',
          booksRoot,
        },
        fetchImpl: fakeGoogleFetch(calls),
      });

      const result = await postDomain(worker, 'annas_archive_import', {
        domain_id: 'governance',
        url: 'https://annas.test/download/book-1.pdf',
        title: 'Book One',
        author: 'Author One',
        format: 'pdf',
        corpus_id: 'governance-test-corpus',
        ingest: true,
        copyright_posture: 'operator-approved private research library import',
        approval_id: 'approval-anna-1',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'annas_archive_import_result',
        status: 'downloaded',
        download: { status: 'downloaded' },
        rag_ingest: { status: 'import_requested' },
      });
      const annaCall = calls.find((call) => call.url === 'https://annas.test/download/book-1.pdf');
      expect(annaCall?.headers.authorization).toBe('Bearer test-annas-token');
      expect(annaCall?.headers['x-api-key']).toBe('test-annas-token');
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/fixture-governance-rag/o'))).toBe(true);
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('rejects live Anna import when sanitized topic still escapes the books root', async () => {
    const { base, cleanup } = workspaceFixture();
    const booksRoot = join(base, 'Books');
    mkdirSync(booksRoot, { recursive: true });
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        annas: {
          apiKey: 'test-annas-token',
          baseUrl: 'https://annas.test',
          booksRoot,
        },
        fetchImpl: fakeGoogleFetch(calls),
      });

      const response = await postDomainResponse(worker, 'annas_archive_import', {
        domain_id: 'governance',
        annas_archive_id: 'book-path-escape',
        title: 'Escaping Book',
        author: 'Author One',
        topic: '..',
        copyright_posture: 'operator-approved private research library import',
        approval_id: 'approval-path-escape',
        dry_run: false,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'path_escape_denied' },
      });
      expect(calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('replans Anna import path when redirected download URL changes the inferred format', async () => {
    const { base, cleanup } = workspaceFixture();
    const booksRoot = join(base, 'Books');
    mkdirSync(booksRoot, { recursive: true });
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        annas: {
          apiKey: 'test-annas-token',
          baseUrl: 'https://annas.test',
          booksRoot,
        },
        fetchImpl: fakeGoogleFetch(calls, {
          web: {
            'https://annas.test/download/book': webFixture({
              status: 302,
              headers: { location: 'https://annas.test/download/book.epub' },
            }),
            'https://annas.test/download/book.epub': webFixture({
              body: new TextEncoder().encode('epub-bytes'),
              headers: { 'content-type': 'application/epub+zip' },
            }),
          },
        }),
      });

      const result = await postDomain(worker, 'annas_archive_import', {
        domain_id: 'governance',
        url: 'https://annas.test/download/book',
        title: 'Redirected Format',
        author: 'Author One',
        topic: 'Governance',
        copyright_posture: 'operator-approved private research library import',
        approval_id: 'approval-replanned-format',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'annas_archive_import_result',
        status: 'downloaded',
        download: {
          status: 'downloaded',
          format: 'epub',
          relative_path: 'governance/author-one-redirected-format/author-one-redirected-format.epub',
        },
      });
      expect(existsSync(join(booksRoot, 'governance', 'author-one-redirected-format', 'author-one-redirected-format.epub'))).toBe(true);
      expect(existsSync(join(booksRoot, 'governance', 'author-one-redirected-format', 'author-one-redirected-format.pdf'))).toBe(false);
      expect(calls.map((call) => call.url)).toEqual([
        'https://annas.test/download/book',
        'https://annas.test/download/book.epub',
      ]);
    } finally {
      cleanup();
    }
  });

  test('rejects caller-supplied Anna import URLs outside the configured origin before fetch', async () => {
    const { base, cleanup } = workspaceFixture();
    const booksRoot = join(base, 'Books');
    mkdirSync(booksRoot, { recursive: true });
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls),
        },
        annas: {
          apiKey: 'test-annas-token',
          baseUrl: 'https://annas.test',
          importGcsPrefix: 'gs://fixture-governance-rag/approved',
          booksRoot,
        },
        fetchImpl: fakeGoogleFetch(calls),
      });

      const response = await postDomainResponse(worker, 'annas_archive_import', {
        domain_id: 'governance',
        url: 'https://evil.test/file.pdf',
        format: 'pdf',
        corpus_id: 'governance-test-corpus',
        copyright_posture: 'operator-approved private research library import',
        approval_id: 'approval-anna-1',
        dry_run: false,
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'annas_archive_url_not_allowed',
        },
      });
      expect(calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('rejects Anna import redirects outside the configured origin before forwarding credentials', async () => {
    const { base, cleanup } = workspaceFixture();
    const booksRoot = join(base, 'Books');
    mkdirSync(booksRoot, { recursive: true });
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        google: {
          accessToken: 'test-google-token',
          fetchImpl: fakeGoogleFetch(calls, {
            web: {
              'https://annas.test/download/redirect': webFixture({
                status: 302,
                headers: { location: 'https://evil.test/file.pdf' },
              }),
            },
          }),
        },
        annas: {
          apiKey: 'test-annas-token',
          baseUrl: 'https://annas.test',
          importGcsPrefix: 'gs://fixture-governance-rag/approved',
          booksRoot,
        },
        fetchImpl: fakeGoogleFetch(calls, {
          web: {
            'https://annas.test/download/redirect': webFixture({
              status: 302,
              headers: { location: 'https://evil.test/file.pdf' },
            }),
          },
        }),
      });

      const response = await postDomainResponse(worker, 'annas_archive_import', {
        domain_id: 'governance',
        url: 'https://annas.test/download/redirect',
        format: 'pdf',
        corpus_id: 'governance-test-corpus',
        copyright_posture: 'operator-approved private research library import',
        approval_id: 'approval-anna-1',
        dry_run: false,
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'annas_archive_url_not_allowed',
        },
      });
      expect(calls.map((call) => call.url)).toEqual(['https://annas.test/download/redirect']);
      expect(calls[0]?.headers.authorization).toBe('Bearer test-annas-token');
      expect(calls.some((call) => call.url.startsWith('https://evil.test'))).toBe(false);
      expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/'))).toBe(false);
      expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('rejects Anna downloads above the configured download ceiling while streaming and cancels the body', async () => {
    const calls: CapturedCall[] = [];
    const booksRoot = mkdtempSync(join(tmpdir(), 'olympus-annas-books-'));
    let bodyCanceled = false;
    let sent = false;
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls),
      },
      annas: {
        apiKey: 'test-annas-token',
        baseUrl: 'https://annas.test',
        importGcsPrefix: 'gs://fixture-governance-rag/approved',
        booksRoot,
        maxDownloadBytes: 10 * 1024 * 1024,
      },
      fetchImpl: fakeGoogleFetch(calls, {
        web: {
          'https://annas.test/download/huge.pdf': webFixture({
            body: new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent) return;
                sent = true;
                controller.enqueue(new Uint8Array((10 * 1024 * 1024) + 1));
              },
              cancel() {
                bodyCanceled = true;
              },
            }),
            headers: { 'content-type': 'application/pdf' },
          }),
        },
      }),
    });

    const response = await postDomainResponse(worker, 'annas_archive_import', {
      domain_id: 'governance',
      url: 'https://annas.test/download/huge.pdf',
      format: 'pdf',
      corpus_id: 'governance-test-corpus',
      ingest: true,
      copyright_posture: 'operator-approved private research library import',
      approval_id: 'approval-anna-huge',
      dry_run: false,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: 'annas_archive_download_size_limit_exceeded' },
    });
    expect(bodyCanceled).toBe(true);
    expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/'))).toBe(false);
    expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(false);
  });

  test('allows Anna downloads over the stage-import cap but under the Anna download ceiling', async () => {
    const { base, cleanup } = workspaceFixture();
    const booksRoot = join(base, 'Books');
    mkdirSync(booksRoot, { recursive: true });
    const calls: CapturedCall[] = [];
    const bytes = new Uint8Array(30 * 1024 * 1024);
    bytes.fill(7);
    try {
      const worker = createDomainExpertWorker({
        annas: {
          apiKey: 'test-annas-token',
          baseUrl: 'https://annas.test',
          booksRoot,
        },
        fetchImpl: fakeGoogleFetch(calls, {
          web: {
            'https://annas.test/download/thirty-mb.pdf': webFixture({
              body: bytes,
              headers: {
                'content-type': 'application/pdf',
                'content-length': String(bytes.byteLength),
              },
            }),
          },
        }),
      });

      const result = await postDomain(worker, 'annas_archive_import', {
        domain_id: 'governance',
        url: 'https://annas.test/download/thirty-mb.pdf',
        title: 'Thirty Megabyte Scan',
        author: 'Author One',
        topic: 'Governance',
        copyright_posture: 'operator-approved private research library import',
        approval_id: 'approval-thirty-mb',
        dry_run: false,
      });

      const expectedPath = join(booksRoot, 'governance', 'author-one-thirty-megabyte-scan', 'author-one-thirty-megabyte-scan.pdf');
      expect(result).toMatchObject({
        kind: 'annas_archive_import_result',
        status: 'downloaded',
        download: {
          status: 'downloaded',
          bytes: bytes.byteLength,
          format: 'pdf',
          relative_path: 'governance/author-one-thirty-megabyte-scan/author-one-thirty-megabyte-scan.pdf',
        },
      });
      expect(statSync(expectedPath).size).toBe(bytes.byteLength);
    } finally {
      cleanup();
    }
  });

  test('refuses a live Anna import when no books root is configured', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls),
      },
      annas: {
        apiKey: 'test-annas-token',
        baseUrl: 'https://annas.test',
        importGcsPrefix: 'gs://fixture-governance-rag/approved',
      },
      fetchImpl: fakeGoogleFetch(calls),
    });

    const health = await getJson(worker, 'http://worker.test/v1/health') as {
      configured: { annas_books_root: boolean };
    };
    expect(health.configured.annas_books_root).toBe(false);

    const dryRun = await postDomainResponse(worker, 'annas_archive_import', {
      domain_id: 'governance',
      url: 'https://annas.test/download/unconfigured.pdf',
      format: 'pdf',
      corpus_id: 'governance-test-corpus',
      copyright_posture: 'operator-approved private research library import',
    });
    expect(dryRun.status).toBe(200);

    const response = await postDomainResponse(worker, 'annas_archive_import', {
      domain_id: 'governance',
      url: 'https://annas.test/download/unconfigured.pdf',
      format: 'pdf',
      corpus_id: 'governance-test-corpus',
      copyright_posture: 'operator-approved private research library import',
      approval_id: 'approval-anna-unconfigured',
      dry_run: false,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'annas_books_root_not_configured',
        suggestion: 'Set OLYMPUS_DOMAIN_EXPERT_ANNAS_BOOKS_ROOT (or DomainExpertAnnasConfig.booksRoot) to the absolute directory acquisitions should be written to.',
      },
    });
    expect(calls.some((call) => call.url.startsWith('https://annas.test/'))).toBe(false);
  });

  test('times out stalled Anna download bodies without upload or import', async () => {
    const calls: CapturedCall[] = [];
    const booksRoot = mkdtempSync(join(tmpdir(), 'olympus-annas-books-'));
    let bodyCanceled = false;
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls),
      },
      annas: {
        apiKey: 'test-annas-token',
        baseUrl: 'https://annas.test',
        importGcsPrefix: 'gs://fixture-governance-rag/approved',
        booksRoot,
      },
      fetchImpl: fakeGoogleFetch(calls, {
        web: {
          'https://annas.test/download/stall.pdf': webFixture({
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('partial pdf body'));
              },
              cancel() {
                bodyCanceled = true;
              },
            }),
            headers: { 'content-type': 'application/pdf' },
          }),
        },
      }),
      annasDownloadTimeoutMs: 20,
    });

    const response = await postDomainResponse(worker, 'annas_archive_import', {
      domain_id: 'governance',
      url: 'https://annas.test/download/stall.pdf',
      format: 'pdf',
      corpus_id: 'governance-test-corpus',
      copyright_posture: 'operator-approved private research library import',
      approval_id: 'approval-anna-stall',
      dry_run: false,
    });

    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({
      error: { code: 'annas_archive_download_timeout' },
    });
    expect(bodyCanceled).toBe(true);
    expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/'))).toBe(false);
    expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(false);
  });

  test('rejects Anna live import when the configured upload prefix is outside the domain allowlist', async () => {
    const calls: CapturedCall[] = [];
    const booksRoot = mkdtempSync(join(tmpdir(), 'olympus-annas-books-'));
    const worker = createDomainExpertWorker({
      google: {
        accessToken: 'test-google-token',
        fetchImpl: fakeGoogleFetch(calls),
      },
      annas: {
        apiKey: 'test-annas-token',
        baseUrl: 'https://annas.test',
        importGcsPrefix: 'gs://wrong-governance-rag/approved',
        booksRoot,
      },
      fetchImpl: fakeGoogleFetch(calls),
    });

    const response = await postDomainResponse(worker, 'annas_archive_import', {
      domain_id: 'governance',
      annas_archive_id: 'book-1',
      format: 'pdf',
      corpus_id: 'governance-test-corpus',
      ingest: true,
      copyright_posture: 'operator-approved private research library import',
      approval_id: 'approval-anna-1',
      dry_run: false,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'annas_archive_import_result',
      status: 'downloaded_ingest_blocked',
      download: { status: 'downloaded' },
      rag_ingest: {
        status: 'blocked',
        error: { code: 'gcs_destination_not_allowed' },
      },
    });
    expect(calls.some((call) => call.url.startsWith('https://annas.test/download/book-1'))).toBe(true);
    expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/'))).toBe(false);
    expect(calls.some((call) => call.url.includes('/ragFiles:import'))).toBe(false);
  });

  test('skips duplicate Anna downloads by stable locator audit', async () => {
    const { base, cleanup } = workspaceFixture();
    const booksRoot = join(base, 'Books');
    mkdirSync(booksRoot, { recursive: true });
    const calls: CapturedCall[] = [];
    try {
      const worker = createDomainExpertWorker({
        annas: {
          apiKey: 'test-annas-token',
          baseUrl: 'https://annas.test',
          booksRoot,
        },
        fetchImpl: fakeGoogleFetch(calls),
      });
      const params = {
        domain_id: 'governance',
        annas_archive_id: 'book-duplicate',
        title: 'Duplicate Book',
        author: 'Ada Author',
        topic: 'Evolutionary Biology',
        md5: 'duplicate-md5',
        format: 'epub',
        copyright_posture: 'operator-approved private research library import',
        approval_id: 'approval-duplicate',
        dry_run: false,
      };

      const first = await postDomain(worker, 'annas_archive_import', params);
      const second = await postDomain(worker, 'annas_archive_import', params);

      expect(first).toMatchObject({
        kind: 'annas_archive_import_result',
        status: 'downloaded',
        download: { status: 'downloaded' },
        rag_ingest: { status: 'not_requested' },
      });
      expect(second).toMatchObject({
        kind: 'annas_archive_import_result',
        status: 'skipped_duplicate',
        download: {
          status: 'skipped_duplicate',
          reason: 'target_path_exists',
        },
      });
      expect(calls.filter((call) => call.url.startsWith('https://annas.test/download/book-duplicate'))).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test('returns needs_corpus_decision when Anna RAG ingest is requested without an explicit corpus', async () => {
    const { base, cleanup } = workspaceFixture();
    const booksRoot = join(base, 'Books');
    mkdirSync(booksRoot, { recursive: true });
    try {
      const worker = createDomainExpertWorker({
        annas: {
          apiKey: 'test-annas-token',
          baseUrl: 'https://annas.test',
          booksRoot,
        },
        fetchImpl: fakeGoogleFetch([]),
      });

      const result = await postDomain(worker, 'annas_archive_import', {
        domain_id: 'governance',
        annas_archive_id: 'needs-corpus-book',
        title: 'Needs Corpus Book',
        format: 'epub',
        ingest: true,
        copyright_posture: 'operator-approved private research library import',
        approval_id: 'approval-needs-corpus',
        dry_run: false,
      });

      expect(result).toMatchObject({
        kind: 'annas_archive_import_result',
        status: 'downloaded_ingest_blocked',
        download: { status: 'downloaded' },
        rag_ingest: { status: 'needs_corpus_decision' },
      });
    } finally {
      cleanup();
    }
  });

  test('rejects live Anna import without explicit approval', async () => {
    const worker = createDomainExpertWorker({
      annas: {
        apiKey: 'test-annas-token',
        baseUrl: 'https://annas.test',
        importGcsPrefix: 'gs://fixture-governance-rag/approved',
      },
    });

    const response = await postDomainResponse(worker, 'annas_archive_import', {
      domain_id: 'governance',
      annas_archive_id: 'book-1',
      copyright_posture: 'operator-approved private research library import',
      dry_run: false,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'approval_required',
      },
      policy: {
        raw_runtime_secrets_exposed: false,
      },
    });
  });

  test('parses env configuration without exposing secrets in health', async () => {
    const { workspaceRoot, auditPath, cleanup } = workspaceFixture();
    try {
      const roots = domainExpertRootsFromEnv({
        OLYMPUS_DOMAIN_EXPERT_ROOTS_JSON: JSON.stringify({
          castor_workspace: {
            path: workspaceRoot,
            audit_path: auditPath,
            max_write_bytes: 1024,
            allow_overwrite: false,
          },
        }),
      });
      const google = domainExpertGoogleConfigFromEnv({
        OLYMPUS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN: 'secret-google-token',
        OLYMPUS_DOMAIN_EXPERT_GENERATE_MODEL: 'gemini-test',
      });
      expect(google).toMatchObject({
        retrievalTopK: 30,
        answerContextLimit: 12,
        reranker: 'rank-service',
        multiQuery: true,
      });
      expect(domainExpertGoogleConfigFromEnv({
        OLYMPUS_DOMAIN_EXPERT_RETRIEVAL_TOP_K: '40',
        OLYMPUS_DOMAIN_EXPERT_ANSWER_CONTEXT_LIMIT: '8',
        OLYMPUS_DOMAIN_EXPERT_RERANKER: 'llm',
        OLYMPUS_DOMAIN_EXPERT_RERANKER_MODEL: 'gemini-2.5-flash',
        OLYMPUS_DOMAIN_EXPERT_MULTI_QUERY: 'false',
      })).toMatchObject({
        retrievalTopK: 40,
        answerContextLimit: 8,
        reranker: 'llm',
        rerankerModel: 'gemini-2.5-flash',
        multiQuery: false,
      });
      const annas = domainExpertAnnasConfigFromEnv({
        OLYMPUS_DOMAIN_EXPERT_ANNAS_ARCHIVE_API_KEY: 'secret-annas-token',
        OLYMPUS_DOMAIN_EXPERT_ANNAS_ARCHIVE_BASE_URL: 'https://annas.test/',
        OLYMPUS_DOMAIN_EXPERT_ANNAS_MAX_DOWNLOAD_BYTES: '31457280',
      });
      expect(annas.maxDownloadBytes).toBe(31_457_280);
      expect(annas.booksRoot).toBeUndefined();
      expect(domainExpertAnnasConfigFromEnv({
        OLYMPUS_DOMAIN_EXPERT_ANNAS_BOOKS_ROOT: '/srv/olympus/books',
      }).booksRoot).toBe('/srv/olympus/books');
      expect(domainExpertWorkerFlagsFromEnv({
        OLYMPUS_DOMAIN_EXPERT_ENABLED: 'true',
        OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED: 'true',
      })).toEqual({
        enabled: true,
        liveToolsEnabled: true,
      });
      expect(domainExpertWorkerFlagsFromEnv({})).toEqual({
        enabled: false,
        liveToolsEnabled: false,
      });
      const worker = createDomainExpertWorker({ roots, google, annas });
      const health = await getJson(worker, 'http://worker.test/v1/health');

      expect(health).toMatchObject({
        configured: {
          workspace_roots: 1,
          google: true,
          annas_archive: true,
        },
      });
      expect(JSON.stringify(health)).not.toContain('secret-google-token');
      expect(JSON.stringify(health)).not.toContain('secret-annas-token');
    } finally {
      cleanup();
    }
  });
});

describe('Domain Expert retrieval ranking', () => {
  test('merges reciprocal ranks and deduplicates repeated context ids and URI/text pairs', () => {
    const sourceA = { id: 'a', sourceUri: 'gs://books/a.pdf', text: 'A' };
    const sourceB = { id: 'b', sourceUri: 'gs://books/b.pdf', text: 'B' };
    const uriDuplicate = { sourceUri: 'gs://books/c.pdf', text: 'same chunk' };
    const fused = reciprocalRankFuse([
      [sourceA, sourceB, uriDuplicate],
      [sourceB, { id: 'd', sourceUri: 'gs://books/d.pdf', text: 'D' }, sourceA],
      [{ sourceUri: 'gs://books/c.pdf', text: 'same chunk' }],
    ]);

    expect(fused).toHaveLength(4);
    expect(fused[0]).toEqual(sourceB);
    expect(fused.filter((context) => context.sourceUri === 'gs://books/c.pdf')).toHaveLength(1);
  });
});

describe('Domain Expert client and operation routing', () => {
  test('direct HTTP transport preserves bounded allowlisted worker errors', async () => {
    for (const code of ['invalid_params', 'domain_expert_not_configured', 'annas_archive_not_configured']) {
      await expect(requestDomainTransportError(503, JSON.stringify({
        error: {
          code,
          message: `Bounded ${code} message.`,
          suggestion: `Bounded ${code} suggestion.`,
        },
      }))).resolves.toMatchObject({
        code,
        message: `Bounded ${code} message.`,
        suggestion: `Bounded ${code} suggestion.`,
      });
    }
  });

  test.each([
    ['ANSI controls in message', 'message', '\u001b[31mINJECTED\u0007'],
    ['ANSI controls in suggestion', 'suggestion', '\u001b[31mINJECTED\u0007'],
    ['ESC alone', 'message', '\u001b'],
    ['NUL', 'message', 'INJECTED\u0000TEXT'],
    ['C1 NEL', 'suggestion', 'INJECTED\u0085TEXT'],
    ['newline', 'message', 'INJECTED\nTEXT'],
    ['tab', 'suggestion', 'INJECTED\tTEXT'],
  ])('rejects %s in worker error %s', async (_case, field, value) => {
    const error = await requestDomainTransportError(503, JSON.stringify({
      error: {
        code: 'domain_expert_not_configured',
        message: field === 'message' ? value : 'Bounded worker message.',
        suggestion: field === 'suggestion' ? value : 'Bounded worker suggestion.',
      },
    }));
    expect(error).toMatchObject({
      code: 'domain_expert_error',
      message: 'Domain expert worker returned HTTP 503.',
      suggestion: 'Check the Olympus domain expert worker logs.',
    });
  });

  test.each([
    ['unknown JSON code', 503, JSON.stringify({
      error: {
        code: 'malicious_worker_code',
        message: 'PRIVATE UNKNOWN MESSAGE',
        suggestion: 'PRIVATE UNKNOWN SUGGESTION',
      },
    }), 'domain_expert_error'],
    ['huge code', 503, JSON.stringify({
      error: {
        code: `domain_expert_not_configured${'x'.repeat(1_000_000)}`,
        message: 'PRIVATE HUGE CODE MESSAGE',
        suggestion: 'PRIVATE HUGE CODE SUGGESTION',
      },
    }), 'domain_expert_error'],
    ['huge message', 503, JSON.stringify({
      error: {
        code: 'domain_expert_not_configured',
        message: 'M'.repeat(1_000_000),
        suggestion: 'PRIVATE HUGE MESSAGE SUGGESTION',
      },
    }), 'domain_expert_error'],
    ['huge suggestion', 503, JSON.stringify({
      error: {
        code: 'domain_expert_not_configured',
        message: 'PRIVATE HUGE SUGGESTION MESSAGE',
        suggestion: 'S'.repeat(1_000_000),
      },
    }), 'domain_expert_error'],
    ['malformed JSON body', 503, '{"error":{"code":"domain_expert_not_configured"', 'domain_expert_error'],
    ['non-JSON 503 body', 503, '<html>PRIVATE UPSTREAM 503</html>', 'domain_expert_error'],
    ['malicious JSON 403 body', 403, JSON.stringify({
      error: {
        code: 'domain_expert_not_configured',
        message: 'PRIVATE POLICY MESSAGE',
        suggestion: 'PRIVATE POLICY SUGGESTION',
      },
    }), 'domain_expert_policy_violation'],
  ])('sanitizes %s', async (_case, status, body, expectedCode) => {
    const error = await requestDomainTransportError(status, body) as {
      code: string;
      message: string;
      suggestion?: string;
    };
    expect(error).toMatchObject({
      code: expectedCode,
      message: `Domain expert worker returned HTTP ${status}.`,
      suggestion: 'Check the Olympus domain expert worker logs.',
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });

  test('direct HTTP transport preserves typed non-policy worker errors', async () => {
    const worker = createDomainExpertWorkerWithGate({
      enabled: true,
      liveToolsEnabled: true,
    });
    const transport = new DirectHttpDomainExpertTransport((url, init) => worker.fetch(new Request(url, init)));

    await expect(transport.requestJson('http://worker.test/v1/domain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'annas_archive_search',
        params: { query: 'governance' },
      }),
    })).rejects.toMatchObject({
      code: 'annas_archive_not_configured',
    });

    const policyTransport = new DirectHttpDomainExpertTransport(async () => new Response(JSON.stringify({
      error: {
        code: 'approval_required',
        message: 'This worker action requires approval.',
      },
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(policyTransport.requestJson('http://worker.test/v1/domain', {
      method: 'POST',
      body: '{}',
    })).rejects.toMatchObject({
      code: 'domain_expert_policy_violation',
    });
  });

  test('worker HTTP dispatch refuses every domain tool unless both worker flags are enabled', async () => {
    const domainTools = [
      'domain_agent',
      'domain_ask',
      'domain_source',
      'rag_corpus',
      'domain_doc',
      'annas_archive_search',
      'annas_archive_import',
    ];

    for (const flags of [
      { enabled: false, liveToolsEnabled: false },
      { enabled: true, liveToolsEnabled: false },
      { enabled: false, liveToolsEnabled: true },
    ]) {
      const worker = createDomainExpertWorkerWithGate(flags);
      for (const tool of domainTools) {
        const response = await postDomainResponse(worker, tool, {});
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: {
            code: 'domain_expert_not_configured',
          },
        });
      }

      const health = await getJson(worker, 'http://worker.test/v1/health');
      expect(health).toMatchObject({
        kind: 'domain_expert_health',
        reachable: true,
      });
    }
  });

  test('client posts to the worker and enforces the bounded policy contract', async () => {
    const config = defaultConfig();
    config.domainExpert.enabled = true;
    config.domainExpert.baseUrl = 'http://domain-worker.test/v1';
    const calls: Array<{ url: string; body: string }> = [];
    const client = new DomainExpertClient(config, {
      async requestJson(url, init) {
        calls.push({ url, body: String(init.body) });
        return {
          kind: 'ok',
          policy: {
            olympus_control_plane_only: true,
            raw_runtime_secrets_exposed: false,
          },
        };
      },
    });

    await expect(client.run('domain_ask', { question: 'hello' })).resolves.toMatchObject({ kind: 'ok' });
    expect(calls[0]).toEqual({
      url: 'http://domain-worker.test/v1/domain',
      body: JSON.stringify({ tool: 'domain_ask', params: { question: 'hello' } }),
    });

    const badClient = new DomainExpertClient(config, {
      async requestJson() {
        return { kind: 'bad', policy: { raw_runtime_secrets_exposed: true } };
      },
    });
    await expect(badClient.run('domain_ask', { question: 'hello' })).rejects.toThrow('bounded policy contract');
  });

  test('operation handlers delegate to the configured domain expert worker', async () => {
    const config = defaultConfig();
    config.domainExpert.enabled = true;
    config.domainExpert.liveToolsEnabled = true;
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const ctx: OperationContext = {
      config,
      delphi: {} as OperationContext['delphi'],
      email: {} as OperationContext['email'],
      domainExpert: {
        async run(tool: string, params: Record<string, unknown>) {
          calls.push({ tool, params });
          return {
            kind: 'delegated',
            policy: {
              olympus_control_plane_only: true,
              raw_runtime_secrets_exposed: false,
            },
          };
        },
      } as unknown as NonNullable<OperationContext['domainExpert']>,
    };
    const domainAsk = operations.find((operation) => operation.name === 'domain_ask')!;

    await expect(domainAsk.handler(ctx, {
      domain_id: 'governance',
      question: 'What should we read?',
      max_results: 3,
    })).resolves.toMatchObject({ kind: 'delegated' });

    expect(calls).toEqual([{
      tool: 'domain_ask',
      params: {
        domain_id: 'governance',
        question: 'What should we read?',
        max_results: 3,
      },
    }]);
  });

  test('audit: no domain expert tool silently degrades to its static planner', async () => {
    const config = defaultConfig();
    config.domainExpert.enabled = true;
    config.domainExpert.liveToolsEnabled = false;
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const ctx: OperationContext = {
      config,
      delphi: {} as OperationContext['delphi'],
      email: {} as OperationContext['email'],
      domainExpert: {
        async run(tool: string, params: Record<string, unknown>) {
          calls.push({ tool, params });
          return { kind: 'unexpected_delegation' };
        },
      } as unknown as NonNullable<OperationContext['domainExpert']>,
    };
    const domainTools = [
      'domain_agent',
      'domain_ask',
      'domain_source',
      'rag_corpus',
      'domain_doc',
      'annas_archive_search',
      'annas_archive_import',
    ];

    for (const toolName of domainTools) {
      const operation = operations.find((candidate) => candidate.name === toolName)!;
      await expect(operation.handler(ctx, {})).rejects.toMatchObject({
        code: 'domain_expert_not_configured',
      });
    }

    config.domainExpert.enabled = false;
    config.domainExpert.liveToolsEnabled = true;
    const domainAsk = operations.find((operation) => operation.name === 'domain_ask')!;
    await expect(domainAsk.handler(ctx, {
      domain_id: 'governance',
      question: 'What should we read?',
    })).rejects.toMatchObject({
      code: 'domain_expert_not_configured',
    });

    expect(calls).toEqual([]);
  });
});

// Generated here and thrown away with the process; no real service-account
// material may appear in a fixture.
const THROWAWAY_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'olympus-fixture-project',
  private_key_id: 'fixture-key-id',
  private_key: THROWAWAY_KEY.privateKey,
  client_email: 'olympus-secure@olympus-fixture-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const WORKER_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/devstorage.read_write',
].join(' ');

describe('Domain Expert worker service-account token lane', () => {
  test('mints its own token from an assertion that carries no impersonated subject', async () => {
    const calls: CapturedCall[] = [];
    const tokenCalls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        serviceAccountJson: SERVICE_ACCOUNT_JSON,
        fetchImpl: fakeGoogleFetchWithTokenExchange(calls, tokenCalls),
      },
    });

    const result = await postDomain(worker, 'rag_corpus', {
      action: 'import',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      gcs_uri: 'gs://fixture-governance-rag/batch-1/book.pdf',
      dry_run: false,
    });

    expect(result).toMatchObject({ kind: 'rag_corpus_result', status: 'import_requested' });
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(tokenCalls[0]!.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');

    const minted = decodeAssertion(tokenCalls[0]!.body);
    expect(minted.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(minted.signatureValid).toBe(true);
    // This lane acts as the service account itself. A `sub` here would turn it
    // into a domain-wide-delegation token for someone else's mailbox.
    expect(minted.claims.sub).toBeUndefined();
    expect(minted.claims.iss).toBe('olympus-secure@olympus-fixture-project.iam.gserviceaccount.com');
    expect(minted.claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(minted.claims.scope).toBe(WORKER_DEFAULT_SCOPES);
    expect(minted.claims.exp).toBe((minted.claims.iat as number) + 3600);

    const importCall = calls.find((call) => call.url.includes('/ragFiles:import'));
    expect(importCall?.headers.authorization).toBe('Bearer minted-service-account-token');
  });

  test('honours configured scopes instead of the worker defaults', async () => {
    const calls: CapturedCall[] = [];
    const tokenCalls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        serviceAccountJson: SERVICE_ACCOUNT_JSON,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        fetchImpl: fakeGoogleFetchWithTokenExchange(calls, tokenCalls),
      },
    });

    await postDomain(worker, 'rag_corpus', {
      action: 'import',
      domain_id: 'governance',
      corpus_id: 'governance-test-corpus',
      gcs_uri: 'gs://fixture-governance-rag/batch-1/book.pdf',
      dry_run: false,
    });

    expect(decodeAssertion(tokenCalls[0]!.body).claims.scope).toBe('https://www.googleapis.com/auth/cloud-platform');
  });

  test('reuses the cached token instead of re-signing per request', async () => {
    const calls: CapturedCall[] = [];
    const tokenCalls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      google: {
        serviceAccountJson: SERVICE_ACCOUNT_JSON,
        fetchImpl: fakeGoogleFetchWithTokenExchange(calls, tokenCalls),
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await postDomain(worker, 'rag_corpus', {
        action: 'import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        gcs_uri: 'gs://fixture-governance-rag/batch-1/book.pdf',
        dry_run: false,
      });
    }

    expect(calls.filter((call) => call.url.includes('/ragFiles:import'))).toHaveLength(2);
    expect(tokenCalls).toHaveLength(1);
  });

  test('answers 503 google_auth_not_configured for missing and unusable credentials', async () => {
    const cases: Array<DomainExpertWorkerOptions['google']> = [
      {},
      { serviceAccountJson: 'not-json-at-all' },
      { serviceAccountJson: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com' }) },
    ];

    for (const google of cases) {
      const calls: CapturedCall[] = [];
      const tokenCalls: CapturedCall[] = [];
      const worker = createDomainExpertWorker({
        google: { ...google, fetchImpl: fakeGoogleFetchWithTokenExchange(calls, tokenCalls) },
      });

      const response = await postDomainResponse(worker, 'rag_corpus', {
        action: 'import',
        domain_id: 'governance',
        corpus_id: 'governance-test-corpus',
        gcs_uri: 'gs://fixture-governance-rag/batch-1/book.pdf',
        dry_run: false,
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'google_auth_not_configured' } });
      expect(tokenCalls).toHaveLength(0);
    }
  });
});

interface CapturedCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

interface WebFixture {
  status?: number;
  headers?: Record<string, string>;
  body?: BodyInit;
}

type TestWebImportFetch = NonNullable<DomainExpertWorkerOptions['webImportFetchImpl']>;

function workspaceFixture(): {
  base: string;
  workspaceRoot: string;
  auditPath: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), 'olympus-domain-expert-'));
  const workspaceRoot = join(base, 'workspace');
  mkdirSync(workspaceRoot);
  return {
    base,
    workspaceRoot,
    auditPath: join(base, 'audit.jsonl'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function rootPolicy(path: string, auditPath: string) {
  return {
    rootId: 'castor_workspace',
    path,
    maxWriteBytes: 10_485_760,
    auditPath,
    allowOverwrite: false,
  };
}

async function getJson(worker: { fetch(request: Request): Promise<Response> }, url: string): Promise<Record<string, unknown>> {
  const response = await worker.fetch(new Request(url));
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function postDomain(
  worker: { fetch(request: Request): Promise<Response> },
  tool: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postDomainResponse(worker, tool, params);
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

function postDomainResponse(
  worker: { fetch(request: Request): Promise<Response> },
  tool: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST',
    body: JSON.stringify({ tool, params }),
  }));
}

function fakeGoogleFetch(
  calls: CapturedCall[],
  options: {
    ragCorpora?: Array<{ name: string; displayName: string }>;
    ragFiles?: Record<string, Array<Record<string, unknown>>>;
    notFoundCorpusIds?: string[];
    queryReformulations?: string[];
    retrieveContexts?: (corpusId: string | undefined, query: string) => Array<Record<string, unknown>>;
    web?: Record<string, WebFixture>;
  } = {},
): typeof fetch {
  const ragCorpora = options.ragCorpora ?? [
    {
      name: 'projects/123456789012/locations/us-central1/ragCorpora/2222222222222222222',
      displayName: 'governance-test-corpus',
    },
    {
      name: 'projects/123456789012/locations/us-central1/ragCorpora/7777777777777777777',
      displayName: 'governance-jamie-docs',
    },
  ];
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body = init?.body ? await new Response(init.body as BodyInit).text() : '';
    const headers = headersRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push({ url, method, body, headers });

    const web = options.web?.[url];
    if (web) {
      return new Response(web.body ?? '', {
        status: web.status ?? 200,
        ...(web.headers ? { headers: web.headers } : {}),
      });
    }
    if (url.startsWith('https://annas.test/download/')) {
      return new Response(new TextEncoder().encode('pdf-bytes-12'));
    }
    if (url.startsWith('https://storage.googleapis.com/upload/storage/v1/b/')) {
      return jsonResponse({ name: 'fixture-governance-rag/approved/object.pdf' });
    }
    if (url.endsWith(':retrieveContexts')) {
      const parsedBody = JSON.parse(body);
      const corpus = parsedBody.vertexRagStore.ragResources[0].ragCorpus as string;
      const corpusId = corpus.split('/').at(-1);
      if (corpusId && options.notFoundCorpusIds?.includes(corpusId)) {
        return jsonResponse({
          error: {
            code: 404,
            message: `RAG corpus ${corpusId} was not found.`,
            status: 'NOT_FOUND',
          },
        }, 404);
      }
      const contexts = options.retrieveContexts?.(corpusId, parsedBody.query.text) ?? [{
        text: `${corpusId} context`,
        ragFile: {
          displayName: `${corpusId} source`,
          gcsSource: {
            uris: [`gs://fixture-governance-rag/${corpusId}.pdf`],
          },
        },
        score: 0.87,
      }];
      return jsonResponse({
        contexts: {
          contexts,
        },
      });
    }
    if (url.includes(':generateContent')) {
      if (body.includes('fileData')) {
        return jsonResponse({
          candidates: [{
            content: {
              parts: [{ text: 'Gemini media transcript text.' }],
            },
          }],
        });
      }
      if (body.includes('Generate exactly two concise retrieval-query reformulations')) {
        return jsonResponse({
          candidates: [{
            content: {
              parts: [{ text: JSON.stringify(options.queryReformulations ?? ['']) }],
            },
          }],
        });
      }
      return jsonResponse({
        candidates: [{
          content: {
            parts: [{ text: 'Use the library context [governance-test-corpus:1].' }],
          },
        }],
      });
    }
    if (url.includes('/ragFiles:import')) {
      const corpusId = url.split('/ragCorpora/').at(-1)?.split('/')[0];
      if (corpusId && options.notFoundCorpusIds?.includes(corpusId)) {
        return jsonResponse({
          error: {
            code: 404,
            message: `RAG corpus ${corpusId} was not found.`,
            status: 'NOT_FOUND',
          },
        }, 404);
      }
      return jsonResponse({ name: 'operations/rag-import-1' });
    }
    if (url.includes('/ragFiles') && method === 'GET') {
      const parsed = new URL(url);
      const corpusId = parsed.pathname.split('/ragCorpora/').at(-1)?.split('/')[0];
      if (corpusId && options.notFoundCorpusIds?.includes(corpusId)) {
        return jsonResponse({
          error: {
            code: 404,
            message: `RAG corpus ${corpusId} was not found.`,
            status: 'NOT_FOUND',
          },
        }, 404);
      }
      const pageToken = parsed.searchParams.get('pageToken') ?? '';
      return jsonResponse({
        ragFiles: options.ragFiles?.[pageToken] ?? [{
          name: `projects/123456789012/locations/us-central1/ragCorpora/${corpusId}/ragFiles/file-1`,
          displayName: 'source-one.md',
          createTime: '2026-07-05T10:00:00Z',
          sourceUri: 'gs://fixture-governance-rag/staged/source-one.md',
          state: 'ACTIVE',
          ignoredField: 'not returned by worker',
        }],
        ...(pageToken === '' && options.ragFiles?.page2 ? { nextPageToken: 'page2' } : {}),
      });
    }
    if (url.includes('/ragFiles/') && method === 'DELETE') {
      const corpusId = url.split('/ragCorpora/').at(-1)?.split('/')[0];
      if (corpusId && options.notFoundCorpusIds?.includes(corpusId)) {
        return jsonResponse({
          error: {
            code: 404,
            message: `RAG corpus ${corpusId} was not found.`,
            status: 'NOT_FOUND',
          },
        }, 404);
      }
      return jsonResponse({ name: 'operations/rag-delete-file-1' });
    }
    if (isRagCorpusListUrl(url) && method === 'GET') {
      return jsonResponse({ ragCorpora });
    }
    if (url.includes('/ragCorpora/') && method === 'GET') {
      const corpusId = url.split('/ragCorpora/').at(-1);
      if (corpusId && options.notFoundCorpusIds?.includes(corpusId)) {
        return jsonResponse({
          error: {
            code: 404,
            message: `RAG corpus ${corpusId} was not found.`,
            status: 'NOT_FOUND',
          },
        }, 404);
      }
      return jsonResponse({
        name: `projects/123456789012/locations/us-central1/ragCorpora/${corpusId}`,
        displayName: ragCorpora.find((corpus) => corpus.name.endsWith(`/ragCorpora/${corpusId}`))?.displayName,
      });
    }
    if (url.includes('/ragCorpora') && method === 'POST') {
      const displayName = JSON.parse(body).displayName;
      return jsonResponse({
        name: 'operations/rag-create-1',
        response: {
          name: 'projects/123456789012/locations/us-central1/ragCorpora/3333333333333333333',
          displayName,
        },
      });
    }
    if (url.startsWith('https://docs.googleapis.com/v1/documents/doc-123?')) {
      return jsonResponse({
        documentId: 'doc-123',
        title: 'Governance Draft',
        revisionId: 'rev-1',
        body: {
          content: [{
            startIndex: 1,
            endIndex: 14,
            paragraph: {
              elements: [{
                startIndex: 1,
                endIndex: 14,
                textRun: { content: 'Hello world.\n' },
              }],
            },
          }],
        },
      });
    }
    if (url.endsWith('/documents/doc-123:batchUpdate')) {
      return jsonResponse({ replies: [{}] });
    }
    if (url.includes('/drive/v3/files/doc-123/comments')) {
      return jsonResponse({ id: 'comment-1', content: 'Proposed addition for owner review.' });
    }
    return jsonResponse({ error: `unexpected URL: ${url}` }, 500);
  }) as typeof fetch;
}

function fakeNotionFetch(
  calls: CapturedCall[],
  options: {
    missingPageIds?: string[];
    rateLimitFirstPageFetch?: boolean;
    databaseRowBatches?: string[][];
  } = {},
): typeof fetch {
  let rateLimited = false;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body = init?.body ? await new Response(init.body as BodyInit).text() : '';
    const headers = headersRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push({ url, method, body, headers });
    const parsed = new URL(url);
    const path = parsed.pathname;

    if (path === '/v1/users/me') return jsonResponse({ object: 'user', id: 'bot-user' });

    const pageId = path.match(/^\/v1\/pages\/([0-9a-f]+)$/)?.[1];
    if (pageId) {
      if (options.missingPageIds?.includes(pageId)) {
        return jsonResponse({ object: 'error', code: 'object_not_found' }, 404);
      }
      if (options.rateLimitFirstPageFetch && !rateLimited) {
        rateLimited = true;
        return jsonResponse({ object: 'error', code: 'rate_limited' }, 429, { 'Retry-After': '0' });
      }
      return jsonResponse({
        object: 'page',
        id: pageId,
        parent: { type: 'database_id', database_id: '33333333-3333-3333-3333-333333333333' },
        properties: {
          Name: {
            type: 'title',
            title: [{ plain_text: notionFixturePageTitle(pageId) }],
          },
        },
      });
    }

    const blockId = path.match(/^\/v1\/blocks\/([0-9a-f]+)\/children$/)?.[1];
    if (blockId) {
      return jsonResponse({
        object: 'list',
        results: blockId.startsWith('1111') || blockId.startsWith('4444') || blockId.startsWith('5555')
          ? [
              {
                object: 'block',
                id: 'block-1',
                type: 'paragraph',
                paragraph: { rich_text: [{ plain_text: blockId.startsWith('1111') ? 'This is imported from Notion.' : `Database row ${notionFixturePageTitle(blockId)}.` }] },
              },
              {
                object: 'block',
                id: 'block-2',
                type: 'unsupported_block',
                unsupported_block: { rich_text: [{ plain_text: 'Unsupported text still appears.' }] },
              },
            ]
          : [],
        has_more: false,
        next_cursor: null,
      });
    }

    const databaseId = path.match(/^\/v1\/databases\/([0-9a-f]+)$/)?.[1];
    if (databaseId && method === 'GET') {
      return jsonResponse({
        object: 'database',
        id: databaseId,
        title: [{ plain_text: 'Research Database' }],
      });
    }
    const queryDatabaseId = path.match(/^\/v1\/databases\/([0-9a-f]+)\/query$/)?.[1];
    if (queryDatabaseId && method === 'POST') {
      const requestBody = body ? JSON.parse(body) as { start_cursor?: string } : {};
      const batches = options.databaseRowBatches ?? [[
        '44444444444444444444444444444444',
        '55555555555555555555555555555555',
      ]];
      const batchIndex = requestBody.start_cursor === 'page2' ? 1 : 0;
      const ids = batches[batchIndex] ?? [];
      return jsonResponse({
        object: 'list',
        results: ids.map((id) => ({
          object: 'page',
          id,
          properties: {
            Name: {
              type: 'title',
              title: [{ plain_text: notionFixturePageTitle(id) }],
            },
          },
        })),
        has_more: batchIndex < batches.length - 1,
        next_cursor: batchIndex < batches.length - 1 ? 'page2' : null,
      });
    }

    return jsonResponse({ error: `unexpected Notion URL: ${url}` }, 500);
  }) as typeof fetch;
}

function notionFixturePageTitle(pageId: string): string {
  if (pageId.startsWith('2222')) return 'Second Page';
  if (pageId.startsWith('4444')) return 'Database Row One';
  if (pageId.startsWith('5555')) return 'Database Row Two';
  if (pageId.startsWith('6666')) return 'Database Row Three';
  return 'Solon API Page';
}

function fakeWebImportFetch(calls: CapturedCall[], web: Record<string, WebFixture>): TestWebImportFetch {
  return async (url, _options) => {
    const urlString = url.toString();
    calls.push({ url: urlString, method: 'GET', body: '', headers: {} });
    const fixture = web[urlString];
    if (!fixture) {
      return jsonResponse({ error: `unexpected URL: ${urlString}` }, 500);
    }
    return new Response(fixture.body ?? '', {
      status: fixture.status ?? 200,
      ...(fixture.headers ? { headers: fixture.headers } : {}),
    });
  };
}

function isRagCorpusListCall(call: CapturedCall): boolean {
  return call.method === 'GET' && isRagCorpusListUrl(call.url);
}

function isRagCorpusListUrl(url: string): boolean {
  return new URL(url).pathname.endsWith('/ragCorpora');
}

/** fakeGoogleFetch, plus the OAuth token endpoint the JWT-bearer lane posts to. */
function fakeGoogleFetchWithTokenExchange(calls: CapturedCall[], tokenCalls: CapturedCall[]): typeof fetch {
  const inner = fakeGoogleFetch(calls);
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== 'https://oauth2.googleapis.com/token') return inner(input as string, init);
    tokenCalls.push({
      url,
      method: init?.method ?? 'POST',
      body: init?.body ? await new Response(init.body as BodyInit).text() : '',
      headers: headersRecord(init?.headers),
    });
    return jsonResponse({ access_token: 'minted-service-account-token', expires_in: 3600 });
  }) as typeof fetch;
}

function decodeAssertion(tokenRequestBody: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signatureValid: boolean;
} {
  const assertion = new URLSearchParams(tokenRequestBody).get('assertion') ?? '';
  const [header, claims, signature] = assertion.split('.');
  return {
    header: JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(claims ?? '', 'base64url').toString('utf8')),
    signatureValid: createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(THROWAWAY_KEY.publicKey, Buffer.from(signature ?? '', 'base64url')),
  };
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) record[key.toLowerCase()] = value;
    return record;
  }
  for (const [key, value] of Object.entries(headers)) record[key.toLowerCase()] = String(value);
  return record;
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function requestDomainTransportError(status: number, body: string): Promise<unknown> {
  const transport = new DirectHttpDomainExpertTransport(async () => new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
  try {
    await transport.requestJson('http://worker.test/v1/domain', {
      method: 'POST',
      body: '{}',
    });
    throw new Error('Expected worker request to fail.');
  } catch (error) {
    return error;
  }
}

function webFixture(input: WebFixture): WebFixture {
  return input;
}

function fakeYtDlpExec(
  calls: Array<{ command: string; args: string[]; cwd?: string }>,
  fixtures: Record<string, {
    metadata?: Record<string, unknown>;
    download?: { fileName: string; bytes?: Uint8Array; size?: number };
    error?: Error & { stderr?: string };
  }>,
): MediaExec {
  return async (command, args, options = {}) => {
    calls.push({ command, args, ...(options.cwd ? { cwd: options.cwd } : {}) });
    const url = args.at(-1) ?? '';
    const fixture = fixtures[url] ?? {};
    if (fixture.error) throw fixture.error;
    if (args.includes('--dump-json')) {
      return { stdout: JSON.stringify(fixture.metadata ?? { title: 'Untitled', subtitles: {}, automatic_captions: {} }), stderr: '' };
    }
    if (!options.cwd) throw new Error('yt-dlp download expected cwd');
    const download = fixture.download ?? { fileName: 'audio.m4a', bytes: new TextEncoder().encode('audio') };
    const target = join(options.cwd, download.fileName);
    if (download.size !== undefined) {
      writeFileSync(target, '');
      truncateSync(target, download.size);
    } else {
      writeFileSync(target, download.bytes ?? new TextEncoder().encode('audio'));
    }
    return { stdout: '', stderr: '' };
  };
}

function fakeMediaRuntime(): any {
  return {
    domainId: 'governance',
    project: 'olympus-fixture-project',
    location: 'us-central1',
    batchId: 'test-batch',
    destination: {
      bucket: 'fixture-governance-rag',
      objectPrefix: 'staged/governance/test-batch/',
      directoryUri: 'gs://fixture-governance-rag/staged/governance/test-batch/',
    },
    dataDir: tmpdir(),
    ytDlpBin: 'yt-dlp',
    exec: async () => ({ stdout: '{}', stderr: '' }),
    upload: async () => ({}),
    transcribe: async () => 'transcript',
  };
}

function fakeResolveHost(records: Record<string, string[]> = {}): (hostname: string) => Promise<string[]> {
  return async (hostname: string) => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return [hostname];
    return records[hostname] ?? ['93.184.216.34'];
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function richHtml(title: string): string {
  const paragraphs = Array.from({ length: 18 }, (_, index) => `${title} paragraph ${index} contains enough importable readable text.`);
  return `<html><title>${title}</title><main>${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('')}</main></html>`;
}

describe('pinnedWebImportLookup', () => {
  const collect = (
    lookup: ReturnType<typeof pinnedWebImportLookup>,
    lookupOptions: unknown,
  ): Promise<{ err: Error | null; address?: unknown; family?: number }> =>
    new Promise((resolvePromise) => {
      lookup('example.test', lookupOptions, (err, address, family) => {
        resolvePromise({ err, ...(address !== undefined ? { address } : {}), ...(family !== undefined ? { family } : {}) });
      });
    });

  test('returns the full address array when the socket layer asks with all:true', async () => {
    const lookup = pinnedWebImportLookup(['2606:4700::1', '188.114.97.3']);
    const result = await collect(lookup, { all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual([
      { address: '2606:4700::1', family: 6 },
      { address: '188.114.97.3', family: 4 },
    ]);
  });

  test('returns a single pinned address without all', async () => {
    const lookup = pinnedWebImportLookup(['188.114.97.3', '2606:4700::1']);
    const result = await collect(lookup, undefined);
    expect(result.err).toBeNull();
    expect(result.address).toBe('188.114.97.3');
    expect(result.family).toBe(4);
  });

  test('filters private and malformed addresses and errors when none remain', async () => {
    const lookup = pinnedWebImportLookup(['127.0.0.1', '10.0.0.8', 'not-an-ip']);
    const result = await collect(lookup, { all: true });
    expect(result.err).toBeInstanceOf(Error);
    expect(String(result.err?.message)).toContain('no validated public addresses');
  });

  test('serves public addresses while dropping a private one defensively', async () => {
    const lookup = pinnedWebImportLookup(['192.168.1.10', '188.114.97.3']);
    const result = await collect(lookup, { all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual([{ address: '188.114.97.3', family: 4 }]);
  });
});
