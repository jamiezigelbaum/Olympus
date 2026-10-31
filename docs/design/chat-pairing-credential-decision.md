# Dashboard chat pairing: credential decision

The requested dashboard flow keeps Telegram credentials and login challenges on
loopback and out of logs. Login codes and 2FA passwords can be discarded after
use. The API ID and hash are also needed when the capture reader starts again:
`scripts/telegram-telethon-reader.py` constructs Telethon clients with both.
The current pairing stores them in Olympus's secret store, which defaults to an
encrypted file, and the capture supervisor retrieves them on restart.

Owner decision, 2026-10-31: retain the API ID and hash in the existing encrypted
secret store. Login codes and 2FA passwords stay in memory only; neither these
nor the API credentials pass through the relay or ChatGPT. Language runtime
strings cannot guarantee physical zeroing, so each process releases its
references immediately after use.

Planned screens: Telegram and WhatsApp dashboard source cards, including
pairing progress, Telegram credential prompts, WhatsApp QR, and chat selection.
Chat selection controls capture scope, not item privacy classification. The
existing whole-account regression test is retained as a specification.
