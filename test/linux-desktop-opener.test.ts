import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EXPECTED_MIME_TYPES,
  isActiveLinuxScope,
  linuxGraphicalSessionReadiness,
  linuxGraphicalSessionReadinessAsync,
  openLinuxDesktopPath,
  type LinuxCommandResult,
  type LinuxDesktopOpenerDependencies,
  type LinuxGraphicalSession,
  type LinuxPathInspection,
} from '../src/core/linux-desktop-opener.ts';
import { OPENABLE_EXTENSIONS } from '../src/workers/dropbox-files/open-target.ts';

const READY: LinuxGraphicalSession = {
  ready: true,
  kind: 'wayland',
  environment: {
    PATH: '/usr/bin:/bin',
    HOME: '/home/owner',
    XDG_RUNTIME_DIR: '/run/user/1000',
    WAYLAND_DISPLAY: 'wayland-1',
    XDG_CURRENT_DESKTOP: 'Hyprland',
  },
  displaySocket: '/run/user/1000/wayland-1',
};

const OK = (stdout = ''): LinuxCommandResult => ({ status: 0, stdout, stderr: '' });
const STARTED = { established: true, stderr: 'Running scope as unit: olympus-open-test.scope\n' } as const;
const TRUSTED = (): boolean => true;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(name: string, content = 'fixture'): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-linux-opener-'));
  temporary.push(root);
  const folder = join(root, 'sources');
  mkdirSync(folder);
  const path = join(folder, name);
  writeFileSync(path, content);
  return { root, path };
}

function dependencies(overrides: LinuxDesktopOpenerDependencies = {}): LinuxDesktopOpenerDependencies {
  return {
    trustExecutable: TRUSTED,
    readiness: () => READY,
    run: async (argv) => OK(argv[0]?.endsWith('xdg-mime') ? 'application/pdf\n' : 'application/pdf\n'),
    launch: async () => STARTED,
    scopeUnit: () => 'olympus-open-test',
    ...overrides,
  };
}

describe('live Linux graphical-session readiness', () => {
  const info = (kind: LinuxPathInspection['kind'], mode: number, uid = 1000): LinuxPathInspection => ({ kind, mode, uid, symbolicLink: false });

  test('uses the user manager environment when the engine itself has no display', () => {
    const calls: string[][] = [];
    const readiness = linuxGraphicalSessionReadiness({
      uid: 1000,
      trustExecutable: TRUSTED,
      runSync: (argv) => {
        calls.push([...argv]);
        return argv.includes('is-active') ? OK('active\n') : OK([
          'HOME=/home/owner',
          'XDG_RUNTIME_DIR=/run/user/1000',
          'WAYLAND_DISPLAY=wayland-1',
          'XDG_CURRENT_DESKTOP=Hyprland',
          'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
          'LD_PRELOAD=/tmp/hostile.so',
        ].join('\n'));
      },
      inspectPath: (path) => path.endsWith('wayland-1') ? info('socket', 0o600) : info('directory', 0o700),
      realpath: (path) => path,
    });
    expect(readiness).toMatchObject({ ready: true, kind: 'wayland', displaySocket: '/run/user/1000/wayland-1' });
    if (!readiness.ready) throw new Error('expected readiness');
    expect(readiness.environment).toMatchObject({ XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'Hyprland' });
    expect(readiness.environment.LD_PRELOAD).toBeUndefined();
    expect(calls).toEqual([
      ['/usr/bin/systemctl', '--user', 'is-active', 'graphical-session.target'],
      ['/usr/bin/systemctl', '--user', 'show-environment'],
    ]);
  });

  test('inactive graphical target and a stale display socket refuse readiness', () => {
    expect(linuxGraphicalSessionReadiness({
      uid: 1000, trustExecutable: TRUSTED, runSync: () => ({ status: 3, stdout: 'inactive\n', stderr: '' }),
    })).toEqual({ ready: false, reason: 'inactive_graphical_session' });
    expect(linuxGraphicalSessionReadiness({
      uid: 1000,
      trustExecutable: TRUSTED,
      runSync: (argv) => argv.includes('is-active') ? OK('active\n') : OK('XDG_RUNTIME_DIR=/run/user/1000\nDISPLAY=:0\nXDG_CURRENT_DESKTOP=GNOME\n'),
      inspectPath: (path) => path === '/run/user/1000' ? info('directory', 0o700) : undefined,
      realpath: (path) => path,
    })).toEqual({ ready: false, reason: 'stale_display' });
  });

  test('an X11 display owned by another local UID is not the owner session', () => {
    const probe = (socketUid: number) => linuxGraphicalSessionReadiness({
      uid: 1000, trustExecutable: TRUSTED,
      runSync: argv => argv.includes('is-active') ? OK('active\n') : OK('XDG_RUNTIME_DIR=/run/user/1000\nDISPLAY=:0\nXDG_CURRENT_DESKTOP=GNOME\n'),
      inspectPath: path => path === '/run/user/1000' ? info('directory', 0o700) : info('socket', 0o600, socketUid),
      realpath: path => path,
    });
    expect(probe(1001)).toEqual({ ready: false, reason: 'stale_display' });
    expect(probe(1000).ready).toBe(true);
    expect(probe(0).ready).toBe(true);
  });

  test('an active socket without a qualified GNOME or Hyprland resolver refuses readiness', () => {
    expect(linuxGraphicalSessionReadiness({
      uid: 1000,
      trustExecutable: TRUSTED,
      runSync: (argv) => argv.includes('is-active') ? OK('active\n') : OK('XDG_RUNTIME_DIR=/run/user/1000\nWAYLAND_DISPLAY=wayland-1\nXDG_CURRENT_DESKTOP=KDE\n'),
      inspectPath: (path) => path.endsWith('wayland-1') ? info('socket', 0o600) : info('directory', 0o700),
      realpath: (path) => path,
    })).toEqual({ ready: false, reason: 'unsupported_desktop' });
  });
});

