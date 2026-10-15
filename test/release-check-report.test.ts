// The release check's report: verdict rules, the static HTML page, and the
// scan that keeps Private and Secret text out of the report itself.

import { describe, expect, test } from 'bun:test';
import { forbiddenMarkers, PRIVATE_MARKER, SECRET_MARKER } from '../scripts/release-check/fixture.ts';
import {
  buildReport,
  escapeHtml,
  renderHtml,
  scanReport,
  type CheckResult,
  type MachineReport,
  type ReleaseReportInput,
} from '../scripts/release-check/report.ts';

const ASKED: CheckResult = { id: 'q1.facts', title: 'Answer states the facts', status: 'pass' };

function machine(checks: CheckResult[], agentChecks: CheckResult[] = [ASKED]): MachineReport {
  return {
    id: 'm1',
    label: 'Linux VM',
    os: 'linux',
    driver: 'test-driver',
    build: '1.0.0+abc',
    timings: { provision: 61_000, ingest: 120_500 },
    checks,
    agents: [
      { id: 'a1', label: 'Agent One', kind: 'model', ran: true, checks: agentChecks },
      { id: 'a2', label: 'Agent Two', kind: 'model', ran: false, skipReason: 'key missing: no provider API key is available to this run; skipped', checks: [] },
    ],
    screenshots: [{ label: '390 px wide, light', path: 'screenshots/dashboard-390-light.png', width: 390, theme: 'light' }],
    logs: [{ label: 'run.log', path: 'logs/run.log' }],
  };
}

function input(overrides: Partial<ReleaseReportInput> = {}): ReleaseReportInput {
  return {
    runId: 'run-1',
    candidate: { label: 'main@abcd1234', sha: 'abcd1234' },
    startedAt: '2026-10-14T20:00:00.000Z',
    finishedAt: '2026-10-14T20:30:00.000Z',
    machines: [machine([{ id: 'c1', title: 'Install', status: 'pass' }])],
    errors: [],
    ...overrides,
  };
}

describe('release-check report verdict', () => {
  test('passes when nothing failed, and a skipped agent does not fail the run', () => {
    const report = buildReport(input());
    expect(report.verdict).toBe('pass');
    expect(report.counts).toEqual({ pass: 2, fail: 0, warn: 0, skip: 0 });
  });

  test('a skipped check is counted but never fails the run; a warning does not either', () => {
    const report = buildReport(input({ machines: [machine([
      { id: 'c1', title: 'Install', status: 'pass' },
      { id: 'c2', title: 'Judge', status: 'skip' },
      { id: 'c3', title: 'Quality', status: 'warn' },
    ])] }));
    expect(report.verdict).toBe('pass');
    expect(report.counts).toEqual({ pass: 2, fail: 0, warn: 1, skip: 1 });
  });

  test('one failed check in a machine or an agent fails the run', () => {
    expect(buildReport(input({ machines: [machine([{ id: 'c1', title: 'x', status: 'fail' }])] })).verdict).toBe('fail');
    expect(buildReport(input({ machines: [machine([], [{ id: 'q.no-leak', title: 'x', status: 'fail' }])] })).verdict).toBe('fail');
  });

  test('a run in which every agent was skipped fails: nothing was asked of the product', () => {
    const skipped = machine([{ id: 'c1', title: 'Install', status: 'pass' }]);
    skipped.agents = skipped.agents.map((agent) => ({ ...agent, ran: false, skipReason: 'key missing', checks: [] }));
    const report = buildReport(input({ machines: [skipped] }));
    expect(report.verdict).toBe('fail');
    expect(report.errors.join(' ')).toContain('every agent was skipped');
    expect(renderHtml(report)).toContain('no agent asked a question');
    // Rebuilding from the finished report records the problem once.
    expect(buildReport({ ...report, machines: [skipped] }).errors).toEqual(report.errors);
  });

  test('a machine with no agents configured, or whose agents ran without producing a check, also fails', () => {
    const none = machine([{ id: 'c1', title: 'Install', status: 'pass' }]);
    none.agents = [];
    expect(buildReport(input({ machines: [none] })).verdict).toBe('fail');
    expect(buildReport(input({ machines: [machine([{ id: 'c1', title: 'Install', status: 'pass' }], [])] })).verdict).toBe('fail');
  });

  test('one agent that asked is enough when the others were skipped', () => {
    expect(buildReport(input()).verdict).toBe('pass');
  });

  test('a run problem (for example a failed teardown) or no machine at all fails the run', () => {
    expect(buildReport(input({ errors: ['teardown failed: x'] })).verdict).toBe('fail');
    expect(buildReport(input({ machines: [] })).verdict).toBe('fail');
  });
});

