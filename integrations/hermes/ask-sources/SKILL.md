---
name: ask-sources
version: 0.4.0
description: Ask Olympus for cited answers and check source readiness through the exact three-tool Hermes MCP surface.
tools:
  - source_answer
  - source_answer_result
  - source_index_status
mutating: false
---

# Ask Sources from Hermes

Use `source_answer` for questions grounded in Olympus-indexed sources. Preserve
the returned citations and coverage gaps. Set `include_secure_local: true` only
when the user asks for private material and the installed sovereignty posture
has an approved analyst route for it. Do not replace an Olympus refusal with
shell, database, filesystem, browser, or provider-CLI access.

If `source_answer` returns `"status": "working"` with a `job_id`, the answer is
still being prepared and keeps running. Call `source_answer_result` with that
`job_id`, again while it says working, and deliver the answer it returns. Do
not ask the same question again.

Use `source_index_status` only for aggregate readiness and coverage checks. It
does not browse or return source content.

This Hermes adaptation intentionally has no search, locator, sync, watch,
export, or mutation tool. If the three declared tools are unavailable, say that
the Olympus MCP lane is unavailable and stop.
