/**
 * Whole-repository owner-identifier scan for the public flip.
 *
 * `release-artifact.ts` scans the ~29 files that go into the published tarball.
 * That is the wrong boundary for making the repository itself public: every
 * tracked file becomes world-readable, including all of `src/`, `test/`,
 * `scripts/`, `eval/`, `tools/`, `dist/`, and every `skills/` directory the
 * package never carries.
 *
 * This script applies the same patterns to every file `git ls-files` reports,
 * and fails unless each hit is on the explicit sanctioned list below. A hit that
 * is not sanctioned is a blocker for the first public push — which is
 * irreversible once the objects are on a public remote.
 *
 * Usage:
 *   bun scripts/public-flip-scan.ts            # human report, exit 1 on any
 *                                              # unsanctioned hit
 *   bun scripts/public-flip-scan.ts --json     # machine-readable report
 *   bun scripts/public-flip-scan.ts --all      # also list sanctioned hits
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  OWNER_IDENTIFIER_PATTERNS,
  scannableText,
  type OwnerIdentifierSeverity,
} from './owner-identifier-patterns.ts';

export interface OwnerIdentifierHit {
  readonly path: string;
  readonly label: string;
  readonly severity: OwnerIdentifierSeverity;
  readonly match: string;
  /** The reason this hit is allowed to stay, or `undefined` when it is a blocker. */
  readonly sanction?: string | undefined;
}

export interface PublicFlipScanReport {
  readonly scannedFiles: number;
  /**
   * Tracked paths that could not be read as a file at all (a submodule gitlink,
   * a broken symlink). Listed, never silently dropped: an unread file is an
   * unreviewed file, and the flip publishes it either way.
   */
  readonly unreadable: readonly string[];
  /** `identity` hits explicitly allowed to survive the flip. */
  readonly sanctioned: readonly OwnerIdentifierHit[];
  /** `identity` hits with no sanction. Any one of these blocks the first public push. */
  readonly blockers: readonly OwnerIdentifierHit[];
  /**
   * `private-surface` hits: names kept out of the published package but present
   * in tracked repository files, which the owner's flip decision publishes.
   * Reported for review, never blocking.
   */
  readonly privateSurface: readonly OwnerIdentifierHit[];
}

interface SanctionedHit {
  /** Exact tracked path, or a path prefix when it ends with `/`. */
  readonly path: string;
  readonly label: string;
  /** The matched text must satisfy this, so a *different* leak in the same file still fails. */
  readonly match: RegExp;
  readonly reason: string;
}

/**
 * The complete set of owner identifiers that may stay in a public Olympus.
 *
 * Every entry is a decision already recorded in PR #120, #134, or #135. Adding
 * a row here is a scrub decision, not a scan fix: it says "this exact string,
 * in this exact file, is publishable".
 */
