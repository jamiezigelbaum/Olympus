import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { V0_4_HERMES_MCP_TOOLS, V0_4_PUBLIC_PACKAGE_FILES } from '../src/core/public-surface.ts';
import { listMcpTools } from '../src/mcp/tools.ts';

const ROOT = join(import.meta.dir, '..');

describe('Hermes v0.4 integration', () => {
  test('documents and packages the exact two-tool MCP filter', () => {
    const configPath = 'config/hermes/olympus.mcp.yaml';
    const skillPath = 'integrations/hermes/ask-sources/SKILL.md';
    expect(V0_4_PUBLIC_PACKAGE_FILES).toContain(configPath);
    expect(V0_4_PUBLIC_PACKAGE_FILES).toContain(skillPath);
    const config = readFileSync(join(ROOT, configPath), 'utf8');
    expect(config).toContain('command: <absolute-managed-plugin-root>/bin/olympus');
    expect(config).toContain('args: [serve]');
    expect(config).toContain(`include: [${V0_4_HERMES_MCP_TOOLS.join(', ')}]`);
    expect(config).toContain('prompts: false');
    expect(config).toContain('resources: false');
    const skill = readFileSync(join(ROOT, skillPath), 'utf8');
    const declaredTools = skill.match(/^  - ([a-z_]+)$/gm)?.map((line) => line.slice(4)) ?? [];
    expect(declaredTools).toEqual([...V0_4_HERMES_MCP_TOOLS]);
    expect(skill).not.toContain('source_index_search');
    expect(skill).not.toContain('source_watch_');
  });

  test('the live MCP registry contains both filtered names and docs use current Hermes commands', () => {
    const registered = new Set(listMcpTools(defaultConfig()).map((tool) => tool.name));
    expect(V0_4_HERMES_MCP_TOOLS.every((tool) => registered.has(tool))).toBe(true);
    const docs = [
      readFileSync(join(ROOT, 'README.md'), 'utf8'),
      readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8'),
      readFileSync(join(ROOT, 'docs/V0_4_RELEASE.md'), 'utf8'),
    ].join('\n');
    expect(docs).toContain('openclaw plugins inspect olympus --json');
    expect(docs).toContain('hermes mcp add olympus --command /absolute/managed/olympus/bin/olympus --args serve');
    expect(docs).toContain('hermes mcp test olympus');
    expect(docs).toContain('include: [source_answer, source_index_status]');
    expect(docs).toContain('mcp_olympus_source_answer');
    expect(docs).not.toContain('mcp__olympus__');
    expect(docs).toContain('No `hermes://mcp/install` link is published');
  });
});
