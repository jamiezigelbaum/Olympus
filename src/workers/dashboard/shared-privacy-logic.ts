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
 *
 * Follow-up questions (owner request, 2026-10-05): a description that names a
 * broad area ("my family, health and financial stuff") makes the privacy
 * model keep too much private. The editors ask a few short questions per
 * broad area it names, and each answered area becomes one visible sentence
 * after the owner's own words ("About family: private — …; fine to share —
 * …."), which the owner can still edit. The catalog's structure (which areas,
 * how they are spotted, each choice's default) lives here; its words (names,
 * questions, choices, the sentence) are vocabulary.ts
 * DASHBOARD_PRIVACY_QUESTIONS_COPY, handed in as `topicWords`. Deterministic:
 * no model call.
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

/** Which side a follow-up choice puts its kind of item on. */
export type PrivacyTopicSide = 'private' | 'share';

/** Answers per broad area: area id → choice id → side. */
export type PrivacyTopicAnswers = Record<string, Record<string, PrivacyTopicSide>>;

/**
 * The words of the follow-up questions (vocabulary.ts
 * DASHBOARD_PRIVACY_QUESTIONS_COPY): the sentence an answered area becomes,
 * and per area its name, question and choices by id.
 */
export interface PrivacyTopicWords {
  /** The sentence's start, e.g. "About {topic}:". */
  about: string;
  /** The private part, e.g. "private — {list}". */
  privateList: string;
  /** The shared part, e.g. "fine to share — {list}". */
  shareList: string;
  topics: Record<string, { name: string; question: string; options: Record<string, string> }>;
}

/** One broad area as an editor asks about it: each choice with its current side. */
export interface PrivacyTopicQuestion {
  id: string;
  name: string;
  question: string;
  /** True when the description already carries this area's sentence. */
  answered: boolean;
  options: Array<{ id: string; label: string; side: PrivacyTopicSide }>;
}

/** What the logic needs to know about the editor it serves. */
export interface PrivacyLogicConfig {
  /** The mail source a sender or label rule belongs to (gmail.email). */
  mailSourceId: string;
  /** Folder sources a folder rule may name, by id (their names are not read here). */
  folderSources: Record<string, string>;
  /** The follow-up questions' words; without them only detection on plain text works. */
  topicWords?: PrivacyTopicWords;
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

  // ---- follow-up questions -------------------------------------------------
  /** The profile's description limit (privacy-profile.ts PRIVACY_DESCRIPTION_MAX_CHARS). */
  const DESCRIPTION_MAX = 2000;
  /**
   * The broad areas, in the order they are asked: the words that name one
   * (whole words, any case, with plurals and common variants), and each
   * choice's default side.
   */
  const TOPICS: Array<{ id: string; words: string[]; options: Array<[string, PrivacyTopicSide]> }> = [
    { id: 'family', words: ['family', 'families', 'familial', 'kid', 'kids', 'child', 'children', 'son', 'sons', 'daughter', 'daughters', 'parent', 'parents', 'mother', 'father', 'mom', 'dad', 'spouse', 'wife', 'husband', 'sibling', 'siblings'], options: [
      ['medical', 'private'], ['legal_money', 'private'], ['conversations', 'private'],
      ['logistics', 'share'], ['contacts', 'share'], ['history', 'share']] },
    { id: 'health', words: ['health', 'healthcare', 'health care', 'medical'], options: [
      ['results', 'private'], ['prescriptions', 'private'], ['therapy', 'private'], ['exports', 'private'],
      ['wellness', 'share'], ['guides', 'share'], ['product_tests', 'share']] },
    { id: 'money', words: ['financial', 'financials', 'finance', 'finances', 'money', 'bank', 'banks', 'banking'], options: [
      ['statements', 'private'], ['tax', 'private'], ['bills', 'private'], ['loans', 'private'],
      ['articles', 'share'], ['projects', 'share'], ['prices', 'share']] },
    { id: 'work', words: ['work', 'job', 'jobs', 'career', 'employment'], options: [
      ['contracts', 'private'], ['hr', 'private'],
      ['projects', 'share'], ['meetings', 'share'], ['wikis', 'share']] },
    { id: 'relationships', words: ['relationship', 'relationships', 'love', 'love life', 'partner', 'partners', 'intimate', 'intimacy', 'dating'], options: [
      ['journals', 'private'], ['conversations', 'private'],
      ['teachings', 'share'], ['groups', 'share']] },
    { id: 'home', words: ['home', 'homes', 'house', 'houses', 'property', 'properties'], options: [
      ['deeds', 'private'],
      ['info', 'share'], ['plans', 'share']] },
  ];
  const words = config.topicWords;

  function topicById(id: string): { id: string; words: string[]; options: Array<[string, PrivacyTopicSide]> } | undefined {
    return TOPICS.filter((entry) => entry.id === id)[0];
  }

