// Privacy guard: every item is judged on its own content. Only a rule the
// user sets (a sender, folder, label or chat rule, applied by the shared tier
// classifier) decides a whole group of items. Defaults, deployment settings,
// connectors and stores never do: the mistake this guard keeps out came back
// repeatedly as a source "Private by default", a lane floor, a protected chat
// list, or a store's placement read back as a prior. If this test is red, the
// change is reintroducing that mistake. Fix the change, do not weaken the guard.

import { Glob } from 'bun';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const SURFACES = ['src/**/*.ts', 'scripts/**/*.ts', 'scripts/**/*.py', 'scripts/**/*.sh', 'config/**/*'];

// Names of the retired group-level privacy paths. None may come back.
const RETIRED = [
  /\bstoredPlacementIsPrior\b/,
  /\blaneFloor\b/,
  /source_default/,
  /PROTECTED_CHAT_SCOPES/,
  /CHAT_CLASSIFICATIONS_JSON/,
  /telegram-protected-chat-scopes/,
];

// Every floor a connector may publish is a fact about the one item it is on.
// A new basis needs that argument here, in review, before it ships.
const ITEM_FLOOR_BASES: Record<string, string> = {
  TELEGRAM_SECRET_REDACTED_FLOOR_BASIS: 'this message\'s own text was cleared as a Secret',
  WHATSAPP_SECRET_REDACTED_FLOOR_BASIS: 'this message\'s own text was cleared as a Secret',
  "'provider:secret_chat'": 'Telegram marks this message as sent in an end-to-end Secret Chat',
};

/** A file's lines without its comment lines. */
function code(text: string): string[] {
  return text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

function sources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const pattern of SURFACES) {
    for (const path of new Glob(pattern).scanSync({ cwd: repoRoot, dot: false })) {
      out.push({ path, text: readFileSync(join(repoRoot, path), 'utf8') });
    }
  }
  return out;
}

test('no retired group-level privacy path is back', () => {
  const offenders = sources().flatMap(({ path, text }) =>
    RETIRED.filter((pattern) => pattern.test(text)).map((pattern) => `${path}: ${pattern}`));
  expect(offenders).toEqual([]);
});

// Where a prior may appear at all: the signal type and the shared classifier
// that applies the owner's rules. Everywhere else in src a prior is a group
// decision made by code, which is what this guard keeps out.
const PRIOR_OWNERS = new Set([
  'src/core/classification-signals.ts',
  'src/workers/classification/tier-classifier.ts',
]);

// The one connector prior left, with why and when it goes. Counted, so a second
// prior in the same file fails. It only shrinks.
const PRIOR_LEFTOVERS: Record<string, { count: number; reason: string }> = {
  'src/workers/telegram-messages/record-builder.ts': {
    count: 1,
    reason: 'Capture records written before 2026-10-28 by a deployment\'s protected-chat setting still say secure_local; '
      + 'the helper writes every new record internal, so this rests nothing new. Retire when the capture lanes merge.',
  },
};

// Every way code can set a prior: an object key, shorthand, assignment, or
// bracket access. Local variables that happen to be named `prior` do not match.
const PRIOR_WRITES = [
  /(^|[{,])\s*prior\s*:\s*[^\s:]/,
  /[{,]\s*prior\s*[,}]/,
  /\.prior\s*=[^=]/,
  /\[\s*['"`]prior['"`]\s*\]/,
];

function priorWrites(text: string): number {
  return code(text).filter((line) => PRIOR_WRITES.some((pattern) => pattern.test(line))).length;
}

test('no connector publishes a prior: only the user\'s own rules rest a group of items', () => {
  const offenders = sources()
    .filter(({ path }) => path.startsWith('src/') && !PRIOR_OWNERS.has(path))
    .map(({ path, text }) => ({ path, writes: priorWrites(text) }))
    .filter(({ path, writes }) => writes > (PRIOR_LEFTOVERS[path]?.count ?? 0))
    .map(({ path, writes }) => `${path}: ${writes}`);
  expect(offenders).toEqual([]);
});

test('every leftover prior is still there, so the list only shrinks', () => {
  const texts = new Map(sources().map(({ path, text }) => [path, text]));
  const stale = Object.entries(PRIOR_LEFTOVERS)
    .filter(([path, { count }]) => priorWrites(texts.get(path) ?? '') < count)
    .map(([path]) => path);
  expect(stale).toEqual([]);
});

test('every published floor is a fact about its own item', () => {
  const floors = sources()
    .filter(({ path }) => path.startsWith('src/') && !PRIOR_OWNERS.has(path))
    .flatMap(({ path, text }) => code(text).flatMap((line) =>
      [...line.matchAll(/\bfloor\s*:\s*(\{[^}]*\}?|[\w$.]+\s*\()/g)].map((match) => ({ path, value: match[1]! }))));
  expect(floors.length).toBeGreaterThan(0);
  const unknown = floors.filter(({ value }) => {
    const basis = /basis\s*:\s*([^\s,}]+)/.exec(value)?.[1];
    return !basis || !(basis in ITEM_FLOOR_BASES);
  });
  expect(unknown).toEqual([]);
});
