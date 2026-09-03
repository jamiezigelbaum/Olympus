import { OperationError } from './operation-error.ts';

export const DOMAIN_AGENT_ACTIONS = ['bootstrap', 'status'] as const;
export type DomainAgentAction = typeof DOMAIN_AGENT_ACTIONS[number];

export const DOMAIN_SOURCE_ACTIONS = ['add', 'list', 'status', 'remove'] as const;
export type DomainSourceAction = typeof DOMAIN_SOURCE_ACTIONS[number];

export const RAG_CORPUS_ACTIONS = ['create', 'import', 'stage_import', 'web_import', 'notion_import', 'list_files', 'delete_file', 'status', 'refresh'] as const;
export type RagCorpusAction = typeof RAG_CORPUS_ACTIONS[number];
export const WEB_IMPORT_TRANSCRIPT_MODES = ['auto', 'captions', 'asr'] as const;
export type WebImportTranscriptMode = typeof WEB_IMPORT_TRANSCRIPT_MODES[number];

export const DOMAIN_DOC_ACTIONS = [
  'read',
  'comment',
  'visual_insert',
  'visual_replace',
  'accept_visual_edits',
  'reject_visual_edits',
] as const;
export type DomainDocAction = typeof DOMAIN_DOC_ACTIONS[number];

export const DOMAIN_SOURCE_KINDS = [
  'book',
  'pdf',
  'epub',
  'google_doc',
  'blog_post',
  'transcript',
  'note',
  'dataset',
  'web_page',
  'unknown',
] as const;
export type DomainSourceKind = typeof DOMAIN_SOURCE_KINDS[number];

export const ANNAS_ARCHIVE_FORMATS = ['pdf', 'epub', 'mobi', 'azw3', 'djvu', 'unknown'] as const;
export type AnnasArchiveFormat = typeof ANNAS_ARCHIVE_FORMATS[number];

interface Color {
  red: number;
  green: number;
  blue: number;
}

export interface DomainVisualStyle {
  foreground_color: Color;
  background_color: Color;
  prefix_marker: string;
  companion_comment_required: boolean;
}

export interface DomainManifest {
  domain_id: string;
  display_name: string;
  workspace_root_id: string;
  workspace_relative_path: string;
  inbox_relative_path: string;
  library_aliases: string[];
  canonical_resource_paths: string[];
  gcp_project: string;
  rag_location: string;
  allowed_gcs_prefixes: string[];
  rag_backend: 'gemini_enterprise_rag_engine';
  corpora: Array<{ id: string; description: string }>;
  embedding_model: string;
  chunking: {
    parser: 'layout';
    chunk_tokens: number;
    chunk_overlap: number;
  };
  trust_posture: 'cloud_eligible_with_source_review';
  resource_wiki_namespace: string;
  eval_set: string;
  docs_service_account_mode: 'per_domain_service_account';
  visual_review_style: DomainVisualStyle;
}

export interface DomainAgentParams {
  action: DomainAgentAction;
  domainId?: string;
  displayName?: string;
  dryRun?: boolean;
}

export interface DomainAskParams {
  domainId?: string;
  question: string;
  corpusId?: string;
  corpora?: string[];
  maxResults?: number;
}

export interface DomainSourceParams {
  action: DomainSourceAction;
  domainId?: string;
  sourceId?: string;
  sourceKind?: DomainSourceKind;
  title?: string;
  author?: string;
  url?: string;
  relativePath?: string;
  corpusId?: string;
  trustPosture?: string;
  copyrightPosture?: string;
  includeHistory?: boolean;
  includeRemoved?: boolean;
  dryRun?: boolean;
}

export interface RagCorpusParams {
  action: RagCorpusAction;
  domainId?: string;
  corpusId?: string;
  ragFileName?: string;
  pageToken?: string;
  sourceId?: string;
  gcsUri?: string;
  driveFileId?: string;
  workspaceRelativePath?: string;
  batchId?: string;
  urls?: string[];
  pageIds?: string[];
  databaseIds?: string[];
  includeMedia?: boolean;
  transcriptMode?: WebImportTranscriptMode;
  dryRun?: boolean;
}

export interface DomainDocParams {
  action: DomainDocAction;
  domainId?: string;
  documentId: string;
  text?: string;
  comment?: string;
  rangeStart?: number;
  rangeEnd?: number;
  approvalId?: string;
  editBatchId?: string;
  dryRun?: boolean;
}

export interface AnnasArchiveSearchParams {
  domainId?: string;
  query?: string;
  topic?: string;
  title?: string;
  author?: string;
  maxResults?: number;
  topN?: number;
  formatPreference?: 'auto' | 'text_rag' | 'layout';
  language?: string;
}