  /** A whole-word, any-case match for any of an area's words. */
  function named(topic: { words: string[] }, text: string): boolean {
    const alternatives = topic.words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
    return new RegExp('(^|[^a-z0-9])(' + alternatives.join('|') + ')(?![a-z0-9])', 'i').test(text);
  }

  /** The start of an area's generated sentence, e.g. "About family:". */
  function leadOf(id: string): string {
    if (!words || !words.topics[id]) return '';
    return words.about.split('{topic}').join(words.topics[id]!.name);
  }

  /**
   * The area whose generated sentence this line is, or ''. Only the full
   * generated shape counts: the lead, then the private or the shared part
   * ("About family: private — …"). An owner's line that merely starts with
   * the lead ("About family: never share …") is theirs, never replaced or read.
   */
  function lineTopic(line: string): string {
    if (!words) return '';
    const trimmed = line.trim();
    const parts = [words.privateList.split('{list}')[0]!, words.shareList.split('{list}')[0]!];
    for (const topic of TOPICS) {
      const lead = leadOf(topic.id);
      if (!lead) continue;
      for (const part of parts) if (part && trimmed.indexOf(lead + ' ' + part) === 0) return topic.id;
    }
    return '';
  }

  /**
   * The broad areas the description names, in catalog order: named in the
   * owner's own words (the generated sentences mention other areas' words,
   * so they are not read for this), or already answered by a sentence.
   */
  function detectTopics(description: string): string[] {
    const lines = String(description || '').split('\n');
    const answered = lines.map(lineTopic);
    const own = lines.filter((_line, index) => !answered[index]).join('\n');
    return TOPICS.filter((topic) => named(topic, own) || answered.indexOf(topic.id) >= 0).map((topic) => topic.id);
  }

  /** Whether `label` sits in `segment` as a whole item (`segment` starts with a space). */
  function holds(segment: string, label: string): boolean {
    let from = 0;
    for (;;) {
      const at = segment.indexOf(label, from);
      if (at < 0) return false;
      const before = segment.charAt(at - 1);
      const after = segment.charAt(at + label.length);
      if (/\s/.test(before) && (after === '' || /[\s,;.…]/.test(after))) return true;
      from = at + 1;
    }
  }

  /** The answers the description's generated sentences already carry, per area (an unanswered area is absent). */
  function topicAnswers(description: string): PrivacyTopicAnswers {
    const out: PrivacyTopicAnswers = {};
    if (!words) return out;
    const privatePrefix = words.privateList.split('{list}')[0]!;
    const sharePrefix = words.shareList.split('{list}')[0]!;
    for (const line of String(description || '').split('\n')) {
      const id = lineTopic(line);
      const topic = topicById(id);
      if (!topic || out[id]) continue;
      const body = line.trim().slice(leadOf(id).length);
      const p = body.indexOf(privatePrefix);
      const q = body.indexOf(sharePrefix);
      const privatePart = p < 0 ? '' : body.slice(p + privatePrefix.length, q > p ? q : body.length);
      const sharePart = q < 0 ? '' : body.slice(q + sharePrefix.length, p > q ? p : body.length);
      const answer: Record<string, PrivacyTopicSide> = {};
      for (const [option, side] of topic.options) {
        const label = words.topics[id]!.options[option] || '';
        answer[option] = label && holds(' ' + privatePart, label) ? 'private'
          : label && holds(' ' + sharePart, label) ? 'share' : side;
      }
      out[id] = answer;
    }
    return out;
  }

  /** An area's sentence for an answer (a choice it does not name keeps its default). */
  function sentence(id: string, answer: Record<string, PrivacyTopicSide>): string {
    const topic = topicById(id);
    if (!words || !topic || !words.topics[id]) return '';
    const kept: string[] = [];
    const shared: string[] = [];
    for (const [option, side] of topic.options) {
      const label = words.topics[id]!.options[option] || '';
      if (label) ((answer[option] || side) === 'private' ? kept : shared).push(label);
    }
    const parts: string[] = [];
    if (kept.length) parts.push(words.privateList.split('{list}').join(kept.join(', ')));
    if (shared.length) parts.push(words.shareList.split('{list}').join(shared.join(', ')));
    return leadOf(id) + ' ' + parts.join('; ') + '.';
  }

  /**
   * The owner's text with one generated sentence per answered area: an area
   * answered before has its sentence replaced in place; a new one goes on its
   * own line at the end. A sentence is never shortened (a cut one would drop
   * choices): when the whole result would pass the description limit, the
   * description comes back unchanged (`fitsAnswers` tells the editor why).
   */
  function refineDescription(description: string, answers: PrivacyTopicAnswers): string {
    const text = String(description || '').replace(/\r\n/g, '\n');
    const refined = refineUnbounded(text, answers);
    return refined.length > DESCRIPTION_MAX ? text : refined;
  }

