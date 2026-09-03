# Olympus Uninstall and Data Deletion

Olympus separates stopping/removing its supervised worker from deleting user
data. The lifecycle command is safe to rerun and retains credentials, source
configuration, indexes, embeddings, caches, and reports:

```bash
olympus worker uninstall
olympus worker status
```

Status should report the service unit as missing while the worker environment
may remain present. Use the data lifecycle below only when the goal is a clean,
destructive uninstall.

## Preview Removal

```bash
olympus data delete --all --dry-run
```

The dry run prints the known files and directories Olympus would remove and
the worker-custody prerequisite. Stop or uninstall the supervised worker before
executing delete-all; the command refuses active, failed, or unknown service
state rather than deleting underneath an open store.

## Delete Local Olympus Data

```bash
olympus data delete --all
```

Interactive delete-all requires two typed confirmations:

1. `DELETE OLYMPUS DATA`
2. `DELETE EVERYTHING`

Automated tests may use:

```bash
olympus data delete --all --yes-i-am-sure
```

The delete-all command removes Olympus indexes, embeddings, caches, local report
files, secret-store files, handle registries, and generated launchd/systemd
worker units that match Olympus-owned names.

To remove only one connected source:

```bash
olympus data delete --source dropbox.files --dry-run
# Use Disconnect in the local dashboard.
olympus data delete --source dropbox.files
```

The preview is available while connected and reports that execution is not yet
ready. The destructive command requires the source's local connected-handle
registry to prove it is disconnected. Disconnect stops scheduled and manual
reads and retains indexed data; the CLI is the separate boundary that removes
those bytes.

## Remove The Plugin

After local data is deleted, remove the plugin with the host OpenClaw plugin
manager:

```bash
openclaw plugins uninstall olympus
```

The supported lifecycle owns launchd and user-systemd details; normal removal
does not require direct service-manager commands, raw environment edits, or
manual unit-file surgery. If an older hand-authored unit exists outside the
known Olympus locations, inspect and remove that separately rather than
expanding the data command's custody.
