import { expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_STATES, previewWaitingQuestions, previewSecretNotice } from '../scripts/dashboard-preview.ts';
import { REMOTE_PRIVATE_NOTE, REMOTE_SECRET_NOTE, REMOTE_PRIVATE_NOTE_PATTERN } from '../src/core/remote-result.ts';

test('preview offers a settled failure alongside answered questions', () => {
  expect(DASHBOARD_PREVIEW_STATES).toContain('inbox-failed');
  const questions = previewWaitingQuestions(3, 'inbox-failed').questions;
  expect(questions.map((q) => q.state)).toEqual(['answered', 'answered', 'failed']);
});

test('Secret preview carries only the fixed remote pointer', () => {
  expect(DASHBOARD_PREVIEW_STATES).toContain('secret-notice');
  const notice = previewSecretNotice();
  expect(notice).toBe(`${REMOTE_PRIVATE_NOTE} ${REMOTE_SECRET_NOTE}`);
  expect(new RegExp(REMOTE_PRIVATE_NOTE_PATTERN).test(notice)).toBe(true);
});