  /** Whether these answers' sentences fit within the description limit. */
  function fitsAnswers(description: string, answers: PrivacyTopicAnswers): boolean {
    return refineUnbounded(String(description || '').replace(/\r\n/g, '\n'), answers).length <= DESCRIPTION_MAX;
  }

  function refineUnbounded(text: string, answers: PrivacyTopicAnswers): string {
    if (!words) return text;
    const lines = text.split('\n');
    for (const topic of TOPICS) {
      const answer = answers[topic.id];
      const line = answer ? sentence(topic.id, answer) : '';
      if (!line) continue;
      const at = lines.map(lineTopic).indexOf(topic.id);
      if (at >= 0) lines[at] = line;
      else {
        while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
        lines.push(line);
      }
    }
    return lines.join('\n');
  }

  /** The questions for a description: each area it names, each choice at its saved side or its default. */
  function questions(description: string): PrivacyTopicQuestion[] {
    if (!words) return [];
    const saved = topicAnswers(description);
    const out: PrivacyTopicQuestion[] = [];
    for (const id of detectTopics(description)) {
      const topic = topicById(id);
      const said = words.topics[id];
      if (!topic || !said) continue;
      const answer = saved[id];
      out.push({
        id,
        name: said.name,
        question: said.question,
        answered: !!answer,
        options: topic.options.map(([option, side]) => ({
          id: option,
          label: said.options[option] || option,
          side: answer && answer[option] ? answer[option]! : side,
        })),
      });
    }
    return out;
  }

  /** One choice as answers: that area's choices as they stand, with this one changed. */
  function choiceAnswers(description: string, topicId: string, optionId: string, side: PrivacyTopicSide): PrivacyTopicAnswers | null {
    const question = questions(description).filter((entry) => entry.id === topicId)[0];
    if (!question || (side !== 'private' && side !== 'share')) return null;
    const answer: Record<string, PrivacyTopicSide> = {};
    for (const option of question.options) answer[option.id] = option.id === optionId ? side : option.side;
    const answers: PrivacyTopicAnswers = {};
    answers[topicId] = answer;
    return answers;
  }

  /**
   * The description after one choice changes: that area's sentence, with
   * every other choice as it stands. `fits` is false when the sentence would
   * pass the description limit; the description then comes back unchanged
   * and the editor asks the owner to shorten their words.
   */
  function answerTopic(description: string, topicId: string, optionId: string, side: PrivacyTopicSide): { description: string; fits: boolean } {
    const answers = choiceAnswers(description, topicId, optionId, side);
    if (!answers) return { description, fits: true };
    if (!fitsAnswers(description, answers)) return { description, fits: false };
    return { description: refineDescription(description, answers), fits: true };
  }

  /**
   * The description with every asked area's sentence written as its choices
   * stand, defaults included: Save calls this so what the questions show is
   * what is saved, even when the owner accepts every default. Unchanged when
   * nothing is asked or the sentences would pass the description limit.
   */
  function withShownAnswers(description: string): string {
    const answers: PrivacyTopicAnswers = {};
    for (const question of questions(description)) {
      const answer: Record<string, PrivacyTopicSide> = {};
      for (const option of question.options) answer[option.id] = option.side;
      answers[question.id] = answer;
    }
    return refineDescription(description, answers);
  }

  /** What the questions show for a description, as one comparable string: redraw when it changes. */
  function questionsKey(description: string): string {
    return JSON.stringify(questions(description));
  }

  return {
    validRule, displayOf, viewRule, identity, ruleOut, addTo, lowering, lowers, replay, senderValue,
    detectTopics, topicAnswers, refineDescription, fitsAnswers, questions, questionsKey, answerTopic, withShownAnswers,
  };
}

export type PrivacyLogic = ReturnType<typeof privacyLogic>;

const NO_RULES: PrivacyLogicConfig = { mailSourceId: '', folderSources: {} };

/** The broad areas a description names, in the order they are asked (area ids). */
export function detectPrivacyTopics(description: string, words?: PrivacyTopicWords): string[] {
  return privacyLogic(words ? { ...NO_RULES, topicWords: words } : NO_RULES).detectTopics(description);
}

/** The owner's text with one generated sentence per answered area, each replacing that area's earlier one. */
export function refinedPrivacyDescription(description: string, answers: PrivacyTopicAnswers, words: PrivacyTopicWords): string {
  return privacyLogic({ ...NO_RULES, topicWords: words }).refineDescription(description, answers);
}

/** The answers a saved description already carries, so an editor can pre-fill its questions. */
export function privacyTopicAnswers(description: string, words: PrivacyTopicWords): PrivacyTopicAnswers {
  return privacyLogic({ ...NO_RULES, topicWords: words }).topicAnswers(description);
}
