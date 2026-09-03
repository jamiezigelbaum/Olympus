import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CANONICAL_HEADING = '## Venice S4 policy (normative)';

const REQUIRED_FLOOR_MARKERS = [
  'Venice privacy categories are ordered `anonymized < private < tee < e2ee`.',
  'Any EvidencePack carrying `secure_local` (S4) evidence has a Venice privacy floor of **Private**.',
  'Venice is an `encrypted_cloud` analyst approved for raw `secure_local` S4 packs whenever the install\'s sovereignty config routes it',
  '`standard_cloud` is banned for every pack containing `secure_local` candidates.',
  'S5 and `blocked_sensitive` content never leaves local and never enters any cloud analyst, including Venice.',
  '`anonymized` produces a typed policy refusal.',
  'Every refusal occurs before chat dispatch and never falls back to another provider.',
] as const;

const REQUIRED_AUTHORITY_MARKERS = [
  'The Venice-published [List Models catalog](https://docs.venice.ai/api-reference/endpoint/models/list) is the category authority;',
  'Olympus reads `data[].model_spec.privacy`.',
  'Any model in a Private-and-above category becomes category-eligible the moment Venice ships it, with no per-model Olympus allowlist; dispatch-readiness gates still apply.',
  '24-hour default TTL.',
  'The pinned snapshot is an offline fallback only:',
  'An unsigned fresh cache cannot by itself upgrade a model that the pinned snapshot classifies as `anonymized`.',
  'A successful live catalog response remains authoritative.',
  'A cached-catalog miss triggers one bounded, rate-limited catalog refresh.',
  'Absence after a successful refresh refuses.',
  '`egress_destination` appears in two kinds of receipt with two meanings.',
] as const;

const REQUIRED_LINEAGE_MARKERS = [
  '2026-05-28',
  '2026-07-06',
  '2026-07-11',
  '2026-07-20',
  '2026-07-21',
  '2026-07-23',
] as const;

const REQUIRED_CANONICAL_MARKERS = [
  ...REQUIRED_FLOOR_MARKERS,
  ...REQUIRED_AUTHORITY_MARKERS,
  ...REQUIRED_LINEAGE_MARKERS,
] as const;

// Exact former copies only. Broad policy vocabulary is intentionally not
// guarded: historical decisions and implementation discussion remain valid
// documentation, while these sentences are known normative/stale duplicates.
const FORBIDDEN_OTHER_DOC_PHRASES = [
  {
    label: 'pre-category-gate redacted-pack-only flow',
    phrase: 'Only then may a cloud model see the **redacted** pack. Raw `secure_local` content never crosses;',
  },
  {
    label: 'pre-category-floor anonymized wording',
    phrase: 'Venice models in the `anonymized` category (Venice\'s lowest privacy tier) are NOT approved for S4.',
  },
  {
    label: 'E2EE-only raw-S4 claim',
    phrase: 'Only the E2EE Venice backend may see raw S4.',
  },
  {
    label: 'pre-ruling local-until-E2EE claim',
    phrase: 'S4 stays local until the real Venice E2EE contract passes;',
  },
  {
    label: 'pre-ruling non-S4-only Venice claim',
    phrase: 'Venice is approved for non-S4 work and bounded derivatives now, and as the candidate raw-S4 replacement only after',
  },
  {
    label: 'SOVEREIGNTY_CONFIG category-floor copy',
    phrase: 'raw secure data may route to Venice only when the resolved model has pinned privacy category `private`, `tee`, or `e2ee`;',
  },
  {
    label: 'SOVEREIGNTY_CONFIG preset-floor copy',
    phrase: 'Venice Private or TEE models are acceptable by default; Venice Anonymized is never an S4 lane.',
  },
  {
    label: 'OPSEC_MODEL category-floor copy',
    phrase: 'Raw S4 evidence may also reach a configured Venice `encrypted_cloud` analyst only at privacy category Private or above (`private`, `tee`, `e2ee`).',
  },
  {
    label: 'OPSEC_MODEL dispatch-refusal copy',
    phrase: 'When sovereignty configuration routes raw S4 reasoning to Venice, the resolved model must have pinned category Private, TEE, or E2EE;',
  },
  {
    label: 'TRUST_MODEL category-floor copy',
    phrase: 'Venice `encrypted_cloud` models may see raw S4 when sovereignty policy routes them and their pinned privacy category is Private, TEE, or E2EE;',
  },
  {
    label: 'TRUST_MODEL model-context copy',
    phrase: 'Model reasoning may use local analysts or an explicitly routed Venice model at category Private or above;',
  },
  {
    label: 'SECURE_CUSTODY_MODEL approval copy',
    phrase: 'Venice is an approved S4 trusted-private analyst backend for that turn when the active sovereignty route permits it.',
  },
  {
    label: 'CTO role approval copy',
    phrase: 'Venice is an approved S4 private-cloud escalation backend for that turn.',
  },
] as const;

