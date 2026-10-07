import { describe, expect, test } from 'bun:test';
import {
  detectPrivacyTopics,
  privacyLogic,
  privacyTopicAnswers,
  refinedPrivacyDescription,
  type PrivacyTopicAnswers,
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

  test('an area another area\'s sentence mentions is not asked about', () => {
    // The family sentence mentions "money papers"; the owner never named money.
    const refined = answer('my family', 'family', 'contacts', 'private');
    expect(refined).toContain('money');
    expect(L.detectTopics(refined)).toEqual(['family']);
  });
});

describe('the sentence an answer adds', () => {
  test('the owner\'s words stay first and unchanged; one sentence per answered area', () => {
    const refined = answer(OWNER, 'family', 'logistics', 'share');
    expect(refined.split('\n')[0]).toBe(OWNER);
    expect(refined.split('\n')[1]).toBe('About family: private — Family members\' medical records, '
      + 'Family legal and money papers (divorce, custody, trusts), Private family conversations and journals; '
      + 'fine to share — School plans and family logistics, Alumni, contact and address lists, Family history and photos.');
    expect(refined.split('\n')).toHaveLength(2);
  });

  test('answering again replaces that area\'s sentence instead of adding another', () => {
    const once = answer(OWNER, 'family', 'contacts', 'private');
    const twice = answer(once, 'family', 'contacts', 'share');
    expect(twice.split('About family:')).toHaveLength(2);
    expect(L.topicAnswers(twice).family!.contacts).toBe('share');
    // Same answers, same text: idempotent.
    expect(refinedPrivacyDescription(twice, L.topicAnswers(twice), Q)).toBe(twice);
    // Another area adds its own line and leaves the first in place.
    const both = answer(twice, 'health', 'wellness', 'private');
    expect(both.split('\n')).toEqual([OWNER, twice.split('\n')[1], expect.stringMatching(/^About health: private — .*Wellness programs/)]);
  });

  test('a sentence the owner moved stays where they put it, and their edits around it are kept', () => {
    const answered = answer('health', 'health', 'therapy', 'share');
    const moved = answered.split('\n').reverse().join('\n') + '\nand my journals';
    const again = answer(moved, 'health', 'therapy', 'private');
    const lines = again.split('\n');
    expect(lines[0]).toMatch(/^About health: private — .*Therapy sessions/);
    expect(lines.slice(1)).toEqual(['health', 'and my journals']);
  });

  test('every choice on one side names only that side', () => {
    const answers: PrivacyTopicAnswers = { home: { deeds: 'share', info: 'share', plans: 'share' } };
    expect(refinedPrivacyDescription('my home', answers, Q)).toBe(
      'my home\nAbout home: fine to share — Deeds, purchase contracts and leases, Property information and certificates, Listings, renovation and moving plans.',
    );
  });

  test('an answer that would pass the description limit changes nothing and says it does not fit', () => {
    const own = `my family ${'x'.repeat(PRIVACY_DESCRIPTION_MAX_CHARS - 120)}`;
    // The full sentence is longer than the room left: never cut, so no Private choice is dropped.
    expect(L.answerTopic(own, 'family', 'history', 'private')).toEqual({ description: own, fits: false });
    expect(refinedPrivacyDescription(own, { family: {} }, Q)).toBe(own);
    // Answered before and now too long to rewrite: the earlier, whole sentence stays, and reads back as it was.
    // (All of home shared; making one choice private adds a private part, which is longer.)
    const saved = refinedPrivacyDescription('my home', { home: { deeds: 'share' } }, Q);
    const padded = `my home ${'y'.repeat(PRIVACY_DESCRIPTION_MAX_CHARS - saved.length - 2)}\n${saved.split('\n')[1]}`;
    expect(padded.length).toBe(PRIVACY_DESCRIPTION_MAX_CHARS - 1);
    const longer = L.answerTopic(padded, 'home', 'plans', 'private');
    expect(longer).toEqual({ description: padded, fits: false });
    expect(L.topicAnswers(padded).home).toEqual({ deeds: 'share', info: 'share', plans: 'share' });
    // Six full answers fit beside a short description.
    const all: PrivacyTopicAnswers = {};
    for (const topic of ['family', 'health', 'money', 'work', 'relationships', 'home']) all[topic] = {};
    expect(L.fitsAnswers(OWNER, all)).toBe(true);
    expect(refinedPrivacyDescription(OWNER, all, Q).length).toBeLessThanOrEqual(PRIVACY_DESCRIPTION_MAX_CHARS);
  });

  test('an owner\'s line that starts like a sentence is theirs: never replaced or read as answers', () => {
    const own = 'About family: never share anything about my kids.\nmy family stuff';
    expect(L.topicAnswers(own)).toEqual({});
    expect(L.questions(own)[0]).toMatchObject({ id: 'family', answered: false });
    const refined = answer(own, 'family', 'contacts', 'private');
    const lines = refined.split('\n');
    expect(lines.slice(0, 2)).toEqual(['About family: never share anything about my kids.', 'my family stuff']);
    expect(lines[2]).toStartWith('About family: private — ');
    expect(L.topicAnswers(refined).family!.contacts).toBe('private');
    // Answering again rewrites only the generated line.
    const again = answer(refined, 'family', 'contacts', 'share');
    expect(again.split('\n').slice(0, 2)).toEqual(lines.slice(0, 2));
    expect(again.split('\n')).toHaveLength(3);
    expect(L.topicAnswers(again).family!.contacts).toBe('share');
  });

  test('the questions\' key changes when a sentence is edited by hand, not only when an area does', () => {
    const saved = answer('my family', 'family', 'medical', 'share');
    const edited = saved.replace('fine to share — Family members\' medical records, ', 'fine to share — ')
      .replace('private — ', 'private — Family members\' medical records, ');
    expect(L.detectTopics(edited)).toEqual(L.detectTopics(saved));
    expect(L.questionsKey(edited)).not.toBe(L.questionsKey(saved));
    expect(L.topicAnswers(edited).family!.medical).toBe('private');
  });
});

describe('answers read back from a saved description', () => {
  test('pre-fills each choice from the sentence, and unanswered areas at their defaults', () => {
    const saved = answer(answer(OWNER, 'family', 'logistics', 'private'), 'family', 'medical', 'share');
    expect(privacyTopicAnswers(saved, Q)).toEqual({
      family: { medical: 'share', legal_money: 'private', conversations: 'private', logistics: 'private', contacts: 'share', history: 'share' },
    });
    const asked = L.questions(saved);
    expect(asked.map((topic) => [topic.id, topic.answered])).toEqual([['family', true], ['health', false], ['money', false]]);
    expect(asked[0]!.question).toBe('Which family things are private?');
    expect(asked[0]!.options.find((option) => option.id === 'medical')!.side).toBe('share');
    expect(asked[1]!.options.map((option) => option.side)).toEqual(['private', 'private', 'private', 'private', 'share', 'share', 'share']);
  });

  test('a description without sentences carries no answers', () => {
    expect(privacyTopicAnswers(OWNER, Q)).toEqual({});
  });

  test('an area whose sentence remains is still asked about after its word is deleted', () => {
    const saved = answer('my house', 'home', 'plans', 'private').replace('my house', 'my car');
    expect(L.detectTopics(saved)).toEqual(['home']);
    expect(L.topicAnswers(saved).home!.plans).toBe('private');
  });

  test('a changed description lowers protection, so a choice still needs the owner\'s confirmation', () => {
    const refined = answer(OWNER, 'family', 'logistics', 'share');
    expect(L.lowers([], refined, OWNER)).toBe(true);
  });
});
