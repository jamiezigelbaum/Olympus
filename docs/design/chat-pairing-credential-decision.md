# Dashboard chat pairing: credential decision

The requested dashboard flow keeps Telegram credentials and login challenges on
loopback and out of logs. Login codes and 2FA passwords can be discarded after
use. The API ID and hash are also needed when the capture reader starts again:
`scripts/telegram-telethon-reader.py` constructs Telethon clients with both.
The current pairing stores them in Olympus's secret store, which defaults to an
encrypted file, and the capture supervisor retrieves them on restart.

The requested rule that values are never written to disk except Telethon's own
session file conflicts with that existing persistence. Before implementing the
credential path, the owner needs to choose whether the existing encrypted secret
store is permitted for the API ID and hash, or whether users must supply them
again after a restart. The latter also needs a way for capture to remain stopped
until the dashboard receives them. Neither option sends credentials to the relay
or ChatGPT.

Planned screens: Telegram and WhatsApp dashboard source cards, including
pairing progress, Telegram credential prompts, WhatsApp QR, and chat selection.
Chat selection controls capture scope, not item privacy classification. The
existing whole-account regression test is retained as a failing specification;
no pairing or capture behavior has been changed in this draft.
