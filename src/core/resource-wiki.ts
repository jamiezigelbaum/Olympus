import { lstat, mkdir, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RESOURCE_WIKI_GENERATOR_ID = 'olympus.resource-wiki.compiler';
export const RESOURCE_WIKI_MODEL_LANE = 'model_authored_synthesis';
export const RESOURCE_WIKI_LAYOUT_DIRS = ['00 Meta', '01 Projects', '02 Areas', '03 Resources', '04 Archive'] as const;

export const RESOURCE_WIKI_SOURCE_FAMILIES = ['docs', 'research_notes', 'operator_notes', 'readwise', 'x'] as const;
export const RESOURCE_WIKI_KNOWLEDGE_ROLES = [
  'claim',
  'definition',
  'current_state',
  'pattern',
  'rationale',
  'attention_signal',
  'constraint',
  'implementation_context',
  'castor_take',
  'source_quality',
  'open_question',
  'related_page',
] as const;
export const RESOURCE_WIKI_RESOURCE_KINDS = ['topic', 'technical_landscape', 'product_research', 'operating_note'] as const;
export const RESOURCE_WIKI_TRUST_DOMAINS = ['public_safe', 'internal'] as const;
export const RESOURCE_WIKI_SENSITIVITY_LEVELS = ['public_safe', 'internal_notes'] as const;
export const RESOURCE_WIKI_REVIEW_STATUSES = ['proposed', 'experimental', 'needs_review', 'reviewed'] as const;

export type ResourceWikiSourceFamily = (typeof RESOURCE_WIKI_SOURCE_FAMILIES)[number] | `x-${string}`;
export type ResourceWikiKnowledgeRole = (typeof RESOURCE_WIKI_KNOWLEDGE_ROLES)[number] | `x-${string}`;
export type ResourceWikiResourceKind = (typeof RESOURCE_WIKI_RESOURCE_KINDS)[number] | `x-${string}`;
export type ResourceWikiTrustDomain = (typeof RESOURCE_WIKI_TRUST_DOMAINS)[number] | `x-${string}`;
export type ResourceWikiSensitivity = (typeof RESOURCE_WIKI_SENSITIVITY_LEVELS)[number] | `x-${string}`;
export type ResourceWikiReviewStatus = (typeof RESOURCE_WIKI_REVIEW_STATUSES)[number] | `x-${string}`;

export interface ResourceWikiSourceRef {
  id: string;
  family: ResourceWikiSourceFamily;
  label: string;
  provider: 'fixture' | 'manual' | 'readwise' | 'x' | `x-${string}`;
  corpusId?: string;
  providerItemId?: string;
  uri?: string;
  folderNames?: string[];
  trustDomain: ResourceWikiTrustDomain;
  sensitivity: ResourceWikiSensitivity;
  validAsOf: string;
}

export interface ResourceWikiEvidencePoint {
  id: string;
  sourceRefIds: string[];
  knowledgeRoles: ResourceWikiKnowledgeRole[];
  summary: string;
}

export interface ResourceWikiEvidencePacket {
  packetId: string;
  title: string;
  canonicalId: string;
  resourceKind: ResourceWikiResourceKind;
  trustDomain: ResourceWikiTrustDomain;
  sensitivity: ResourceWikiSensitivity;
  validAsOf: string;
  sourceRefs: ResourceWikiSourceRef[];
  evidence: ResourceWikiEvidencePoint[];
  whatChanged: string[];
}

export interface ResourceWikiModelAuthoredBodySection {
  heading: string;
  markdown: string;
}

export interface ResourceWikiModelAuthoredBody {
  lead: string;
  sections: ResourceWikiModelAuthoredBodySection[];
  relatedPages: string[];
}

export interface ResourceWikiPageMetadata {
  type: 'resource_wiki_page';
  canonical_id: string;
  resource_kind: ResourceWikiResourceKind;
  trust_domain: ResourceWikiTrustDomain;
  sensitivity: ResourceWikiSensitivity;
  review_status: ResourceWikiReviewStatus;
  generated_by: typeof RESOURCE_WIKI_GENERATOR_ID;
  model_lane: typeof RESOURCE_WIKI_MODEL_LANE;
  last_compiled_at: string;
  valid_as_of: string;
  source_refs: ResourceWikiSourceRef[];
  knowledge_roles: ResourceWikiKnowledgeRole[];
  what_changed: string[];
}

export interface ResourceWikiRenderedMarkdown {
  path: string;
  title: string;
  metadata: ResourceWikiPageMetadata;
  markdown: string;
}

export interface ResourceWikiCompileLogEntry {
  compiled_at: string;
  generator: typeof RESOURCE_WIKI_GENERATOR_ID;
  vault_root: string;
  reset_vault: boolean;
  pages_written: string[];
  directories_ensured: string[];
}

export interface ResourceWikiCompileLog {
  path: string;
  markdown: string;
  entry: ResourceWikiCompileLogEntry;
}

export interface ResourceWikiCompileResult {
  pages: ResourceWikiRenderedMarkdown[];
  log: ResourceWikiCompileLog;
  layoutDirs: readonly string[];
}

export interface ResourceWikiPageCompileInput {
  packet: ResourceWikiEvidencePacket;
  path: string;
  reviewStatus: ResourceWikiReviewStatus;
  body: ResourceWikiModelAuthoredBody;
}

export interface ResourceWikiCompileOptions {
  pages: ResourceWikiPageCompileInput[];
  compiledAt?: string;
  vaultRoot?: string;
  resetVault?: boolean;
}

export interface ResourceWikiWriteOptions {
  vaultRoot: string;
  resetVault?: boolean;
  compiledAt?: string;
}

export interface ResourceWikiWritePagesOptions extends ResourceWikiWriteOptions {
  pages: ResourceWikiPageCompileInput[];
}

export interface ResourceWikiWriteResult extends ResourceWikiCompileResult {
  vaultRoot: string;
}

export function createOpenClawMemorySolutionsPacket(validAsOf = '2026-05-19'): ResourceWikiEvidencePacket {
  return {
    packetId: 'rw-proof.openclaw-memory-solutions',
    title: 'OpenClaw Memory Solutions',
    canonicalId: 'resource-wiki/openclaw-memory-solutions',
    resourceKind: 'technical_landscape',
    trustDomain: 'internal',
    sensitivity: 'internal_notes',
    validAsOf,
    sourceRefs: [
      {
        id: 'docs.openclaw-memory',
        family: 'docs',
        label: 'Public-safe OpenClaw memory architecture notes',
        provider: 'fixture',
        trustDomain: 'internal',
        sensitivity: 'internal_notes',
        validAsOf,
      },
      {
        id: 'notes.castor-research',
        family: 'research_notes',
        label: 'Researcher synthesis notes for Castor memory work',
        provider: 'fixture',
        trustDomain: 'internal',
        sensitivity: 'internal_notes',
        validAsOf,
      },
    ],
    evidence: [
      {
        id: 'shape',
        sourceRefIds: ['docs.openclaw-memory'],
        knowledgeRoles: ['definition', 'current_state'],
        summary:
          'OpenClaw memory should be treated as layered product infrastructure: short-lived session state, curated project knowledge, and source-backed retrieval all serve different user jobs.',
      },
      {
        id: 'patterns',
        sourceRefIds: ['docs.openclaw-memory', 'notes.castor-research'],
        knowledgeRoles: ['pattern'],
        summary:
          'The strongest pattern is provenance-first memory. Pages should explain where claims came from, why they matter, and what changed since the last compilation.',
      },
      {
        id: 'castor-take',
        sourceRefIds: ['notes.castor-research'],
        knowledgeRoles: ['castor_take'],
        summary:
          'Castor should consume Resource Wiki pages as clean synthesis, not as a raw packet mirror. Source families describe origin; knowledge roles describe how the synthesized claim is being used.',
      },
      {
        id: 'questions',
        sourceRefIds: ['notes.castor-research'],
        knowledgeRoles: ['open_question', 'related_page'],
        summary:
          'The next proof should decide how freshness, review ownership, and user-visible correction loops appear inside ordinary Obsidian reading and editing.',
      },
    ],
    whatChanged: [
      'Created the first bounded Resource Wiki proof page.',
      'Separated source families from knowledge roles in page metadata.',
      'Separated model-authored page body from deterministic compiler metadata and vault writes.',
    ],
  };
}

export function createOpenClawMemorySolutionsModelAuthoredBody(): ResourceWikiModelAuthoredBody {
  return {
    lead:
      'OpenClaw memory is best understood as product infrastructure, not one generic memory bucket. The useful split is between short-lived session continuity, curated project knowledge, and source-backed retrieval, because each layer answers a different user job and carries a different review burden.[^shape]',
    sections: [
      {
        heading: 'Current Shape',
        markdown:
          'Olympus should treat Resource Wiki pages as the clean reading layer over source evidence. The page is allowed to synthesize, name patterns, and decide what matters, while the compiler keeps source refs, review state, and trust-domain metadata attached in a predictable way.[^shape]',
      },
      {
        heading: 'Main Patterns',
        markdown:
          'The strongest pattern is provenance-first synthesis. A useful page should say where a claim came from, why it matters now, and what changed since the last compilation instead of copying packet fields into Obsidian.[^patterns]',
      },
      {
        heading: 'Current Castor Take',
        markdown:
          'Castor should read these pages as concise operating knowledge. Source families describe origin; knowledge roles describe how the claim is being used. Keeping those separate lets an email, bookmark, highlight, or doc all contribute definitions, open questions, decisions, or implementation context without flattening the source model.[^castor-take]',
      },
      {
        heading: 'Open Questions',
        markdown:
          'The next product question is the correction loop: when the owner edits a page in Obsidian, Olympus needs to preserve the human edit, track what evidence was superseded, and avoid silently regenerating over durable human judgment.[^questions]',
      },
    ],
    relatedPages: ['[[00 Meta/Resource Wiki/log|Resource Wiki compile log]]'],
  };
}

export function compileResourceWikiProof(options: { compiledAt?: string } = {}): ResourceWikiCompileResult {
  const compiledAt = options.compiledAt ?? new Date().toISOString();
  const packet = createOpenClawMemorySolutionsPacket(compiledAt.slice(0, 10));
  return compileResourceWikiPages({
    compiledAt,
    pages: [{
      packet,
      path: '03 Resources/OpenClaw Memory Solutions.md',
      reviewStatus: 'proposed',
      body: createOpenClawMemorySolutionsModelAuthoredBody(),
    }],
  });
}

export function compileResourceWikiPages(options: ResourceWikiCompileOptions): ResourceWikiCompileResult {
  if (options.pages.length === 0) {
    throw new Error('Resource Wiki compile requires at least one page.');
  }
  const compiledAt = options.compiledAt ?? new Date().toISOString();
  const pages = options.pages.map((page) => renderResourceWikiPage(page.packet, {
    path: page.path,
    reviewStatus: page.reviewStatus,
    compiledAt,
    body: page.body,
  }));
  const log = renderCompileLog({
    compiled_at: compiledAt,
    generator: RESOURCE_WIKI_GENERATOR_ID,
    vault_root: options.vaultRoot ?? '',
    reset_vault: options.resetVault === true,
    pages_written: pages.map((page) => page.path),
    directories_ensured: [...RESOURCE_WIKI_LAYOUT_DIRS, '00 Meta/Resource Wiki'],
  });

  return {
    pages,
    log,
    layoutDirs: RESOURCE_WIKI_LAYOUT_DIRS,
  };
}

export async function writeResourceWikiProof(options: ResourceWikiWriteOptions): Promise<ResourceWikiWriteResult> {
  const compiledAt = options.compiledAt ?? new Date().toISOString();
  return writeResourceWikiPages({
    ...options,
    compiledAt,
    pages: [{
      packet: createOpenClawMemorySolutionsPacket(compiledAt.slice(0, 10)),
      path: '03 Resources/OpenClaw Memory Solutions.md',
      reviewStatus: 'proposed',
      body: createOpenClawMemorySolutionsModelAuthoredBody(),
    }],
  });
}

export async function writeResourceWikiPages(options: ResourceWikiWritePagesOptions): Promise<ResourceWikiWriteResult> {
  const vaultRoot = path.resolve(options.vaultRoot);
  const resetVault = options.resetVault === true;
  const compiled = compileResourceWikiPages({
    pages: options.pages,
    ...(options.compiledAt === undefined ? {} : { compiledAt: options.compiledAt }),
    vaultRoot,
    resetVault,
  });

  if (resetVault) {
    await resetVaultContent(vaultRoot);
  }

  await ensureVaultLayout(vaultRoot, [...RESOURCE_WIKI_LAYOUT_DIRS, '00 Meta/Resource Wiki']);

  for (const page of compiled.pages) {
    await writeVaultFile(vaultRoot, page.path, page.markdown);
  }

  const logEntry: ResourceWikiCompileLogEntry = {
    ...compiled.log.entry,
    vault_root: vaultRoot,
    reset_vault: resetVault,
  };
  const log = renderCompileLog(logEntry);
  await writeVaultFile(vaultRoot, log.path, log.markdown);

  return {
    ...compiled,
    log,
    vaultRoot,
  };
}

export function renderResourceWikiPage(
  packet: ResourceWikiEvidencePacket,
  options: {
    path: string;
    reviewStatus: ResourceWikiReviewStatus;
    compiledAt: string;
    body: ResourceWikiModelAuthoredBody;
  },
): ResourceWikiRenderedMarkdown {
  assertSafeVaultRelativePath(options.path);
  validateEvidencePacket(packet);
  validateModelAuthoredBody(options.body, packet);

  const knowledgeRoles = unique(packet.evidence.flatMap((point) => point.knowledgeRoles));
  const metadata: ResourceWikiPageMetadata = {
    type: 'resource_wiki_page',
    canonical_id: packet.canonicalId,
    resource_kind: packet.resourceKind,
    trust_domain: packet.trustDomain,
    sensitivity: packet.sensitivity,
    review_status: options.reviewStatus,
    generated_by: RESOURCE_WIKI_GENERATOR_ID,
    model_lane: RESOURCE_WIKI_MODEL_LANE,
    last_compiled_at: options.compiledAt,
    valid_as_of: packet.validAsOf,
    source_refs: packet.sourceRefs,
    knowledge_roles: knowledgeRoles,
    what_changed: packet.whatChanged,
  };

  const body = [
    `# ${packet.title}`,
    '',
    options.body.lead.trim(),
    '',
    ...options.body.sections.flatMap((section) => [
      `## ${section.heading.trim()}`,
      '',
      section.markdown.trim(),
      '',
    ]),
    '## Related Pages',
    '',
    options.body.relatedPages.map((page) => `- ${page.trim()}`).join('\n'),
    '',
    '## Notes',
    '',
    endnotesFor(packet),
    '',
  ].join('\n');

  const markdown = `${renderYamlFrontmatter(metadata)}\n${body}`;
  assertNoForbiddenResourceWikiOutput(markdown);

  return {
    path: options.path,
    title: packet.title,
    metadata,
    markdown,
  };
}

export function renderCompileLog(entry: ResourceWikiCompileLogEntry): ResourceWikiCompileLog {
  const path = '00 Meta/Resource Wiki/log.md';
  assertSafeVaultRelativePath(path);
  const markdown = [
    '# Resource Wiki Compile Log',
    '',
    `- compiled_at: ${entry.compiled_at}`,
    `- generator: ${entry.generator}`,
    `- vault_root: ${entry.vault_root || '(not written)'}`,
    `- reset_vault: ${entry.reset_vault}`,
    `- pages_written: ${entry.pages_written.join(', ')}`,
    `- directories_ensured: ${entry.directories_ensured.join(', ')}`,
    '',
  ].join('\n');
  assertNoForbiddenResourceWikiOutput(markdown);

  return {
    path,
    markdown,
    entry,
  };
}

export function assertSafeVaultRelativePath(relativePath: string): void {
  if (relativePath.trim() !== relativePath || relativePath.length === 0) {
    throw new Error('Resource Wiki paths must be non-empty normalized relative paths.');
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error('Resource Wiki paths must stay inside the vault.');
  }
  const normalized = path.posix.normalize(relativePath.replaceAll(path.win32.sep, path.posix.sep));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized !== relativePath) {
    throw new Error('Resource Wiki paths must not contain traversal segments.');
  }
  for (const segment of normalized.split('/')) {
    if (segment === '..' || segment === '.' || segment.length === 0) {
      throw new Error('Resource Wiki paths must use explicit vault-local segments.');
    }
  }
}

