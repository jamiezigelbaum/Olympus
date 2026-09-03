import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import {
  ANNAS_ARCHIVE_FORMATS,
  DOMAIN_DOC_ACTIONS,
  DOMAIN_GCP_PROJECT_ENV,
  DOMAIN_SOURCE_ACTIONS,
  gcpProjectIdProblem,
  DOMAIN_SOURCE_KINDS,
  RAG_CORPUS_ACTIONS,
  optionalWebImportTranscriptMode,
  domainManifest,
  domainPolicy,
  parseDomainAgentAction,
  parseDomainDocAction,
  parseDomainSourceAction,
  parseRagCorpusAction,
  planAnnasArchiveImport,
  planDomainAgent,
  planDomainAsk,
  planDomainDoc,
  planDomainSource,
  planRagCorpus,
} from '../../core/domain-expert.ts';
import type {
  AnnasArchiveImportParams,
  AnnasArchiveSearchParams,
  DomainAgentParams,
  DomainDocParams,
  DomainSourceParams,
  RagCorpusParams,
} from '../../core/domain-expert.ts';
import {
  GOOGLE_JWT_BEARER_GRANT_TYPE,
  googleServiceAccountTokenUrl,
  parseGoogleServiceAccountKey,
  signGoogleServiceAccountJwt,
} from '../../core/google-service-account.ts';
import type { GoogleServiceAccountKey } from '../../core/google-service-account.ts';
import { OperationError } from '../../core/operation-error.ts';

export interface DomainExpertWorkspaceRootPolicy {
  rootId: string;
  path: string;
  maxWriteBytes: number;
  auditPath?: string;
  allowOverwrite: boolean;
}

export interface DomainExpertGoogleConfig {
  accessToken?: string;
  serviceAccountJson?: string;
  serviceAccountJsonPath?: string;
  scopes?: string[];
  model?: string;
  transcribeModel?: string;
  retrievalTopK?: number;
  answerContextLimit?: number;
  reranker?: DomainExpertReranker;
  rerankerModel?: string;
  multiQuery?: boolean;
  fetchImpl?: typeof fetch;
}

export type DomainExpertReranker = 'rank-service' | 'llm' | 'off';

export interface DomainExpertAnnasConfig {
  apiKey?: string;
  baseUrl?: string;
  searchUrlTemplate?: string;
  downloadUrlTemplate?: string;
  importGcsPrefix?: string;
  booksRoot?: string;
  maxDownloadBytes?: number;
}

export interface DomainExpertNotionConfig {
  token?: string;
  notionVersion?: string;
  maxObjects?: number;
  fetchImpl?: typeof fetch;
}

export interface DomainExpertWorkerOptions {
  enabled?: boolean;
  liveToolsEnabled?: boolean;
  roots?: DomainExpertWorkspaceRootPolicy[];
  google?: DomainExpertGoogleConfig;
  annas?: DomainExpertAnnasConfig;
  notion?: DomainExpertNotionConfig;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  webImportFetchImpl?: WebImportFetchImpl;
  webImportFetchTimeoutMs?: number;
  annasDownloadTimeoutMs?: number;
  resolveHostImpl?: ResolveHostImpl;
  ytDlpBin?: string;
  mediaExec?: MediaExec;
  basePath?: string;
}

