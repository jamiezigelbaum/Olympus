import { describe, expect, test } from 'bun:test';
import {
  detectPrivacyTopics,
  privacyLogic,
  privacyTopicAnswers,
  refinedPrivacyDescription,
} from '../src/workers/dashboard/shared-privacy-logic.ts';
import { PRIVACY_DESCRIPTION_MAX_CHARS } from '../src/workers/classification/privacy-profile.ts';
import { DASHBOARD_PRIVACY_QUESTIONS_COPY as Q } from '../src/workers/dashboard/vocabulary.ts';

/**
 * The privacy editors' follow-up questions (shared-privacy-logic.ts): which
 * broad areas a description names, the sentence an answer adds to it, and the
 * answers read back from a saved description. Deterministic, no model.
 */
const L = privacyLogic({ mailSourceId: 'gmail.email', folderSources: {}, topicWords: Q });
const OWNER = 'I want my family, health, and financial stuff to stay private';
/** The description after one choice, when it fits. */
const answer = (text: string, topic: string, option: string, side: 'private' | 'share') => L.answerTopic(text, topic, option, side).description;

describe('which broad areas a description names', () => {
  test.each([
    ['my family stuff', ['family']],
    ['Families and kids', ['family']],
    ['anything about my kids', ['family']],
    ['my wife and my parents', ['family']],
    ['health', ['health']],
    ['my medical history and healthcare', ['health']],
    ['finances', ['money']],
    ['anything about MONEY or my bank', ['money']],
    ['financial records', ['money']],
    ['my job and work email', ['work']],
    ['my love life and dating', ['relationships']],
    ['my relationship with my partner', ['relationships']],
    ['our house and other properties', ['home']],
    [OWNER, ['family', 'health', 'money']],
  ])('%p names %p', (text, topics) => {
    expect(detectPrivacyTopics(text)).toEqual(topics);
  });

  test('only whole words: networking, homework, wealthy and unfamiliar name no area', () => {
    expect(detectPrivacyTopics('networking homework wealthy unfamiliar')).toEqual([]);
    expect(detectPrivacyTopics('')).toEqual([]);
  });

  test('generated fallback sentences do not trigger another topic', () => {
    const refined = answer('my family', 'family', 'legal_money', 'private');
    expect(refined).toContain('money');
    expect(L.detectTopics(refined)).toEqual(['family']);
  });
});

describe('unanswered questions and explicit answers', () => {
  test('every new choice starts unanswered, including former fine-to-share defaults', () => {
    for (const question of L.questions(OWNER)) {
      expect(question.answered).toBe(false);
      for (const option of question.options) expect(option.side).toBeUndefined();
    }
    expect(privacyTopicAnswers(OWNER, Q)).toEqual({});
  });

  test('an answer writes only that choice, after the owner’s unchanged words', () => {
    const once = answer(OWNER, 'family', 'logistics', 'share');
    expect(once).toBe(OWNER + '\nAbout family: fine to share — School plans and family logistics.');
    expect(L.topicAnswers(once)).toEqual({ family: { logistics: 'share' } });
    expect(L.questions(once)[0]!.options.find(option => option.id === 'history')!.side).toBeUndefined();
    const twice = answer(once, 'family', 'logistics', 'private');
    expect(twice.split('About family:')).toHaveLength(2);
    expect(L.topicAnswers(twice)).toEqual({ family: { logistics: 'private' } });
    expect(refinedPrivacyDescription(twice, L.topicAnswers(twice), Q)).toBe(twice);
  });

  test('save keeps every skipped choice Private and preserves explicit sharing', () => {
    const partial = answer(OWNER, 'family', 'medical', 'share');
    const saved = L.withShownAnswers(partial);
    expect(saved.split('\n')[0]).toBe(OWNER);
    for (const question of L.questions(saved)) for (const option of question.options) {
      expect(option.side).toBe(question.id === 'family' && option.id === 'medical' ? 'share' : 'private');
    }
    expect(L.withShownAnswers(saved)).toBe(saved);
    expect(L.withShownAnswers('my divorce')).toBe('my divorce');
  });

  test('saved explicit sides prefill; unspecified choices remain unanswered', () => {
    const saved = OWNER + "\nAbout family: private — Alumni, contact and address lists; fine to share — Family members' medical records.";
    expect(L.topicAnswers(saved)).toEqual({ family: { contacts: 'private', medical: 'share' } });
    expect(L.questions(saved)[0]!.options.find(option => option.id === 'history')!.side).toBeUndefined();
    const changed = saved.replace('fine to share —', 'private —');
    expect(L.questionsKey(changed)).not.toBe(L.questionsKey(saved));
  });

  test('an owner’s own similar-looking line is never replaced', () => {
    const own = 'About family: never share anything about my kids.\nmy family stuff\n';
    const refined = answer(own, 'family', 'contacts', 'private');
    expect(refined.startsWith(own + '\n')).toBe(true);
    expect(L.topicAnswers(refined)).toEqual({ family: { contacts: 'private' } });
  });

  test('too-long answers are refused whole; no answer disappears through truncation', () => {
    const own = 'my family ' + 'x'.repeat(PRIVACY_DESCRIPTION_MAX_CHARS - 20);
    expect(L.answerTopic(own, 'family', 'medical', 'share')).toEqual({ description: own, fits: false });
    expect(L.fitsAnswers(own, { family: { medical: 'share' } })).toBe(false);
    expect(refinedPrivacyDescription(own, { family: { medical: 'share' } }, Q)).toBe(own);
  });
});
