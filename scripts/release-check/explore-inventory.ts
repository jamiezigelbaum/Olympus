/**
 * The controls the Sources section of the dashboard can offer, listed from the product's own source (not from what a crawler happens
 * to find on a page): the roster of sources, and for each the controls the dashboard's view model builds for it
 * (src/workers/chatgpt/dashboard-view-model.ts), with the words on them from the vocabulary.
 *
 * The exploration (explore.ts) reports coverage against this list: a control that never showed up on the page is a control it
 * missed, not one that is absent. Where a control cannot be produced on the throwaway machine (it needs a real account at the
 * provider, a paired phone, this computer's own folders), the entry says why, and the report says so for each.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DASHBOARD_SUPPORTED_SOURCES } from '../../src/workers/source-dashboard.ts';
import { DASHBOARD_CHATGPT_PICKER_COPY as PICKER, DASHBOARD_CHATGPT_SETUP_LABELS as LABELS, DASHBOARD_CHATGPT_VOCABULARY as VOCABULARY } from '../../src/workers/dashboard/vocabulary.ts';

export type { ControlKind, SeedId } from './explore-kinds.ts';
import type { ControlKind, SeedId } from './explore-kinds.ts';

export interface InventoryControl {
  /** `<source id>:<kind>`. */
  id: string;
  sourceId: string;
  sourceLabel: string;
  kind: ControlKind;
  /** The words on the control, as a regular expression source (the label differs a little between hosts and states). */
  label: string;
  destructive: boolean;
  /** The states of the seeded install in which the page shows it. */
  seeds: SeedId[];
  /** Why the throwaway machine cannot press it; absent when it can. */
  unreachable?: string;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A set literal in the view model's source: `const NAME = new Set<string>([...])`. Read from the file so a new source cannot be forgotten here. */
export function setLiteral(source: string, name: string): string[] {
  const match = new RegExp(`const ${name} = new Set<string>\\(\\[([^\\]]*)\\]\\)`).exec(source);
  if (!match) throw new Error(`the view model no longer defines ${name} the way the exploration's inventory reads it`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((entry) => entry[1]!);
}

/**
 * The sources the throwaway machine can drive, and how:
 * - Readwise, through the stand-in for its API, reached by the connector's own base-URL settings (readwise-fake.ts);
 * - Files on this computer on a Linux machine, with a real folder of files made on it (a Mac asks for a privacy permission the
 *   machine cannot grant).
 */
export type MachineOs = 'linux' | 'macos';
const DRIVABLE = new Set(['readwise.library']);

const UNREACHABLE: Record<string, string> = {
  oauth: 'needs a real sign-in at the provider, and the sign-in and API addresses are a closed table in the product with no setting to point them at a stand-in; a stand-in would need a hook that exists only for tests',
  local: 'needs this computer\'s own folders and, on a Mac, its privacy permission, which a throwaway machine cannot grant',
  pairing: 'needs a paired session: a credential-broker handle for a local Telethon or whatsmeow reader, which only the pairing daemon makes (a stand-in would need a test-only product hook)',
  api_token: 'this source has no stand-in',
};

/** Why a source cannot be driven on this kind of machine; absent when it can. */
export function unreachableOn(connectKind: string, sourceId: string, os: MachineOs): string | undefined {
  if (DRIVABLE.has(sourceId)) return undefined;
  if (connectKind === 'local' && os === 'linux') return undefined;
  return UNREACHABLE[connectKind] ?? UNREACHABLE.oauth!;
}

export function buildInventory(root = join(import.meta.dir, '..', '..'), os: MachineOs = 'linux'): InventoryControl[] {
  const view = readFileSync(join(root, 'src', 'workers', 'chatgpt', 'dashboard-view-model.ts'), 'utf8');
  const scopeIds = new Set(setLiteral(view, 'SCOPE_SOURCE_IDS'));
  const disconnectIds = new Set(setLiteral(view, 'DISCONNECT_SOURCE_IDS'));
  const syncIds = new Set(setLiteral(view, 'SYNC_SOURCE_IDS'));
  const out: InventoryControl[] = [];
  for (const definition of DASHBOARD_SUPPORTED_SOURCES) {
    if (definition.family === 'model') continue;
    const id = definition.source_id;
    const why = unreachableOn(definition.connect_kind, id, os);
    const add = (kind: ControlKind, label: string, destructive: boolean, seeds: SeedId[], onlyWhere?: string): void => {
      const unreachable = why ?? onlyWhere;
      out.push({ id: `${id}:${kind}`, sourceId: id, sourceLabel: definition.label, kind, label: `^(${label})$`, destructive, seeds, ...(unreachable ? { unreachable } : {}) });
    };
    add('connect', escape(LABELS.connect), false, ['disconnected', 'empty']);
    add('reconnect', `${escape(VOCABULARY.reconnect)}|${escape(VOCABULARY.reconnectGoogle)}`, false, ['failed']);
    if (syncIds.has(id)) add('sync', escape(LABELS.syncNow), false, ['populated', 'failed']);
    // A source this worker cannot sync offers Check again on its Needs-you row (checkAgainFix() in the view model).
    else add('check-again', escape(VOCABULARY.checkAgain), false, ['failed']);
    if (scopeIds.has(id)) add('scope', `${escape(LABELS.chooseFolders)}|${escape(LABELS.chooseMail)}`, false, ['populated'], definition.connect_kind === 'local' ? undefined : 'its folders and mail are chosen in a picker that lists the provider\'s folders, which needs the provider');
    // A Mac that will not open a chosen folder stalls the source, and the row then links to the privacy settings page (client.ts, scope_root_permission_needed).
    if (definition.connect_action.kind === 'this_computer') add('privacy-settings', escape(PICKER.openPrivacySettings), false, ['failed'], 'it shows only when a Mac refuses a chosen folder, and a Linux machine never does');
    // A paired chat app (Telegram, WhatsApp) offers Unpair, with the engine's own confirmation, on the computer (unpairEntry() in the dashboard client).
    if (definition.connect_kind === 'pairing') add('unpair', escape(`Unpair ${definition.label}`), true, ['populated']);
    if (disconnectIds.has(id) || definition.connect_action.kind === 'this_computer') {
      add('disconnect', escape(LABELS.disconnect), true, ['populated', 'failed']);
      add('delete-data', escape(LABELS.deleteData), true, ['disconnected']);
    }
  }
  return out;
}

/** Which source a row name belongs to. */
export function sourceIdOfLabel(label: string): string | undefined {
  return DASHBOARD_SUPPORTED_SOURCES.find((definition) => definition.label === label)?.source_id;
}