type ResolveHostImpl = (hostname: string) => Promise<string[]>;
type WebImportFetchImpl = (url: URL, options: {
  signal: AbortSignal;
  validatedAddresses: readonly string[];
}) => Promise<Response>;
export type MediaExec = (command: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

type DomainExpertTool =
  | 'domain_agent'
  | 'domain_ask'
  | 'domain_source'
  | 'rag_corpus'
  | 'domain_doc'
  | 'annas_archive_search'
  | 'annas_archive_import';

interface DomainExpertRequest {
  tool: DomainExpertTool;
  params: Record<string, unknown>;
}

interface VisualEditLedgerRecord {
  kind: 'domain_doc_visual_edit';
  edit_batch_id: string;
  domain_id: string;
  document_id: string;
  action: 'visual_insert' | 'visual_replace';
  inserted_text: string;
  inserted_start_index: number;
  inserted_end_index: number;
  prior_text?: string;
  created_at: string;
  approval_id?: string;
}

interface RagCorpusMappingRecord {
  display_name: string;
  corpus_id: string;
  resource_name: string;
  project: string;
  location: string;
  updated_at: string;
}

interface RagCorpusMappingFile {
  version: 1;
  corpora: Record<string, RagCorpusMappingRecord>;
}

interface DomainSourceRegistryRecord {
  record: Record<string, unknown>;
  sourceId: string;
  registeredAt?: string;
  fileOrder: number;
  removed: boolean;
}

interface DomainSourceRegistryRead {
  records: DomainSourceRegistryRecord[];
  totalRecords: number;
  malformedLines: number;
  missing: boolean;
}

interface ResolvedRagCorpus {
  requested: string;
  corpusId: string;
  resourceName: string;
  displayName?: string;
  warnings?: RagCorpusWarning[];
}

interface ParsedRagCorpusResourceName {
  project: string;
  location: string;
  corpusId: string;
}

interface ParsedRagFileResourceName extends ParsedRagCorpusResourceName {
  fileId: string;
}

interface RagCorpusNotFoundWarning {
  corpus_id: string;
  code: 'rag_corpus_not_found';
  message: string;
  suggestion: string;
}

interface RagCorpusDuplicateDisplayNameWarning {
  corpus_id: string;
  code: 'rag_corpus_duplicate_display_name';
  message: string;
  display_name: string;
  selected_resource_name: string;
  duplicate_resource_names: string[];
  selection_order: string;
}

interface RagCorpusMappingFileWarning {
  code: 'rag_corpus_mapping_file_unreadable';
  message: string;
  mapping_file: string;
}

type RagCorpusWarning = RagCorpusNotFoundWarning | RagCorpusDuplicateDisplayNameWarning | RagCorpusMappingFileWarning;

interface StageImportEligibleFile {
  workspaceRelativePath: string;
  uploadRelativePath: string;
  absolutePath: string;
  bytes: number;
  objectName: string;
  gcsUri: string;
}

interface StageImportSkippedFile {
  workspace_relative_path: string;
  reason: string;
  bytes?: number;
}

interface WebImportFetchResult {
  url: string;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

interface WebImportHandlerContext {
  sourceUrl: string;
  finalUrl: string;
  sourceProvenanceUrl: string;
  finalProvenanceUrl: string;
  response: WebImportFetchResult;
  includeMedia: boolean;
  transcriptMode: 'auto' | 'captions' | 'asr';
  dryRun: boolean;
  fetchedAt: string;
  fetch: (url: string) => Promise<WebImportFetchResult>;
  media: MediaRuntimeContext;
}

interface WebImportDerivedFile {
  sourceUrl: string;
  finalUrl: string;
  kind: string;
  fileName: string;
  bytes: Uint8Array;
  warnings?: string[];
}

interface WebImportUrlError {
  source_url: string;
  final_url?: string;
  handler?: string;
  code: string;
  message: string;
  suggestion?: string;
  stderr_tail?: string;
}

interface WebImportHandlerResult {
  files: WebImportDerivedFile[];
  errors?: WebImportUrlError[];
  plan?: Record<string, unknown>;
}

export interface WebImportHandler {
  id: string;
  detect(context: WebImportHandlerContext): boolean;
  derive(context: WebImportHandlerContext): Promise<WebImportHandlerResult>;
}

interface MediaRuntimeContext {
  domainId: string;
  project: string;
  location: string;
  batchId: string;
  destination: ReturnType<typeof stageDestination>;
  dataDir: string;
  ytDlpBin: string;
  exec: MediaExec;
  upload(bucket: string, objectName: string, bytes: Uint8Array): Promise<unknown>;
  transcribe(input: { gcsUri: string; mimeType: string }): Promise<string>;
}

interface NotionImportObjectPlan {
  object_id: string;
  object_type: 'page' | 'database';
  title: string;
  source_url?: string;
  child_block_count?: number;
  row_page_count?: number;
  workspace_relative_path?: string;
  warnings?: string[];
}

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/devstorage.read_write',
];

const STAGE_IMPORT_ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.html']);
const STAGE_IMPORT_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4', '.mov', '.webm']);
const STAGE_IMPORT_TRANSCRIBABLE_MEDIA_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4', '.mov', '.webm']);
const STAGE_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const STAGE_IMPORT_MAX_BATCH_BYTES = 100 * 1024 * 1024;
const MEDIA_TRANSCRIBE_MAX_BYTES = 200 * 1024 * 1024;
const WEB_IMPORT_MAX_FETCH_BYTES = 25 * 1024 * 1024;
const WEB_IMPORT_MAX_BATCH_BYTES = 100 * 1024 * 1024;
const WEB_IMPORT_MAX_FETCHES = 250;
const WEB_IMPORT_MAX_REDIRECTS = 10;
const WEB_IMPORT_FETCH_TIMEOUT_MS = 15_000;
const ANNAS_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 15_000;
const ANNAS_ARCHIVE_MAX_REDIRECTS = 5;
const DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const ANNAS_AUDIT_FILE = '.olympus-annas-audit.jsonl';
const NOTION_BASE_URL = 'https://api.notion.com/v1';
const NOTION_DEFAULT_VERSION = '2022-06-28';
const NOTION_DEFAULT_MAX_OBJECTS = 200;
const NOTION_DEFAULT_DEPTH = 6;
const NOTION_MAX_RETRIES = 3;
const DEFAULT_DOMAIN_RETRIEVAL_TOP_K = 30;
const DEFAULT_DOMAIN_ANSWER_CONTEXT_LIMIT = 12;
const DEFAULT_DOMAIN_RERANKER: DomainExpertReranker = 'rank-service';
const DEFAULT_DOMAIN_RANKER_MODEL = 'semantic-ranker-512@latest';
const MAX_DOMAIN_RETRIEVAL_QUERIES = 3;
const DOMAIN_RRF_K = 60;

export class DomainExpertWorkerError extends Error {
  status: number;
  code: string;
  suggestion?: string;
  stderrTail?: string;

  constructor(status: number, code: string, message: string, suggestion?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}

export class DomainExpertService {
  private roots: Map<string, DomainExpertWorkspaceRootPolicy>;
  private google: GoogleRuntimeClient;
  private annas: DomainExpertAnnasConfig;
  private annasBooksRoot: string;
  private annasMaxDownloadBytes: number;
  private notion: NotionRuntimeClient;
  private dataDir: string;
  private fetchImpl: typeof fetch;
  private webImportFetchImpl: WebImportFetchImpl;
  private webImportFetchTimeoutMs: number;
  private annasDownloadTimeoutMs: number;
  private resolveHostImpl: ResolveHostImpl;
  private ytDlpBin: string;
  private mediaExec: MediaExec;
  private ragCorpusCache = new Map<string, ResolvedRagCorpus>();
  private ragCorpusListCache = new Map<string, Array<{ name: string; displayName?: string }>>();
  private ragCorpusMapping?: RagCorpusMappingFile;
  private ragCorpusMappingQueue: Promise<unknown> = Promise.resolve();
  private ragCorpusMappingWarnings: RagCorpusMappingFileWarning[] = [];
  private ragCorpusProjectAliases = new Map<string, Set<string>>();
  private registryAppendQueue: Promise<unknown> = Promise.resolve();

  constructor(options: DomainExpertWorkerOptions = {}) {
    this.roots = new Map((options.roots ?? []).map((root) => [root.rootId, normalizeRoot(root)]));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webImportFetchImpl = options.webImportFetchImpl
      ?? (options.fetchImpl ? webImportFetchFromFetchImpl(options.fetchImpl) : defaultWebImportFetch);
    this.webImportFetchTimeoutMs = normalizePositiveInteger(options.webImportFetchTimeoutMs, WEB_IMPORT_FETCH_TIMEOUT_MS);
    this.annasDownloadTimeoutMs = normalizePositiveInteger(options.annasDownloadTimeoutMs, ANNAS_ARCHIVE_DOWNLOAD_TIMEOUT_MS);
    this.google = new GoogleRuntimeClient({
      ...(options.google ?? {}),
      fetchImpl: options.google?.fetchImpl ?? options.fetchImpl ?? fetch,
    });
    this.annas = options.annas ?? {};
    this.annasBooksRoot = options.annas?.booksRoot ?? '';
    this.annasMaxDownloadBytes = normalizePositiveInteger(options.annas?.maxDownloadBytes, DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES);
    this.notion = new NotionRuntimeClient({
      ...(options.notion ?? {}),
      fetchImpl: options.notion?.fetchImpl ?? options.fetchImpl ?? fetch,
    });
    this.dataDir = options.dataDir ?? '/tmp/olympus-domain-expert';
    this.resolveHostImpl = options.resolveHostImpl ?? defaultResolveHost;
    this.ytDlpBin = options.ytDlpBin ?? process.env.OLYMPUS_DOMAIN_EXPERT_YTDLP_BIN ?? 'yt-dlp';
    this.mediaExec = options.mediaExec ?? defaultMediaExec;
  }

  health(): Record<string, unknown> {
    return {
      kind: 'domain_expert_health',
      reachable: true,
      configured: {
        workspace_roots: this.roots.size,
        // Credentials and tenant are separate facts and were reported as one.
        // `google: true` with no project meant "ready" for a runtime that
        // cannot make a single Vertex call, so `google` now requires both and
        // the two halves are reported individually for diagnosis.
        google: this.google.configured() && googleTenantConfigured(),
        google_credentials: this.google.configured(),
        google_tenant: googleTenantConfigured(),
        annas_archive: Boolean(this.annas.apiKey && (this.annas.searchUrlTemplate || this.annas.baseUrl)),
        annas_books_root: Boolean(this.annasBooksRoot),
        notion: this.notion.configured(),
      },
      roots: [...this.roots.values()].map((root) => ({
        root_id: root.rootId,
        max_write_bytes: root.maxWriteBytes,
        allow_overwrite: root.allowOverwrite,
      })),
      policy: domainPolicy(),
    };
  }

  async run(request: DomainExpertRequest): Promise<unknown> {
    switch (request.tool) {
      case 'domain_agent':
        return this.domainAgent(parseDomainAgentParams(request.params));
      case 'domain_ask':
        return this.domainAsk(parseDomainAskParams(request.params));
      case 'domain_source':
        return this.domainSource(parseDomainSourceParams(request.params));
      case 'rag_corpus':
        return this.ragCorpus(parseRagCorpusParams(request.params));
      case 'domain_doc':
        return this.domainDoc(parseDomainDocParams(request.params));
      case 'annas_archive_search':
        return this.annasSearch(parseAnnasArchiveSearchParams(request.params));
      case 'annas_archive_import':
        return this.annasImport(parseAnnasArchiveImportParams(request.params));
      default:
        throw new DomainExpertWorkerError(400, 'invalid_tool', 'Unsupported domain expert tool.');
    }
  }

  private async domainAgent(params: DomainAgentParams): Promise<unknown> {
    const dryRun = params.dryRun ?? true;
    const plan = planDomainAgent({ ...params, dryRun: true });
    if (dryRun || params.action !== 'bootstrap') return plan;

    const manifest = domainManifest(params.domainId, params.displayName);
    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const directories = [
      manifest.workspace_relative_path,
      `${manifest.workspace_relative_path}/inbox`,
      `${manifest.workspace_relative_path}/references`,
      `${manifest.workspace_relative_path}/templates`,
      `${manifest.workspace_relative_path}/eval`,
      `${manifest.workspace_relative_path}/outputs/briefs`,
      `${manifest.workspace_relative_path}/outputs/resource-wiki-proposals`,
    ];
    for (const relativePath of directories) {
      await mkdir(resolveInside(rootPath, relativePath), { recursive: true });
    }

    const writes = await writeWorkspaceSeedFiles(root, rootPath, manifest);
    await audit(root, {
      kind: 'domain_agent_audit',
      action: 'bootstrap',
      domain_id: manifest.domain_id,
      files: writes,
      created_at: new Date().toISOString(),
    });
    return {
      kind: 'domain_agent_result',
      status: 'workspace_bootstrapped',
      domain_id: manifest.domain_id,
      root_id: root.rootId,
      workspace_relative_path: manifest.workspace_relative_path,
      directories_created: directories,
      files: writes,
      aliases_to_create: manifest.library_aliases.map((alias, index) => ({
        alias,
        target_hint: manifest.canonical_resource_paths[index] ?? manifest.canonical_resource_paths[0],
      })),
      policy: domainPolicy(),
    };
  }

  private async domainAsk(params: { domainId?: string; question: string; corpusId?: string; corpora?: string[]; maxResults?: number }): Promise<unknown> {
    const plan = planDomainAsk(params);
    const manifest = domainManifest(params.domainId);
    assertRagCloudTenantConfigured(manifest);
    const question = requireString(params.question, 'question');
    const corpora = params.corpusId
      ? [params.corpusId]
      : (params.corpora?.length ? params.corpora : manifest.corpora.map((corpus) => corpus.id));
    const topK = params.maxResults ?? this.google.retrievalTopK();
    const answerContextLimit = Math.min(topK, this.google.answerContextLimit());
    const resolvedCorpora: ResolvedRagCorpus[] = [];
    const warnings: RagCorpusWarning[] = [];
    for (const corpusId of corpora) {
      const resolved = await this.resolveRagCorpus(manifest, corpusId).catch((error) => {
        if (error instanceof DomainExpertWorkerError && error.code === 'rag_corpus_not_found' && corpora.length > 1) {
          warnings.push(ragCorpusWarning(corpusId, error));
          return undefined;
        }
        throw error;
      });
      if (resolved) {
        resolvedCorpora.push(resolved);
        warnings.push(...ragCorpusWarnings(resolved));
      }
    }
    if (resolvedCorpora.length === 0) {
      throw new DomainExpertWorkerError(
        404,
        'rag_corpus_not_found',
        `No requested RAG corpora could be resolved for ${manifest.domain_id}: ${corpora.join(', ')}.`,
        'Run rag_corpus create for at least one requested corpus before asking.',
      );
    }
    let queries = [question];
    if (this.google.multiQueryEnabled()) {
      try {
        queries = domainRetrievalQueries(question, await this.google.generateQueryReformulations({
          project: manifest.gcp_project,
          location: manifest.rag_location,
          model: this.google.model(),
          question,
        }));
      } catch {
        console.warn(JSON.stringify({ kind: 'domain_expert_multi_query_fallback', query_count: 1 }));
      }
    }
    const rankedLists: Array<Array<Record<string, unknown> & { corpus_id: string }>> = [];
    const usedCorpora = new Map<string, ResolvedRagCorpus>();
    for (const corpus of resolvedCorpora) {
      let currentCorpus = corpus;
      for (const query of queries) {
        const { value: contexts, resolved, warnings: retryWarnings } = await this.withRagCorpusRetry(manifest, currentCorpus, (candidate) => this.google.retrieveContexts({
          project: manifest.gcp_project,
          location: manifest.rag_location,
          corpusName: candidate.resourceName,
          query,
          topK,
        }));
        currentCorpus = resolved;
        usedCorpora.set(resolved.requested, resolved);
        warnings.push(...retryWarnings);
        rankedLists.push(contexts.map((context) => ({
          ...context,
          corpus_id: resolved.requested,
        })));
      }
    }
    const citationOrdinals = new Map<string, number>();
    const fusedContexts = reciprocalRankFuse<Record<string, unknown> & { corpus_id: string }>(rankedLists, answerContextLimit);
    const retrieved: Array<Record<string, unknown> & { citation_id: string; corpus_id: string }> = fusedContexts.map((context) => {
      const ordinal = (citationOrdinals.get(context.corpus_id) ?? 0) + 1;
      citationOrdinals.set(context.corpus_id, ordinal);
      return {
        ...context,
        citation_id: `${context.corpus_id}:${ordinal}`,
      };
    });
    console.info(JSON.stringify({
      kind: 'domain_expert_retrieval_counts',
      query_count: queries.length,
      corpus_count: usedCorpora.size,
      ranked_list_count: rankedLists.length,
      candidate_context_count: rankedLists.reduce((sum, contexts) => sum + contexts.length, 0),
      selected_context_count: retrieved.length,
    }));
    const answer = await this.google.generateAnswer({
      project: manifest.gcp_project,
      location: manifest.rag_location,
      model: this.google.model(),
      question,
      contexts: retrieved,
    });
    return {
      kind: 'domain_answer',
      status: 'answered',
      domain_id: manifest.domain_id,
      question,
      answer,
      citations: retrieved.map((context) => ({
        citation_id: context.citation_id,
        corpus_id: context.corpus_id,
        source_display_name: context.sourceDisplayName,
        source_uri: context.sourceUri,
        score: context.score,
      })),
      retrieved_context_count: retrieved.length,
      resolved_corpora: [...usedCorpora.values()].map((corpus) => ({
        requested: corpus.requested,
        corpus_id: corpus.corpusId,
        resource_name: corpus.resourceName,
        ...(corpus.displayName ? { display_name: corpus.displayName } : {}),
      })),
      ...(warnings.length ? { warnings } : {}),
      retrieval_plan: (plan as Record<string, unknown>).retrieval,
      policy: domainPolicy(),
    };
  }

  private async domainSource(params: DomainSourceParams): Promise<unknown> {
    const dryRun = params.dryRun ?? true;
    const manifest = domainManifest(params.domainId);
    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const registryRelativePath = `${manifest.workspace_relative_path}/references/source-registry.jsonl`;
    const registryPath = resolveInside(rootPath, registryRelativePath);
    if (params.action === 'list') {
      return this.listDomainSources(params, registryPath, registryRelativePath, manifest.domain_id);
    }
    if (params.action === 'status') {
      return this.statusDomainSource(params, registryPath, registryRelativePath, manifest.domain_id);
    }
    const plan = planDomainSource({ ...params, dryRun: true });
    if (params.action === 'remove') {
      return this.removeDomainSource(params, registryPath, registryRelativePath, manifest.domain_id, dryRun);
    }
    if (dryRun) return plan;
    const sourceRecord = (plan as { source_record: Record<string, unknown> }).source_record;
    const logPath = resolveInside(rootPath, `${manifest.workspace_relative_path}/references/ingest-log.md`);
    await mkdir(dirname(registryPath), { recursive: true });
    await this.appendRegistryJsonLine(registryPath, { ...sourceRecord, registered_at: new Date().toISOString() });
    await appendFile(logPath, `- ${new Date().toISOString()} registered ${sourceRecord.source_id} (${params.action})\n`, 'utf8');
    return {
      kind: 'domain_source_result',
      status: 'registered',
      action: params.action,
      domain_id: manifest.domain_id,
      source_record: sourceRecord,
      registry_relative_path: registryRelativePath,
      policy: domainPolicy(),
    };
  }

  private async listDomainSources(
    params: DomainSourceParams,
    registryPath: string,
    registryRelativePath: string,
    domainId: string,
  ): Promise<Record<string, unknown>> {
    const registry = await readDomainSourceRegistry(registryPath);
    const includeHistory = params.includeHistory === true;
    const includeRemoved = params.includeRemoved === true;
    const grouped = groupDomainSourceRecords(registry.records);
    const sources = [...grouped.entries()]
      .map(([sourceId, history]) => ({ sourceId, history, current: latestDomainSourceRecord(history) }))
      .filter(({ current }) => includeRemoved || !current.removed)
      .filter(({ current }) => !params.sourceKind || stringRecordField(current.record, 'kind') === params.sourceKind)
      .filter(({ current }) => !params.corpusId || stringRecordField(current.record, 'target_corpus_id') === params.corpusId)
      .sort((left, right) => compareDomainSourceRecords(left.current, right.current))
      .map(({ sourceId, history, current }) => ({
        source_id: sourceId,
        record_count: history.length,
        current: current.record,
        ...(includeHistory ? { history: history.map((entry) => entry.record) } : {}),
      }));
    return {
      kind: 'domain_source_list',
      status: 'ok',
      domain_id: domainId,
      registry_relative_path: registryRelativePath,
      total_records: registry.totalRecords,
      malformed_lines: registry.malformedLines,
      sources,
      ...(registry.missing ? { note: `Source registry ${registryRelativePath} does not exist yet.` } : {}),
      filters: {
        ...(params.sourceKind ? { kind: params.sourceKind } : {}),
        ...(params.corpusId ? { corpus_id: params.corpusId } : {}),
        include_history: includeHistory,
        include_removed: includeRemoved,
      },
      policy: domainPolicy(),
    };
  }

  private async statusDomainSource(
    params: DomainSourceParams,
    registryPath: string,
    registryRelativePath: string,
    domainId: string,
  ): Promise<Record<string, unknown>> {
    const sourceId = params.sourceId?.trim();
    if (!sourceId) throw new DomainExpertWorkerError(400, 'invalid_params', 'domain_source status requires source_id.');
    const registry = await readDomainSourceRegistry(registryPath);
    const history = registry.records
      .filter((entry) => entry.sourceId === sourceId)
      .sort(compareDomainSourceRecords);
    if (history.length === 0) {
      throw new DomainExpertWorkerError(404, 'domain_source_not_found', `Source ${sourceId} was not found in ${registryRelativePath}.`);
    }
    const current = latestDomainSourceRecord(history);
    return {
      kind: 'domain_source_status',
      status: 'ok',
      domain_id: domainId,
      source_id: sourceId,
      registry_relative_path: registryRelativePath,
      total_records: registry.totalRecords,
      malformed_lines: registry.malformedLines,
      current: current.record,
      history: history.map((entry) => entry.record),
      removed: current.removed,
      policy: domainPolicy(),
    };
  }

  private async removeDomainSource(
    params: DomainSourceParams,
    registryPath: string,
    registryRelativePath: string,
    domainId: string,
    dryRun: boolean,
  ): Promise<Record<string, unknown>> {
    const sourceId = params.sourceId?.trim();
    if (!sourceId) throw new DomainExpertWorkerError(400, 'invalid_params', 'domain_source remove requires source_id.');
    const registry = await readDomainSourceRegistry(registryPath);
    const history = registry.records
      .filter((entry) => entry.sourceId === sourceId)
      .sort(compareDomainSourceRecords);
    if (history.length === 0) {
      throw new DomainExpertWorkerError(404, 'domain_source_not_found', `Source ${sourceId} was not found in ${registryRelativePath}.`);
    }
    const current = latestDomainSourceRecord(history);
    const tombstone = {
      source_id: sourceId,
      domain_id: domainId,
      ingest_status: 'removed',
      removed: true,
      registered_at: new Date().toISOString(),
    };
    if (dryRun) {
      return {
        kind: 'domain_source_plan',
        status: 'dry_run_source_lifecycle_ready',
        action: 'remove',
        domain_id: domainId,
        registry_relative_path: registryRelativePath,
        target_record: current.record,
        tombstone_record: tombstone,
        policy: domainPolicy(),
      };
    }
    const logPath = resolveInside(dirname(dirname(registryPath)), 'references/ingest-log.md');
    await mkdir(dirname(registryPath), { recursive: true });
    await this.appendRegistryJsonLine(registryPath, tombstone);
    await appendFile(logPath, `- ${tombstone.registered_at} removed ${sourceId} (remove)\n`, 'utf8');
    return {
      kind: 'domain_source_result',
      status: 'removed',
      action: 'remove',
      domain_id: domainId,
      source_record: tombstone,
      target_record: current.record,
      registry_relative_path: registryRelativePath,
      policy: domainPolicy(),
    };
  }

  private async ragCorpus(params: RagCorpusParams): Promise<unknown> {
    const dryRun = params.dryRun ?? true;
    // Before ANY dispatch. stage_import, web_import and notion_import each
    // fetch, stage, upload or transcribe before they touch a corpus, so a
    // guard placed after the dispatch let a tenant-less runtime do outbound
    // work first and only then refuse. Nothing in this handler runs until the
    // deployment has a cloud tenant.
    assertRagCloudTenantConfigured(domainManifest(params.domainId));
    if (params.action === 'stage_import') {
      return this.stageRagImport(params, dryRun);
    }
    if (params.action === 'web_import') {
      return this.webRagImport(params, dryRun);
    }
    if (params.action === 'notion_import') {
      return this.notionRagImport(params, dryRun);
    }
    const plan = planRagCorpus({ ...params, dryRun: true });
    if (dryRun && params.action !== 'delete_file' && params.action !== 'list_files') return plan;
    const manifest = domainManifest(params.domainId);
    const corpusId = params.corpusId ?? defaultCorpusId(manifest.domain_id, params.action);
    assertReviewedLiveRagImport(manifest, params, dryRun);
    if (params.action === 'create') {
      const description = manifest.corpora.find((corpus) => corpus.id === corpusId)?.description;
      const operation = await this.google.createRagCorpus({
        project: manifest.gcp_project,
        location: manifest.rag_location,
        displayName: corpusId,
        ...(description ? { description } : {}),
      });
      const createdResourceName = extractRagCorpusResourceName(operation);
      if (createdResourceName) {
        await this.recordRagCorpusMapping(manifest.gcp_project, manifest.rag_location, corpusId, createdResourceName);
      }
      return {
        kind: 'rag_corpus_result',
        status: 'create_requested',
        domain_id: manifest.domain_id,
        operation,
        ...(createdResourceName ? {
          resolved_corpus: {
            requested: corpusId,
            corpus_id: corpusIdFromResourceName(createdResourceName),
            resource_name: createdResourceName,
            display_name: corpusId,
          },
        } : {}),
        policy: domainPolicy(),
      };
    }
    const resolved = await this.resolveRagCorpus(manifest, corpusId);
    const resolutionWarnings = ragCorpusWarnings(resolved);
    if (params.action === 'status' || params.action === 'refresh') {
      const { value: corpus, resolved: usedResolved, warnings } = await this.withRagCorpusRetry(manifest, resolved, (candidate) => this.google.getRagCorpus({
        project: manifest.gcp_project,
        location: manifest.rag_location,
        corpusName: candidate.resourceName,
      }));
      return {
        kind: 'rag_corpus_status',
        domain_id: manifest.domain_id,
        resolved_corpus: {
          requested: usedResolved.requested,
          corpus_id: usedResolved.corpusId,
          resource_name: usedResolved.resourceName,
          ...(usedResolved.displayName ? { display_name: usedResolved.displayName } : {}),
        },
        corpus,
        ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
        policy: domainPolicy(),
      };
    }
    if (params.action === 'list_files') {
      const { value: result, resolved: usedResolved, warnings } = await this.withRagCorpusRetry(manifest, resolved, (candidate) => this.google.listRagFiles({
        project: manifest.gcp_project,
        location: manifest.rag_location,
        corpusName: candidate.resourceName,
        ...(params.pageToken ? { pageToken: params.pageToken } : {}),
      }));
      this.rememberResolvedRagCorpusProjectAliases(manifest, usedResolved);
      this.rememberListedRagFileProjects(manifest, usedResolved, result.files);
      return {
        kind: 'rag_corpus_files',
        domain_id: manifest.domain_id,
        resolved_corpus: resolvedCorpusRecord(usedResolved),
        files: result.files,
        ...(result.nextPageToken ? { next_page_token: result.nextPageToken } : {}),
        ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
        policy: domainPolicy(),
      };
    }
    if (params.action === 'delete_file') {
      const ragFileName = requireString(params.ragFileName, 'rag_file_name');
      this.assertRagFileBelongsToResolvedCorpus(manifest, ragFileName, resolved);
      const base = {
        action: 'delete_file',
        domain_id: manifest.domain_id,
        resolved_corpus: resolvedCorpusRecord(resolved),
        rag_file_name: ragFileName,
        ...([...resolutionWarnings].length ? { warnings: resolutionWarnings } : {}),
        policy: domainPolicy(),
      };
      if (dryRun) {
        return {
          kind: 'rag_corpus_delete_file_plan',
          status: 'dry_run_delete_file_ready',
          ...base,
        };
      }
      const { value: operation, resolved: usedResolved, warnings } = await this.withRagCorpusRetry(manifest, resolved, (candidate) => {
        this.assertRagFileBelongsToResolvedCorpus(manifest, ragFileName, candidate);
        return this.google.deleteRagFile({
          project: manifest.gcp_project,
          location: manifest.rag_location,
          ragFileName,
        });
      });
      return {
        kind: 'rag_corpus_delete_file_result',
        status: 'delete_file_requested',
        ...base,
        resolved_corpus: resolvedCorpusRecord(usedResolved),
        ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
        operation,
      };
    }
    const { value: operation, resolved: usedResolved, warnings } = await this.withRagCorpusRetry(manifest, resolved, (candidate) => this.google.importRagFiles({
      project: manifest.gcp_project,
      location: manifest.rag_location,
      corpusName: candidate.resourceName,
      ...(params.gcsUri ? { gcsUri: params.gcsUri } : {}),
      ...(params.driveFileId ? { driveFileId: params.driveFileId } : {}),
      chunkTokens: manifest.chunking.chunk_tokens,
      chunkOverlap: manifest.chunking.chunk_overlap,
    }));
    return {
      kind: 'rag_corpus_result',
      status: 'import_requested',
      domain_id: manifest.domain_id,
      resolved_corpus: {
        requested: usedResolved.requested,
        corpus_id: usedResolved.corpusId,
        resource_name: usedResolved.resourceName,
        ...(usedResolved.displayName ? { display_name: usedResolved.displayName } : {}),
      },
      ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
      operation,
      policy: domainPolicy(),
    };
  }

  private async stageRagImport(params: RagCorpusParams, dryRun: boolean): Promise<unknown> {
    const manifest = domainManifest(params.domainId);
    const corpusId = params.corpusId ?? defaultCorpusId(manifest.domain_id, params.action);
    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const workspaceRelativePath = requireString(params.workspaceRelativePath, 'workspace_relative_path');
    const batchId = normalizeStageBatchId(params.batchId ?? randomUUID());
    const stage = await this.planStageImportDirectory({
      manifest,
      rootPath,
      workspaceRelativePath,
      batchId,
      corpusId,
      includeMedia: params.includeMedia ?? false,
    });
    const { eligible, skipped, totalBytes, destination, resolvedCorpus } = stage;
    const resolutionWarnings = ragCorpusWarnings(stage.resolved);
    if (eligible.length === 0) {
      throw new DomainExpertWorkerError(
        400,
        'no_stage_import_files',
        'stage_import found no eligible files after applying extension and size limits.',
      );
    }
    const base = {
      action: 'stage_import',
      domain_id: manifest.domain_id,
      source: {
        workspace_root_id: manifest.workspace_root_id,
        workspace_relative_path: workspaceRelativePath,
        recursive: true,
      },
      destination: {
        gcs_uri_prefix: destination.directoryUri,
        bucket: destination.bucket,
        object_prefix: destination.objectPrefix,
        batch_id: batchId,
        allowed_gcs_prefixes: manifest.allowed_gcs_prefixes,
      },
      resolved_corpus: resolvedCorpus,
      file_policy: {
        recursive: true,
        allowed_extensions: [...STAGE_IMPORT_ALLOWED_EXTENSIONS].map((extension) => extension.slice(1)),
        max_file_bytes: STAGE_IMPORT_MAX_FILE_BYTES,
        max_batch_bytes: STAGE_IMPORT_MAX_BATCH_BYTES,
        media_max_file_bytes: MEDIA_TRANSCRIBE_MAX_BYTES,
        media_bytes_count_against_text_batch_cap: false,
      },
      eligible_files: eligible.map((file) => ({
        workspace_relative_path: file.workspaceRelativePath,
        upload_relative_path: file.uploadRelativePath,
        bytes: file.bytes,
        gcs_uri: file.gcsUri,
      })),
      skipped_files: skipped,
      eligible_file_count: eligible.length,
      skipped_file_count: skipped.length,
      total_eligible_bytes: totalBytes,
      ...(resolutionWarnings.length ? { warnings: resolutionWarnings } : {}),
      policy: domainPolicy(),
    };
    if (dryRun) {
      return {
        kind: 'rag_corpus_stage_import_plan',
        status: 'dry_run_stage_import_ready',
        ...base,
      };
    }
    const { stagedFiles, operation, warnings, resolved } = await this.executeStageImport(stage);
    return {
      kind: 'rag_corpus_stage_import_result',
      status: 'staged_and_import_requested',
      ...base,
      resolved_corpus: resolvedCorpusRecord(resolved),
      staged_files: stagedFiles,
      ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
      operation,
    };
  }

  private async webRagImport(params: RagCorpusParams, dryRun: boolean): Promise<unknown> {
    const manifest = domainManifest(params.domainId);
    const corpusId = requireString(params.corpusId, 'corpus_id');
    const urls = params.urls ?? [];
    if (urls.length === 0 || urls.length > 200) {
      throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus web_import requires urls with 1 to 200 entries.');
    }
    const includeMedia = params.includeMedia ?? false;
    const transcriptMode = params.transcriptMode ?? 'auto';
    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const batchId = normalizeStageBatchId(params.batchId ?? randomUUID());
    const importWorkspaceRelativePath = `${manifest.workspace_relative_path}/sources/web-imports/${batchId}`;
    const importPath = resolveInside(rootPath, importWorkspaceRelativePath);
    const fetchedAt = new Date().toISOString();
    const budget = webImportBudget();
    const guardedFetch = (url: string) => guardedWebImportFetch({
      url,
      fetchImpl: this.webImportFetchImpl,
      resolveHost: this.resolveHostImpl,
      budget,
      timeoutMs: this.webImportFetchTimeoutMs,
    });
    const mediaDestination = stageDestination(manifest.allowed_gcs_prefixes, manifest.domain_id, batchId);
    const derivation = await deriveWebImportFiles({
      urls,
      includeMedia,
      transcriptMode,
      dryRun,
      fetchedAt,
      fetch: guardedFetch,
      media: {
        domainId: manifest.domain_id,
        project: manifest.gcp_project,
        location: manifest.rag_location,
        batchId,
        destination: mediaDestination,
        dataDir: this.dataDir,
        ytDlpBin: this.ytDlpBin,
        exec: this.mediaExec,
        upload: (bucket, objectName, bytes) => this.google.uploadGcsObject(bucket, objectName, bytes),
        transcribe: (input) => this.google.transcribeMedia({
          project: manifest.gcp_project,
          location: manifest.rag_location,
          model: this.google.transcribeModel(),
          ...input,
        }),
      },
    });

    if (derivation.files.length > 0) {
      await mkdir(importPath, { recursive: true });
      for (const file of derivation.files) {
        const absolutePath = resolveInside(importPath, file.fileName);
        if (!root.allowOverwrite && await fileExists(absolutePath)) {
          throw new DomainExpertWorkerError(409, 'workspace_file_exists', `${importWorkspaceRelativePath}/${file.fileName} already exists.`);
        }
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, file.bytes);
      }
    }

    const stage = await this.planStageImportDirectory({
      manifest,
      rootPath,
      workspaceRelativePath: importWorkspaceRelativePath,
      batchId,
      corpusId,
      includeMedia,
    }).catch((error) => {
      if (derivation.files.length === 0 && error instanceof DomainExpertWorkerError && error.code === 'workspace_path_not_found') {
        return undefined;
      }
      throw error;
    });
    const eligible = stage?.eligible ?? [];
    const skipped = stage?.skipped ?? [];
    const totalBytes = stage?.totalBytes ?? 0;
    const destination = stage?.destination ?? mediaDestination;
    const resolved = stage?.resolved ?? await this.resolveRagCorpus(manifest, corpusId);
    const resolvedCorpus = stage?.resolvedCorpus ?? resolvedCorpusRecord(resolved);
    const resolutionWarnings = ragCorpusWarnings(resolved);
    const provenanceUrls = urls.map(webImportProvenanceUrl);
    const base = {
      action: 'web_import',
      domain_id: manifest.domain_id,
      source: {
        urls: provenanceUrls,
        include_media: includeMedia,
        transcript_mode: transcriptMode,
        batch_id: batchId,
        workspace_root_id: manifest.workspace_root_id,
        workspace_relative_path: importWorkspaceRelativePath,
      },
      handler_table: WEB_IMPORT_HANDLERS.map((handler) => handler.id),
      fetch_policy: {
        https_only: true,
        private_ip_denied: true,
        max_fetch_bytes: WEB_IMPORT_MAX_FETCH_BYTES,
        max_batch_bytes: WEB_IMPORT_MAX_BATCH_BYTES,
        max_fetches: WEB_IMPORT_MAX_FETCHES,
        timeout_ms: this.webImportFetchTimeoutMs,
        media_max_file_bytes: MEDIA_TRANSCRIBE_MAX_BYTES,
        media_bytes_count_against_text_batch_cap: false,
      },
      destination: {
        gcs_uri_prefix: destination.directoryUri,
        bucket: destination.bucket,
        object_prefix: destination.objectPrefix,
        batch_id: batchId,
        allowed_gcs_prefixes: manifest.allowed_gcs_prefixes,
      },
      resolved_corpus: resolvedCorpus,
      derived_files: derivation.files.map((file) => ({
        source_url: webImportProvenanceUrl(file.sourceUrl),
        final_url: webImportProvenanceUrl(file.finalUrl),
        kind: file.kind,
        workspace_relative_path: `${importWorkspaceRelativePath}/${file.fileName}`,
        bytes: file.bytes.byteLength,
        ...(file.warnings?.length ? { warnings: file.warnings } : {}),
      })),
      url_results: derivation.urlResults,
      errors: derivation.errors,
      eligible_files: eligible.map((file) => ({
        workspace_relative_path: file.workspaceRelativePath,
        upload_relative_path: file.uploadRelativePath,
        bytes: file.bytes,
        gcs_uri: file.gcsUri,
      })),
      skipped_files: skipped,
      eligible_file_count: eligible.length,
      skipped_file_count: skipped.length,
      total_eligible_bytes: totalBytes,
      ...(resolutionWarnings.length ? { warnings: resolutionWarnings } : {}),
      policy: domainPolicy(),
    };
    if (dryRun) {
      return {
        kind: 'rag_corpus_web_import_plan',
        status: eligible.length > 0 ? 'dry_run_web_import_ready' : 'dry_run_web_import_no_importable_files',
        ...base,
      };
    }
    if (!stage || eligible.length === 0) {
      return {
        kind: 'rag_corpus_web_import_result',
        status: 'web_import_no_importable_files',
        ...base,
      };
    }
    const { stagedFiles, operation, warnings, resolved: importResolved } = await this.executeStageImport(stage);
    const importResolvedCorpus = resolvedCorpusRecord(importResolved);
    await this.appendWebImportRegistryRecord({
      manifest,
      rootPath,
      urls,
      batchId,
      importWorkspaceRelativePath,
      resolvedCorpus: importResolvedCorpus,
      stagedFileCount: stagedFiles.length,
    });
    return {
      kind: 'rag_corpus_web_import_result',
      status: 'staged_and_import_requested',
      ...base,
      resolved_corpus: importResolvedCorpus,
      staged_files: stagedFiles,
      ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
      operation,
    };
  }

  private async notionRagImport(params: RagCorpusParams, dryRun: boolean): Promise<unknown> {
    if (!this.notion.configured()) {
      throw new DomainExpertWorkerError(
        503,
        'notion_not_configured',
        'notion_import requires a Notion integration token. Run olympus connect notion, then wire OLYMPUS_DOMAIN_EXPERT_NOTION_TOKEN into the domain-expert worker.',
      );
    }
    const manifest = domainManifest(params.domainId);
    const corpusId = requireString(params.corpusId, 'corpus_id');
    const batchId = normalizeStageBatchId(params.batchId ?? randomUUID());
    const importWorkspaceRelativePath = `${manifest.workspace_relative_path}/sources/notion-imports/${batchId}`;
    const sources = notionImportSources(params);
    const maxObjects = this.notion.maxObjects();
    if (sources.length === 0 || sources.length > maxObjects) {
      throw new DomainExpertWorkerError(400, 'invalid_params', `rag_corpus notion_import requires 1 to ${maxObjects} urls, page_ids, or database_ids.`);
    }
    await this.notion.probe();
    const objectPlans: NotionImportObjectPlan[] = [];
    const errors: Array<Record<string, unknown>> = [];
    let skippedObjectCount = 0;
    for (const source of sources) {
      try {
        const metadata = await this.notion.inspectObject(source.id, source.type);
        const titleSlug = safeObjectName(metadata.title || metadata.objectId);
        objectPlans.push({
          object_id: metadata.objectId,
          object_type: metadata.objectType,
          title: metadata.title,
          ...(source.url ? { source_url: source.url } : {}),
          ...(metadata.childBlockCount !== undefined ? { child_block_count: metadata.childBlockCount } : {}),
          ...(metadata.rowPageCount !== undefined ? { row_page_count: metadata.rowPageCount } : {}),
          workspace_relative_path: `${importWorkspaceRelativePath}/${titleSlug}-${metadata.objectId.slice(0, 8)}.md`,
          ...(metadata.warnings.length ? { warnings: metadata.warnings } : {}),
        });
        skippedObjectCount += metadata.skippedObjectCount;
      } catch (error) {
        errors.push(notionImportErrorForObject(error, source));
      }
    }
    const destination = stageDestination(manifest.allowed_gcs_prefixes, manifest.domain_id, batchId);
    const base = {
      action: 'notion_import',
      domain_id: manifest.domain_id,
      source: {
        urls: (params.urls ?? []).map(sanitizeNotionSourceUrl),
        page_ids: (params.pageIds ?? []).map(normalizeNotionObjectId),
        database_ids: (params.databaseIds ?? []).map(normalizeNotionObjectId),
        batch_id: batchId,
        workspace_root_id: manifest.workspace_root_id,
        workspace_relative_path: importWorkspaceRelativePath,
      },
      api_policy: {
        base_url: NOTION_BASE_URL,
        notion_version: this.notion.notionVersion(),
        max_starting_objects: maxObjects,
        block_depth_cap: NOTION_DEFAULT_DEPTH,
        media_downloads: false,
        retry_429: true,
      },
      destination: {
        gcs_uri_prefix: destination.directoryUri,
        bucket: destination.bucket,
        object_prefix: destination.objectPrefix,
        batch_id: batchId,
        allowed_gcs_prefixes: manifest.allowed_gcs_prefixes,
      },
      corpus: {
        corpus_id: corpusId,
        backend: manifest.rag_backend,
        gcp_project: manifest.gcp_project,
        location: manifest.rag_location,
      },
      derived_files: objectPlans,
      object_count: objectPlans.length,
      skipped_object_count: skippedObjectCount,
      errors,
      policy: domainPolicy(),
    };
    if (dryRun) {
      return {
        kind: 'rag_corpus_notion_import_plan',
        status: objectPlans.length > 0 ? 'dry_run_notion_import_ready' : 'dry_run_notion_import_no_importable_objects',
        ...base,
      };
    }
    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const importPath = resolveInside(rootPath, importWorkspaceRelativePath);
    const retrievedAt = new Date().toISOString();
    const markdownFiles: NotionMarkdownDerivative[] = [];
    const liveErrors = [...errors];
    const notionWarnings: string[] = [];
    for (const plan of objectPlans) {
      const source = sources.find((candidate) => candidate.id === plan.object_id);
      try {
        if (plan.object_type === 'database') {
          const database = await this.notion.listDatabasePages(plan.object_id);
          for (const warning of database.warnings) {
            notionWarnings.push(warning);
            if (!plan.warnings?.includes(warning)) plan.warnings = [...(plan.warnings ?? []), warning];
          }
          for (const page of database.pages) {
            markdownFiles.push(await this.notion.fetchPageMarkdown({
              id: page.objectId,
              retrievedAt,
              filePrefix: database.databaseTitle,
            }));
          }
        } else {
          markdownFiles.push(await this.notion.fetchPageMarkdown({
            id: plan.object_id,
            ...(source?.url ? { sourceUrl: source.url } : {}),
            retrievedAt,
          }));
        }
      } catch (error) {
        liveErrors.push(notionImportErrorForObject(error, {
          id: plan.object_id,
          type: plan.object_type,
          ...(source?.url ? { url: source.url } : {}),
        }));
      }
    }
    if (markdownFiles.length > 0) {
      await mkdir(importPath, { recursive: true });
      for (const file of markdownFiles) {
        const absolutePath = resolveInside(importPath, file.fileName);
        if (!root.allowOverwrite && await fileExists(absolutePath)) {
          throw new DomainExpertWorkerError(409, 'workspace_file_exists', `${importWorkspaceRelativePath}/${file.fileName} already exists.`);
        }
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, file.bytes);
      }
    }
    const stage = markdownFiles.length > 0
      ? await this.planStageImportDirectory({
          manifest,
          rootPath,
          workspaceRelativePath: importWorkspaceRelativePath,
          batchId,
          corpusId,
          includeMedia: false,
        })
      : undefined;
    const eligible = stage?.eligible ?? [];
    const skipped = stage?.skipped ?? [];
    const totalBytes = stage?.totalBytes ?? 0;
    const resolved = stage?.resolved ?? await this.resolveRagCorpus(manifest, corpusId);
    const resolutionWarnings = ragCorpusWarnings(resolved);
    const liveBase = {
      ...base,
      errors: liveErrors,
      ...(notionWarnings.length ? { notion_warnings: [...new Set(notionWarnings)] } : {}),
      derived_files: markdownFiles.map((file) => ({
        source_url: file.sourceUrl,
        notion_object_id: file.objectId,
        notion_object_type: file.objectType,
        title: file.title,
        workspace_relative_path: `${importWorkspaceRelativePath}/${file.fileName}`,
        bytes: file.bytes.byteLength,
        ...(file.parentPageId ? { parent_page_id: file.parentPageId } : {}),
        ...(file.parentDatabaseId ? { parent_database_id: file.parentDatabaseId } : {}),
        ...(file.warnings.length ? { warnings: [...new Set(file.warnings)] } : {}),
      })),
      eligible_files: eligible.map((file) => ({
        workspace_relative_path: file.workspaceRelativePath,
        upload_relative_path: file.uploadRelativePath,
        bytes: file.bytes,
        gcs_uri: file.gcsUri,
      })),
      skipped_files: skipped,
      eligible_file_count: eligible.length,
      skipped_file_count: skipped.length,
      total_eligible_bytes: totalBytes,
      ...(resolutionWarnings.length ? { warnings: resolutionWarnings } : {}),
    };
    if (!stage || eligible.length === 0) {
      return {
        kind: 'rag_corpus_notion_import_result',
        status: 'notion_import_no_importable_files',
        ...liveBase,
      };
    }
    const { stagedFiles, operation, warnings, resolved: importResolved } = await this.executeStageImport(stage);
    const importResolvedCorpus = resolvedCorpusRecord(importResolved);
    await this.appendNotionImportRegistryRecord({
      manifest,
      rootPath,
      sources,
      batchId,
      importWorkspaceRelativePath,
      resolvedCorpus: importResolvedCorpus,
      stagedFileCount: stagedFiles.length,
    });
    return {
      kind: 'rag_corpus_notion_import_result',
      status: 'staged_and_import_requested',
      ...liveBase,
      corpus: {
        ...base.corpus,
        resolved_corpus: importResolvedCorpus,
      },
      staged_files: stagedFiles,
      ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
      operation,
    };
  }

  private async planStageImportDirectory(input: {
    manifest: ReturnType<typeof domainManifest>;
    rootPath: string;
    workspaceRelativePath: string;
    batchId: string;
    corpusId: string;
    includeMedia: boolean;
  }): Promise<{
    destination: ReturnType<typeof stageDestination>;
    batchId: string;
    eligible: StageImportEligibleFile[];
    skipped: StageImportSkippedFile[];
    totalBytes: number;
    resolved: ResolvedRagCorpus;
    resolvedCorpus: Record<string, unknown>;
    manifest: ReturnType<typeof domainManifest>;
  }> {
    const targetPath = resolveInside(input.rootPath, input.workspaceRelativePath);
    const destination = stageDestination(input.manifest.allowed_gcs_prefixes, input.manifest.domain_id, input.batchId);
    const { eligible, skipped, totalBytes } = await planStageImportFiles(
      input.rootPath,
      targetPath,
      destination.bucket,
      destination.objectPrefix,
      { includeMedia: input.includeMedia },
    );
    const resolved = await this.resolveRagCorpus(input.manifest, input.corpusId);
    return {
      destination,
      batchId: input.batchId,
      eligible,
      skipped,
      totalBytes,
      resolved,
      resolvedCorpus: resolvedCorpusRecord(resolved),
      manifest: input.manifest,
    };
  }

  private async executeStageImport(stage: {
    destination: ReturnType<typeof stageDestination>;
    batchId: string;
    eligible: StageImportEligibleFile[];
    resolved: ResolvedRagCorpus;
    manifest: ReturnType<typeof domainManifest>;
  }): Promise<{ stagedFiles: Array<Record<string, unknown>>; operation: unknown; warnings: Array<Record<string, unknown> | RagCorpusWarning>; resolved: ResolvedRagCorpus }> {
    const stagedFiles = [];
    const warnings: Array<Record<string, unknown> | RagCorpusWarning> = [];
    for (const file of stage.eligible) {
      const bytes = new Uint8Array(await readFile(file.absolutePath));
      if (bytes.byteLength !== file.bytes || bytes.byteLength > maxStageFileBytes(file.workspaceRelativePath)) {
        throw new DomainExpertWorkerError(409, 'stage_import_file_changed', `${file.workspaceRelativePath} changed during staging.`);
      }
      await this.google.uploadGcsObject(stage.destination.bucket, file.objectName, bytes);
      const stagedFile = {
        workspace_relative_path: file.workspaceRelativePath,
        upload_relative_path: file.uploadRelativePath,
        gcs_uri: file.gcsUri,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      };
      stagedFiles.push(stagedFile);
      if (isTranscribableMediaPath(file.workspaceRelativePath)) {
        const mimeType = mediaMimeType(file.workspaceRelativePath);
        try {
          const transcript = await transcribeMediaFromGcs({
            project: stage.manifest.gcp_project,
            location: stage.manifest.rag_location,
            sourceUrl: file.workspaceRelativePath,
            title: basename(file.workspaceRelativePath),
            kind: 'media',
            retrievedAt: new Date().toISOString(),
            transcriptSource: 'asr',
            gcsUri: file.gcsUri,
            mimeType,
            transcribe: (input) => this.google.transcribeMedia({
              project: stage.manifest.gcp_project,
              location: stage.manifest.rag_location,
              model: this.google.transcribeModel(),
              ...input,
            }),
          });
          const transcriptObjectName = `${stage.destination.objectPrefix}${safeGcsRelativePath(`${file.uploadRelativePath}.transcript.md`)}`;
          await this.google.uploadGcsObject(stage.destination.bucket, transcriptObjectName, transcript.bytes);
          stagedFiles.push({
            workspace_relative_path: `${file.workspaceRelativePath}.transcript.md`,
            upload_relative_path: `${file.uploadRelativePath}.transcript.md`,
            kind: 'media_transcript',
            transcript_source: 'asr',
            source_media_gcs_uri: file.gcsUri,
            gcs_uri: `gs://${stage.destination.bucket}/${transcriptObjectName}`,
            bytes: transcript.bytes.byteLength,
            sha256: sha256(transcript.bytes),
          });
        } catch (error) {
          warnings.push({
            workspace_relative_path: file.workspaceRelativePath,
            code: error instanceof DomainExpertWorkerError ? error.code : 'media_transcription_failed',
            message: error instanceof Error ? error.message : 'Media transcription failed.',
            ...(error instanceof DomainExpertWorkerError && error.stderrTail ? { stderr_tail: error.stderrTail } : {}),
          });
        }
      }
    }
    const retry = await this.withRagCorpusRetry(stage.manifest, stage.resolved, (candidate) => this.google.importRagFiles({
      project: stage.manifest.gcp_project,
      location: stage.manifest.rag_location,
      corpusName: candidate.resourceName,
      gcsUri: stage.destination.directoryUri,
      chunkTokens: stage.manifest.chunking.chunk_tokens,
      chunkOverlap: stage.manifest.chunking.chunk_overlap,
    }));
    warnings.push(...retry.warnings);
    return { stagedFiles, operation: retry.value, warnings, resolved: retry.resolved };
  }

  private async appendWebImportRegistryRecord(input: {
    manifest: ReturnType<typeof domainManifest>;
    rootPath: string;
    urls: string[];
    batchId: string;
    importWorkspaceRelativePath: string;
    resolvedCorpus: Record<string, unknown>;
    stagedFileCount: number;
  }): Promise<void> {
    const urls = input.urls.map(webImportProvenanceUrl);
    const registryPath = resolveInside(input.rootPath, `${input.manifest.workspace_relative_path}/references/source-registry.jsonl`);
    await mkdir(dirname(registryPath), { recursive: true });
    await this.appendRegistryJsonLine(registryPath, {
      source_id: `${input.manifest.domain_id}-web-import-${input.batchId}`,
      domain_id: input.manifest.domain_id,
      kind: 'web_import',
      urls,
      batch_id: input.batchId,
      corpus: input.resolvedCorpus,
      staged_file_count: input.stagedFileCount,
      workspace_relative_path: input.importWorkspaceRelativePath,
      target_corpus_id: input.resolvedCorpus.requested,
      trust_posture: input.manifest.trust_posture,
      ingest_status: 'import_requested',
      timestamp: new Date().toISOString(),
    });
  }

  private async appendNotionImportRegistryRecord(input: {
    manifest: ReturnType<typeof domainManifest>;
    rootPath: string;
    sources: NotionImportSource[];
    batchId: string;
    importWorkspaceRelativePath: string;
    resolvedCorpus: Record<string, unknown>;
    stagedFileCount: number;
  }): Promise<void> {
    const registryPath = resolveInside(input.rootPath, `${input.manifest.workspace_relative_path}/references/source-registry.jsonl`);
    await mkdir(dirname(registryPath), { recursive: true });
    await this.appendRegistryJsonLine(registryPath, {
      source_id: `${input.manifest.domain_id}-notion-import-${input.batchId}`,
      domain_id: input.manifest.domain_id,
      kind: 'notion_import',
      notion_object_ids: input.sources.map((source) => source.id),
      urls: input.sources.map((source) => source.url).filter((url): url is string => typeof url === 'string'),
      batch_id: input.batchId,
      corpus: input.resolvedCorpus,
      staged_file_count: input.stagedFileCount,
      workspace_relative_path: input.importWorkspaceRelativePath,
      target_corpus_id: input.resolvedCorpus.requested,
      trust_posture: input.manifest.trust_posture,
      ingest_status: 'import_requested',
      timestamp: new Date().toISOString(),
    });
  }

  private async domainDoc(params: DomainDocParams): Promise<unknown> {
    const dryRun = params.dryRun ?? true;
    const plan = planDomainDoc({ ...params, dryRun: true });
    if (dryRun) return plan;
    const manifest = domainManifest(params.domainId);
    const action = params.action;
    if (action === 'read') {
      const doc = await this.google.getDocument(params.documentId);
      return documentReadResult(manifest.domain_id, doc);
    }
    if (action === 'comment') {
      return {
        kind: 'domain_doc_result',
        status: 'comment_created',
        domain_id: manifest.domain_id,
        document_id: params.documentId,
        comment: await this.google.createDriveComment(params.documentId, requireString(params.comment, 'comment')),
        policy: domainPolicy(),
      };
    }
    if (action === 'visual_insert' || action === 'visual_replace') {
      if (!params.approvalId) {
        throw new DomainExpertWorkerError(403, 'approval_required', `${action} requires approval_id.`);
      }
      const editBatchId = params.editBatchId ?? randomUUID();
      const doc = await this.google.getDocument(params.documentId);
      const insertIndex = params.rangeStart ?? documentEndIndex(doc);
      const text = `${manifest.visual_review_style.prefix_marker} ${requireString(params.text, 'text')}`;
      const priorText = action === 'visual_replace'
        ? extractDocumentTextRange(doc, requireNumber(params.rangeStart, 'range_start'), requireNumber(params.rangeEnd, 'range_end'))
        : undefined;
      const requests: Array<Record<string, unknown>> = [];
      if (action === 'visual_replace') {
        requests.push({ deleteContentRange: { range: { startIndex: params.rangeStart, endIndex: params.rangeEnd } } });
      }
      requests.push(
        { insertText: { location: { index: insertIndex }, text } },
        {
          updateTextStyle: {
            range: { startIndex: insertIndex, endIndex: insertIndex + text.length },
            textStyle: styleFromManifest(manifest),
            fields: 'foregroundColor,backgroundColor',
          },
        },
      );
      const batchUpdate = await this.google.batchUpdateDocument(params.documentId, requests);
      if (params.comment) await this.google.createDriveComment(params.documentId, params.comment);
      const ledger: VisualEditLedgerRecord = {
        kind: 'domain_doc_visual_edit',
        edit_batch_id: editBatchId,
        domain_id: manifest.domain_id,
        document_id: params.documentId,
        action,
        inserted_text: text,
        inserted_start_index: insertIndex,
        inserted_end_index: insertIndex + text.length,
        ...(priorText !== undefined ? { prior_text: priorText } : {}),
        created_at: new Date().toISOString(),
        ...(params.approvalId ? { approval_id: params.approvalId } : {}),
      };
      await appendLedger(this.dataDir, ledger);
      return {
        kind: 'domain_doc_result',
        status: 'visual_edit_created',
        domain_id: manifest.domain_id,
        document_id: params.documentId,
        edit_batch_id: editBatchId,
        batch_update: batchUpdate,
        visual_review_style: manifest.visual_review_style,
        policy: domainPolicy(),
      };
    }
    return this.cleanupVisualEdit(manifest.domain_id, params);
  }

  private async cleanupVisualEdit(domainId: string, params: DomainDocParams): Promise<unknown> {
    const editBatchId = requireString(params.editBatchId, 'edit_batch_id');
    const ledger = await findLedgerRecord(this.dataDir, editBatchId);
    if (!ledger) throw new DomainExpertWorkerError(404, 'edit_batch_not_found', 'No visual edit ledger entry found for edit_batch_id.');
    if (ledger.document_id !== params.documentId || ledger.domain_id !== domainId) {
      throw new DomainExpertWorkerError(403, 'edit_batch_mismatch', 'The edit batch does not belong to this domain/document.');
    }
    if (params.action === 'accept_visual_edits') {
      const requests: Array<Record<string, unknown>> = [{
        updateTextStyle: {
          range: { startIndex: ledger.inserted_start_index, endIndex: ledger.inserted_end_index },
          textStyle: {},
          fields: 'foregroundColor,backgroundColor',
        },
      }];
      return {
        kind: 'domain_doc_result',
        status: 'visual_edit_accepted',
        domain_id: domainId,
        document_id: params.documentId,
        edit_batch_id: editBatchId,
        batch_update: await this.google.batchUpdateDocument(params.documentId, requests),
        policy: domainPolicy(),
      };
    }
    const requests: Array<Record<string, unknown>> = [
      {
        deleteContentRange: {
          range: {
            startIndex: ledger.inserted_start_index,
            endIndex: ledger.inserted_end_index,
          },
        },
      },
    ];
    if (ledger.action === 'visual_replace' && ledger.prior_text) {
      requests.push({ insertText: { location: { index: ledger.inserted_start_index }, text: ledger.prior_text } });
    }
    return {
      kind: 'domain_doc_result',
      status: 'visual_edit_rejected',
      domain_id: domainId,
      document_id: params.documentId,
      edit_batch_id: editBatchId,
      batch_update: await this.google.batchUpdateDocument(params.documentId, requests),
      policy: domainPolicy(),
    };
  }

  private async annasSearch(params: AnnasArchiveSearchParams): Promise<unknown> {
    const query = params.query ?? params.topic;
    const url = annasUrl(this.annas.searchUrlTemplate, this.annas.baseUrl, '/search', {
      query,
      topic: params.topic,
      title: params.title,
      author: params.author,
      language: params.language,
      max_results: String(params.maxResults ?? Math.max(params.topN ?? 10, 10)),
    });
    if (!url || !this.annas.apiKey) {
      throw new DomainExpertWorkerError(
        503,
        'annas_archive_not_configured',
        'Anna Archive search endpoint and API key must both be configured.',
      );
    }
    const { response } = await fetchAnnasCredentialed(this.fetchImpl, url, {
      config: this.annas,
      apiKey: this.annas.apiKey,
      purpose: 'search',
    });
    const body = await responseTextOrJson(response);
    if (!response.ok) {
      throw new DomainExpertWorkerError(response.status, 'annas_archive_error', 'Anna Archive search failed.');
    }
    const candidates = rankAnnasCandidates(normalizeAnnasCandidates(body), params);
    return {
      kind: 'annas_archive_search_result',
      status: 'candidates_ready',
      domain_id: params.domainId ?? 'governance',
      search: {
        ...(query ? { query } : {}),
        ...(params.topic ? { topic: params.topic } : {}),
        top_n: params.topN ?? params.maxResults ?? 10,
        format_preference: params.formatPreference ?? 'auto',
      },
      candidates,
      approval_gate: {
        required_before_download: true,
        selection_fields: ['annas_archive_id or url', 'title', 'author', 'format', 'md5', 'copyright_posture'],
      },
      policy: domainPolicy(),
    };
  }

  private async annasImport(params: AnnasArchiveImportParams): Promise<unknown> {
    const dryRun = params.dryRun ?? true;
    // First, like the RAG handler: this acquires a file and imports it into a
    // corpus, so a runtime with no cloud tenant must not get as far as planning
    // or configuration checks, let alone a download.
    assertRagCloudTenantConfigured(domainManifest(params.domainId));
    const plan = planAnnasArchiveImport({ ...params, dryRun: true });
    if (dryRun) return plan;
    if (!params.approvalId) throw new DomainExpertWorkerError(403, 'approval_required', 'annas_archive_import requires approval_id.');
    if (!this.annas.apiKey) throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', 'Anna Archive API key is not configured.');
    if (!this.annasBooksRoot) {
      throw new DomainExpertWorkerError(
        503,
        'annas_books_root_not_configured',
        'Anna Archive books root is not configured.',
        'Set OLYMPUS_DOMAIN_EXPERT_ANNAS_BOOKS_ROOT (or DomainExpertAnnasConfig.booksRoot) to the absolute directory acquisitions should be written to.',
      );
    }
    const manifest = domainManifest(params.domainId);
    const locator = params.annasArchiveId ?? params.url;
    const plannedFormat: NonNullable<AnnasArchiveImportParams['format']> = params.format && params.format !== 'unknown'
      ? params.format
      : extensionFormat(params.url ?? `${locator ?? 'download'}.pdf`) as NonNullable<AnnasArchiveImportParams['format']>;
    const plannedPath = await annasDownloadPlan(this.annasBooksRoot, { ...params, format: plannedFormat });
    const duplicate = await existingAnnasAcquisition(this.annasBooksRoot, params, plannedPath.targetPath);
    if (duplicate) {
      await appendAnnasAudit(this.annasBooksRoot, {
        kind: 'annas_archive_acquisition_audit',
        action: 'skipped_duplicate',
        domain_id: manifest.domain_id,
        approval_id: params.approvalId,
        selected: annasSelectionAudit(params),
        target_path: duplicate.targetPath,
        reason: duplicate.reason,
        created_at: new Date().toISOString(),
      });
      return {
        kind: 'annas_archive_import_result',
        status: 'skipped_duplicate',
        domain_id: manifest.domain_id,
        download: { status: 'skipped_duplicate', path: duplicate.targetPath, reason: duplicate.reason },
        rag_ingest: params.ingest ? { status: 'not_run_download_skipped' } : { status: 'not_requested' },
        policy: domainPolicy(),
      };
    }

    const downloadUrl = params.url ?? annasUrl(this.annas.downloadUrlTemplate, this.annas.baseUrl, `/download/${encodeURIComponent(requireString(locator, 'annas_archive_id'))}`, {
      id: params.annasArchiveId,
      format: plannedFormat,
    });
    if (!downloadUrl) throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', 'Anna Archive download endpoint is not configured.');
    const { response, url: finalDownloadUrl } = await fetchAnnasDownload(this.fetchImpl, downloadUrl, this.annas, this.annas.apiKey);
    if (!response.ok) throw new DomainExpertWorkerError(response.status, 'annas_archive_error', 'Anna Archive download failed.');
    const bytes = await readCappedAnnasDownloadBody(response, finalDownloadUrl, this.annasDownloadTimeoutMs, this.annasMaxDownloadBytes);
    const format: NonNullable<AnnasArchiveImportParams['format']> = params.format && params.format !== 'unknown'
      ? params.format
      : extensionFormat(finalDownloadUrl) as NonNullable<AnnasArchiveImportParams['format']>;
    const finalPath = format === plannedFormat ? plannedPath : await annasDownloadPlan(this.annasBooksRoot, { ...params, format });
    const digest = sha256(bytes);
    await writeAnnasBookFile(finalPath.targetPath, bytes);
    const download = {
      status: 'downloaded',
      path: finalPath.targetPath,
      relative_path: finalPath.relativePath,
      bytes: bytes.byteLength,
      sha256: digest,
      format,
    };
    await appendAnnasAudit(this.annasBooksRoot, {
      kind: 'annas_archive_acquisition_audit',
      action: 'downloaded',
      domain_id: manifest.domain_id,
      approval_id: params.approvalId,
      selected: annasSelectionAudit(params),
      download,
      created_at: new Date().toISOString(),
    });

    const ragIngest = params.ingest
      ? await this.tryAnnasRagIngest(manifest, params, locator ?? digest, format, bytes)
      : { status: 'not_requested' };

    return {
      kind: 'annas_archive_import_result',
      status: ragIngest.status === 'blocked' || ragIngest.status === 'needs_corpus_decision' ? 'downloaded_ingest_blocked' : 'downloaded',
      domain_id: manifest.domain_id,
      download,
      rag_ingest: ragIngest,
      policy: domainPolicy(),
    };
  }

  private async tryAnnasRagIngest(
    manifest: ReturnType<typeof domainManifest>,
    params: AnnasArchiveImportParams,
    locator: string,
    format: string,
    bytes: Uint8Array,
  ): Promise<Record<string, unknown>> {
    if (!params.corpusId?.trim()) {
      return {
        status: 'needs_corpus_decision',
        reason: 'RAG ingest requires an explicit corpus_id; no general Castor knowledge corpus is configured in this operation.',
      };
    }
    try {
      const gcsUri = await this.uploadApprovedImportToGcs(manifest, locator, format, bytes);
      const importResult = await this.ragCorpus({
        action: 'import',
        domainId: manifest.domain_id,
        corpusId: params.corpusId,
        gcsUri,
        dryRun: false,
      });
      return { status: 'import_requested', target_corpus_id: params.corpusId, gcs_uri: gcsUri, rag_import: importResult };
    } catch (error) {
      return {
        status: 'blocked',
        target_corpus_id: params.corpusId,
        error: error instanceof DomainExpertWorkerError
          ? { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) }
          : { code: 'rag_ingest_error', message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private annasImportGcsPrefix(manifest: ReturnType<typeof domainManifest>): string {
    const prefix = this.annas.importGcsPrefix;
    if (!prefix) throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', 'OLYMPUS_DOMAIN_EXPERT_ANNAS_IMPORT_GCS_PREFIX is required for direct RAG imports.');
    assertAllowedGcsDestination(prefix, manifest.allowed_gcs_prefixes);
    return prefix;
  }

  private async uploadApprovedImportToGcs(manifest: ReturnType<typeof domainManifest>, locator: string, format: string, bytes: Uint8Array): Promise<string> {
    const prefix = this.annasImportGcsPrefix(manifest);
    const parsed = parseGcsPrefix(prefix);
    const objectName = `${parsed.prefix}${manifest.domain_id}/${safeObjectName(locator)}-${Date.now()}.${format}`;
    const gcsUri = `gs://${parsed.bucket}/${objectName}`;
    assertAllowedGcsDestination(gcsUri, manifest.allowed_gcs_prefixes);
    await this.google.uploadGcsObject(parsed.bucket, objectName, bytes);
    return gcsUri;
  }

  private async withRagCorpusRetry<T>(
    manifest: ReturnType<typeof domainManifest>,
    resolved: ResolvedRagCorpus,
    operation: (resolved: ResolvedRagCorpus) => Promise<T>,
  ): Promise<{ value: T; resolved: ResolvedRagCorpus; warnings: RagCorpusWarning[] }> {
    try {
      return { value: await operation(resolved), resolved, warnings: [] };
    } catch (error) {
      if (!isStaleResolvedRagCorpusError(error) || !resolved.displayName) throw error;
    }

    await this.invalidateRagCorpusMapping(manifest.gcp_project, manifest.rag_location, resolved.displayName);
    const fresh = await this.resolveRagCorpus(manifest, resolved.displayName, { refresh: true });
    try {
      return { value: await operation(fresh), resolved: fresh, warnings: ragCorpusWarnings(fresh) };
    } catch (error) {
      if (isStaleResolvedRagCorpusError(error)) {
        throw ragCorpusNotFoundError(fresh.requested, manifest.gcp_project, manifest.rag_location);
      }
      throw error;
    }
  }

  private async resolveRagCorpus(
    manifest: ReturnType<typeof domainManifest>,
    requested: string,
    options: { refresh?: boolean } = {},
  ): Promise<ResolvedRagCorpus> {
    const corpus = requireString(requested, 'corpus_id');
    if (isFullRagCorpusResourceName(corpus)) {
      const resolved = {
        requested: corpus,
        corpusId: corpusIdFromResourceName(corpus),
        resourceName: corpus,
      };
      this.rememberResolvedRagCorpusProjectAliases(manifest, resolved);
      return resolved;
    }
    if (isNumericRagCorpusId(corpus)) {
      const resolved = {
        requested: corpus,
        corpusId: corpus,
        resourceName: corpusResourceNameFromParts(manifest.gcp_project, manifest.rag_location, corpus),
      };
      this.rememberResolvedRagCorpusProjectAliases(manifest, resolved);
      return resolved;
    }

    const cacheKey = ragCorpusMappingKey(manifest.gcp_project, manifest.rag_location, corpus);
    if (!options.refresh) {
      const cached = this.ragCorpusCache.get(cacheKey);
      if (cached) return cached;

      const mapping = await this.loadRagCorpusMapping();
      const mapped = mapping.corpora[cacheKey];
      if (mapped) {
        const resolved = {
          requested: corpus,
          corpusId: mapped.corpus_id,
          resourceName: mapped.resource_name,
          displayName: mapped.display_name,
          warnings: this.consumeRagCorpusMappingWarnings(),
        };
        this.rememberRagCorpusProjectAlias(manifest.gcp_project, manifest.rag_location, mapped.corpus_id, mapped.project);
        this.rememberResolvedRagCorpusProjectAliases(manifest, resolved);
        this.ragCorpusCache.set(cacheKey, resolved);
        return resolved;
      }
    }

    const listed = await this.listRagCorpora(
      manifest.gcp_project,
      manifest.rag_location,
      options.refresh ? { refresh: true } : {},
    );
    const matches = listed.filter((candidate) => candidate.displayName === corpus);
    const match = matches[0];
    if (!match?.name) {
      throw ragCorpusNotFoundError(corpus, manifest.gcp_project, manifest.rag_location);
    }
    const warnings = [
      ...this.consumeRagCorpusMappingWarnings(),
      ...duplicateRagCorpusWarnings(corpus, matches),
    ];
    const resolved = {
      requested: corpus,
      corpusId: corpusIdFromResourceName(match.name),
      resourceName: match.name,
      ...(match.displayName ? { displayName: match.displayName } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
    this.rememberResolvedRagCorpusProjectAliases(manifest, resolved);
    this.ragCorpusCache.set(cacheKey, resolved);
    await this.recordRagCorpusMapping(manifest.gcp_project, manifest.rag_location, corpus, match.name);
    return resolved;
  }

  private async listRagCorpora(project: string, location: string, options: { refresh?: boolean } = {}): Promise<Array<{ name: string; displayName?: string }>> {
    const cacheKey = `${project}/${location}`;
    const cached = this.ragCorpusListCache.get(cacheKey);
    if (cached && !options.refresh) return cached;
    const listed = await this.google.listRagCorpora({ project, location });
    this.ragCorpusListCache.set(cacheKey, listed);
    const recordedDisplayNames = new Set<string>();
    for (const corpus of listed) {
      if (!corpus.displayName || recordedDisplayNames.has(corpus.displayName)) continue;
      recordedDisplayNames.add(corpus.displayName);
      await this.recordRagCorpusMapping(project, location, corpus.displayName, corpus.name);
    }
    return listed;
  }

  private async loadRagCorpusMapping(): Promise<RagCorpusMappingFile> {
    return this.withRagCorpusMappingLock(() => this.loadRagCorpusMappingUnlocked());
  }

  private async loadRagCorpusMappingUnlocked(): Promise<RagCorpusMappingFile> {
    if (this.ragCorpusMapping) return this.ragCorpusMapping;
    const path = ragCorpusMappingPath(this.dataDir);
    const raw = await readFile(path, 'utf8').catch(() => '');
    if (!raw) {
      this.ragCorpusMapping = { version: 1, corpora: {} };
      return this.ragCorpusMapping;
    }
    let parsed: Partial<RagCorpusMappingFile>;
    try {
      parsed = JSON.parse(raw) as Partial<RagCorpusMappingFile>;
    } catch (error) {
      this.ragCorpusMappingWarnings.push({
        code: 'rag_corpus_mapping_file_unreadable',
        message: 'rag-corpus-mapping.json could not be parsed; rebuilding corpus name mappings from Vertex ragCorpora.',
        mapping_file: 'rag-corpus-mapping.json',
      });
      console.warn(`rag-corpus-mapping.json could not be parsed; rebuilding from Vertex ragCorpora. ${error instanceof Error ? error.message : String(error)}`);
      this.ragCorpusMapping = { version: 1, corpora: {} };
      return this.ragCorpusMapping;
    }
    this.ragCorpusMapping = {
      version: 1,
      corpora: parsed.corpora && typeof parsed.corpora === 'object' ? parsed.corpora : {},
    };
    return this.ragCorpusMapping;
  }

  private async recordRagCorpusMapping(project: string, location: string, displayName: string, resourceName: string): Promise<void> {
    await this.withRagCorpusMappingLock(async () => {
      const corpusId = corpusIdFromResourceName(resourceName);
      const key = ragCorpusMappingKey(project, location, displayName);
      const mapping = await this.loadRagCorpusMappingUnlocked();
      mapping.corpora[key] = {
        display_name: displayName,
        corpus_id: corpusId,
        resource_name: resourceName,
        project,
        location,
        updated_at: new Date().toISOString(),
      };
      this.rememberRagCorpusProjectAlias(project, location, corpusId, project);
      const parsedResourceName = parseRagCorpusResourceName(resourceName);
      if (parsedResourceName) {
        this.rememberRagCorpusProjectAlias(project, parsedResourceName.location, corpusId, parsedResourceName.project);
      }
      this.ragCorpusCache.set(key, {
        requested: displayName,
        corpusId,
        resourceName,
        displayName,
      });
      await mkdir(this.dataDir, { recursive: true });
      await writeJsonFileAtomically(ragCorpusMappingPath(this.dataDir), mapping);
    });
  }

  private assertRagFileBelongsToResolvedCorpus(
    manifest: ReturnType<typeof domainManifest>,
    ragFileName: string,
    resolved: ResolvedRagCorpus,
  ): void {
    const parsedCorpus = parseRagCorpusResourceName(resolved.resourceName);
    const aliasKey = parsedCorpus
      ? ragCorpusProjectAliasKey(manifest.gcp_project, parsedCorpus.location, parsedCorpus.corpusId)
      : undefined;
    const allowedProjects = new Set<string>([
      manifest.gcp_project,
      ...(parsedCorpus ? [parsedCorpus.project] : []),
      ...(aliasKey ? this.ragCorpusProjectAliases.get(aliasKey) ?? [] : []),
    ]);
    assertRagFileBelongsToCorpus(ragFileName, resolved.resourceName, { allowedProjects });
  }

  private rememberResolvedRagCorpusProjectAliases(
    manifest: Pick<ReturnType<typeof domainManifest>, 'gcp_project'>,
    resolved: ResolvedRagCorpus,
  ): void {
    const parsed = parseRagCorpusResourceName(resolved.resourceName);
    if (!parsed) return;
    this.rememberRagCorpusProjectAlias(manifest.gcp_project, parsed.location, parsed.corpusId, manifest.gcp_project);
    this.rememberRagCorpusProjectAlias(manifest.gcp_project, parsed.location, parsed.corpusId, parsed.project);
  }

  private rememberListedRagFileProjects(
    manifest: ReturnType<typeof domainManifest>,
    resolved: ResolvedRagCorpus,
    files: Array<Record<string, unknown>>,
  ): void {
    const parsedCorpus = parseRagCorpusResourceName(resolved.resourceName);
    if (!parsedCorpus) return;
    for (const file of files) {
      if (typeof file.name !== 'string') continue;
      const parsedFile = parseRagFileResourceName(file.name);
      if (!parsedFile) continue;
      if (parsedFile.location !== parsedCorpus.location || parsedFile.corpusId !== parsedCorpus.corpusId) continue;
      this.rememberRagCorpusProjectAlias(manifest.gcp_project, parsedFile.location, parsedFile.corpusId, parsedFile.project);
    }
  }

  private rememberRagCorpusProjectAlias(manifestProject: string, location: string, corpusId: string, projectAlias: string): void {
    const key = ragCorpusProjectAliasKey(manifestProject, location, corpusId);
    let aliases = this.ragCorpusProjectAliases.get(key);
    if (!aliases) {
      aliases = new Set<string>();
      this.ragCorpusProjectAliases.set(key, aliases);
    }
    aliases.add(projectAlias);
  }

  private async invalidateRagCorpusMapping(project: string, location: string, displayName: string): Promise<void> {
    await this.withRagCorpusMappingLock(async () => {
      const key = ragCorpusMappingKey(project, location, displayName);
      this.ragCorpusCache.delete(key);
      this.ragCorpusListCache.delete(`${project}/${location}`);
      const mapping = await this.loadRagCorpusMappingUnlocked();
      if (mapping.corpora[key]) {
        delete mapping.corpora[key];
        await mkdir(this.dataDir, { recursive: true });
        await writeJsonFileAtomically(ragCorpusMappingPath(this.dataDir), mapping);
      }
    });
  }

  private consumeRagCorpusMappingWarnings(): RagCorpusMappingFileWarning[] {
    if (this.ragCorpusMappingWarnings.length === 0) return [];
    const warnings = this.ragCorpusMappingWarnings;
    this.ragCorpusMappingWarnings = [];
    return warnings;
  }

  private rootFor(rootId: string): DomainExpertWorkspaceRootPolicy {
    const root = this.roots.get(rootId);
    if (!root) throw new DomainExpertWorkerError(400, 'unknown_root', 'domain workspace root is not configured.');
    return root;
  }

  private async appendRegistryJsonLine(path: string, record: Record<string, unknown>): Promise<void> {
    await this.withRegistryAppendLock(() => appendCompleteLine(path, JSON.stringify(record)));
  }

  private async withRagCorpusMappingLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.ragCorpusMappingQueue.then(operation, operation);
    this.ragCorpusMappingQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withRegistryAppendLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.registryAppendQueue.then(operation, operation);
    this.registryAppendQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface NotionImportSource {
  id: string;
  type?: 'page' | 'database';
  url?: string;
}

interface NotionObjectMetadata {
  objectId: string;
  objectType: 'page' | 'database';
  title: string;
  childBlockCount?: number;
  rowPageCount?: number;
  skippedObjectCount: number;
  warnings: string[];
}

interface NotionMarkdownDerivative {
  objectId: string;
  objectType: 'page';
  title: string;
  fileName: string;
  bytes: Uint8Array;
  sourceUrl?: string;
  parentPageId?: string;
  parentDatabaseId?: string;
  warnings: string[];
}

interface NotionDatabasePageList {
  databaseId: string;
  databaseTitle: string;
  pages: Array<{ objectId: string; title: string }>;
  skipped: number;
  warnings: string[];
}

class NotionRuntimeClient {
  private config: DomainExpertNotionConfig;

  constructor(config: DomainExpertNotionConfig) {
    this.config = config;
  }

  configured(): boolean {
    return Boolean(this.config.token?.trim());
  }

  notionVersion(): string {
    return this.config.notionVersion?.trim() || NOTION_DEFAULT_VERSION;
  }

  maxObjects(): number {
    return normalizePositiveInteger(this.config.maxObjects, NOTION_DEFAULT_MAX_OBJECTS);
  }

  async probe(): Promise<void> {
    await this.notionJson('/users/me');
  }

  async inspectObject(id: string, preferredType?: 'page' | 'database'): Promise<NotionObjectMetadata> {
    const objectId = normalizeNotionObjectId(id);
    if (preferredType === 'database') return this.inspectDatabase(objectId);
    if (preferredType === 'page') return this.inspectPage(objectId);
    try {
      return await this.inspectPage(objectId);
    } catch (error) {
      if (error instanceof DomainExpertWorkerError && error.status === 404) return this.inspectDatabase(objectId);
      throw error;
    }
  }

  async fetchPageMarkdown(input: {
    id: string;
    sourceUrl?: string;
    retrievedAt: string;
    filePrefix?: string;
  }): Promise<NotionMarkdownDerivative> {
    const objectId = normalizeNotionObjectId(input.id);
    const page = asRecord(await this.notionJson(`/pages/${objectId}`), 'notion page');
    const title = notionTitleFromObject(page) || 'Untitled Notion page';
    const warnings: string[] = [];
    const blocks = await this.fetchBlocksMarkdown(objectId, 0, warnings);
    const parent = notionParentIds(page);
    const markdown = notionMarkdownDocument({
      objectId,
      objectType: 'page',
      retrievedAt: input.retrievedAt,
      title,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(parent.parentPageId ? { parentPageId: parent.parentPageId } : {}),
      ...(parent.parentDatabaseId ? { parentDatabaseId: parent.parentDatabaseId } : {}),
      warnings,
      body: blocks.join('\n').trim(),
    });
    return {
      objectId,
      objectType: 'page',
      title,
      fileName: `${input.filePrefix ? `${safeObjectName(input.filePrefix)}/` : ''}${safeObjectName(title)}-${objectId.slice(0, 8)}.md`,
      bytes: new TextEncoder().encode(markdown),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(parent.parentPageId ? { parentPageId: parent.parentPageId } : {}),
      ...(parent.parentDatabaseId ? { parentDatabaseId: parent.parentDatabaseId } : {}),
      warnings,
    };
  }

  async listDatabasePages(databaseIdValue: string): Promise<NotionDatabasePageList> {
    const databaseId = normalizeNotionObjectId(databaseIdValue);
    const database = asRecord(await this.notionJson(`/databases/${databaseId}`), 'notion database');
    const databaseTitle = notionTitleFromObject(database) || 'Untitled Notion database';
    const pages: Array<{ objectId: string; title: string }> = [];
    const warnings: string[] = [];
    let skipped = 0;
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const response = asRecord(await this.notionJson(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      }), 'notion database query');
      const results = Array.isArray(response.results) ? response.results : [];
      for (const result of results) {
        if (pages.length >= this.maxObjects()) {
          skipped += 1;
          continue;
        }
        const row = asOptionalRecord(result);
        const id = typeof row?.id === 'string' ? normalizeNotionObjectId(row.id) : undefined;
        if (!id || !row) continue;
        pages.push({ objectId: id, title: notionTitleFromObject(row) || 'Untitled Notion page' });
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
      if (pages.length >= this.maxObjects() && cursor) {
        warnings.push('notion_database_row_count_capped');
        break;
      }
    } while (cursor);
    if (skipped > 0) warnings.push('notion_database_row_count_capped');
    return { databaseId, databaseTitle, pages, skipped, warnings: [...new Set(warnings)] };
  }

  private async inspectPage(objectId: string): Promise<NotionObjectMetadata> {
    const page = asRecord(await this.notionJson(`/pages/${objectId}`), 'notion page');
    const count = await this.countChildBlocks(objectId);
    return {
      objectId,
      objectType: 'page',
      title: notionTitleFromObject(page) || 'Untitled Notion page',
      childBlockCount: count.count,
      skippedObjectCount: count.skipped,
      warnings: count.warnings,
    };
  }

  private async inspectDatabase(objectId: string): Promise<NotionObjectMetadata> {
    const database = asRecord(await this.notionJson(`/databases/${objectId}`), 'notion database');
    const count = await this.countDatabaseRows(objectId);
    return {
      objectId,
      objectType: 'database',
      title: notionTitleFromObject(database) || 'Untitled Notion database',
      rowPageCount: count.count,
      skippedObjectCount: count.skipped,
      warnings: count.warnings,
    };
  }

  private async countChildBlocks(blockId: string): Promise<{ count: number; skipped: number; warnings: string[] }> {
    let count = 0;
    let skipped = 0;
    let cursor: string | undefined;
    const warnings: string[] = [];
    do {
      const path = `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = asRecord(await this.notionJson(path), 'notion block children');
      const results = Array.isArray(response.results) ? response.results : [];
      count += results.length;
      if (count >= this.maxObjects()) {
        skipped += results.length - Math.max(0, this.maxObjects() - (count - results.length));
        count = this.maxObjects();
        if (response.has_more === true || skipped > 0) warnings.push('notion_page_block_count_capped');
        break;
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return { count, skipped, warnings };
  }

  private async countDatabaseRows(databaseId: string): Promise<{ count: number; skipped: number; warnings: string[] }> {
    let count = 0;
    let skipped = 0;
    let cursor: string | undefined;
    const warnings: string[] = [];
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const response = asRecord(await this.notionJson(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      }), 'notion database query');
      const results = Array.isArray(response.results) ? response.results : [];
      count += results.length;
      if (count >= this.maxObjects()) {
        skipped += results.length - Math.max(0, this.maxObjects() - (count - results.length));
        count = this.maxObjects();
        if (response.has_more === true || skipped > 0) warnings.push('notion_database_row_count_capped');
        break;
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return { count, skipped, warnings };
  }

  private async fetchBlocksMarkdown(blockId: string, depth: number, warnings: string[]): Promise<string[]> {
    if (depth >= NOTION_DEFAULT_DEPTH) {
      warnings.push('notion_block_depth_cap_reached');
      return [];
    }
    const rendered: string[] = [];
    let cursor: string | undefined;
    do {
      const path = `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = asRecord(await this.notionJson(path), 'notion block children');
      const results = Array.isArray(response.results) ? response.results : [];
      for (const value of results) {
        const block = asOptionalRecord(value);
        if (!block) continue;
        const childMarkdown = block.has_children === true && block.type !== 'child_page'
          ? await this.fetchBlocksMarkdown(String(block.id ?? ''), depth + 1, warnings)
          : [];
        rendered.push(renderNotionBlock(block, childMarkdown, warnings));
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return rendered.filter((entry) => entry.trim().length > 0);
  }

  private async notionJson(path: string, init: RequestInit = {}, attempt = 0): Promise<unknown> {
    const token = this.config.token?.trim();
    if (!token) {
      throw new DomainExpertWorkerError(
        503,
        'notion_not_configured',
        'notion_import requires OLYMPUS_DOMAIN_EXPERT_NOTION_TOKEN.',
      );
    }
    const response = await (this.config.fetchImpl ?? fetch)(`${NOTION_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': this.notionVersion(),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 429 && attempt < NOTION_MAX_RETRIES) {
      await sleepMs(retryAfterMs(response.headers.get('retry-after')));
      return this.notionJson(path, init, attempt + 1);
    }
    if (!response.ok) {
      throw new DomainExpertWorkerError(
        response.status,
        'notion_api_error',
        `Notion API request failed with HTTP ${response.status}.`,
      );
    }
    return response.json();
  }
}

class GoogleRuntimeClient {
  private config: DomainExpertGoogleConfig;
  private tokenCache?: { token: string; expiresAtMs: number };

  constructor(config: DomainExpertGoogleConfig) {
    this.config = {
      ...config,
      scopes: config.scopes ?? DEFAULT_SCOPES,
    };
  }

  configured(): boolean {
    return Boolean(this.config.accessToken || this.config.serviceAccountJson || this.config.serviceAccountJsonPath);
  }

  /**
   * The tenant project has no committed default (see `DOMAIN_GCP_PROJECT_ENV`),
   * so a runtime that never configured one must not reach Vertex at all rather
   * than send a request against a malformed resource path.
   *
   * EVERY method here that accepts a project calls this, including the four
   * that address a resource by its fully-qualified name and never interpolate
   * the project into a URL. Those were the gap: a caller could resolve a
   * fully-qualified or numeric corpus id, skip the project entirely, and reach
   * the network with no tenant configured.
   */
  private requireProject(project: string): string {
    const trimmed = project.trim();
    if (!trimmed) {
      throw new DomainExpertWorkerError(
        503,
        'gcp_project_not_configured',
        'No Google Cloud project is configured for domain expert cloud work.',
        `Set ${DOMAIN_GCP_PROJECT_ENV} to the project id that owns this deployment's Vertex RAG corpora and staging buckets.`,
      );
    }
    // Configuration is validated where it is read, but this client also takes a
    // project from callers, so a placeholder must not reach a request URL here
    // either.
    if (gcpProjectIdProblem(trimmed) !== undefined) {
      throw new DomainExpertWorkerError(
        503,
        'gcp_project_not_configured',
        'The configured Google Cloud project is not a project id.',
        `Set ${DOMAIN_GCP_PROJECT_ENV} to the bare project id — not a placeholder, project number, or resource path.`,
      );
    }
    return trimmed;
  }

  model(): string {
    return this.config.model ?? 'gemini-2.5-pro';
  }

  transcribeModel(): string {
    return this.config.transcribeModel ?? this.model();
  }

  retrievalTopK(): number {
    return Math.min(100, normalizePositiveInteger(this.config.retrievalTopK, DEFAULT_DOMAIN_RETRIEVAL_TOP_K));
  }

  answerContextLimit(): number {
    return Math.min(24, normalizePositiveInteger(this.config.answerContextLimit, DEFAULT_DOMAIN_ANSWER_CONTEXT_LIMIT));
  }

  multiQueryEnabled(): boolean {
    return this.config.multiQuery ?? true;
  }

  private reranker(): DomainExpertReranker {
    return this.config.reranker ?? DEFAULT_DOMAIN_RERANKER;
  }

  private rerankerModel(reranker: DomainExpertReranker): string {
    return this.config.rerankerModel?.trim()
      || (reranker === 'llm' ? this.model() : DEFAULT_DOMAIN_RANKER_MODEL);
  }

  async createRagCorpus(options: {
    project: string;
    location: string;
    displayName: string;
    description?: string;
  }): Promise<unknown> {
    return this.googleJson(
      `${vertexBase(options.location)}/v1/projects/${this.requireProject(options.project)}/locations/${options.location}/ragCorpora`,
      {
        method: 'POST',
        body: JSON.stringify({
          displayName: options.displayName,
          ...(options.description ? { description: options.description } : {}),
        }),
      },
    );
  }

  async listRagCorpora(options: { project: string; location: string }): Promise<Array<{ name: string; displayName?: string }>> {
    const corpora: Array<{ name: string; displayName?: string }> = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${vertexBase(options.location)}/v1/projects/${this.requireProject(options.project)}/locations/${options.location}/ragCorpora`);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await this.googleJson(url.toString());
      const record = response as Record<string, any>;
      for (const corpus of record.ragCorpora ?? []) {
        if (typeof corpus?.name !== 'string') continue;
        corpora.push({
          name: corpus.name,
          ...(typeof corpus.displayName === 'string' ? { displayName: corpus.displayName } : {}),
        });
      }
      pageToken = typeof record.nextPageToken === 'string' && record.nextPageToken ? record.nextPageToken : undefined;
    } while (pageToken);
    return corpora;
  }

  async getRagCorpus(options: { project: string; location: string; corpusName: string }): Promise<unknown> {
    this.requireProject(options.project);
    return this.googleJson(`${vertexBase(options.location)}/v1/${options.corpusName}`);
  }

  async listRagFiles(options: {
    project: string;
    location: string;
    corpusName: string;
    pageToken?: string;
  }): Promise<{ files: Array<Record<string, unknown>>; nextPageToken?: string }> {
    this.requireProject(options.project);
    const url = new URL(`${vertexBase(options.location)}/v1/${options.corpusName}/ragFiles`);
    if (options.pageToken) url.searchParams.set('pageToken', options.pageToken);
    const response = await this.googleJson(url.toString());
    const record = response as Record<string, any>;
    const files = ((record.ragFiles ?? []) as Array<Record<string, any>>)
      .filter((file) => typeof file?.name === 'string')
      .map((file) => ({
        name: file.name,
        ...(typeof file.displayName === 'string' ? { displayName: file.displayName } : {}),
        ...(typeof file.createTime === 'string' ? { createTime: file.createTime } : {}),
        ...(typeof file.sourceUri === 'string' ? { sourceUri: file.sourceUri } : {}),
        ...(typeof file.fileStatus?.state === 'string' ? { state: file.fileStatus.state } : typeof file.state === 'string' ? { state: file.state } : {}),
        ...(asOptionalRecord(file.errorStatus) ? { errorStatus: file.errorStatus } : {}),
      }));
    const nextPageToken = typeof record.nextPageToken === 'string' && record.nextPageToken ? record.nextPageToken : undefined;
    return {
      files,
      ...(nextPageToken ? { nextPageToken } : {}),
    };
  }

  async deleteRagFile(options: {
    project: string;
    location: string;
    ragFileName: string;
  }): Promise<unknown> {
    this.requireProject(options.project);
    return this.googleJson(`${vertexBase(options.location)}/v1/${options.ragFileName}`, { method: 'DELETE' });
  }

  async importRagFiles(options: {
    project: string;
    location: string;
    corpusName: string;
    gcsUri?: string;
    driveFileId?: string;
    chunkTokens: number;
    chunkOverlap: number;
  }): Promise<unknown> {
    this.requireProject(options.project);
    if (!options.gcsUri && !options.driveFileId) {
      throw new DomainExpertWorkerError(400, 'invalid_rag_import', 'rag_corpus import requires gcs_uri or drive_file_id.');
    }
    const importRagFilesConfig: Record<string, unknown> = {
      ragFileParsingConfig: { layoutParser: {} },
      ragFileTransformationConfig: {
        ragFileChunkingConfig: {
          fixedLengthChunking: {
            chunkSize: options.chunkTokens,
            chunkOverlap: options.chunkOverlap,
          },
        },
      },
    };
    if (options.gcsUri) importRagFilesConfig.gcsSource = { uris: [options.gcsUri] };
    if (options.driveFileId) {
      importRagFilesConfig.googleDriveSource = {
        resourceIds: [{ resourceId: options.driveFileId, resourceType: 'RESOURCE_TYPE_FILE' }],
      };
    }
    return this.googleJson(
      `${vertexBase(options.location)}/v1/${options.corpusName}/ragFiles:import`,
      {
        method: 'POST',
        body: JSON.stringify({ importRagFilesConfig }),
      },
    );
  }

  async retrieveContexts(options: {
    project: string;
    location: string;
    corpusName: string;
    query: string;
    topK: number;
  }): Promise<Array<Record<string, unknown>>> {
    const reranker = this.reranker();
    const response = await this.googleJson(
      `${vertexBase(options.location)}/v1/projects/${this.requireProject(options.project)}/locations/${options.location}:retrieveContexts`,
      {
        method: 'POST',
        body: JSON.stringify({
          vertexRagStore: {
            ragResources: [{ ragCorpus: options.corpusName }],
          },
          query: {
            text: options.query,
            ragRetrievalConfig: {
              topK: options.topK,
              ...(reranker === 'rank-service' ? {
                ranking: { rankService: { modelName: this.rerankerModel(reranker) } },
              } : reranker === 'llm' ? {
                ranking: { llmRanker: { modelName: this.rerankerModel(reranker) } },
              } : {}),
            },
          },
        }),
      },
    );
    const contexts = ((response as Record<string, any>).contexts?.contexts ?? []) as Array<Record<string, unknown>>;
    return contexts.map(normalizeRetrievedContextSource);
  }

  async generateQueryReformulations(options: {
    project: string;
    location: string;
    model: string;
    question: string;
  }): Promise<string[]> {
    const prompt = [
      'Generate exactly two concise retrieval-query reformulations for the question below.',
      'Use likely source terminology, titles, people, and concepts when the question provides them.',
      'Keep each query focused on one topic or tradition. Do not answer the question.',
      'Return only a JSON array of two strings.',
      '',
      `Question: ${options.question}`,
    ].join('\n');
    const response = await this.googleJson(
      `${vertexBase(options.location)}/v1/projects/${this.requireProject(options.project)}/locations/${options.location}/publishers/google/models/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 160,
            responseMimeType: 'application/json',
          },
        }),
      },
    );
    const text = String((response as Record<string, any>).candidates?.[0]?.content?.parts?.[0]?.text ?? '');
    return parseQueryReformulations(text);
  }

  async generateAnswer(options: {
    project: string;
    location: string;
    model: string;
    question: string;
    contexts: Array<Record<string, unknown>>;
  }): Promise<string> {
    const contextText = options.contexts
      .slice(0, 24)
      .map((context) => [
        `[${context.citation_id}] ${context.sourceDisplayName ?? context.sourceUri ?? 'source'}`,
        String(context.text ?? '').slice(0, 4000),
      ].join('\n'))
      .join('\n\n');
    const prompt = [
      'Answer the question using only the supplied domain library context.',
      'Cite each source-backed claim with the bracketed citation id.',
      'If the context is insufficient, say what is missing.',
      '',
      `Question: ${options.question}`,
      '',
      `Context:\n${contextText}`,
    ].join('\n');
    const response = await this.googleJson(
      `${vertexBase(options.location)}/v1/projects/${this.requireProject(options.project)}/locations/${options.location}/publishers/google/models/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      },
    );
    return String((response as Record<string, any>).candidates?.[0]?.content?.parts?.[0]?.text ?? '');
  }

  async transcribeMedia(options: {
    project: string;
    location: string;
    model: string;
    gcsUri: string;
    mimeType: string;
  }): Promise<string> {
    const response = await this.googleJson(
      `${vertexBase(options.location)}/v1/projects/${this.requireProject(options.project)}/locations/${options.location}/publishers/google/models/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                text: [
                  'Transcribe this public governance media source into clean plain text.',
                  'Preserve speaker wording as faithfully as possible.',
                  'Do not summarize, analyze, add timestamps, or invent missing words.',
                  'Return only the transcript text.',
                ].join(' '),
              },
              { fileData: { fileUri: options.gcsUri, mimeType: options.mimeType } },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      },
    );
    return String((response as Record<string, any>).candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
  }

  async getDocument(documentId: string): Promise<Record<string, any>> {
    return this.googleJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?suggestionsViewMode=SUGGESTIONS_INLINE&includeTabsContent=true`) as Promise<Record<string, any>>;
  }

  async batchUpdateDocument(documentId: string, requests: Array<Record<string, unknown>>): Promise<unknown> {
    return this.googleJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  async createDriveComment(fileId: string, content: string): Promise<unknown> {
    return this.googleJson(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/comments?fields=id,createdTime,modifiedTime,htmlContent,content,author(displayName,photoLink)`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  }

  async uploadGcsObject(bucket: string, objectName: string, bytes: Uint8Array): Promise<unknown> {
    return this.googleBytes(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([copyToArrayBuffer(bytes)], { type: 'application/octet-stream' }),
    });
  }

  private async googleJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.authedFetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = await responseTextOrJson(response);
    if (!response.ok) throw googleError(response, body);
    return body;
  }

  private async googleBytes(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.authedFetch(url, init);
    const body = await responseTextOrJson(response);
    if (!response.ok) throw googleError(response, body);
    return body;
  }

  private async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    return (this.config.fetchImpl ?? fetch)(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  }

  private async accessToken(): Promise<string> {
    if (this.config.accessToken) return this.config.accessToken;
    if (this.tokenCache && this.tokenCache.expiresAtMs > Date.now() + 60_000) return this.tokenCache.token;
    const credential = await this.serviceAccountCredential();
    // No `subject`: this lane acts as the service account itself, so the
    // assertion carries no `sub` and mints no domain-wide-delegation token.
    const assertion = signGoogleServiceAccountJwt({
      credential,
      scopes: this.config.scopes ?? DEFAULT_SCOPES,
    });
    const response = await (this.config.fetchImpl ?? fetch)(googleServiceAccountTokenUrl(credential), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: GOOGLE_JWT_BEARER_GRANT_TYPE,
        assertion,
      }),
    });
    const body = await responseTextOrJson(response);
    if (!response.ok) throw googleError(response, body);
    const token = requireString((body as Record<string, unknown>).access_token, 'access_token');
    const expiresIn = Number((body as Record<string, unknown>).expires_in ?? 3600);
    this.tokenCache = { token, expiresAtMs: Date.now() + Math.max(300, expiresIn - 60) * 1000 };
    return token;
  }

  private async serviceAccountCredential(): Promise<GoogleServiceAccountKey> {
    const raw = this.config.serviceAccountJson
      ?? (this.config.serviceAccountJsonPath ? await readFile(this.config.serviceAccountJsonPath, 'utf8') : undefined);
    if (!raw) {
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', 'Google service account JSON or access token is not configured.');
    }
    try {
      return parseGoogleServiceAccountKey(raw);
    } catch (error) {
      // The shared parser's messages are already credential-free; re-clothing
      // them as a worker error keeps this lane's 503 contract intact.
      throw new DomainExpertWorkerError(
        503,
        'google_auth_not_configured',
        error instanceof Error ? error.message : 'Google service account JSON is not usable.',
      );
    }
  }
}

