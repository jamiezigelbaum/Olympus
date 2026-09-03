import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

describe('verification contract', () => {
  test('focused, explicit local checks remain available without running in pre-push', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:focus']).toBe('bun test');
    expect(pkg.scripts['contracts:check']).toBe('bun scripts/contract-version.ts');
    expect(pkg.scripts['credentials:check']).toBe('bun scripts/credential-pattern-check.ts');
    expect(pkg.scripts['risk:check']).toBe('bun scripts/change-risk.ts');
    expect(pkg.scripts['test:go']).toBe('bun scripts/test-lane.ts go');
    expect(pkg.scripts.verify).toBe('bun run typecheck && bun run test:fast && bun run dist:check');
    expect(pkg.scripts['verify:full']).toBe('bun run typecheck && bun run test && bun run dist:check');

    expect(pkg.scripts['hooks:install']).toBeUndefined();
    expect(existsSync(join(ROOT, '.githooks'))).toBe(false);
    expect(existsSync(join(ROOT, '.husky'))).toBe(false);
    expect(JSON.stringify(pkg)).not.toMatch(/hooksPath|\.githooks|husky|simple-git-hooks/);
  });

  test('required CI exposes every substantive lane directly without a billed aggregate job', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'verify.yml'), 'utf8');
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).not.toContain('branches: ["**"]');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(workflow).not.toMatch(/uses: [^\n]+@(v|main\b)/);
    expect(workflow).toContain('types: [opened, synchronize, reopened]');
    expect(workflow).not.toMatch(/\b(labeled|unlabeled)\b/);
    expect(workflow).not.toContain('run: bun run risk:check');
    expect(workflow).toContain('bun scripts/credential-pattern-check.ts --base "$BASE_SHA" --head "$HEAD_SHA"');
    expect(workflow).toContain('run: bun run contracts:check');
    expect(workflow).toContain('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(workflow).toContain('release-artifacts/ci-provenance.json');
    expect(workflow).toContain('cache-dependency-path: |\n            tools/whatsapp-bridge/go.sum\n            config/go-cache-version');
    expect(workflow).toContain('command -v shellcheck >/dev/null ||');
    expect(workflow).toContain('OLYMPUS_JUNIT_PATH: test-results/fast.xml');
    expect(workflow).toContain('name: fast-timing-${{ github.sha }}');
    expect(workflow).toContain('path: test-results/fast.xml');
    expect(workflow).toContain('OLYMPUS_JUNIT_PATH: test-results/deploy-${{ matrix.shard }}.xml');
    expect(workflow).toContain("if: ${{ always() && github.event_name == 'push' }}");
    expect(workflow).toMatch(/\n  static:\n/);
    expect(workflow).toMatch(/\n  fast:\n/);
    expect(workflow).toMatch(/\n  deploy:\n/);
    expect(workflow).toMatch(/\n  go:\n    name: Go bridge tests\n/);
    const deploySection = workflow.slice(workflow.indexOf('\n  deploy:\n'), workflow.indexOf('\n  go:\n'));
    expect(deploySection).not.toContain('actions/setup-go@');
    expect(workflow).toContain('bun scripts/test-lane.ts go');
    expect(workflow).toContain('shard: [1, 2, 3]');
    expect(workflow).toContain('bun scripts/test-lane.ts deploy --shard=${{ matrix.shard }}/3');
    expect(workflow).not.toMatch(/\n  verify:\n/);
    expect(workflow).not.toContain('needs: [static, fast, deploy, go]');
    expect(workflow).not.toContain('Require every lane');
    expect(workflow).not.toContain('run: bun run verify\n');
  });

  test('scheduled Go qualification stays cold and isolated from pull-request latency', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'hermetic-go.yml'), 'utf8');
    expect(workflow).toContain("cron: '17 5 * * 1'");
    expect(workflow).toContain('cache: false');
    expect(workflow).toContain('GOCACHE: ${{ runner.temp }}/olympus-hermetic-go-cache');
    expect(workflow).toContain('go test -count=1 ./...');
    expect(workflow).not.toMatch(/uses: [^\n]+@(v|main\b)/);
  });
});
