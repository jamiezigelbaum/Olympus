import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const CLOUD_SCRIPT = join(import.meta.dir, '..', 'config', 'systemd', 'user', 'olympus-cloud-fresh.sh');

describe('cloud freshness product behavior', () => {
  test('generated cloud script has each retained corpus exactly once and no legacy X branch', () => {
    const cloudScript = readFileSync(CLOUD_SCRIPT, 'utf8');
    expect(cloudScript.match(/internal\.drive\.docs/g)).toHaveLength(1);
    expect(cloudScript.match(/internal\.readwise\.library/g)).toHaveLength(1);
    expect(cloudScript).not.toContain('internal.x.bookmarks');
    expect(cloudScript).not.toContain('OLYMPUS_CLOUD_FRESHNESS_INCLUDE_LEGACY_X');
    expect(cloudScript).not.toContain('OLYMPUS_WORKER_SCHEDULER_ENABLED');
    expect(cloudScript).toContain('WORKER_BASE_URL="http://127.0.0.1:8010/v1"');
    expect(cloudScript).not.toContain('OLYMPUS_CLOUD_FRESHNESS_WORKER_BASE_URL');
    expect(cloudScript).toContain('assert_private_regular_file "$AUTH_HEADER_FILE"');
  });

  test('never executes the removed legacy X owner, even when an obsolete env value is injected', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-cloud-owner-execution-'));
    const bin = join(root, 'bin');
    const capture = join(root, 'requests.txt');
    const authHeader = join(root, 'worker-header');
    mkdirSync(bin);
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
payload=""
while (( \$# > 0 )); do
  if [[ "\$1" == "--data" ]]; then
    shift
    payload="\$1"
  fi
  shift
done
printf '%s\\n' "\$payload" >> '${capture}'
printf '%s\\n' '{"status":"completed"}'
`);
    writeFileSync(join(bin, 'stat'), '#!/usr/bin/env bash\necho 600\n');
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'stat'), 0o755);
    writeFileSync(authHeader, 'Authorization: Bearer worker-token\n', { mode: 0o600 });
    const baseEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      OLYMPUS_CLOUD_FRESHNESS_CURL_BIN: join(bin, 'curl'),
      OLYMPUS_CLOUD_FRESHNESS_LOG_PATH: join(root, 'cloud.log'),
      OLYMPUS_CLOUD_FRESHNESS_RETRY_DELAY_SECONDS: '1',
      OLYMPUS_WORKER_AUTH_HEADER_FILE: authHeader,
    };

    const phaseOne = Bun.spawnSync(['/bin/bash', CLOUD_SCRIPT], {
      env: { ...baseEnv, OLYMPUS_CLOUD_FRESHNESS_INCLUDE_LEGACY_X: 'true' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(phaseOne.exitCode).toBe(0);
    const phaseOneRequests = readFileSync(capture, 'utf8').trim().split('\n');
    expect(phaseOneRequests).toHaveLength(2);
    expect(phaseOneRequests.some((line) => line.includes('internal.x.bookmarks'))).toBe(false);

    writeFileSync(capture, '');
    const phaseTwo = Bun.spawnSync(['/bin/bash', CLOUD_SCRIPT], {
      env: { ...baseEnv, OLYMPUS_CLOUD_FRESHNESS_INCLUDE_LEGACY_X: 'false' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(phaseTwo.exitCode).toBe(0);
    const phaseTwoRequests = readFileSync(capture, 'utf8').trim().split('\n');
    expect(phaseTwoRequests).toHaveLength(2);
    expect(phaseTwoRequests.some((line) => line.includes('internal.x.bookmarks'))).toBe(false);
    expect(phaseTwoRequests.filter((line) => line.includes('internal.drive.docs'))).toHaveLength(1);
    // The host script sends canonical corpus ids: it must not depend on the
    // documented alias shim, even though that shim is supported (and covered
    // by test/source-index-sync-corpus-alias.test.ts).
    expect(phaseTwoRequests.filter((line) => line.includes('internal.readwise.library'))).toHaveLength(1);
  }, 30_000);

  test('accepts canonical scheduler handoff and bounds the HTTP wait', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-cloud-scheduler-handoff-'));
    const bin = join(root, 'bin');
    const capture = join(root, 'timeouts.txt');
    const authHeader = join(root, 'worker-header');
    const logPath = join(root, 'cloud.log');
    mkdirSync(bin);
    writeFileSync(authHeader, 'Authorization: Bearer test-only\n', { mode: 0o600 });
    writeFileSync(join(bin, 'stat'), '#!/usr/bin/env bash\necho 600\n');
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
payload=""
timeout=""
while (( \$# > 0 )); do
  case "\$1" in
    --data) shift; payload="\$1" ;;
    --max-time) shift; timeout="\$1" ;;
  esac
  shift
done
corpus_id="\$(printf '%s' "\$payload" | sed -E 's/.*"corpus_id":"([^"]+)".*/\\1/')"
printf '{"kind":"source_scheduler_status","sources":[{"corpus_id":"%s","tasks":[{"running":true,"consecutive_failures":0}]}],"policy":{"counts_only":true}}\\n' "\$corpus_id"
printf '%s\\n' "\$timeout" >> '${capture}'
`);
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'stat'), 0o755);

    const result = Bun.spawnSync(['/bin/bash', CLOUD_SCRIPT], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OLYMPUS_CLOUD_FRESHNESS_CURL_BIN: join(bin, 'curl'),
        OLYMPUS_CLOUD_FRESHNESS_CURL_TIMEOUT_SECONDS: '17',
        OLYMPUS_CLOUD_FRESHNESS_LOG_PATH: logPath,
        OLYMPUS_CLOUD_FRESHNESS_RETRY_DELAY_SECONDS: '0',
        OLYMPUS_WORKER_AUTH_HEADER_FILE: authHeader,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(capture, 'utf8')).toBe('17\n17\n');
    expect(existsSync(logPath)).toBe(false);
  }, 30_000);

  test('rejects a scheduler response that does not prove the requested corpus', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-cloud-scheduler-mismatch-'));
    const bin = join(root, 'bin');
    const authHeader = join(root, 'worker-header');
    const logPath = join(root, 'cloud.log');
    mkdirSync(bin);
    writeFileSync(authHeader, 'Authorization: Bearer test-only\n', { mode: 0o600 });
    writeFileSync(join(bin, 'stat'), '#!/usr/bin/env bash\necho 600\n');
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
printf '%s\\n' '{"kind":"source_scheduler_status","sources":[{"corpus_id":"internal.other"}],"policy":{"counts_only":true}}'
`);
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'stat'), 0o755);

    const result = Bun.spawnSync(['/bin/bash', CLOUD_SCRIPT], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OLYMPUS_CLOUD_FRESHNESS_CURL_BIN: join(bin, 'curl'),
        OLYMPUS_CLOUD_FRESHNESS_LOG_PATH: logPath,
        OLYMPUS_CLOUD_FRESHNESS_RETRY_DELAY_SECONDS: '0',
        OLYMPUS_WORKER_AUTH_HEADER_FILE: authHeader,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(logPath, 'utf8')).toContain('internal.drive.docs failed after 3 tries (last=err)');
    expect(readFileSync(logPath, 'utf8')).toContain('internal.readwise.library failed after 3 tries (last=err)');
  }, 30_000);

  test('rejects unsafe worker authorization material before any request', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-cloud-auth-boundary-'));
    const bin = join(root, 'bin');
    const realHeader = join(root, 'worker-header');
    const linkedHeader = join(root, 'linked-worker-header');
    const capture = join(root, 'curl-ran');
    mkdirSync(bin);
    writeFileSync(realHeader, 'Authorization: Bearer worker-token\n', { mode: 0o600 });
    symlinkSync(realHeader, linkedHeader);
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\ntouch '${capture}'\n`);
    chmodSync(join(bin, 'curl'), 0o755);
    const result = Bun.spawnSync(['/bin/bash', CLOUD_SCRIPT], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OLYMPUS_CLOUD_FRESHNESS_CURL_BIN: join(bin, 'curl'),
        OLYMPUS_WORKER_AUTH_HEADER_FILE: linkedHeader,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain('regular non-symlink');
    expect(existsSync(capture)).toBe(false);

    chmodSync(realHeader, 0o640);
    const groupReadable = Bun.spawnSync(['/bin/bash', CLOUD_SCRIPT], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OLYMPUS_CLOUD_FRESHNESS_CURL_BIN: join(bin, 'curl'),
        OLYMPUS_WORKER_AUTH_HEADER_FILE: realHeader,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(groupReadable.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(groupReadable.stderr)).toContain('group or other');
    expect(existsSync(capture)).toBe(false);
  }, 30_000);
});