export function createDomainExpertWorker(options: DomainExpertWorkerOptions = {}): { fetch(request: Request): Promise<Response> } {
  const service = new DomainExpertService(options);
  const basePath = normalizeBasePath(options.basePath ?? '/v1');
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === `${basePath}/health`) {
          return json(service.health());
        }
        if (request.method === 'POST' && url.pathname === `${basePath}/domain`) {
          if (!options.enabled || !options.liveToolsEnabled) {
            throw new DomainExpertWorkerError(
              503,
              'domain_expert_not_configured',
              'Domain expert dispatch requires both domainExpert.enabled and domainExpert.liveToolsEnabled.',
            );
          }
          return json(await service.run(await parseDomainExpertRequest(request)));
        }
        return json({ error: { code: 'not_found', message: 'Domain expert route not found.' }, policy: domainPolicy() }, 404);
      } catch (error) {
        if (error instanceof DomainExpertWorkerError) {
          return json({
            error: {
              code: error.code,
              message: error.message,
              ...(error.suggestion ? { suggestion: error.suggestion } : {}),
            },
            policy: domainPolicy(),
          }, error.status);
        }
        if (error instanceof OperationError) {
          return json({
            error: {
              code: error.code,
              message: error.message,
              ...(error.suggestion ? { suggestion: error.suggestion } : {}),
            },
            policy: domainPolicy(),
          }, operationErrorStatus(error));
        }
        throw error;
      }
    },
  };
}

