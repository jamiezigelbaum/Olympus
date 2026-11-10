// Reads the worker's dispatch (src/workers/email-source/index.ts) for the
// engine split's route guard (#1224). It does not try to understand every way
// a handler could be written: it knows the forms the worker uses and reports
// any other use of `request.method` as unrecognised, so a new form fails the
// guard until the scan learns it. What it returns is every path, beneath the
// worker's basePath, that a handler serves to a method other than GET, HEAD
// or OPTIONS, prefix routes' actions included.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Uses of `request.method` that dispatch nothing: what precedes them. */
const NON_DISPATCH = [/\bmethod: $/, /\bisV04PublicDashboardRoute\($/, /\bworkerRouteAllowed\($/];

export interface WorkerRouteScan {
  /** Paths beneath basePath served to a writing method, e.g. `/source/answer`. */
  writes: Set<string>;
  /** Dispatch the scan does not recognise, as `line N: text`. */
  unrecognized: string[];
}

export function scanWorkerWriteRoutes(source: string): WorkerRouteScan {
  const writes = new Set<string>();
  const unrecognized: string[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  const report = (index: number, why: string) => {
    const line = source.split('\n')[lineOf(index) - 1]!.trim();
    unrecognized.push(`line ${lineOf(index)}: ${why}: ${line.slice(0, 160)}`);
  };
  for (const match of source.matchAll(/\brequest\.method\b/g)) {
    const at = match.index!;
    const from = source.slice(at);
    const before = source.slice(Math.max(0, at - 40), at);
    if (NON_DISPATCH.some((form) => form.test(before))) continue;
    const compared = /^request\.method\s*===\s*(['"`])([A-Z]+)\1/.exec(from);
    if (!compared) { report(at, 'not a request.method === \'METHOD\' test'); continue; }
    if (READ_METHODS.has(compared[2]!)) continue;
    const condition = enclosingIfCondition(source, at);
    if (!condition) { report(at, 'a writing method tested outside an if condition'); continue; }
    const text = source.slice(condition.open + 1, condition.close);
    const exact = [...text.matchAll(/url\.pathname === `\$\{basePath\}(\/[^`$]*)`/g)].map((m) => m[1]!);
    const prefixes = [...text.matchAll(/url\.pathname\.startsWith\(`\$\{basePath\}(\/[^`$]*\/)`\)/g)].map((m) => m[1]!);
    const cli = /url\.pathname\.startsWith\(`\$\{basePath\}\$\{WORKER_CLI_ROUTE_PREFIX\}`\)/.test(text);
    const basePathMentions = (text.match(/basePath/g) ?? []).length;
    if (basePathMentions !== exact.length + prefixes.length + (cli ? 1 : 0)) { report(at, 'a basePath path in a form the scan does not know'); continue; }
    if (basePathMentions === 0) {
      // Not a /v1 route: the dashboard's own routes, which index.ts serves only
      // when V0_4_PUBLIC_DASHBOARD_ROUTES lists them. A writer with no path
      // test, or with a literal /v1 path, is not one of those.
      if (!/pathname/.test(text)) { report(at, 'a writing method with no path test'); continue; }
      // Only dashboard paths: a literal under /dashboard or a DASHBOARD_ constant.
      const rest = text
        .replace(/request\.method === (['"`])[A-Z]+\1/g, '')
        .replace(/(['"`])\/dashboard[^'"`]*\1/g, '')
        .replace(/\bDASHBOARD_[A-Z_]+(?:\.\w+)?/g, '')
        .replace(/\burl\.pathname\b/g, '')
        .replace(/\bas readonly string\[\]/g, '')
        .replace(/\.(?:includes|startsWith)\b/g, '')
        .replace(/===|\|\||&&|[()[\],\s]/g, '');
      if (rest !== '') report(at, 'a writer path that is not a dashboard route the scan can read');
      continue;
    }
    for (const path of exact) writes.add(path);
    if (prefixes.length === 0 && !cli) continue;
    const body = blockAfter(source, condition.close);
    if (!body) { report(at, 'a prefix route without a block'); continue; }
    const block = source.slice(body.open + 1, body.close);
    if (cli) {
      if (!/WORKER_CLI_OPERATIONS\s*\n?\s*\.find\(/.test(block)) report(at, 'a CLI prefix route that does not dispatch through WORKER_CLI_OPERATIONS');
      continue;
    }
    const actions = [...block.matchAll(/\baction === (['"`])([\w-]+)\1/g)].map((m) => m[2]!);
    const otherActionUses = (block.match(/\baction\b/g) ?? []).length - actions.length;
    const declared = /const action = url\.pathname\.slice\(/.test(block) ? 1 : 0;
    if (actions.length === 0 || otherActionUses !== declared) { report(at, 'a prefix route whose actions are not each an action === \'name\' test'); continue; }
    for (const prefix of prefixes) for (const action of actions) writes.add(`${prefix}${action}`);
  }
  return { writes, unrecognized };
}

/** The `if (...)` whose parentheses hold `index`, as the positions of its two parentheses. */
function enclosingIfCondition(source: string, index: number): { open: number; close: number } | undefined {
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const char = source[at];
    if (char === ')') depth += 1;
    else if (char === '(') {
      if (depth > 0) { depth -= 1; continue; }
      if (/\bif\s*$/.test(source.slice(Math.max(0, at - 8), at))) {
        const close = matching(source, at, '(', ')');
        return close === undefined ? undefined : { open: at, close };
      }
    } else if (char === ';' || char === '{' || char === '}') {
      if (depth === 0) return undefined;
    }
  }
  return undefined;
}

function blockAfter(source: string, close: number): { open: number; close: number } | undefined {
  const open = source.indexOf('{', close);
  if (open < 0 || source.slice(close + 1, open).trim() !== '') return undefined;
  const end = matching(source, open, '{', '}');
  return end === undefined ? undefined : { open, close: end };
}

/** The bracket that closes the one at `open`, skipping quoted strings and line comments. */
function matching(source: string, open: number, opener: string, closer: string): number | undefined {
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    const char = source[at]!;
    if (char === '\'' || char === '"') {
      for (at += 1; at < source.length && source[at] !== char; at += 1) if (source[at] === '\\') at += 1;
      continue;
    }
    if (char === '/' && source[at + 1] === '/') { at = source.indexOf('\n', at); if (at < 0) return undefined; continue; }
    if (char === opener) depth += 1;
    else if (char === closer) { depth -= 1; if (depth === 0) return at; }
  }
  return undefined;
}

/** The family-scoped aliases index.ts rewrites to the generic extraction paths. */
export function scanFileExtractionAliases(source: string): string[] {
  const start = source.indexOf('const FILE_EXTRACTION_ROUTE_ALIASES');
  const end = source.indexOf(']);', start);
  return [...source.slice(start, end).matchAll(/\['(\/[^']+)', \{/g)].map((m) => m[1]!);
}
