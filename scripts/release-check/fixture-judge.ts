/** Test infrastructure only. The marker belongs to an individual item's own text. */
export type IntendedTier = 'personal' | 'private' | 'secrets' | 'public';
export const FIXTURE_JUDGE_PORT = 19291;
export const FIXTURE_JUDGE_MODEL = 'release-check-fixture-judge-v1';
export const fixtureTierMarker = (tier: IntendedTier): string => `RC_ITEM_TIER_${tier.toUpperCase()}_V1`;
export const fixtureText = (text: string, tier: IntendedTier = 'personal'): string => text.trim()
  ? text.includes(fixtureTierMarker(tier)) ? text : `${fixtureTierMarker(tier)} ${text}` : text;

/** Only item JSON lines from the user prompt count: never system/owner/parent context. */
export function fixtureJudgeVerdicts(messages: Array<{ role?: string; content?: unknown }>): string {
  const verdicts: unknown[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    for (const line of message.content.split('\n')) {
      let item: { i?: unknown; document?: unknown; names?: unknown };
      try { item = JSON.parse(line); } catch { continue; }
      if (!Number.isInteger(item?.i)) continue;
      const material = item.document ?? item.names;
      if (typeof material !== 'string') continue;
      const own = material.replace(/\nParent names \(context only\): [^\n]*/g, '');
      const markers = [...new Set(own.match(/RC_ITEM_TIER_(PERSONAL|PRIVATE|SECRETS|PUBLIC)_V1/g) ?? [])];
      const marker = markers.length === 1 ? markers[0] : undefined;
      // The product's sniffer only accepts Personal/Private. Public needs an owner
      // rule; Secrets are refused before dispatch. Neither may be granted by a judge.
      const personal = marker === fixtureTierMarker('personal') || marker === fixtureTierMarker('public');
      verdicts.push({ i: item.i, category: 'other', ownRecord: false,
        privateKind: personal ? 'none' : 'other', confidence: marker ? 1 : 0,
        tier: personal ? 'personal' : 'private' });
    }
  }
  return JSON.stringify({ verdicts });
}

export function startFixtureJudge(port = FIXTURE_JUDGE_PORT) {
  const stats = { calls: 0, ms: 0 };
  return Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/stats') return Response.json({ model: FIXTURE_JUDGE_MODEL, ...stats });
    if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: FIXTURE_JUDGE_MODEL, object: 'model' }] });
    if (path !== '/v1/chat/completions' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    const started = performance.now();
    const body = await request.json() as { model?: string; messages?: Array<{ role?: string; content?: unknown }> };
    if (body.model !== FIXTURE_JUDGE_MODEL || !Array.isArray(body.messages)) return new Response('Invalid model or messages', { status: 400 });
    const content = fixtureJudgeVerdicts(body.messages);
    stats.calls++;
    stats.ms += performance.now() - started;
    return Response.json({ id: `fixture-judge-${stats.calls}`, object: 'chat.completion', model: FIXTURE_JUDGE_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  } });
}