export interface AnnasArchiveImportParams {
  domainId?: string;
  annasArchiveId?: string;
  url?: string;
  format?: AnnasArchiveFormat;
  corpusId?: string;
  title?: string;
  author?: string;
  year?: string;
  topic?: string;
  language?: string;
  fileName?: string;
  md5?: string;
  fileSizeBytes?: number;
  ingest?: boolean;
  copyrightPosture?: string;
  approvalId?: string;
  dryRun?: boolean;
}

const GOVERNANCE_DOMAIN_ID = 'governance';
const GOVERNANCE_AGENT_ID = 'solon';
const GOVERNANCE_DISPLAY_NAME = 'Solon';
const GOVERNANCE_WORKSPACE_RELATIVE_PATH = 'castor-solon';
const AGENT_WORKSHOP_SKILL = 'agent-workshop';
const GOVERNANCE_OPERATING_SKILL = 'governance-research';
/**
 * The cloud tenant a domain expert runs in is deployment configuration, not a
 * product constant: a Google Cloud project id and a GCS bucket name identify
 * the operator's tenant, so neither has a committed default. An unconfigured
 * runtime produces a manifest with no project and no allowed GCS prefix, and
 * every live path fails closed on that — Vertex requests refuse to build a URL
 * without a project, and `stage_import`/`assertAllowedGcsDestination` refuse an
 * empty allowlist.
 */
export const DOMAIN_GCP_PROJECT_ENV = 'OLYMPUS_DOMAIN_EXPERT_GCP_PROJECT';
/** Bucket name template; `{domain}` expands to the normalized domain id. */
export const DOMAIN_GCS_BUCKET_TEMPLATE_ENV = 'OLYMPUS_DOMAIN_EXPERT_GCS_BUCKET_TEMPLATE';
const DEFAULT_RAG_LOCATION = 'us-central1';
const RAG_BACKEND = 'gemini_enterprise_rag_engine';
const RUNTIME_SECRET_REF = 'OpenClaw SecretRef/1Password';
const ANNAS_ARCHIVE_SECRET_NAME = 'Annas-Archive-API-Key';

export function parseDomainAgentAction(value: unknown): DomainAgentAction {
  return parseEnum(value, DOMAIN_AGENT_ACTIONS, 'action');
}

export function parseDomainSourceAction(value: unknown): DomainSourceAction {
  return parseEnum(value, DOMAIN_SOURCE_ACTIONS, 'action');
}

export function parseRagCorpusAction(value: unknown): RagCorpusAction {
  return parseEnum(value, RAG_CORPUS_ACTIONS, 'action');
}

export function optionalWebImportTranscriptMode(value: unknown): WebImportTranscriptMode | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : parseEnum(value, WEB_IMPORT_TRANSCRIPT_MODES, 'transcript_mode');
}

export function parseDomainDocAction(value: unknown): DomainDocAction {
  return parseEnum(value, DOMAIN_DOC_ACTIONS, 'action');
}

export function optionalDomainSourceKind(value: unknown): DomainSourceKind | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : parseEnum(value, DOMAIN_SOURCE_KINDS, 'kind');
}

export function optionalAnnasArchiveFormat(value: unknown): AnnasArchiveFormat | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : parseEnum(value, ANNAS_ARCHIVE_FORMATS, 'format');
}

export function normalizeDomainId(value: string | undefined): string {
  const raw = (value ?? GOVERNANCE_DOMAIN_ID).trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw new OperationError('invalid_params', 'domain_id must contain at least one letter or number.');
  }
  if (normalized.length > 64) {
    throw new OperationError('invalid_params', 'domain_id must be 64 characters or fewer after normalization.');
  }
  return normalized;
}

export function domainManifest(domainIdValue?: string, displayNameValue?: string): DomainManifest {
  const domainId = normalizeDomainId(domainIdValue);
  const title = displayNameValue?.trim()
    || (domainId === GOVERNANCE_DOMAIN_ID ? GOVERNANCE_DISPLAY_NAME : `${titleCase(domainId)} Researcher`);
  const workspaceRelativePath = domainId === GOVERNANCE_DOMAIN_ID
    ? GOVERNANCE_WORKSPACE_RELATIVE_PATH
    : `castor-${domainId}-researcher`;
  const resourceName = domainId === GOVERNANCE_DOMAIN_ID
    ? 'Governance'
    : (title.replace(/\s+Researcher$/i, '').trim() || titleCase(domainId));
  return {
    domain_id: domainId,
    display_name: title,
    workspace_root_id: 'castor_workspace',
    workspace_relative_path: workspaceRelativePath,
    inbox_relative_path: `${workspaceRelativePath}/inbox`,
    library_aliases: [`${resourceName} alias`],
    canonical_resource_paths: domainId === GOVERNANCE_DOMAIN_ID
      ? ['3 Resources/Books/Governance', '3 Resources/Crypto/DAOs']
      : [`3 Resources/Books/${resourceName}`, `3 Resources/${resourceName}`],
    gcp_project: configuredGcpProject(),
    rag_location: DEFAULT_RAG_LOCATION,
    allowed_gcs_prefixes: configuredGcsPrefixes(domainId),
    rag_backend: RAG_BACKEND,
    corpora: defaultCorpora(domainId),
    embedding_model: 'gemini-embedding-2',
    chunking: {
      parser: 'layout',
      chunk_tokens: 512,
      chunk_overlap: 64,
    },
    trust_posture: 'cloud_eligible_with_source_review',
    resource_wiki_namespace: `03 Resources/${resourceName}`,
    eval_set: 'eval/questions.jsonl',
    docs_service_account_mode: 'per_domain_service_account',
    visual_review_style: visualStyle(domainId),
  };
}

