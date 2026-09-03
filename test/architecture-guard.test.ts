// Architecture guard: keeps the source pipeline capability-shaped, not
// source-shaped or question-shaped. This is the mechanical half of the freeze
// rule in docs/CONTRACTS.md — the part a fresh thread or a different tool
// cannot talk its way past. If a change makes this test red, the change is
// reintroducing the exact anti-pattern the contracts exist to remove. Fix the
// change, do not weaken the guard.
//
// History: the pre-contracts template path (src/workers/source-index/answer.ts)
// was quarantined 2026-05-28, ratcheted down, and DELETED at the Lane F
// deletion milestone on 2026-06-10. The guard now keeps it dead.

import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import slice2Deletion from '../config/slice2-deleted-paths.json';
import {
  isPathDigest,
  literalBasename,
  pathDigest,
  quotedLiterals,
  redactedPathOffenders,
  referenceCandidates,
} from '../scripts/redacted-path-digest.ts';
import { pathCarriesOwnerIdentityToken } from '../scripts/owner-identifier-patterns.ts';
import { trackedFiles } from '../scripts/public-flip-scan.ts';

const repoRoot = join(import.meta.dir, '..');
const SLICE_2_DELETION_COUNT = 154;
const SLICE_2_ACTIVE_SURFACE_GLOBS = [
  'src/**/*.ts',
  'scripts/**/*.ts',
  'scripts/**/*.sh',
  'scripts/**/*.zsh',
  'config/**/*',
  'test/**/*.ts',
  'package.json',
];
const SLICE_2_RECEIPT_ONLY_LEDGERS = new Set([
  'config/private-ops-disposition.json',
  'config/slice2-deleted-paths.json',
]);

// The deleted template path must not come back under its old name.
const DELETED_PATHS = [
  'src/workers/source-index/answer.ts',
  'src/workers/connector-store/embedding-import.ts',
  'src/workers/google-ingest/common.ts',
  'src/workers/google-ingest/drive-connector.ts',
  'src/workers/google-ingest/gmail-connector.ts',
  'src/workers/google-ingest/index.ts',
];

const CANONICAL_EXPLICIT_SOURCE_CONNECTOR_IMPLEMENTATIONS = [
  'src/workers/google-connectors/drive.ts',
  'src/workers/google-connectors/gmail.ts',
];

const LEGACY_TELEGRAM_INPUT_ALIAS = 'secure_local.telegram.messages';
const LEGACY_TELEGRAM_INPUT_ALIAS_OWNER = 'src/core/source-corpus-registry.ts';

const RETIRED_EMBEDDING_IMPORT_SYMBOLS = [
  'importChunkEmbeddings',
  'importLegacyEmbeddings',
  'ConnectorStoreEmbeddingImport',
  'ConnectorStoreLegacyEmbeddingSource',
];

// The only file allowed to mention the deprecated template/regex symbols: the
// contracts doc-comment that records what the Analyst replaced.
const ALLOWED = new Set<string>(['src/core/contracts.ts']);

const FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'per-source answer template (synthesizeSafe*)', pattern: /synthesizeSafe\w*/ },
  { label: 'per-question answer template (synthesize*Answer(...))', pattern: /synthesize\w*Answer\s*\(/ },
  { label: 'per-question regex fact classifier (queryRequests*Facts)', pattern: /queryRequests\w*Facts/ },
];

// Legacy bespoke source indexes are allowed to keep serving proven live
// corpora while we extract shared machinery behind parity tests. New source
// families should use SourceConnector + LocalConnectorStore by default instead
// of adding another source-shaped index monolith.
const ALLOWED_LOCAL_INDEX_PATHS = new Set<string>([
  'src/workers/connector-store/local-index.ts',
]);

