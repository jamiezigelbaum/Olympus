import { describe, expect, test } from 'bun:test';
import { classifyItemTier } from '../src/workers/classification/index.ts';

// The sensitive-sender option is a RAISE ("overrides clean rules, never
// overridden by them"). It must never cap a message at S4 when the secret
// detector's S5 floor fires: S5 never enters any model or cloud path, while
// S4 secure_local is model-eligible and Venice-eligible.
describe('sensitive sender override vs the S5 secret floor', () => {
  test('an API token from a configured sensitive sender still classifies S5', () => {
    const result = classifyItemTier({
      subject: 'Portal access',
      sender: 'billing@bank.example',
      text: 'Your integration key: sk-abcdefghijklmnopqrstuvwxyz012345',
    }, { sensitiveSenderPatterns: ['billing@bank.example'] });

    expect(result.tier).toBe('S5');
    expect(result.trustDomain).toBe('secure_local');
    expect(result.decidedBy).toBe('sensitive_detector');
    expect(result.signals).toContain('secret:api_secret_token');
  });

  test('a credential assignment from a configured sensitive sender still classifies S5', () => {
    const result = classifyItemTier({
      subject: 'Your new portal login',
      sender: 'Bank Billing <billing@bank.example>',
      text: 'password: Tr0ub4dor&3xample',
    }, { sensitiveSenderPatterns: ['billing@bank.example'] });

    expect(result.tier).toBe('S5');
    expect(result.signals).toContain('secret:credential_assignment');
  });

  test('the override still raises a clean-looking message from that sender to S4', () => {
    const result = classifyItemTier({
      subject: 'Thanks!',
      sender: 'billing@bank.example',
      text: 'Thanks, see you Tuesday.',
    }, { sensitiveSenderPatterns: ['billing@bank.example'] });

    expect(result.tier).toBe('S4');
    expect(result.trustDomain).toBe('secure_local');
    expect(result.decidedBy).toBe('sensitive_detector');
    expect(result.signals).toEqual(['sensitive_sender_override']);
  });
});
