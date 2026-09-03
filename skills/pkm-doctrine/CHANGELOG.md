# pkm-doctrine changelog

## 0.1.0 — 2026-07-23

- First persona-neutral release: core skill, four situation slices, three
  templates, rationale, machine-readable rules, and deterministic evals.
- Task placement now defers to each install's configured task surface; the
  doctrine does not create a second execution system.
- Restricted-page handling now follows per-item classification and maps through
  the active surface adapter. Reflect uses `private: true`; surfaces without a
  marker omit it without treating secure content as safe to expose.
- New tasks require an observed owner commitment. Third-party action items stay
  evidence until the owner adopts them.
- The first release excludes judgment seeds, wiki authoring, projector
  mechanics, and personal overlays.

Selective rewrite-and-port from `km/worklog` source
`676353e18d03bc0292cb00cc74cf7428ea9aab58`.
