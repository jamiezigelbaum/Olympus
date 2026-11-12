# Build: remote read handle for source_item_read (Olympus issue #1547)

Repo: jamiezigelbaum/olympus, branch claude/remote-read-handle (= main after #1501). Read AGENTS.md first. TypeScript + Bun 1.3.14.

## Goal
Remote callers on the non-ChatGPT `/mcp` surface (Claude, Grok, Cursor, keys) can read more of a found Personal item with `source_item_read`, using an opaque server-mapped **read handle** instead of `selected_item`. Today `source_item_read` is local/native/CLI only (`V0_4_PUBLIC_REMOTE_MCP_TOOLS = V0_4_HERMES_MCP_TOOLS` in src/core/public-surface.ts; the comment there says it joins with the remote read handle).

## Handle rules (privacy, non-negotiable)
- Opaque: `rh_` + 22+ chars base64url from crypto random bytes. Never a store id, path, corpus id, provider id or local item id, and not derived from them.
- Server-mapped: an in-memory map in the process that serves remote /mcp, handle -> { corpus_id, family, provider, account_scope, provider_item_id, provider_conversation_id?, local_item_id, connectionId, expiresAt }. Bounded (e.g. 5,000 entries; evict oldest). Not persisted.
- Issued only for Personal items: evidence/citations whose raw `trust_domain` is `internal` or `public_safe` (the same CITABLE set response-builder.ts uses), with a resolvable local item id. Nothing for anything else.
- Expiring: 30 minutes, via an injectable clock (tests use a fake clock; no raw sleeps).
- Bound to the connection that received it (`verification.connection.id` in src/workers/remote-mcp.ts). Another connection presenting it gets the same refusal as an unknown handle. A revoked connection gets the existing refusedAccess result.
- Read-time recheck: resolution only maps to a selected item; the engine route `/source/item/read` (src/workers/engine/index.ts) and `LocalConnectorStore.readItemPages` already reread the item's CURRENT label and scope at read time, so an item re-judged Private after the search is refused (`not_personal` 403). Do not cache any label in the handle. Add a test proving this.
- Unknown / expired / wrong-connection handle: one fixed content-free refusal (e.g. couldNotRead `['not_in_scope']` or an invalid_params error), identical in all three cases.

## Where to issue handles
1. `olympus_search` on non-ChatGPT /mcp: src/workers/remote-search.ts `runSearch` (NOT src/workers/chatgpt/mcp-surface.ts; ChatGPT's /openai/mcp must not change at all). After the final `searchToolResult(...)`, add `read_handle` to each structured evidence entry that maps to a Personal raw item (map E-ids to raw evidence in the same order searchToolResult keeps them; prefer a small optional callback/option on searchToolResult that reports kept raw items, without changing its output for ChatGPT). Mention handles in the text part only if needed; structuredContent is enough plus a one-line tool description addition ("pass an item's read_handle to source_item_read to read more of it").
2. `source_answer` citations on remote /mcp: src/core/remote-result.ts `sourceAnswerOutput`/`citationOutput` via a new optional `RemoteOutputOptions` issuer callback; only the remote /mcp path passes it (remote-openapi does not).
3. Raw evidence currently lacks `local_item_id` (searchReleasedEvidence in src/workers/source-index/analyst-answer.ts ~line 3056 and the source_answer evidence). Either add it to the raw evidence (it is allowlisted out by searchToolResult/citationOutput and must never reach output; check assertNoSourceIndexOperationalLeakFields and tests) or resolve it at read time from the identity. Pick the smaller safe option.

## Where to accept handles
- List `source_item_read` on remote /mcp again (public-surface.ts `V0_4_PUBLIC_REMOTE_MCP_TOOLS`), with a remote input schema of `{ read_handle: string (required), page?, pages? }` and NO `selected_item` (remote callers must not supply raw identifiers; reject `selected_item` from remote). Use the existing remote schema hooks in remote-result.ts (`remoteToolSchema`, `remoteDeclaredParams`, `remoteWithheldParam`) or a remote-mcp extension, whichever is cleaner.
- Resolve handle -> selected_item, then run the normal operation (engine route keeps all gates, `withRemoteReadAuthorization` already rechecks the connection mid-read).
- Output schema for remote source_item_read already exists in remote-result.ts (REMOTE_OUTPUT_SCHEMAS.source_item_read).

## Must not change
- `/openai/mcp` and the pinned listing `connect-relay/server/directory/approved.ts`; `connect-relay/test/reviewer-path.test.ts`, test/chatgpt-*.test.ts, test/claude-app-surface.test.ts must pass unchanged. `bun run build` must not change `connect-relay/server/generated/*`.
- No new entry in config/public-surface-allowlist.json. Do not weaken test/architecture-guard, public-surface-guard, privacy-per-item-guard or the tier-classifier guard. No change to src/core/contracts.ts. No question-specific logic.

## Tests (write first)
New test/remote-read-handle.test.ts, plus updates to test/remote-mcp.test.ts / test/public-surface-guard expectations as needed:
- remote olympus_search returns read_handle for Personal evidence only; handle text contains no corpus/provider/local id.
- remote source_item_read with that handle returns pages; same handle from another connection refused; after 30 min (fake clock) refused; unknown handle refused; all three refusals identical.
- item re-judged Private (set ledger content_tier secure) after the search -> read refused with not_personal and no text.
- remote source_item_read with `selected_item` is rejected.
- connection revoked during the read releases nothing (port the two tests at the end of this brief).
- remote source_answer citations carry read_handle for Personal citations only.
- ChatGPT surface output byte-identical (existing tests).
Existing helpers: test/source-item-read.test.ts (fixture(), selected(), client()) and test/remote-mcp.test.ts.

## Done when
Focused tests above, test/source-item-read, test/remote-mcp, test/remote-oauth, test/chatgpt-*, test/claude-app-surface, the guards, connect-relay/test/reviewer-path pass; `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit -p .` clean; dist rebuilt with `bun run build`. Edit the checkout in place; no commits. Summarize the design choices in result.md.

## The two remote tests removed from #1501 (port them)
```ts
// Remote-path tests removed from #1501 when source_item_read left the remote list.
// They return with the remote read handle PR.

test('MCP connection revoked during a chunk release receives only the fixed refusal', async () => {
  const f = await fixture('Personal orchard.'); let active = true;
  f.onCheck(() => { queueMicrotask(() => { active = false; }); });
  const ctx = { config: config(), email: client(f), delphi: {} } as OperationContext;
  const result = await handleMcpCallTool({ params: { name: 'source_item_read', arguments: { selected_item: selected(f) } } }, () => ctx, 'remote', () => active ? 'active' : 'revoked');
  expect(active).toBe(false); expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('invalid_token'); expect(JSON.stringify(result)).not.toContain('orchard');
});


test('remote pages are withheld if the owner overrides the item during release await', async () => {
  const f = await fixture('Personal orchard.');
  const check = createReleaseTierCheck(() => [{ ledger: f.ledger, corpusIds: new Set([f.store.corpusId]) }], () => 'allow');
  let checked = false;
  const ctx = { config: config(), email: client(f), delphi: {}, releaseCheck: {
    inputs(inputs) {
      const result = check.inputs(inputs);
      if (!checked) { checked = true; queueMicrotask(() => f.ledger.setOverride(f.item.identity, { kind: 'tier', tier: 'secure' })); }
      return result;
    }, secureDerivativeDefault: () => 'allow',
  } } as OperationContext;
  const result = await handleMcpCallTool({ params: { name: 'source_item_read', arguments: { selected_item: selected(f) } } }, () => ctx, 'remote');
  expect(checked).toBe(true); expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('orchard');
});


```
