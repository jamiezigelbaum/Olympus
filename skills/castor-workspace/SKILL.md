---
name: castor-workspace
version: 0.1.0
description: Use the owner's delegated assistant workfiles folder through the bounded Olympus workspace tool.
triggers:
  - user asks the calling assistant to use, inspect, copy, delete, export, or organize files in delegated workfiles
  - user says a file or folder has been placed in delegated workfiles for the calling assistant to use freely
  - user asks to export delegated workfiles contents to Google Cloud Storage or a RAG corpus
tools:
  - castor_workspace
mutating: true
---

# Delegated Workfiles

Use this skill when the owner asks you to work with files inside the delegated
assistant workfiles folder.

## Product Rule

Delegated workfiles is an approved filesystem root exposed through the
`castor_workspace` tool. Placement inside this root is the owner's approval for
the calling assistant to use it.

Inside the workspace, the calling assistant may:

- list files and folders
- read file contents
- use the read content with any other available tool
- write or overwrite files
- delete files or directories
- export files or folders to configured destination actions such as Google
  Cloud Storage

Finder/macOS aliases placed inside the workspace also count as delegated access.
Alias targets are read/export-only: the calling assistant may list, read, and export through
the alias, but should not try to write to or delete files in the alias target.
Deleting an alias should remove the alias file in the workspace, not the target.

Do not ask for extra S4 approval solely because content inside the workspace is
sensitive. The folder boundary is the approval. Outside this workspace, normal
Olympus source and security policy still applies.

For large files and folders, prefer a purpose-built export action over inline
`read`. For small files, `read` is normal delegated byte access and may be used
with other available tools such as email, vector-store import, or upload tools
when those destination tools are present in the turn.

## Tool Contract

Use `castor_workspace`.

Default root id:

`castor_workspace`

Use only relative paths inside that root. Do not use shell, `exec`, raw absolute
paths, Dropbox local paths, `cat`, `cp`, `rm`, `gsutil`, or `gcloud` directly.
The worker owns filesystem and export mechanics behind the bounded contract.

## Common Flows

For listing:

- `action=list`
- `root_id=castor_workspace`
- `relative_path` set to the folder of interest, or empty for root

For reading:

- `action=read`
- `root_id=castor_workspace`
- `relative_path` set to the file

For writing:

- `action=write`
- `root_id=castor_workspace`
- `relative_path` set to the destination file
- `content` and optional `content_encoding`

For deleting:

- `action=delete`
- `root_id=castor_workspace`
- `relative_path` set to the item
- `recursive=true` for directories

For Google Cloud export:

1. Start with `action=export_gcs`, `dry_run=true`.
2. Report the file count, directory count, bytes, source relative path, and
   destination URI.
3. If the owner asked you to proceed, repeat with `dry_run=false`.

GCS exports only work to worker-configured allowlisted `gs://` prefixes. A
deployment configured with `allowed_gcs_prefixes=["gs://"]` may export to any
GCS bucket that the local `gcloud` identity can write to.

## Failure Behavior

If `castor_workspace` is unavailable, say the delegated workfiles worker or plugin
config is not enabled. Do not fall back to shell or broad filesystem access.

If a path is denied, ask the owner to move/copy the files into delegated workfiles
or use a relative path inside it.