export function assertNoForbiddenResourceWikiOutput(output: string): void {
  const forbiddenPatterns = [
    /\braw[_-]?(source|text|body|content)\b/i,
    /\bsanitized_text\b/i,
    /\bsource_packet\b/i,
    /\bpacket_fields\b/i,
    /\bvector(s|_backend|_embedding)?\b/i,
    /\boauth\b/i,
    /\baccess[_-]?token\b/i,
    /\brefresh[_-]?token\b/i,
    /\bsnippet(s)?\b/i,
    /\bprivate[_-]?source[_-]?text\b/i,
  ];
  const match = forbiddenPatterns.find((pattern) => pattern.test(output));
  if (match) {
    throw new Error(`Resource Wiki output contains forbidden private/source field marker: ${match.source}`);
  }
}

async function ensureVaultLayout(vaultRoot: string, dirs: string[]): Promise<void> {
  await mkdir(vaultRoot, { recursive: true });
  for (const dir of dirs) {
    assertSafeVaultRelativePath(dir);
    await mkdir(path.join(vaultRoot, dir), { recursive: true });
  }
}

async function resetVaultContent(vaultRoot: string): Promise<void> {
  await mkdir(vaultRoot, { recursive: true });
  const entries = await readdir(vaultRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.obsidian') continue;
    await removeVaultEntry(path.join(vaultRoot, entry.name));
  }
}