describe('the Linux desktop source opener', () => {
  test('qualifies only an active exact systemd scope with a nonempty cgroup', () => {
    const unit = 'olympus-open-1234-abcdef';
    const exact = `ActiveState=active\nControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}.scope\n`;
    expect(isActiveLinuxScope(exact, unit)).toBe(true);
    expect(isActiveLinuxScope(exact.replace('ActiveState=active', 'ActiveState=failed'), unit)).toBe(false);
    expect(isActiveLinuxScope('ActiveState=active\nControlGroup=\n', unit)).toBe(false);
    expect(isActiveLinuxScope(exact.replace(`${unit}.scope`, `${unit}-other.scope`), unit)).toBe(false);
  });

  test('has an explicit MIME contract for every shared openable extension', () => {
    expect([...OPENABLE_EXTENSIONS].filter((extension) => !EXPECTED_MIME_TYPES[extension])).toEqual([]);
  });

  test('opens an agreed PDF in a separate user scope with one literal absolute path argument', async () => {
    const source = fixture('report $(touch nope).pdf', '%PDF-1.7');
    const launched: string[][] = [];
    const result = await openLinuxDesktopPath({
      path: source.path,
      roots: [source.root],
      revalidateEligibility: () => true,
      dependencies: dependencies({
        launch: async (argv) => { launched.push([...argv]); return STARTED; },
      }),
    });
    expect(result).toEqual({ opened: 'file', path: source.path, mimeType: 'application/pdf' });
    expect(launched).toEqual([[
      '/usr/bin/systemd-run', '--user', '--scope', '--unit=olympus-open-test', '--', '/usr/bin/xdg-open', source.path,
    ]]);
  });

  test('HTML disguised as a PDF opens only its validated parent folder', async () => {
    const source = fixture('invoice.pdf', '<html><script>location="bad"</script></html>');
    const launched: string[][] = [];
    const result = await openLinuxDesktopPath({
      path: source.path,
      roots: [source.root],
      revalidateEligibility: () => true,
      dependencies: dependencies({
        run: async (argv) => OK(argv[0]?.endsWith('xdg-mime') ? 'application/pdf\n' : 'text/html\n'),
        launch: async (argv) => { launched.push([...argv]); return STARTED; },
      }),
    });
    expect(result).toEqual({ opened: 'folder', path: dirname(source.path), fallback: 'mime_mismatch' });
    expect(launched[0]?.at(-1)).toBe(dirname(source.path));
    expect(launched[0]).not.toContain(source.path);
  });

  test('failed MIME probing and unsupported extensions open only the folder', async () => {
    const pdf = fixture('unknown.pdf');
    const script = fixture('run.desktop', '[Desktop Entry]\nExec=bad');
    const calls: string[][] = [];
    const probeFailed = await openLinuxDesktopPath({
      path: pdf.path, roots: [pdf.root], revalidateEligibility: () => true,
      dependencies: dependencies({ run: async () => ({ status: 1, stdout: '', stderr: 'no resolver' }) }),
    });
    const unsupported = await openLinuxDesktopPath({
      path: script.path, roots: [script.root], revalidateEligibility: () => true,
      dependencies: dependencies({
        run: async (argv) => { calls.push([...argv]); return OK(); },
      }),
    });
    expect(probeFailed).toEqual({ opened: 'folder', path: dirname(pdf.path), fallback: 'mime_probe_failed' });
    expect(unsupported).toEqual({ opened: 'folder', path: dirname(script.path), fallback: 'unsupported_extension' });
    expect(calls).toEqual([]);
  });

  test('rejects traversal and control-character paths before invoking a command', async () => {
    const source = fixture('report.pdf');
    let commands = 0;
    for (const path of [`${source.root}/sources/../sources/report.pdf`, `${source.path}\n--unit=evil`]) {
      await expect(openLinuxDesktopPath({
        path, roots: [source.root], revalidateEligibility: () => true,
        dependencies: dependencies({ run: async () => { commands += 1; return OK('application/pdf'); } }),
      })).rejects.toMatchObject({ code: 'invalid_target' });
    }
    expect(commands).toBe(0);
  });

  test('refuses a symlink swap during MIME probing', async () => {
    const source = fixture('report.pdf');
    const replacement = join(source.root, 'replacement.pdf');
    writeFileSync(replacement, '%PDF replacement');
    let probes = 0;
    await expect(openLinuxDesktopPath({
      path: source.path, roots: [source.root], revalidateEligibility: () => true,
      dependencies: dependencies({
        run: async () => {
          probes += 1;
          if (probes === 1) {
            renameSync(source.path, join(source.root, 'original.pdf'));
            symlinkSync(replacement, source.path);
          }
          return OK('application/pdf');
        },
      }),
    })).rejects.toMatchObject({ code: 'target_changed' });
  });

  test('refuses same-path file replacement during MIME probing', async () => {
    const source = fixture('report.pdf');
    await expect(openLinuxDesktopPath({
      path: source.path, roots: [source.root], revalidateEligibility: () => true,
      dependencies: dependencies({
        run: async () => {
          renameSync(source.path, join(source.root, 'old.pdf'));
          writeFileSync(source.path, '%PDF replacement');
          return OK('application/pdf');
        },
      }),
    })).rejects.toMatchObject({ code: 'target_changed' });
  });

  test('rechecks eligibility immediately before dispatch', async () => {
    const source = fixture('report.pdf');
    const decisions = [true, false];
    let launched = false;
    await expect(openLinuxDesktopPath({
      path: source.path,
      roots: [source.root],
      revalidateEligibility: () => decisions.shift() ?? false,
      dependencies: dependencies({ launch: async () => { launched = true; return STARTED; } }),
    })).rejects.toMatchObject({ code: 'eligibility_revoked' });
    expect(launched).toBe(false);
  });

  test('refuses dispatch when live readiness is absent', async () => {
    const source = fixture('report.pdf');
    await expect(openLinuxDesktopPath({
      path: source.path, roots: [source.root], revalidateEligibility: () => true,
      dependencies: dependencies({ readiness: () => ({ ready: false, reason: 'stale_display' }) }),
    })).rejects.toMatchObject({ code: 'desktop_unavailable' });
  });

  test('does not call a spawned systemd-run process a success without its scope receipt', async () => {
    const source = fixture('report.pdf');
    await expect(openLinuxDesktopPath({
      path: source.path, roots: [source.root], revalidateEligibility: () => true,
      dependencies: dependencies({ launch: async () => ({ established: false, stderr: '' }) }),
    })).rejects.toMatchObject({ code: 'dispatch_failed' });
  });

  test('refuses when logout invalidates the graphical session during an awaited check', async () => {
    const source = fixture('report.pdf');
    let readinessChecks = 0;
    let launched = false;
    await expect(openLinuxDesktopPath({
      path: source.path, roots: [source.root], revalidateEligibility: async () => true,
      dependencies: dependencies({
        readiness: () => ++readinessChecks === 1 ? READY : { ready: false, reason: 'inactive_graphical_session' },
        launch: async () => { launched = true; return STARTED; },
      }),
    })).rejects.toMatchObject({ code: 'desktop_unavailable' });
    expect(launched).toBe(false);
  });
});


