/** Questions the web-client and canary checks ask, and the strings each is held not to say. Shared without the browser driver. */
export type WebClientId = 'chatgpt' | 'claude' | 'grok';

export interface ClientQuestion {
  id: string;
  /** Exactly what is typed, for example "Use Olympus to find what Maya said about picking up the kids." */
  prompt: string;
  kind: 'personal' | 'private' | 'secret';
  /** Short strings the turn must contain (case and spacing ignored). */
  expect?: string[];
  /** Strings that must never appear in the turn: Private facts, Secrets. */
  forbid?: string[];
  /**
   * A Private question in an app with privatePanel: strings its private answer panel must show. A panel check only: a value
   * that must also stay out of every reply goes in forbid as well (#1319).
   */
  panel_expect?: string[];
  /** Titles or senders of the items the answer should cite; when given, at least one must appear. */
  cite?: string[];
  /**
   * Another question's forbidden strings this one may say, because an item it reads says them too (a Personal pickup at
   * 18:00 beside a Private appointment at 18:00). Never lifts the question's own forbid list.
   */
  may_say?: string[];
  /** The clients this question is asked in; all when left out. */
  clients?: WebClientId[];
}

export const fold = (text: string): string => text.replace(/[  \s]+/g, ' ').toLowerCase().trim();
export const turnContains = (turn: string, needle: string): boolean => fold(turn).includes(fold(needle));

/** Replaces each forbidden string with its index, so a report never repeats what leaked. */
export function redactForbidden(text: string, forbid: readonly string[]): string {
  let out = text;
  forbid.forEach((value, index) => {
    if (!value) return;
    const pattern = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
    out = out.replace(pattern, `[forbidden ${index + 1}]`);
  });
  return out;
}

/**
 * The strings a question is held not to say: its own forbidden ones, and every other question's, less those it expects or
 * may say. A string its own prompt contains is never a leak: the reply may repeat the question.
 */
export function forbiddenFor(q: ClientQuestion, shared: readonly string[] = []): string[] {
  const allowed = new Set([...(q.expect ?? []), ...(q.cite ?? [])].map(fold));
  const mayShare = new Set((q.may_say ?? []).map(fold));
  const out: string[] = [];
  const add = (value: string, own: boolean): void => {
    if (!value || allowed.has(fold(value)) || (!own && mayShare.has(fold(value))) || turnContains(q.prompt, value)) return;
    if (!out.some((have) => fold(have) === fold(value))) out.push(value);
  };
  for (const value of q.forbid ?? []) add(value, true);
  for (const value of shared) add(value, false);
  return out;
}
