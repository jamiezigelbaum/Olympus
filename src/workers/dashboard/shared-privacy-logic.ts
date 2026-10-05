/**
 * The privacy editors' one set of rules, shared by the ChatGPT panel
 * (chatgpt/privacy.ts) and the local Privacy editor (pages/privacy.ts and the
 * browser controller). Extracted unchanged from the reviewed ChatGPT panel
 * (2026-10-02): which loaded rules are valid in the engine's shape, how a rule
 * is named, what makes two rules the same rule, what a save would lower, what
 * a save sends, and how a draft is replayed onto settings changed elsewhere.
 *
 * `privacyLogic` is serialized into both pages (the ChatGPT page inlines it
 * beside its programs; the standalone dashboard beside its controller), so it
 * must stay self-contained: it references nothing outside its own body.
 */

/** Folder sources a private folder can come from, by name. */
export const PRIVACY_FOLDER_SOURCE_NAMES: Readonly<Record<string, string>> = {
  'dropbox.files': 'Dropbox',
  'google_drive.docs': 'Google Drive',
};

/** Any rule-shaped value: what an editor holds, what the engine saved. */
export interface PrivacyRuleLike {
  kind: string;
  source_id: string;
  key?: string;
  value?: string;
  display?: string;
}

/** What the logic needs to know about the editor it serves. */
export interface PrivacyLogicConfig {
  /** The mail source a sender or label rule belongs to (gmail.email). */
  mailSourceId: string;
  /** Folder sources a folder rule may name, by id (their names are not read here). */
  folderSources: Record<string, string>;
}

/**
 * A rule as an editor holds it: the engine's fields, plus `display` (what the
 * page prints), `saved` (it came from the engine, so removing it lowers
 * protection), `removed`, and `raw` (exactly what the engine sent, which a
 * save sends back unchanged).
 */
export interface PrivacyViewRule {
  kind: string;
  source_id: string;
  key?: string;
  value?: string;
  display: string;
  removed: boolean;
  saved?: boolean;
  raw?: Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function privacyLogic(config: PrivacyLogicConfig) {
  const KINDS = ['folder', 'label', 'sender'];
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DOMAIN = /^@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  const text = (value: any): boolean => typeof value === 'string' && value.trim() !== '';

  /**
   * One rule exactly as the engine serializes it (dashboard-contract.ts
   * PrivacyRuleView, response-builder.ts copyPrivacySettings): a sender is
   * {gmail.email, value}; a label {gmail.email, key, value}; a folder
   * {dropbox.files | google_drive.docs, key, display?}. `display` is only
   * ever a folder's, and optional.
   */
  function validRule(rule: any): boolean {
    if (!rule || typeof rule !== 'object' || KINDS.indexOf(rule.kind) < 0) return false;
    if (rule.kind === 'sender') return rule.source_id === config.mailSourceId && text(rule.value);
    if (rule.kind === 'label') return rule.source_id === config.mailSourceId && text(rule.key) && text(rule.value);
    return Object.prototype.hasOwnProperty.call(config.folderSources, rule.source_id) && text(rule.key)
      && (rule.display === undefined || typeof rule.display === 'string');
  }

  /**
   * What a page prints for a rule: the sender, the label's name, the folder's
   * name, or `unnamed` (already filled, e.g. "A folder in Dropbox").
   */
  function displayOf(rule: any, unnamed: string): string {
    if (rule.kind === 'sender' || rule.kind === 'label') return String(rule.value);
    return text(rule.display) ? String(rule.display) : unnamed;
  }

  /** A loaded rule for the view: `raw` is what the engine sent, saved back unchanged unless removed. */
  function viewRule(rule: any, display: string): PrivacyViewRule {
    const raw: Record<string, unknown> = {};
    for (const field of Object.keys(rule)) raw[field] = rule[field];
    const copy: PrivacyViewRule = { kind: rule.kind, source_id: rule.source_id, display, removed: false, saved: true, raw };
    if (typeof rule.key === 'string') copy.key = rule.key;
    if (typeof rule.value === 'string') copy.value = rule.value;
    return copy;
  }

  /**
   * A rule's identity as the engine matches it (privacy-profile.ts
   * privacyRuleId): a folder or label by its key, a sender by its address,
   * trimmed and lower-cased. A label's name can change; it is the same rule.
   */
  function identity(rule: any): string {
    const matched = rule.kind === 'sender'
      ? (typeof rule.value === 'string' ? rule.value.trim().toLowerCase() : '')
      : (typeof rule.key === 'string' ? rule.key.trim() : '');
    return rule.kind + '\n' + rule.source_id + '\n' + matched;
  }

  /**
   * Exactly what a save sends for a rule: a loaded rule as the engine sent
   * it; a new one in the contract's shape (a folder with its name as
   * `display`, which the contract keeps for the panel). No local flags.
   */
  function ruleOut(rule: any): Record<string, unknown> {
    if (rule.raw) return rule.raw;
    const out: Record<string, unknown> = { kind: rule.kind, source_id: rule.source_id };
    if (typeof rule.key === 'string') out.key = rule.key;
    if (typeof rule.value === 'string') out.value = rule.value;
    if (rule.kind === 'folder' && text(rule.display)) out.display = rule.display;
    return out;
  }

  /** Adds a rule to a list, or brings back the same rule if it was removed. Returns the list. */
  function addTo(rules: any[], rule: any): any[] {
    const id = identity(rule);
    const existing = rules.filter((other: any) => identity(other) === id)[0];
    if (existing) existing.removed = false;
    else rules.push(rule);
    return rules;
  }

  /** Saved rules a save would drop, and whether it changes the saved description: both lower protection. */
  function lowering(rules: readonly any[], description: string, savedDescription: string): { removed: any[]; described: boolean } {
    return {
      removed: rules.filter((rule: any) => rule.saved && rule.removed),
      described: description.trim() !== savedDescription,
    };
  }

  function lowers(rules: readonly any[], description: string, savedDescription: string): boolean {
    const change = lowering(rules, description, savedDescription);
    return change.removed.length > 0 || change.described;
  }

  /**
   * The person's changes, replayed onto settings changed elsewhere: the saved
   * rules they removed stay removed (matched by identity), the rules they
   * added are added again, and a changed description is kept. `fresh` is the
   * current saved rules, already as view rules. Returns the new rule list and
   * the description to show (null: keep the saved one).
   */
  function replay(
    draft: { rules: readonly any[]; description: string; savedDescription: string },
    fresh: any[],
  ): { rules: any[]; description: string | null } {
    const removed: Record<string, boolean> = {};
    for (const rule of draft.rules) if (rule.saved && rule.removed) removed[identity(rule)] = true;
    const additions = draft.rules.filter((rule: any) => !rule.saved && !rule.removed);
    const described = draft.description.trim() !== draft.savedDescription ? draft.description : null;
    for (const rule of fresh) if (removed[identity(rule)]) rule.removed = true;
    for (const rule of additions) addTo(fresh, rule);
    return { rules: fresh, description: described };
  }

  /** A sender the person typed, as a rule value (trimmed, lower-cased), or '' when it is not an address or @domain. */
  function senderValue(input: unknown): string {
    const value = String(input || '').trim().toLowerCase();
    return EMAIL.test(value) || DOMAIN.test(value) ? value : '';
  }

  return { validRule, displayOf, viewRule, identity, ruleOut, addTo, lowering, lowers, replay, senderValue };
}

export type PrivacyLogic = ReturnType<typeof privacyLogic>;
