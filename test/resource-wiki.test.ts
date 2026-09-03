import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  assertNoForbiddenResourceWikiOutput,
  compileResourceWikiPages,
  compileResourceWikiProof,
  createOpenClawMemorySolutionsModelAuthoredBody,
  renderResourceWikiPage,
  writeResourceWikiPages,
  writeResourceWikiProof,
} from '../src/core/resource-wiki.ts';
import { createOlympusKnowledgeArchitecturePageInput } from '../scripts/resource-wiki-compile-real.ts';

describe('resource wiki compiler proof', () => {
  test('renders prose-first markdown with required frontmatter and sections', () => {
    const result = compileResourceWikiProof({ compiledAt: '2026-05-19T12:00:00.000Z' });
    const page = result.pages[0];

    expect(page?.path).toBe('03 Resources/OpenClaw Memory Solutions.md');
    expect(page?.markdown).toStartWith('---\ntype: resource_wiki_page\n');
    expect(page?.markdown).toContain('canonical_id: resource-wiki/openclaw-memory-solutions');
    expect(page?.markdown).toContain('resource_kind: technical_landscape');
    expect(page?.markdown).toContain('trust_domain: internal');
    expect(page?.markdown).toContain('sensitivity: internal_notes');
    expect(page?.markdown).toContain('review_status: proposed');
    expect(page?.markdown).toContain('generated_by: olympus.resource-wiki.compiler');
    expect(page?.markdown).toContain('model_lane: model_authored_synthesis');
    expect(page?.markdown).toContain('last_compiled_at: 2026-05-19T12:00:00.000Z');
    expect(page?.markdown).toContain('valid_as_of: 2026-05-19');
    expect(page?.markdown).toContain('source_refs:\n  - id: docs.openclaw-memory');
    expect(page?.markdown).toContain('knowledge_roles:\n  - definition');
    expect(page?.markdown).toContain('what_changed:\n  - "Created the first bounded Resource Wiki proof page."');

    for (const heading of [
      '# OpenClaw Memory Solutions',
      '## Current Shape',
      '## Main Patterns',
      '## Current Castor Take',
      '## Open Questions',
      '## Related Pages',
      '## Notes',
    ]) {
      expect(page?.markdown).toContain(heading);
    }
    expect(page?.markdown).toContain('OpenClaw memory is best understood as product infrastructure');
    expect(page?.markdown).toContain('Castor should read these pages as concise operating knowledge.');
  });

  test('keeps source families distinct from knowledge roles', () => {
    const page = compileResourceWikiProof({ compiledAt: '2026-05-19T12:00:00.000Z' }).pages[0];
    expect(page?.metadata.source_refs.map((sourceRef) => sourceRef.family).sort()).toEqual([
      'docs',
      'research_notes',
    ]);
    expect(page?.metadata.knowledge_roles).toEqual([
      'definition',
      'current_state',
      'pattern',
      'castor_take',
      'open_question',
      'related_page',
    ]);
    expect(page?.metadata.knowledge_roles).not.toContain('docs');
    expect(page?.metadata.source_refs.map((sourceRef) => sourceRef.family)).not.toContain('castor_take');
  });

  test('writes the PARA-ish layout, page, and log into a vault', async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'olympus-rw-vault-'));
    const result = await writeResourceWikiProof({
      vaultRoot,
      compiledAt: '2026-05-19T12:00:00.000Z',
    });

    for (const dir of ['00 Meta', '01 Projects', '02 Areas', '03 Resources', '04 Archive']) {
      expect((await stat(path.join(vaultRoot, dir))).isDirectory()).toBe(true);
    }

    const page = await readFile(path.join(vaultRoot, '03 Resources/OpenClaw Memory Solutions.md'), 'utf8');
    const log = await readFile(path.join(vaultRoot, '00 Meta/Resource Wiki/log.md'), 'utf8');

    expect(page).toContain('# OpenClaw Memory Solutions');
    expect(log).toContain('pages_written: 03 Resources/OpenClaw Memory Solutions.md');
    expect(result.log.entry.reset_vault).toBe(false);
  });

  test('compiles selected Readwise and X evidence into an Olympus architecture Resource page', async () => {
    const pageInput = createOlympusKnowledgeArchitecturePageInput('2026-05-19');
    const result = compileResourceWikiPages({
      pages: [pageInput],
      compiledAt: '2026-05-19T14:00:00.000Z',
    });
    const page = result.pages[0];

    expect(page?.path).toBe('03 Resources/Olympus Knowledge Architecture.md');
    expect(page?.markdown).toContain('# Olympus Knowledge Architecture');
    expect(page?.markdown).toContain('canonical_id: resource-wiki/olympus-knowledge-architecture');
    expect(page?.markdown).toContain('corpus_id: "internal.readwise.library"');
    expect(page?.markdown).toContain('corpus_id: "internal.x.bookmarks"');
    expect(page?.markdown).toContain('folder_names:\n      - "AI"');
    expect(page?.markdown).toContain('knowledge_roles:\n  - claim');
    expect(page?.markdown).toContain('source_quality');
    expect(page?.markdown).toContain('review_status: proposed');
    expect(page?.markdown).not.toContain('[[03 Resources/OpenClaw Memory Solutions|OpenClaw Memory Solutions]]');
    expect(page?.markdown).toContain('[[00 Meta/Resource Wiki/log|Resource Wiki compile log]]');
    expect(() => assertNoForbiddenResourceWikiOutput(page?.markdown ?? '')).not.toThrow();
  });

  test('writes arbitrary compiled pages through the generic vault writer', async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'olympus-rw-real-'));
    const result = await writeResourceWikiPages({
      vaultRoot,
      compiledAt: '2026-05-19T14:00:00.000Z',
      pages: [createOlympusKnowledgeArchitecturePageInput('2026-05-19')],
    });

    const page = await readFile(path.join(vaultRoot, '03 Resources/Olympus Knowledge Architecture.md'), 'utf8');
    const log = await readFile(path.join(vaultRoot, '00 Meta/Resource Wiki/log.md'), 'utf8');

    expect(page).toContain('type: resource_wiki_page');
    expect(page).toContain('provider_item_id: "highlight:1002715743"');
    expect(log).toContain('pages_written: 03 Resources/Olympus Knowledge Architecture.md');
    expect(result.pages).toHaveLength(1);
  });

  test('reset preserves .obsidian while clearing generated vault content', async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'olympus-rw-reset-'));
    await mkdir(path.join(vaultRoot, '.obsidian'), { recursive: true });
    await writeFile(path.join(vaultRoot, '.obsidian/app.json'), '{"always":"keep"}', 'utf8');
    await mkdir(path.join(vaultRoot, '03 Resources'), { recursive: true });
    await writeFile(path.join(vaultRoot, '03 Resources/stale.md'), 'stale', 'utf8');
    await writeFile(path.join(vaultRoot, 'loose.md'), 'remove me', 'utf8');

    await writeResourceWikiProof({
      vaultRoot,
      resetVault: true,
      compiledAt: '2026-05-19T12:00:00.000Z',
    });

    expect(await readFile(path.join(vaultRoot, '.obsidian/app.json'), 'utf8')).toBe('{"always":"keep"}');
    await expect(stat(path.join(vaultRoot, '03 Resources/stale.md'))).rejects.toThrow();
    await expect(stat(path.join(vaultRoot, 'loose.md'))).rejects.toThrow();
    expect(await readFile(path.join(vaultRoot, '03 Resources/OpenClaw Memory Solutions.md'), 'utf8')).toContain(
      'review_status: proposed',
    );
  });

  test('rejects path traversal before writing markdown', () => {
    const packet = compileResourceWikiProof({ compiledAt: '2026-05-19T12:00:00.000Z' }).pages[0]?.metadata;
    expect(packet).toBeDefined();

    expect(() =>
      renderResourceWikiPage(
        {
          packetId: 'bad',
          title: 'Bad',
          canonicalId: 'bad',
          resourceKind: 'technical_landscape',
          trustDomain: 'internal',
          sensitivity: 'internal_notes',
          validAsOf: '2026-05-19',
          sourceRefs: [
            {
              id: 's1',
              family: 'docs',
              label: 'Safe fixture',
              provider: 'fixture',
              trustDomain: 'internal',
              sensitivity: 'internal_notes',
              validAsOf: '2026-05-19',
            },
          ],
          evidence: [
            {
              id: 'e1',
              sourceRefIds: ['s1'],
              knowledgeRoles: ['definition'],
              summary: 'Safe synthesized claim.',
            },
          ],
          whatChanged: ['Created a test page.'],
        },
        {
          path: '../outside.md',
          reviewStatus: 'experimental',
          compiledAt: '2026-05-19T12:00:00.000Z',
          body: {
            lead: 'Safe synthesized lead.[^e1]',
            sections: [{ heading: 'Safe', markdown: 'Safe synthesized body.[^e1]' }],
            relatedPages: [],
          },
        },
      ),
    ).toThrow('Resource Wiki paths must not contain traversal segments');
  });

  test('rejects model-authored bodies with unknown evidence citations', () => {
    expect(() =>
      renderResourceWikiPage(
        {
          packetId: 'bad-cite',
          title: 'Bad Cite',
          canonicalId: 'bad-cite',
          resourceKind: 'technical_landscape',
          trustDomain: 'internal',
          sensitivity: 'internal_notes',
          validAsOf: '2026-05-19',
          sourceRefs: [
            {
              id: 's1',
              family: 'docs',
              label: 'Safe fixture',
              provider: 'fixture',
              trustDomain: 'internal',
              sensitivity: 'internal_notes',
              validAsOf: '2026-05-19',
            },
          ],
          evidence: [
            {
              id: 'e1',
              sourceRefIds: ['s1'],
              knowledgeRoles: ['definition'],
              summary: 'Safe synthesized claim.',
            },
          ],
          whatChanged: ['Created a test page.'],
        },
        {
          path: '03 Resources/Bad Cite.md',
          reviewStatus: 'experimental',
          compiledAt: '2026-05-19T12:00:00.000Z',
          body: {
            ...createOpenClawMemorySolutionsModelAuthoredBody(),
            lead: 'This body cites something outside the packet.[^missing]',
          },
        },
      ),
    ).toThrow('Resource Wiki model-authored body cites unknown evidence id: missing');
  });

  test('generated output has no obvious private/source packet fields', () => {
    const result = compileResourceWikiProof({ compiledAt: '2026-05-19T12:00:00.000Z' });
    const output = JSON.stringify(result);
    expect(() => assertNoForbiddenResourceWikiOutput(output)).not.toThrow();
    expect(output).not.toContain('raw_text');
    expect(output).not.toContain('source_packet');
    expect(output).not.toContain('vectors');
    expect(output).not.toContain('oauth');
    expect(output).not.toContain('access_token');
    expect(output).not.toContain('refresh_token');
    expect(output).not.toContain('snippet');
  });
});