export function planDomainAgent(params: DomainAgentParams): Record<string, unknown> {
  const manifest = domainManifest(params.domainId, params.displayName);
  const dryRun = params.dryRun ?? true;
  if (!dryRun) throwDomainBackendNotConfigured('domain_agent');
  return {
    kind: 'domain_agent_plan',
    status: params.action === 'bootstrap' ? 'dry_run_scaffold_ready' : 'dry_run_status_ready',
    action: params.action,
    domain: manifest,
    workspace_scaffold: {
      root_id: manifest.workspace_root_id,
      relative_path: manifest.workspace_relative_path,
      directories: bootstrapDirectories(manifest),
      files: bootstrapFiles(manifest),
      aliases_to_create: manifest.library_aliases.map((alias, index) => ({
        alias,
        target_hint: manifest.canonical_resource_paths[index] ?? manifest.canonical_resource_paths[0],
      })),
    },
    openclaw_agent: {
      agent_id: manifest.domain_id === GOVERNANCE_DOMAIN_ID ? GOVERNANCE_AGENT_ID : manifest.domain_id,
      display_name: manifest.display_name,
      workspace: manifest.workspace_relative_path,
      created_by_skill: AGENT_WORKSHOP_SKILL,
      operating_skill: operatingSkillForDomain(manifest.domain_id),
      scoped_tools: [
        'domain_ask',
        'domain_source',
        'rag_corpus',
        'domain_doc',
        'annas_archive_search',
        'annas_archive_import',
        'castor_workspace',
      ],
    },
    policy: domainPolicy(),
    next_steps: [
      'Materialize these paths through the bounded castor_workspace worker or live OpenClaw runtime.',
      'Share a test Google Doc with the per-domain service account before enabling document edits.',
      'Create or verify Gemini Enterprise RAG corpora before asking grounded questions.',
    ],
  };
}

function operatingSkillForDomain(domainId: string): string {
  return domainId === GOVERNANCE_DOMAIN_ID ? GOVERNANCE_OPERATING_SKILL : `${domainId}-research`;
}

export function planDomainAsk(params: DomainAskParams): Record<string, unknown> {
  const manifest = domainManifest(params.domainId);
  const question = requireNonEmpty(params.question, 'question');
  const corpora = params.corpusId
    ? [params.corpusId]
    : (params.corpora?.length ? params.corpora : manifest.corpora.map((corpus) => corpus.id));
  return {
    kind: 'domain_ask_plan',
    status: 'requires_gemini_enterprise_rag_backend',
    domain: compactDomain(manifest),
    question,
    retrieval: {
      backend: manifest.rag_backend,
      gcp_project: manifest.gcp_project,
      location: manifest.rag_location,
      corpora,
      max_results: params.maxResults ?? 12,
      cross_corpus_retrieval: true,
    },
    expected_output: {
      answer: true,
      citations: true,
      unanswered_gaps: true,
      source_registry_refs: true,
    },
    policy: domainPolicy(),
    next_steps: [
      'Wire this plan to Gemini Enterprise RAG Engine Cross-Corpus Retrieval in the OpenClaw runtime.',
      'Return cited answers and explicit gaps; do not add domain-specific answer code in Olympus.',
    ],
  };
}

