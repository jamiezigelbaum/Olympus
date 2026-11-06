import { spawn } from 'node:child_process';
import type { PairingCommandRequest, PairingCommandResult } from '../../core/messaging-pairing.ts';
import type { PairingField, PairingHooks } from './dashboard-messaging.ts';

const FIELDS = new Set(['api_id', 'api_hash', 'phone', 'code', 'password']);

/** Run the packaged helper with an in-memory prompt pipe; stdout contains no answers. */
export async function runDashboardPairingCommand(request: PairingCommandRequest, hooks: PairingHooks): Promise<PairingCommandResult> {
  const child = spawn(request.executable, request.args, {
    env: { ...request.env, OLYMPUS_TELEGRAM_LIST_CHATS: '', OLYMPUS_TELEGRAM_DASHBOARD_PROMPTS: '1' },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', ...(request.inheritFds ?? [])],
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdin || !stdout || !stderr || !child.stdio[3]) throw new Error('Pairing pipes unavailable.');
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    child.kill('SIGTERM');
    escalation ??= setTimeout(() => child.kill('SIGKILL'), 5_000);
  };
  const timer = setTimeout(cancel, 10 * 60_000);
  if (hooks.signal.aborted) cancel();
  else hooks.signal.addEventListener('abort', cancel, { once: true });
  const lines: string[] = [];
  stdin.on('error', () => { /* The helper may exit while a reply is in flight. */ });
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  const readLines = async () => {
    let buffer = '';
    for await (const chunk of stdout) {
      buffer += Buffer.from(chunk).toString('utf8');
      if (buffer.length > 4 * 1024 * 1024) throw new Error('Pairing output exceeded its bound.');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let event: { event?: unknown; field?: unknown } = {};
        try { event = JSON.parse(line) as typeof event; } catch { /* helper output is not a prompt */ }
        if (event.event === 'prompt') {
          if (typeof event.field !== 'string' || !FIELDS.has(event.field)) throw new Error('Invalid pairing prompt.');
          const field = event.field as PairingField;
          hooks.prompt(field, (value) => {
            stdin.write(`${JSON.stringify({ field, value })}\n`);
          });
        } else {
          lines.push(line);
          await request.onStdoutLine?.(line);
        }
      }
    }
    if (buffer.trim()) throw new Error('Incomplete pairing output.');
  };
  const readBounded = async (stream: NodeJS.ReadableStream, limit: number) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new Error('Pairing output exceeded its bound.');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  };
  try {
    const [exitCode, stderrText, privatePayload] = await Promise.all([
      exit, readBounded(stderr, 16 * 1024), readBounded(child.stdio[3] as NodeJS.ReadableStream, 4096), readLines(),
    ]);
    return { exitCode, stdoutLines: lines, stderr: stderrText, ...(privatePayload ? { privatePayload } : {}) };
  } catch (error) {
    cancel();
    await exit.catch(() => 1);
    throw error;
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    hooks.signal.removeEventListener('abort', cancel);
    stdin.destroy();
  }
}