async function removeVaultEntry(absolutePath: string): Promise<void> {
  const info = await lstat(absolutePath);
  if (!info.isDirectory()) {
    await unlink(absolutePath);
    return;
  }

  const children = await readdir(absolutePath);
  for (const child of children) {
    await removeVaultEntry(path.join(absolutePath, child));
  }
  await rmdir(absolutePath);
}

async function writeVaultFile(vaultRoot: string, relativePath: string, content: string): Promise<void> {
  assertSafeVaultRelativePath(relativePath);
  const absolutePath = path.join(vaultRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
}

function validateEvidencePacket(packet: ResourceWikiEvidencePacket): void {
  const sourceRefIds = new Set(packet.sourceRefs.map((sourceRef) => sourceRef.id));
  if (sourceRefIds.size !== packet.sourceRefs.length) {
    throw new Error('Resource Wiki source refs must have unique ids.');
  }
  for (const point of packet.evidence) {
    if (point.sourceRefIds.length === 0) {
      throw new Error('Resource Wiki evidence points must cite at least one source ref.');
    }
    for (const sourceRefId of point.sourceRefIds) {
      if (!sourceRefIds.has(sourceRefId)) {
        throw new Error(`Resource Wiki evidence point cites unknown source ref: ${sourceRefId}`);
      }
    }
  }
}

function validateModelAuthoredBody(body: ResourceWikiModelAuthoredBody, packet: ResourceWikiEvidencePacket): void {
  if (body.lead.trim().length === 0) {
    throw new Error('Resource Wiki model-authored body must include a lead.');
  }
  if (body.sections.length === 0) {
    throw new Error('Resource Wiki model-authored body must include at least one section.');
  }
  for (const section of body.sections) {
    if (section.heading.trim().length === 0 || section.heading !== section.heading.trim()) {
      throw new Error('Resource Wiki model-authored section headings must be non-empty and trimmed.');
    }
    if (section.heading.includes('\n') || section.heading.startsWith('#')) {
      throw new Error('Resource Wiki model-authored section headings must be plain headings.');
    }
    if (section.markdown.trim().length === 0) {
      throw new Error('Resource Wiki model-authored sections must include markdown body text.');
    }
  }
  for (const page of body.relatedPages) {
    if (page.trim().length === 0 || page !== page.trim() || page.includes('\n')) {
      throw new Error('Resource Wiki related pages must be non-empty single-line values.');
    }
  }

  const knownEvidenceIds = new Set(packet.evidence.map((point) => point.id));
  const citedEvidenceIds = new Set<string>();
  const citePattern = /\[\^([^\]\s]+)\]/g;
  const modelText = [body.lead, ...body.sections.map((section) => section.markdown)].join('\n');
  for (const match of modelText.matchAll(citePattern)) {
    citedEvidenceIds.add(match[1] ?? '');
  }
  if (citedEvidenceIds.size === 0) {
    throw new Error('Resource Wiki model-authored body must cite bounded evidence.');
  }
  for (const citedEvidenceId of citedEvidenceIds) {
    if (!knownEvidenceIds.has(citedEvidenceId)) {
      throw new Error(`Resource Wiki model-authored body cites unknown evidence id: ${citedEvidenceId}`);
    }
  }

  assertNoForbiddenResourceWikiOutput(modelText);
}

