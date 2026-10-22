/**
 * `olympus engine install-helper`: put the signed Olympus engine host app in
 * place (see native/macos-engine-host and docs/design/local-files.md, "Mac
 * permissions"). With it installed, macOS names "Olympus" when the engine
 * asks to read Desktop, Documents, Downloads, iCloud Drive or a removable or
 * network volume, and the person's choice sticks across Olympus updates.
 *
 * The app comes from a prebuilt, signed bundle (`from`), or is built from a
 * source checkout with the signing identity named in
 * OLYMPUS_MACOS_SIGNING_IDENTITY (or `identity`). The identity is never
 * stored. The installed bundle is checked before it replaces anything: a
 * Developer ID signature that verifies, the right bundle id, and an
 * executable where the engine plist expects it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ENGINE_HELPER_APP_NAME,
  ENGINE_HELPER_BUNDLE_ID,
  ENGINE_HELPER_EXECUTABLE,
  enginePaths,
  type EngineExec,
  type EngineExecResult,
} from './engine-service.ts';
import { OperationError } from './operation-error.ts';
import { olympusPackageRoot } from './package-root.ts';

export const MACOS_SIGNING_IDENTITY_ENV = 'OLYMPUS_MACOS_SIGNING_IDENTITY';
/** Optional: refuse a helper app signed by any other team. Never committed as a literal. */
export const MACOS_HELPER_TEAM_ENV = 'OLYMPUS_MACOS_HELPER_TEAM_ID';

export interface EngineHelperInstallOptions {
  homeDir?: string;
  platform?: string;
  env?: Record<string, string | undefined>;
  /** A built and signed app to install instead of building one. */
  from?: string;
  /** Signing identity for a build; defaults to OLYMPUS_MACOS_SIGNING_IDENTITY. */
  identity?: string;
  /** Refuse an app whose team id differs; defaults to OLYMPUS_MACOS_HELPER_TEAM_ID when set. */
  expectedTeamId?: string;
  exec?: EngineExec;
  /** Test seam for the rename steps of the swap. */
  rename?: (from: string, to: string) => void;
  /** Where the checkout's scripts live; defaults to the Olympus package root. */
  packageRoot?: string;
}

export interface EngineHelperInstallResult {
  ok: true;
  app_path: string;
  executable_path: string;
  bundle_id: string;
  team_id: string | null;
  signed_with: 'developer_id' | 'ad_hoc';
  built: boolean;
  replaced: boolean;
}