export function planDomainSource(params: DomainSourceParams): Record<string, unknown> {
  const manifest = domainManifest(params.domainId);
  const dryRun = params.dryRun ?? true;
  if (!dryRun) throwDomainBackendNotConfigured('domain_source');
  validateDomainSourceRequest(params);
  const sourceId = params.sourceId ?? plannedSourceId(manifest.domain_id, params);
  return {
    kind: 'domain_source_plan',
    status: 'dry_run_source_lifecycle_ready',
    action: params.action,
    domain: compactDomain(manifest),
    source_record: {
      source_id: sourceId,
      domain_id: manifest.domain_id,
      kind: params.sourceKind ?? 'unknown',
      ...(params.title ? { title: params.title } : {}),
      ...(params.author ? { author: params.author } : {}),
      ...(params.url ? { canonical_url: params.url } : {}),
      ...(params.relativePath ? { workspace_relative_path: params.relativePath } : {}),
      ...(params.corpusId ? { target_corpus_id: params.corpusId } : {}),
      trust_posture: params.trustPosture ?? manifest.trust_posture,
      ...(params.copyrightPosture ? { copyright_posture: params.copyrightPosture } : {}),
      ingest_status: params.action === 'add' ? 'planned' : 'lookup_planned',
    },
    ingest_pipeline: [
      'classify trust and copyright posture',
      'dedupe against source-registry.jsonl',
      'convert or extract text where needed',
      'stage eligible artifacts under the allowed GCS prefix',
      'import into the selected Gemini Enterprise corpus',
      'append source-registry.jsonl and ingest-log.md',
    ],
    policy: domainPolicy(),
  };
}

export function planRagCorpus(params: RagCorpusParams): Record<string, unknown> {
  const manifest = domainManifest(params.domainId);
  const dryRun = params.dryRun ?? true;
  if (!dryRun) throwDomainBackendNotConfigured('rag_corpus');
  validateRagCorpusRequest(params);
  validateGcsUri(manifest, params.gcsUri);
  const corpusId = params.corpusId ?? defaultCorpusId(manifest, params.action);
  const stageImport = params.action === 'stage_import'
    ? {
        workspace_relative_path: params.workspaceRelativePath,
        batch_id: params.batchId,
        recursive: true,
        include_media: params.includeMedia ?? false,
        eligible_extensions: params.includeMedia
          ? ['md', 'txt', 'pdf', 'html', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'mp4', 'mov', 'webm']
          : ['md', 'txt', 'pdf', 'html'],
        max_file_bytes: 10 * 1024 * 1024,
        max_batch_bytes: 100 * 1024 * 1024,
        media_max_file_bytes: 200 * 1024 * 1024,
        media_bytes_count_against_text_batch_cap: false,
        destination_prefix: `${manifest.allowed_gcs_prefixes[0] ?? '<missing-allowed-gcs-prefix>'}/staged/${manifest.domain_id}/${params.batchId ?? '<generated-batch-id>'}/`,
      }
    : undefined;
  const webImport = params.action === 'web_import'
    ? {
        urls: params.urls,
        batch_id: params.batchId,
        include_media: params.includeMedia ?? false,
        transcript_mode: params.transcriptMode ?? 'auto',
        workspace_relative_path: `${manifest.workspace_relative_path}/sources/web-imports/${params.batchId ?? '<generated-batch-id>'}`,
        target_corpus_id: corpusId,
        handler_table: ['youtube', 'direct-file', 'generic-html'],
        youtube_media_transcripts: 'yt-dlp captions first, Gemini ASR fallback through GCS-staged media',
        media_max_file_bytes: 200 * 1024 * 1024,
        media_bytes_count_against_text_batch_cap: false,
        destination_prefix: `${manifest.allowed_gcs_prefixes[0] ?? '<missing-allowed-gcs-prefix>'}/staged/${manifest.domain_id}/${params.batchId ?? '<generated-batch-id>'}/`,
    }
    : undefined;
  const notionImport = params.action === 'notion_import'
    ? {
        urls: params.urls,
        page_ids: params.pageIds,
        database_ids: params.databaseIds,
        batch_id: params.batchId,
        workspace_relative_path: `${manifest.workspace_relative_path}/sources/notion-imports/${params.batchId ?? '<generated-batch-id>'}`,
        target_corpus_id: corpusId,
        api: {
          base_url: 'https://api.notion.com/v1',
          notion_version: '2022-06-28',
          object_cap_default: 200,
          recursive_block_depth_default: 6,
        },
        destination_prefix: `${manifest.allowed_gcs_prefixes[0] ?? '<missing-allowed-gcs-prefix>'}/staged/${manifest.domain_id}/${params.batchId ?? '<generated-batch-id>'}/`,
      }
    : undefined;
  return {
    kind: 'rag_corpus_plan',
    status: 'dry_run_corpus_lifecycle_ready',
    action: params.action,
    domain: compactDomain(manifest),
    corpus: {
      corpus_id: corpusId,
      backend: manifest.rag_backend,
      gcp_project: manifest.gcp_project,
      location: manifest.rag_location,
      embedding_model: manifest.embedding_model,
      chunking: manifest.chunking,
      ...(params.gcsUri ? { gcs_uri: params.gcsUri } : {}),
      ...(params.driveFileId ? { drive_file_id: params.driveFileId } : {}),
      ...(params.ragFileName ? { rag_file_name: params.ragFileName } : {}),
      ...(params.pageToken ? { page_token: params.pageToken } : {}),
      ...(params.sourceId ? { source_id: params.sourceId } : {}),
      ...(stageImport ? { stage_import: stageImport } : {}),
      ...(webImport ? { web_import: webImport } : {}),
      ...(notionImport ? { notion_import: notionImport } : {}),
    },
    allowed_gcs_prefixes: manifest.allowed_gcs_prefixes,
    policy: domainPolicy(),
    next_steps: [
      'Resolve Google credentials through the OpenClaw runtime secret provider.',
      'Use Gemini Enterprise RAG Engine corpus lifecycle APIs, then record corpus state in the domain registry.',
    ],
  };
}

