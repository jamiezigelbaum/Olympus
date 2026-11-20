# Owner revocation of on-demand reads

All five findings were reproduced with failing regression tests on the first build and fixed in this checkout.

| Finding | Change | Regression proof |
| --- | --- | --- |
| 1. Owner reads an unchanged file again | Job reuse checks the current item and its versioned grants across the lane. An explicit owner read can reuse retained indexed content after restoring the grants and checking that the content is still served. Otherwise it queues extraction. | After a Names-only save, a body-only search misses in both stores. The local dashboard read restores both grants and the body match. Replaying the completed save preserves this new grant. |
| 2. Saving folder B revoked a grant in folder A | Folder approvals and disposition rules compare the item's permissions before and after the save. The previous choices stay with the saved configuration until the writer completes reconciliation. A replay can finish a partial revoke. | Both save routes preserve an individually granted body in unchanged Names-only folder A while changing B. A failed second-store write is retried. A refused rules document can be corrected. |
| 3. Archive Remove acknowledged while copies remained searchable | Remove marks the archive as removing, waits for any active import pass for that archive, clears its grants, and withdraws its copies from the tier ledger before reporting success. Physical cleanup can then run in the background. | The confirmed HTTP removal is followed by a fresh search in every archive store before cleanup. A second case pauses an import inside its store write and checks that Remove waits and the newly written page is hidden. |
| 4. A provider deletion retained the grant | An explicit provider deletion or an authoritative snapshot removal clears the item's grants across the lane, including stores holding only a grant. | After both an explicit deletion and a complete snapshot omission, restoring the same item and version leaves both grant tables clear for that item. A body-only search misses. |
| 5. Busy Disconnect erased grants | Local-files Disconnect checks for a running read again after scheduler refresh and before revoking. Rollback restores the original connection timestamp so the saved folder approval stays valid. | A read starting during refresh produces HTTP 409. The original approval, both grants, and the body search match survive. The successful Disconnect and failed-write retry cases also pass. |

## Local verification

- The 26 first-round focused files passed **688 tests**, including all 16 owner-revocation tests and 43 archive dashboard tests. Each file ran in a separate process with a fresh temporary home.
- Four additional files passed **44 tests** covering the approved directory surface, Telegram archive lifecycle, split routing, and long-file release.
- The additional two-process boot suite had **one pass and one failure** on macOS. Loopback startup passed. The warm-up case waited for a Linux front socket that the transport does not create on macOS. The first-round report records the same failure.
- A separate two-process smoke test sent a rule save to the running front and inspected both SQLite stores after the response. Folder A's grant remained in both and folder B's was absent from both. A subsequent HTTP Disconnect cleared A in both.
- Typecheck, build, and all 32 guard suites passed locally. The dashboard repin tool refreshed the implementation digest. The rendered-page pins stayed unchanged.

The patch is uncommitted in the supplied checkout.
