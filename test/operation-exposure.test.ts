import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { exposedOperations, type OperationSurface } from '../src/core/operation-exposure.ts';
import { operations } from '../src/core/operations.ts';

function exposedNames(config = defaultConfig()): string[] {
  return surfaceNames('native', config);
}

function surfaceNames(
  surface: OperationSurface,
  config = defaultConfig(),
): string[] {
  return exposedOperations(operations, {
    config,
    surface,
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

  test('can disable the product source-index surface', () => {
    const config = defaultConfig();
    config.sourceIndex.enabled = false;

    expect(exposedNames(config)).not.toContain('source_answer');
    expect(exposedNames(config)).not.toContain('source_index_status');
    expect(exposedNames(config)).not.toContain('source_index_search');
    expect(exposedNames(config)).not.toContain('source_watch_create');
    expect(exposedNames(config)).not.toContain('source_watches');
    expect(exposedNames(config)).not.toContain('source_watch_cancel');
  });

  test('legacy source-index answer dev gate still enables the promoted read surface', () => {
    const config = defaultConfig();
    config.sourceIndex.enabled = false;
    config.sourceIndex.answerDevEnabled = true;

    expect(exposedNames(config)).toContain('source_answer');
    expect(exposedNames(config)).toContain('source_index_status');
    expect(exposedNames(config)).toContain('source_index_search');
  });

});