export function planDomainDoc(params: DomainDocParams): Record<string, unknown> {
  const manifest = domainManifest(params.domainId);
  const dryRun = params.dryRun ?? true;
  validateDomainDocRequest(params, dryRun);
  if (!dryRun) throwDomainBackendNotConfigured('domain_doc');
  return {
    kind: 'domain_doc_plan',
    status: 'dry_run_google_doc_operation_ready',
    action: params.action,
    domain: compactDomain(manifest),
    document: {
      document_id: params.documentId,
      service_account_mode: manifest.docs_service_account_mode,
      credentials: RUNTIME_SECRET_REF,
      ...(params.rangeStart !== undefined ? { range_start: params.rangeStart } : {}),
      ...(params.rangeEnd !== undefined ? { range_end: params.rangeEnd } : {}),
      ...(params.editBatchId ? { edit_batch_id: params.editBatchId } : {}),
    },
    requested_change: {
      ...(params.text ? { text: params.text } : {}),
      ...(params.comment ? { comment: params.comment } : {}),
      ...(params.approvalId ? { approval_id: params.approvalId } : {}),
    },
    visual_review_style: manifest.visual_review_style,
    google_docs_posture: {
      native_suggestion_mode_created_by_api: false,
      comments_supported_path: true,
      direct_visual_edits_supported_path: true,
      direct_visual_edits_require_approval: true,
    },
    policy: domainPolicy(),
  };
}

export function planAnnasArchiveImport(params: AnnasArchiveImportParams): Record<string, unknown> {
  const manifest = domainManifest(params.domainId);
  const dryRun = params.dryRun ?? true;
  const locator = firstNonEmpty(params.annasArchiveId, params.url);
  if (!locator) {
    throw new OperationError('invalid_params', 'Provide annas_archive_id or url for annas_archive_import.');
  }
  if (!params.copyrightPosture?.trim()) {
    throw new OperationError(
      'domain_expert_policy_violation',
      'annas_archive_import requires an explicit copyright_posture before any download/import plan.',
    );
  }
  if (!dryRun && !params.approvalId?.trim()) {
    throw new OperationError(
      'domain_expert_policy_violation',
      'annas_archive_import with dry_run=false requires approval_id.',
    );
  }
  if (!dryRun) throwDomainBackendNotConfigured('annas_archive_import');
  return {
    kind: 'annas_archive_import_plan',
    status: 'dry_run_acquisition_ready',
    domain: compactDomain(manifest),
    acquisition: {
      ...(params.annasArchiveId ? { annas_archive_id: params.annasArchiveId } : {}),
      ...(params.url ? { url: params.url } : {}),
      ...(params.md5 ? { md5: params.md5 } : {}),
      ...(params.title ? { title: params.title } : {}),
      ...(params.author ? { author: params.author } : {}),
      ...(params.year ? { year: params.year } : {}),
      ...(params.topic ? { topic: params.topic } : {}),
      ...(params.language ? { language: params.language } : {}),
      ...(params.fileName ? { file_name: params.fileName } : {}),
      ...(params.fileSizeBytes !== undefined ? { file_size_bytes: params.fileSizeBytes } : {}),
      format: params.format ?? 'unknown',
      copyright_posture: params.copyrightPosture,
      destination: 'xanthos_books_folder',
      deterministic_layout: 'topic/Author - Title (Year)/filename',
    },
    rag_ingest: params.ingest
      ? (params.corpusId
          ? { status: 'planned', target_corpus_id: params.corpusId }
          : {
              status: 'needs_corpus_decision',
              reason: 'No explicit corpus_id was provided for RAG ingest.',
            })
      : { status: 'not_requested' },
    format_preference: {
      default: 'epub_for_text_first_rag_pdf_for_layout_heavy',
      configurable: true,
    },
    runtime_secret: {
      provider: RUNTIME_SECRET_REF,
      name: ANNAS_ARCHIVE_SECRET_NAME,
      exposed_to_agent: false,
    },
    ingest_pipeline: [
      'download approved file inside Castor runtime worker',
      'save into the Xanthos books folder without overwriting existing files',
      'audit selected/downloaded/skipped path and hashes',
      'optionally stage/import into an explicit Gemini Enterprise RAG corpus',
      'record source and ingest status in the domain registry when a corpus is chosen',
    ],
    policy: domainPolicy(),
  };
}

