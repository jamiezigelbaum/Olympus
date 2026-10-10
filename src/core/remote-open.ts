/**
 * Remote mode: Olympus runs on a server, and the screens that only work on the
 * computer running Olympus (keys, X sign-in, Telegram and WhatsApp pairing)
 * have to open in a browser on the owner's OWN computer, through an SSH
 * tunnel to the engine's port. docs/design/remote-access.md holds the design
 * and the threat model.
 *
 * Pure and dependency-free apart from the closed target list: the worker (the
 * panel's remote-mode state), the agent tool (core/remote-open-tool.ts), the
 * CLI and the olympusplugin.ai /open/ pages read the same words and commands.
 *
 * The one fact everything here rests on (test/remote-open.test.ts proves it
 * through a real forwarded port): the opening ticket and the control cookie
 * are bound to the dashboard's ORIGIN, port included
 * (core/dashboard-launch.ts, workers/http.ts). The server mints the link for
 * `http://127.0.0.1:<port>`, so the tunnel's end on the computer must listen
 * on that SAME port number; a link opened on any other port is refused as
 * "no longer valid".
 */
import { openTargetPath, type OpenTarget } from './open-targets.ts';

/**
 * The engine's declaration that it runs on a server (owner decision,
 * 2026-10-10: the engine declares remote mode; the panel does not infer it).
 * `on` / `off` are set by the owner or the install guide (`olympus server-mode`);
 * `auto` (the default) decides from the host: a Linux or other Unix host with
 * no desktop session (neither DISPLAY nor WAYLAND_DISPLAY) is a server; macOS
 * and Windows are computers someone sits at.
 */
export const SERVER_MODE_ENV = 'OLYMPUS_SERVER_MODE';
/** How the owner's computer reaches this server over SSH (`user@host`), when known. */
export const SERVER_SSH_TARGET_ENV = 'OLYMPUS_SERVER_SSH_TARGET';
/**
 * `off` when the owner's assistant cannot open Olympus on their computer even
 * though OpenClaw runs the engine (a Hermes install: OpenClaw hosts the
 * engine, Hermes is the assistant and has no node). The panel then offers
 * only the by-hand lines.
 */
export const SERVER_AGENT_ROUTE_ENV = 'OLYMPUS_SERVER_AGENT_ROUTE';

export type ServerModeSetting = 'on' | 'off' | 'auto';
export const SERVER_MODE_SETTINGS: readonly ServerModeSetting[] = ['on', 'off', 'auto'];

export interface ServerMode {
  /** True: the engine runs on a server; the panel shows the remote-mode instructions. */
  remote: boolean;
  setting: ServerModeSetting;
  /** Why `remote` is what it is. */
  basis: 'declared' | 'no_desktop_session' | 'desktop_session' | 'desktop_platform';
  /** `user@host` the owner's computer uses to reach this server, when set and well-formed. */
  sshTarget?: string;
  /** False only when the owner turned the assistant route off (SERVER_AGENT_ROUTE_ENV=off). */
  agentRoute: boolean;
}

export function parseServerModeSetting(value: unknown): ServerModeSetting | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (SERVER_MODE_SETTINGS as readonly string[]).includes(normalized) ? normalized as ServerModeSetting : undefined;
}

/**
 * Resolve the declaration.
 *
 * `fileEnv` (worker.env, read fresh) outranks the process environment for
 * these two keys, so `olympus server-mode on` takes effect on the next
 * dashboard read without a restart; the worker copied worker.env into its
 * own environment when it started, which would otherwise pin the old value.
 */
export function resolveServerMode(input: {
  env: Record<string, string | undefined>;
  fileEnv?: Record<string, string | undefined> | undefined;
  platform?: string;
}): ServerMode {
  const setting = parseServerModeSetting(input.fileEnv?.[SERVER_MODE_ENV])
    ?? parseServerModeSetting(input.env[SERVER_MODE_ENV])
    ?? 'auto';
  const rawTarget = input.fileEnv?.[SERVER_SSH_TARGET_ENV] ?? input.env[SERVER_SSH_TARGET_ENV];
  const sshTarget = isValidSshTarget(rawTarget) ? rawTarget.trim() : undefined;
  const agentRoute = (input.fileEnv?.[SERVER_AGENT_ROUTE_ENV] ?? input.env[SERVER_AGENT_ROUTE_ENV])?.trim().toLowerCase() !== 'off';
  const withTarget = (mode: Omit<ServerMode, 'sshTarget' | 'agentRoute'>): ServerMode => (sshTarget ? { ...mode, sshTarget, agentRoute } : { ...mode, agentRoute });
  if (setting === 'on') return withTarget({ remote: true, setting, basis: 'declared' });
  if (setting === 'off') return withTarget({ remote: false, setting, basis: 'declared' });
  const platform = input.platform ?? process.platform;
  if (platform === 'darwin' || platform === 'win32') return withTarget({ remote: false, setting, basis: 'desktop_platform' });
  if (input.env.DISPLAY?.trim() || input.env.WAYLAND_DISPLAY?.trim()) {
    return withTarget({ remote: false, setting, basis: 'desktop_session' });
  }
  return withTarget({ remote: true, setting, basis: 'no_desktop_session' });
}

