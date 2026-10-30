// OLYMPUS_TEST_LANE: deploy
// The subscription command-line agents: how their output becomes calls and tokens, and what they are given.

import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexConfigToml, codexLoginAvailable, looksLikeClaudeSetupToken, parseClaudeResult, parseCodexEvents, runCodex } from '../scripts/release-check/cli-agents.ts';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rc-cli-test-'));
  scratch.push(dir);
  return dir;
}

describe('Claude Code', () => {
  test('only a Claude Code setup token is accepted', () => {
    expect(looksLikeClaudeSetupToken(`sk-ant-oat01-${'a'.repeat(40)}`)).toBe(true);
    expect(looksLikeClaudeSetupToken(`sk-ant-api03-${'a'.repeat(40)}`)).toBe(false);
    expect(looksLikeClaudeSetupToken('sk-ant-oat01-short')).toBe(false);
    expect(looksLikeClaudeSetupToken('')).toBe(false);
  });

  test('reads the reply, turns and tokens from the JSON result', () => {
    const run = parseClaudeResult(`${JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'It is on 24 October [E1].',
      usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 42 },
    })}\n`);
    expect(run).toEqual({ finalText: 'It is on 24 October [E1].', usage: { invocations: 1, modelCalls: 3, inputTokens: 510, outputTokens: 42 }, toolCalls: 0 });
  });

  test('an error result and unparseable output are reported without detail from the provider', () => {
    expect(parseClaudeResult(JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'x', num_turns: 1 })).error).toBe('Claude Code reported an error (error_during_execution)');
    expect(parseClaudeResult('not json').error).toBe('Claude Code printed no result');
  });
});

describe('Codex', () => {
  const events = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'olympus', tool: 'olympus_search' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'It is on 24 October [E1].' } },
    { type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 80 } },
  ].map((event) => JSON.stringify(event)).join('\n');

  test('counts tool calls, model requests and tokens from the event stream', () => {
    const run = parseCodexEvents(`warning: not json\n${events}\n`);
    expect(run.finalText).toBe('It is on 24 October [E1].');
    expect(run.toolCalls).toBe(1);
    expect(run.usage).toEqual({ invocations: 1, modelCalls: 2, inputTokens: 1200, outputTokens: 80 });
    expect(run.error).toBeUndefined();
  });

  test('a stream with no completed turn, or a failed turn, is an error', () => {
    expect(parseCodexEvents('').error).toBe('Codex printed no completed turn');
    expect(parseCodexEvents(JSON.stringify({ type: 'turn.failed' })).error).toBe('Codex reported an error');
  });

  test('the run configuration offers only the Olympus endpoint and no shell, web or other tool', () => {
    const toml = codexConfigToml('http://127.0.0.1:5555/mcp/abc');
    expect(toml).toContain('[mcp_servers.olympus]');
    expect(toml).toContain('url = "http://127.0.0.1:5555/mcp/abc"');
    expect(toml).toContain('web_search = "disabled"');
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('shell_tool = false');
    expect(toml.match(/\[mcp_servers\./g)).toHaveLength(1);
  });

  test('a ChatGPT login is recognized from the file shape, without reading token values out', () => {
    const home = tempDir();
    expect(codexLoginAvailable(home)).toBe(false);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'x' }));
    expect(codexLoginAvailable(home)).toBe(false);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'a' } }));
    expect(codexLoginAvailable(home)).toBe(true);
    writeFileSync(join(home, 'auth.json'), '{broken');
    expect(codexLoginAvailable(home)).toBe(false);
  });
  test('serializes concurrent refreshes and recovers an abandoned lock file', async () => {
    const root = tempDir();
    const home = join(root, 'codex-home');
    const bin = join(root, 'bin');
    mkdirSync(home); mkdirSync(bin);
    writeFileSync(join(home, 'auth.json'), '0');
    // Kill a real lock holder, leaving its file behind for the next call.
    const holder = spawn('python3', ['-c', 'import fcntl,sys,time; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(30)', join(home, '.release-check-codex.lock')]);
    await new Promise<void>((resolve, reject) => { holder.stdout.once('data', () => resolve()); holder.once('error', reject); });
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.once('close', () => resolve()));
    const fake = join(bin, 'codex');
    writeFileSync(fake, `#!/usr/bin/env python3
import os, time
p = os.path.join(os.environ['CODEX_HOME'], 'auth.json')
with open(p) as f: n = int(f.read())
time.sleep(0.15)
with open(p, 'w') as f: f.write(str(n + 1))
print('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}')
`);
    chmodSync(fake, 0o755);
    const oldHome = process.env.CODEX_HOME;
    const oldPath = process.env.PATH;
    process.env.CODEX_HOME = home;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const options = { question: 'test', mcpUrl: 'http://localhost', timeoutMs: 5000 };
      const runs = await Promise.all([runCodex(options), runCodex(options)]);
      expect(runs.map(run => run.error)).toEqual([undefined, undefined]);
      expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('2');
      const single = await runCodex(options);
      expect(single.error).toBeUndefined();
      expect(single.usage.inputTokens).toBe(1);
      expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('3');
    } finally {
      if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  });

});
