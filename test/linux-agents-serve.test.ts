// Runs in the Linux remote-build container, without OpenClaw or host credentials.
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

for (const name of ['claude-code','codex']) {
  test.skipIf(process.platform !== 'linux')(`Linux ${name} resolves the standalone home launcher and serves MCP`, async () => {
    expect(process.platform).toBe('linux');
    const home = mkdtempSync(join(tmpdir(),'olympus-home with spaces-'));
    const command = join(home,'.local/bin/olympus');
    mkdirSync(join(home,'.local/bin'),{recursive:true});
    // Model the standalone installer's managed launcher; do not substitute
    // the source-checkout launcher, which requires ambient Bun on PATH.
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    writeFileSync(command,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('dist/cli.js'))} "$@"\n`,{mode:0o700});
    const transport = new StdioClientTransport({command,args:['serve'],env:{HOME:home,PATH:'/usr/bin:/bin',OLYMPUS_STATE_ROOT:join(home,'.olympus')},stderr:'pipe'});
    const client = new Client({name,version:'1.0.0'});
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toContain('source_answer');
      expect(tools.tools.map(tool => tool.name)).toContain('source_answer_result');
    } finally {
      await client.close();
      rmSync(home,{recursive:true,force:true});
    }
  },30_000);
}
