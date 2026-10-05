/**
 * Build the consult gate's vocabulary packs (src/core/consult-gate.ts) under
 * assets/consult/vocabulary/. Each pack is a gzip-compressed, sorted list of
 * lower-case a-z words, one per line, with no comment lines; its SHA-256 is
 * pinned in src/core/consult-gate.ts (CONSULT_VOCABULARY_PACKS) and checked at
 * load. Offline: the source packages are fetched by hand with `npm pack`.
 *
 * Packs and sources (licences reproduced next to the packs):
 *   en-scowl   SCOWL by Kevin Atkinson, via npm wordlist-english 1.2.1.
 *              All dialects, sizes <= 70, words with no capital letter.
 *              Licence: SCOWL copyright notice (permissive; SCOWL-COPYRIGHT.txt).
 *   nl-opentaal OpenTaal Dutch spelling dictionary, via npm dictionary-nl 2.0.0.
 *              Stems with no capital letter, expanded with the dictionary's
 *              own prefix and suffix rules (one level, no compounds).
 *              Licence: Revised BSD (chosen of BSD-3-Clause OR CC-BY-3.0;
 *              OPENTAAL-LICENSE.txt).
 *   cldr-names Unicode CLDR 48.2: unit display names and unit patterns, and
 *              country and macro-region names (territory codes of two
 *              letters or three digits; no subdivisions, no cities), for
 *              en, es, fr, de, it, pt, nl. Licence: Unicode-3.0 (UNICODE-LICENSE.txt).
 *
 * Usage:
 *   bun scripts/build-consult-vocabulary.ts <wordlist-english dir> <dictionary-nl dir> <cldr-localenames-full dir> <cldr-units-full dir>
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [scowlDir, nlDir, namesDir, unitsDir] = process.argv.slice(2);
if (!scowlDir || !nlDir || !namesDir || !unitsDir) throw new Error('usage: see the header');
const OUT = 'assets/consult/vocabulary';
const LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl'];

function words(text: string): string[] {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ß/gu, 'ss')
    .split(/[^\p{L}]+/u).filter((part) => /^[a-z]+$/u.test(part));
}

function writePack(id: string, set: Set<string>): void {
  const body = `${[...set].sort().join('\n')}\n`;
  const gz = gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
  writeFileSync(join(OUT, `${id}.txt.gz`), gz);
  console.log(`${id}\t${set.size} words\t${body.length} bytes raw\t${gz.length} bytes gz\tsha256 ${createHash('sha256').update(gz).digest('hex')}`);
}

// en-scowl
{
  const set = new Set<string>();
  for (const dialect of ['english', 'american', 'british', 'canadian', 'australian']) {
    for (const size of [10, 20, 35, 40, 50, 55, 60, 70]) {
      for (const word of JSON.parse(readFileSync(join(scowlDir, `${dialect}-words-${size}.json`), 'utf8')) as string[]) {
        if (/\p{Lu}/u.test(word)) continue;
        for (const part of words(word)) set.add(part);
      }
    }
  }
  writePack('en-scowl', set);
}

// nl-opentaal: stems plus one level of the dictionary's own affix rules.
{
  const aff = readFileSync(join(nlDir, 'index.aff'), 'utf8').split('\n');
  const rules = new Map<string, Array<{ prefix: boolean; strip: string; add: string; condition: RegExp }>>();
  const excluded = new Set<string>();
  for (const line of aff) {
    const parts = line.trim().split(/\s+/u);
    if (parts[0] === 'FORBIDDENWORD' || parts[0] === 'ONLYINCOMPOUND' || parts[0] === 'NEEDAFFIX') excluded.add(parts[1]!);
    if ((parts[0] === 'SFX' || parts[0] === 'PFX') && parts.length >= 5) {
      const [kind, flag, strip, rawAdd, condition] = parts as [string, string, string, string, string];
      const add = rawAdd.split('/')[0]!;
      const list = rules.get(flag) ?? [];
      const prefix = kind === 'PFX';
      const pattern = condition === '.' ? '' : condition;
      list.push({
        prefix,
        strip: strip === '0' ? '' : strip,
        add: add === '0' ? '' : add,
        condition: new RegExp(prefix ? `^${pattern}` : `${pattern}$`, 'u'),
      });
      rules.set(flag, list);
    }
  }
  const set = new Set<string>();
  const dic = readFileSync(join(nlDir, 'index.dic'), 'utf8').split('\n').slice(1);
  for (const entry of dic) {
    const [stem, flagText = ''] = entry.split('/');
    if (!stem || /\p{Lu}/u.test(stem)) continue;
    const flags = flagText.match(/../gu) ?? [];
    if (flags.some((flag) => excluded.has(flag))) continue;
    const forms = [stem];
    for (const flag of flags) {
      for (const rule of rules.get(flag) ?? []) {
        if (!rule.condition.test(stem)) continue;
        if (rule.prefix) {
          if (stem.startsWith(rule.strip)) forms.push(rule.add + stem.slice(rule.strip.length));
        } else if (stem.endsWith(rule.strip)) {
          forms.push(stem.slice(0, stem.length - rule.strip.length) + rule.add);
        }
      }
    }
    for (const form of forms) {
      const split = words(form);
      if (split.length === 1) set.add(split[0]!);
    }
  }
  writePack('nl-opentaal', set);
}

// cldr-names: unit names and patterns, country and macro-region names.
{
  const set = new Set<string>();
  for (const locale of LOCALES) {
    const territories = (JSON.parse(readFileSync(join(namesDir, 'main', locale, 'territories.json'), 'utf8')) as {
      main: Record<string, { localeDisplayNames: { territories: Record<string, string> } }>;
    }).main[locale]!.localeDisplayNames.territories;
    for (const [code, name] of Object.entries(territories)) {
      if (/^(?:[A-Z]{2}|\d{3})(?:-alt-[a-z]+)?$/u.test(code)) for (const part of words(name)) set.add(part);
    }
    const units = (JSON.parse(readFileSync(join(unitsDir, 'main', locale, 'units.json'), 'utf8')) as {
      main: Record<string, { units: Record<string, unknown> }>;
    }).main[locale]!.units;
    const visit = (value: unknown): void => {
      if (typeof value === 'string') for (const part of words(value.replace(/\{\d\}/gu, ' '))) set.add(part);
      else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
    };
    visit(units);
  }
  writePack('cldr-names', set);
}