export const SANCTIONED_HITS: readonly SanctionedHit[] = [
  // ---- 1. The MIT copyright line. ------------------------------------------
  // `scannableText()` already neutralises the LICENSE copyright line, so
  // LICENSE needs no row: it does not produce a hit at all.

  // ---- 2. Three persisted identifiers naming live state. -------------------
  // Renaming any of them orphans data or breaks a required CI context, so they
  // survive the flip by owner decision (PR #134, "Persisted identifiers").
  {
    path: 'src/core/domain-expert.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: 'Corpus id `governance-jamie-docs`: also the live Vertex RAG display name, so renaming means renaming the live corpus.',
  },
  {
    path: 'skills/governance-research/SKILL.md',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: 'Corpus id `governance-jamie-docs` named in the skill that queries it.',
  },
  {
    path: 'test/domain-expert-worker.test.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: 'Corpus id `governance-jamie-docs` in fixtures for the worker that resolves it.',
  },
  {
    path: 'test/operations.test.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: 'Corpus id `governance-jamie-docs` in operations fixtures.',
  },
  {
    path: 'src/workers/embedding-ledger.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: "Embedding-ledger approver enum value 'jamie' — the append-only value already written to the live ledger; the rendered string is neutral.",
  },
  {
    path: 'src/workers/embedding-ledger-observer.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: "Comment naming the embedding-ledger approver enum value 'jamie'.",
  },
  {
    path: 'src/workers/dashboard/pages/embedding-ledger.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: "Embedding-ledger approver enum value 'jamie' selecting a CSS class; the raw value is never displayed.",
  },
  {
    path: 'scripts/dashboard-preview.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: "Embedding-ledger approver enum value 'jamie' in the dashboard preview fixture.",
  },
  {
    path: 'test/embedding-ledger.test.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: "Embedding-ledger approver enum value 'jamie' under test.",
  },
  {
    path: 'dist/cli.js',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: "Embedding-ledger approver enum value 'jamie', compiled from src/workers/embedding-ledger.ts.",
  },
  {
    path: 'config/critical-review.json',
    label: 'a tenant or host identity',
    match: /^jamiezigelbaum$/i,
    reason: 'Reviewer login the `critical-review` publisher trusts; changing it breaks the required CI context.',
  },
  {
    path: 'test/critical-review-workflow.test.ts',
    label: 'a tenant or host identity',
    match: /^jamiezigelbaum$/i,
    reason: 'Pins the reviewer login in `config/critical-review.json`.',
  },

  // ---- 3. Real GitHub URLs and repository paths. ---------------------------
  {
    path: 'config/private-ops-disposition.json',
    label: 'a tenant or host identity',
    match: /^jamiezigelbaum$/i,
    reason: 'Real private-ops CI receipt URL; the receipt has to be resolvable.',
  },
  {
    path: 'config/private-ops-live-attestation.json',
    label: 'a tenant or host identity',
    match: /^jamiezigelbaum$/i,
    reason: 'Real private-ops CI receipt URL; the receipt has to be resolvable.',
  },
  {
    path: 'scripts/private-ops-disposition.ts',
    label: 'a tenant or host identity',
    match: /^jamiezigelbaum$/i,
    reason: 'Real private-ops CI receipt URL pinned in the disposition checker.',
  },
  {
    path: 'docs/V0_4_BASELINE.md',
    label: 'a tenant or host identity',
    match: /^jamiezigelbaum$/i,
    reason: 'Names the private ops repository by its real path.',
  },

  // ---- 4. The scanners' own ban patterns and leak tripwires. ---------------
  // These have to spell the identifier out or they stop being guards.
  {
    path: 'scripts/owner-identifier-patterns.ts',
    label: 'a tenant or host identity',
    match: /^(?:jamie|jamiezigelbaum|b?zigelbaum|sparta)$/i,
    reason: "The scanner's own ban pattern and the LICENSE copyright exemption; a guard has to spell out what it bans.",
  },
  // This file carries a handful of the literals it sanctions, because an
  // allowlist that cannot name what it allows is not auditable. It is only
  // acceptable because the same strings already sit in the negative-guard tests
  // (`pkm-doctrine`, `lifecycle`, `release-artifact`, `source-skill-runtime-context`)
  // that assert the packaged output never contains them — this adds no new
  // disclosure. Rows whose literal ends up regex-escaped here never match and
  // are dead weight; `SANCTIONED_HITS` is asserted live against the real tree.
  {
    path: 'scripts/public-flip-scan.ts',
    label: 'a tenant or host identity',
    match: /^(?:jamie|jamiezigelbaum|b?zigelbaum|sparta)$/i,
    reason: 'This file: the sanctioned-hit table has to name the exact strings it sanctions.',
  },
  {
    path: 'scripts/public-flip-scan.ts',
    label: 'a Google Cloud project id',
    match: /^(?:olympus-491816|castor-493710|castor-000001)$/i,
    reason: 'This file: names the project ids two forbidden-string assertions must spell out, plus the invented id its own test uses.',
  },
  {
    path: 'scripts/public-flip-scan.ts',
    label: 'private key material',
    match: /^BEGIN PRIVATE KEY$/i,
    reason: 'This file: names the PEM header carried by two synthetic redaction fixtures.',
  },
  {
    path: 'test/public-flip-scan.test.ts',
    label: 'a tenant or host identity',
    match: /^(?:jamie|jamiezigelbaum|zigelbaum|sparta)$/i,
    reason: 'Exercises the ban patterns and the LICENSE exemption, which requires the exact strings.',
  },
  {
    path: 'test/public-flip-scan.test.ts',
    label: 'a tenant email identity',
    match: /^jamie@example\.test$/i,
    reason: 'Reserved example domain proving the LICENSE exemption covers only the copyright line.',
  },
  {
    path: 'test/public-flip-scan.test.ts',
    label: 'an absolute path inside a person\'s home directory',
    match: /^\/Users\/realperson\/$/i,
    reason: 'Invented home root proving a home path outside the neutral list still blocks.',
  },
  {
    path: 'test/public-flip-scan.test.ts',
    label: 'a Google Cloud project id',
    match: /^castor-000001$/i,
    reason: 'Invented project id proving a real-shaped project id outside the neutral list still blocks.',
  },
  {
    path: 'test/public-flip-scan.test.ts',
    label: 'a Google service-account address',
    match: /^olympus-secure@castor-000001\.iam\.gserviceaccount\.com$/i,
    reason: 'Invented service account on the invented project above; proves a non-fixture tenant still blocks.',
  },
  {
    path: 'test/pkm-doctrine.test.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: 'Forbidden-string list for the shipped PKM doctrine pack; neutralising it deletes the guard.',
  },
  {
    path: 'test/release-artifact.test.ts',
    label: 'a tenant or host identity',
    match: /^zigelbaum$/i,
    reason: 'Forbidden-string assertion for the packaged release artifact.',
  },
  {
    path: 'test/lifecycle.test.ts',
    label: 'a tenant or host identity',
    match: /^(?:jamie|sparta)$/i,
    reason: 'Forbidden-string assertion for shipped fixtures: the lifecycle managed-write fixtures must contain neither the owner name nor the private host alias, and the literals ARE the guard.',
  },

  // ---- 5. Deliberate leak tripwires that must spell the owner path out. ----
  {
    path: 'test/source-ingestion-dashboard.test.ts',
    label: 'an absolute path inside a person\'s home directory',
    match: /^\/Users\/zig\/$/i,
    reason: 'Asserts the dashboard HTML never renders the owner Dropbox root; the literal IS the guard (PR #135).',
  },
  {
    path: 'test/source-ingestion-live-dashboard.test.ts',
    label: 'an absolute path inside a person\'s home directory',
    match: /^\/Users\/zig\/$/i,
    reason: 'Asserts the live dashboard HTML never renders the owner Dropbox root; the literal IS the guard (PR #135).',
  },

  {
    path: 'test/release-artifact.test.ts',
    label: 'a Google Cloud project id',
    match: /^(?:olympus-491816|castor-493710)$/i,
    reason: 'Forbidden-string assertion: the packaged skills/docs must not contain these project ids.',
  },
  {
    path: 'test/release-artifact.test.ts',
    label: 'a named GCS bucket',
    match: /^gs:\/\/castor-governance-rag$/i,
    reason: 'Forbidden-string assertion for the packaged artifact.',
  },
  {
    path: 'test/source-skill-runtime-context.test.ts',
    label: 'a Google Cloud project id',
    match: /^(?:olympus-491816|castor-493710)$/i,
    reason: 'Forbidden-string assertion: the rendered governance skill context must not contain these project ids.',
  },
  {
    path: 'test/source-skill-runtime-context.test.ts',
    label: 'a named GCS bucket',
    match: /^gs:\/\/castor-governance-rag$/i,
    reason: 'Forbidden-string assertion for the rendered governance skill context.',
  },

  // ---- 6. Obviously synthetic key material in redaction fixtures. ----------
  {
    path: 'test/data-lifecycle.test.ts',
    label: 'private key material',
    match: /^BEGIN PRIVATE KEY$/i,
    reason: 'PEM header around the literal bodies `policy-private-key` / `config-private-key`; the fixture proves redaction, and no key is present.',
  },
  {
    path: 'test/source-export-dropbox.test.ts',
    label: 'private key material',
    match: /^BEGIN PRIVATE KEY$/i,
    reason: 'PEM header around the literal body `abc123`; the fixture proves export redaction, and no key is present.',
  },

  // ---- 7. Reserved-domain fixture kept deliberately in PR #120. ------------
  {
    path: 'test/gmail-content-provider.test.ts',
    label: 'a tenant email identity',
    match: /^jamie@example\.com$/i,
    reason: 'Reserved example domain; a fixture address, not a real mailbox.',
  },
  {
    path: 'test/gmail-content-provider.test.ts',
    label: 'a tenant or host identity',
    match: /^jamie$/i,
    reason: 'The same reserved-domain fixture address.',
  },
];

