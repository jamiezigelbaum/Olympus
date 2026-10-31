import { Window } from 'happy-dom';
import { renderDashboardPrivateAnswersPage } from '../src/workers/dashboard/pages/private-answers.ts';
import { expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_STATES, previewWaitingQuestions, previewSecretNotice } from '../scripts/dashboard-preview.ts';
import { REMOTE_PRIVATE_NOTE, REMOTE_SECRET_NOTE, REMOTE_PRIVATE_NOTE_PATTERN } from '../src/core/remote-result.ts';

test('preview offers a settled failure alongside answered questions', () => {
  expect(DASHBOARD_PREVIEW_STATES).toContain('inbox-failed');
  const questions = previewWaitingQuestions(3, 'inbox-failed').questions;
  expect(questions.map((q) => q.state)).toEqual(['answered', 'answered', 'failed']);
  expect(questions[2]).toMatchObject({ failureReason: 'no_model' });
});

test('Secret preview carries only the fixed remote pointer', () => {
  expect(DASHBOARD_PREVIEW_STATES).toContain('secret-notice');
  const notice = previewSecretNotice();
  expect(notice).toBe(`${REMOTE_PRIVATE_NOTE} ${REMOTE_SECRET_NOTE}`);
  expect(new RegExp(REMOTE_PRIVATE_NOTE_PATTERN).test(notice)).toBe(true);
});

test('initial failed preview row shows the reason and a usable setup link without question details in its notice', () => {
  const window = new Window();
  window.document.body.innerHTML = renderDashboardPrivateAnswersPage({
    controlSessionCsrfToken: 'preview', outsideHelpLocalSession: true,
    privateAnswers: { available: true, waiting: previewWaitingQuestions(3, 'inbox-failed') },
  });
  const notice = window.document.querySelector('[data-pa-failure]')!;
  expect(notice.textContent).toBe('Your local model is not available. Set up local models');
  expect(notice.querySelector('a')!.getAttribute('href')).toBe('/dashboard?keys');
  expect(notice.textContent).not.toContain('flight');
  window.close();
});