/**
 * `user@host`, `host`, or an ssh_config alias: letters, digits, `.`, `_`, `-`,
 * starting with a letter or digit, so it can never be read as an ssh option
 * and never carries a space, quote or shell character into a command line.
 */
export function isValidSshTarget(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length <= 255
    && /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,190}$/.test(trimmed);
}

/** What the instructions say when the server's SSH name is not known. */
export const SSH_TARGET_PLACEHOLDER = 'you@your-server';
/** The engine's default port (core/config.ts), for the static /open/ pages, which cannot know the real one. */
export const DEFAULT_ENGINE_PORT = 8010;

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export interface RemoteOpenInstructions {
  /** On the owner's computer: the tunnel, on the SAME port number as the engine. */
  onComputer: string;
  /** On the server: prints the one-time link (it lands on `target`). */
  onServer: string;
}

/**
 * The two lines for doing it by hand (Hermes, the Mac app without a CLI node,
 * a browser-only user): a tunnel from the computer, then a fresh link from
 * the server, opened in the computer's browser.
 */
export function remoteOpenInstructions(input: { port: number; sshTarget?: string; target?: OpenTarget }): RemoteOpenInstructions {
  const port = isValidPort(input.port) ? input.port : DEFAULT_ENGINE_PORT;
  const sshTarget = isValidSshTarget(input.sshTarget) ? input.sshTarget.trim() : SSH_TARGET_PLACEHOLDER;
  const path = input.target ? openTargetPath(input.target) : 'dashboard';
  return {
    onComputer: `ssh -N -L ${port}:127.0.0.1:${port} ${sshTarget}`,
    onServer: `olympus dashboard --no-open${path === 'dashboard' ? '' : ` --target ${path}`}`,
  };
}

/** How long the agent's tunnel stays up when nothing is using it (the link itself lasts 15 minutes). */
export const REMOTE_TUNNEL_SECONDS = 1800;

/** A minted opening link: loopback, a 43-character ticket, at most one target token. Nothing else is ever put on a command line. */
const OPENING_LINK_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/dashboard\/launch#olympus_launch_ticket=[A-Za-z0-9_-]{43}(?:&olympus_open=[a-z]+\.[a-z]+)?$/;

export function isOpeningLinkForCommandLine(value: unknown): value is string {
  return typeof value === 'string' && OPENING_LINK_PATTERN.test(value);
}

export interface RemoteOpenNodeCommands {
  /**
   * Starts the tunnel. It listens on 127.0.0.1 only, on the engine's own port
   * number, fails at once if that port is taken (ExitOnForwardFailure), and
   * closes itself: the server side runs `sleep`, and ssh exits once that ends
   * and the browser's connections close.
   */
  tunnel: string;
  /** Opens the link in the computer's default browser. */
  open: string;
  /** Run `tunnel` as a background exec (Windows' ssh cannot fork itself with -f). */
  tunnelInBackground: boolean;
}

export type RemoteOpenPlatform = 'macos' | 'linux' | 'windows';

/**
 * The exact commands the agent runs on the owner's computer (`exec host=node`),
 * per platform. Every value interpolated here is validated: the port is an
 * integer, the SSH target matches isValidSshTarget, and the link matches the
 * minted shape, so nothing reaches a shell that was not built here.
 */
export function remoteOpenNodeCommands(input: { port: number; sshTarget: string; link: string }): Record<RemoteOpenPlatform, RemoteOpenNodeCommands> {
  if (!isValidPort(input.port)) throw new Error('remote open: invalid port');
  if (!isValidSshTarget(input.sshTarget)) throw new Error('remote open: invalid ssh target');
  if (!isOpeningLinkForCommandLine(input.link)) throw new Error('remote open: invalid link');
  const port = input.port;
  const target = input.sshTarget.trim();
  const forward = `-o ExitOnForwardFailure=yes -L 127.0.0.1:${port}:127.0.0.1:${port} ${target} sleep ${REMOTE_TUNNEL_SECONDS}`;
  return {
    macos: { tunnel: `ssh -f ${forward}`, open: `open '${input.link}'`, tunnelInBackground: false },
    linux: { tunnel: `ssh -f ${forward}`, open: `xdg-open '${input.link}'`, tunnelInBackground: false },
    windows: { tunnel: `ssh ${forward}`, open: `cmd /c start "" "${input.link}"`, tunnelInBackground: true },
  };
}
