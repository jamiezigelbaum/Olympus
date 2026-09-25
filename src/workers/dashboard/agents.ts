/**
 * Setup's Agents section: remote access (with Turn on and Turn off),
 * "Connect an agent", and the agents already connected.
 *
 * Written for the owner, not a developer (owner ruling, 2026-09-03): the owner
 * picks the agent they use and gets that agent's own steps, with every address
 * and snippet behind a copy button. The method follows the agent:
 *
 * - Claude, ChatGPT and Grok add Olympus as a connector and approve it on the
 *   Olympus approval page with a one-time pairing code minted right here.
 * - Muse and the Grok API take an address plus a key; Create key shows the key
 *   once.
 * - Claude Code and Codex on this computer run `olympus serve` locally.
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
}

const AGENTS: readonly AgentChoice[] = [
  {
    id: 'claude',
    label: 'Claude',
    detail: 'web, desktop and phone',
    method: 'oauth',
    add: 'In Claude, open Customize, then Connectors. Choose +, then Add custom connector, name it Olympus, and paste this address as the URL:',
    approve: 'Choose Add, then Connect on the Olympus connector. An Olympus approval page opens, on your phone too.',
    instructionsWhere: 'Paste this into a Claude project\'s instructions.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    method: 'oauth',
    add: 'In ChatGPT, open Settings, then Apps, and turn on Developer mode under Advanced settings. Then create a connector, name it Olympus, choose OAuth, and paste this address as the URL:',
    approve: 'Choose Create. An Olympus approval page opens.',
    instructionsWhere: 'Paste this into a ChatGPT project\'s instructions, or into your custom instructions.',
  },
  {
    id: 'grok',
    label: 'Grok or Grok Bot',
    method: 'oauth',
    add: 'In Grok, go to grok.com/connectors, choose New Connector, then Custom, and paste this address as the MCP server URL:',
    approve: 'Continue to sign in. An Olympus approval page opens.',
    instructionsWhere: 'Paste this into your Grok Bot\'s skills or into Grok\'s custom instructions.',
  },
  {
    id: 'muse',
    label: 'Muse',
    method: 'key',
    keyName: 'Muse',
    address: 'openapi',
    add: 'In Muse, ask it to create a custom connector for Olympus, and give it this OpenAPI address:',
    keyUse: 'When Muse asks for credentials, give it the key as a bearer token.',
    instructionsWhere: 'Paste this into Muse\'s instructions for the Olympus connector.',
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
  'Find the installed plugin with `openclaw plugins inspect olympus --json` and take `plugin.rootDir`.',
  'Then run the one command for this tool:',
  '- Claude Code: `claude mcp add olympus -- <rootDir>/bin/olympus serve`',
  '- Codex: `codex mcp add olympus -- <rootDir>/bin/olympus serve`',
  'Do not change any other configuration. Afterwards, list the Olympus tools to confirm source_answer is there.',
].join('\n');

const CLAUDE_CODE_SNIPPET = 'claude mcp add olympus -- <plugin folder>/bin/olympus serve';
const CODEX_SNIPPET = [
  '[mcp_servers.olympus]',
  'command = "<plugin folder>/bin/olympus"',
  'args = ["serve"]',
].join('\n');

export interface DashboardAgentsSectionInput {
  view: DashboardAgentsView;
  /** When the page was built, for "last used" wording. */
  now: Date;
}

export function renderDashboardAgentsSection(input: DashboardAgentsSectionInput): string {
  const { view } = input;
  return [
    '<div class="sect" id="agents">Agents</div>',
    remoteAccessRow(view.remoteAccess),
    setupRow({
      label: 'Connect an agent',
      blurb: 'Let Claude, ChatGPT, Grok, Muse or a coding agent ask Olympus, under the same privacy rules as your OpenClaw agent.',
      action: { label: 'Connect an agent', kind: 'none', sheet: AGENT_CONNECT_SHEET_ID, primary: true },
    }),
    connectSheet(view.remoteAccess),
    // Its own region so the controller can re-read the list after a key,
    // Done or Revoke without replacing an open sheet or a shown key.
    `<div data-agent-connections-list>${connectionList(view, input.now)}</div>`,
  ].join('\n');
}

