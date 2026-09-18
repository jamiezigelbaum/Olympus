import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { V0_4_PUBLIC_SKILL_DIRS } from '../src/core/public-surface.ts';

const ROOT = join(import.meta.dir, '..');

function discoveredRuntimeSkillDirs(): string[] {
  return readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && V0_4_PUBLIC_SKILL_DIRS.includes(`skills/${entry.name}` as (typeof V0_4_PUBLIC_SKILL_DIRS)[number])
      && existsSync(join(ROOT, 'skills', entry.name, 'SKILL.md')))
    .map((entry) => `skills/${entry.name}`)
    .sort();
}

describe('source skill runtime context', () => {
  test('plugin manifest exports every discovered runtime skill', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'skills', 'manifest.json'), 'utf8')) as {
      skills: Array<{ name: string; path: string; description: string }>;
    };
    const plugin = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8')) as {
      skills: string[];
    };

    const manifestSkillDirs = manifest.skills
      .map((entry) => entry.path.replace(/\/SKILL\.md$/, ''))
      .sort();
    const discoveredSkillDirs = discoveredRuntimeSkillDirs();

    expect(discoveredSkillDirs.length).toBeGreaterThan(0);
    expect(manifestSkillDirs).toEqual(discoveredSkillDirs);
    expect([...plugin.skills].sort()).toEqual(discoveredSkillDirs);
  });

  test('ask-sources discovery and resolver carry the no-shell source-tool rule', () => {
    const skill = readFileSync(join(ROOT, 'skills', 'ask-sources', 'SKILL.md'), 'utf8');
    const resolver = readFileSync(join(ROOT, 'skills', 'RESOLVER.md'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(ROOT, 'skills', 'manifest.json'), 'utf8')) as {
      skills: Array<{ name: string; path: string; description: string }>;
    };
    const askSources = manifest.skills.find((entry) => entry.name === 'ask-sources');

    expect(askSources).toBeDefined();
    expect(askSources?.path).toBe('skills/ask-sources/SKILL.md');
    expect(askSources?.description).toContain('source_answer');
    expect(askSources?.description).toContain('source_index_search');
    expect(askSources?.description).toContain('Never use bash');
    expect(askSources?.description).toContain('skill-file inspection');
    expect(askSources?.description).toContain('omit corpus_id unless intentionally force-narrowing');
    // skills/ask-email-local was deleted with the pre-v0.4 email tools on
    // 2026-09-18; the only email route left is source_answer over ask-sources.
    expect(manifest.skills.map((entry) => entry.name)).not.toContain('ask-email-local');
    expect(skill).toContain('tools:\n  - source_answer\n  - source_index_search');
    expect(skill).toContain('preserve the citation markers returned');
    expect(skill).toContain('concrete query built from those titles');
    expect(skill).toContain('Do not fan out into unbounded');
    expect(skill).toContain('Omit `corpus_id` on that first private ask');
    expect(skill).toContain('Do not infer Dropbox from legal, financial, medical, tax');
    expect(skill).toContain('For email, Gmail, Google Mail');
    expect(skill).toContain('Do not use `bash`, shell commands, local files, raw databases');
    expect(resolver).toContain('do not read skill files with bash');
    expect(resolver).toContain('do not inspect `skills/ask-sources/SKILL.md`');
    expect(skill).toContain('web search, or web browsing');
    expect(skill).toContain('legacy `sourceItem`');
    expect(skill).toContain('tools are unavailable, fail clearly');
    expect(resolver).toContain('| User asks to search Telegram, X/Twitter bookmarks, saved/bookmarked tweets/posts, Readwise, Drive/Docs, Dropbox, or another Olympus-indexed source | `skills/ask-sources/SKILL.md` |');
    expect(resolver).toContain('| User asks to search, summarize, inspect, or answer questions about Gmail/email | `skills/ask-sources/SKILL.md` |');
    expect(resolver).toContain('use one `source_answer` call with');
    expect(resolver).toContain('Do not route legal, financial');
    expect(resolver).toContain('do not fall back to raw shell');
  });

  test('the canonical OpenClaw change protocol stays the live-system contract', () => {
    // skills/update-openclaw-runtime was deleted on 2026-09-18: updating a live
    // OpenClaw deployment is the deployment owner's procedure, not a skill this
    // repository ships. AGENTS.md and docs/ops/OPENCLAW_CHANGE_PROTOCOL.md are
    // what still have to carry the contract for anyone working in this tree.
    const resolver = readFileSync(join(ROOT, 'skills', 'RESOLVER.md'), 'utf8');
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    const canonical = readFileSync(join(ROOT, 'docs', 'ops', 'OPENCLAW_CHANGE_PROTOCOL.md'), 'utf8');

    for (const text of [
      'openclaw docs <query>',
      'config.schema.lookup',
      'openclaw config validate && openclaw doctor --lint --severity-min error --non-interactive',
      'openclaw secrets audit --check --allow-exec',
      '`openclaw gateway restart`',
      '`openclaw update`',
      'openclaw plugins inspect <name>',
      '[gateway] http server listening (N plugins…)',
      'openclaw gateway stability --bundle latest',
      'config set` `.bak.*` rotation',
    ]) {
      expect(agents).toContain(text);
    }
    expect(canonical).toContain('native OpenClaw processes only');
    expect(canonical).toContain('openclaw-ops');
    expect(canonical).not.toContain('openclaw-safe-restart');
    expect(existsSync(join(ROOT, 'skills', 'update-openclaw-runtime'))).toBe(false);

    // Retired 2026-09-17 by the owner: custom gates must not creep back into the digests.
    for (const retiredGuidance of [
      'restart ONLY via',
      'Restart ONLY via',
      'install-approvals',
      '--no-restart',
      'openclaw update repair --yes',
      'openclaw-safe-restart',
      'OPENCLAW_PROTOCOL_NORMATIVE_SHA256',
    ]) {
      expect(resolver).not.toContain(retiredGuidance);
      expect(agents).not.toContain(retiredGuidance);
    }
  });
});
