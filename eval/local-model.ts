// The local OpenAI-compatible model the eval's authoring and judging steps
// ask: loopback or private addresses only, so private text never leaves the
// machine.
import { lookup } from 'node:dns/promises';
import { parseLane, parseModelProfile, type loadConfig } from '../src/core/config.ts';

export interface DraftModel { complete(prompt: string): Promise<unknown> }
/** The model answered, but not with a readable JSON object (often a refusal in prose). */
export class DraftUnreadable extends Error {}

function privateAddress(address: string): boolean {
  if (address === '::1' || (address.includes(':') && /^(fc|fd)/i.test(address))) return true;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && (parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31));
}
export function localDraftModel(settings: { baseUrl: string; model: string; timeoutMs?: number }): DraftModel {
  const url = new URL(settings.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!privateAddress(url.hostname.replace(/^\[|\]$/g, '')) && !['localhost', 'sparta'].includes(url.hostname))) throw new Error('Drafting requires an explicit local model endpoint.');
  return { async complete(prompt) {
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
    if (!addresses.length || addresses.some(({ address }) => !privateAddress(address))) throw new Error('Drafting endpoint must resolve locally.');
    const response = await fetch(`${url.href.replace(/\/$/, '')}/chat/completions`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(settings.timeoutMs ?? 240_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: settings.model, temperature: 0, messages: [{ role: 'system', content: 'Draft private retrieval evaluation questions. Return only the requested JSON object.' }, { role: 'user', content: prompt }] }) });
    if (!response.ok) throw new Error('Local draft request failed.');
    const body = await response.json() as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new DraftUnreadable('Empty local draft response.');
    try { return JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as unknown; }
    catch { throw new DraftUnreadable('Unreadable local draft response.'); }
  } };
}

/** The eval's local Analyst profile or lane, unless an endpoint or model is given. */
export function localEvalModel(config: ReturnType<typeof loadConfig>, override: { baseUrl?: string | undefined; model?: string | undefined } = {}): DraftModel {
  const profile = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE?.trim()
    ? config.argus.lanes[parseLane(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE)]
    : config.argus.modelProfiles[parseModelProfile(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE ?? 'source_answer')];
  return localDraftModel({ baseUrl: override.baseUrl ?? profile.baseUrl, model: override.model ?? profile.model });
}