function parseEnum<T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new OperationError('invalid_params', `${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T[number];
}

function defaultCorpora(domainId: string): DomainManifest['corpora'] {
  if (domainId === GOVERNANCE_DOMAIN_ID) {
    return [
      {
        id: 'governance-jamie-docs',
        description: "Single Solon governance corpus for the owner's governance writing, essays by Vitalik and other authors, and governance books; author attribution lives on source records and display names.",
      },
    ];
  }
  return [
    { id: `${domainId}-library`, description: `${titleCase(domainId)} books, PDFs, and long-form references` },
    { id: `${domainId}-web`, description: `${titleCase(domainId)} canonical web and blog sources` },
    { id: `${domainId}-notes`, description: `${titleCase(domainId)} owner-authored notes and working docs` },
  ];
}

function visualStyle(domainId: string): DomainVisualStyle {
  if (domainId === GOVERNANCE_DOMAIN_ID) {
    return {
      foreground_color: { red: 0.32, green: 0.2, blue: 0.72 },
      background_color: { red: 0.9, green: 0.87, blue: 1 },
      prefix_marker: '[Solon]',
      companion_comment_required: true,
    };
  }
  return {
    foreground_color: { red: 0.22, green: 0.32, blue: 0.72 },
    background_color: { red: 0.88, green: 0.92, blue: 1 },
    prefix_marker: `[${titleCase(domainId)}]`,
    companion_comment_required: true,
  };
}

export function domainPolicy(): Record<string, unknown> {
  return {
    olympus_control_plane_only: true,
    backend: RAG_BACKEND,
    source_pipeline_contracts_unchanged: true,
    per_question_answer_logic_in_olympus: false,
    raw_runtime_secrets_exposed: false,
    cloud_corpus_requires_source_review: true,
    direct_google_doc_edits_require_approval: true,
  };
}

function compactDomain(manifest: DomainManifest): Record<string, unknown> {
  return {
    domain_id: manifest.domain_id,
    display_name: manifest.display_name,
    workspace_root_id: manifest.workspace_root_id,
    workspace_relative_path: manifest.workspace_relative_path,
    rag_backend: manifest.rag_backend,
    gcp_project: manifest.gcp_project,
    rag_location: manifest.rag_location,
    corpora: manifest.corpora,
  };
}

function bootstrapDirectories(manifest: DomainManifest): string[] {
  const root = manifest.workspace_relative_path;
  return [
    root,
    `${root}/inbox`,
    `${root}/references`,
    `${root}/templates`,
    `${root}/eval`,
    `${root}/outputs`,
    `${root}/outputs/briefs`,
    `${root}/outputs/resource-wiki-proposals`,
  ];
}

function bootstrapFiles(manifest: DomainManifest): Array<Record<string, unknown>> {
  const root = manifest.workspace_relative_path;
  return [
    { relative_path: `${root}/PROPOSAL.md`, kind: 'operating_doctrine' },
    { relative_path: `${root}/domain.manifest.json`, kind: 'domain_manifest', content_preview: manifest },
    { relative_path: `${root}/references/source-registry.jsonl`, kind: 'source_registry' },
    { relative_path: `${root}/references/ingest-log.md`, kind: 'ingest_log' },
    { relative_path: `${root}/references/reading-map.md`, kind: 'reading_map' },
    { relative_path: `${root}/references/retrieval-craft.md`, kind: 'agent_retrieval_guidance' },
    { relative_path: `${root}/templates/source-card.md`, kind: 'template' },
    { relative_path: `${root}/templates/research-brief.md`, kind: 'template' },
    { relative_path: `${root}/templates/literature-review.md`, kind: 'template' },
    { relative_path: `${root}/templates/disagreement-map.md`, kind: 'template' },
    { relative_path: `${root}/eval/questions.jsonl`, kind: 'eval_seed' },
  ];
}

function validateDomainSourceRequest(params: DomainSourceParams): void {
  if (params.action === 'add' && !firstNonEmpty(params.url, params.relativePath)) {
    throw new OperationError('invalid_params', 'domain_source add requires url or relative_path.');
  }
  if ((params.action === 'status' || params.action === 'remove') && !params.sourceId?.trim()) {
    throw new OperationError('invalid_params', `domain_source ${params.action} requires source_id.`);
  }
}

function validateDomainDocRequest(params: DomainDocParams, dryRun: boolean): void {
  requireNonEmpty(params.documentId, 'document_id');
  if ((params.action === 'comment') && !params.comment?.trim()) {
    throw new OperationError('invalid_params', 'domain_doc comment requires comment.');
  }
  if ((params.action === 'visual_insert' || params.action === 'visual_replace') && !params.text?.trim()) {
    throw new OperationError('invalid_params', `domain_doc ${params.action} requires text.`);
  }
  if (params.action === 'visual_replace' && (params.rangeStart === undefined || params.rangeEnd === undefined)) {
    throw new OperationError('invalid_params', 'domain_doc visual_replace requires range_start and range_end.');
  }
  if ((params.action === 'visual_insert' || params.action === 'visual_replace') && !dryRun && !params.approvalId?.trim()) {
    throw new OperationError(
      'domain_expert_policy_violation',
      `domain_doc ${params.action} with dry_run=false requires approval_id.`,
    );
  }
}

function validateRagCorpusRequest(params: RagCorpusParams): void {
  if (params.action === 'stage_import' && !params.workspaceRelativePath?.trim()) {
    throw new OperationError('invalid_params', 'rag_corpus stage_import requires workspace_relative_path.');
  }
  if (params.action === 'web_import') {
    if (!params.corpusId?.trim()) {
      throw new OperationError('invalid_params', 'rag_corpus web_import requires corpus_id.');
    }
    if (!params.urls || params.urls.length === 0 || params.urls.length > 200) {
      throw new OperationError('invalid_params', 'rag_corpus web_import requires urls with 1 to 200 entries.');
    }
    for (const url of params.urls) {
      requireNonEmpty(url, 'urls');
    }
  }
  if (params.action === 'notion_import') {
    if (!params.corpusId?.trim()) {
      throw new OperationError('invalid_params', 'rag_corpus notion_import requires corpus_id.');
    }
    const sourceCount = (params.urls?.length ?? 0) + (params.pageIds?.length ?? 0) + (params.databaseIds?.length ?? 0);
    if (sourceCount === 0) {
      throw new OperationError('invalid_params', 'rag_corpus notion_import requires urls, page_ids, or database_ids.');
    }
    if (sourceCount > 200) {
      throw new OperationError('invalid_params', 'rag_corpus notion_import accepts at most 200 starting objects.');
    }
    for (const url of params.urls ?? []) requireNonEmpty(url, 'urls');
    for (const pageId of params.pageIds ?? []) requireNonEmpty(pageId, 'page_ids');
    for (const databaseId of params.databaseIds ?? []) requireNonEmpty(databaseId, 'database_ids');
  }
  if (params.action === 'delete_file') {
    requireNonEmpty(params.ragFileName, 'rag_file_name');
  }
}

function validateGcsUri(manifest: DomainManifest, gcsUri: string | undefined): void {
  if (!gcsUri) return;
  if (!gcsUri.startsWith('gs://')) {
    throw new OperationError('invalid_params', 'gcs_uri must start with gs://.');
  }
  if (!manifest.allowed_gcs_prefixes.some((prefix) => gcsUri === prefix || gcsUri.startsWith(`${prefix}/`))) {
    throw new OperationError(
      'domain_expert_policy_violation',
      `gcs_uri must be inside one of the domain allowlisted prefixes: ${manifest.allowed_gcs_prefixes.join(', ')}.`,
    );
  }
}

function plannedSourceId(domainId: string, params: DomainSourceParams): string {
  const basis = firstNonEmpty(params.url, params.relativePath, params.title, params.author) ?? 'source';
  return `${domainId}-${slugify(basis).slice(0, 48)}-${stableShortHash(basis)}`;
}

function defaultCorpusId(manifest: DomainManifest, action: RagCorpusAction | 'import'): string {
  if (action === 'import' || action === 'stage_import' || action === 'web_import' || action === 'notion_import') {
    const books = manifest.corpora.find((corpus) => corpus.id.endsWith('-books') || corpus.id.endsWith('-library'));
    return books?.id ?? manifest.corpora[0]?.id ?? `${manifest.domain_id}-library`;
  }
  return manifest.corpora[0]?.id ?? `${manifest.domain_id}-library`;
}

/** Google Cloud project ids: 6-30 chars, lowercase start, no trailing hyphen. */
export const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** `google` and the near-misses Google reserves alongside it. */
const GOOGLE_RESTRICTED_SUBSTRING = /g[o0]{2}gle/;
/** Words Google documents as unusable in a project id. */
const GCP_PROJECT_ID_RESERVED_WORDS = ['ssl', 'null', 'undefined'];

/**
 * Google's own naming rules, not just a shape check. Both name spaces reserve
 * strings, and a name that violates a reserved-string rule is rejected at
 * create time — so accepting it here would only move the failure to a live
 * call. Rules per Google's project and bucket naming documentation.
 */
export function gcpProjectIdProblem(value: string): string | undefined {
  if (!GCP_PROJECT_ID_PATTERN.test(value)) {
    return 'it must be 6-30 characters, start with a lowercase letter, use only lowercase letters, digits and hyphens, and not end with a hyphen';
  }
  const reserved = GCP_PROJECT_ID_RESERVED_WORDS.find((word) => value.includes(word));
  if (GOOGLE_RESTRICTED_SUBSTRING.test(value)) {
    return 'it must not contain the restricted string "google" or a near-miss spelling of it';
  }
  if (reserved) return `it must not contain the restricted string "${reserved}"`;
  return undefined;
}

/**
 * GCS bucket naming. The length floor is on the WHOLE name, not on each
 * dot-separated component — `x.example.com` is a legal domain-scoped bucket
 * even though its first component is one character. Components carry only the
 * 63-character ceiling and the alphanumeric-ends rule. A dotted name has to be
 * a valid DNS name, which rules out underscores that a flat name may use.
 */
export function gcsBucketNameProblem(value: string): string | undefined {
  const components = value.split('.');
  const dotted = components.length > 1;
  if (value.length < 3) return 'a bucket name must be at least 3 characters';
  if (value.length > (dotted ? 222 : 63)) {
    return dotted
      ? 'a dotted bucket name must be at most 222 characters'
      : 'a bucket name must be at most 63 characters';
  }
  // Dotted names are DNS names, so no underscores anywhere in them.
  const componentPattern = dotted
    ? /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
    : /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
  const badComponent = components.find((component) => component.length > 63 || !componentPattern.test(component));
  if (badComponent !== undefined) {
    return dotted
      ? 'each dot-separated component must be 1-63 characters, start and end with a lowercase letter or digit, and use only lowercase letters, digits and hyphens, because a dotted name must be DNS-valid'
      : 'it must be lowercase letters, digits, hyphens, underscores and dots, and start and end with a letter or digit';
  }
  if (components.length === 4 && components.every((component) => /^\d{1,3}$/.test(component) && Number(component) <= 255)) {
    return 'it must not be formatted like a dotted-decimal IP address';
  }
  if (value.startsWith('goog')) return 'it must not start with the reserved prefix "goog"';
  if (GOOGLE_RESTRICTED_SUBSTRING.test(value)) {
    return 'it must not contain "google" or a near-miss spelling of it';
  }
  return undefined;
}

/**
 * Unset means "no cloud tenant configured" and fails closed downstream. A value
 * that is *present but not a project id* — a `<project-id>` placeholder copied
 * out of an example config, a full resource path, a display name — is a
 * configuration mistake, and silently treating it as a literal would send
 * requests to a resource path that cannot exist. Reject it here instead.
 */
function configuredGcpProject(env: Record<string, string | undefined> = process.env): string {
  const value = env[DOMAIN_GCP_PROJECT_ENV]?.trim() ?? '';
  if (!value) return '';
  const problem = gcpProjectIdProblem(value);
  if (problem) {
    throw new OperationError(
      'config_error',
      `${DOMAIN_GCP_PROJECT_ENV} is not a Google Cloud project id: ${problem}.`,
      'Set it to the bare project id — not a placeholder, project number, or resource path.',
    );
  }
  return value;
}

function configuredGcsPrefixes(
  domainId: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const template = env[DOMAIN_GCS_BUCKET_TEMPLATE_ENV]?.trim();
  if (!template) return [];
  const bucket = template
    .replaceAll('{domain}', domainId)
    .replace(/^gs:\/\//, '')
    .replace(/\/+$/, '')
    .trim();
  if (!bucket) return [];
  const bucketProblem = gcsBucketNameProblem(bucket);
  if (bucketProblem) {
    throw new OperationError(
      'config_error',
      `${DOMAIN_GCS_BUCKET_TEMPLATE_ENV} does not expand to a GCS bucket name: ${bucketProblem}.`,
      `It expanded to "${bucket}". Set it to a bucket name, optionally containing {domain} — not a placeholder or a full gs:// object path.`,
    );
  }
  return [`gs://${bucket}`];
}

function throwDomainBackendNotConfigured(toolName: string): never {
  throw new OperationError(
    'domain_expert_not_configured',
    `${toolName} live execution is not configured in this Olympus runtime yet.`,
    'Use dry_run=true for the Phase 0 control-plane plan, or wire the OpenClaw runtime worker for Google/Gemini/Anna access.',
  );
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationError('invalid_params', `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

function stableShortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}
