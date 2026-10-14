import { describe, expect, spyOn, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient, type EmailFetch } from '../src/core/email.ts';
import { recordReleaseManifest } from '../src/core/release-manifest.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const answer: SourceIndexAnswerResult = {
  answer: 'SENTINEL_SOURCE_ANSWER', evidence: [],
  opsec: { structured_evidence: [], release_decision: { decision: 'allow', reasons: [] }, raw_source_exposed: false },
  audit: { searched_corpora: [], skipped_corpora: [], lane_audits: [], latency_ms: 1, raw_source_exposed: false,
    answer_synthesis: { private_context_used: false, secure_local_items_consulted: 0,
      internal_content_used: false, internal_items_consulted: 0, internal_content_failures: 0,
      analyst_backend: 'local', raw_source_exposed: false },
  },
  policy: { raw_source_exposed: false, source_packets_exposed: false, internal_content_exposed: false, secure_local_content_exposed: false, castor_safe_bridge: true },
};
function client(fetcher: EmailFetch): EmailClient {
  const config = defaultConfig();
  config.email.enabled = true;
  config.email.baseUrl = 'http://worker.test/v1';
  config.sourceIndex.enabled = true;
  return new EmailClient(config, new DirectHttpEmailTransport(fetcher));
}

describe('local release ticket diagnostics', () => {
  test.each([
    ['private', 'mcp'], ['legacy', 'mcp'], ['private', 'native'], ['private', 'cli'],
  ] as const)('cached Private-derived answer follows current posture and explicit consent (%s, %s)', async (tier, surface) => {
    let posture: 'allow' | 'approval' = 'allow';
    let includeSecureLocalContent = false;
    const worker = createEmailSourceWorker({
      sourceAnswer: { answer: async () => {
        recordReleaseManifest({
          inputs: [{ corpusId: 'secure_local.fixture.files', provider: 'fixture', accountScope: 'personal', providerItemId: 'lease', privateAtAnswer: true }],
          constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent },
        });
        return answer;
      } },
      sourceAnswerReleaseCheck: { inputs: (inputs) => inputs.map(() => ({ tier, gone: false })), secureDerivativeDefault: () => posture },
    });
    try {
      const email = client(async (input, init) => worker.fetch(new Request(input, init)));
      const cached = await email.sourceAnswer({ question: 'fixture?', caller: { surface } });
      expect(cached.answer).toBe(answer.answer);
      posture = 'approval';
      const withheld = await email.revalidateSourceAnswer(cached);
      expect(withheld).toEqual({ answer: 'Olympus withheld this answer because current settings require approval for Private content.', evidence: [] });
      expect(JSON.stringify(withheld)).not.toContain(answer.answer);
      // Explicit consent in the manifest still permits Private under approval.
      includeSecureLocalContent = true;
      const explicit = await email.sourceAnswer({ question: 'fixture?', includeSecureLocalContent: true, caller: { surface } });
      expect(explicit.answer).toBe(answer.answer);
    } finally { worker.close(); }
  });

  test('late collection is withheld with expiry and ask-again instructions', async () => {
    const clock = spyOn(Date, 'now');
    let now = 1_000_000;
    clock.mockImplementation(() => now);
    const worker = createEmailSourceWorker({
      sourceAnswer: { answer: async () => {
        recordReleaseManifest({ inputs: [], constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false } });
        return answer;
      } },
      sourceAnswerReleaseCheck: { inputs: () => [], secureDerivativeDefault: () => 'allow' },
    });
    try {
      const email = client(async (input, init) => worker.fetch(new Request(input, init)));
      const result = await email.sourceAnswer({ question: 'fixture?', caller: { surface: 'mcp' } });
      expect(result.answer).toBe(answer.answer);
      now += 15 * 60_000;
      const collected = await email.revalidateSourceAnswer(result);
      expect(collected).toEqual({ answer: 'Olympus withheld this answer because its privacy release ticket expired after 15 minutes. Ask again.', evidence: [] });
      expect(JSON.stringify(collected)).not.toContain(answer.answer);
    } finally {
      clock.mockRestore();
      worker.close();
    }
  });

  test.each(['mcp', 'native', 'cli'] as const)('an older engine without a ticket is withheld with update instructions (%s)', async surface => {
    const email = client(async () => Response.json(answer));
    const result: unknown = await email.sourceAnswer({ question: 'fixture?', caller: { surface } });
    expect(result).toEqual({
      answer: 'Olympus withheld this answer because the engine did not provide a privacy release ticket. Update Olympus, then ask again.', evidence: [],
    });
  });

  test('a ticket lost on engine restart is withheld with ask-again instructions', async () => {
    const worker = createEmailSourceWorker();
    try {
      const response = await worker.fetch(new Request('http://worker.test/v1/source/answer/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: 'a'.repeat(43) }),
      }));
      expect(await response.json()).toEqual({ withheld: 'Olympus withheld this answer because its privacy release ticket is no longer available (the engine may have restarted). Ask again.' });
    } finally { worker.close(); }
  });
});