// These files are the shared answer/reasoning spine plus the file-extraction
// factory. They may talk about trust domains, evidence, analysts, release
// gates, extractors, and providers in the abstract; they must not name a
// concrete source family. Concrete source wiring belongs in server/bootstrap
// adapters or SourceConnector/local store modules.
//
// The whole of src/workers/file-extraction/ is enrolled here on purpose: the
// factory is a reusable connector that any file-storage family can feed, so
// "source-neutral" has to be an enforced invariant rather than an intention.
// The coverage test below fails if a new module in that directory is not
// listed, so a file cannot quietly escape the rule by being added later.
const SOURCE_AGNOSTIC_SHARED_FILES = [
  'src/core/analyst.ts',
  // Shared support for implementing the file-extraction seam. It is imported
  // by every family's source module, so its neutrality has to be enforced
  // rather than intended — the family-shaped code lives on the other side of
  // the seam, in the family's own module, where this guard does not reach.
  'src/core/file-extraction-source.ts',
  'src/core/evidence-pack.ts',
  // The folder-exclusion gate. Every file-storage family needs the identical
  // capability, and a gate that learned one provider's idioms would be a gate
  // the next provider silently does not get. Enrolling it here is what makes
  // "source-neutral" an enforced invariant rather than an intention.
  'src/core/source-ingestion-exclusions.ts',
  // The folder-disposition picker's engine. It reads the gate above and nothing
  // else, and every file-storage family needs the identical picker — so the same
  // neutrality the gate is held to applies here, or the first provider to get a
  // picker would be the only one that ever has one.
  'src/core/source-disposition-tree.ts',
  'src/core/query-planner.ts',
  'src/core/source-model-policy.ts',
  'src/core/source-index/retrieval.ts',
  'src/core/source-index/router.ts',
  'src/core/source-index/selected-item-safety.ts',
  'src/workers/file-extraction/extractors/bounded-text.ts',
  'src/workers/file-extraction/extractors/command-runner.ts',
  'src/workers/file-extraction/extractors/document-formats.ts',
  'src/workers/file-extraction/extractors/ocr.ts',
  'src/workers/file-extraction/extractors/openai-compatible-client.ts',
  'src/workers/file-extraction/extractors/pdf-render.ts',
  'src/workers/file-extraction/extractors/remote-vlm.ts',
  'src/workers/file-extraction/extractors/text.ts',
  'src/workers/file-extraction/extractors/transcription.ts',
  'src/workers/file-extraction/extractors/venice-client.ts',
  'src/workers/file-extraction/extractors/vlm.ts',
  'src/workers/file-extraction/http-types.ts',
  'src/workers/file-extraction/job-store.ts',
  // The readiness counts the source status surface publishes. It maps the
  // queue's own vocabulary onto the dashboard's count keys, which is exactly
  // the place a one-provider verdict would be tempting to add — and the
  // per-family ladder it replaces is why the page saturated at 100%.
  'src/workers/file-extraction/readiness-ledger.ts',
  'src/workers/file-extraction/registry.ts',
  'src/workers/file-extraction/runner.ts',
  'src/workers/file-extraction/store-sink.ts',
  'src/workers/file-extraction/types.ts',
  'src/workers/source-index/analyst-answer.ts',
  'src/workers/source-index/answer-types.ts',
];

const FILE_EXTRACTION_FACTORY_GLOB = 'src/workers/file-extraction/**/*.ts';

const RETIRED_CREDENTIAL_GATEWAY_NAME = ['claw', 'visor'].join('');
const RETIRED_CREDENTIAL_GATEWAY_ACTIVE_GLOBS = [
  'src/**/*.ts',
  'scripts/**/*.ts',
  'scripts/**/*.sh',
  'scripts/**/*.zsh',
  'config/**/*',
  'package.json',
  'test/**/*.ts',
];

// Dropbox's product path must not grow back through the grandfathered index,
// replay, or per-source extraction/scheduler modules while those files remain
// available for the one-time convergence cut in Slice 2.
const DROPBOX_CANONICAL_RUNTIME_FILES = [
  'src/workers/dropbox-files/connector.ts',
  'src/workers/dropbox-files/provider-client.ts',
  'src/workers/dropbox-files/provider-store-sync.ts',
];
const FORBIDDEN_DROPBOX_LEGACY_IMPORT = /from\s+['"]\.\/(?:content-extraction|dropbox-live-(?:control|sync)|legacy-replay|live-sync|local-index|sync-jobs)\.ts['"]/;

const FORBIDDEN_SHARED_SOURCE_TOKENS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'Dropbox-specific shared answer logic', pattern: /\bdropbox\b/i },
  { label: 'Gmail-specific shared answer logic', pattern: /\bgmail\b/i },
  { label: 'email-specific shared answer logic', pattern: /\bemail\b/i },
  { label: 'Google Drive-specific shared answer logic', pattern: /\bgoogle[-_\s]?drive\b/i },
  { label: 'Drive Docs-specific shared answer logic', pattern: /\bdrive[-_\s]?docs\b/i },
  { label: 'Readwise-specific shared answer logic', pattern: /\breadwise\b/i },
  { label: 'X bookmark-specific shared answer logic', pattern: /\bx[-_\s]?bookmarks?\b|\bx_bookmark\b/i },
  { label: 'Telegram-specific shared answer logic', pattern: /\btelegram\b/i },
  { label: 'WhatsApp-specific shared answer logic', pattern: /\bwhatsapp\b/i },
  { label: 'Apple Messages-specific shared answer logic', pattern: /\bapple[-_\s]?messages?\b/i },
  { label: 'Reflect-specific shared answer logic', pattern: /\breflect\b/i },
  { label: 'Roam-specific shared answer logic', pattern: /\broam\b/i },
];

