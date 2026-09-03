import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyQualificationArtifact } from './artifact.ts';

const plan = JSON.parse(readFileSync(resolve(required('--plan')), 'utf8')) as {
  candidate_artifact: { artifact_sha256: string; artifact_bytes: number };
  documentary_cells: Array<{ source_id: string; check: string; assertions: string[] }>;
};
const artifact = verifyQualificationArtifact(required('--artifact'), plan.candidate_artifact);
const sourceId = required('--source-id');
const check = required('--check');
const output = resolve(required('--output'));
const cell = plan.documentary_cells.find((candidate) => candidate.source_id === sourceId && candidate.check === check);
if (!cell) throw new Error('Release-input cell is not declared by the exact plan.');

const manifest = {
  kind: 'olympus_release_input_manifest' as const,
  schema_version: 1 as const,
  status: 'prepared' as const,
  source_id: sourceId,
  check,
  artifact_sha256: artifact.sha256,
  artifact_bytes: artifact.bytes,
  required_assertions: cell.assertions,
  completion_owner: 'slice4_independent_review' as const,
};
writeFileSync(output, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ kind: 'olympus_release_input_prepared', schema_version: 1, source_id: sourceId, check, artifact_sha256: artifact.sha256, assertions: cell.assertions.length, qualification_complete: false, completion_owner: manifest.completion_owner, content_free: true }));

function required(name: string): string { const index = process.argv.indexOf(name); const value = index >= 0 ? process.argv[index + 1] : undefined; if (!value) throw new Error(`${name} is required.`); return value; }
