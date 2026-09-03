import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { exposedOperations, type OperationSurface } from '../src/core/operation-exposure.ts';
import { operations } from '../src/core/operations.ts';

function exposedNames(config = defaultConfig(), activeModel?: unknown, hireBrokerEnabled?: boolean): string[] {
  return surfaceNames('native', config, activeModel, hireBrokerEnabled);
}

function surfaceNames(
  surface: OperationSurface,
  config = defaultConfig(),
  activeModel?: unknown,
  hireBrokerEnabled?: boolean,
): string[] {
  return exposedOperations(operations, {
    config,
    surface,
    activeModel,
    ...(hireBrokerEnabled !== undefined ? { hireBrokerEnabled } : {}),
  }).map((operation) => operation.name);
}

describe('operation exposure policy', () => {
  test('fresh defaults expose the promoted source-index read surface', () => {
    expect(exposedNames()).toEqual([
      'argus_ping',
      'argus_list_models',
      'argus_complete',
      'source_answer',
      'source_index_status',
      'source_index_search',
      'source_watch_create',
      'source_watches',
      'source_watch_cancel',
      'olympus_doctor',
    ]);
  });

  test('only the native surface advertises the operations that need its session route', () => {
    // Every other surface would publish a tool with nowhere to get the
    // authenticated owner and delivery route from, so the call could only
    // ever come back as a policy refusal.
    const sessionRouteOnly = ['source_watch_create', 'source_watches', 'source_watch_cancel'];
    const native = surfaceNames('native');
    for (const name of sessionRouteOnly) expect(native).toContain(name);
    for (const surface of ['mcp', 'cli'] as const) {
      const names = surfaceNames(surface);
      for (const name of sessionRouteOnly) expect(names).not.toContain(name);
      // Nothing else moved: the two surfaces differ by exactly those three.
      expect(names).toEqual(native.filter((operation) => !sessionRouteOnly.includes(operation)));
    }
  });

  test('keeps domain expert tools outside the v0.4 public surface even when internal gates are active', () => {
    const config = defaultConfig();
    const domainTools = [
      'domain_agent',
      'domain_ask',
      'domain_source',
      'rag_corpus',
      'domain_doc',
      'annas_archive_search',
      'annas_archive_import',
    ];

    config.domainExpert.liveToolsEnabled = true;
    for (const tool of domainTools) expect(exposedNames(config)).not.toContain(tool);

    config.domainExpert.enabled = true;
    config.domainExpert.liveToolsEnabled = false;
    for (const tool of domainTools) expect(exposedNames(config)).not.toContain(tool);

    config.domainExpert.liveToolsEnabled = true;
    for (const tool of domainTools) expect(exposedNames(config)).not.toContain(tool);
  });

  test('can disable the product source-index read surface without exposing operator tools', () => {
    const config = defaultConfig();
    config.sourceIndex.enabled = false;

    expect(exposedNames(config)).not.toContain('source_answer');
    expect(exposedNames(config)).not.toContain('source_index_status');
    expect(exposedNames(config)).not.toContain('source_index_search');
    expect(exposedNames(config)).not.toContain('source_watch_create');
    expect(exposedNames(config)).not.toContain('source_watches');
    expect(exposedNames(config)).not.toContain('source_watch_cancel');
    expect(exposedNames(config)).not.toContain('xanthos_file_deliver');
    expect(exposedNames(config)).not.toContain('source_index_sync');
    expect(exposedNames(config)).not.toContain('email_index_search');
  });

  test('legacy source-index answer dev gate still enables the promoted read surface', () => {
    const config = defaultConfig();
    config.sourceIndex.enabled = false;
    config.sourceIndex.answerDevEnabled = true;

    expect(exposedNames(config)).toContain('source_answer');
    expect(exposedNames(config)).toContain('source_index_status');
    expect(exposedNames(config)).toContain('source_index_search');
  });

  test('operator-gated source-index tools stay hidden on fresh product defaults', () => {
    const names = exposedNames();

    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('source_export');
    expect(names).not.toContain('source_transcribe');
    expect(names).not.toContain('source_media_ingest');
    expect(names).not.toContain('source_index_promotion_candidates');
    expect(names).not.toContain('source_index_promotion_propose');
    expect(names).not.toContain('source_index_promotion_proposals');
    expect(names).not.toContain('source_index_promotion_proposal');
    expect(names).not.toContain('source_index_promotion_decide');
  });

  test('keeps Hire Broker tools outside the v0.4 public surface', () => {
    expect(exposedNames()).not.toContain('expert_hire');
    expect(exposedNames()).not.toContain('expert_report');
    expect(exposedNames(defaultConfig(), undefined, true)).not.toContain('expert_hire');
    expect(exposedNames(defaultConfig(), undefined, true)).not.toContain('expert_report');
  });

  test('keeps Xanthos file delivery outside the v0.4 public surface', () => {
    const config = defaultConfig();
    expect(exposedNames(config)).not.toContain('xanthos_file_deliver');

    config.fileDelivery.enabled = true;

    expect(exposedNames(config)).not.toContain('xanthos_file_deliver');
  });

  test('hides private email tools when active-model guard is enabled without approved local metadata', () => {
    const config = defaultConfig();
    config.email.localPacketsDevEnabled = true;
    config.email.indexAdminDevEnabled = true;
    config.email.requireLocalActiveModelForPrivateTools = true;

    expect(exposedNames(config)).not.toContain('email_search');
    expect(exposedNames(config)).not.toContain('email_index_search');
    expect(exposedNames(config)).not.toContain('email_index_sync');
    expect(exposedNames(config)).not.toContain('source_index_sync');
    expect(exposedNames(config, { provider: 'openai-codex', modelId: 'gpt-5.5' }))
      .not.toContain('email_index_search');
  });

  test('keeps private email packet/admin tools outside the v0.4 public surface', () => {
    const config = defaultConfig();
    config.argus.lanes.fast.model = 'local-qwen-fast';
    config.email.localPacketsDevEnabled = true;
    config.email.indexAdminDevEnabled = true;
    config.email.requireLocalActiveModelForPrivateTools = true;

    const names = exposedNames(config, {
      provider: 'olympus-local',
      modelId: 'local-qwen-fast',
    });

    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('email_index_sync');
    expect(names).not.toContain('email_index_embed');
    expect(names).not.toContain('source_index_sync');
  });
});