function remoteAccessRow(access: DashboardRemoteAccess): string {
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
  return `<div class="attncard plain" data-remote-access="${access.state}">`
    + `<div class="grow"><span class="name">Remote access</span><span class="why"> — ${escapeHtml(why)}</span>${next}</div>`
    + remoteAccessControls(access)
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
    + `<button class="btn quiet" type="submit">Turn off remote access</button>${status}`
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
    + `<button class="btn quiet" type="button" data-remote-terms-cancel>Not now</button>`
    + `<span class="actmsg" data-action-message role="status"></span>`
    + `</form>`
    + `</div>`;
}

function connectSheet(access: DashboardRemoteAccess): string {
  const choices = AGENTS.map((agent) => agentChoice(agent, access)).join('');
  return `<div class="sheet" id="${AGENT_CONNECT_SHEET_ID}" aria-hidden="true">`
    + `<h4>Connect an agent</h4>`
    + `<p>Pick the agent you use. It never sees Private source text or Secrets. For Private items it receives only answers that Venice or a local model reasoned out, with each item's title, path, source and author.</p>`
    + `<div class="agentpick">${choices}</div>`
    + `</div>`;
}

function agentChoice(agent: AgentChoice, access: DashboardRemoteAccess): string {
  const detail = agent.detail ? ` <span class="hint">${escapeHtml(agent.detail)}</span>` : '';
  return `<details class="agentchoice" data-poll-key="agent-${agent.id}" data-agent="${agent.id}">`
    + `<summary><span class="name">${escapeHtml(agent.label)}</span>${detail}</summary>`
    + `<div class="agentbody">${agentBody(agent, access)}</div>`
    + `</details>`;
}

function agentBody(agent: AgentChoice, access: DashboardRemoteAccess): string {
  if (agent.method === 'local') return localBody(agent);
  if (access.state !== 'on') return remoteUnavailable(access) + instructionsStep(agent, false);
  if (agent.method === 'oauth') {
    return `<ol class="steps">`
      + `<li>${escapeHtml(agent.add ?? '')}${copyBox(`agent-${agent.id}-url`, access.mcpUrl, 'Copy address')}</li>`
      + `<li>${escapeHtml(agent.approve ?? '')}</li>`
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
    + `<li data-agent-step>Approve a connector with a pairing code.${pairForm(agent.id)}</li>`
    + `<li data-agent-step>Or create a key and give it to the agent as a bearer token.${keyForm(agent.id, 'Agent')}</li>`
    + `<li>${instructionsStep(agent, true)}</li>`
    + `</ol>`;
}

function localBody(agent: AgentChoice): string {
  return `<p>These run on this computer, so they work without remote access. Paste this into Claude Code or Codex and it adds Olympus for you:</p>`
    + copyBox('agent-local-prompt', LOCAL_AGENT_PROMPT, 'Copy prompt', true)
    + `<details class="agentprompt" data-poll-key="agent-local-manual"><summary>Add it yourself instead</summary>`
    + `<p>The plugin folder is the <b>rootDir</b> that <b>openclaw plugins inspect olympus --json</b> prints. For Claude Code, run:</p>`
    + copyBox('agent-local-claude', CLAUDE_CODE_SNIPPET, 'Copy command')
    + `<p>For Codex, add this to ~/.codex/config.toml:</p>`
    + copyBox('agent-local-codex', CODEX_SNIPPET, 'Copy snippet')
    + `</details>`
    + instructionsStep(agent, false);
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
    + `<button class="btn quiet" type="button" data-agent-secret-done>Done</button>`
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
    + `<button class="btn quiet" type="submit">Revoke</button>`
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