function renderYamlFrontmatter(metadata: ResourceWikiPageMetadata): string {
  return [
    '---',
    `type: ${metadata.type}`,
    `canonical_id: ${metadata.canonical_id}`,
    `resource_kind: ${metadata.resource_kind}`,
    `trust_domain: ${metadata.trust_domain}`,
    `sensitivity: ${metadata.sensitivity}`,
    `review_status: ${metadata.review_status}`,
    `generated_by: ${metadata.generated_by}`,
    `model_lane: ${metadata.model_lane}`,
    `last_compiled_at: ${metadata.last_compiled_at}`,
    `valid_as_of: ${metadata.valid_as_of}`,
    'source_refs:',
    ...metadata.source_refs.map((sourceRef) => [
      `  - id: ${sourceRef.id}`,
      `    family: ${sourceRef.family}`,
      `    label: ${yamlQuote(sourceRef.label)}`,
      `    provider: ${sourceRef.provider}`,
      ...(sourceRef.corpusId ? [`    corpus_id: ${yamlQuote(sourceRef.corpusId)}`] : []),
      ...(sourceRef.providerItemId ? [`    provider_item_id: ${yamlQuote(sourceRef.providerItemId)}`] : []),
      ...(sourceRef.uri ? [`    uri: ${yamlQuote(sourceRef.uri)}`] : []),
      ...(sourceRef.folderNames && sourceRef.folderNames.length > 0
        ? ['    folder_names:', ...sourceRef.folderNames.map((folderName) => `      - ${yamlQuote(folderName)}`)]
        : []),
      `    trust_domain: ${sourceRef.trustDomain}`,
      `    sensitivity: ${sourceRef.sensitivity}`,
      `    valid_as_of: ${sourceRef.validAsOf}`,
    ].join('\n')),
    'knowledge_roles:',
    ...metadata.knowledge_roles.map((role) => `  - ${role}`),
    'what_changed:',
    ...metadata.what_changed.map((change) => `  - ${yamlQuote(change)}`),
    '---',
  ].join('\n');
}

function endnotesFor(packet: ResourceWikiEvidencePacket): string {
  return packet.evidence.map((point) => {
    const sourceRefs = point.sourceRefIds.map((id) => {
      const sourceRef = packet.sourceRefs.find((candidate) => candidate.id === id);
      if (!sourceRef) return id;
      const label = sourceRef.uri ? `[${sourceRef.label}](${sourceRef.uri})` : sourceRef.label;
      const folders = sourceRef.folderNames && sourceRef.folderNames.length > 0
        ? `; folders: ${sourceRef.folderNames.join(', ')}`
        : '';
      return `${label} (${sourceRef.family}${folders})`;
    });
    return `[^${point.id}]: Synthesized from ${sourceRefs.join('; ')}. Knowledge roles: ${point.knowledgeRoles.join(', ')}.`;
  }).join('\n');
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}
