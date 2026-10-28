/**
 * The Agents page on this computer (On this computer → Agents): remote access
 * (with Turn on and Turn off), "Connect an agent", and the agents already
 * connected.
 *
 * Written for the owner, not a developer (owner ruling, 2026-09-03): the owner
 * picks the agent they use and gets that agent's own steps, with every address
 * and snippet behind a copy button. The method follows the agent:
 *
 * - Through the Olympus relay (the default) ChatGPT, Claude and Grok connect:
 *   the relay registers only their pinned clients and routes no keys.
 *   Approval is one click on Olympus's page in this computer's browser, with
 *   no pairing code.
 * - Through a tunnel the owner runs (`remote.publicBaseUrl`), Claude, ChatGPT
 *   and Grok add Olympus as a connector and approve it on the Olympus approval
 *   page with a one-time pairing code minted right here; the Grok API takes
 *   an address plus a key, and Create key shows the key once. Under the
 *   relay the Grok API and other agents say they need such a tunnel, and show
 *   no steps that cannot work.
 * - Claude Code and Codex on this computer run `olympus serve` locally.
 *
 * Muse is not offered (owner decision, 2026-10-12): consumer Muse adds
 * connectors only from Meta's catalog, so it waits for an Olympus catalog
 * connector (docs/design/background-agents.md, build step 5).
 *
 * Pairing codes and keys never enter this markup. The controller puts them
 * into a read-only field after the control route answers, and clears it on
 * Done. The picker is a list of disclosures, so it needs no script of its own
 * and a poll keeps whichever agent the owner opened.
 */
import {
  LETS_ENCRYPT_REPOSITORY_URL,
  WORKER_ENV_ADDRESS_MESSAGE,
  type DashboardAgentConnection,
  type DashboardAgentsView,
  type DashboardRemoteAccess,
} from '../agent-connections.ts';
import { AGENT_INSTRUCTION_TEXT, AGENT_SKILL_PATH } from '../../core/agent-instructions.ts';
import { resolveServerMode } from '../../core/remote-open.ts';
import { escapeHtml, setupRow } from './components.ts';

export const AGENT_CONNECT_SHEET_ID = 'agent-connect';

type AgentMethod = 'oauth' | 'key' | 'local' | 'other';

interface AgentChoice {
  id: string;
  label: string;
  detail?: string;
  method: AgentMethod;
  /** Where the connector is added, in the vendor's own words, before the address. */
  add?: string;
  /** What happens after the address is saved, before the pairing code. */
  approve?: string;
  /** Key agents: the name the connection is created with (editable). */
  keyName?: string;
  /** Key agents: which address they take. */
  address?: 'mcp' | 'openapi';
  /** Key agents: how the key is given to the agent. */
  keyUse?: string;
  /** Where the when-to-ask instructions go for this agent. */
  instructionsWhere: string;
  /** Connects through the Olympus relay: ChatGPT, Claude and Grok only (connect-relay/server/client-registration.ts). */
  viaRelay?: true;
  /** Relay oauth agents: what happens after the address is saved; approval is one click, with no pairing code. */
  approveViaRelay?: string;
}

