---
name: deliver-files
version: 0.1.0
description: Save files to approved Xanthos destinations through the bounded Olympus file-delivery tool instead of shell or broad exec.
triggers:
  - user asks the calling assistant or Argus to save, write, create, or deliver a file on Xanthos
  - user asks to save a file in Fleur or another approved Olympus file-delivery root
  - task requires creating a user-facing local file from assistant-generated content
tools:
  - xanthos_file_deliver
mutating: true
---

# Deliver Files

Use this skill when the user wants a file saved to Xanthos.

## Contract

Use `xanthos_file_deliver`. Do not use shell, `system.run`, `exec`, `cat`,
`mkdir`, redirection, or raw absolute paths to create user files.

The tool accepts:

- `root_id`: approved logical root such as `olympus_smoke` or `growth_fleur`
- `relative_path`: path below that root only
- `content`
- `content_encoding`: `utf8` or `base64`
- `write_mode`: `dry_run`, `create_new`, or `overwrite_with_approval`
- `trust_domain`
- `idempotency_key`

The tool returns a delivery id, relative path, content hash, bytes written, and
audit reference. It does not expose the concrete Xanthos host path.

## Normal Flow

For a new user-facing file:

1. Choose the approved logical root.
2. Use a relative filename with a safe extension.
3. Start with `dry_run` if the destination, extension, or trust domain is
   uncertain.
4. Use `create_new` for the actual write.
5. Confirm the logical root, relative path, and delivery id.

Do not overwrite files unless the user has explicitly approved the overwrite
and the tool call includes an approval reference.

## Failure Behavior

If delivery fails, report the bounded reason from the tool. Do not fall back to
shell writes or broad exec. If the logical root is missing, say the runtime
file-delivery profile needs to map that root on Xanthos.