test('bridge readiness uses bounded async probes and refuses an inactive session without a second probe', async () => {
  let count = 0;
  const result = await linuxGraphicalSessionReadinessAsync({ trustExecutable: () => true,
    runSync: () => { throw new Error('bridge readiness must not block the worker'); },
    run: async (argv, options) => { count++; expect(options.timeoutMs).toBe(3000); expect(argv).toContain('is-active'); return { status: 3, stdout: 'inactive', stderr: '' }; } });
  expect(count).toBe(1); expect(result).toEqual({ ready: false, reason: 'inactive_graphical_session' });
});

test('bridge readiness reads a real manager environment larger than 4 KiB (stock Omarchy is about 6 KiB)', async () => {
  if (process.platform !== 'linux') return;
  const root = mkdtempSync(join(tmpdir(), 'olympus-manager-env-'));
  try {
    const runtime = join(root, 'runtime');
    mkdirSync(runtime, { mode: 0o700 });
    const padding = Array.from({ length: 80 }, (_, i) => `PAD_${i}=${'x'.repeat(90)}`).join('\n');
    const systemctl = join(root, 'systemctl');
    writeFileSync(systemctl, `#!/bin/sh\ncase "$*" in\n*is-active*) echo active ;;\n*show-environment*) cat <<'ENV'\nXDG_CURRENT_DESKTOP=Hyprland\nXDG_RUNTIME_DIR=${runtime}\n${padding}\nENV\n;;\nesac\n`, { mode: 0o700 });
    const result = await linuxGraphicalSessionReadinessAsync({ trustExecutable: TRUSTED, executables: { systemctl } });
    // Parsed past the manager environment; this fixture has no display socket.
    expect(result).toMatchObject({ ready: false, reason: 'stale_display' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
