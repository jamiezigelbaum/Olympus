/**
 * The import-free half of shared-privacy.ts: what a valid always-private rule
 * of each kind is, and how a rule is named on screen. Kept apart so the
 * Gateway bridge (core/control-ui-gateway.ts) can check a rule's shape
 * without pulling the privacy profile's storage into the plugin bundle.
 */

/** Any rule-shaped value: what an editor holds, what the engine saved. */
export interface PrivacyRuleLike {
  kind: string;
  source_id: string;
  key?: string;
  value?: string;
  display?: string;
}

/** Folder sources a private folder can come from, by name. */
export const PRIVACY_FOLDER_SOURCE_NAMES: Readonly<Record<string, string>> = {
  'dropbox.files': 'Dropbox',
  'google_drive.docs': 'Google Drive',
};

const SENDER = /^(?:[^\s<>"(),;:@]+)?@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/**
 * What is wrong with a rule of its kind, or undefined when nothing is: a
 * folder needs its key (a path for Dropbox), a label its id and name, a
 * sender an address or a whole @domain. The engine's parser has the last
 * word; this is the same shape check, early.
 */
export function privacyRuleProblem(rule: PrivacyRuleLike): string | undefined {
  if (rule.kind === 'sender') {
    if (rule.key !== undefined) return 'A sender rule takes value, not key.';
    const value = (rule.value ?? '').trim();
    return value.length > 0 && value.length <= 240 && SENDER.test(value)
      ? undefined
      : 'A sender rule needs an address (name@example.com) or a whole domain (@example.com).';
  }
  if (rule.kind !== 'folder' && rule.kind !== 'label') return 'A rule kind must be folder, label or sender.';
  const key = rule.key ?? '';
  if (!key.trim() || key.length > 1_024) return 'A folder or label rule needs its key.';
  if (rule.kind === 'folder') {
    if (rule.source_id !== 'dropbox.files' && rule.source_id !== 'google_drive.docs') return 'A folder rule names Dropbox or Google Drive.';
    if (rule.source_id === 'dropbox.files' && !key.startsWith('/')) return 'A Dropbox folder key is a path.';
    if (rule.value !== undefined) return 'A folder rule takes key, not value.';
    return undefined;
  }
  if (rule.source_id !== 'gmail.email') return 'A label rule names Gmail.';
  const name = (rule.value ?? '').trim();
  return name && name.length <= 200 ? undefined : 'A label rule needs its name.';
}

/** A rule's name and what kind of place it is, in the editor's words. */
export function privacyRuleWords(
  rule: PrivacyRuleLike,
  words: { kindFolder: string; kindLabel: string; kindSender: string; unnamedFolder: string },
): { name: string; kind: string } {
  if (rule.kind === 'sender') return { name: rule.value ?? '', kind: words.kindSender };
  if (rule.kind === 'label') return { name: rule.value ?? rule.key ?? '', kind: words.kindLabel };
  const key = rule.key ?? '';
  const fromKey = key.startsWith('/') ? key.split('/').filter(Boolean).pop() : undefined;
  return {
    name: rule.display || fromKey || words.unnamedFolder,
    kind: words.kindFolder.split('{source}').join(PRIVACY_FOLDER_SOURCE_NAMES[rule.source_id] ?? rule.source_id),
  };
}