const FORBIDDEN_SHARED_DOMAIN_TOKENS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'lab-specific shared answer logic', pattern: /\blabs?\b/i },
  { label: 'bloodwork-specific shared answer logic', pattern: /\bblood[-_\s]?work\b/i },
  { label: 'biomarker-specific shared answer logic', pattern: /\bbiomarkers?\b/i },
  { label: 'medical-specific shared answer logic', pattern: /\bmedical|clinical\b/i },
];

// Existing regex heuristics in shared answer/reasoning files are reviewed
// generic policy/formatting gates. New regex routing must be placed in an
// explicitly reviewed helper rather than appearing ad hoc in the shared spine.
const ALLOWED_SHARED_REGEX_FUNCTIONS = new Map<string, Set<string>>([
  ['src/core/analyst.ts', new Set([
    'isUnsupportedNoContentAnswer',
    'compactSourceText',
    'stripCodeFences',
  ])],
  ['src/core/evidence-pack.ts', new Set([
    'hasTemporalIntent',
  ])],
  ['src/core/query-planner.ts', new Set([
    'stripCodeFences',
  ])],
  ['src/core/source-index/selected-item-safety.ts', new Set([
    'normalizeSelectedItemField',
  ])],
  ['src/core/source-index/router.ts', new Set([
    'normalizeRouterResultKey',
    // Generic, content-free error digest for a dropped lane's late failure
    // (per-lane retrieval deadline). Source-agnostic; mirrors redactAnalystLegError.
    'redactLaneError',
  ])],
  // The file-extraction factory's format decoders. Every regex-bearing
  // function in that directory is listed here, including the handful whose
  // regexes the detector below does not currently recognize (matchAll, and a
  // pattern assigned to a local const before use): the point of the list is a
  // reviewed inventory of where regexes live, not a minimal set of names
  // needed to make the assertion pass. All of them are format grammars —
  // zip part names, Office XML tags, PDF operators, delimited rows — and none
  // routes on content or on a source family.
  ['src/workers/file-extraction/extractors/bounded-text.ts', new Set([
    'normalizeExtractedText',
    'sanitizeErrorDetail',
  ])],
  ['src/workers/file-extraction/extractors/document-formats.ts', new Set([
    'parseDelimitedRows',
    'normalizeTableCell',
    'extractPdfTextStreams',
    'decodePdfStream',
    'extractPdfTextOperators',
    'extractPdfTextRuns',
    'decodePdfHexString',
    'decodePdfLiteralString',
    'pdfAppearsImageOnly',
    'isWordHeaderPart',
    'isWordFooterPart',
    'isSlidePart',
    'isNotesSlidePart',
    'isWorksheetPart',
    'sheetXmlHasFormula',
    'officePartNumber',
    'extractWordParagraphs',
    'extractWordComments',
    'extractWordTables',
    'extractDrawingMlTables',
    'extractXmlTagText',
    'extractXlsxSharedStrings',
    'extractXlsxSheetNames',
    'extractXlsxRows',
    'extractXlsxCellValue',
    'stripXmlTags',
    'decodeXmlEntities',
    'escapeRegExp',
  ])],
  ['src/workers/file-extraction/extractors/pdf-render.ts', new Set([
    'parsePdfInfoPageCount',
    'matchRenderedPageNumber',
  ])],
  ['src/workers/file-extraction/extractors/ocr.ts', new Set([
    // Terminal-versus-retryable classification of a rejected PDF. Matches the
    // OCR command's own diagnostics, never document content.
    'classifyOcrDeterministicPdfRejection',
  ])],
  ['src/workers/file-extraction/extractors/remote-vlm.ts', new Set([
    // The two egress guards. Both only strip trailing slashes before parsing;
    // the host and protocol decisions are made on the parsed URL.
    'requireLocalHttpBaseUrl',
    'requireApprovedRemoteExtractionBaseUrl',
    'classifyRemoteVlmEndpointError',
  ])],
  ['src/workers/file-extraction/extractors/transcription.ts', new Set([
    'parseTranscriberArgvTemplate',
    'tempAudioFileName',
    'normalizeTranscriptText',
  ])],
  ['src/workers/file-extraction/extractors/vlm.ts', new Set([
    'stripDataUrlPrefix',
    // Terminal-versus-retryable classification of a refused vision request.
    // Matches the router's own diagnostics, never document content.
    'classifyVlmRouterEndpointError',
  ])],
  ['src/workers/source-index/analyst-answer.ts', new Set([
    'redactAnalystLegError',
    'requestExplicitlyTargetsSecureLocal',
    'isBulkSecureLocalReleaseRequest',
    'stripBulkAndRawDisclosureProhibitions',
    'isBoundedDerivativeQuestion',
    'hasConceptualRetrievalIntent',
    'secureMetadataOnlyGapResult',
    'providerErrorReason',
    'isUnsupportedNoContentAnswer',
  ])],
]);

