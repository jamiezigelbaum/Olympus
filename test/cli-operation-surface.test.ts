import { describe, expect, test } from 'bun:test';
import { parseArgs, resolveCliOperation } from '../src/cli.ts';
import { operations } from '../src/core/operations.ts';

describe('CLI operation surface', () => {
  test('every declared CLI name resolves back to its own operation', () => {
    const unreachable = operations
      .filter((operation) => {
        const resolved = resolveCliOperation(operation.cliHints.name.split(' '));
        return resolved.operation?.name !== operation.name || resolved.rest.length !== 0;
      })
      .map((operation) => operation.cliHints.name);
    expect(unreachable).toEqual([]);
  });

  test('unexpected bare arguments are refused instead of silently dropped', () => {
    const sourceAnswer = operations.find((operation) => operation.cliHints.name === 'source answer');
    expect(sourceAnswer).toBeDefined();
    expect(() => parseArgs(sourceAnswer!, ['what', 'did', 'we', 'decide'])).toThrow(/Unexpected argument: did/);
    expect(parseArgs(sourceAnswer!, ['what did we decide'])).toEqual({ question: 'what did we decide' });
  });

  test('public per-operation help renders without leaking placeholders', async () => {
    const help = await runSourceCli(['source', 'answer', '--help']);
    expect(help.stdout).not.toContain('{{');
    expect(help.stdout).toContain('Usage: olympus source answer');
  }, 30_000);
});

async function runSourceCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`bin/olympus ${args.join(' ')} failed: ${stderr || stdout}`);
  }
  return { stdout, stderr };
}