const AGENTS: readonly AgentChoice[] = [
  {
    id: 'claude',
    label: 'Claude',
    detail: 'web, desktop and phone',
    method: 'oauth',
    add: 'In Claude, open Customize, then Connectors. Choose +, then Add custom connector, name it Olympus, and paste this address as the URL:',
    approve: 'Choose Add, then Connect on the Olympus connector. An Olympus approval page opens, on your phone too.',
    approveViaRelay: 'Choose Add, then Connect on the Olympus connector. An Olympus page opens in this computer\'s browser asking to connect Claude to Olympus: choose Connect. Do this in Claude on this computer; the page opens only here. After that, Olympus works in Claude on your phone too.',
    instructionsWhere: 'Paste this into a Claude project\'s instructions.',
    viaRelay: true,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    method: 'oauth',
    add: 'In ChatGPT, open Plugins, choose +, then Add custom MCP server. Name it Olympus, choose OAuth, and paste this address as the URL (if you don\'t see Add custom MCP server, turn on Developer mode in Settings first):',
    approve: 'Choose Create. An Olympus approval page opens.',
    approveViaRelay: 'Choose Create. An Olympus page opens in this computer\'s browser asking to connect ChatGPT to Olympus: choose Connect. Do this in ChatGPT on this computer; the page opens only here.',
    instructionsWhere: 'Paste this into a ChatGPT project\'s instructions, or into your custom instructions.',
    viaRelay: true,
  },
  {
    id: 'grok',
    label: 'Grok',
    detail: 'grok.com',
    method: 'oauth',
    add: 'In Grok, go to grok.com/connectors, choose New Connector, then Custom, and paste this address as the MCP server URL:',
    approve: 'Continue to sign in. An Olympus approval page opens.',
    approveViaRelay: 'Continue to sign in. An Olympus page opens in this computer\'s browser asking to connect Grok to Olympus: choose Connect. Do this on grok.com on this computer; the page opens only here.',
    instructionsWhere: 'Paste this into Grok\'s custom instructions.',
    viaRelay: true,
  },
  {
    id: 'grok-api',
    label: 'Grok API',
    detail: 'xAI API and scripts',
    method: 'key',
    keyName: 'Grok API',
    address: 'mcp',
    add: 'Add Olympus as a remote MCP server with this address:',
    keyUse: 'Send the key as a bearer token: the header Authorization: Bearer followed by the key.',
    instructionsWhere: 'Put this in the system prompt of the requests that use Olympus.',
  },
  {
    id: 'local',
    label: 'Claude Code or Codex',
    detail: 'on this computer',
    method: 'local',
    instructionsWhere: 'Paste this into your CLAUDE.md or AGENTS.md, or copy the Olympus skill folder into ~/.claude/skills/ or ~/.codex/skills/.',
  },
  {
    id: 'other',
    label: 'Other',
    method: 'other',
    instructionsWhere: 'Paste this wherever the agent keeps its instructions.',
  },
];

const LOCAL_AGENT_PROMPT = [
  'Add Olympus to this coding agent as a local MCP server.',
  'First find the full path of the olympus command:',
  '- If `openclaw plugins inspect olympus --json` finds the plugin, it is `<plugin.rootDir>/bin/olympus`.',
  '- Otherwise Olympus was installed with its Mac installer, and it is `$HOME/.local/bin/olympus` with $HOME written out. Check that the file exists.',
  'Then run the one command for this tool:',
  '- Claude Code: `claude mcp add olympus -- <olympus path> serve`',
  '- Codex: `codex mcp add olympus -- <olympus path> serve`',
  'Do not change any other configuration. Afterwards, list the Olympus tools to confirm source_answer is there.',
].join('\n');

const CLAUDE_CODE_SNIPPET = 'claude mcp add olympus -- <olympus path> serve';
const CODEX_SNIPPET = [
  '[mcp_servers.olympus]',
  'command = "<olympus path>"',
  'args = ["serve"]',
].join('\n');

/** OPENER supplies text only after validating its owner-only socket route.
 * Undefined means no usable handoff; this callback never creates or approves one.
 */
export interface AgentConnectHost {
  platform?: NodeJS.Platform;
  headless?: boolean;
  approvalHandoff?: () => string | undefined;
}

export interface DashboardAgentsSectionInput extends AgentConnectHost {
  view: DashboardAgentsView;
  /** When the page was built, for "last used" wording. */
  now: Date;
}

