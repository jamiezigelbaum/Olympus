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

## Licensing — build from source only

whatsmeow is MPL-2.0 and pulls in `go.mau.fi/libsignal`, which is GPL-3.0.
Olympus ships this bridge as source and builds it on the user's computer
(`buildWhatsAppBridge` in `src/core/messaging-pairing.ts`), which keeps the
rest of Olympus under MIT. Never publish or host a prebuilt bridge binary: a
binary that links libsignal is a GPL-3.0 work that needs the GPL text and a
source offer.

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
    capture-status.json  # connected or not, last connected time, dropped-message count
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

Non-text payloads add `"media_type":"image"` (or
`video`, `audio`, `document`, `sticker`, `contact`, `location`, `poll`,
`reaction`, `event`, `video_note`). A photo, video, video note or document
carries its caption as `"text"` (empty when it has none, and on every other
media type).

Voice notes, pictures, videos and video notes are saved in the state dir's
`media/audio`, `media/images` and `media/video`, whatever their size, with no
quota: every piece of media is kept. Each download streams into a temp file,
never into memory. The one safeguard is the computer's: below a free-space
floor on the volume (the larger of 5 GB and 5% of it) no download starts and
a running one stops; the message is still spooled with `"download_status":
"waiting_for_disk"`, and what the download needs (never the message's words)
is kept in `media/waiting/`. The media is downloaded only once Olympus has
judged the message not Secret and written a grant beside the entry
(`<stem>.grant`, the judged line and its digest); then, once there is room
again (checked every minute), the message is spooled again from that line
with its media. `capture-status.json` says `"media_waiting_for_disk": true`
meanwhile. A saved file's line carries `media_path`, `media_mime` and
`download_status`. Olympus reads a saved picture or video as its message's
child, and deletes it when the picture is judged Secrets.

Only the newest spool file ever grows;
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

For a packaged Olympus install, use `olympus connect whatsapp --pair`. Its
private terminal shows only the current QR and replaces it when WhatsApp
refreshes the handshake. Expired codes are removed from view. Authentication
and persisted-device proof must succeed before Olympus asks for capture scope.
The bridge pins an upstream revision containing the September 2026 companion
registration refresh support. Passkey-required linking is reported explicitly;
this terminal flow does not implement browser passkey verification. Fixed,
content-free results are saved in `pairing-status.json` for diagnosis, without
account identifiers, keys, QR payloads, or provider response bodies.

The older direct-daemon flow below is for advanced manual deployments:

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

## Command-line modes

- No flags: the historic daemon. It pairs by QR when the session store is
  empty, then captures every chat.
- `--pair-only`: what `olympus connect whatsapp --pair` runs. It pairs (or
  verifies the existing link), prints JSON events on stdout (`qr` with the
  private PNG path, then `ready` with the authentication proof), records a
  content-free result in `pairing-status.json`, and exits without capturing.
  It ignores the native-capture switch and creates no spool. A failure exits
  non-zero with `olympus-whatsapp-bridge: <code>` on stderr.
  `OLYMPUS_WHATSAPP_PAIR_TTY_QR=false` keeps the QR out of the terminal.
- `--capture-approved`: captures only the chats listed in
  `OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS` (comma-separated chat JIDs, or `*` for
  the whole linked account). A missing or malformed list exits before any state
  is touched. Messages, reactions and voice notes from other chats are dropped
  before any download or spool write. It combines with native capture.
- `--pair-only --capture-approved` is refused (`incompatible_modes`).

## Native capture mode (managed service)

`OLYMPUS_WHATSAPP_NATIVE_CAPTURE=true` turns the same binary into a managed
capture service whose startup is provable to its owner. It is off by default,
and **a service instance nonce alone never enables it**:

- `OLYMPUS_WHATSAPP_NATIVE_CAPTURE=true` — the explicit switch. Only `1`,
  `true`, `yes`, or `on` (case-insensitive) enable native capture; anything
  else, including a nonce left in the environment by a source worker, leaves
  the daemon in the ordinary manual pairing path.
- `OLYMPUS_NATIVE_SERVICE_INSTANCE_ID` — required **only** in native mode, and
  it must be a canonical lower-case UUID (`8-4-4-4-12`, lower-case hex). An
  unset, upper-case, braced, or otherwise non-canonical nonce is refused before
  the state dir, session store, or provider is touched, and the refused value
  is never echoed to logs. In ordinary mode the same variable is ignored.

Native mode **never** starts QR pairing or a login flow. If `session.db` has no
paired device, startup fails categorically with an actionable error telling the
operator to pair manually first; run once without the switch, scan the QR, then
start the service again. A paired store is reused exactly like an ordinary
restart — same spool, cursors, media, reactions, sends/read-receipt policy, and
auto-reconnect behaviour.

After the provider has authenticated the reused session and reported
`Connected`, the daemon publishes `${OLYMPUS_WHATSAPP_STATE_DIR}/native-service-readiness.json`
atomically (temp file + rename) with mode `0600`:

```json
{"kind":"whatsapp_capture_service_readiness","instance_id":"019f6ff4-…","pid":12345,"paired":true,"connected":true}
```

The receipt is process identity only — no phone number, JID, device keys, or
captured content. It is written strictly after authentication, so it can never
outrun the provider handshake. If the receipt cannot be written, startup fails
categorically rather than advertising a service that is not actually ready.

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
- `spool/capture-status.json` is rewritten every minute and on each connect
  or disconnect: `connected`, `connected_through` (the last time capture knew
  it was connected) and `dropped_messages` (messages a full spool queue
  dropped, carried across restarts) with `last_dropped_at`. It holds counts
  and times only. Olympus reads it to tell a quiet account from a stopped
  capture and to report drops.
- Restarts may re-deliver recent offline messages, producing duplicate spool
  lines. Downstream ingest upserts on the WhatsApp message id, so duplicates
  collapse harmlessly.
- Group chats spool with an empty `chat_name` (resolving group subjects would
  need live metadata queries; the connector falls back to the chat JID).
- Voice notes, pictures and videos are downloaded into the private local media
  folders (above); no media or message content leaves the host through this
  bridge.

New pairings advertise the linked-device name **Olympus Plugin** using the desktop device type.

If WhatsApp requests interactive passkey authentication, this headless bridge
removes its stale QR and stops with an explicit unsupported-flow message.
It does not synthesize authenticator responses or bypass phone consent.
