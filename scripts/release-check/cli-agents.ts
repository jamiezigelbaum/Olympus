/**
 * The subscription command-line agents: Claude Code (headless) and Codex
 * (`codex exec`). Each is run with nothing but the Olympus MCP endpoint as a
 * tool, in a scratch home of its own, so the owner's own settings, memory,
 * skills, hooks and other MCP servers never join the run and nothing here
 * writes to the owner's real configuration.
 *
 *   - Claude Code is authenticated with a Claude Code setup token the run
 *     supplies through its environment (never a command-line argument, never
 *     logged). The scratch config directory means no stored login is read.
 *   - Codex signs in with the ChatGPT login already on the machine that runs
 *     the suite (`auth.json` in the Codex home). That file is copied into the
 *     scratch home for the run; if Codex refreshed the tokens during the run,
 *     the refreshed file is written back only when the original is still the
 *     file that was copied, because a refresh can retire the old refresh token.
 *     A host without a ChatGPT login needs a one-time `codex login` there.
 *
 * Both are billed to a subscription, so the suite keeps its question list
 * short and every run reports how many calls each agent made.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_INSTRUCTIONS } from './agents.ts';

export interface CliUsage {
  invocations: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CliRun {
  finalText: string;
  usage: CliUsage;
  /** How many tool calls the agent says it made (the proxy's own record is the authority). */
  toolCalls: number;
  error?: string;
}

interface Spawned { code: number; stdout: string; stderr: string; timedOut: boolean }