function run(exec: EngineExec | undefined, command: string, args: string[], env?: Record<string, string | undefined>): EngineExecResult {
  if (exec) return exec(command, args);
  const result = spawnSync(command, args, { encoding: 'utf8', ...(env ? { env: env as NodeJS.ProcessEnv } : {}) });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** What `codesign -dvv` says about a bundle: its identifier, team and whether it is Developer ID signed. */
export function parseCodesignDetails(text: string): { identifier: string | null; teamId: string | null; developerId: boolean; adHoc: boolean; hardened: boolean } {
  const identifier = /^Identifier=(.+)$/m.exec(text)?.[1] ?? null;
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1] ?? null;
  return {
    identifier,
    teamId: team && team !== 'not set' ? team : null,
    developerId: /^Authority=Developer ID Application:/m.test(text),
    adHoc: /^Signature=adhoc$/m.test(text) || /flags=0x\w+\(adhoc/.test(text),
    hardened: /flags=0x[0-9a-f]+\([^)]*runtime/.test(text),
  };
}

export function installEngineHelper(options: EngineHelperInstallOptions = {}): EngineHelperInstallResult {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new OperationError('invalid_params', 'The Olympus helper app is for macOS. Linux does not need one.');
  }
  const env = options.env ?? process.env;
  const homeDir = resolve(options.homeDir ?? homedir());
  const paths = enginePaths(homeDir);
  const target = paths.helperAppPath!;
  mkdirSync(paths.appSupportDir, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(paths.appSupportDir, '.helper-'));
  try {
    let built = false;
    let candidate: string;
    if (options.from !== undefined) {
      candidate = resolve(options.from);
      if (!existsSync(join(candidate, 'Contents', 'Info.plist'))) {
        throw new OperationError('invalid_params', `${candidate} is not an app bundle.`);
      }
    } else {
      const identity = options.identity ?? env[MACOS_SIGNING_IDENTITY_ENV];
      if (!identity) {
        throw new OperationError(
          'config_error',
          'Building the Olympus helper app needs a Developer ID signing identity.',
          `Set ${MACOS_SIGNING_IDENTITY_ENV}, pass --identity, or pass --from <signed app> to install one that is already built.`,
        );
      }
      const root = options.packageRoot ?? olympusPackageRoot();
      const script = join(root, 'scripts', 'build-macos-helper.sh');
      if (!existsSync(script) || !existsSync(join(root, 'native', 'macos-engine-host', 'main.c'))) {
        throw new OperationError('config_error', 'This install does not include the helper app source.', 'Pass --from <signed app>, or build from an Olympus source checkout.');
      }
      // The identity travels in the environment so it is not in the process list.
      const result = run(options.exec, script, ['--out', staging], { ...process.env, ...env, [MACOS_SIGNING_IDENTITY_ENV]: identity });
      if (result.status !== 0) {
        throw new OperationError('config_error', `Building the Olympus helper app failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
      }
      candidate = join(staging, ENGINE_HELPER_APP_NAME);
      built = true;
    }

    const verify = run(options.exec, '/usr/bin/codesign', ['--verify', '--strict', '--deep', candidate]);
    if (verify.status !== 0) {
      throw new OperationError('config_error', `The helper app's signature does not verify: ${verify.stderr.trim().split('\n')[0] ?? ''}`);
    }
    const details = parseCodesignDetails(run(options.exec, '/usr/bin/codesign', ['-dvv', candidate]).stderr);
    if (details.identifier !== ENGINE_HELPER_BUNDLE_ID) {
      throw new OperationError('config_error', `The helper app is signed as ${details.identifier ?? 'nothing'}, not ${ENGINE_HELPER_BUNDLE_ID}.`);
    }
    if (!details.developerId) {
      throw new OperationError(
        'config_error',
        'The helper app is not signed with a Developer ID. macOS forgets folder permissions for an app that is not, every time it changes.',
        `Sign it with ${MACOS_SIGNING_IDENTITY_ENV}.`,
      );
    }
    if (!details.hardened) {
      throw new OperationError('config_error', 'The helper app is not signed with the hardened runtime.', 'Sign it with --options runtime (scripts/build-macos-helper.sh does).');
    }
    const expectedTeam = options.expectedTeamId ?? env[MACOS_HELPER_TEAM_ENV];
    if (expectedTeam && details.teamId !== expectedTeam) {
      throw new OperationError('config_error', `The helper app is signed by team ${details.teamId ?? 'none'}, not the expected team.`);
    }
    const executable = join(candidate, 'Contents', 'MacOS', ENGINE_HELPER_EXECUTABLE);
    if (!existsSync(executable)) {
      throw new OperationError('config_error', `The helper app has no ${ENGINE_HELPER_EXECUTABLE} program.`);
    }

    const replaced = existsSync(target);
    if (replaced && lstatSync(target).isSymbolicLink()) {
      throw new OperationError('config_error', `${target} is a link; remove it and run this again.`);
    }
    // ditto keeps the signature intact; the swap is a rename so a running
    // engine never sees half an app.
    const copy = join(staging, 'copy.app');
    const ditto = run(options.exec, '/usr/bin/ditto', [candidate, copy]);
    if (ditto.status !== 0) throw new OperationError('config_error', `Could not copy the helper app: ${ditto.stderr.trim()}`);
    const copyCheck = run(options.exec, '/usr/bin/codesign', ['--verify', '--strict', '--deep', copy]);
    if (copyCheck.status !== 0) {
      throw new OperationError('config_error', `The copied helper app's signature does not verify: ${copyCheck.stderr.trim().split('\n')[0] ?? ''}`);
    }
    // Move the old app aside, move the new one in, and put the old one back
    // if that fails; the old app is deleted only once the new one is in place.
    const rename = options.rename ?? renameSync;
    const aside = join(staging, 'previous.app');
    if (replaced) rename(target, aside);
    try {
      rename(copy, target);
    } catch (error) {
      if (replaced) rename(aside, target);
      throw new OperationError('config_error', `Could not put the helper app in place: ${error instanceof Error ? error.message : String(error)}${replaced ? ' The previous helper app was kept.' : ''}`);
    }
    return {
      ok: true,
      app_path: target,
      executable_path: paths.helperExecutablePath!,
      bundle_id: ENGINE_HELPER_BUNDLE_ID,
      team_id: details.teamId,
      signed_with: 'developer_id',
      built,
      replaced,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