/**
 * Matches that are provably not owner identifiers wherever they appear.
 *
 * These exist because two of the patterns are deliberately shape-based rather
 * than name-based: any home-directory path and any service-account address look
 * alike whether the tenant is real or invented. The scrub PRs replaced the real
 * values with these exact neutral ones, so recognising them here keeps the
 * blocking list to actual identity leaks. Each entry is still an exact string,
 * so a *new* home path or project name fails.
 */
export const NEUTRAL_MATCHES: readonly { label: string; match: RegExp; reason: string }[] = [
  {
    label: 'an absolute path inside a person\'s home directory',
    match: /^\/(?:Users|home)\/(?:owner|sam|private|friend|fixture|test-user)\/$/i,
    reason: 'Neutral fixture home root introduced by the scrub PRs; names no real account.',
  },
  {
    label: 'a Google service-account address',
    match: /^(?:olympus-secure@olympus-fixture-project|a@b)\.iam\.gserviceaccount\.com$/i,
    reason: 'Fixture service account on an invented project; not a real tenant identity.',
  },
  {
    label: 'a named GCS bucket',
    match: /^gs:\/\/(?:books|other-bucket|other-rag|wrong-governance-rag|fixture-governance-rag|fixture_governance_rag|fixture-trading-books-rag|rag\.governance\.example-corp\.test|x\.example-corp\.test)$/i,
    reason: 'Invented fixture bucket names; the dotted ones use the reserved .test TLD and prove a domain-scoped name, a one-character leading component, and a flat underscore name all stay legal.',
  },
  {
    label: 'a Vertex RAG corpus resource name',
    // Both halves have to be synthetic: an invented project number from the
    // fourth scrub, and a corpus id of nineteen repeated digits, which no real
    // Vertex corpus id is. A real project number or a real corpus id inside an
    // otherwise-fictional resource name still blocks.
    match: /^projects\/(?:123456789012|987654321098)\/locations\/[a-z0-9-]+\/ragCorpora\/(\d)\1{18}$/i,
    reason: 'Invented project number and synthetic repeated-digit corpus id introduced by the fourth scrub; names no real tenant resource.',
  },
];

