/**
 * `olympus_open_remote {target}`: the agent route for remote mode (owner
 * decision, 2026-10-10; docs/design/remote-access.md).
 *
 * Olympus runs on a server; the owner's assistant (OpenClaw) can run commands
 * on the owner's computer through a paired node (`exec host=node`). This tool
 * hands the assistant exactly what it needs to open one Olympus screen in that
 * computer's browser, already unlocked: a one-time opening link, the engine's
 * port, where the link lands, and the exact tunnel and open commands.
 *
 * The link is a bearer ticket (single use, 15 minutes, the same control
 * session `olympus dashboard` grants), so:
 * - only the owner's own agent session gets one: the native tool factory sets
 *   `ownerAgentSession` from OpenClaw's `senderIsOwner`, and nothing else can
 *   (it is never read from tool params; no other surface exposes this tool);
 * - only a place from the closed list (core/open-targets.ts) can be named, so
 *   a prompt-injected call can at most open one of those screens, and the
 *   node still asks the owner before the tunnel starts;
 * - every refusal happens BEFORE the ticket is minted, and the mint is the
 *   last step; nothing here logs the link or puts it in an error.
 */
import { mintDashboardOpeningUrl, workerRootBaseUrl, type DashboardFetch } from './dashboard-opening.ts';
import { DASHBOARD_LAUNCH_TICKET_TTL_SECONDS } from './dashboard-launch.ts';
import type { OlympusConfig } from './config.ts';
import { allOpenTargets, isKeysOpenTarget, openTargetFromPath, openTargetPath } from './open-targets.ts';
import { OperationError } from './operation-error.ts';
import {
  REMOTE_TUNNEL_SECONDS,
  SSH_TARGET_PLACEHOLDER,
  isOpeningLinkForCommandLine,
  isValidPort,
  remoteOpenInstructions,
  remoteOpenNodeCommands,
  resolveServerMode,
} from './remote-open.ts';
import { readWorkerSetupEnv, workerAuthTokenProvider } from './worker-auth.ts';

export const OPEN_REMOTE_TOOL_NAME = 'olympus_open_remote';

export const OPEN_REMOTE_PARAMS = {
  target: {
    type: 'string' as const,
    required: true,
    enum: allOpenTargets().map(openTargetPath),
    description: 'Where Olympus opens: dashboard, connect/<x|readwise|telegram|whatsapp>, or fix/<connect|reconnect|answers|search|models>.',
  },
};

export const OPEN_REMOTE_DESCRIPTION = [
  'Open Olympus on the owner\'s own computer when Olympus runs on a server (for example when they say "open Olympus on my computer", or to connect X, Readwise, Telegram or WhatsApp).',
  'Returns a one-time link (single use, 15 minutes), the engine port and two commands per platform.',
  'Run them on the owner\'s computer with exec host=node, in order: first the tunnel (it asks the owner to approve it), then open. Do not run them anywhere else, do not show or repeat the link, and do not call this unless the owner asked.',
  'If ssh_target is null, replace you@your-server with the user@host the computer uses to reach this server (ask the owner).',
  'If there is no node that can run commands, give the owner the by_hand lines instead.',
].join(' ');

export interface OpenRemoteContext {
  config: OlympusConfig;
  /** Set only by the OpenClaw tool factory, from the host's own `senderIsOwner`. */
  ownerAgentSession?: boolean;
}

export interface OpenRemoteDeps {
  env?: Record<string, string | undefined>;
  /** worker.env, read fresh (the server-mode declaration lives there). */
  fileEnv?: () => Record<string, string | undefined> | undefined;
  platform?: string;
  fetchImpl?: DashboardFetch;
  /** The worker bearer; production reads it the way every native call does. */
  token?: () => string | undefined;
}

export async function openRemote(
  ctx: OpenRemoteContext,
  params: Record<string, unknown>,
  deps: OpenRemoteDeps = {},
): Promise<Record<string, unknown>> {
  if (ctx.ownerAgentSession !== true) {
    throw new OperationError(
      'invalid_request',
      'Only the owner\'s own assistant can open Olympus on their computer.',
      'Ask from your own chat with your assistant.',
    );
  }
  const extra = Object.keys(params).filter((key) => key !== 'target');
  if (extra.length > 0) {
    throw new OperationError('invalid_request', `Open remote takes only "target"; remove ${extra.map((key) => `"${key}"`).join(', ')}.`);
  }
  const target = openTargetFromPath(params.target);
  if (!target) {
    throw new OperationError('invalid_params', `target must be one of: ${allOpenTargets().map(openTargetPath).join(', ')}.`);
  }
  const env = deps.env ?? process.env;
  const mode = resolveServerMode({
    env,
    fileEnv: deps.fileEnv ? deps.fileEnv() : readWorkerSetupEnv({ env }),
    ...(deps.platform ? { platform: deps.platform } : {}),
  });
  if (!mode.remote) {
    throw new OperationError(
      'config_error',
      'Olympus runs on a computer with a screen, not on a server, so there is nothing to open remotely.',
      'Open it on that computer with olympus dashboard. If Olympus does run on a server, run olympus server-mode on.',
    );
  }
  const base = workerRootBaseUrl(ctx.config.email.baseUrl);
  const baseUrl = new URL(base);
  const port = Number(baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80));
  if (baseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(baseUrl.hostname) || !isValidPort(port)) {
    // The tunnel reaches the server's loopback, and the ticket is bound to the
    // origin it was minted for: only a loopback engine address works.
    throw new OperationError(
      'config_error',
      'The Olympus engine is not on this server\'s own loopback address, so a tunnel cannot reach it.',
      'Set OLYMPUS_EMAIL_BASE_URL to http://127.0.0.1:<port>/v1.',
    );
  }
  const token = (deps.token ?? workerAuthTokenProvider(ctx.config))();
  // Minted last: every refusal above leaves no ticket behind.
  const link = await mintDashboardOpeningUrl(base, token, { target, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  if (!isOpeningLinkForCommandLine(link)) {
    throw new OperationError('email_error', 'The Olympus engine returned an opening link in an unexpected shape.', 'Update Olympus, then try again.');
  }
  const sshTarget = mode.sshTarget ?? null;
  const byHand = remoteOpenInstructions({ port, ...(mode.sshTarget ? { sshTarget: mode.sshTarget } : {}), target });
  return {
    ok: true,
    target: openTargetPath(target),
    lands_on: isKeysOpenTarget(target) ? '/dashboard?keys' : '/dashboard',
    link,
    link_single_use: true,
    link_expires_in_seconds: DASHBOARD_LAUNCH_TICKET_TTL_SECONDS,
    engine_port: port,
    ssh_target: sshTarget,
    node_commands: remoteOpenNodeCommands({ port, sshTarget: sshTarget ?? SSH_TARGET_PLACEHOLDER, link }),
    tunnel_closes_after_seconds: REMOTE_TUNNEL_SECONDS,
    steps: [
      'Run node_commands.<platform>.tunnel on the owner\'s computer with exec host=node (on Windows as a background exec). The owner approves it once.',
      `It must listen on port ${port}, the engine's own number: the link only works there. If ssh says the port is in use, something on the computer already uses ${port}; ask the owner to close it.`,
      'Then run node_commands.<platform>.open. Olympus opens in the computer\'s browser, unlocked. The owner does the typing there (keys, sign-ins).',
      'Tell the owner it is open. Do not repeat the link.',
    ],
    by_hand: byHand,
  };
}