function operationErrorStatus(error: OperationError): number {
  if (error.code === 'domain_expert_policy_violation') return 403;
  if (error.code === 'invalid_params') return 400;
  return 500;
}

async function readDomainSourceRegistry(path: string): Promise<DomainSourceRegistryRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { records: [], totalRecords: 0, malformedLines: 0, missing: true };
    }
    throw error;
  }
  const records: DomainSourceRegistryRecord[] = [];
  let totalRecords = 0;
  let malformedLines = 0;
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformedLines += 1;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const sourceId = stringRecordField(record, 'source_id', 'sourceId');
    if (!sourceId) {
      malformedLines += 1;
      continue;
    }
    totalRecords += 1;
    const registeredAt = stringRecordField(record, 'registered_at', 'registeredAt');
    records.push({
      record,
      sourceId,
      ...(registeredAt ? { registeredAt } : {}),
      fileOrder: index,
      removed: record.removed === true || stringRecordField(record, 'ingest_status', 'ingestStatus') === 'removed',
    });
  }
  return { records, totalRecords, malformedLines, missing: false };
}

function groupDomainSourceRecords(records: DomainSourceRegistryRecord[]): Map<string, DomainSourceRegistryRecord[]> {
  const grouped = new Map<string, DomainSourceRegistryRecord[]>();
  for (const record of records) {
    const existing = grouped.get(record.sourceId);
    if (existing) {
      existing.push(record);
    } else {
      grouped.set(record.sourceId, [record]);
    }
  }
  for (const history of grouped.values()) history.sort(compareDomainSourceRecords);
  return grouped;
}

