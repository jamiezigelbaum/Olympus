# Owner revocation of on-demand reads

A completed revoke removes the stored permission from every existing tier of the affected lane. A fresh search can still match permitted names or independently authorized content. The regression query matches only a word in the granted file's body.

## Owner actions

The behavior column describes the checkout at `57277128` before the patch. Locations refer to the patched source. The disconnect regression was reproduced through HTTP. The other baseline entries describe the production code paths.

| Owner action | Could a fresh search still return the previously granted body? | Entry point and disposition |
| --- | --- | --- |
| Change a folder from Names with read on demand to Names only | Yes, once the row satisfied the new approval stamp. Names only and on-demand folders share the metadata search filter, and the existing item/version grant admitted the body. | The panel saves through `src/workers/chatgpt/setup-backend.ts:197` and `src/workers/engine/index.ts:1024`. Saving now reconciles grants against the approved folders, including on a replay after a failed write. |
| Skip a folder, remove it from the selected folders, or withdraw whole-account coverage | No while the item is outside the approved metadata scope. The grant survived and could admit the same version when its folder became visible again. | Same save route. The selection and exclusion predicates are in `src/workers/source-scope-runtime.ts:385`. New saves remove the affected grants, including copies in legs without an item row. |
| Save ingestion disposition edits or replace the rules document | Yes for a Names only rule where the old grant supplied body access. A fully excluded row is hidden wherever the exclusion applies. | `src/workers/engine/index.ts:1038`. The save now reconciles the affected sources against the saved rules before returning. |
| Disconnect files on this computer or a connected account, including a shared Google grant | Folder-approved sources are hidden while disconnected. A retained store whose read scope still allows the item could return its body. The grant row survived both cases. | `src/workers/engine/index.ts:2326` and `src/workers/engine/index.ts:2445`. Disconnect now revokes grants for each affected source. The additional file-scope gate is in `src/workers/engine/runtime/store-scope-policies.ts:23`. |
| Unpair a messaging source | Yes where the retained index still serves the granted item. Unpair keeps indexed messages. | `src/workers/engine/index.ts:2663` and `src/workers/source-dashboard.ts:3356`. Unpair now revokes on-demand reads before teardown. The separate chat picker edits the capture service's future intake at `src/workers/engine/dashboard/dashboard-messaging-service.ts:349`. |
| Make one item Private from the dashboard, an app, Check the judge, or the tier CLI | Personal search hides a routed item on a raise. A search authorized for its Private copy could still use the old grant. An item raised to Secrets is already hidden. | `src/workers/engine/index.ts:3097`, `src/workers/engine/index.ts:663`, `src/workers/classification/judge-check.ts:356`, and `src/workers/classification/tier-cli.ts:493` converge on `applyTierSet`. Private and Secrets choices now revoke first. The split dashboard's HTTP 202 explicitly reports pending while the writer works. |
| Remove a standalone archive, directly or by confirming an agent's removal request | Yes between the removal request and the background withdrawal of its copies. No after removal finished. | `src/workers/archive-import/dashboard.ts:1028` and `src/workers/archive-import/removal.ts:176`. The writer now revokes the archive's grants before acknowledging removal. Cleanup also covers removals pending across an upgrade. Archives imported into an existing source are deleted with that source. |
| Delete a source's indexed data or delete all Olympus data | No after completed deletion. The data lifecycle removes the store files, including their grant tables. | `src/workers/engine/index.ts:4066`, `src/data-lifecycle.ts:1604`, and `src/data-lifecycle.ts:791`. The existing delete path covers this case. |
| Delete an individual item at its provider | No once its deletion is reflected in the index. A usable grant requires an active item row and matching version. | `src/workers/connector-store/local-index.ts:6873` and `src/workers/connector-store/local-index.ts:9416`. I found no public single-item Forget operation. |

The dashboard's existing revoke control for folders is the picker choice followed by Save. The requested sentence is directly under Save at `src/workers/dashboard/chatgpt/picker.ts:2081`. The source card defines Disconnect at `src/workers/source-dashboard.ts:3313`. I found no separate “stop reading on request” button there.

## Implementation

The shared helper at `src/workers/file-extraction/on-demand-read.ts:10` collects grant IDs from the stores, including legs that hold only the grant. It applies each revoke synchronously across the lane. A write error propagates to the owner action. A retry enumerates the remaining rows, so a successful first-leg commit cannot mask a failed second leg. In the split engine the front waits for the writer's completed receipt at `src/workers/engine/server.ts:4911`.

Folder saves compare the new choices against the item's existing folder observations for the same account. Grants in folders that remain on demand or fully indexed can survive the revision change. A save also clears previous one-off grants in folders now designated Names only. Search continues to use its existing grant and delivery checks. No send permit or in-flight search cancellation was added.

## Local verification

- Before changing production code, the new test reproduced both failures. Disconnect returned HTTP 200, a fresh body-only search still returned the file, and injecting a revoke failure in the second store still produced HTTP 200.
- The eight cases in `test/on-demand-revoke-owner.test.ts` passed. The fixture requests the read over HTTP, downloads and extracts the bytes, applies a Personal judgment, then searches each corpus separately. It also verifies that retry completes a partial revoke and that saving a still-authorized on-demand folder retains its grant.
- A separate two-process macOS smoke test seeded a grant in both local-files stores, posted Disconnect to the running front, and read both SQLite files after the HTTP 200. Both grant tables were empty.
- `bun run typecheck`, `bun run guards` (32 guards), and `bun run build` passed locally. Four dashboard design pins were refreshed with the provided repin script. The generated bundles and dashboard assets are included.
- The requested search and read suites passed: 53 tests in `on-demand-read`, 30 in `source-index-router`, and 40 in `source-item-read`. The 26 focused files covering those paths and the touched actions passed 679 tests in total, with isolated temporary homes. The directory-path suite passed another 17 tests. The Telegram archive lifecycle suite passed all 13 under the repository test runner's 15-second limit; its source-tree scan exceeded Bun's five-second default on this host.
- One additional platform check remains unverified on Linux. The two-process boot suite passed its loopback test on macOS. Its Unix-socket warm-up case timed out because it requests a front socket path that the transport only supplies on Linux (`test/engine-split-boot.test.ts:177`, `src/core/worker-transport.ts:40`). No remote host was used.

The patch is uncommitted in the supplied checkout.
