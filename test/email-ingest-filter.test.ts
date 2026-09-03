import { describe, expect, test } from 'bun:test';
import {
  classifyEmailIngestSkip,
  parseEmailIngestFilterOptionsFromEnv,
  tallyEmailIngestSkips,
} from '../src/workers/email-source/ingest-filter.ts';

describe('email ingest filter', () => {
  test('flags verification-code mail by subject', () => {
    expect(classifyEmailIngestSkip({ subject: 'Your verification code is 482910' })).toBe('otp');
    expect(classifyEmailIngestSkip({ subject: 'Acme security code' })).toBe('otp');
    expect(classifyEmailIngestSkip({ subject: 'Your one-time passcode' })).toBe('otp');
  });

  test('flags short bare-code bodies, keeps long real mail with numbers', () => {
    expect(classifyEmailIngestSkip({ subject: 'Acme', body: 'Use code 583920. It expires in 10 minutes.' })).toBe('otp');
    const longBody = `Quarterly report attached. Revenue was 482910 EUR. ${'Detail. '.repeat(200)}`;
    expect(classifyEmailIngestSkip({ subject: 'Q2 report', body: longBody })).toBeUndefined();
  });

  test('skips Gmail promotions category by default, keeps updates', () => {
    expect(classifyEmailIngestSkip({ subject: 'SALE', labels: ['CATEGORY_PROMOTIONS', 'INBOX'] })).toBe('category:CATEGORY_PROMOTIONS');
    expect(classifyEmailIngestSkip({ subject: 'Your order shipped', labels: ['CATEGORY_UPDATES', 'INBOX'] })).toBeUndefined();
  });

  test('env parsing controls categories and otp toggle', () => {
    const options = parseEmailIngestFilterOptionsFromEnv({
      OLYMPUS_EMAIL_INGEST_SKIP_CATEGORIES: 'CATEGORY_PROMOTIONS, CATEGORY_SOCIAL',
      OLYMPUS_EMAIL_INGEST_SKIP_OTP: 'false',
    });
    expect(classifyEmailIngestSkip({ subject: 'code 123456 expires in 5m', body: 'code 123456 expires in 5m' }, options)).toBeUndefined();
    expect(classifyEmailIngestSkip({ labels: ['CATEGORY_SOCIAL'] }, options)).toBe('category:CATEGORY_SOCIAL');
  });

  test('tally aggregates skip reasons', () => {
    expect(tallyEmailIngestSkips(['otp', 'otp', 'category:CATEGORY_PROMOTIONS'])).toEqual({
      otp: 2,
      'category:CATEGORY_PROMOTIONS': 1,
    });
  });

  test('ordinary personal mail passes', () => {
    expect(classifyEmailIngestSkip({
      subject: 'Dinner Thursday?',
      body: 'Are you free Thursday at 8? The place on Rua das Flores.',
      labels: ['INBOX', 'CATEGORY_PERSONAL'],
    })).toBeUndefined();
  });
});