export function renderDashboardAgentsSection(input: DashboardAgentsSectionInput): string {
  const { view } = input;
  const platform = input.platform ?? process.platform;
  const host = {
    ...input,
    platform,
    headless: input.headless ?? resolveServerMode({ env: process.env, platform }).remote,
  };

  return [
    '<div class="sect" id="agents">Agents</div>',
    remoteAccessRow(view.remoteAccess, view.remoteAccessManual),
    setupRow({
      label: 'Connect an agent',
      blurb: platform === 'linux'
        ? 'Let ChatGPT, Claude, Grok or a coding agent ask Olympus, under the same privacy rules on this computer.'
        : 'Let ChatGPT, Claude, Grok or a coding agent ask Olympus, under the same privacy rules as your OpenClaw agent.',
      action: { label: 'Connect an agent', kind: 'none', sheet: AGENT_CONNECT_SHEET_ID, primary: true },
    }),
    connectSheet(view.remoteAccess, host),
    // Its own region so the controller can re-read the list after a key,
    // Done or Revoke without replacing an open sheet or a shown key.
    `<div data-agent-connections-list>${connectionList(view, input.now)}</div>`,
  ].join('\n');
}

function remoteAccessRow(access: DashboardRemoteAccess, manual: string | undefined): string {
  const why = access.state === 'on'
    ? `On. Agents in the cloud reach Olympus at ${hostOf(access.mcpUrl)}.`
    : access.state === 'off'
      ? 'Off. Only agents on this computer can ask Olympus.'
      : access.state === 'not_connected'
        ? 'On, but not connected. Agents in the cloud cannot reach Olympus until it is.'
        : `Not set up correctly. ${access.detail}`;
  const next = access.state === 'not_connected' && access.detail
    ? `<span class="hint" data-remote-next-step> ${escapeHtml(access.detail)}</span>`
    : access.state === 'on' && access.setBy === 'worker_env'
      ? `<span class="hint" data-remote-set-by="worker_env"> ${escapeHtml(WORKER_ENV_ADDRESS_MESSAGE)}</span>`
      : '';
  // A host that cannot switch it from here says how instead, and offers no button (it could only be refused).
  const workerEnv = access.state === 'on' && access.setBy === 'worker_env';
  const how = manual !== undefined && !workerEnv ? `<span class="hint" data-remote-manual> ${escapeHtml(manual)}</span>` : '';
  return `<div class="attncard plain" data-remote-access="${access.state}">`
    + `<div class="grow"><span class="name">Remote access</span><span class="why"> — ${escapeHtml(why)}</span>${next}${how}</div>`
    + (manual === undefined ? remoteAccessControls(access) : '')
    + `</div>`
    + (access.state === 'off' || (access.state === 'not_connected' && access.needsTerms) ? termsPanel() : '');
}

/**
 * Turn on and Turn off remote access. Turning on shows Let's Encrypt's
 * subscriber agreement first (the terms panel below the row) and needs the
 * owner's explicit acceptance; the route says when that is needed.
 */
function remoteAccessControls(access: DashboardRemoteAccess): string {
  const status = `<span class="actmsg" data-action-message role="status"></span>`;
  // Set outside plugin config: a Turn off here would change nothing.
  if (access.state === 'on' && access.setBy === 'worker_env') return '';
  if (access.state === 'off') {
    return `<form class="rowform" data-agent-kind="remote-on">`
      + `<button class="btn primary" type="submit">Turn on remote access</button>${status}`
      + `</form>`;
  }
  const review = access.state === 'not_connected' && access.needsTerms
    ? `<form class="rowform" data-agent-kind="remote-on"><button class="btn primary" type="submit">Review agreement</button>${status}</form>`
    : '';
  const confirmation = 'Turn off remote access? Agents in the cloud will no longer reach Olympus until you turn it on again. Agents on this computer are unaffected.';
  return review
    + `<form class="rowform" data-agent-kind="remote-off" data-confirmation="${escapeHtml(confirmation)}">`
    + `<button class="btn" type="submit">Turn off remote access</button>${status}`
    + `</form>`;
}

