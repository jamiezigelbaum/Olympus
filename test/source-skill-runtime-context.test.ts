import { createHash } from 'node:crypto';
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
    expect(plugin.skills).not.toContain('skills/update-openclaw-runtime');
  });

  test('ask-sources discovery and resolver carry the no-shell source-tool rule', () => {
    const skill = readFileSync(join(ROOT, 'skills', 'ask-sources', 'SKILL.md'), 'utf8');
    const emailSkill = readFileSync(join(ROOT, 'skills', 'ask-email-local', 'SKILL.md'), 'utf8');
    const resolver = readFileSync(join(ROOT, 'skills', 'RESOLVER.md'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(ROOT, 'skills', 'manifest.json'), 'utf8')) as {
      skills: Array<{ name: string; path: string; description: string }>;
    };
    const askSources = manifest.skills.find((entry) => entry.name === 'ask-sources');
    const askEmailLocal = manifest.skills.find((entry) => entry.name === 'ask-email-local');

    expect(askSources).toBeDefined();
    expect(askSources?.path).toBe('skills/ask-sources/SKILL.md');
    expect(askSources?.description).toContain('source_answer');
    expect(askSources?.description).toContain('source_index_search');
    expect(askSources?.description).toContain('Never use bash');
    expect(askSources?.description).toContain('skill-file inspection');
    expect(askSources?.description).toContain('omit corpus_id unless intentionally force-narrowing');
    expect(askEmailLocal).toBeUndefined();
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
    expect(emailSkill).toContain('compatibility shim');
    expect(emailSkill).toContain('use `skills/ask-sources/SKILL.md`');
    expect(emailSkill).toContain('Omit `corpus_id` on the first private ask');
    expect(emailSkill).toContain('Do not call `email_answer`');
    expect(resolver).toContain('| User asks to search Telegram, X/Twitter bookmarks, saved/bookmarked tweets/posts, Readwise, Drive/Docs, Dropbox, or another Olympus-indexed source | `skills/ask-sources/SKILL.md` |');
    expect(resolver).toContain('| User asks to search, summarize, inspect, or answer questions about Gmail/email | `skills/ask-sources/SKILL.md` |');
    expect(resolver).toContain('use one `source_answer` call with');
    expect(resolver).toContain('Do not route legal, financial');
    expect(resolver).toContain('do not fall back to raw shell');
  });

  test('runtime update skill carries the OpenClaw live-system protocol', () => {
    const skill = readFileSync(join(ROOT, 'skills', 'update-openclaw-runtime', 'SKILL.md'), 'utf8');
    const resolver = readFileSync(join(ROOT, 'skills', 'RESOLVER.md'), 'utf8');
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    const canonical = readFileSync(join(ROOT, 'docs', 'ops', 'OPENCLAW_CHANGE_PROTOCOL.md'), 'utf8');
    const normativeProtocol = canonical.split('\n## Known sharp edges')[0]!.trim().replace(/\r\n/g, '\n');
    const protocolPin = createHash('sha256').update(normativeProtocol).digest('hex');

    for (const text of [
      'openclaw docs <query>',
      'config.schema.lookup',
      'openclaw config validate && openclaw doctor --lint --severity-min error --non-interactive',
      'openclaw secrets audit --check --allow-exec',
      'scripts/ops/openclaw-safe-restart.sh',
      '[gateway] http server listening (N plugins…)',
      'openclaw gateway stability --bundle latest',
      'config set` `.bak.*` rotation',
      `OPENCLAW_PROTOCOL_NORMATIVE_SHA256: ${protocolPin}`,
    ]) {
      expect(skill).toContain(text);
      expect(resolver).toContain(text);
      expect(agents).toContain(text);
    }
    expect(skill).toContain('openclaw config set|unset');
    expect(skill).toContain('config.patch');
    expect(skill).toContain('Validate before restart');
    expect(skill).toContain('../../docs/ops/OPENCLAW_CHANGE_PROTOCOL.md');
    expect(resolver).toContain('Before any live runtime config');
    expect(agents).toContain('requires all three legs');
    expect(agents).toContain('Runtime-hold flock/link custody stays on one local ext4 filesystem');
    expect(skill).toContain('Commit-ready crash recovery is');
    expect(resolver).toMatch(/commit-ready crash recovery is\s+cleanup-only/);
    for (const text of [
      'crash-durably publishes',
      '`inactive`/3',
      '`failed`/3',
      'parent-directory fsync',
    ]) {
      expect(skill).toContain(text);
      expect(resolver).toContain(text);
      expect(agents).toContain(text);
      expect(canonical).toContain(text);
    }

    for (const staleOrUnsafeGuidance of [
      '`openclaw doctor --lint`',
      '`openclaw gateway restart`',
      'openclaw doctor --fix',
      '`systemctl restart',
    ]) {
      expect(skill).not.toContain(staleOrUnsafeGuidance);
      expect(resolver).not.toContain(staleOrUnsafeGuidance);
      expect(agents).not.toContain(staleOrUnsafeGuidance);
    }
  });

  test('agent-workshop remains repository-only and outside the public artifact', () => {
    const agentWorkshop = readFileSync(join(ROOT, 'skills', 'agent-workshop', 'SKILL.md'), 'utf8');
    const governance = readFileSync(join(ROOT, 'skills', 'governance-research', 'SKILL.md'), 'utf8');
    const resolver = readFileSync(join(ROOT, 'skills', 'RESOLVER.md'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(ROOT, 'skills', 'manifest.json'), 'utf8')) as {
      skills: Array<{ name: string; path: string; description: string }>;
    };

    expect(manifest.skills.find((entry) => entry.name === 'agent-workshop')).toBeUndefined();
    expect(agentWorkshop).toContain('Agent Workshop is the factory');
    expect(agentWorkshop).toContain('Call `domain_agent` first');
    expect(agentWorkshop).toContain('Use OpenClaw `skill_workshop`');
    expect(agentWorkshop).toContain('The OpenClaw workspace is not the source library of record');
    expect(agentWorkshop).toContain('Gemini lane deployment checklist per domain');
    expect(governance).toContain('Do not use this skill to create new agents');
    // The skill ships in the release tarball to every installation, so it names
    // the unpackaged deployment note by path instead of carrying one tenant's
    // service account, project, bucket and corpus resource in its body.
    expect(governance).toContain('docs/roles/researcher/GOVERNANCE_RAG_DEPLOYMENT.md');
    expect(governance).not.toContain('gserviceaccount.com');
    expect(governance).not.toContain('8463231270061604864');
    expect(governance).not.toContain('olympus-491816');
    expect(governance).not.toContain('castor-493710');
    expect(governance).not.toContain('gs://castor-governance-rag');
    expect(governance).not.toContain('When the owner asks to create a new domain agent');
    expect(resolver).toContain('| User asks Castor to create, bootstrap, spin up, register, bind, or clone a new domain-specific agent | `skills/agent-workshop/SKILL.md` |');
    expect(resolver).toContain('Do not put generic agent-creation behavior inside');
    expect(resolver).toContain('The OpenClaw workspace holds scaffold, doctrine, memory, registry');
  });
});
