import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ChangeRisk = 'standard' | 'critical';

export interface ChangeRiskConfig {
  schemaVersion: 2;
  criticalExact: string[];
  criticalPrefixes: string[];
  criticalCodeTerms: string[];
}

export interface ChangeRiskResult {
  risk: ChangeRisk;
  files: string[];
  criticalFiles: string[];
}

export function classifyChange(files: readonly string[], config: ChangeRiskConfig): ChangeRiskResult {
  if (config.schemaVersion !== 2) throw new Error('Unsupported change-risk configuration.');
  const normalized = [...new Set(files.map((path) => path.trim()).filter(Boolean))].sort();
  const criticalFiles = normalized.filter((path) => isCriticalPath(path, config));
  return {
    risk: criticalFiles.length > 0 ? 'critical' : 'standard',
    files: normalized,
    criticalFiles,
  };
}

function isCriticalPath(path: string, config: ChangeRiskConfig): boolean {
  if (config.criticalExact.includes(path)) return true;
  if (config.criticalPrefixes.some((prefix) => path.startsWith(prefix))) return true;
  if (!/^(src|scripts|config)\//.test(path)) return false;
  const lower = path.toLowerCase();
  return config.criticalCodeTerms.some((term) => lower.includes(term.toLowerCase()));
}

async function changedFiles(base: string, head: string): Promise<string[]> {
  const process = Bun.spawn(['git', 'diff', '--name-only', '-z', base, head], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git diff failed: ${stderr.trim()}`);
  return stdout.split('\0').filter(Boolean);
}

if (import.meta.main) {
  const root = join(fileURLToPath(new URL('..', import.meta.url)));
  const config = JSON.parse(readFileSync(join(root, 'config/change-risk.json'), 'utf8')) as ChangeRiskConfig;
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA;
  if (!base || !head) throw new Error('BASE_SHA and HEAD_SHA are required.');
  const result = classifyChange(await changedFiles(base, head), config);
  console.log(JSON.stringify(result, null, 2));
}
