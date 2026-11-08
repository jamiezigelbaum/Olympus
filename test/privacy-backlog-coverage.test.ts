import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { privacyBacklogCoverageNote } from '../src/core/privacy-backlog-coverage.ts';
import { remoteOperationOutput } from '../src/core/remote-result.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { callChatGptTool, type ChatGptSurfaceOptions } from '../src/workers/chatgpt/mcp-surface.ts';
import { answerToolResult, searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { remoteSearchExtension } from '../src/workers/remote-search.ts';
import { recordScriptedSearch, scriptedSearchReleaseCheck } from './helpers/scripted-search-release.ts';

const NOTE = 'Olympus is still checking 7 new items for privacy before they can be searched. This can take a while on this computer.';
const EMPTY = { evidence: [], coverage: { searched_corpora: 2 } };
const THIN = {
  ...EMPTY,
  evidence: [{ corpus_id: 'internal.fixture.files', provider_item_id: 'readable', trust_domain: 'internal', provider: 'fixture', family: 'file', title: 'Readable note', excerpt: 'One readable passage.' }],
};
const ANSWER = { answer: 'I could not find enough evidence to answer.', evidence: [] };

function context(pendingItems = 7): OperationContext {
  return {
    config: defaultConfig(),
    delphi: {} as OperationContext['delphi'],
    email: { sourceAnswer: async () => recordScriptedSearch(ANSWER) } as unknown as OperationContext['email'],
    releaseCheck: scriptedSearchReleaseCheck,
    pendingPrivacyItems: () => pendingItems,
  };
}

function surface(raw = EMPTY): ChatGptSurfaceOptions {
  return {
    dashboardView: async () => { throw new Error('dashboard unavailable'); },
    privateMatchProbe: async () => false,
    evidenceSearch: async () => recordScriptedSearch(raw),
  };
}

describe('privacy judgment coverage, counts only', () => {
  test('one pending item uses singular wording', () => {
    expect(privacyBacklogCoverageNote(1)).toBe('Olympus is still checking 1 new item for privacy before it can be searched. This can take a while on this computer.');
  });

  test('empty, unavailable and invalid counts have no note', () => {
    for (const count of [0, undefined, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(privacyBacklogCoverageNote(count)).toBeUndefined();
    }
    expect(privacyBacklogCoverageNote('HELD_ITEM_TITLE' as unknown as number)).toBeUndefined();
  });

  for (const [label, raw] of [['empty', EMPTY], ['thin', THIN]] as const) {
    test(`${label} search includes the note in text and structured notes`, () => {
      const result = searchToolResult(raw, { pendingPrivacyItems: 7 });
      expect(result.content[0]!.text).toContain(NOTE);
      expect(result.structuredContent?.notes).toContain(NOTE);
      expect(result.structuredContent?.evidence).toHaveLength(raw.evidence.length);
    });
  }

  test('source answers carry the note in their existing coverage/notes paths', () => {
    const chatgpt = answerToolResult(ANSWER, { pendingPrivacyItems: 7 });
    expect(chatgpt.content[0]!.text).toContain(NOTE);
    expect(chatgpt.structuredContent?.notes).toContain(NOTE);
    for (const name of ['source_answer', 'source_answer_result']) {
      expect(remoteOperationOutput(name, ANSWER, { pendingPrivacyItems: 7 }).answer).toBe(`${ANSWER.answer}\n\nCoverage notes:\n- ${NOTE}`);
    }
  });

  test('an empty backlog leaves search and answer results unchanged', () => {
    expect(searchToolResult(EMPTY, { pendingPrivacyItems: 0 })).toEqual(searchToolResult(EMPTY));
    expect(answerToolResult(ANSWER, { pendingPrivacyItems: 0 })).toEqual(answerToolResult(ANSWER));
    expect(remoteOperationOutput('source_answer', ANSWER, { pendingPrivacyItems: 0 })).toEqual(remoteOperationOutput('source_answer', ANSWER));
  });

  test('remote answers keep their output length bound with the coverage note', () => {
    const result = remoteOperationOutput('source_answer', { ...ANSWER, answer: 'a'.repeat(64 * 1024) }, { pendingPrivacyItems: 7 });
    expect((result.answer as string).length).toBe(64 * 1024);
    expect(result.answer).toEndWith(NOTE);
  });
});

describe('privacy backlog response wiring', () => {
  for (const pendingItems of [7, 0]) {
    test(`ChatGPT search and source answer read the pending count (${pendingItems})`, async () => {
      const ctx = context(pendingItems);
      const search = await callChatGptTool('olympus_search', { question: 'What is available?' }, ctx, surface());
      const answer = await callChatGptTool('source_answer', { question: 'What is available?' }, ctx, surface());
      for (const result of [search, answer]) {
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result).includes(NOTE)).toBe(pendingItems > 0);
      }
    });

    test(`remote search and source answer read the pending count (${pendingItems})`, async () => {
      const ctx = context(pendingItems);
      const extension = remoteSearchExtension({ evidenceSearch: async () => EMPTY }, () => 'active', { pendingPrivacyItems: ctx.pendingPrivacyItems! });
      const search = await extension.call({ params: { name: 'olympus_search', arguments: { question: 'What is available?' } } }, async () => ({ content: [] }));
      const answer = await handleMcpCallTool({ params: { name: 'source_answer', arguments: { question: 'What is available?' } } }, () => ctx, 'remote');
      for (const result of [search, answer]) {
        expect(result?.isError).not.toBe(true);
        expect(JSON.stringify(result).includes(NOTE)).toBe(pendingItems > 0);
      }
    });
  }

  test('ChatGPT preserves the note when an empty result is rebuilt for no connected sources', async () => {
    const result = await callChatGptTool('olympus_search', { question: 'What is available?' }, context(), {
      ...surface(), dashboardView: async () => ({ sources: [] }) as never,
    });
    expect(result.content[0]!.text).toContain(NOTE);
    expect(result.content[0]!.text).toContain('No sources are connected');
  });

  test('the backlog is read after retrieval and only its pending-item count leaves', async () => {
    const backlog = { pendingItems: 0, checkingItems: 19, remainingQuestions: 24, summary: 'HELD_ITEM_TITLE', waiting: { label: 'HELD_ITEM_PATH' } };
    const ctx = { ...context(), pendingPrivacyItems: () => backlog.pendingItems };
    const result = await callChatGptTool('olympus_search', { question: 'What is available?' }, ctx, {
      ...surface(), evidenceSearch: async () => { backlog.pendingItems = 7; return recordScriptedSearch(THIN); },
    });
    expect(result.content[0]!.text).toContain(NOTE);
    expect(JSON.stringify(result)).not.toContain('HELD_ITEM');
  });
});
