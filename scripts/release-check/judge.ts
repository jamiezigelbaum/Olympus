/**
 * Answer-quality judge. The exact checks (an expected fact is stated, a marker
 * is absent) stay in code and decide pass or fail on their own; the judge adds
 * one advisory line on whether the answer as a whole matches what a correct
 * answer says. It may raise a warning, never lower a bar, and when it is
 * unavailable the check is skipped rather than guessed.
 *
 * The judge is any command that follows the `verify` contract of the owner's
 * decision-gate tool: `--criteria <file> --evidence <file>`; exit 0 means no
 * flags, 2 means flags raised, anything else means unavailable. The command
 * comes from the run's private configuration; this file names no tool.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { CheckResult } from './report.ts';

export type JudgeVerdict = 'clear' | 'flagged' | 'unavailable';

/** The verdict, and what the judge printed with it (its reasons), so a flag can be read without running it again. */
export interface JudgeResult {
  verdict: JudgeVerdict;
  said?: string;
}

export interface Judge {
  judge(input: { criteria: string; evidence: string }): Promise<JudgeResult>;
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A judge backed by a verify-style command. */
export function commandJudge(argv: readonly string[], timeoutMs = 60_000): Judge {
  return {
    async judge({ criteria, evidence }) {
      const dir = mkdtempSync(join(tmpdir(), 'release-check-judge-'));
      try {
        const criteriaFile = join(dir, 'criteria.md');
        const evidenceFile = join(dir, 'evidence.md');
        writeFileSync(criteriaFile, `- ${criteria}\n`);
        writeFileSync(evidenceFile, `${evidence}\n`);
        let said = '';
        const code = await new Promise<number>((resolve) => {
          const child = spawn(argv[0]!, [...argv.slice(1), '--criteria', criteriaFile, '--evidence', evidenceFile], { stdio: ['ignore', 'pipe', 'ignore'] });
          child.stdout.on('data', (chunk: Buffer) => { if (said.length < 4_000) said += chunk.toString('utf8'); });
          const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
          child.on('error', () => { clearTimeout(timer); resolve(1); });
          child.on('close', (status) => { clearTimeout(timer); resolve(status ?? 1); });
        });
        const verdict: JudgeVerdict = code === 0 ? 'clear' : code === 2 ? 'flagged' : 'unavailable';
        return said.trim() ? { verdict, said: clip(said, 600) } : { verdict };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * One check from a verdict. A flag says what the judge said, what a correct answer says and what the agent answered, so the warning
 * can be read where it is shown (2026-10-25: a flag that said only "read it against the expectation" had neither to read).
 */
export function judgeCheck(id: string, title: string, result: JudgeResult, read: { expectation: string; answer: string }): CheckResult {
  if (result.verdict === 'clear') return { id, title, status: 'pass', detail: 'The judge raised no flags.' };
  if (result.verdict === 'flagged') {
    const said = result.said ? ` The judge said: ${result.said}` : ' The judge gave no reason.';
    return { id, title, status: 'warn', detail: `The judge flagged this answer.${said} Expected: ${clip(read.expectation, 400)} Answer: "${clip(read.answer, 800)}"` };
  }
  return { id, title, status: 'skip', detail: 'The judge was unavailable.' };
}