/**
 * Every file under the repository's own top-level directories, plus the
 * top-level files, so the redacted half of the deletion guard is checked
 * against the whole tree rather than only the paths the ledger happens to list.
 *
 * EXACT SEMANTICS, so nobody reads more into this than it does: it walks the
 * named directories with `Glob`, which does not descend symlinked directories.
 * It applies no ignore rules at all, so it also sweeps untracked and ignored
 * files that happen to sit inside them. That is deliberate — sweeping a file
 * git would ignore can only produce a finding, never miss one.
 *
 * What it must NOT do is decide correctness from the local filesystem. The
 * completeness test below therefore compares this list against the TRACKED
 * tree, not against whatever directories exist on the machine: CI writes
 * `test-results/` and a developer's checkout does not.
 */
const REPO_CONTENT_DIRECTORIES = [
  '.claude', '.github', 'bin', 'config', 'dist', 'docs', 'eval',
  'integrations', 'relay', 'scripts', 'skills', 'src', 'test', 'tools',
];

function repoContentFiles(): string[] {
  const files = new Set<string>();
  for (const directory of REPO_CONTENT_DIRECTORIES) {
    if (!existsSync(join(repoRoot, directory))) continue;
    // `dot: true` is load-bearing: without it Glob skips dot-directories, so
    // `.claude/` and `.github/` were swept not at all. The tracked-tree
    // assertion below is what caught that.
    for (const rel of new Glob(`${directory}/**/*`).scanSync({ cwd: repoRoot, dot: true })) {
      files.add(rel.split('\\').join('/'));
    }
  }
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isFile()) files.add(entry.name);
  }
  return [...files];
}

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

function moduleSpecifiers(activePath: string, deletedPath: string): string[] {
  if (!activePath.endsWith('.ts') || !deletedPath.endsWith('.ts')) return [];
  let specifier = relative(dirname(activePath), deletedPath).split('\\').join('/');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  return [specifier, specifier.slice(0, -3)];
}

function functionNameByLine(content: string): string[] {
  const names: string[] = [];
  let current = '<top-level>';
  for (const line of content.split('\n')) {
    const match = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\b/);
    // A top-level closing brace ends the body, so attribution must drop back to
    // <top-level>; otherwise every later arrow/const helper — including anything
    // appended after a file's last `function` — inherits an allowlisted name.
    if (match) current = match[1]!;
    else if (/^\}/.test(line)) current = '<top-level>';
    names.push(current);
  }
  return names;
}

