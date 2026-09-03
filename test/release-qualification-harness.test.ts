import { describe, expect, test } from 'bun:test';
import { parseReleaseQualificationAttempt, summarizeReleaseQualification } from '../src/core/release-qualification.ts';

const base = {
  kind: 'olympus_release_qualification_attempt', schema_version: 1, source_id: 'all',
  host_os: 'linux_x64_ubuntu_lts', host_surface: 'openclaw', execution_kind: 'simulated', check: 'install',
  artifact_sha256: 'a'.repeat(64), artifact_bytes: 602_000,
  started_at: '2026-08-30T18:00:00.000Z', ended_at: '2026-08-30T18:01:00.000Z',
  start_state: 'clean_home', end_state: 'installed', assistance: 'documented_flow', result: 'passed',
  assertions_total: 4, assertions_passed: 4,
} as const;
const realCustody = {
  recorder: 'real_provider_runner_v1', execution_session_id: 'b'.repeat(32), custody_hmac_sha256: 'c'.repeat(64),
} as const;

describe('Slice 3F release qualification receipts', () => {
  test('accepts a complete simulated cell without counting a real provider', () => {
    const attempt = parseReleaseQualificationAttempt(base);
    expect(summarizeReleaseQualification([attempt])).toMatchObject({ attempts: 1, eligible_passes: 1, real_provider_passes: 0, simulated_passes: 1 });
  });
  test('rejects content-bearing timestamps and extension fields', () => {
    expect(() => parseReleaseQualificationAttempt({ ...base, started_at: 'Sun, 30 Aug 2026 18:00:00 GMT (private)' })).toThrow('canonical UTC');
    expect(() => parseReleaseQualificationAttempt({ ...base, source_text: 'private' })).toThrow('Unknown receipt fields');
  });
  test('binds result, state, assistance, assertions, and execution semantics', () => {
    expect(() => parseReleaseQualificationAttempt({ ...base, end_state: 'failed' })).toThrow('must end in installed');
    expect(() => parseReleaseQualificationAttempt({ ...base, assistance: 'engineering_intervention' })).toThrow('cannot produce a passing');
    expect(() => parseReleaseQualificationAttempt({ ...base, assertions_passed: 3 })).toThrow('all assertions');
    expect(() => parseReleaseQualificationAttempt({ ...base, execution_kind: 'real_provider' })).toThrow('real-provider or pilot');
  });
  test('counts an eligible real-provider receipt without making the independent-review conclusion', () => {
    const real = parseReleaseQualificationAttempt({ ...base, ...realCustody, source_id: 'gmail.email', execution_kind: 'real_provider', check: 'real_provider_end_to_end', host_os: 'darwin_arm64', end_state: 'answer_ready', assistance: 'documented_recovery', assertions_total: 10, assertions_passed: 10 });
    expect(summarizeReleaseQualification([real])).toMatchObject({ real_provider_passes: 1, eligible_passes: 1 });
  });
  test('requires one artifact identity, unique cells, and an explicit rollback baseline', () => {
    const first = parseReleaseQualificationAttempt(base);
    expect(() => summarizeReleaseQualification([first, first])).toThrow('duplicate cells');
    const different = parseReleaseQualificationAttempt({ ...base, host_os: 'darwin_arm64', artifact_sha256: 'b'.repeat(64) });
    expect(() => summarizeReleaseQualification([first, different])).toThrow('mix artifact identities');
    expect(() => parseReleaseQualificationAttempt({ ...base, check: 'rollback', start_state: 'installed_previous', end_state: 'rolled_back', assertions_total: 5, assertions_passed: 5 })).toThrow('explicit previous artifact');
  });
  test('separates operating system from the Hermes host surface', () => {
    expect(() => parseReleaseQualificationAttempt({ ...base, host_surface: 'hermes', host_os: 'darwin_arm64' })).toThrow('Linux x86_64');
    const hermes = parseReleaseQualificationAttempt({ ...base, ...realCustody, source_id: 'gmail.email', host_surface: 'hermes', execution_kind: 'real_provider', check: 'hermes_end_to_end', end_state: 'answer_ready', assertions_total: 8, assertions_passed: 8 });
    expect(hermes.host_surface).toBe('hermes');
  });
  test('requires runner custody and content-free pilot identity while documentary inputs cannot count', () => {
    expect(() => parseReleaseQualificationAttempt({ ...base, source_id: 'gmail.email', execution_kind: 'real_provider', check: 'pilot_task', end_state: 'answer_ready', assertions_total: 7, assertions_passed: 7 })).toThrow('runner custody');
    expect(() => parseReleaseQualificationAttempt({ ...base, ...realCustody, source_id: 'gmail.email', execution_kind: 'real_provider', check: 'pilot_task', end_state: 'answer_ready', assertions_total: 7, assertions_passed: 7 })).toThrow('pilot_attempt_id');
    const pilot = parseReleaseQualificationAttempt({ ...base, ...realCustody, source_id: 'gmail.email', execution_kind: 'real_provider', check: 'pilot_task', end_state: 'answer_ready', assertions_total: 7, assertions_passed: 7, pilot_attempt_id: 'c'.repeat(32), reuse_intent: 'yes' });
    expect(summarizeReleaseQualification([pilot])).toMatchObject({ pilot_attempts: 1, pilot_wants_reuse: 1, eligible_passes: 1 });
    expect(() => parseReleaseQualificationAttempt({ ...base, source_id: 'gmail.email', execution_kind: 'documentary_evidence' })).toThrow('execution_kind is unsupported');
  });
});