/** Shown by the controller when the route asks for the agreement; its link is set to the agreement's own URL. */
function termsPanel(): string {
  return `<div class="remoteterms" data-remote-terms hidden>`
    + `<p><b>Before remote access turns on</b></p>`
    + `<p>So that agents in the cloud reach this computer over an encrypted connection only this computer can open, Olympus gets a free certificate from Let's Encrypt. Getting one means agreeing to Let's Encrypt's Subscriber Agreement.</p>`
    + `<p>In short: the certificate is only for this Olympus's own address; its private key never leaves this computer and must be kept secret; Let's Encrypt may revoke the certificate if the key is exposed or the certificate is misused; and the service comes without warranties. You don't sign up for anything or share an email address. This is a summary, not the agreement: read the agreement itself before you accept.</p>`
    + `<p><a data-remote-terms-link href="${LETS_ENCRYPT_REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">Read the Let's Encrypt Subscriber Agreement</a></p>`
    + `<form class="rowform" data-agent-kind="remote-accept">`
    + `<button class="btn primary" type="submit">I accept, turn on remote access</button>`
    + `<button class="btn" type="button" data-remote-terms-cancel>Not now</button>`
    + `<span class="actmsg" data-action-message role="status"></span>`
    + `</form>`
    + `</div>`;
}

function connectSheet(access: DashboardRemoteAccess, host: AgentConnectHost): string {
  // The Mac picker is frozen byte-for-byte. Linux also exposes the clients
  // already pinned by #296; no new registration or callback is admitted.
  const agents: readonly AgentChoice[] = host.platform === 'linux'
    ? [...AGENTS.map((agent): AgentChoice => agent.id === 'grok-api' ? { ...agent, viaRelay: true } : agent), ...(['grok-bot', 'cursor'] as const).map((id): AgentChoice => ({
      id, label: id === 'grok-bot' ? 'Grok Bot' : 'Cursor', method: 'oauth', viaRelay: true,
      add: 'Add Olympus as a custom remote MCP server, choose OAuth, and use this address:',
      approve: 'Start connecting. An Olympus approval page opens.',
      approveViaRelay: "An Olympus page opens in this computer's browser asking to connect Grok Bot or Cursor to Olympus: choose Connect. Olympus names this connection Grok Bot or Cursor because the apps share a sign-in.",
      instructionsWhere: "Paste this into the agent's instructions.",
    }))]
    : AGENTS;
  const choices = agents.map((agent) => agentChoice(agent, access, host)).join('');
  return `<div class="sheet" id="${AGENT_CONNECT_SHEET_ID}" aria-hidden="true">`
    + `<h4>Connect an agent</h4>`
    + `<p>Pick the agent you use. It never sees Private source text or Secrets. For Private items it receives only answers that Venice or a local model reasoned out, with each item's title, path, source and author.</p>`
    + `<div class="agentpick">${choices}</div>`
    + `</div>`;
}

function agentChoice(agent: AgentChoice, access: DashboardRemoteAccess, host: AgentConnectHost): string {
  const hints = [agent.detail, needsOwnTunnel(agent, access) ? 'needs your own tunnel' : undefined].filter(Boolean).join(' · ');
  const detail = hints ? ` <span class="hint">${escapeHtml(hints)}</span>` : '';
  return `<details class="agentchoice" data-poll-key="agent-${agent.id}" data-agent="${agent.id}">`
    + `<summary><span class="name">${escapeHtml(agent.label)}</span>${detail}</summary>`
    + `<div class="agentbody">${agentBody(agent, access, host)}</div>`
    + `</details>`;
}

/** Remote access runs through a tunnel the owner runs, not the Olympus relay. */
function ownTunnel(access: DashboardRemoteAccess): boolean {
  return access.state === 'on' && (access.ownTunnel === true || access.setBy === 'worker_env');
}

