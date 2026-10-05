/**
 * A new install's first question: with no source connected, an empty search
 * says so instead of "no evidence in N searched sources" (zigelbot fresh
 * install, 2026-10-04).
 */
import { describe, expect, test } from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import { SEARCH_TOOL, callChatGptTool, type ChatGptSurfaceOptions } from '../src/workers/chatgpt/mcp-surface.ts';
import { NO_SOURCES_CONNECTED_TEXT } from '../src/workers/chatgpt/response-builder.ts';

const EMPTY = { evidence: [], coverage: { searched_corpora: 4, unreadable_items: 0, partially_read_items: 0, unclassified_items: 0 } };

function options(dashboardView: ChatGptSurfaceOptions['dashboardView'], raw: unknown = EMPTY): ChatGptSurfaceOptions {
  return { dashboardView, evidenceSearch: async () => raw, privateMatchProbe: async () => ({ count: 0, evidence: [] }) } as ChatGptSurfaceOptions;
}

const text = (result: { content: unknown }) => (result.content as Array<{ text: string }>)[0]!.text;

describe('olympus_search with nothing connected', () => {
  test('an empty result on a Mac with no connected source says nothing is connected', async () => {
    const result = await callChatGptTool(SEARCH_TOOL.name, { question: 'integral theory' }, {} as OperationContext, options(async () => ({ sources: [] }) as never));
    expect(text(result)).toContain(NO_SOURCES_CONNECTED_TEXT);
    expect(text(result)).not.toContain('searched source');
  });

  test('an unreadable dashboard keeps the ordinary empty result', async () => {
    const result = await callChatGptTool(SEARCH_TOOL.name, { question: 'integral theory' }, {} as OperationContext, options(async () => { throw new Error('down'); }));
    expect(text(result)).toContain('in 4 searched sources');
  });

  test('a result with evidence never reads the dashboard', async () => {
    let read = 0;
    const raw = { ...EMPTY, evidence: [{ trust_domain: 'internal', family: 'file', provider: 'dropbox', title: 'Notes', excerpt: 'Integral theory notes.' }] };
    const result = await callChatGptTool(SEARCH_TOOL.name, { question: 'integral theory' }, {} as OperationContext, options(async () => { read += 1; return {} as never; }, raw));
    expect(text(result)).toContain('Notes');
    expect(read).toBe(0);
  });
});
