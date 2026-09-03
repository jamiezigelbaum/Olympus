# olympus-whatsapp-bridge

Read-only personal-WhatsApp capture daemon. Connects as a **linked device**
via [whatsmeow](https://github.com/tulir/whatsmeow) and appends every incoming
and outgoing text message to a local JSONL spool. The TypeScript connector
(`src/workers/whatsapp/live-connector.ts`) reads the spool; the shared
connector-store machinery does storage and search. Nothing else in Olympus
talks to WhatsApp.

## Risk note — read this once

This uses an **unofficial client** (whatsmeow) paired as a linked device.
WhatsApp's terms do not allow third-party clients, and accounts have been
banned for using them. The owner reviewed and **explicitly accepted this risk**
(2026-06). Mitigations baked into the daemon: it is strictly receive-only —
no message sends, no read receipts beyond protocol minimums, no presence
broadcasting, no control surface (no sockets, no HTTP, no IPC). If WhatsApp
logs the device out, the daemon exits and waits to be re-paired; it never
retries in a way that looks like automation.

## Build

Requires Go ≥ 1.26 and a C compiler (the session store uses
`mattn/go-sqlite3`, which is CGO).

```sh
# Debian/Ubuntu host
sudo apt-get install -y golang gcc            # or install Go from go.dev
cd tools/whatsapp-bridge
CGO_ENABLED=1 go build -o olympus-whatsapp-bridge .
```

Dependencies resolve from the public module proxy (`go.mod`/`go.sum` are
committed; nothing is vendored).

## State directory

`$OLYMPUS_WHATSAPP_STATE_DIR`, default `~/.local/share/olympus/whatsapp-live`:

```
whatsapp-live/
  session.db          # whatsmeow device/session store (sqlite, secret material)
  qr.txt              # pairing QR (ASCII), present only while pairing
  spool/
    2026-06-11.jsonl  # one JSON object per message, named by receive date (UTC)
```

Spool line shape (field names are a contract with the TypeScript connector):

```json
{"id":"3EB0...","chat_jid":"123@s.whatsapp.net","chat_name":"Ada",
 "sender_jid":"123@s.whatsapp.net","sender_name":"Ada","from_me":false,
 "timestamp":"2026-06-11T15:04:05Z","text":"https://maps.example/place",
 "preview_title":"Barouk","preview_description":"Meet near lx factory",
 "preview_url":"https://maps.example/place"}
```

`preview_title`, `preview_description`, and `preview_url` are optional,
control-character-free link-preview strings carried by WhatsApp itself. They
are byte-bounded (256/1024/1024 respectively); `preview_url` is the protocol's
matched text, not a network-resolved canonical URL. The bridge never fetches
preview URLs or thumbnail/binary preview payloads.

Non-text payloads keep `"text":""` and add `"media_type":"image"` (or
`video`, `audio`, `document`, `sticker`, `contact`, `location`, `poll`,
`reaction`, `event`, `video_note`). Only the newest spool file ever grows;
the daemon fsyncs after every batch. `session.db` holds the device keys —
treat the whole state dir as secret (`0700`).

A `"media_type":"reaction"` line is a fact about ANOTHER message, and carries
`reaction_target_id`, `reaction_target_chat_jid`, `reaction_key` (the emoji,
control-character-free and bounded to 64 bytes so it fits the store's 64-char
token cap), `reaction_removed` (true when the reactor took it back — an empty
key is never used to mean removal), and `reaction_sender_timestamp_ms`. The
daemon counts nothing and keeps no reaction state: the connector aggregates
these lines over the whole spool and attaches the result to the message that
was reacted to.

## First run: pairing

1. Start the daemon in a terminal: `./olympus-whatsapp-bridge`
2. It prints a QR code to stdout and writes the same code to
   `$STATE_DIR/qr.txt` (plain text — `cat` it over SSH if the terminal
   mangled the blocks). Codes rotate roughly every 20 seconds; the file is
   rewritten each time.
3. On the phone: **WhatsApp > Settings > Linked Devices > Link a Device**,
   scan the code.
4. On success the daemon logs `paired successfully`, deletes `qr.txt`, and
   starts spooling. Subsequent starts reuse `session.db` — no QR needed.

If pairing times out before a scan, the daemon exits; just start it again.
If the phone ever removes the linked device, the daemon exits with a
"logged out" message — delete nothing, restart it, and pair again.

## Run as a service (systemd)

The private host uses the repo-owned user-systemd installer. It runs the Go tests,
builds the checked-in source to a candidate binary, atomically installs it,
preserves the existing linked-device state, tightens session-file modes, and
enables the capture producer for login/reboot recovery:

```sh
bash scripts/ops/install-private-host-whatsapp-bridge-systemd.sh
systemctl --user status olympus-whatsapp-bridge.service --no-pager
```

Do not hand-create a root unit under `/etc/systemd/system`; the Olympus runtime
refresh owns this user service and its installed binary. On an unpaired first
run, the service keeps the QR out of the journal and writes the rotating code
to `$STATE_DIR/qr.txt`. Read that file locally and scan it with WhatsApp Linked
Devices. `Restart=always` covers the fatal-exit paths (logged out, stream
replaced, spool write failure) — the daemon is deliberately crash-only.

## Operational notes

- Reconnects: transient drops are retried by whatsmeow's built-in
  auto-reconnect with backoff; initial connection failures retry with
  exponential backoff (2s → 5m cap).
- Restarts may re-deliver recent offline messages, producing duplicate spool
  lines. Downstream ingest upserts on the WhatsApp message id, so duplicates
  collapse harmlessly.
- Group chats spool with an empty `chat_name` (resolving group subjects would
  need live metadata queries; the connector falls back to the chat JID).
- Audio messages are downloaded into the private bounded local media cache for
  the local transcription lane. Other media keeps metadata only; no media or
  message content leaves the host through this bridge.
