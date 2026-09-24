import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  classifyChange,
  type ChangeRiskConfig,
} from '../scripts/change-risk.ts';

const config = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'config/change-risk.json'), 'utf8'),
) as ChangeRiskConfig;

describe('change risk', () => {
  test('ordinary product and test changes remain standard', () => {
    expect(classifyChange(['src/core/source-index/router.ts', 'test/router.test.ts'], config).risk)
      .toBe('standard');
  });

  test('governance, contract, ops, and sensitive code paths are critical', () => {
    const result = classifyChange([
      '.github/workflows/verify.yml',
      'src/core/contracts.ts',
      'scripts/ops/refresh.sh',
      'src/core/credential-broker.ts',
    ], config);
    expect(result.risk).toBe('critical');
    expect(result.criticalFiles).toHaveLength(4);
  });

  test('the frozen public surface and imported contract types cannot bypass critical review', () => {
    const surfaces = [
      'openclaw.plugin.json',
      'src/core/public-surface.ts',
      'src/core/source-index/types.ts',
    ];
    expect(classifyChange(surfaces, config).criticalFiles).toEqual([...surfaces].sort());
  });

  test('lifecycle, install, upgrade, rollback, service-manager, and managed-path changes are critical', () => {
    const lifecycleSurfaces = [
      'INSTALL_FOR_AGENTS.md',
      'docs/UNINSTALL.md',
      'src/cli.ts',
      'src/core/lifecycle.ts',
      'src/core/lifecycle-artifact.ts',
      'src/core/managed-path.ts',
      'src/core/upgrade-plan.ts',
      'src/core/rollback-plan.ts',
      'src/core/service-manager.ts',
      'src/core/worker-service.ts',
      'src/platform/launchd-unit.ts',
      'src/platform/systemd-unit.ts',
    ];
    expect(classifyChange(lifecycleSurfaces, config).criticalFiles).toEqual(lifecycleSurfaces.sort());
  });

  test('the active Slice 3B lifecycle change cannot be classified as standard', () => {
    const result = classifyChange([
      'README.md',
      'src/core/lifecycle.ts',
      'src/core/lifecycle-lock.ts',
      'src/core/worker-service.ts',
      'test/lifecycle.test.ts',
    ], config);
    expect(result.risk).toBe('critical');
    expect(result.criticalFiles).toEqual([
      'src/core/lifecycle-lock.ts',
      'src/core/lifecycle.ts',
      'src/core/worker-service.ts',
    ]);
  });

  test('the classifier and the checks that defend it classify themselves as critical', () => {
    const selfProtecting = [
      'config/change-risk.json',
      'config/critical-review.json',
      'scripts/credential-pattern-check.ts',
      'scripts/change-risk.ts',
      'scripts/critical-review-receipt.ts',
      'scripts/test-lane.ts',
      'test/change-risk.test.ts',
      'test/critical-review-workflow.test.ts',
      'test/credential-pattern-check.test.ts',
      'test/verify-workflow.test.ts',
    ];
    expect(classifyChange(selfProtecting, config).criticalFiles).toEqual(selfProtecting.sort());
  });

  test('the plugin entry point and the host-loadability guards are critical', () => {
    const entryPoints = [
      'openclaw.plugin.json',
      'src/native-plugin.ts',
      'scripts/public-manifest-guard.ts',
      'scripts/top-level-await-scan.ts',
      'test/plugin-bundle-no-top-level-await.test.ts',
      'test/plugin-host-loader-compatibility.test.ts',
    ];
    expect(classifyChange(entryPoints, config).criticalFiles).toEqual([...entryPoints].sort());
  });

  test('source-answer trust routing and the trust model it implements are critical', () => {
    // Which evidence a source answer searches, which analyst may read it, and
    // what is released from it is security/trust routing, not ordinary
    // product behavior; a path-only classifier must see it.
    const trustRouting = [
      'docs/TRUST_MODEL.md',
      'src/workers/email-source/server.ts',
      'src/workers/source-index/analyst-answer.ts',
      'src/workers/source-index/analyst-pool.ts',
    ];
    expect(classifyChange(trustRouting, config).criticalFiles).toEqual([...trustRouting].sort());
  });

  test('remote agent endpoints and the connection store are critical', () => {
    // Every file here decides who outside this machine may call Olympus and
    // what they reach: connection-token auth, the remote routes, the store.
    const remoteSurfaces = [
      'src/core/remote-connections.ts',
      'src/workers/remote-mcp.ts',
      'src/workers/remote-openapi.ts',
      'src/workers/remote-request-body.ts',
    ];
    expect(classifyChange(remoteSurfaces, config).criticalFiles).toEqual([...remoteSurfaces].sort());
  });

  test('rejects a stale configuration schema instead of guessing', () => {
    const stale = { ...config, schemaVersion: 1 } as unknown as ChangeRiskConfig;
    expect(() => classifyChange(['AGENTS.md'], stale)).toThrow(/Unsupported change-risk configuration/);
  });

  test('publisher token exchange code, configuration, and its tests require critical review', () => {
    const surfaces = [
      'exchange/src/index.ts',
      'exchange/src/google.ts',
      'exchange/src/redirect-allowlist.ts',
      'exchange/src/new-handler.ts',
      'exchange/wrangler.toml',
      'exchange/package.json',
      'exchange/tsconfig.json',
      'exchange/test/google-exchange.test.ts',
    ];
    expect(classifyChange(surfaces, config).criticalFiles).toEqual([...surfaces].sort());
  });
});
