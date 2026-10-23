/**
 * What kind of control a dashboard panel control is, from its key and words (the page gives every control a stable key). Light on
 * purpose: this file runs on the machine, so it reads only the vocabulary.
 */
import { DASHBOARD_CHATGPT_SETUP_LABELS as LABELS, DASHBOARD_CHATGPT_VOCABULARY as VOCABULARY } from '../../src/workers/dashboard/vocabulary.ts';

export type SeedId = 'populated' | 'failed' | 'disconnected' | 'empty';
export type ControlKind = 'connect' | 'reconnect' | 'sync' | 'scope' | 'disconnect' | 'delete-data' | 'menu' | 'see-why' | 'confirm' | 'cancel' | 'unpair' | 'check-again' | 'privacy-settings' | 'other';

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function kindOf(key: string, label: string): ControlKind {
  if (/^summary:menu:/.test(key)) return 'menu';
  if (/^source:.+:privacy-settings$/.test(key)) return 'privacy-settings';
  if (/^summary:why:/.test(key)) return 'see-why';
  if (/:yes$/.test(key)) return 'confirm';
  if (/:no$/.test(key)) return 'cancel';
  const text = label.trim();
  if (new RegExp(`^${escape(LABELS.syncNow)}$`).test(text)) return 'sync';
  if (new RegExp(`^${escape(LABELS.disconnect)}$`).test(text)) return 'disconnect';
  if (new RegExp(`^${escape(LABELS.deleteData)}$`).test(text)) return 'delete-data';
  if (new RegExp(`^(${escape(LABELS.chooseFolders)}|${escape(LABELS.chooseMail)})$`).test(text)) return 'scope';
  if (new RegExp(`^(${escape(VOCABULARY.reconnect)}|${escape(VOCABULARY.reconnectGoogle)})$`).test(text)) return 'reconnect';
  if (new RegExp(`^${escape(LABELS.connect)}$`).test(text)) return 'connect';
  if (new RegExp(`^${escape(VOCABULARY.checkAgain)}$`).test(text)) return 'check-again';
  if (/^Unpair\b/.test(text)) return 'unpair';
  return 'other';
}
