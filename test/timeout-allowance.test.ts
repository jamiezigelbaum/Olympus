import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every timeout in the product is listed with its kind in
 * config/timeout-allowance.json, and the clocks that cancel work that may
 * still be progressing (kind a) can only go down. The rule: a clock never
 * cancels progressing work. It rests on progress or a heartbeat, returns
 * partial work that names what is unfinished, or hands an outside client a
 * "still working" handle.
 */
const repoRoot = join(import.meta.dir, '..');
const ALLOWANCE_PATH = 'config/timeout-allowance.json';

/**
 * Kind (a) sites today. Lower it as they go; it never rises.
 */
const KIND_A_CEILING = 27;

const KINDS = new Set(['a', 'b', 'c', 'd', 'n']);
const CONSTANT = /\b(?:export\s+)?(?:const|readonly|static\s+readonly|private\s+static\s+readonly)\s+([A-Z][A-Z0-9_]*(?:TIMEOUT|DEADLINE|_WAIT|BUDGET|GRACE|STALL|BOUND|ABANDON|HANDOFF|PASS_TIME|MAX_PASS|STAND_BACK_MAX|SELF_HEAL_MAX)[A-Z0-9_]*?_(?:MS|SECONDS))\s*(?::[^=]+)?=\s*([^;]+);/;
const INLINE = /AbortSignal\.timeout\([^)]*?\d[\d_]{2,}|\b[A-Za-z]*(?:[Tt]imeout|[Dd]eadline)(?:Ms|Seconds)?\s*:\s*\d|setTimeout\([^)]*abort/;

type Scan = { constants: Set<string>; inline: Map<string, number> };

function scanTimeouts(files: Iterable<[path: string, source: string]>): Scan {
  const constants = new Set<string>();
  const inline = new Map<string, number>();
  for (const [path, source] of files) {
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      const named = CONSTANT.exec(line);
      if (named && /\d/.test(named[2]!)) constants.add(`${path}#${named[1]}`);
      else if (INLINE.test(line)) inline.set(path, (inline.get(path) ?? 0) + 1);
    }
  }
  return { constants, inline };
}

function productFiles(): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  for (const root of ['src', 'connect-relay']) {
    for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(repoRoot, root) })) {
      const path = `${root}/${relative}`;
      if (/\/test\/|generated|\.test\.ts$/.test(path)) continue;
      files.push([path, readFileSync(join(repoRoot, path), 'utf8')]);
    }
  }
  return files;
}

type Allowance = { constants: Record<string, string>; inline: Record<string, Record<string, number>> };

describe('timeouts never cancel progressing work (kind a only shrinks)', () => {
  test('every timeout is listed with its kind, and the listing matches the code', () => {
    const allowance = JSON.parse(readFileSync(join(repoRoot, ALLOWANCE_PATH), 'utf8')) as Allowance;
    const { constants, inline } = scanTimeouts(productFiles());
    const problems: string[] = [];
    for (const key of [...constants].sort()) {
      if (!(key in allowance.constants)) problems.push(`${key}: a new timeout. List it in ${ALLOWANCE_PATH} with its kind; a clock that cancels progressing work (kind a) is not allowed.`);
    }
    for (const [key, kind] of Object.entries(allowance.constants)) {
      if (!KINDS.has(kind[0]!)) problems.push(`${key}: unknown kind ${kind}.`);
      if (!constants.has(key)) problems.push(`${key}: no longer in the code. Remove its entry from ${ALLOWANCE_PATH}.`);
    }
    for (const [path, count] of [...inline].sort(([a], [b]) => a.localeCompare(b))) {
      const listed = Object.values(allowance.inline[path] ?? {}).reduce((sum, n) => sum + n, 0);
      if (count > listed) problems.push(`${path}: ${count} inline timeouts, ${listed} listed. List the new one in ${ALLOWANCE_PATH} with its kind.`);
      else if (count < listed) problems.push(`${path}: down to ${count} inline timeouts from ${listed}. Lower the entry for the kind that went.`);
    }
    for (const [path, kinds] of Object.entries(allowance.inline)) {
      for (const kind of Object.keys(kinds)) if (!KINDS.has(kind[0]!)) problems.push(`${path}: unknown kind ${kind}.`);
      if (!inline.has(path)) problems.push(`${path}: no inline timeouts left. Remove its entry from ${ALLOWANCE_PATH}.`);
    }
    expect(problems).toEqual([]);
  });

  test('kind (a) never rises above its ceiling, and the ceiling follows it down', () => {
    const allowance = JSON.parse(readFileSync(join(repoRoot, ALLOWANCE_PATH), 'utf8')) as Allowance;
    let kindA = Object.values(allowance.constants).filter(kind => kind.startsWith('a')).length;
    for (const kinds of Object.values(allowance.inline)) {
      for (const [kind, count] of Object.entries(kinds)) if (kind.startsWith('a')) kindA += count;
    }
    expect(kindA <= KIND_A_CEILING ? kindA : `kind (a) rose to ${kindA}; make the new clock rest on progress instead`).toBe(KIND_A_CEILING);
  });

  test('the scan finds named, inline and default timeouts and ignores comments and types', () => {
    const { constants, inline } = scanTimeouts([['x.ts', `
      export const FETCH_TIMEOUT_MS = 20_000;
      const STOP_GRACE_MS: number = 5_000;
      const TIMEOUT_MS = options.timeoutMs;
      // const OLD_TIMEOUT_MS = 1_000;
      const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
      await run({ timeoutMs: 30_000 });
      const limits = { responseTotalTimeoutMs: 30 * 60_000 };
      type T = { timeoutMs: number };
    `]]);
    expect([...constants]).toEqual(['x.ts#FETCH_TIMEOUT_MS', 'x.ts#STOP_GRACE_MS']);
    expect(inline.get('x.ts')).toBe(3);
  });
});