function latestDomainSourceRecord(records: DomainSourceRegistryRecord[]): DomainSourceRegistryRecord {
  return records.reduce((latest, candidate) => compareDomainSourceRecords(latest, candidate) <= 0 ? candidate : latest);
}

function compareDomainSourceRecords(left: DomainSourceRegistryRecord, right: DomainSourceRegistryRecord): number {
  const leftTime = timestampOrUndefined(left.registeredAt);
  const rightTime = timestampOrUndefined(right.registeredAt);
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime !== undefined && rightTime === undefined) return 1;
  if (leftTime === undefined && rightTime !== undefined) return -1;
  return left.fileOrder - right.fileOrder;
}

function timestampOrUndefined(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function stringRecordField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function domainExpertRootsFromEnv(env: Record<string, string | undefined> = process.env): DomainExpertWorkspaceRootPolicy[] {
  const raw = env.OLYMPUS_DOMAIN_EXPERT_ROOTS_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed.map((value) => asRecord(value, 'root'))
    : Object.entries(asRecord(parsed, 'OLYMPUS_DOMAIN_EXPERT_ROOTS_JSON')).map(([rootId, value]) => ({
      root_id: rootId,
      ...asRecord(value, `root ${rootId}`),
    }));
  return entries.map(rootFromRecord);
}

export function domainExpertGoogleConfigFromEnv(env: Record<string, string | undefined> = process.env): DomainExpertGoogleConfig {
  return {
    ...(env.OLYMPUS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN ? { accessToken: env.OLYMPUS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON ? { serviceAccountJson: env.OLYMPUS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE ? { serviceAccountJsonPath: env.OLYMPUS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_GENERATE_MODEL ? { model: env.OLYMPUS_DOMAIN_EXPERT_GENERATE_MODEL } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_TRANSCRIBE_MODEL ? { transcribeModel: env.OLYMPUS_DOMAIN_EXPERT_TRANSCRIBE_MODEL } : {}),
    retrievalTopK: env.OLYMPUS_DOMAIN_EXPERT_RETRIEVAL_TOP_K
      ? normalizePositiveInteger(env.OLYMPUS_DOMAIN_EXPERT_RETRIEVAL_TOP_K, DEFAULT_DOMAIN_RETRIEVAL_TOP_K)
      : DEFAULT_DOMAIN_RETRIEVAL_TOP_K,
    answerContextLimit: env.OLYMPUS_DOMAIN_EXPERT_ANSWER_CONTEXT_LIMIT
      ? normalizePositiveInteger(env.OLYMPUS_DOMAIN_EXPERT_ANSWER_CONTEXT_LIMIT, DEFAULT_DOMAIN_ANSWER_CONTEXT_LIMIT)
      : DEFAULT_DOMAIN_ANSWER_CONTEXT_LIMIT,
    reranker: domainExpertRerankerFromEnv(env.OLYMPUS_DOMAIN_EXPERT_RERANKER),
    ...(env.OLYMPUS_DOMAIN_EXPERT_RERANKER_MODEL ? { rerankerModel: env.OLYMPUS_DOMAIN_EXPERT_RERANKER_MODEL } : {}),
    multiQuery: booleanEnvWithDefault(env.OLYMPUS_DOMAIN_EXPERT_MULTI_QUERY, true, 'OLYMPUS_DOMAIN_EXPERT_MULTI_QUERY'),
  };
}

export function domainExpertAnnasConfigFromEnv(env: Record<string, string | undefined> = process.env): DomainExpertAnnasConfig {
  return {
    ...(env.OLYMPUS_DOMAIN_EXPERT_ANNAS_ARCHIVE_API_KEY ? { apiKey: env.OLYMPUS_DOMAIN_EXPERT_ANNAS_ARCHIVE_API_KEY } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_ANNAS_ARCHIVE_BASE_URL ? { baseUrl: trimTrailingSlash(env.OLYMPUS_DOMAIN_EXPERT_ANNAS_ARCHIVE_BASE_URL) } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_ANNAS_SEARCH_URL_TEMPLATE ? { searchUrlTemplate: env.OLYMPUS_DOMAIN_EXPERT_ANNAS_SEARCH_URL_TEMPLATE } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_ANNAS_DOWNLOAD_URL_TEMPLATE ? { downloadUrlTemplate: env.OLYMPUS_DOMAIN_EXPERT_ANNAS_DOWNLOAD_URL_TEMPLATE } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_ANNAS_IMPORT_GCS_PREFIX ? { importGcsPrefix: env.OLYMPUS_DOMAIN_EXPERT_ANNAS_IMPORT_GCS_PREFIX } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_ANNAS_MAX_DOWNLOAD_BYTES
      ? { maxDownloadBytes: normalizePositiveInteger(env.OLYMPUS_DOMAIN_EXPERT_ANNAS_MAX_DOWNLOAD_BYTES, DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES) }
      : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_ANNAS_BOOKS_ROOT ? { booksRoot: env.OLYMPUS_DOMAIN_EXPERT_ANNAS_BOOKS_ROOT } : {}),
  };
}

export function domainExpertWorkerFlagsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Pick<DomainExpertWorkerOptions, 'enabled' | 'liveToolsEnabled'> {
  return {
    enabled: booleanEnvWithDefault(
      env.OLYMPUS_DOMAIN_EXPERT_ENABLED,
      false,
      'OLYMPUS_DOMAIN_EXPERT_ENABLED',
    ),
    liveToolsEnabled: booleanEnvWithDefault(
      env.OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED,
      false,
      'OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED',
    ),
  };
}

export function domainExpertNotionConfigFromEnv(env: Record<string, string | undefined> = process.env): DomainExpertNotionConfig {
  return {
    ...(env.OLYMPUS_DOMAIN_EXPERT_NOTION_TOKEN ? { token: env.OLYMPUS_DOMAIN_EXPERT_NOTION_TOKEN } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_NOTION_VERSION ? { notionVersion: env.OLYMPUS_DOMAIN_EXPERT_NOTION_VERSION } : {}),
    ...(env.OLYMPUS_DOMAIN_EXPERT_NOTION_MAX_OBJECTS ? { maxObjects: normalizePositiveInteger(env.OLYMPUS_DOMAIN_EXPERT_NOTION_MAX_OBJECTS, NOTION_DEFAULT_MAX_OBJECTS) } : {}),
  };
}

function parseDomainExpertRequest(request: Request): Promise<DomainExpertRequest> {
  return request.json().then((value) => {
    const record = asRecord(value, 'body');
    return {
      tool: asDomainExpertTool(record.tool),
      params: asRecord(record.params ?? {}, 'params'),
    };
  });
}

function parseDomainAgentParams(params: Record<string, unknown>): DomainAgentParams {
  return {
    action: parseDomainAgentAction(params.action),
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.display_name, 'displayName'),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
  };
}

function parseDomainAskParams(params: Record<string, unknown>): { domainId?: string; question: string; corpusId?: string; corpora?: string[]; maxResults?: number } {
  return {
    ...optionalStringField(params.domain_id, 'domainId'),
    question: requireString(params.question, 'question'),
    ...optionalStringField(params.corpus_id, 'corpusId'),
    ...(params.corpora !== undefined ? { corpora: asStringArray(params.corpora, 'corpora') } : {}),
    ...optionalNumberField(params.max_results, 'maxResults'),
  };
}

function parseDomainSourceParams(params: Record<string, unknown>): DomainSourceParams {
  const action = parseDomainSourceAction(params.action);
  if (!DOMAIN_SOURCE_ACTIONS.includes(action)) throw new DomainExpertWorkerError(400, 'invalid_action', 'Invalid domain_source action.');
  return {
    action,
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.source_id, 'sourceId'),
    ...optionalSourceKind(params.kind),
    ...optionalStringField(params.title, 'title'),
    ...optionalStringField(params.author, 'author'),
    ...optionalStringField(params.url, 'url'),
    ...optionalStringField(params.relative_path, 'relativePath'),
    ...optionalStringField(params.corpus_id, 'corpusId'),
    ...optionalStringField(params.trust_posture, 'trustPosture'),
    ...optionalStringField(params.copyright_posture, 'copyrightPosture'),
    ...optionalBooleanField(params.include_history, 'includeHistory'),
    ...optionalBooleanField(params.include_removed, 'includeRemoved'),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
  };
}

function parseRagCorpusParams(params: Record<string, unknown>): RagCorpusParams {
  const action = parseRagCorpusAction(params.action);
  if (!RAG_CORPUS_ACTIONS.includes(action)) throw new DomainExpertWorkerError(400, 'invalid_action', 'Invalid rag_corpus action.');
  if (action === 'stage_import' && (typeof params.workspace_relative_path !== 'string' || params.workspace_relative_path.trim().length === 0)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus stage_import requires workspace_relative_path.');
  }
  if (action === 'web_import' && params.urls === undefined) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus web_import requires urls.');
  }
  if (action === 'notion_import' && params.urls === undefined && params.page_ids === undefined && params.database_ids === undefined) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus notion_import requires urls, page_ids, or database_ids.');
  }
  if (action === 'delete_file' && (typeof params.rag_file_name !== 'string' || params.rag_file_name.trim().length === 0)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus delete_file requires rag_file_name.');
  }
  return {
    action,
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.corpus_id, 'corpusId'),
    ...optionalStringField(params.rag_file_name, 'ragFileName'),
    ...optionalStringField(params.page_token, 'pageToken'),
    ...optionalStringField(params.source_id, 'sourceId'),
    ...optionalStringField(params.gcs_uri, 'gcsUri'),
    ...optionalStringField(params.drive_file_id, 'driveFileId'),
    ...optionalStringField(params.workspace_relative_path, 'workspaceRelativePath'),
    ...optionalStringField(params.batch_id, 'batchId'),
    ...(params.urls !== undefined ? { urls: asStringArray(params.urls, 'urls') } : {}),
    ...(params.page_ids !== undefined ? { pageIds: asStringArray(params.page_ids, 'page_ids') } : {}),
    ...(params.database_ids !== undefined ? { databaseIds: asStringArray(params.database_ids, 'database_ids') } : {}),
    ...optionalBooleanField(params.include_media, 'includeMedia'),
    ...optionalTranscriptModeField(params.transcript_mode),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
  };
}

function parseDomainDocParams(params: Record<string, unknown>): DomainDocParams {
  const action = parseDomainDocAction(params.action);
  if (!DOMAIN_DOC_ACTIONS.includes(action)) throw new DomainExpertWorkerError(400, 'invalid_action', 'Invalid domain_doc action.');
  return {
    action,
    ...optionalStringField(params.domain_id, 'domainId'),
    documentId: requireString(params.document_id, 'document_id'),
    ...optionalStringField(params.text, 'text'),
    ...optionalStringField(params.comment, 'comment'),
    ...optionalNumberField(params.range_start, 'rangeStart'),
    ...optionalNumberField(params.range_end, 'rangeEnd'),
    ...optionalStringField(params.approval_id, 'approvalId'),
    ...optionalStringField(params.edit_batch_id, 'editBatchId'),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
  };
}

function parseAnnasArchiveSearchParams(params: Record<string, unknown>): AnnasArchiveSearchParams {
  return {
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.query, 'query'),
    ...optionalStringField(params.topic, 'topic'),
    ...optionalStringField(params.title, 'title'),
    ...optionalStringField(params.author, 'author'),
    ...optionalStringField(params.language, 'language'),
    ...optionalNumberField(params.max_results, 'maxResults'),
    ...optionalNumberField(params.top_n, 'topN'),
    ...optionalAnnasFormatPreference(params.format_preference),
  };
}

function parseAnnasArchiveImportParams(params: Record<string, unknown>): AnnasArchiveImportParams {
  return {
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.annas_archive_id, 'annasArchiveId'),
    ...optionalStringField(params.url, 'url'),
    ...optionalAnnasFormat(params.format),
    ...optionalStringField(params.corpus_id, 'corpusId'),
    ...optionalStringField(params.title, 'title'),
    ...optionalStringField(params.author, 'author'),
    ...optionalStringField(params.year, 'year'),
    ...optionalStringField(params.topic, 'topic'),
    ...optionalStringField(params.language, 'language'),
    ...optionalStringField(params.file_name, 'fileName'),
    ...optionalStringField(params.md5, 'md5'),
    ...optionalNumberField(params.file_size_bytes, 'fileSizeBytes'),
    ...optionalBooleanField(params.ingest, 'ingest'),
    copyrightPosture: requireString(params.copyright_posture, 'copyright_posture'),
    ...optionalStringField(params.approval_id, 'approvalId'),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
  };
}

async function writeWorkspaceSeedFiles(
  root: DomainExpertWorkspaceRootPolicy,
  rootPath: string,
  manifest: ReturnType<typeof domainManifest>,
): Promise<Array<Record<string, unknown>>> {
  const rootRel = manifest.workspace_relative_path;
  const files: Array<[string, string]> = [
    [`${rootRel}/PROPOSAL.md`, proposalContent(manifest)],
    [`${rootRel}/domain.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`],
    [`${rootRel}/references/source-registry.jsonl`, ''],
    [`${rootRel}/references/ingest-log.md`, `# Ingest Log\n\nCreated ${new Date().toISOString()}.\n`],
    [`${rootRel}/references/reading-map.md`, `# ${manifest.display_name} Reading Map\n`],
    [`${rootRel}/references/retrieval-craft.md`, retrievalCraftContent()],
    [`${rootRel}/templates/source-card.md`, '# Source Card\n\n- Title:\n- Author:\n- Corpus:\n- Status:\n- Notes:\n'],
    [`${rootRel}/templates/research-brief.md`, '# Research Brief\n\n## Question\n\n## Evidence\n\n## Answer\n\n## Gaps\n'],
    [`${rootRel}/templates/literature-review.md`, '# Literature Review\n\n## Sources\n\n## Themes\n\n## Disagreements\n'],
    [`${rootRel}/templates/disagreement-map.md`, '# Disagreement Map\n\n## Claims\n\n## Tradeoffs\n\n## Open Questions\n'],
    [`${rootRel}/eval/questions.jsonl`, `${JSON.stringify({
      id: `${manifest.domain_id}-example-1`,
      question: `What are the central open questions in the ${manifest.display_name} library?`,
      expected_sources: [],
      tags: ['example'],
      notes: 'Example format: id, question, expected_sources, tags, notes. Replace or extend this row; every persistent retrieval miss becomes an eval case.',
    })}\n`],
  ];
  const results = [];
  for (const [relativePath, content] of files) {
    const target = resolveInside(rootPath, relativePath);
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > root.maxWriteBytes) {
      throw new DomainExpertWorkerError(413, 'content_too_large', `${relativePath} exceeds the root write limit.`);
    }
    await mkdir(dirname(target), { recursive: true });
    const existed = await exists(target);
    if (!existed) {
      const file = await open(target, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
    } else if (root.allowOverwrite) {
      await writeFile(target, bytes, { mode: 0o600 });
    }
    results.push({
      relative_path: relativePath,
      status: existed ? (root.allowOverwrite ? 'overwritten' : 'skipped_existing') : 'created',
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return results;
}

function retrievalCraftContent(): string {
  return [
    '# Retrieval Craft',
    '',
    'Use these practices when you call `domain_ask`:',
    '',
    '- Name the source, author, or text when you know it.',
    '- Keep each query to one tradition or topic.',
    '- Decompose broad questions into focused retrieval questions, then synthesize across the grounded answers.',
    "- When results are weak, re-ask using the source text's own vocabulary.",
    '- Never cite or imply support from a source that retrieval did not return.',
    '- When a source you expect keeps missing, tell your owner. Retrieval misses become eval cases: record the miss in `eval/questions.jsonl` so it cannot silently regress.',
    '',
  ].join('\n');
}

function proposalContent(manifest: ReturnType<typeof domainManifest>): string {
  return [
    `# ${manifest.display_name}`,
    '',
    '## Core Role',
    '',
    `You are the ${manifest.display_name}. Answer from the curated ${manifest.domain_id} library, cite source-backed claims, and name gaps plainly.`,
    '',
    '## Source Hierarchy',
    '',
    '- Owner-authored docs and approved working notes',
    '- Canonical books, PDFs, papers, and source texts',
    '- Public web essays and blog posts',
    '',
    '## Workflow',
    '',
    'Use domain_source for intake, rag_corpus for corpus lifecycle, domain_ask for grounded answers, and domain_doc for Google Docs collaboration.',
    '',
  ].join('\n');
}

async function checkedRootPath(root: DomainExpertWorkspaceRootPolicy): Promise<string> {
  const rootPath = resolve(root.path);
  const info = await stat(rootPath).catch(() => undefined);
  if (!info?.isDirectory()) throw new DomainExpertWorkerError(400, 'root_not_directory', 'Configured domain workspace root is not a directory.');
  return rootPath;
}

function resolveInside(rootPath: string, relativePath: string): string {
  if (relativePath.startsWith('/') || relativePath.includes('\0')) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', 'Use relative paths inside the domain workspace root.');
  }
  const target = resolve(rootPath, relativePath);
  if (!(target === rootPath || target.startsWith(`${rootPath}${sep}`))) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', 'relative_path escapes the domain workspace root.');
  }
  return target;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function audit(root: DomainExpertWorkspaceRootPolicy, record: Record<string, unknown>): Promise<void> {
  if (!root.auditPath) return;
  await mkdir(dirname(root.auditPath), { recursive: true });
  await appendFile(root.auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function documentReadResult(domainId: string, doc: Record<string, any>): Record<string, unknown> {
  const text = extractDocumentText(doc);
  return {
    kind: 'domain_doc_read',
    domain_id: domainId,
    document_id: doc.documentId,
    title: doc.title,
    revision_id: doc.revisionId,
    text,
    text_chars: text.length,
    suggestions_view_mode: doc.suggestionsViewMode,
    policy: domainPolicy(),
  };
}

function extractDocumentText(doc: Record<string, any>): string {
  const pieces: string[] = [];
  const content = doc.body?.content ?? doc.tabs?.[0]?.documentTab?.body?.content ?? [];
  for (const element of content) {
    for (const paragraphElement of element.paragraph?.elements ?? []) {
      const text = paragraphElement.textRun?.content;
      if (typeof text === 'string') pieces.push(text);
    }
  }
  return pieces.join('');
}

function extractDocumentTextRange(doc: Record<string, any>, start: number, end: number): string {
  const pieces: string[] = [];
  const content = doc.body?.content ?? doc.tabs?.[0]?.documentTab?.body?.content ?? [];
  for (const element of content) {
    for (const paragraphElement of element.paragraph?.elements ?? []) {
      const text = paragraphElement.textRun?.content;
      const startIndex = paragraphElement.startIndex;
      const endIndex = paragraphElement.endIndex;
      if (typeof text !== 'string' || typeof startIndex !== 'number' || typeof endIndex !== 'number') continue;
      const sliceStart = Math.max(start, startIndex) - startIndex;
      const sliceEnd = Math.min(end, endIndex) - startIndex;
      if (sliceEnd > sliceStart) pieces.push(text.slice(sliceStart, sliceEnd));
    }
  }
  return pieces.join('');
}

function documentEndIndex(doc: Record<string, any>): number {
  const content = doc.body?.content ?? doc.tabs?.[0]?.documentTab?.body?.content ?? [];
  const endIndexes = content.map((item: Record<string, unknown>) => typeof item.endIndex === 'number' ? item.endIndex : 1);
  return Math.max(1, ...endIndexes) - 1;
}

function styleFromManifest(manifest: ReturnType<typeof domainManifest>): Record<string, unknown> {
  return {
    foregroundColor: { color: { rgbColor: manifest.visual_review_style.foreground_color } },
    backgroundColor: { color: { rgbColor: manifest.visual_review_style.background_color } },
  };
}

async function appendLedger(dataDir: string, record: VisualEditLedgerRecord): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await appendFile(join(dataDir, 'domain-doc-edits.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

async function findLedgerRecord(dataDir: string, editBatchId: string): Promise<VisualEditLedgerRecord | undefined> {
  const path = join(dataDir, 'domain-doc-edits.jsonl');
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VisualEditLedgerRecord)
    .reverse()
    .find((record) => record.edit_batch_id === editBatchId);
}

function corpusResourceNameFromParts(project: string, location: string, corpusId: string): string {
  return `projects/${project}/locations/${location}/ragCorpora/${corpusId}`;
}

function isNumericRagCorpusId(value: string): boolean {
  return /^\d+$/.test(value);
}

function isFullRagCorpusResourceName(value: string): boolean {
  return parseRagCorpusResourceName(value) !== undefined;
}

function parseRagCorpusResourceName(value: string): ParsedRagCorpusResourceName | undefined {
  const match = /^projects\/([^/]+)\/locations\/([^/]+)\/ragCorpora\/(\d+)$/.exec(value);
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    corpusId: match[3]!,
  };
}

function parseRagFileResourceName(value: string): ParsedRagFileResourceName | undefined {
  const match = /^projects\/([^/]+)\/locations\/([^/]+)\/ragCorpora\/(\d+)\/ragFiles\/([^/]+)$/.exec(value);
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    corpusId: match[3]!,
    fileId: match[4]!,
  };
}

function assertRagFileBelongsToCorpus(
  ragFileName: string,
  corpusName: string,
  options: { allowedProjects?: Iterable<string> } = {},
): void {
  const parsedFile = parseRagFileResourceName(ragFileName);
  if (!parsedFile) {
    throw new DomainExpertWorkerError(
      400,
      'invalid_rag_file_resource',
      'rag_file_name must be a full Vertex ragFiles resource name.',
    );
  }
  const parsedCorpus = parseRagCorpusResourceName(corpusName);
  if (!parsedCorpus) {
    throw new DomainExpertWorkerError(500, 'invalid_rag_corpus_resource', 'Google returned an invalid RAG corpus resource name.');
  }
  const allowedProjects = new Set([parsedCorpus.project, ...(options.allowedProjects ?? [])]);
  if (
    parsedFile.location !== parsedCorpus.location
    || parsedFile.corpusId !== parsedCorpus.corpusId
    || !allowedProjects.has(parsedFile.project)
  ) {
    throw new DomainExpertWorkerError(
      403,
      'rag_file_foreign_corpus',
      'rag_file_name must belong to the resolved RAG corpus.',
    );
  }
}

function corpusIdFromResourceName(resourceName: string): string {
  const parsed = parseRagCorpusResourceName(resourceName);
  if (!parsed) {
    throw new DomainExpertWorkerError(500, 'invalid_rag_corpus_resource', 'Google returned an invalid RAG corpus resource name.');
  }
  return parsed.corpusId;
}

function ragCorpusMappingKey(project: string, location: string, displayName: string): string {
  return `${project}/${location}/${displayName}`;
}

function ragCorpusProjectAliasKey(manifestProject: string, location: string, corpusId: string): string {
  return `${manifestProject}/${location}/${corpusId}`;
}

function ragCorpusMappingPath(dataDir: string): string {
  return join(dataDir, 'rag-corpus-mapping.json');
}

function ragCorpusWarning(corpusId: string, error: DomainExpertWorkerError): RagCorpusNotFoundWarning {
  return {
    corpus_id: corpusId,
    code: 'rag_corpus_not_found',
    message: error.message,
    suggestion: error.suggestion ?? `Run rag_corpus create with corpus_id "${corpusId}" before asking.`,
  };
}

function ragCorpusWarnings(resolved: ResolvedRagCorpus): RagCorpusWarning[] {
  return resolved.warnings ?? [];
}

function duplicateRagCorpusWarnings(
  displayName: string,
  matches: Array<{ name: string; displayName?: string }>,
): RagCorpusDuplicateDisplayNameWarning[] {
  if (matches.length <= 1) return [];
  const duplicateResourceNames = matches.map((match) => match.name);
  return [{
    corpus_id: displayName,
    code: 'rag_corpus_duplicate_display_name',
    display_name: displayName,
    selected_resource_name: matches[0]!.name,
    duplicate_resource_names: duplicateResourceNames,
    selection_order: 'Vertex ragCorpora list order; Olympus selects the first matching displayName returned by the API.',
    message: `Multiple Vertex RAG corpora use displayName "${displayName}"; selected the first corpus returned by ragCorpora list.`,
  }];
}

function ragCorpusNotFoundError(corpus: string, project: string, location: string): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    404,
    'rag_corpus_not_found',
    `Could not resolve RAG corpus "${corpus}" in ${project}/${location}.`,
    `Run rag_corpus create with corpus_id "${corpus}" before asking, importing, or checking status.`,
  );
}

function isStaleResolvedRagCorpusError(error: unknown): boolean {
  if (!(error instanceof DomainExpertWorkerError)) return false;
  if (error.status !== 404) return false;
  const message = error.message.toUpperCase();
  return error.code === 'google_api_error' && (message.includes('NOT_FOUND') || message.includes('"STATUS":"NOT_FOUND"') || message.includes('"CODE":404'));
}

async function writeJsonFileAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function appendCompleteLine(path: string, line: string): Promise<void> {
  const handle = await open(path, 'a');
  try {
    await handle.write(line.endsWith('\n') ? line : `${line}\n`);
  } finally {
    await handle.close();
  }
}

async function planStageImportFiles(
  rootPath: string,
  targetPath: string,
  destinationBucket: string,
  destinationObjectPrefix: string,
  options: { includeMedia?: boolean } = {},
): Promise<{ eligible: StageImportEligibleFile[]; skipped: StageImportSkippedFile[]; totalBytes: number }> {
  const files = await collectStageImportFiles(rootPath, targetPath);
  const eligible: StageImportEligibleFile[] = [];
  const skipped: StageImportSkippedFile[] = [];
  let totalBytes = 0;
  const allowedExtensions = allowedStageImportExtensions(options.includeMedia ?? false);
  for (const file of files) {
    const extension = extname(file.workspaceRelativePath).toLowerCase();
    if (isJunkStageImportPath(file.workspaceRelativePath)) {
      skipped.push({
        workspace_relative_path: file.workspaceRelativePath,
        reason: 'junk_file',
        bytes: file.bytes,
      });
      continue;
    }
    if (!allowedExtensions.has(extension)) {
      skipped.push({
        workspace_relative_path: file.workspaceRelativePath,
        reason: `extension_not_allowed:${extension || '<none>'}`,
        bytes: file.bytes,
      });
      continue;
    }
    const maxFileBytes = maxStageFileBytes(file.workspaceRelativePath);
    if (file.bytes > maxFileBytes) {
      skipped.push({
        workspace_relative_path: file.workspaceRelativePath,
        reason: 'file_size_limit_exceeded',
        bytes: file.bytes,
      });
      continue;
    }
    const countsAgainstTextBatchCap = !isTranscribableMediaPath(file.workspaceRelativePath);
    if (countsAgainstTextBatchCap && totalBytes + file.bytes > STAGE_IMPORT_MAX_BATCH_BYTES) {
      skipped.push({
        workspace_relative_path: file.workspaceRelativePath,
        reason: 'batch_size_limit_exceeded',
        bytes: file.bytes,
      });
      continue;
    }
    if (countsAgainstTextBatchCap) totalBytes += file.bytes;
    const uploadRelativePath = safeGcsRelativePath(file.uploadRelativePath);
    const objectName = `${destinationObjectPrefix}${uploadRelativePath}`;
    eligible.push({
      workspaceRelativePath: file.workspaceRelativePath,
      uploadRelativePath,
      absolutePath: file.absolutePath,
      bytes: file.bytes,
      objectName,
      gcsUri: `gs://${destinationBucket}/${objectName}`,
    });
  }
  return { eligible, skipped, totalBytes };
}

function allowedStageImportExtensions(includeMedia: boolean): Set<string> {
  return includeMedia
    ? new Set([...STAGE_IMPORT_ALLOWED_EXTENSIONS, ...STAGE_IMPORT_MEDIA_EXTENSIONS])
    : new Set(STAGE_IMPORT_ALLOWED_EXTENSIONS);
}

function maxStageFileBytes(path: string): number {
  return isTranscribableMediaPath(path) ? MEDIA_TRANSCRIBE_MAX_BYTES : STAGE_IMPORT_MAX_FILE_BYTES;
}

function isTranscribableMediaPath(path: string): boolean {
  return STAGE_IMPORT_TRANSCRIBABLE_MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

function isJunkStageImportPath(workspaceRelativePath: string): boolean {
  return workspaceRelativePath.split('/').some((segment) => (
    segment === '.DS_Store'
    || segment.startsWith('._')
    || (segment.startsWith('.') && segment.length > 1)
  ));
}

async function collectStageImportFiles(
  rootPath: string,
  targetPath: string,
): Promise<Array<{
  workspaceRelativePath: string;
  uploadRelativePath: string;
  absolutePath: string;
  bytes: number;
}>> {
  const targetInfo = await stat(targetPath).catch(() => undefined);
  if (!targetInfo) throw new DomainExpertWorkerError(404, 'workspace_path_not_found', 'workspace_relative_path does not exist.');
  const rootRealPath = await realpath(rootPath);
  const targetRealPath = await realpath(targetPath);
  const targetIsDirectory = targetInfo.isDirectory();
  const paths = targetIsDirectory
    ? await collectFilesRecursively(rootRealPath, targetRealPath)
    : [targetRealPath];
  const files = [];
  for (const absolutePath of paths) {
    await assertRealPathInside(rootRealPath, absolutePath, 'workspace_relative_path escapes the domain workspace root.');
    const info = await stat(absolutePath);
    if (!info.isFile()) continue;
    const workspaceRelativePath = toPortableRelativePath(rootRealPath, absolutePath);
    const uploadRelativePath = targetIsDirectory
      ? toPortableRelativePath(targetRealPath, absolutePath)
      : basename(absolutePath);
    files.push({
      workspaceRelativePath,
      uploadRelativePath,
      absolutePath,
      bytes: info.size,
    });
  }
  return files.sort((left, right) => left.workspaceRelativePath.localeCompare(right.workspaceRelativePath));
}

async function collectFilesRecursively(rootRealPath: string, directoryPath: string): Promise<string[]> {
  await assertRealPathInside(rootRealPath, directoryPath, 'workspace_relative_path escapes the domain workspace root.');
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(directoryPath, entry.name);
    const info = await stat(absolutePath);
    if (info.isDirectory()) {
      files.push(...await collectFilesRecursively(rootRealPath, await realpath(absolutePath)));
    } else if (info.isFile()) {
      files.push(await realpath(absolutePath));
    }
  }
  return files.sort();
}

async function assertRealPathInside(rootPath: string, targetPath: string, message: string): Promise<void> {
  const rootRealPath = await realpath(rootPath);
  const targetRealPath = await realpath(targetPath);
  if (!(targetRealPath === rootRealPath || targetRealPath.startsWith(`${rootRealPath}${sep}`))) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', message);
  }
}

function toPortableRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join('/');
}

function normalizeStageBatchId(value: string): string {
  const batchId = requireString(value, 'batch_id');
  if (!/^[A-Za-z0-9._-]+$/.test(batchId)) {
    throw new DomainExpertWorkerError(400, 'invalid_batch_id', 'batch_id may contain only letters, numbers, dots, underscores, and hyphens.');
  }
  return batchId;
}

function safeGcsRelativePath(value: string): string {
  const segments = value.split('/').filter(Boolean).map((segment) => safeObjectName(segment));
  if (segments.length === 0) throw new DomainExpertWorkerError(400, 'invalid_stage_path', 'stage_import file path is empty.');
  return segments.join('/');
}

function extractRagCorpusResourceName(value: unknown): string | undefined {
  if (typeof value === 'string') return isFullRagCorpusResourceName(value) ? value : undefined;
  if (!value || typeof value !== 'object') return undefined;
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = extractRagCorpusResourceName(item);
    if (found) return found;
  }
  return undefined;
}

function defaultCorpusId(domainId: string, action: string): string {
  const manifest = domainManifest(domainId);
  if (action === 'import' || action === 'stage_import') {
    return manifest.corpora.find((corpus) => corpus.id.endsWith('-books') || corpus.id.endsWith('-library'))?.id
      ?? manifest.corpora[0]?.id
      ?? `${domainId}-library`;
  }
  return manifest.corpora[0]?.id ?? `${domainId}-library`;
}

function vertexBase(location: string): string {
  return `https://${location}-aiplatform.googleapis.com`;
}

async function responseTextOrJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function googleError(response: Response, body: unknown): DomainExpertWorkerError {
  const message = typeof body === 'object' && body && 'error' in body
    ? JSON.stringify((body as Record<string, unknown>).error)
    : `Google API request failed with HTTP ${response.status}.`;
  return new DomainExpertWorkerError(response.status, 'google_api_error', message);
}

function annasUrl(template: string | undefined, baseUrl: string | undefined, path: string, params: Record<string, string | undefined>): string | undefined {
  if (template) {
    return Object.entries(params).reduce(
      (url, [key, value]) => url.replaceAll(`{${key}}`, encodeURIComponent(value ?? '')),
      template,
    );
  }
  if (!baseUrl) return undefined;
  const url = new URL(`${trimTrailingSlash(baseUrl)}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function annasHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-API-Key': apiKey,
  };
}

async function fetchAnnasDownload(
  fetchImpl: typeof fetch,
  downloadUrl: string,
  config: DomainExpertAnnasConfig,
  apiKey: string,
): Promise<{ response: Response; url: string }> {
  return fetchAnnasCredentialed(fetchImpl, downloadUrl, {
    config,
    apiKey,
    purpose: 'download',
  });
}

async function fetchAnnasCredentialed(
  fetchImpl: typeof fetch,
  rawUrl: string,
  options: {
    config: DomainExpertAnnasConfig;
    apiKey: string;
    purpose: 'download' | 'search';
  },
): Promise<{ response: Response; url: string }> {
  let current = requireAllowedAnnasCredentialUrl(rawUrl, options.config, options.purpose);
  for (let redirects = 0; redirects <= ANNAS_ARCHIVE_MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(current.toString(), {
      headers: annasHeaders(options.apiKey),
      redirect: 'manual',
    });
    if (!isRedirectStatus(response.status)) {
      return { response, url: current.toString() };
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new DomainExpertWorkerError(400, 'annas_archive_redirect_without_location', 'Anna Archive request redirect did not include a Location header.');
    }
    current = requireAllowedAnnasCredentialUrl(new URL(location, current).toString(), options.config, options.purpose);
  }
  throw new DomainExpertWorkerError(400, 'annas_archive_redirect_limit_exceeded', 'Anna Archive request exceeded the maximum redirect count.');
}

function requireAllowedAnnasCredentialUrl(rawUrl: string, config: DomainExpertAnnasConfig, purpose: 'download' | 'search'): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainExpertWorkerError(400, 'invalid_annas_archive_url', 'Anna Archive download URL must be absolute.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DomainExpertWorkerError(403, 'annas_archive_url_not_allowed', 'Anna Archive credentials may only be sent to HTTPS Anna Archive endpoints without embedded credentials.');
  }
  const allowedOrigins = annasCredentialOrigins(config, purpose);
  if (allowedOrigins.size === 0) {
    throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', `Anna Archive base URL or ${purpose} URL template is required for live ${purpose} requests.`);
  }
  if (!allowedOrigins.has(url.origin)) {
    throw new DomainExpertWorkerError(403, 'annas_archive_url_not_allowed', 'Anna Archive credentials may only be sent to the configured Anna Archive origin.');
  }
  return url;
}

function annasCredentialOrigins(config: DomainExpertAnnasConfig, purpose: 'download' | 'search'): Set<string> {
  const origins = new Set<string>();
  const template = purpose === 'download' ? config.downloadUrlTemplate : config.searchUrlTemplate;
  for (const candidate of [config.baseUrl, template]) {
    const origin = annasCredentialOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

function annasCredentialOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readCappedAnnasDownloadBody(response: Response, url: string, timeoutMs: number, maxDownloadBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxDownloadBytes) {
    await response.body?.cancel().catch(() => {});
    throw annasDownloadSizeError(url, maxDownloadBytes);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await readCappedAnnasDownloadBodyWithSignal(response, url, controller.signal, maxDownloadBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function readCappedAnnasDownloadBodyWithSignal(response: Response, url: string, signal: AbortSignal, maxDownloadBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxDownloadBytes) throw annasDownloadSizeError(url, maxDownloadBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw annasDownloadTimeoutError(url);
      }
      const { done, value } = await readWebImportChunk(reader, signal);
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxDownloadBytes) {
        await reader.cancel().catch(() => {});
        throw annasDownloadSizeError(url, maxDownloadBytes);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      throw annasDownloadTimeoutError(url);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function annasDownloadSizeError(url: string, maxDownloadBytes: number): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    413,
    'annas_archive_download_size_limit_exceeded',
    `Anna Archive download from ${url} exceeded the ${maxDownloadBytes} byte download limit.`,
  );
}

function annasDownloadTimeoutError(url: string): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    408,
    'annas_archive_download_timeout',
    `Timed out downloading Anna Archive item from ${url}.`,
  );
}

function normalizeAnnasCandidates(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['results', 'items', 'candidates', 'data']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}


interface NormalizedAnnasCandidate {
  annas_archive_id?: string;
  stable_locator?: string;
  title?: string;
  author?: string;
  year?: string;
  format?: string;
  language?: string;
  file_size_bytes?: number;
  md5?: string;
  url?: string;
  score: number;
  rationale: string[];
}

function rankAnnasCandidates(items: unknown[], params: AnnasArchiveSearchParams): NormalizedAnnasCandidate[] {
  const limit = params.topN ?? params.maxResults ?? 10;
  return items
    .map((item) => scoreAnnasCandidate(normalizeAnnasCandidate(item), params))
    .filter((candidate) => candidate.title || candidate.author || candidate.annas_archive_id || candidate.md5 || candidate.url)
    .sort((left, right) => right.score - left.score || String(left.title ?? '').localeCompare(String(right.title ?? '')))
    .slice(0, limit);
}

function normalizeAnnasCandidate(item: unknown): Omit<NormalizedAnnasCandidate, 'score' | 'rationale'> {
  const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const md5 = firstCandidateString(record, ['md5', 'hash', 'file_md5']);
  const id = firstCandidateString(record, ['id', 'annas_archive_id', 'aacid', 'stable_id']);
  const url = firstCandidateString(record, ['url', 'download_url', 'href', 'link']);
  const stableLocator = md5 ? `md5:${md5}` : id ?? url;
  return {
    ...(id ? { annas_archive_id: id } : {}),
    ...(stableLocator ? { stable_locator: stableLocator } : {}),
    ...stringField('title', firstCandidateString(record, ['title', 'name', 'book_title'])),
    ...stringField('author', firstCandidateString(record, ['author', 'authors', 'creator'])),
    ...stringField('year', firstCandidateString(record, ['year', 'publication_year', 'published_year'])),
    ...stringField('format', normalizeAnnasFormat(firstCandidateString(record, ['format', 'extension', 'file_type', 'ext']))),
    ...stringField('language', firstCandidateString(record, ['language', 'lang', 'languages'])),
    ...numberField('file_size_bytes', firstCandidateNumber(record, ['file_size_bytes', 'filesize_bytes', 'size_bytes', 'filesize', 'size'])),
    ...(md5 ? { md5 } : {}),
    ...(url ? { url } : {}),
  };
}

function scoreAnnasCandidate(candidate: Omit<NormalizedAnnasCandidate, 'score' | 'rationale'>, params: AnnasArchiveSearchParams): NormalizedAnnasCandidate {
  let score = 0;
  const rationale: string[] = [];
  const topicTerms = tokenizeAnnasQuery([params.query, params.topic, params.title].filter(Boolean).join(' '));
  const haystack = [candidate.title, candidate.author].filter(Boolean).join(' ').toLowerCase();
  const matchedTerms = topicTerms.filter((term) => haystack.includes(term));
  if (matchedTerms.length) {
    score += matchedTerms.length * 5;
    rationale.push(`matched ${matchedTerms.length} query/topic term(s)`);
  }
  if (params.author && candidate.author?.toLowerCase().includes(params.author.toLowerCase())) {
    score += 8;
    rationale.push('author match');
  }
  if (params.language && candidate.language?.toLowerCase().includes(params.language.toLowerCase())) {
    score += 3;
    rationale.push('language match');
  }
  const format = candidate.format?.toLowerCase();
  const preference = params.formatPreference ?? 'auto';
  if ((preference === 'text_rag' || preference === 'auto') && format === 'epub') {
    score += 6;
    rationale.push('EPUB preferred for text-first reading/RAG');
  } else if (preference === 'layout' && format === 'pdf') {
    score += 6;
    rationale.push('PDF preferred for layout-heavy/design material');
  } else if (format) {
    score += 1;
    rationale.push(`format metadata present (${format})`);
  }
  if (candidate.year) {
    score += 1;
    rationale.push('publication year present');
  }
  if (candidate.file_size_bytes) {
    score += 1;
    rationale.push('file size present');
  }
  if (candidate.md5 || candidate.annas_archive_id) {
    score += 2;
    rationale.push('stable locator present');
  }
  return { ...candidate, score, rationale: rationale.length ? rationale : ['candidate metadata returned by Anna Archive'] };
}

function tokenizeAnnasQuery(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4))].slice(0, 12);
}

function firstCandidateString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) {
      const pieces = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
      if (pieces.length) return pieces.join(', ');
    }
  }
  return undefined;
}

function firstCandidateNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
    }
  }
  return undefined;
}

function stringField<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}

function numberField<K extends string>(key: K, value: number | undefined): Record<K, number> | Record<string, never> {
  return value !== undefined ? { [key]: value } as Record<K, number> : {};
}

function normalizeAnnasFormat(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^\./, '').toLowerCase();
  return ANNAS_ARCHIVE_FORMATS.includes(normalized as any) ? normalized : value;
}

async function annasDownloadPlan(root: string, params: AnnasArchiveImportParams): Promise<{ root: string; relativePath: string; targetPath: string }> {
  const rootPath = resolve(root);
  const info = await stat(rootPath).catch(() => undefined);
  if (!info?.isDirectory()) throw new DomainExpertWorkerError(503, 'annas_books_root_not_configured', 'Anna Archive books root is not available on this host.');
  const topic = safeAnnasPathSegment(params.topic ?? 'General');
  const author = params.author?.trim() || 'Unknown Author';
  const title = params.title?.trim() || params.annasArchiveId || params.md5 || basename(params.url ?? 'Anna Archive Item');
  const year = params.year?.trim();
  const folder = safeAnnasPathSegment(`${author} - ${title}${year ? ` (${year})` : ''}`);
  const extension = params.format && params.format !== 'unknown' ? params.format : extensionFormat(params.url ?? 'download.pdf');
  const originalStem = params.fileName ? basename(params.fileName, extname(params.fileName)) : `${author} - ${title}${year ? ` (${year})` : ''}`;
  const locator = params.md5 ?? params.annasArchiveId;
  const suffix = locator ? `-${safeAnnasPathSegment(locator).slice(0, 16)}` : '';
  const filename = `${safeAnnasPathSegment(originalStem)}${suffix}.${extension}`;
  const relativePath = [topic, folder, filename].join('/');
  const targetPath = resolve(rootPath, relativePath);
  if (!(targetPath === rootPath || targetPath.startsWith(`${rootPath}${sep}`))) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', 'Anna Archive download path escaped the configured books root.');
  }
  return { root: rootPath, relativePath, targetPath };
}

async function existingAnnasAcquisition(root: string, params: AnnasArchiveImportParams, targetPath: string): Promise<{ reason: string; targetPath: string } | undefined> {
  if (await exists(targetPath)) return { reason: 'target_path_exists', targetPath };
  const stable = [params.md5, params.annasArchiveId, params.url].filter(Boolean).map(String);
  if (stable.length === 0) return undefined;
  const raw = await readFile(join(resolve(root), ANNAS_AUDIT_FILE), 'utf8').catch(() => '');
  for (const line of raw.split('\n').filter(Boolean).reverse()) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const selected = record.selected && typeof record.selected === 'object' ? record.selected as Record<string, unknown> : {};
    const download = record.download && typeof record.download === 'object' ? record.download as Record<string, unknown> : {};
    const matches = stable.some((value) => Object.values(selected).some((candidate) => candidate === value));
    const path = typeof download.path === 'string' ? download.path : typeof record.target_path === 'string' ? record.target_path : undefined;
    if (matches && path && await exists(path)) return { reason: 'stable_locator_seen_in_audit', targetPath: path };
  }
  return undefined;
}

async function writeAnnasBookFile(targetPath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await writeFile(targetPath, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EEXIST') {
      throw new DomainExpertWorkerError(409, 'annas_archive_duplicate_path', 'Anna Archive target file already exists; refusing to overwrite.');
    }
    throw error;
  }
}

async function appendAnnasAudit(root: string, record: Record<string, unknown>): Promise<void> {
  const rootPath = resolve(root);
  await mkdir(rootPath, { recursive: true });
  await appendFile(join(rootPath, ANNAS_AUDIT_FILE), `${JSON.stringify(record)}\n`, 'utf8');
}

function safeAnnasPathSegment(value: string): string {
  return safeObjectName(value).replace(/-+/g, '-').replace(/^-+|-+$/g, '') || randomUUID();
}

function annasSelectionAudit(params: AnnasArchiveImportParams): Record<string, unknown> {
  return {
    ...(params.annasArchiveId ? { annas_archive_id: params.annasArchiveId } : {}),
    ...(params.url ? { url: params.url } : {}),
    ...(params.md5 ? { md5: params.md5 } : {}),
    ...(params.title ? { title: params.title } : {}),
    ...(params.author ? { author: params.author } : {}),
    ...(params.year ? { year: params.year } : {}),
    ...(params.topic ? { topic: params.topic } : {}),
    ...(params.format ? { format: params.format } : {}),
    copyright_posture: params.copyrightPosture,
  };
}

function parseGcsPrefix(prefix: string): { bucket: string; prefix: string } {
  if (!prefix.startsWith('gs://')) throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS prefix must start with gs://.');
  const withoutScheme = prefix.slice('gs://'.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const objectPrefix = slash === -1 ? '' : `${withoutScheme.slice(slash + 1).replace(/\/?$/, '/')}`;
  if (!bucket) throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS prefix must include a bucket.');
  return { bucket, prefix: objectPrefix };
}

/**
 * Resolution runs before any Vertex call and can itself reach the network (a
 * display-name lookup lists corpora), while the fully-qualified and numeric
 * resource-name branches never consult the project at all. So the tenant check
 * belongs at the top of every live RAG operation, not only inside the URL
 * builders — those remain the backstop.
 */
/**
 * Whether this deployment has a cloud tenant at all, independent of whether it
 * has credentials for one.
 */
function googleTenantConfigured(): boolean {
  try {
    return domainManifest().gcp_project.trim().length > 0;
  } catch {
    // A malformed tenant configuration is not a configured tenant.
    return false;
  }
}

function assertRagCloudTenantConfigured(manifest: ReturnType<typeof domainManifest>): void {
  if (manifest.gcp_project.trim()) return;
  throw new DomainExpertWorkerError(
    503,
    'gcp_project_not_configured',
    'No Google Cloud project is configured for domain expert cloud work.',
    `Set ${DOMAIN_GCP_PROJECT_ENV} to the project id that owns this deployment's Vertex RAG corpora and staging buckets.`,
  );
}

function assertReviewedLiveRagImport(manifest: ReturnType<typeof domainManifest>, params: RagCorpusParams, dryRun: boolean): void {
  if (params.action !== 'import') return;
  if (params.gcsUri) {
    assertAllowedGcsDestination(params.gcsUri, manifest.allowed_gcs_prefixes);
  }
  if (!dryRun && params.driveFileId) {
    throw new DomainExpertWorkerError(
      403,
      'drive_import_review_required',
      'Live Google Drive RAG imports require a reviewed source-registry import path before Vertex ingestion.',
    );
  }
}

