// The ChatGPT plugin package at chatgpt-plugin/: manifest and MCP config parse
// and stay inside the Agent Plugins 1.0.0 schemas and OpenAI's submission
// limits for the fields used.
//
// Schemas: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json and
// mcp.schema.json. Limits: https://developers.openai.com/plugins/deploy/submission.

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'chatgpt-plugin');
const repo = join(import.meta.dir, '..');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

const PLUGIN_KEYS = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
const INTERFACE_KEYS = [
  'displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities',
  'websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL', 'defaultPrompt',
  'brandColor', 'brandColorDark', 'composerIcon', 'composerIconDark', 'logo', 'logoDark', 'screenshots',
];
const CATEGORIES = [
  'Productivity', 'Creativity', 'Developer Tools', 'Business & Operations', 'Data & Analytics', 'Communication',
  'Education & Research', 'Security', 'Finance', 'Healthcare', 'Travel', 'Entertainment', 'Other',
];

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('chatgpt-plugin/plugin.json', () => {
  const plugin = readJson(join(root, 'plugin.json'));

  test('matches the Agent Plugins 1.0.0 manifest schema', () => {
    expect(plugin.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(plugin.name).toBe('olympus');
    expect(plugin.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    expect(Object.keys(plugin).filter((key) => !PLUGIN_KEYS.includes(key))).toEqual([]);
    expect(Object.keys(plugin.author).filter((key) => !['name', 'email', 'url'].includes(key))).toEqual([]);
    for (const value of Object.values(plugin.extensions)) expect(typeof value).toBe('object');
  });

  test('carries the package version, author and license', () => {
    expect(plugin.version).toBe(readJson(join(repo, 'package.json')).version);
    expect(plugin.author.name).toBe('Jamie Zigelbaum');
    expect(plugin.homepage).toBe('https://olympusplugin.ai');
    expect(plugin.license).toBe('MIT');
    expect(readFileSync(join(repo, 'LICENSE'), 'utf8').startsWith('MIT License')).toBe(true);
    expect(plugin.description.length).toBeLessThanOrEqual(4000);
  });

  test('extensions.com.openai.interface stays inside the submission limits', () => {
    const openai = plugin.extensions['com.openai'];
    // Submission rejects app references and lifecycle hooks.
    expect(openai.apps).toBeUndefined();
    expect(openai.hooks).toBeUndefined();
    const ui = openai.interface;
    expect(Object.keys(ui).filter((key) => !INTERFACE_KEYS.includes(key))).toEqual([]);
    expect(ui.displayName).toBe('Olympus');
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
    expect(ui.developerName.length).toBeLessThanOrEqual(80);
    expect(CATEGORIES).toContain(ui.category);
    expect(ui.capabilities.length).toBeLessThanOrEqual(20);
    for (const capability of ui.capabilities) expect(capability.length).toBeLessThanOrEqual(120);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const prompt of ui.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128);
    for (const key of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
      if (ui[key] !== undefined) expect(ui[key]).toMatch(/^https:\/\//);
    }
    for (const key of ['composerIcon', 'logo']) {
      const path = join(root, ui[key]);
      expect(existsSync(path)).toBe(true);
      const { width, height } = pngSize(path);
      expect(width).toBe(height);
      expect(width).toBeGreaterThanOrEqual(48);
      expect(readFileSync(path).length).toBeLessThanOrEqual(5 * 1024 * 1024);
    }
  });

  test('ships no app references or hooks files', () => {
    expect(existsSync(join(root, '.app.json'))).toBe(false);
    expect(existsSync(join(root, 'hooks'))).toBe(false);
  });
});

describe('chatgpt-plugin/mcp.json', () => {
  test('one streamable-http server at the fixed relay host', () => {
    const mcp = readJson(join(root, 'mcp.json'));
    expect(mcp.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    const servers = Object.entries(mcp.mcpServers as Record<string, Record<string, unknown>>);
    expect(servers).toHaveLength(1);
    expect(servers[0]![1]).toEqual({ type: 'streamable-http', url: 'https://mcp.olympusplugin.ai/mcp' });
  });
});

describe('chatgpt-plugin/skills', () => {
  test('each skill has SKILL.md with name matching its directory and a description', () => {
    const dirs = readdirSync(join(root, 'skills')).sort();
    expect(dirs).toEqual(['olympus-ask', 'olympus-setup']);
    for (const dir of dirs) {
      const text = readFileSync(join(root, 'skills', dir, 'SKILL.md'), 'utf8');
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
      expect(frontmatter).toContain(`name: ${dir}\n`);
      expect(/^description: .{20,}$/m.test(frontmatter)).toBe(true);
    }
  });
});
