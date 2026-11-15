#!/usr/bin/env bun
// Correctness check for a build that moves where the engine finds rows but
// must not change what it decides (loop-stall step-back, families 1-4).
// Run two builds' engines on two copies made from one starting copy, each
// through a hidden-set build, a status recount and a full settle pass, then:
//   bun eval/loop-finders-compare.ts --base <start copy> --a <copy run by build A> --b <copy run by build B>
// It opens nothing for writing (each ledger read-only, query_only) and prints
// counts only: per corpus, the status snapshot's numbers (timings and stamps
// left out); per ledger, rows by tiers, state and decider, overrides, copies by
// corpus and state, and rows each run raised, lowered or changed since the
// start copy. Exit 1 when A and B differ in any count, with every difference named.
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const LEDGER_SUFFIX = '.tier-ledger.sqlite';
const SNAPSHOT = 'source-status-snapshot.json';
const RANK: Record<string, number> = { public: 0, private: 1, secure: 2, secrets: 3 };
// Keys that say when or how long, not what: left out of the comparison.
const VOLATILE = /(^|_)(at|ms|age|seconds|duration|written|refreshed|stamp|instance|epoch_started|last_refresh|reconciled)($|_)|At$|Ms$/;

function args(): { base: string; a: string; b: string } {
  const get = (name: string) => {
    const at = process.argv.indexOf(`--${name}`);
    const value = at >= 0 ? process.argv[at + 1] : undefined;
    if (!value || !existsSync(value)) throw new Error(`--${name} <data root> is required and must exist`);
    return value;
  };
  return { base: get('base'), a: get('a'), b: get('b') };
}

function files(root: string, test: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isDirectory()) files(path, test, out);
    else if (test(name)) out.push(path);
  }
  return out;
}

/** Numbers and short strings of a JSON value, keyed by path, without the volatile keys. */
function flatten(value: unknown, path: string, out: Map<string, string | number | boolean>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    // Corpora are listed in an array: key them by corpus id, not position.
    value.forEach((entry, index) => {
      const id = entry && typeof entry === 'object' && typeof (entry as { corpus_id?: unknown }).corpus_id === 'string'
        ? (entry as { corpus_id: string }).corpus_id : String(index);
      flatten(entry, `${path}[${id}]`, out);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) if (!VOLATILE.test(key)) flatten(entry, path ? `${path}.${key}` : key, out);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 64)) out.set(path, value);
}

function snapshotCounts(root: string): Map<string, string | number | boolean> {
  const out = new Map<string, string | number | boolean>();
  for (const path of files(root, (name) => name === SNAPSHOT)) flatten(JSON.parse(readFileSync(path, 'utf8')), `status:${relative(root, path)}`, out);
  return out;
}

function ledgerCounts(root: string, base: string): Map<string, number> {
  const out = new Map<string, number>();
  const put = (key: string, n: number) => out.set(key, (out.get(key) ?? 0) + n);
  for (const path of files(root, (name) => name.endsWith(LEDGER_SUFFIX))) {
    const name = relative(root, path);
    const db = new Database(path, { readonly: true });
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 10000;');
      for (const row of db.query(`SELECT metadata_tier m, content_tier c, state s, decided_by d, count(*) n FROM tier_items GROUP BY 1, 2, 3, 4`).all() as Array<{ m: string; c: string; s: string; d: string; n: number }>) {
        put(`ledger:${name}:items:${row.m}/${row.c}:${row.s}:${row.d}`, row.n);
      }
      put(`ledger:${name}:overrides`, (db.query('SELECT count(*) n FROM tier_overrides').get() as { n: number }).n);
      for (const row of db.query(`SELECT corpus_id k, copy_state s, count(*) n FROM tier_copies GROUP BY 1, 2`).all() as Array<{ k: string; s: string; n: number }>) {
        put(`ledger:${name}:copies:${row.k}:${row.s}`, row.n);
      }
      const start = join(base, name);
      if (existsSync(start)) {
        // A read-only connection opens what it attaches read-only too.
        db.query('ATTACH DATABASE ? AS start').run(start);
        const rows = db.query(`SELECT i.metadata_tier m, i.content_tier c, s.metadata_tier sm, s.content_tier sc,
            i.generation g, s.generation sg, i.state st, s.state sst, i.decided_by d, s.decided_by sd, i.reasons_json r, s.reasons_json sr
          FROM tier_items i JOIN start.tier_items s USING (provider, account_scope, provider_item_id)
          WHERE i.generation IS NOT s.generation OR i.state IS NOT s.state OR i.reasons_json IS NOT s.reasons_json
            OR i.metadata_tier IS NOT s.metadata_tier OR i.content_tier IS NOT s.content_tier`).all() as Array<Record<string, string | number>>;
        for (const row of rows) {
          const before = Math.max(RANK[row.sm as string] ?? 0, RANK[row.sc as string] ?? 0);
          const after = Math.max(RANK[row.m as string] ?? 0, RANK[row.c as string] ?? 0);
          put(`ledger:${name}:since_start:${after > before ? 'raised' : after < before ? 'lowered' : 'changed_same_tier'}`, 1);
          put(`ledger:${name}:since_start:decided_by:${row.sd}->${row.d}`, 1);
        }
        put(`ledger:${name}:since_start:new_rows`, (db.query(`SELECT count(*) n FROM tier_items i WHERE NOT EXISTS (SELECT 1 FROM start.tier_items s
          WHERE s.provider = i.provider AND s.account_scope = i.account_scope AND s.provider_item_id = i.provider_item_id)`).get() as { n: number }).n);
      }
    } finally { db.close(); }
  }
  return out;
}

const { base, a, b } = args();
const left = new Map<string, unknown>([...snapshotCounts(a), ...ledgerCounts(a, base)]);
const right = new Map<string, unknown>([...snapshotCounts(b), ...ledgerCounts(b, base)]);
const differences: string[] = [];
for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
  if (left.get(key) !== right.get(key)) differences.push(`${key}: A=${left.get(key) ?? '-'} B=${right.get(key) ?? '-'}`);
}
console.log(JSON.stringify({ keys: left.size, compared: new Set([...left.keys(), ...right.keys()]).size, differences: differences.length }));
for (const line of differences) console.log(line);
for (const [key, value] of [...left].filter(([key]) => key.includes(':since_start:')).sort()) console.log(`A ${key} = ${value}`);
process.exit(differences.length === 0 ? 0 : 1);