describe('release-check harness commit', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const withCandidate = (sha: string | undefined, harnessCommit: string | undefined) => buildReport(input({
    candidate: { label: 'candidate', ...(sha ? { sha } : {}) },
    ...(harnessCommit ? { harnessCommit } : {}),
  }));

  test('the same commit is recorded in the JSON and shown on the page, and the run can pass', () => {
    const report = withCandidate(A, A);
    expect(report.harness).toEqual({ commit: A, candidateCommit: A, relation: 'same-commit' });
    expect(report.verdict).toBe('pass');
    expect(JSON.parse(JSON.stringify(report)).harness.relation).toBe('same-commit');
    expect(renderHtml(report)).toContain(`Harness commit ${A} · the same commit as the candidate`);
  });

  test('a harness from another commit than the candidate fails the run and says so', () => {
    const report = withCandidate(A, B);
    expect(report.harness.relation).toBe('different-commit');
    expect(report.verdict).toBe('fail');
    expect(report.errors.join(' ')).toContain('does not qualify that candidate');
    expect(renderHtml(report)).toContain("NOT the candidate&#39;s commit");
    // Rebuilding from the finished report records the problem once.
    expect(buildReport({ ...report }).errors).toEqual(report.errors);
  });

  test('a local artifact has no commit of its own: the harness commit is recorded and the page says the match is unconfirmed', () => {
    const report = withCandidate(undefined, B);
    expect(report.harness).toEqual({ commit: B, relation: 'candidate-commit-not-recorded' });
    expect(report.verdict).toBe('pass');
    expect(renderHtml(report)).toContain('not confirmed to match');
  });

  test('an unpinned run (no harness commit) is labeled as a development run', () => {
    const report = withCandidate(A, undefined);
    expect(report.harness.relation).toBe('unpinned');
    expect(renderHtml(report)).toContain('not release evidence');
  });
});

describe('release-check report page', () => {
  test('renders results, skip reasons, timings, screenshots and log links, with no script', () => {
    const html = renderHtml(buildReport(input({ machines: [machine([{ id: 'c1', title: 'Install works', status: 'pass', detail: 'build 1.0.0' }], [{ id: 'q', title: 'Fact stated', status: 'fail', detail: 'missing: 24 October' }])] })));
    expect(html).toContain('FAIL');
    expect(html).toContain('Install works');
    expect(html).toContain('missing: 24 October');
    expect(html).toContain('key missing');
    expect(html).toContain('provision 61.0 s');
    expect(html).toContain('href="screenshots/dashboard-390-light.png"');
    expect(html).toContain('href="logs/run.log"');
    expect(html).not.toContain('<script');
  });

  test('escapes text and keeps file links inside the report folder', () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
    const m = machine([{ id: 'c', title: '<img src=x onerror=alert(1)>', status: 'pass' }]);
    m.logs = [{ label: 'evil', path: '../../etc/passwd' }, { label: 'abs', path: '/etc/passwd' }];
    const html = renderHtml(buildReport(input({ machines: [m] })));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('href="../');
    expect(html).not.toContain('href="/etc');
  });

  test('a self-test run says so', () => {
    const html = renderHtml(buildReport(input({ selfTest: 'the private marker was stored in a Personal item on purpose' })));
    expect(html).toContain('Self-test: the private marker was stored in a Personal item on purpose');
  });
});

describe('release-check report scan', () => {
  const markers = forbiddenMarkers();

  test('a clean report has no findings', () => {
    expect(scanReport(buildReport(input()), markers)).toEqual([]);
  });

  test('a marker in any field of the JSON or the page is a finding that names the marker, not its text', () => {
    const leaky = buildReport(input({ machines: [machine([{ id: 'c1', title: 'x', status: 'pass', detail: `oops ${SECRET_MARKER}` }])] }));
    const findings = scanReport(leaky, markers);
    expect(findings.map((f) => `${f.label}:${f.markerId}`).sort()).toEqual(['report.html:secret-marker', 'report.json:secret-marker']);
    expect(JSON.stringify(findings)).not.toContain(SECRET_MARKER);
    const privateLeak = buildReport(input({ errors: [`note ${PRIVATE_MARKER}`] }));
    expect(scanReport(privateLeak, markers).some((f) => f.markerId === 'private-marker')).toBe(true);
  });
});