function lineContainsRegexLiteral(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//')) return false;
  return /\/(?:\\.|[^/\n])+\/[dgimsuy]*\.(?:test|exec)\(/.test(line)
    || /\.(?:match|replace|search|split)\(\s*\/(?:\\.|[^/\n])+\/[dgimsuy]*/.test(line)
    || /\bnew\s+RegExp\s*\(/.test(line)
    || /^(?:\|\|\s*)?\/(?:\\.|[^/\n])+\/[dgimsuy]*(?:[,);]|$)/.test(trimmed);
}

describe('architecture guard: capability, not per-source/per-question code', () => {
  test('the deleted template path stays deleted', () => {
    for (const rel of DELETED_PATHS) {
      expect(existsSync(join(repoRoot, rel))).toBe(false);
    }
  });

  test('the retired embedding importer cannot return under another module name', () => {
    const offenders: string[] = [];
    for (const rel of new Glob('src/**/*.ts').scanSync({ cwd: repoRoot })) {
      const norm = rel.split('\\').join('/');
      const content = read(norm);
      for (const symbol of RETIRED_EMBEDDING_IMPORT_SYMBOLS) {
        if (content.includes(symbol)) offenders.push(`${norm}: ${symbol}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('explicit SourceConnector implementations stay on the canonical Google connector modules', () => {
    const implementations = [...new Glob('src/**/*.ts').scanSync({ cwd: repoRoot })]
      .map((rel) => rel.split('\\').join('/'))
      .filter((rel) => read(rel).includes('implements SourceConnector'))
      .sort();
    expect(implementations).toEqual(CANONICAL_EXPLICIT_SOURCE_CONNECTOR_IMPLEMENTATIONS);
  });

  test('the historical Telegram corpus id remains an input alias only', () => {
    const owners = [...new Glob('src/**/*.ts').scanSync({ cwd: repoRoot })]
      .map((rel) => rel.split('\\').join('/'))
      .filter((rel) => read(rel).includes(LEGACY_TELEGRAM_INPUT_ALIAS));
    expect(owners).toEqual([LEGACY_TELEGRAM_INPUT_ALIAS_OWNER]);

    const workerSurface = [
      'src/workers/email-source/index.ts',
      'src/workers/email-source/server.ts',
      'src/workers/source-index/status.ts',
      'src/workers/telegram-messages/corpus-adapter.ts',
    ].map(read).join('\n');
    expect(workerSurface).not.toContain('defineLegacySecureLocalTelegramMessagesCorpus');
    expect(workerSurface).not.toMatch(/\bTELEGRAM_MESSAGES_CORPUS_ID\b/);
  });

  test('the approved Slice 2 inventory stays deleted and has no active consumer', () => {
    const deletedPaths = slice2Deletion.paths;
    // Nineteen of the retired paths carry the private host alias in the
    // filename, so the ledger holds their SHA-256 instead of the name. Both
    // halves stay guarded; scripts/redacted-path-digest.ts records why an
    // invented replacement name would have been worse than no entry at all.
    const redactedDigests = new Set<string>(slice2Deletion.redacted_path_sha256);
    const redactedBasenames = new Set<string>(slice2Deletion.redacted_basename_sha256);
    expect(slice2Deletion.schema_version).toBe(2);
    expect(redactedDigests.size).toBe(slice2Deletion.redacted_path_sha256.length);
    expect(redactedBasenames.size).toBe(redactedDigests.size);
    expect(slice2Deletion.redacted_path_sha256.every(isPathDigest)).toBe(true);
    expect(slice2Deletion.redacted_basename_sha256.every(isPathDigest)).toBe(true);
    // A surviving path's own filename must never hash into the basename set,
    // or the guard would fire on a file that is legitimately still here.
    expect(deletedPaths.filter((rel) => redactedBasenames.has(pathDigest(rel.slice(rel.lastIndexOf('/') + 1))))).toEqual([]);
    expect(repoContentFiles().filter((rel) => redactedBasenames.has(pathDigest(rel.slice(rel.lastIndexOf('/') + 1))))).toEqual([]);
    expect(new Set(deletedPaths).size).toBe(deletedPaths.length);
    expect(deletedPaths.length + redactedDigests.size).toBe(SLICE_2_DELETION_COUNT);
    // A literal entry must not also be carried as a digest.
    expect(deletedPaths.filter((rel) => redactedDigests.has(pathDigest(rel)))).toEqual([]);
    // ...and no literal entry may carry an identity token, including one
    // embedded in a longer filename, which is what the digest half is for.
    expect(deletedPaths.filter((rel) => pathCarriesOwnerIdentityToken(rel))).toEqual([]);

    const activePaths = new Set<string>();
    for (const pattern of SLICE_2_ACTIVE_SURFACE_GLOBS) {
      for (const rel of new Glob(pattern).scanSync({ cwd: repoRoot })) {
        activePaths.add(rel.split('\\').join('/'));
      }
    }

    // Still deleted. The literal half is checked by name; the redacted half by
    // hashing every tracked path, which covers the whole tree rather than only
    // the names the ledger happens to list.
    expect(deletedPaths.filter((rel) => existsSync(join(repoRoot, rel)))).toEqual([]);
    expect(redactedPathOffenders(repoContentFiles(), redactedDigests)).toEqual([]);

    // No active consumer. The literal half searches each file for the quoted
    // path; the redacted half runs the same check inverted — pull every quoted
    // literal out of the file, resolve relative specifiers, and hash.
    const offenders: string[] = [];
    for (const activePath of [...activePaths].sort()) {
      if (SLICE_2_RECEIPT_ONLY_LEDGERS.has(activePath)) continue;
      const content = read(activePath);
      for (const deletedPath of deletedPaths) {
        const candidates = [
          deletedPath,
          ...moduleSpecifiers(activePath, deletedPath),
        ];
        if (candidates.some((candidate) => (
          content.includes(`'${candidate}'`)
          || content.includes(`"${candidate}"`)
          || content.includes(`\`${candidate}\``)
        ))) {
          offenders.push(`${activePath} -> ${deletedPath}`);
        }
      }
      for (const literal of quotedLiterals(content)) {
        const byPath = redactedPathOffenders(referenceCandidates(activePath, literal), redactedDigests).length > 0;
        // Also the bare filename, which catches join()/interpolated paths whose
        // only literal fragment is the name. See literalBasename() for the
        // residual this still does not cover.
        const basename = literalBasename(literal);
        const byBasename = basename !== undefined && redactedBasenames.has(pathDigest(basename));
        if (byPath || byBasename) {
          offenders.push(`${activePath} -> <redacted retired path>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the retired-path sweep covers every tracked repository path', () => {
    // The expectation is the TRACKED tree — exactly what the flip publishes —
    // not the local filesystem. Reading directories off disk made this depend
    // on whatever the machine happened to have: CI writes `test-results/` for
    // the JUnit reporter and a developer's checkout does not, so the test
    // passed locally and failed in CI. A build output must never decide whether
    // this passes.
    const tracked = trackedFiles(repoRoot);
    expect(tracked.length).toBeGreaterThan(500);

    const trackedTopLevelDirectories = [...new Set(tracked
      .filter((rel) => rel.includes('/'))
      .map((rel) => rel.slice(0, rel.indexOf('/'))))].sort();
    // A new tracked top-level directory must be added to the sweep list, or a
    // retired path could come back inside it unseen.
    expect(trackedTopLevelDirectories.filter((name) => !REPO_CONTENT_DIRECTORIES.includes(name))).toEqual([]);

    // And the sweep must actually reach every tracked path, so an over-eager
    // skip rule cannot quietly carve a hole in it.
    const swept = new Set(repoContentFiles());
    expect(tracked.filter((rel) => !swept.has(rel))).toEqual([]);
  });

  test('the redacted half of the Slice 2 guard fires on a retired name it never spells', () => {
    // The nineteen redacted names cannot be written here either, so the
    // mechanism is proven against synthetic retired paths that stand in for
    // them: the ledger holds only their digests, and the guard still catches
    // both the file coming back and an active file referencing it.
    const retiredScript = 'scripts/ops/install-example-retired-systemd.sh';
    const retiredModule = 'scripts/example-retired-helper.ts';
    const digests = new Set([pathDigest(retiredScript), pathDigest(retiredModule)]);
    expect([...digests].every(isPathDigest)).toBe(true);
    for (const digest of digests) expect(digest).not.toContain('example-retired');

    // 1. The file coming back is caught by hashing candidate paths, and an
    //    unrelated neighbour in the same directory is not.
    expect(redactedPathOffenders(['scripts/ops/install-example-kept-systemd.sh'], digests)).toEqual([]);
    expect(redactedPathOffenders(['scripts/ops/install-example-kept-systemd.sh', retiredScript], digests))
      .toEqual([retiredScript]);

    // 2. It is caught in a real temp tree through the same glob-and-hash path
    //    the ledger guard uses, so the proof is not just a unit call.
    const treeRoot = mkdtempSync(join(tmpdir(), 'olympus-retired-path-guard-'));
    try {
      mkdirSync(join(treeRoot, 'scripts', 'ops'), { recursive: true });
      writeFileSync(join(treeRoot, 'scripts', 'ops', 'install-example-kept-systemd.sh'), '#!/usr/bin/env bash\n');
      const scanned = () => [...new Glob('scripts/**/*.sh').scanSync({ cwd: treeRoot })]
        .map((rel) => rel.split('\\').join('/'));
      expect(redactedPathOffenders(scanned(), digests)).toEqual([]);

      writeFileSync(join(treeRoot, retiredScript), '#!/usr/bin/env bash\n');
      expect(redactedPathOffenders(scanned(), digests)).toEqual([retiredScript]);
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
    }

    // 3. A reference to it is caught by hashing the file's quoted literals,
    //    including a relative module specifier with the extension omitted.
    const consumer = 'scripts/consumer.ts';
    const cases: Array<{ label: string; content: string; caught: boolean }> = [
      { label: 'single quotes', content: `const script = '${retiredScript}';\n`, caught: true },
      { label: 'double quotes', content: `const script = "${retiredScript}";\n`, caught: true },
      { label: 'backticks', content: `const script = \`${retiredScript}\`;\n`, caught: true },
      { label: 'specifier with extension', content: "import { helper } from './example-retired-helper.ts';\n", caught: true },
      { label: 'specifier without extension', content: "import { helper } from './example-retired-helper';\n", caught: true },
      { label: 'unrelated neighbour', content: "const script = 'scripts/ops/install-example-kept-systemd.sh';\n", caught: false },
      { label: 'unquoted mention', content: `// ${retiredScript} in a comment\n`, caught: false },
      { label: 'join() fragment', content: "const script = join(OPS_DIR, 'install-example-retired-systemd.sh');\n", caught: true },
      { label: 'interpolated prefix, literal filename', content: "const script = `${opsDir}/install-example-retired-systemd.sh`;\n", caught: true },
      // The documented residual: no fragment of the name appears literally, so
      // no source-text check can see it. Same blind spot the literal-path half
      // has always had.
      { label: 'name assembled from variables', content: "const script = join(opsDir, `install-${what}-systemd.sh`);\n", caught: false },
    ];
    const basenames = new Set([pathDigest('install-example-retired-systemd.sh'), pathDigest('example-retired-helper.ts')]);
    for (const { label, content, caught } of cases) {
      const hits = quotedLiterals(content).flatMap((literal) => {
        const byPath = redactedPathOffenders(referenceCandidates(consumer, literal), digests);
        const basename = literalBasename(literal);
        const byBasename = basename !== undefined && basenames.has(pathDigest(basename)) ? [basename] : [];
        return [...byPath, ...byBasename];
      });
      expect({ label, caught: hits.length > 0 }).toEqual({ label, caught });
    }
  });

  test('deleted X replay entry points stay absent while persisted rows remain readable', () => {
    const activeRuntime = [
      ...new Glob('src/**/*.ts').scanSync({ cwd: repoRoot }),
      ...new Glob('scripts/**/*.ts').scanSync({ cwd: repoRoot }),
    ].map((rel) => rel.split('\\').join('/'));
    const publicReplayOffenders = activeRuntime.filter((rel) =>
      /seedLegacyBaseline|legacyBaselinePreflight/.test(read(rel))
    );
    expect(publicReplayOffenders).toEqual([]);

    const compatibilityOwners = activeRuntime.filter((rel) => read(rel).includes('legacy_replay'));
    expect(compatibilityOwners).toEqual(['src/workers/x-bookmarks/reconcile-state.ts']);
  });

  test('the retired credential gateway stays out of active product and runtime surfaces', () => {
    const offenders: string[] = [];
    const needle = RETIRED_CREDENTIAL_GATEWAY_NAME.toLowerCase();
    for (const pattern of RETIRED_CREDENTIAL_GATEWAY_ACTIVE_GLOBS) {
      for (const rel of new Glob(pattern).scanSync({ cwd: repoRoot })) {
        const norm = rel.split('\\').join('/');
        if (norm === 'test/architecture-guard.test.ts' || SLICE_2_RECEIPT_ONLY_LEDGERS.has(norm)) continue;
        if (read(norm).toLowerCase().includes(needle)) offenders.push(norm);
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  test('no per-source/per-question answer code anywhere in src', () => {
    const offenders: string[] = [];
    for (const rel of new Glob('src/**/*.ts').scanSync({ cwd: repoRoot })) {
      const norm = rel.split('\\').join('/');
      if (ALLOWED.has(norm)) continue;
      const content = read(norm);
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(content)) offenders.push(`${norm}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('new source families do not add bespoke local-index monoliths', () => {
    const localIndexes = [...new Glob('src/workers/*/local-index.ts').scanSync({ cwd: repoRoot })]
      .map((rel) => rel.split('\\').join('/'))
      .sort();
    expect(localIndexes).toEqual([...ALLOWED_LOCAL_INDEX_PATHS].sort());
  });

  test('shared answer spine stays source-agnostic', () => {
    const offenders: string[] = [];
    for (const rel of SOURCE_AGNOSTIC_SHARED_FILES) {
      const content = read(rel);
      for (const { label, pattern } of [
        ...FORBIDDEN_SHARED_SOURCE_TOKENS,
        ...FORBIDDEN_SHARED_DOMAIN_TOKENS,
      ]) {
        if (pattern.test(content)) offenders.push(`${rel}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every file-extraction factory module is enrolled in the source-agnostic list', () => {
    // Without this, SOURCE_AGNOSTIC_SHARED_FILES is an opt-in list and the
    // next module added to the factory silently gets no source-neutrality
    // check at all. The factory is the one directory where the whole tree is
    // covered, so the list has to be checked against the tree.
    const enrolled = new Set(SOURCE_AGNOSTIC_SHARED_FILES);
    const factoryModules = [...new Glob(FILE_EXTRACTION_FACTORY_GLOB).scanSync({ cwd: repoRoot })]
      .map((rel) => rel.split('\\').join('/'))
      .sort();

    // A glob that matches nothing would make the assertion below vacuous.
    expect(factoryModules.length).toBeGreaterThan(0);
    expect(factoryModules.filter((rel) => !enrolled.has(rel))).toEqual([]);
  });

  test('Dropbox canonical leaf modules stay independent of convergence-only modules', () => {
    const offenders = DROPBOX_CANONICAL_RUNTIME_FILES.filter((rel) =>
      FORBIDDEN_DROPBOX_LEGACY_IMPORT.test(read(rel))
    );
    expect(offenders).toEqual([]);
  });

  test('Dropbox product assembly uses the canonical store for writes and reads', () => {
    const server = read('src/workers/email-source/server.ts');
    expect(server).not.toContain('sourceReadAuthorities');
    expect(server).not.toContain('dropboxLegacyIndexLaneEnabled(process.env)');
    expect(server).toContain('const readConnectorStores = connectorStores;');
    expect(server).toContain('createDropboxProviderStoreSyncHandler({');
    expect(server).toContain('createCanonicalDropboxSchedulerSource({');
    expect(server).not.toMatch(/\bcreateDropboxSchedulerSource\b/);

    const scheduler = read('src/workers/source-scheduler.ts');
    const canonicalStart = scheduler.indexOf('export function createCanonicalDropboxSchedulerSource');
    const canonicalEnd = scheduler.indexOf('export function createReadwiseSchedulerSource', canonicalStart);
    expect(canonicalStart).toBeGreaterThanOrEqual(0);
    expect(canonicalEnd).toBeGreaterThan(canonicalStart);
    const canonicalSection = scheduler.slice(canonicalStart, canonicalEnd);
    expect(canonicalSection).not.toMatch(
      /LocalDropboxFilesIndex|DropboxFilesSyncJobsHandler|DropboxContentExtractionBatchHandler|dropboxPolicyExcludedPathPrefixes/,
    );
  });

  test('Gmail product assembly is provider-native and has no legacy read selector', () => {
    const server = read('src/workers/email-source/server.ts');
    expect(server).not.toContain("sourceReadAuthorities.gmail");
    expect(server).not.toContain('OLYMPUS_SOURCE_INDEX_GMAIL_READ_AUTHORITY');
    expect(server).toContain('createGmailConnectorStoreSyncHandler({');
    expect(server).not.toContain('defaultGmailLegacyReplayDbPath');
  });

  test('product worker assembly cannot construct or register a bespoke source index', () => {
    const server = read('src/workers/email-source/server.ts');
    const mainStart = server.indexOf('export async function main()');
    const mainEnd = server.indexOf('export function resolveEmailSourceBindHostFromEnv', mainStart);
    expect(mainStart).toBeGreaterThanOrEqual(0);
    expect(mainEnd).toBeGreaterThan(mainStart);
    const main = server.slice(mainStart, mainEnd);
    expect(main).not.toMatch(/new\s+Local(?:Email|GoogleDriveDocs|Readwise|XBookmarks|DropboxFiles|TelegramMessages)Index/);
    expect(main).not.toContain('legacy_index');
    expect(main).not.toContain('readAuthorities:');
    expect(main).not.toContain('LegacyReplay');
  });

  test('shared answer regex heuristics stay in reviewed generic helpers', () => {
    const offenders: string[] = [];
    for (const rel of SOURCE_AGNOSTIC_SHARED_FILES) {
      const allowedFunctions = ALLOWED_SHARED_REGEX_FUNCTIONS.get(rel) ?? new Set<string>();
      const content = read(rel);
      const functions = functionNameByLine(content);
      offenders.push(...content
        .split('\n')
        .flatMap((line, index) => {
          if (!lineContainsRegexLiteral(line)) return [];
          const functionName = functions[index] ?? '<top-level>';
          return allowedFunctions.has(functionName)
            ? []
            : [`${rel}:${index + 1}: regex literal in ${functionName}`];
        }));
    }
    expect(offenders).toEqual([]);
  });

  test('regex attribution recognizes exported functions', () => {
    const functions = functionNameByLine([
      'function allowedHelper() {',
      '  return true;',
      '}',
      'export function exportedHelper() {',
      '  return /generic/.test("generic");',
      '}',
      'export async function exportedAsyncHelper() {',
      '  return /generic/.test("generic");',
      '}',
    ].join('\n'));

    expect(functions[1]).toBe('allowedHelper');
    expect(functions[4]).toBe('exportedHelper');
    expect(functions[7]).toBe('exportedAsyncHelper');
  });

  test('regex attribution stops at the end of a function body', () => {
    // Without the reset, everything after a file's last `function` declaration
    // inherits its name — so an arrow-assigned classifier appended below an
    // allowlisted helper would be excused by that helper's allowlist entry.
    const functions = functionNameByLine([
      'function allowedHelper() {',
      '  return true;',
      '}',
      '',
      'const sneakyClassifier = (q: string) => /\\bhow many\\b/i.test(q);',
    ].join('\n'));

    expect(functions[1]).toBe('allowedHelper');
    expect(functions[4]).toBe('<top-level>');
  });

  test('regex guard recognizes common regex APIs and constructors', () => {
    const rejected = [
      'return text.match(/lab/i);',
      'return text.search(/gmail/i);',
      'return text.split(/telegram/i);',
      'return text.replace(/whatsapp/i, "chat");',
      'return new RegExp("bloodwork", "i").test(text);',
    ];
    for (const line of rejected) {
      expect(lineContainsRegexLiteral(line)).toBe(true);
    }
    expect(lineContainsRegexLiteral('return text.split("\\n");')).toBe(false);
    expect(lineContainsRegexLiteral('// return text.match(/lab/i);')).toBe(false);
  });

  test('frozen source contract shapes are declared only in contracts.ts', () => {
    const contractShapeDeclarations = /\b(?:export\s+)?(?:interface|type)\s+(?:SourceConnector|EvidencePack|Analyst)\b/;
    const offenders: string[] = [];
    for (const rel of new Glob('src/**/*.ts').scanSync({ cwd: repoRoot })) {
      const norm = rel.split('\\').join('/');
      if (norm === 'src/core/contracts.ts') continue;
      if (contractShapeDeclarations.test(read(norm))) offenders.push(norm);
    }
    expect(offenders).toEqual([]);
  });

  test('deterministic source embeddings do not bake in source or domain concept buckets', () => {
    const content = read('src/workers/source-index/embeddings.ts');
    expect(content).not.toMatch(/addConcept\(\s*vector\s*,\s*\d+\s*,\s*normalized\s*,\s*\[/);
    expect(content).toContain('conceptGroups');
  });
});