function stageDestination(allowedPrefixes: string[], domainId: string, batchId: string): { bucket: string; objectPrefix: string; directoryUri: string } {
  const primaryPrefix = allowedPrefixes[0];
  if (!primaryPrefix) {
    throw new DomainExpertWorkerError(403, 'gcs_destination_not_allowed', 'Domain manifest has no allowed_gcs_prefixes entry for stage_import.');
  }
  const parsed = parseGcsPrefix(primaryPrefix);
  const objectPrefix = `${parsed.prefix}staged/${safeObjectName(domainId)}/${batchId}/`;
  const directoryUri = `gs://${parsed.bucket}/${objectPrefix}`;
  assertAllowedGcsDestination(directoryUri, allowedPrefixes);
  return { bucket: parsed.bucket, objectPrefix, directoryUri };
}

export function assertAllowedGcsDestination(destinationUri: string, allowedPrefixes: string[]): void {
  if (!destinationUri.startsWith('gs://')) {
    throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS destination must start with gs://.');
  }
  const allowed = allowedPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.replace(/\/+$/g, '');
    return destinationUri === normalizedPrefix || destinationUri.startsWith(`${normalizedPrefix}/`);
  });
  if (!allowed) {
    throw new DomainExpertWorkerError(
      403,
      'gcs_destination_not_allowed',
      `GCS destination must be inside one of the domain allowlisted prefixes: ${allowedPrefixes.join(', ')}.`,
    );
  }
}

function extensionFormat(value: string): string {
  const ext = extname(new URL(value, 'https://example.test').pathname).replace('.', '').toLowerCase();
  return ANNAS_ARCHIVE_FORMATS.includes(ext as any) && ext !== 'unknown' ? ext : 'pdf';
}

function safeObjectName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || randomUUID();
}

function notionImportSources(params: RagCorpusParams): NotionImportSource[] {
  return [
    ...(params.urls ?? []).map((url) => ({ id: notionObjectIdFromUrlOrId(url), url: sanitizeNotionSourceUrl(url) })),
    ...(params.pageIds ?? []).map((pageId) => ({ id: normalizeNotionObjectId(pageId), type: 'page' as const })),
    ...(params.databaseIds ?? []).map((databaseId) => ({ id: normalizeNotionObjectId(databaseId), type: 'database' as const })),
  ];
}

function notionObjectIdFromUrlOrId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[?#/]|$)/);
  if (match?.[1]) return normalizeNotionObjectId(match[1]);
  return normalizeNotionObjectId(trimmed);
}

function normalizeNotionObjectId(value: string): string {
  const compact = value.trim().replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new DomainExpertWorkerError(400, 'invalid_notion_object_id', 'Notion object ids must be 32 hexadecimal characters, with or without dashes.');
  }
  return compact;
}

function sanitizeNotionSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!/(\.|^)notion\.(so|site)$/i.test(url.hostname)) return value;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function isNotionImportUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(\.|^)notion\.(so|site)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function notionTitleFromObject(record: Record<string, unknown>): string | undefined {
  const directTitle = richTextPlainText(record.title);
  if (directTitle) return directTitle;
  const properties = asOptionalRecord(record.properties);
  if (!properties) return undefined;
  for (const value of Object.values(properties)) {
    const property = asOptionalRecord(value);
    if (!property) continue;
    if (property.type === 'title') {
      const title = richTextPlainText(property.title);
      if (title) return title;
    }
  }
  return undefined;
}

function notionParentIds(record: Record<string, unknown>): { parentPageId?: string; parentDatabaseId?: string } {
  const parent = asOptionalRecord(record.parent);
  if (!parent) return {};
  const pageId = typeof parent.page_id === 'string' ? normalizeNotionObjectId(parent.page_id) : undefined;
  const databaseId = typeof parent.database_id === 'string' ? normalizeNotionObjectId(parent.database_id) : undefined;
  return {
    ...(pageId ? { parentPageId: pageId } : {}),
    ...(databaseId ? { parentDatabaseId: databaseId } : {}),
  };
}

function notionMarkdownDocument(input: {
  sourceUrl?: string;
  objectId: string;
  objectType: 'page';
  retrievedAt: string;
  title: string;
  parentPageId?: string;
  parentDatabaseId?: string;
  warnings: string[];
  body: string;
}): string {
  const frontmatter: Record<string, unknown> = {
    kind: 'notion',
    title: input.title,
    notion_object_id: input.objectId,
    notion_object_type: input.objectType,
    retrieved_at: input.retrievedAt,
    ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}),
    ...(input.parentPageId ? { parent_page_id: input.parentPageId } : {}),
    ...(input.parentDatabaseId ? { parent_database_id: input.parentDatabaseId } : {}),
    ...(input.warnings.length ? { warnings: [...new Set(input.warnings)] } : {}),
  };
  return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n')}\n---\n\n# ${input.title}\n\n${input.body || '_No readable Notion blocks returned._'}\n`;
}

function renderNotionBlock(block: Record<string, unknown>, childMarkdown: string[], warnings: string[]): string {
  const type = typeof block.type === 'string' ? block.type : 'unknown';
  const payload = asOptionalRecord(block[type]) ?? {};
  const text = richTextPlainText(payload.rich_text) ?? '';
  const children = childMarkdown.length ? `\n${indentMarkdown(childMarkdown.join('\n'), type === 'quote' ? '> ' : '  ')}` : '';
  switch (type) {
    case 'paragraph':
      return `${text}${children}`.trim();
    case 'heading_1':
      return `# ${text}`.trim();
    case 'heading_2':
      return `## ${text}`.trim();
    case 'heading_3':
      return `### ${text}`.trim();
    case 'bulleted_list_item':
      return `- ${text}${children}`.trim();
    case 'numbered_list_item':
      return `1. ${text}${children}`.trim();
    case 'to_do':
      return `- [${payload.checked === true ? 'x' : ' '}] ${text}${children}`.trim();
    case 'toggle':
      return `<details><summary>${escapeHtml(text || 'Toggle')}</summary>\n\n${childMarkdown.join('\n')}\n\n</details>`;
    case 'quote':
      return `> ${text}${children}`.trim();
    case 'callout':
      return `> ${text}${children}`.trim();
    case 'code': {
      const language = typeof payload.language === 'string' ? payload.language : '';
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    case 'divider':
      return '---';
    case 'table':
      return childMarkdown.join('\n');
    case 'table_row':
      return renderNotionTableRow(payload);
    case 'child_page': {
      const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Child page';
      warnings.push('notion_child_page_not_inlined');
      return `## ${title}\n\n_Notion child page boundary; import this page separately if needed._`;
    }
    case 'bookmark':
    case 'link_preview': {
      const url = typeof payload.url === 'string' ? payload.url : '';
      return url ? `[${text || url}](${url})` : text;
    }
    case 'file':
    case 'pdf':
    case 'image':
    case 'video':
    case 'audio': {
      const url = notionFileUrl(payload);
      warnings.push(`notion_media_not_downloaded:${type}`);
      return url ? `[${text || type}](${url})` : `[${text || type}](notion-media-url-expired)`;
    }
    default:
      warnings.push(`notion_block_unsupported:${type}`);
      return text || `_Unsupported Notion block: ${type}_`;
  }
}

function renderNotionTableRow(payload: Record<string, unknown>): string {
  const cells = Array.isArray(payload.cells) ? payload.cells : [];
  return `| ${cells.map((cell) => richTextPlainText(cell) ?? '').join(' | ')} |`;
}

function notionFileUrl(payload: Record<string, unknown>): string | undefined {
  const file = asOptionalRecord(payload.file);
  const external = asOptionalRecord(payload.external);
  return typeof file?.url === 'string' ? file.url : (typeof external?.url === 'string' ? external.url : undefined);
}

function indentMarkdown(value: string, prefix: string): string {
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function yamlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => yamlValue(entry)).join(', ')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function richTextPlainText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((entry) => asOptionalRecord(entry)?.plain_text)
    .filter((entry): entry is string => typeof entry === 'string')
    .join('')
    .trim();
  return text || undefined;
}

function normalizeRetrievedContextSource(context: Record<string, unknown>): Record<string, unknown> {
  return {
    ...context,
    ...(!stringValue(context.sourceDisplayName) ? optionalField('sourceDisplayName', retrievedContextDisplayName(context)) : {}),
    ...(!stringValue(context.sourceUri) ? optionalField('sourceUri', retrievedContextSourceUri(context)) : {}),
  };
}

export function reciprocalRankFuse<T extends Record<string, unknown>>(rankedLists: T[][], limit = Number.POSITIVE_INFINITY): T[] {
  const fused = new Map<string, { context: T; score: number; firstSeen: number }>();
  let firstSeen = 0;
  for (const contexts of rankedLists) {
    const seenInList = new Set<string>();
    for (const [index, context] of contexts.entries()) {
      const key = retrievedContextDedupeKey(context);
      if (seenInList.has(key)) continue;
      seenInList.add(key);
      const score = 1 / (DOMAIN_RRF_K + index + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.score += score;
      } else {
        fused.set(key, { context, score, firstSeen: firstSeen++ });
      }
    }
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.context);
}

function retrievedContextDedupeKey(context: Record<string, unknown>): string {
  const chunk = asOptionalRecord(context.chunk);
  const contextId = stringValue(context.id)
    ?? stringValue(context.contextId)
    ?? stringValue(context.context_id)
    ?? stringValue(context.chunkId)
    ?? stringValue(context.chunk_id)
    ?? stringValue(chunk?.id)
    ?? stringValue(chunk?.name);
  if (contextId) return `id:${contextId}`;
  const sourceUri = retrievedContextSourceUri(context) ?? '';
  const text = String(context.text ?? chunk?.text ?? '');
  return `source:${sourceUri}\ntext:${createHash('sha256').update(text).digest('hex')}`;
}

function domainRetrievalQueries(question: string, reformulations: string[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [question, ...reformulations]) {
    const query = candidate.trim();
    const key = query.toLocaleLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= MAX_DOMAIN_RETRIEVAL_QUERIES) break;
  }
  return queries.length ? queries : [question];
}

function parseQueryReformulations(text: string): string[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Query reformulations must be a JSON array.');
  return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 2);
}

function domainExpertRerankerFromEnv(value: string | undefined): DomainExpertReranker {
  const normalized = value?.trim().toLowerCase().replaceAll('_', '-') || DEFAULT_DOMAIN_RERANKER;
  if (normalized === 'rank-service' || normalized === 'llm' || normalized === 'off') return normalized;
  if (normalized === 'none' || normalized === 'false' || normalized === '0') return 'off';
  throw new Error('OLYMPUS_DOMAIN_EXPERT_RERANKER must be rank-service, llm, or off.');
}

function booleanEnvWithDefault(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  throw new Error(`${name} must be true or false.`);
}

function retrievedContextDisplayName(context: Record<string, unknown>): string | undefined {
  return stringValue(context.sourceDisplayName)
    ?? stringValue(asOptionalRecord(context.source)?.displayName)
    ?? stringValue(asOptionalRecord(context.ragFile)?.displayName)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.source)?.displayName)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.ragFile)?.displayName);
}

function retrievedContextSourceUri(context: Record<string, unknown>): string | undefined {
  return stringValue(context.sourceUri)
    ?? stringValue(asOptionalRecord(context.source)?.uri)
    ?? stringValue(asOptionalRecord(context.source)?.sourceUri)
    ?? stringValue(asOptionalRecord(context.ragFile)?.sourceUri)
    ?? firstString(asOptionalRecord(asOptionalRecord(context.ragFile)?.gcsSource)?.uris)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.source)?.uri)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.source)?.sourceUri)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.ragFile)?.sourceUri)
    ?? firstString(asOptionalRecord(asOptionalRecord(asOptionalRecord(context.chunk)?.ragFile)?.gcsSource)?.uris);
}

function optionalField(key: string, value: string | undefined): Record<string, string> {
  return value ? { [key]: value } : {};
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) ? value.find((item): item is string => typeof item === 'string' && item.length > 0) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function notionImportErrorForObject(error: unknown, source: NotionImportSource): Record<string, unknown> {
  if (error instanceof DomainExpertWorkerError) {
    return {
      object_id: source.id,
      ...(source.url ? { source_url: source.url } : {}),
      ...(source.type ? { object_type: source.type } : {}),
      code: error.code,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    };
  }
  return {
    object_id: source.id,
    ...(source.url ? { source_url: source.url } : {}),
    ...(source.type ? { object_type: source.type } : {}),
    code: 'notion_object_failed',
    message: error instanceof Error ? error.message : 'Notion object probe failed.',
  };
}

function retryAfterMs(value: string | null): number {
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? 250 : Math.min(Math.max(0, dateMs - Date.now()), 5_000);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export const WEB_IMPORT_HANDLERS: readonly WebImportHandler[] = [
  {
    id: 'youtube',
    detect: (context) => isAllowedYoutubeUrl(context.sourceUrl) || isAllowedYoutubeUrl(context.finalUrl),
    derive: deriveYoutubeTranscript,
  },
  {
    id: 'direct-file',
    detect: (context) => directFileExtension(context.finalUrl, context.response.headers) !== undefined,
    derive: deriveDirectFile,
  },
  {
    id: 'notion',
    detect: (context) => isNotionImportUrl(context.sourceUrl) || isNotionImportUrl(context.finalUrl),
    derive: deriveNotionRequiresApiImport,
  },
  {
    id: 'generic-html',
    detect: () => true,
    derive: deriveGenericHtml,
  },
];

export function selectWebImportHandler(context: WebImportHandlerContext, handlers: readonly WebImportHandler[] = WEB_IMPORT_HANDLERS): WebImportHandler {
  const handler = handlers.find((candidate) => candidate.detect(context));
  if (!handler) throw new DomainExpertWorkerError(500, 'web_import_handler_missing', 'No web import handler matched the URL.');
  return handler;
}

async function deriveWebImportFiles(input: {
  urls: string[];
  includeMedia: boolean;
  transcriptMode: 'auto' | 'captions' | 'asr';
  dryRun: boolean;
  fetchedAt: string;
  fetch: (url: string) => Promise<WebImportFetchResult>;
  media: MediaRuntimeContext;
}): Promise<{
  files: WebImportDerivedFile[];
  errors: WebImportUrlError[];
  urlResults: Array<Record<string, unknown>>;
}> {
  const files: WebImportDerivedFile[] = [];
  const errors: WebImportUrlError[] = [];
  const urlResults: Array<Record<string, unknown>> = [];
  const usedFileNames = new Set<string>();
  for (const sourceUrl of input.urls) {
    const sourceProvenanceUrl = webImportProvenanceUrl(sourceUrl);
    let response: WebImportFetchResult | undefined;
    let handler: WebImportHandler | undefined;
    try {
      if (isNotionImportUrl(sourceUrl)) {
        const error = notionRequiresApiImportError(sourceProvenanceUrl);
        errors.push(error);
        urlResults.push({
          source_url: sourceProvenanceUrl,
          final_url: sourceProvenanceUrl,
          handler: 'notion',
          file_count: 0,
          error_count: 1,
          suggestion: error.suggestion,
        });
        continue;
      }
      response = await input.fetch(sourceUrl);
      const finalProvenanceUrl = webImportProvenanceUrl(response.url);
      const context: WebImportHandlerContext = {
        sourceUrl,
        finalUrl: response.url,
        sourceProvenanceUrl,
        finalProvenanceUrl,
        response,
        includeMedia: input.includeMedia,
        transcriptMode: input.transcriptMode,
        dryRun: input.dryRun,
        fetchedAt: input.fetchedAt,
        fetch: input.fetch,
        media: input.media,
      };
      handler = selectWebImportHandler(context);
      const activeHandler = handler;
      const result = await activeHandler.derive(context);
      for (const file of result.files) {
        const fileName = uniqueWebImportFileName(file.fileName, usedFileNames);
        files.push({ ...file, fileName });
      }
      if (result.errors?.length) {
        errors.push(...result.errors.map((error) => sanitizeWebImportUrlError({
          ...error,
          handler: error.handler ?? activeHandler.id,
        })));
      }
      urlResults.push({
        source_url: sourceProvenanceUrl,
        final_url: finalProvenanceUrl,
        handler: activeHandler.id,
        file_count: result.files.length,
        error_count: result.errors?.length ?? 0,
        ...(result.plan ?? {}),
      });
    } catch (error) {
      if (error instanceof DomainExpertWorkerError && WEB_IMPORT_FAIL_CLOSED_CODES.has(error.code)) {
        throw error;
      }
      const normalized = webImportErrorForUrl(error, sourceProvenanceUrl, response?.url, handler?.id);
      errors.push(normalized);
      urlResults.push({
        source_url: sourceProvenanceUrl,
        ...(response?.url ? { final_url: webImportProvenanceUrl(response.url) } : {}),
        ...(handler?.id ? { handler: handler.id } : {}),
        file_count: 0,
        error_count: 1,
        ...(handler?.id === 'youtube' ? { transcript_mode: input.transcriptMode } : {}),
      });
    }
  }
  return { files, errors, urlResults };
}

const WEB_IMPORT_FAIL_CLOSED_CODES = new Set([
  'web_import_https_required',
  'web_import_hostname_unresolved',
  'web_import_private_address_denied',
  'web_import_redirect_without_location',
  'web_import_redirect_limit_exceeded',
  'web_import_fetch_size_limit_exceeded',
  'web_import_batch_size_limit_exceeded',
  'web_import_fetch_limit_exceeded',
  'web_import_unpinned_fetch_impl',
]);

function webImportErrorForUrl(error: unknown, sourceUrl: string, finalUrl: string | undefined, handler: string | undefined): WebImportUrlError {
  if (error instanceof DomainExpertWorkerError) {
    return sanitizeWebImportUrlError({
      source_url: sourceUrl,
      ...(finalUrl ? { final_url: finalUrl } : {}),
      ...(handler ? { handler } : {}),
      code: error.code,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      ...(error.stderrTail ? { stderr_tail: error.stderrTail } : {}),
    });
  }
  return sanitizeWebImportUrlError({
    source_url: sourceUrl,
    ...(finalUrl ? { final_url: finalUrl } : {}),
    ...(handler ? { handler } : {}),
    code: 'web_import_url_failed',
    message: error instanceof Error ? error.message : 'web_import failed for this URL.',
  });
}

async function deriveNotionRequiresApiImport(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  return {
    files: [],
    errors: [notionRequiresApiImportError(context.sourceProvenanceUrl, context.finalProvenanceUrl)],
  };
}

function notionRequiresApiImportError(sourceUrl: string, finalUrl?: string): WebImportUrlError {
  return {
    source_url: sourceUrl,
    ...(finalUrl ? { final_url: finalUrl } : {}),
    handler: 'notion',
    code: 'notion_requires_api_import',
    message: 'Notion pages require the official Notion API import lane because public Notion pages are client-rendered.',
    suggestion: 'Use rag_corpus action=notion_import with Notion URLs, page_ids, or database_ids after sharing the target pages with the integration.',
  };
}

function sanitizeWebImportUrlError(error: WebImportUrlError): WebImportUrlError {
  return {
    ...error,
    source_url: webImportProvenanceUrl(error.source_url),
    ...(error.final_url ? { final_url: webImportProvenanceUrl(error.final_url) } : {}),
    message: sanitizeWebImportProvenanceText(error.message),
    ...(error.suggestion ? { suggestion: sanitizeWebImportProvenanceText(error.suggestion) } : {}),
    ...(error.stderr_tail ? { stderr_tail: sanitizeWebImportProvenanceText(error.stderr_tail) } : {}),
  };
}

function sanitizeWebImportProvenanceText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (match) => webImportProvenanceUrl(match));
}

