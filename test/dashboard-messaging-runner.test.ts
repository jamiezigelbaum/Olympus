import { expect, test } from 'bun:test';
import { runDashboardPairingCommand } from '../src/workers/email-source/dashboard-messaging-runner.ts';

test('pairing runner sends replies only on the private input pipe', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const script = `import json,os,sys\nprint(json.dumps({'event':'prompt','field':'code'}),flush=True)\nreply=json.loads(sys.stdin.readline())\nassert reply == {'field':'code','value':'temporary-code'}\nos.write(3,b'{"api_id":123,"api_hash":"fixture"}\\n')\nprint(json.dumps({'event':'ready'}),flush=True)\n`;
  const result = await runDashboardPairingCommand({ executable: 'python3', args: ['-u', '-c', script], env: process.env, onStdoutLine: (line) => { events.push(line); } }, {
    signal: controller.signal,
    prompt: (field, reply) => { expect(field).toBe('code'); reply('temporary-code'); },
    qr: () => {},
    commit: () => {},
    choose: async () => { throw new Error('Runner does not choose scope'); },
  });
  expect(result.exitCode).toBe(0);
  expect(events).toEqual(['{"event": "ready"}']);
  expect(JSON.stringify({ lines: result.stdoutLines, stderr: result.stderr })).not.toContain('temporary-code');
  expect(result.privatePayload).toContain('api_id');
});
