/**
 * Fail closed when a pushed commit range adds a high-confidence credential.
 * CI is authoritative; findings name only the file and credential class, never
 * the matching material.
 */
const PATTERNS = Object.freeze([
  ['private_key', /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/],
  ['aws_access_key', /AKIA[0-9A-Z]{16}/],
  ['github_token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['slack_token', /xox[baprs]-[A-Za-z0-9-]{20,}/],
  ['google_api_key', /AIza[0-9A-Za-z_-]{35}/],
] as const);

export interface CredentialFinding {
  file: string;
  kinds: string[];
}

export function scanAddedDiff(diff: string): CredentialFinding[] {
  let file = '<unknown>';
  const findings = new Map<string, Set<string>>();

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    for (const [kind, pattern] of PATTERNS) {
      if (!pattern.test(added)) continue;
      const kinds = findings.get(file) ?? new Set<string>();
      kinds.add(kind);
      findings.set(file, kinds);
    }
  }

  return [...findings.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([findingFile, kinds]) => ({ file: findingFile, kinds: [...kinds].sort() }));
}

export function refusalMessage(findings: readonly CredentialFinding[]): string {
  const summary = findings
    .map((finding) => `${finding.file} (${finding.kinds.join(', ')})`)
    .join('; ');
  return `[credentials] REFUSED: added high-confidence credential pattern(s): ${summary}`;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^[0-9a-f]{40,64}$/.test(value)) {
    throw new Error(`usage: bun scripts/credential-pattern-check.ts --base <sha> --head <sha>`);
  }
  return value;
}

function git(args: string[], stdin?: Uint8Array): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: process.cwd(),
    stdin,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function run(): void {
  let base = argument('--base');
  const head = argument('--head');
  const emptyBase = /^0+$/.test(base);
  if (emptyBase) {
    base = git(['hash-object', '-t', 'tree', '--stdin'], new Uint8Array()).trim();
  }
  const comparisonBase = emptyBase
    ? base
    : git(['merge-base', base, head]).trim();
  const findings = scanAddedDiff(git(['diff', '--text', '--no-ext-diff', '--unified=0', comparisonBase, head]));
  if (findings.length > 0) {
    console.error(refusalMessage(findings));
    process.exit(1);
  }
  console.log('[credentials] no high-confidence credential patterns in added lines');
}

if (import.meta.main) run();
