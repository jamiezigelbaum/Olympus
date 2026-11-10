// Rescore a saved judge-run.ts result (calibration rounds 1 and 2) against the CURRENT labels and importance.
// Counts only: prints no ids, names or text.
//   bun eval/calibration/rescore-saved.ts DIR RESULT.json [--saved-owner] [--exclude-file FILE]
// DIR is the calibration directory the result was run on (labels.json, optional importance.json);
// RESULT.json is a judge-run.ts result saved there. Prints confusion, agreement and important/minor
// misses for all items and per split, so an old run can be scored on corrected labels.
// --saved-owner scores with the owner tier saved in each row (reproduces the run's own numbers);
// by default the owner tier comes from DIR/labels.json now (Secret counts as Private; Not sure, Skip and unlabelled are left out).
import { existsSync, readFileSync } from 'node:fs';
import { confusion, type Tier } from './judge-metrics.ts';

const [dir, file] = process.argv.slice(2);
if (!dir || !file) throw new Error('usage: rescore-saved.ts DIR RESULT.json [--saved-owner] [--exclude-file FILE]');
const flag = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const savedOwner = process.argv.includes('--saved-owner');
const excludeFile = flag('--exclude-file');
const excluded = new Set(excludeFile ? readFileSync(excludeFile, 'utf8').split(/[\s,]+/).filter(Boolean) : []);

const labels = JSON.parse(readFileSync(`${dir}/labels.json`, 'utf8')).labels as Record<string, { label: string; importance?: string }>;
const importance = existsSync(`${dir}/importance.json`)
  ? JSON.parse(readFileSync(`${dir}/importance.json`, 'utf8')).labels as Record<string, { label: string }> : {};
// The whole-item round keeps importance in labels.json; earlier rounds keep it in importance.json.
const tagOf = (id: string) => importance[id]?.label ?? labels[id]?.importance ?? 'untagged';
const result = JSON.parse(readFileSync(file, 'utf8'));
const tierOf = (label?: string) => label === 'personal' ? 'personal' : label === 'private' || label === 'secret' ? 'private' : undefined;

const rows = (result.rows as Array<{ id: string; owner: string; judge: string; split: 'dev' | 'test' }>)
  .filter((row) => !excluded.has(row.id))
  .map((row) => ({ ...row, owner: savedOwner ? row.owner : tierOf(labels[row.id]?.label) }))
  .filter((row): row is typeof row & { owner: Tier } => row.owner === 'personal' || row.owner === 'private')
  // Anything but a Personal answer counts as held Private, as before.
  .map((row) => ({ ...row, source: '', judge: (row.judge === 'personal' ? 'personal' : 'private') as Tier }));

const score = (subset: typeof rows) => {
  // The shared metrics: a class absent from the subset has no recall (null), not zero.
  const c = confusion(subset);
  const own = subset.filter((row) => row.owner === 'private');
  const missed = (tag: string) => own.filter((row) => tagOf(row.id) === tag && row.judge === 'personal').length;
  const of = (tag: string) => own.filter((row) => tagOf(row.id) === tag).length;
  return { ...c, agreement: c.items ? +((c.privateKeptPrivate + c.personalKeptPersonal) / c.items * 100).toFixed(1) : null,
    balancedAccuracy: c.balancedAccuracy === null ? null : +c.balancedAccuracy.toFixed(4),
    importantMissed: `${missed('important')}/${of('important')}`, minorMissed: `${missed('minor')}/${of('minor')}`,
    untaggedMissed: `${own.filter((r) => !['important', 'minor'].includes(tagOf(r.id)) && r.judge === 'personal').length}/${own.filter((r) => !['important', 'minor'].includes(tagOf(r.id))).length}` };
};
console.log(JSON.stringify({ model: result.model, at: result.at, owner: savedOwner ? 'saved' : 'current labels',
  all: score(rows), dev: score(rows.filter((r) => r.split === 'dev')), test: score(rows.filter((r) => r.split === 'test')) }, null, 1));