const rootDir = join(import.meta.dir, '..');

export function trackedFiles(cwd: string = rootDir): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr ?? ''}`);
  }
  return result.stdout.split('\u0000').filter((entry) => entry.length > 0);
}

function sanctionFor(path: string, label: string, match: string): string | undefined {
  for (const entry of NEUTRAL_MATCHES) {
    if (entry.label === label && entry.match.test(match)) return entry.reason;
  }
  for (const entry of SANCTIONED_HITS) {
    const pathMatches = entry.path.endsWith('/') ? path.startsWith(entry.path) : path === entry.path;
    if (pathMatches && entry.label === label && entry.match.test(match)) return entry.reason;
  }
  return undefined;
}

export function scanTree(cwd: string = rootDir, paths?: readonly string[]): PublicFlipScanReport {
  const sanctioned: OwnerIdentifierHit[] = [];
  const blockers: OwnerIdentifierHit[] = [];
  const privateSurface: OwnerIdentifierHit[] = [];
  const unreadable: string[] = [];
  let scannedFiles = 0;
  for (const path of paths ?? trackedFiles(cwd)) {
    let text: string;
    try {
      text = readFileSync(join(cwd, path), 'utf8');
    } catch {
      // Record it. A tracked path this cannot open is still published, so a
      // silent `continue` would hide exactly the file nobody reviewed.
      unreadable.push(path);
      continue;
    }
    // Every tracked file is scanned, including ones holding NUL bytes. Two
    // WhatsApp connector sources carry a NUL in a string literal; a
    // "binary, skip it" heuristic would have excluded real published source
    // from the only scan standing between it and a public remote. Lossy utf8
    // decoding of a genuinely binary blob yields replacement characters, which
    // match nothing — noise costs less than a blind spot.
    scannedFiles += 1;
    const scannedText = scannableText(path, text);
    for (const { label, pattern, severity } of OWNER_IDENTIFIER_PATTERNS) {
      // Report every distinct match in the file, not just the first. A file
      // may hold one sanctioned identifier and one brand-new leak.
      const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      const seen = new Set<string>();
      for (const found of scannedText.matchAll(global)) {
        const match = found[0];
        if (seen.has(match)) continue;
        seen.add(match);
        const sanction = sanctionFor(path, label, match);
        const hit: OwnerIdentifierHit = { path, label, severity, match, sanction };
        if (severity === 'private-surface') privateSurface.push(hit);
        else if (sanction) sanctioned.push(hit);
        else blockers.push(hit);
      }
    }
  }
  return { scannedFiles, unreadable, sanctioned, blockers, privateSurface };
}

export function formatReport(report: PublicFlipScanReport, showSanctioned: boolean): string {
  const files = (hits: readonly OwnerIdentifierHit[]) => new Set(hits.map((hit) => hit.path)).size;
  const lines: string[] = [];
  lines.push(`Scanned ${report.scannedFiles} tracked files; every tracked file was read.`);
  if (report.unreadable.length > 0) {
    lines.push(`UNREAD (${report.unreadable.length}) — published but never scanned; inspect each by hand:`);
    for (const path of report.unreadable) lines.push(`  - ${path}`);
  }
  lines.push(`identity, sanctioned: ${report.sanctioned.length} hits across ${files(report.sanctioned)} files.`);
  lines.push(`identity, BLOCKING:   ${report.blockers.length} hits across ${files(report.blockers)} files.`);
  lines.push(`private-surface:      ${report.privateSurface.length} hits across ${files(report.privateSurface)} files (published with the repository; not blocking).`);
  if (showSanctioned && report.sanctioned.length > 0) {
    lines.push('');
    lines.push('Sanctioned identity hits:');
    for (const hit of report.sanctioned) {
      lines.push(`  - ${hit.path}: ${hit.label} (${hit.match}) — ${hit.sanction}`);
    }
  }
  if (showSanctioned && report.privateSurface.length > 0) {
    lines.push('');
    lines.push('Private-surface hits (by file):');
    for (const path of [...new Set(report.privateSurface.map((hit) => hit.path))]) {
      const labels = [...new Set(report.privateSurface.filter((hit) => hit.path === path).map((hit) => hit.label))];
      lines.push(`  - ${path}: ${labels.join(', ')}`);
    }
  }
  if (report.blockers.length > 0) {
    lines.push('');
    lines.push('BLOCKING — these must be scrubbed or explicitly sanctioned before the first public push:');
    for (const hit of report.blockers) {
      lines.push(`  - ${hit.path}: ${hit.label} (${hit.match})`);
    }
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const json = process.argv.includes('--json');
  const all = process.argv.includes('--all');
  const report = scanTree();
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report, all));
  if (report.blockers.length > 0) process.exit(1);
}