/** A cloud agent the relay cannot serve, while remote access is not through the owner's own tunnel. */
function needsOwnTunnel(agent: AgentChoice, access: DashboardRemoteAccess): boolean {
  return agent.method !== 'local' && !agent.viaRelay && !ownTunnel(access);
}

function agentBody(agent: AgentChoice, access: DashboardRemoteAccess, host: AgentConnectHost): string {
  if (agent.method === 'local') return localBody(agent, host);
  if (needsOwnTunnel(agent, access)) return tunnelNeeded(host) + instructionsStep(agent, false);
  if (access.state !== 'on') return remoteUnavailable(access) + instructionsStep(agent, false);
  if (agent.method === 'oauth' && !ownTunnel(access) && agent.approveViaRelay) {
    return `<ol class="steps">`
      + `<li>${escapeHtml(agent.add ?? '')}${copyBox(`agent-${agent.id}-url`, access.mcpUrl, 'Copy address')}</li>`
      + `<li>${approvalStep(agent, host)}</li>`
      + `<li>${instructionsStep(agent, true)}</li>`
      + `</ol>`;
  }
  if (agent.method === 'oauth') {
    return `<ol class="steps">`
      + `<li>${escapeHtml(agent.add ?? '')}${copyBox(`agent-${agent.id}-url`, access.mcpUrl, 'Copy address')}</li>`
      + `<li>${host.platform === 'linux' ? approvalStep(agent, host, true) : escapeHtml(agent.approve ?? '')}</li>`
      + `<li data-agent-step>On that page, type a pairing code from here.${pairForm(agent.id)}</li>`
      + `<li>${instructionsStep(agent, true)}</li>`
      + `</ol>`;
  }
  if (agent.method === 'key') {
    const url = agent.address === 'openapi' ? access.openapiUrl : access.mcpUrl;
    return `<ol class="steps">`
      + `<li>${escapeHtml(agent.add ?? '')}${copyBox(`agent-${agent.id}-url`, url, 'Copy address')}</li>`
      + `<li data-agent-step>Create a key for it. ${escapeHtml(agent.keyUse ?? '')}${keyForm(agent.id, agent.keyName ?? agent.label)}</li>`
      + `<li>${instructionsStep(agent, true)}</li>`
      + `</ol>`;
  }
  return `<p>If the agent can add a connector that signs in, use the connector address and a pairing code. If it takes an address and a key, create a key.</p>`
    + `<ol class="steps">`
    + `<li>Connector (MCP) address:${copyBox('agent-other-url', access.mcpUrl, 'Copy address')}`
    + `OpenAPI address, for agents that read an API description:${copyBox('agent-other-openapi', access.openapiUrl, 'Copy address')}</li>`
    + (host.platform === 'linux' ? `<li>${approvalStep(agent, host, true)}</li>` : '')
    + `<li data-agent-step>Approve a connector with a pairing code.${pairForm(agent.id)}</li>`
    + `<li data-agent-step>Or create a key and give it to the agent as a bearer token.${keyForm(agent.id, 'Agent')}</li>`
    + `<li>${instructionsStep(agent, true)}</li>`
    + `</ol>`;
}

function approvalStep(agent: AgentChoice, host: AgentConnectHost, pairing = false): string {
  if (host.platform !== 'linux') return escapeHtml(agent.approveViaRelay ?? '');
  if (!host.headless) return pairing
    ? "Open the Olympus approval page in this computer's browser, through the owner's approval route."
    : escapeHtml(agent.approveViaRelay ?? '');
  const handoff = host.approvalHandoff?.();
  if (!handoff) return 'Approval on this computer is not ready. Configure the owner-only SSH socket forward on the Olympus host, then return here.';
  return 'Before connecting, run the owner-only SSH socket forward on your own computer and keep it running. '
    + copyBox(`agent-${agent.id}-handoff`, handoff, 'Copy approval handoff')
    + 'Start the connection in the agent on that computer. Open the approval page in its browser through the forward. '
    + (pairing ? 'Approve with the pairing code from here.' : 'Choose Connect.')
    + ' Olympus continues running on this computer.';
}