function webImportProvenanceUrl(value: string): string {
  try {
    const url = new URL(value);
    const allowed = allowedWebImportProvenanceParams(url);
    const params = new URLSearchParams();
    for (const [key, item] of url.searchParams.entries()) {
      if (allowed.has(key.toLowerCase())) params.append(key, item);
    }
    url.username = '';
    url.password = '';
    url.search = params.toString();
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function allowedWebImportProvenanceParams(url: URL): Set<string> {
  const hostname = normalizedUrlHostname(url);
  if ((hostname === 'youtube.com' || hostname === 'www.youtube.com' || hostname === 'm.youtube.com')
    && url.pathname === '/watch') {
    return new Set(['v']);
  }
  return new Set();
}

function uniqueWebImportFileName(fileName: string, used: Set<string>): string {
  const safe = safeRelativeFileName(fileName);
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const extension = extname(safe);
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function safeRelativeFileName(value: string): string {
  const extension = extname(value).toLowerCase();
  const stem = extension ? value.slice(0, -extension.length) : value;
  return `${safeObjectName(stem)}${extension || '.md'}`;
}

async function deriveYoutubeTranscript(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  const ytDlpUrl = trustedYoutubeYtDlpUrl(context);
  const metadata = await ytDlpMetadata(context.media, ytDlpUrl);
  const title = metadataString(metadata, 'title') ?? 'YouTube transcript';
  const channel = metadataString(metadata, 'channel') ?? metadataString(metadata, 'uploader') ?? metadataString(metadata, 'ownerChannelName');
  const manualCaption = selectYtDlpCaption(metadata.subtitles);
  const autoCaption = selectYtDlpCaption(metadata.automatic_captions);
  const selectedCaption = manualCaption ?? autoCaption;
  const expectedPath = context.transcriptMode === 'asr'
    ? 'will_transcribe'
    : (selectedCaption ? 'captions' : (context.transcriptMode === 'captions' ? 'captions_missing' : 'will_transcribe'));
  if (context.dryRun) {
    return {
      files: [],
      plan: {
        expected_path: expectedPath,
        transcript_mode: context.transcriptMode,
        transcript_source: expectedPath === 'captions' ? 'captions' : (context.transcriptMode === 'captions' ? 'none' : 'asr'),
        youtube_metadata_title: title,
        ...(channel ? { youtube_metadata_channel: channel } : {}),
      },
    };
  }
  if (context.transcriptMode !== 'asr') {
    const captionAttempts = [
      { source: 'manual' as const, caption: manualCaption },
      { source: 'auto' as const, caption: autoCaption },
    ];
    for (const attempt of captionAttempts) {
      if (!attempt.caption) continue;
      const captionResponse = await context.fetch(attempt.caption.url);
      const transcript = vttToPlainText(utf8(captionResponse.bytes));
      if (!transcript.trim()) continue;
      const markdown = transcriptMarkdown({
        sourceUrl: context.sourceProvenanceUrl,
        retrievedAt: context.fetchedAt,
        kind: 'youtube',
        title,
        ...(channel ? { channel } : {}),
        transcriptSource: 'captions',
        transcript,
      });
      return {
        files: [{
          sourceUrl: context.sourceProvenanceUrl,
          finalUrl: context.finalProvenanceUrl,
          kind: 'youtube',
          fileName: `${safeObjectName(title)}.md`,
          bytes: new TextEncoder().encode(markdown),
        }],
        plan: {
          expected_path: 'captions',
          transcript_mode: context.transcriptMode,
          caption_source: attempt.source,
          transcript_source: 'captions',
        },
      };
    }
    if (context.transcriptMode === 'captions') {
      throw new DomainExpertWorkerError(
        422,
        'youtube_captions_unavailable',
        'No readable YouTube captions were available, and transcript_mode=captions does not fall back to ASR.',
      );
    }
  }
  const audio = await downloadYoutubeAudio(context.media, ytDlpUrl, title);
  const objectName = `${mediaStagingObjectPrefix(context.media)}${safeObjectName(title)}-${sha256(audio.bytes).slice(0, 12)}${audio.extension}`;
  await context.media.upload(context.media.destination.bucket, objectName, audio.bytes);
  const gcsUri = `gs://${context.media.destination.bucket}/${objectName}`;
  const transcript = await context.media.transcribe({ gcsUri, mimeType: audio.mimeType });
  if (!transcript.trim()) {
    throw new DomainExpertWorkerError(
      502,
      'youtube_asr_empty',
      'Gemini ASR returned no readable transcript text for this YouTube video.',
      'Retry after checking yt-dlp and Vertex media transcription availability.',
    );
  }
  const markdown = transcriptMarkdown({
    sourceUrl: context.sourceProvenanceUrl,
    retrievedAt: context.fetchedAt,
    kind: 'youtube',
    title,
    ...(channel ? { channel } : {}),
    transcriptSource: 'asr',
    transcript,
  });
  return {
    files: [{
      sourceUrl: context.sourceProvenanceUrl,
      finalUrl: context.finalProvenanceUrl,
      kind: 'youtube',
      fileName: `${safeObjectName(title)}.md`,
      bytes: new TextEncoder().encode(markdown),
    }],
    plan: {
      expected_path: 'will_transcribe',
      transcript_mode: context.transcriptMode,
      transcript_source: 'asr',
      media_gcs_uri: gcsUri,
      media_bytes: audio.bytes.byteLength,
    },
  };
}

async function ytDlpMetadata(media: MediaRuntimeContext, url: string): Promise<Record<string, any>> {
  const result = await runMediaExec(media, [
    '--dump-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    url,
  ]);
  try {
    return JSON.parse(result.stdout) as Record<string, any>;
  } catch {
    throw withStderrTail(
      new DomainExpertWorkerError(502, 'youtube_metadata_invalid', 'yt-dlp returned invalid metadata JSON.'),
      result.stderr,
    );
  }
}

function selectYtDlpCaption(value: unknown): { url: string; ext?: string; language?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const preferred = entries.find(([language]) => /^en([.-]|$)/i.test(language)) ?? entries[0];
  if (!preferred) return undefined;
  const [language, formats] = preferred;
  if (!Array.isArray(formats)) return undefined;
  const format = formats.find((candidate) => (
    candidate
    && typeof candidate === 'object'
    && typeof (candidate as Record<string, unknown>).url === 'string'
    && String((candidate as Record<string, unknown>).ext ?? '').toLowerCase() === 'vtt'
  )) ?? formats.find((candidate) => (
    candidate
    && typeof candidate === 'object'
    && typeof (candidate as Record<string, unknown>).url === 'string'
  ));
  if (!format || typeof format !== 'object') return undefined;
  const record = format as Record<string, unknown>;
  return {
    url: normalizeCaptionUrl(record.url),
    ...(typeof record.ext === 'string' ? { ext: record.ext } : {}),
    language,
  };
}

async function downloadYoutubeAudio(media: MediaRuntimeContext, url: string, title: string): Promise<{ bytes: Uint8Array; extension: string; mimeType: string }> {
  const tempParent = await mediaTempParent(media.dataDir);
  const tempDir = await mkdtemp(join(tempParent, 'yt-dlp-'));
  try {
    const outputTemplate = join(tempDir, 'audio.%(ext)s');
    const result = await runMediaExec(media, [
      '--no-playlist',
      '--no-warnings',
      '--max-filesize',
      `${MEDIA_TRANSCRIBE_MAX_BYTES}`,
      '-f',
      'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio',
      '-o',
      outputTemplate,
      url,
    ], { cwd: tempDir });
    const entries = await readdir(tempDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => join(tempDir, entry.name));
    if (files.length === 0) {
      throw withStderrTail(
        new DomainExpertWorkerError(502, 'youtube_audio_download_failed', `yt-dlp did not produce an audio file for ${title}.`),
        result.stderr,
      );
    }
    const filePath = files[0]!;
    const info = await stat(filePath);
    if (info.size > MEDIA_TRANSCRIBE_MAX_BYTES) {
      throw new DomainExpertWorkerError(413, 'media_size_limit_exceeded', 'Downloaded audio exceeds the 200 MB transcription cap.');
    }
    const extension = extname(filePath).toLowerCase() || '.m4a';
    const bytes = new Uint8Array(await readFile(filePath));
    return { bytes, extension, mimeType: mediaMimeType(filePath) };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function mediaTempParent(dataDir: string): Promise<string> {
  const parent = dataDir ? join(dataDir, 'tmp') : tmpdir();
  await mkdir(parent, { recursive: true });
  return parent;
}

async function runMediaExec(media: MediaRuntimeContext, args: string[], options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  try {
    return await media.exec(media.ytDlpBin, args, options);
  } catch (error) {
    if (isMissingExecutableError(error)) {
      throw new DomainExpertWorkerError(
        503,
        'media_tooling_not_configured',
        `yt-dlp is required for media import. Install it with pip3 install --user yt-dlp, or set OLYMPUS_DOMAIN_EXPERT_YTDLP_BIN.`,
        'Run pip3 install --user yt-dlp on the worker host.',
      );
    }
    const stderr = execErrorText(error, 'stderr');
    const message = error instanceof Error ? error.message : 'yt-dlp failed.';
    throw withStderrTail(new DomainExpertWorkerError(502, 'yt_dlp_failed', message), stderr);
  }
}

function isMissingExecutableError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function execErrorText(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object' || !(key in error)) return '';
  return String((error as Record<string, unknown>)[key] ?? '');
}

function withStderrTail<T extends DomainExpertWorkerError>(error: T, stderr: string): T {
  const tail = stderrTail(stderr);
  if (tail) error.stderrTail = tail;
  return error;
}

function stderrTail(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(-500) : undefined;
}

function vttToPlainText(vtt: string): string {
  const lines = vtt.replace(/\r/g, '').split('\n');
  const cleaned: string[] = [];
  let previous = '';
  let inNote = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === 'WEBVTT') {
      inNote = false;
      continue;
    }
    if (/^(NOTE|STYLE|REGION)(\s|$)/i.test(line)) {
      inNote = true;
      continue;
    }
    if (inNote) continue;
    if (/^\d+$/.test(line)) continue;
    if (line.includes('-->')) continue;
    const text = collapseWhitespace(decodeHtmlEntities(line.replace(/<[^>]+>/g, ' ')));
    if (!text || text === previous) continue;
    cleaned.push(text);
    previous = text;
  }
  return cleaned.join('\n');
}

function transcriptMarkdown(input: {
  sourceUrl: string;
  retrievedAt: string;
  kind: string;
  title: string;
  channel?: string;
  transcriptSource: 'captions' | 'asr';
  transcript: string;
}): string {
  return `${frontmatter({
    source_url: input.sourceUrl,
    retrieved_at: input.retrievedAt,
    kind: input.kind,
    transcript_source: input.transcriptSource,
    title: input.title,
    ...(input.channel ? { channel: input.channel } : {}),
  })}# ${input.title}

${input.channel ? `Channel: ${input.channel}\n\n` : ''}Source: ${input.sourceUrl}

## Transcript

${input.transcript.trim()}
`;
}

async function transcribeMediaFromGcs(input: {
  project: string;
  location: string;
  sourceUrl: string;
  title: string;
  kind: string;
  retrievedAt: string;
  transcriptSource: 'asr';
  gcsUri: string;
  mimeType: string;
  transcribe(media: { gcsUri: string; mimeType: string }): Promise<string>;
}): Promise<{ bytes: Uint8Array }> {
  const transcript = await input.transcribe({ gcsUri: input.gcsUri, mimeType: input.mimeType });
  if (!transcript.trim()) {
    throw new DomainExpertWorkerError(502, 'media_asr_empty', 'Gemini ASR returned no readable transcript text for this media file.');
  }
  return {
    bytes: new TextEncoder().encode(transcriptMarkdown({
      sourceUrl: input.sourceUrl,
      retrievedAt: input.retrievedAt,
      kind: input.kind,
      title: input.title,
      transcriptSource: input.transcriptSource,
      transcript,
    })),
  };
}

function metadataString(metadata: Record<string, any>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mediaStagingObjectPrefix(media: MediaRuntimeContext): string {
  const domainSegment = safeObjectName(media.domainId);
  const expectedSuffix = `staged/${domainSegment}/${media.batchId}/`;
  if (media.destination.objectPrefix.endsWith(expectedSuffix)) {
    return `${media.destination.objectPrefix.slice(0, -expectedSuffix.length)}staged/${domainSegment}/media/${media.batchId}/`;
  }
  return `${media.destination.objectPrefix}media/`;
}

async function deriveGenericHtml(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  const html = utf8(context.response.bytes);
  const title = extractHtmlTitle(html) || new URL(context.finalUrl).hostname;
  const extracted = extractReadableHtmlText(html);
  const warnings = extracted.length < 200 ? ['short_extraction'] : undefined;
  const markdown = `${frontmatter({
    source_url: context.sourceProvenanceUrl,
    retrieved_at: context.fetchedAt,
    kind: 'html',
    title,
  })}# ${title}

${extracted || 'No readable main text could be extracted from this page.'}
`;
  return {
    files: [{
      sourceUrl: context.sourceProvenanceUrl,
      finalUrl: context.finalProvenanceUrl,
      kind: 'html',
      fileName: `${safeObjectName(title)}.md`,
      bytes: new TextEncoder().encode(markdown),
      ...(warnings ? { warnings } : {}),
    }],
  };
}

async function deriveDirectFile(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  const extension = directFileExtension(context.finalUrl, context.response.headers);
  if (!extension) {
    return { files: [] };
  }
  const isMedia = STAGE_IMPORT_MEDIA_EXTENSIONS.has(extension);
  if (isMedia && !context.includeMedia) {
    return {
      files: [],
      errors: [{
        source_url: context.sourceProvenanceUrl,
        final_url: context.finalProvenanceUrl,
        code: 'media_requires_include_media',
        message: `${extension.slice(1)} media files are skipped unless include_media=true.`,
      }],
    };
  }
  const urlPathName = basename(new URL(context.finalUrl).pathname);
  const fallbackName = `${new URL(context.finalUrl).hostname}${extension}`;
  const fileName = urlPathName && extname(urlPathName) ? urlPathName : fallbackName;
  const bytes = extension !== '.pdf' && !isMedia
    ? new TextEncoder().encode(`${frontmatter({
        source_url: context.sourceProvenanceUrl,
        retrieved_at: context.fetchedAt,
        kind: 'file',
      })}${utf8(context.response.bytes)}`)
    : context.response.bytes;
  return {
    files: [{
      sourceUrl: context.sourceProvenanceUrl,
      finalUrl: context.finalProvenanceUrl,
      kind: 'file',
      fileName,
      bytes,
    }],
  };
}

function directFileExtension(url: string, headers: Headers): string | undefined {
  const pathExtension = extname(new URL(url).pathname).toLowerCase();
  if (STAGE_IMPORT_ALLOWED_EXTENSIONS.has(pathExtension) || STAGE_IMPORT_MEDIA_EXTENSIONS.has(pathExtension)) {
    return pathExtension;
  }
  const contentType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const byContentType: Record<string, string> = {
    'application/pdf': '.pdf',
    'text/markdown': '.md',
    'text/plain': '.txt',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/wave': '.wav',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  return contentType ? byContentType[contentType] : undefined;
}

function mediaMimeType(path: string): string {
  const byExtension: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  };
  return byExtension[extname(path).toLowerCase()] ?? 'audio/mp4';
}

const YOUTUBE_YTDLP_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

function isAllowedYoutubeUrl(value: string): boolean {
  try {
    return YOUTUBE_YTDLP_HOSTS.has(normalizedUrlHostname(new URL(value)));
  } catch {
    return false;
  }
}

function trustedYoutubeYtDlpUrl(context: WebImportHandlerContext): string {
  if (isAllowedYoutubeUrl(context.finalUrl)) return context.finalUrl;
  throw new DomainExpertWorkerError(
    400,
    'youtube_url_not_allowed',
    'YouTube import only runs yt-dlp for guard-validated final URLs on allowlisted YouTube hosts.',
  );
}

function extractCaptionTracks(html: string): Array<Record<string, unknown>> {
  const array = extractJsonArrayAfterKey(html, '"captionTracks"') ?? extractJsonArrayAfterKey(html, 'captionTracks');
  if (!array) return [];
  try {
    const parsed = JSON.parse(array) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  } catch {
    return [];
  }
}

function extractJsonArrayAfterKey(text: string, key: string): string | undefined {
  const keyIndex = text.indexOf(key);
  if (keyIndex === -1) return undefined;
  const start = text.indexOf('[', keyIndex);
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function normalizeCaptionUrl(value: unknown): string {
  const raw = requireString(value, 'caption_url').replaceAll('\\u0026', '&').replaceAll('&amp;', '&');
  return new URL(raw).toString();
}

function timedTextToPlainText(xml: string): string {
  const parts = [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((match) => decodeHtmlEntities((match[1] ?? '').replace(/<[^>]+>/g, ' ')).trim())
    .filter(Boolean);
  return collapseWhitespace(parts.join(' '));
}

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? collapseWhitespace(decodeHtmlEntities((match[1] ?? '').replace(/<[^>]+>/g, ' '))) : undefined;
}

function extractJsonString(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1] ?? ''}"`);
  } catch {
    return (match[1] ?? '').replaceAll('\\"', '"');
  }
}

function extractReadableHtmlText(html: string): string {
  const withoutBoilerplate = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|nav|header|footer|aside|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
  const mainMatch = withoutBoilerplate.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  const body = mainMatch?.[2] ?? withoutBoilerplate.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? withoutBoilerplate;
  return collapseWhitespace(decodeHtmlEntities(body.replace(/<[^>]+>/g, ' ')));
}

function frontmatter(values: Record<string, unknown>): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function webImportFetchFromFetchImpl(_fetchImpl: typeof fetch): WebImportFetchImpl {
  return (_url, _options) => {
    return Promise.reject(new DomainExpertWorkerError(
      500,
      'web_import_unpinned_fetch_impl',
      'web_import cannot use a generic fetchImpl because it cannot enforce the prevalidated destination address. Provide webImportFetchImpl or use the default pinned HTTPS transport.',
    ));
  };
}

// The runtime's socket layer may call this with {all: true} (happy-eyeballs
// family selection sorts the result array), or without it for a single
// address — both shapes must be served or the request dies inside net.
export function pinnedWebImportLookup(validatedAddresses: readonly string[]): (
  hostname: string,
  lookupOptions: unknown,
  callback: (err: Error | null, address?: unknown, family?: number) => void,
) => void {
  const entries = validatedAddresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter((entry) => entry.family !== 0 && !isPrivateOrReservedAddress(entry.address));
  return (_hostname, lookupOptions, callback) => {
    const first = entries[0];
    if (!first) {
      callback(new Error('web_import pinned lookup has no validated public addresses.'));
      return;
    }
    if ((lookupOptions as { all?: boolean } | undefined)?.all) {
      callback(null, entries);
      return;
    }
    callback(null, first.address, first.family);
  };
}

function defaultWebImportFetch(url: URL, options: {
  signal: AbortSignal;
  validatedAddresses: readonly string[];
}): Promise<Response> {
  const publicAddresses = options.validatedAddresses
    .filter((address) => isIP(address) !== 0 && !isPrivateOrReservedAddress(address));
  if (publicAddresses.length === 0) {
    return Promise.reject(new DomainExpertWorkerError(
      400,
      'web_import_private_address_denied',
      `web_import denied non-public address ${options.validatedAddresses[0] ?? 'unresolved'} for ${normalizedUrlHostname(url)}.`,
    ));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest(url, {
      method: 'GET',
      lookup: pinnedWebImportLookup(publicAddresses) as never,
      signal: options.signal,
    }, (message) => {
      resolvePromise(responseFromIncomingMessage(message));
    });
    request.on('error', rejectPromise);
    request.end();
  });
}

function responseFromIncomingMessage(message: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  const status = message.statusCode && message.statusCode >= 100 && message.statusCode <= 599
    ? message.statusCode
    : 502;
  const body = status === 204 || status === 304 ? null : readableStreamFromIncomingMessage(message);
  return new Response(body, {
    status,
    headers,
    ...(message.statusMessage ? { statusText: message.statusMessage } : {}),
  });
}

function readableStreamFromIncomingMessage(message: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      message.on('data', (chunk: Buffer | Uint8Array | string) => {
        if (typeof chunk === 'string') {
          controller.enqueue(new TextEncoder().encode(chunk));
          return;
        }
        controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      });
      message.on('end', () => controller.close());
      message.on('error', (error) => controller.error(error));
    },
    cancel() {
      message.destroy();
    },
  });
}

async function guardedWebImportFetch(input: {
  url: string;
  fetchImpl: WebImportFetchImpl;
  resolveHost: ResolveHostImpl;
  budget: WebImportBudget;
  timeoutMs: number;
}): Promise<WebImportFetchResult> {
  let current = new URL(input.url);
  for (let redirects = 0; redirects <= WEB_IMPORT_MAX_REDIRECTS; redirects += 1) {
    const validatedAddresses = await assertWebImportUrlAllowed(current, input.resolveHost);
    if (input.budget.fetches >= WEB_IMPORT_MAX_FETCHES) {
      throw new DomainExpertWorkerError(400, 'web_import_fetch_limit_exceeded', 'web_import exceeded the maximum number of outbound fetches.');
    }
    input.budget.fetches += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    let response: Response;
    try {
      response = await input.fetchImpl(current, {
        validatedAddresses,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${webImportProvenanceUrl(current.toString())}.`);
      }
      throw error;
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new DomainExpertWorkerError(400, 'web_import_redirect_without_location', `Redirect from ${webImportProvenanceUrl(current.toString())} did not include a Location header.`);
        }
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        throw new DomainExpertWorkerError(response.status, 'web_import_fetch_failed', `Fetch failed for ${webImportProvenanceUrl(current.toString())} with HTTP ${response.status}.`);
      }
      const bytes = await readCappedWebImportBody(response, input.budget, webImportProvenanceUrl(current.toString()), controller.signal);
      return {
        url: current.toString(),
        status: response.status,
        headers: response.headers,
        bytes,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${webImportProvenanceUrl(current.toString())}.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new DomainExpertWorkerError(400, 'web_import_redirect_limit_exceeded', 'web_import exceeded the maximum redirect count.');
}

interface WebImportBudget {
  fetches: number;
  totalBytes: number;
}

function webImportBudget(): WebImportBudget {
  return { fetches: 0, totalBytes: 0 };
}

async function readCappedWebImportBody(response: Response, budget: WebImportBudget, url: string, signal: AbortSignal): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (contentLength !== undefined && Number.isFinite(contentLength)) {
    if (contentLength > WEB_IMPORT_MAX_FETCH_BYTES) {
      throw new DomainExpertWorkerError(413, 'web_import_fetch_size_limit_exceeded', `Fetch for ${url} exceeded the 25 MB per-fetch limit.`);
    }
    if (budget.totalBytes + contentLength > WEB_IMPORT_MAX_BATCH_BYTES) {
      throw new DomainExpertWorkerError(413, 'web_import_batch_size_limit_exceeded', 'web_import exceeded the 100 MB batch fetch limit.');
    }
  }
  const startingBudgetBytes = budget.totalBytes;
  const chunks: Uint8Array[] = [];
  let fetchBytes = 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    fetchBytes = bytes.byteLength;
    enforceWebImportBodyBudget(fetchBytes, { ...budget, totalBytes: startingBudgetBytes }, url);
    budget.totalBytes += chargedWebImportBytes(contentLength, fetchBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${url}.`);
      }
      const { done, value } = await readWebImportChunk(reader, signal);
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      fetchBytes += chunk.byteLength;
      try {
        enforceWebImportBodyBudget(fetchBytes, { ...budget, totalBytes: startingBudgetBytes }, url);
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${url}.`);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  budget.totalBytes += chargedWebImportBytes(contentLength, fetchBytes);
  const bytes = new Uint8Array(fetchBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function chargedWebImportBytes(contentLength: number | undefined, actualBytes: number): number {
  return contentLength !== undefined && Number.isFinite(contentLength)
    ? Math.max(contentLength, actualBytes)
    : actualBytes;
}

function readWebImportChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        rejectPromise(error);
      },
    );
  });
}

function enforceWebImportBodyBudget(fetchBytes: number, budget: WebImportBudget, url: string): void {
  if (fetchBytes > WEB_IMPORT_MAX_FETCH_BYTES) {
    throw new DomainExpertWorkerError(413, 'web_import_fetch_size_limit_exceeded', `Fetch for ${url} exceeded the 25 MB per-fetch limit.`);
  }
  if (budget.totalBytes + fetchBytes > WEB_IMPORT_MAX_BATCH_BYTES) {
    throw new DomainExpertWorkerError(413, 'web_import_batch_size_limit_exceeded', 'web_import exceeded the 100 MB batch fetch limit.');
  }
}

async function assertWebImportUrlAllowed(url: URL, resolveHost: ResolveHostImpl): Promise<string[]> {
  if (url.protocol !== 'https:') {
    throw new DomainExpertWorkerError(400, 'web_import_https_required', 'web_import only allows https URLs.');
  }
  const hostname = normalizedUrlHostname(url);
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0) {
    throw new DomainExpertWorkerError(400, 'web_import_hostname_unresolved', `Could not resolve hostname ${hostname}.`);
  }
  for (const address of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      throw new DomainExpertWorkerError(400, 'web_import_private_address_denied', `web_import denied non-public address ${address} for ${hostname}.`);
    }
  }
  return addresses;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(normalized)) return [normalized];
  const records = await lookup(normalized, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function normalizedUrlHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

const MEDIA_EXEC_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'NO_COLOR',
  'FORCE_COLOR',
] as const;

const defaultMediaExec: MediaExec = (command, args, options = {}) => new Promise((resolvePromise, rejectPromise) => {
  execFile(command, args, {
    cwd: options.cwd,
    env: scrubbedMediaExecEnv(),
    maxBuffer: 20 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) {
      Object.assign(error, { stdout, stderr });
      rejectPromise(error);
      return;
    }
    resolvePromise({ stdout, stderr });
  });
});

function scrubbedMediaExecEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(MEDIA_EXEC_ENV_ALLOWLIST.flatMap((key) => {
    const value = env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const mapped = ipv4FromMappedIpv6(normalized) ?? normalized;
  const family = isIP(mapped);
  if (family === 4) return isPrivateOrReservedIpv4(mapped);
  if (family === 6) return isPrivateOrReservedIpv6(mapped);
  return true;
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = -1, b = -1] = parts;
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateOrReservedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff');
}

function ipv4FromMappedIpv6(address: string): string | undefined {
  const words = expandIpv6Words(address);
  if (!words || words.length !== 8) return undefined;
  if (
    words.slice(0, 5).some((word) => word !== 0)
    || words[5] !== 0xffff
  ) {
    return undefined;
  }
  const [high = 0, low = 0] = words.slice(6);
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

function expandIpv6Words(address: string): number[] | undefined {
  const normalized = replaceDottedIpv4Tail(address);
  if (!normalized) return undefined;
  const parts = normalized.split('::');
  if (parts.length > 2) return undefined;
  const left = ipv6WordsFromPart(parts[0] ?? '');
  const right = parts.length === 2 ? ipv6WordsFromPart(parts[1] ?? '') : [];
  if (!left || !right) return undefined;
  if (parts.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ];
}

function replaceDottedIpv4Tail(address: string): string | undefined {
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  if (!dotted) return address;
  const parts = dotted.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
  const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
  return `${address.slice(0, -dotted.length)}${high.toString(16)}:${low.toString(16)}`;
}

function ipv6WordsFromPart(part: string): number[] | undefined {
  if (!part) return [];
  const words = part.split(':').map((segment) => {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) return Number.NaN;
    return Number.parseInt(segment, 16);
  });
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}

function resolvedCorpusRecord(resolved: ResolvedRagCorpus): Record<string, unknown> {
  return {
    requested: resolved.requested,
    corpus_id: resolved.corpusId,
    resource_name: resolved.resourceName,
    ...(resolved.displayName ? { display_name: resolved.displayName } : {}),
  };
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRoot(root: DomainExpertWorkspaceRootPolicy): DomainExpertWorkspaceRootPolicy {
  return {
    rootId: requireString(root.rootId, 'root_id'),
    path: requireString(root.path, 'path'),
    maxWriteBytes: normalizePositiveInteger(root.maxWriteBytes, 100 * 1024 * 1024),
    allowOverwrite: root.allowOverwrite === true,
    ...(root.auditPath ? { auditPath: root.auditPath } : {}),
  };
}

function rootFromRecord(record: Record<string, unknown>): DomainExpertWorkspaceRootPolicy {
  return normalizeRoot({
    rootId: requireString(record.root_id ?? record.rootId, 'root_id'),
    path: requireString(record.path, 'path'),
    maxWriteBytes: normalizePositiveInteger(record.max_write_bytes ?? record.maxWriteBytes, 100 * 1024 * 1024),
    allowOverwrite: record.allow_overwrite === true || record.allowOverwrite === true,
    ...(typeof record.audit_path === 'string' ? { auditPath: record.audit_path } : {}),
    ...(typeof record.auditPath === 'string' ? { auditPath: record.auditPath } : {}),
  });
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new DomainExpertWorkerError(400, 'invalid_config', 'Expected a positive integer.');
  return parsed;
}

function asDomainExpertTool(value: unknown): DomainExpertTool {
  if (
    value === 'domain_agent'
    || value === 'domain_ask'
    || value === 'domain_source'
    || value === 'rag_corpus'
    || value === 'domain_doc'
    || value === 'annas_archive_search'
    || value === 'annas_archive_import'
  ) return value;
  throw new DomainExpertWorkerError(400, 'invalid_tool', 'Unsupported domain expert tool.');
}

function optionalSourceKind(value: unknown): { sourceKind: NonNullable<DomainSourceParams['sourceKind']> } | Record<string, never> {
  if (value === undefined || value === null || value === '') return {};
  const sourceKind = String(value) as NonNullable<DomainSourceParams['sourceKind']>;
  if (!DOMAIN_SOURCE_KINDS.includes(sourceKind)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'kind is not a supported domain source kind.');
  }
  return { sourceKind };
}

function optionalAnnasFormat(value: unknown): { format: NonNullable<AnnasArchiveImportParams['format']> } | Record<string, never> {
  if (value === undefined || value === null || value === '') return {};
  const format = String(value) as NonNullable<AnnasArchiveImportParams['format']>;
  if (!ANNAS_ARCHIVE_FORMATS.includes(format)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'format is not a supported Anna Archive format.');
  }
  return { format };
}

function optionalAnnasFormatPreference(value: unknown): { formatPreference: NonNullable<AnnasArchiveSearchParams['formatPreference']> } | Record<string, never> {
  if (value === undefined || value === null || value === '') return {};
  const preference = String(value) as NonNullable<AnnasArchiveSearchParams['formatPreference']>;
  if (!['auto', 'text_rag', 'layout'].includes(preference)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'format_preference must be auto, text_rag, or layout.');
  }
  return { formatPreference: preference };
}

function optionalStringField<T extends string>(value: unknown, key: T): { [K in T]?: string } {
  return typeof value === 'string' && value.length > 0 ? { [key]: value } as { [K in T]?: string } : {};
}

function optionalBooleanField<T extends string>(value: unknown, key: T): { [K in T]?: boolean } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'boolean') return { [key]: value } as { [K in T]?: boolean };
  if (value === 'true' || value === '1' || value === 'yes') return { [key]: true } as { [K in T]?: boolean };
  if (value === 'false' || value === '0' || value === 'no') return { [key]: false } as { [K in T]?: boolean };
  throw new DomainExpertWorkerError(400, 'invalid_params', `${key} must be true or false.`);
}

function optionalTranscriptModeField(value: unknown): { transcriptMode?: NonNullable<RagCorpusParams['transcriptMode']> } {
  if (value === undefined || value === null || value === '') return {};
  const transcriptMode = optionalWebImportTranscriptMode(value);
  return transcriptMode ? { transcriptMode } : {};
}

function optionalNumberField<T extends string>(value: unknown, key: T): { [K in T]?: number } {
  if (value === undefined || value === null || value === '') return {};
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new DomainExpertWorkerError(400, 'invalid_params', `${key} must be a number.`);
  return { [key]: parsed } as { [K in T]?: number };
}

function asStringArray(value: unknown, name: string): string[] {
  if (Array.isArray(value)) return value.map((item) => requireString(item, name));
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be an array or comma-separated string.`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requireNumber(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be a number.`);
  return number;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/g, '') : `/${trimmed.replace(/\/+$/g, '')}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