function runProcess(command: string, args: readonly string[], options: { env: Record<string, string>; cwd: string; timeoutMs: number }): Promise<Spawned> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // stdin is closed, not inherited: both CLIs wait on it when it is open.
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: `${stderr}${error.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut }); });
  });
}

function baseEnv(home: string): Record<string, string> {
  // A minimal environment: no inherited API keys, tokens or proxy settings.
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: 'en_US.UTF-8' };
}

// ---------------------------------------------------------------------------
// Claude Code

/** A Claude Code setup token has this shape; an API key or anything else is refused before it is used. */
export function looksLikeClaudeSetupToken(token: string): boolean {
  return /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(token);
}

export function parseClaudeResult(stdout: string): CliRun {
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '') as Record<string, any>;
  } catch {
    return { finalText: '', usage: { invocations: 1, modelCalls: 0, inputTokens: 0, outputTokens: 0 }, toolCalls: 0, error: 'Claude Code printed no result' };
  }
  const usage = (parsed.usage ?? {}) as Record<string, number>;
  return {
    finalText: typeof parsed.result === 'string' ? parsed.result : '',
    usage: {
      invocations: 1,
      modelCalls: Number(parsed.num_turns ?? 0),
      inputTokens: Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
    },
    toolCalls: 0,
    ...(parsed.is_error === true ? { error: `Claude Code reported an error (${String(parsed.subtype ?? 'unknown')})` } : {}),
  };
}

export async function runClaudeCode(options: { token: string; question: string; mcpUrl: string; model?: string; timeoutMs?: number }): Promise<CliRun> {
  const scratch = mkdtempSync(join(tmpdir(), 'release-check-claude-'));
  try {
    const home = join(scratch, 'home');
    const work = join(scratch, 'work');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(work, { recursive: true });
    const mcpFile = join(scratch, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { olympus: { type: 'http', url: options.mcpUrl } } }));
    const args = [
      '-p', options.question,
      '--mcp-config', mcpFile,
      '--strict-mcp-config',
      '--tools', '',
      '--allowedTools', 'mcp__olympus__olympus_search',
      '--permission-mode', 'dontAsk',
      '--output-format', 'json',
      '--no-session-persistence',
      '--append-system-prompt', AGENT_INSTRUCTIONS,
      ...(options.model ? ['--model', options.model] : []),
    ];
    const env = { ...baseEnv(home), CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_OAUTH_TOKEN: options.token };
    const out = await runProcess('claude', args, { env, cwd: work, timeoutMs: options.timeoutMs ?? 240_000 });
    if (out.timedOut) return { finalText: '', usage: { invocations: 1, modelCalls: 0, inputTokens: 0, outputTokens: 0 }, toolCalls: 0, error: 'Claude Code timed out' };
    const run = parseClaudeResult(out.stdout);
    // Claude Code's own error text can include request details; keep it out of the report.
    if (out.code !== 0 && !run.error) run.error = `Claude Code exited ${out.code}`;
    return run;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Codex

export function codexHomePath(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/** Whether the host has a ChatGPT login Codex can use (file only; the token values are never read out). */
export function codexLoginAvailable(home = codexHomePath()): boolean {
  const path = join(home, 'auth.json');
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { auth_mode?: string; tokens?: unknown };
    return parsed.auth_mode === 'chatgpt' && typeof parsed.tokens === 'object' && parsed.tokens !== null;
  } catch {
    return false;
  }
}

export function codexConfigToml(mcpUrl: string): string {
  return [
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    // The scratch home has no OS keychain; without this Codex aborts the server's startup on the failed keychain read.
    'mcp_oauth_credentials_store = "file"',
    '',
    '[features]',
    'shell_tool = false',
    'unified_exec = false',
    'apps = false',
    'browser_use = false',
    'browser_use_external = false',
    'computer_use = false',
    'in_app_browser = false',
    'multi_agent = false',
    'memories = false',
    'plugins = false',
    'skill_search = false',
    'hooks = false',
    '',
    '[mcp_servers.olympus]',
    `url = ${JSON.stringify(mcpUrl)}`,
    '',
  ].join('\n');
}

export function parseCodexEvents(stdout: string): CliRun {
  let finalText = '';
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawTurn = false;
  let error: string | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: Record<string, any>;
    try { event = JSON.parse(line) as Record<string, any>; } catch { continue; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') finalText = event.item.text;
    if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') toolCalls += 1;
    if (event.type === 'turn.completed') {
      sawTurn = true;
      inputTokens += Number(event.usage?.input_tokens ?? 0);
      outputTokens += Number(event.usage?.output_tokens ?? 0);
    }
    if (event.type === 'turn.failed' || event.type === 'error') error = 'Codex reported an error';
  }
  return {
    finalText,
    // Each tool result needs one more model request, so requests are the tool calls plus the first.
    usage: { invocations: 1, modelCalls: sawTurn ? toolCalls + 1 : 0, inputTokens, outputTokens },
    toolCalls,
    ...(error ? { error } : sawTurn ? {} : { error: 'Codex printed no completed turn' }),
  };
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function runCodex(options: { question: string; mcpUrl: string; model?: string; timeoutMs?: number }): Promise<CliRun> {
  const realAuth = join(codexHomePath(), 'auth.json');
  const scratch = mkdtempSync(join(tmpdir(), 'release-check-codex-'));
  try {
    const home = join(scratch, 'home');
    const codexHome = join(scratch, 'codex');
    const work = join(scratch, 'work');
    for (const dir of [home, codexHome, work]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), codexConfigToml(options.mcpUrl), { mode: 0o600 });
    const scopedAuth = join(codexHome, 'auth.json');
    copyFileSync(realAuth, scopedAuth);
    chmodSync(scopedAuth, 0o600);
    const copiedDigest = sha(scopedAuth);
    const args = [
      'exec', '--skip-git-repo-check', '--ephemeral', '--json', '-C', work,
      ...(options.model ? ['-m', options.model] : []),
      `${options.question}\n\n${AGENT_INSTRUCTIONS}`,
    ];
    const env = { ...baseEnv(home), CODEX_HOME: codexHome };
    const out = await runProcess('codex', args, { env, cwd: work, timeoutMs: options.timeoutMs ?? 240_000 });
    // A refresh can retire the old refresh token, so a refreshed login is handed back, never lost.
    try {
      if (sha(scopedAuth) !== copiedDigest && existsSync(realAuth) && sha(realAuth) === copiedDigest) {
        const staged = `${realAuth}.release-check-${process.pid}`;
        copyFileSync(scopedAuth, staged);
        chmodSync(staged, 0o600);
        renameSync(staged, realAuth);
      }
    } catch { /* leave the real login as it was */ }
    if (out.timedOut) return { finalText: '', usage: { invocations: 1, modelCalls: 0, inputTokens: 0, outputTokens: 0 }, toolCalls: 0, error: 'Codex timed out' };
    const run = parseCodexEvents(out.stdout);
    if (out.code !== 0 && !run.error) run.error = `Codex exited ${out.code}`;
    return run;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