function localBody(agent: AgentChoice, host: AgentConnectHost): string {
  const linux = host.platform === 'linux';
  const prompt = linux ? LOCAL_AGENT_PROMPT.replace('Mac installer', 'Linux installer') : LOCAL_AGENT_PROMPT;
  return `<p>These run on this computer, so they work without remote access. Paste this into Claude Code or Codex and it adds Olympus for you:</p>`
    + copyBox('agent-local-prompt', prompt, 'Copy prompt', true)
    + `<details class="agentprompt" data-poll-key="agent-local-manual"><summary>Add it yourself instead</summary>`
    + `<p>The olympus path is the full path of the olympus command. On ${linux ? 'Linux set up with the Olympus Linux installer' : 'a Mac set up with the Olympus installer'} it is <b>~/.local/bin/olympus</b>, written out from your home folder. With OpenClaw it is <b>bin/olympus</b> inside the <b>rootDir</b> that <b>openclaw plugins inspect olympus --json</b> prints. For Claude Code, run:</p>`
    + copyBox('agent-local-claude', CLAUDE_CODE_SNIPPET, 'Copy command')
    + `<p>For Codex, add this to ~/.codex/config.toml:</p>`
    + copyBox('agent-local-codex', CODEX_SNIPPET, 'Copy snippet')
    + `</details>`
    + instructionsStep(agent, false);
}

/** For agents the relay cannot serve. Remote access may be on (through the relay), off, or not connected. */
function tunnelNeeded(host: AgentConnectHost): string {
  const text = (host.platform === 'linux'
    ? 'Olympus\'s relay connects ChatGPT, Claude, Grok, Grok Bot and Cursor, so this agent needs a tunnel you run yourself. '
    : 'Olympus\'s relay connects only ChatGPT, Claude and Grok, so this agent needs a tunnel you run yourself. ')
    + 'Advanced: set remote.publicBaseUrl in Olympus\'s settings to your tunnel\'s https address and turn on remote access; this agent\'s steps then appear here. '
    + 'Claude Code and Codex on this computer need no tunnel.';
  return `<p class="why" data-agent-needs-tunnel>${escapeHtml(text)}</p>`;
}

function remoteUnavailable(access: DashboardRemoteAccess): string {
  const text = access.state === 'not_connected'
    ? 'Remote access is on but not connected, so this agent cannot reach Olympus right now. The Remote access line above says why.'
    : access.state === 'invalid'
      ? `Remote access is not set up correctly, so this agent cannot reach Olympus yet. ${access.detail}`
      : 'This agent runs in the cloud, and remote access is off, so it cannot reach Olympus on this computer yet. Turn on remote access above first. Claude Code and Codex on this computer work now.';
  return `<p class="why" data-remote-unavailable>${escapeHtml(text)}</p>`;
}

/** The when-to-ask text, for pasting. `inStep` renders it as a numbered step's content. */
function instructionsStep(agent: AgentChoice, inStep: boolean): string {
  const lead = inStep
    ? `Tell it when to ask Olympus. ${agent.instructionsWhere}`
    : `To have it ask Olympus on its own, ${agent.instructionsWhere.charAt(0).toLowerCase()}${agent.instructionsWhere.slice(1)}`;
  const body = `${escapeHtml(lead)}${copyBox(`agent-${agent.id}-instructions`, AGENT_INSTRUCTION_TEXT, 'Copy instructions', true)}`;
  const skill = agent.id === 'claude' || agent.id === 'local'
    ? `<span class="hint">The Olympus skill is the folder ${escapeHtml(AGENT_SKILL_PATH.replace(/\/SKILL\.md$/, ''))} inside the plugin folder.</span>`
    : '';
  return inStep ? `${body}${skill}` : `<p>${body}</p>${skill}`;
}