function normalizedProse(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function canonicalSection(content: string): string | undefined {
  const headingStart = content.indexOf(CANONICAL_HEADING);
  if (headingStart === -1) return undefined;
  const afterHeading = content.slice(headingStart + CANONICAL_HEADING.length);
  const nextHeading = afterHeading.search(/^## /m);
  return nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
}

function inspectVenicePolicyDocs(docsRoot: string): string[] {
  const failures: string[] = [];
  const contractsPath = join(docsRoot, 'CONTRACTS.md');
  if (!existsSync(contractsPath)) return ['docs/CONTRACTS.md: canonical document missing'];

  const contracts = readFileSync(contractsPath, 'utf8');
  const section = canonicalSection(contracts);
  if (!section) {
    failures.push(`docs/CONTRACTS.md: missing ${CANONICAL_HEADING}`);
  } else {
    const normalizedSection = normalizedProse(section);
    for (const marker of REQUIRED_CANONICAL_MARKERS) {
      if (!normalizedSection.includes(marker)) {
        failures.push(`docs/CONTRACTS.md: canonical marker missing: ${marker}`);
      }
    }
  }

  for (const relativePath of new Glob('**/*.md').scanSync({ cwd: docsRoot })) {
    const normalizedPath = relativePath.split('\\').join('/');
    if (normalizedPath === 'CONTRACTS.md') continue;
    const content = normalizedProse(readFileSync(join(docsRoot, relativePath), 'utf8'));
    for (const forbidden of FORBIDDEN_OTHER_DOC_PHRASES) {
      if (content.includes(forbidden.phrase)) {
        failures.push(`${normalizedPath}: ${forbidden.label}: ${forbidden.phrase}`);
      }
    }
  }

  return failures;
}

describe('Venice S4 policy drift guard', () => {
  test('the canonical policy is complete and other docs do not restate guarded copies', () => {
    const docsRoot = process.env.OLYMPUS_POLICY_DOCS_ROOT
      ? resolve(process.env.OLYMPUS_POLICY_DOCS_ROOT)
      : join(REPO_ROOT, 'docs');
    expect(inspectVenicePolicyDocs(docsRoot)).toEqual([]);
  });

  test('a butchered category floor is rejected', () => {
    const docsRoot = mkdtempSync(join(tmpdir(), 'olympus-venice-policy-'));
    try {
      const canonical = readFileSync(join(REPO_ROOT, 'docs', 'CONTRACTS.md'), 'utf8');
      writeFileSync(
        join(docsRoot, 'CONTRACTS.md'),
        canonical.replace(
          'has a Venice privacy\nfloor of **Private**.',
          'has no fixed Venice privacy floor.',
        ),
      );
      expect(inspectVenicePolicyDocs(docsRoot)).toContain(
        `docs/CONTRACTS.md: canonical marker missing: ${REQUIRED_FLOOR_MARKERS[1]}`,
      );
    } finally {
      rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test('a butchered immediate catalog approval is rejected', () => {
    const docsRoot = mkdtempSync(join(tmpdir(), 'olympus-venice-policy-'));
    try {
      const canonical = readFileSync(join(REPO_ROOT, 'docs', 'CONTRACTS.md'), 'utf8');
      writeFileSync(
        join(docsRoot, 'CONTRACTS.md'),
        canonical.replace(
          'becomes category-eligible the moment Venice\nships it, with no per-model Olympus allowlist; dispatch-readiness gates still\napply.',
          'requires a per-model Olympus approval after Venice ships it.',
        ),
      );
      expect(inspectVenicePolicyDocs(docsRoot)).toContain(
        `docs/CONTRACTS.md: canonical marker missing: ${REQUIRED_AUTHORITY_MARKERS[2]}`,
      );
    } finally {
      rmSync(docsRoot, { recursive: true, force: true });
    }
  });
});
