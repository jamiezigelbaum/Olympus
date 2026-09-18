import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { exposedOperations, type OperationSurface } from '../src/core/operation-exposure.ts';
import { operations } from '../src/core/operations.ts';

function exposedNames(config = defaultConfig(), activeModel?: unknown): string[] {
  return surfaceNames('native', config, activeModel);
}

function surfaceNames(
  surface: OperationSurface,
  config = defaultConfig(),
  activeModel?: unknown,
): string[] {
  return exposedOperations(operations, {
    config,
    surface,
    activeModel,
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

  test('can disable the product source-index read surface', () => {
    const config = defaultConfig();
    config.sourceIndex.enabled = false;

    expect(exposedNames(config)).not.toContain('source_answer');
    expect(exposedNames(config)).not.toContain('source_index_status');
    expect(exposedNames(config)).not.toContain('source_index_search');
    expect(exposedNames(config)).not.toContain('source_watch_create');
    expect(exposedNames(config)).not.toContain('source_watches');
    expect(exposedNames(config)).not.toContain('source_watch_cancel');
    expect(exposedNames(config)).toEqual([
      'argus_ping',
      'argus_list_models',
      'argus_complete',
      'olympus_doctor',
    ]);
  });

  test('the retired private tool names cannot come back through the registry', () => {
    // The fifteen pre-v0.4 email, index-administration and unqualified source
    // workflow tools were deleted on 2026-09-18. Registering any of them again
    // would have to pass the public lists first, but this is the cheap check
    // that the registry itself no longer carries them.
    const registered = new Set(operations.map((operation) => operation.name));
    for (const name of [
      'email_ping',
      'email_answer',
      'email_search',
      'email_index_sync',
      'email_index_embed',
      'email_index_search',
      'source_index_sync',
      'source_export',
      'source_transcribe',
      'source_media_ingest',
      'source_index_promotion_candidates',
      'source_index_promotion_propose',
      'source_index_promotion_proposals',
      'source_index_promotion_proposal',
      'source_index_promotion_decide',
    ]) expect(registered.has(name), `${name} is still registered`).toBe(false);
  });

  test('the active-model guard does not change the public roster', () => {
    // It survives the private-tool retirement as a configuration flag with no
    // gated tools left; nothing it can hide is on the public lists.
    const config = defaultConfig();
    config.argus.lanes.fast.model = 'local-qwen-fast';
    config.email.requireLocalActiveModelForPrivateTools = true;

    expect(exposedNames(config)).toEqual(exposedNames());
    expect(exposedNames(config, { provider: 'olympus-local', modelId: 'local-qwen-fast' }))
      .toEqual(exposedNames());
  });
});