function copyBox(id: string, text: string, label: string, primary = false): string {
  // Sentences wrap between words; addresses and snippets may break anywhere.
  const prose = text.includes(' ') && !text.startsWith('http') ? ' prose' : '';
  return `<div class="promptbox${prose}" id="${id}">${escapeHtml(text)}</div>`
    + `<button class="btn${primary ? ' primary' : ''}" type="button" data-copy-target="#${id}">${escapeHtml(label)}</button>`
    + `<span class="copystatus" data-copy-status aria-live="polite"></span>`;
}

function pairForm(agentId: string): string {
  return `<form class="rowform" data-agent-kind="pair">`
    + `<button class="btn primary" type="submit">Get pairing code</button>`
    + `<span class="actmsg" data-action-message role="status"></span>`
    + `</form>`
    + secretSlot(`agent-${agentId}-code`, 'Pairing code');
}

function keyForm(agentId: string, name: string): string {
  return `<form class="rowform" data-agent-kind="key">`
    + `<input class="keyfield" type="text" name="name" value="${escapeHtml(name)}" required maxlength="64" aria-label="Connection name" autocomplete="off">`
    + `<button class="btn primary" type="submit">Create key</button>`
    + `<span class="actmsg" data-action-message role="status"></span>`
    + `</form>`
    + secretSlot(`agent-${agentId}-key`, 'Key');
}

/** Filled by the controller after the control route answers; empty in markup. */
function secretSlot(id: string, label: string): string {
  return `<div class="agentsecret" data-agent-secret-slot hidden>`
    + `<input class="keyfield" id="${id}" data-agent-secret type="text" readonly autocomplete="off" spellcheck="false" aria-label="${escapeHtml(label)}">`
    + `<button class="btn primary" type="button" data-copy-target="#${id}">Copy</button>`
    + `<button class="btn" type="button" data-agent-secret-done>Done</button>`
    + `<span class="copystatus" data-copy-status aria-live="polite"></span>`
    + `<span class="hint" data-agent-secret-note></span>`
    + `</div>`;
}

function connectionList(view: DashboardAgentsView, now: Date): string {
  if (view.unavailable) {
    return `<div class="foot" data-agent-connections="unavailable">Olympus could not read its list of connected agents. Reload this page to try again.</div>`;
  }
  if (view.connections.length === 0) {
    return `<div class="foot" data-agent-connections="none">No agents are connected yet.</div>`;
  }
  const rows = view.connections.map((connection) => connectionRow(connection, now)).join('\n');
  return `<div class="sect">Connected agents — ${view.connections.length}</div>\n${rows}`;
}

function connectionRow(connection: DashboardAgentConnection, now: Date): string {
  const used = connection.lastUsedAt ? `last used ${relativeDay(connection.lastUsedAt, now)}` : 'not used yet';
  const why = `added ${calendarDate(connection.createdAt)} · ${used}`;
  const confirmation = `Revoke ${connection.name}? It will no longer be able to ask Olympus. You can connect it again later.`;
  return `<div class="attncard plain" data-agent-connection="${escapeHtml(connection.id)}">`
    + `<div class="grow"><span class="name">${escapeHtml(connection.name)}</span><span class="why"> — ${escapeHtml(why)}</span></div>`
    + `<form class="rowform" data-agent-kind="revoke" data-confirmation="${escapeHtml(confirmation)}">`
    + `<input type="hidden" name="connection_id" value="${escapeHtml(connection.id)}">`
    + `<button class="btn" type="submit">Revoke</button>`
    + `<span class="actmsg" data-action-message role="status"></span>`
    + `</form>`
    + `</div>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function calendarDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'on an unknown date';
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function relativeDay(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'at an unknown time';
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 60) return 'within the hour';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return `on ${calendarDate(iso)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
