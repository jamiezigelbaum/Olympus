#!/usr/bin/env python3
"""Interactive, local-only Telegram pairing for the public Olympus package.

Prompts are read from the controlling terminal so the phone number, login
code, API hash, and 2FA password never travel through argv, stdin, stdout, or
the calling agent. Stdout is reserved for one safe JSON receipt.
"""

from __future__ import annotations

import asyncio
import getpass
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, TextIO


MAX_DIALOGS = 200


class SafePairingError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def main() -> int:
    os.umask(0o077)
    try:
        receipt = asyncio.run(pair())
        sys.stdout.write(json.dumps(receipt, separators=(",", ":")) + "\n")
        return 0
    except SafePairingError as error:
        sys.stderr.write(json.dumps({"error": error.code}, separators=(",", ":")) + "\n")
        return 2
    except Exception:
        sys.stderr.write('{"error":"telegram_pairing_failed"}\n')
        return 1


async def pair() -> dict[str, Any]:
    session_base = required_session_base()
    session_base.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(session_base.parent, 0o700)

    try:
        from telethon import TelegramClient
        from telethon.errors import SessionPasswordNeededError
    except Exception as error:
        raise SafePairingError("telethon_not_installed") from error

    with controlling_terminal() as terminal:
        api_id_text = prompt(terminal, "Telegram app api_id: ")
        if not api_id_text.isdigit() or int(api_id_text) <= 0:
            raise SafePairingError("invalid_api_id")
        api_hash = prompt_secret(terminal, "Telegram app api_hash: ")
        if not api_hash:
            raise SafePairingError("invalid_api_hash")

        client = TelegramClient(str(session_base), int(api_id_text), api_hash)
        await client.connect()
        try:
            if not await client.is_user_authorized():
                phone = prompt(terminal, "Telegram phone number (with country code): ")
                if not phone:
                    raise SafePairingError("phone_required")
                await client.send_code_request(phone)
                code = prompt_secret(terminal, "Telegram login code: ")
                if not code:
                    raise SafePairingError("login_code_required")
                try:
                    await client.sign_in(phone=phone, code=code)
                except SessionPasswordNeededError:
                    password = prompt_secret(terminal, "Telegram 2FA password: ")
                    if not password:
                        raise SafePairingError("two_factor_password_required")
                    await client.sign_in(password=password)

            if not await client.is_user_authorized():
                raise SafePairingError("authorization_not_confirmed")
            me = await client.get_me()
            user_id = getattr(me, "id", None)
            if not isinstance(user_id, int) or user_id <= 0:
                raise SafePairingError("account_not_confirmed")

            dialogs: list[dict[str, Any]] = []
            async for dialog in client.iter_dialogs(limit=MAX_DIALOGS):
                entity = dialog.entity
                if bool(getattr(dialog, "is_user", False)):
                    kind = "bot" if bool(getattr(entity, "bot", False)) else "dm"
                elif bool(getattr(dialog, "is_channel", False)) and not bool(
                    getattr(entity, "megagroup", False)
                ):
                    kind = "channel"
                else:
                    kind = "group"
                dialog_id = getattr(dialog, "id", None)
                if not isinstance(dialog_id, int):
                    continue
                dialogs.append(
                    {
                        "chat_scope": f"telegram.personal:chat:{dialog_id}",
                        "kind": kind,
                        "title": safe_one_line(str(getattr(dialog, "name", "") or ""))[:120],
                    }
                )
        finally:
            await client.disconnect()

    session_file = Path(f"{session_base}.session")
    try:
        session_file.stat()
    except OSError as error:
        raise SafePairingError("session_not_persisted") from error
    if not session_file.is_file():
        raise SafePairingError("session_not_persisted")
    os.chmod(session_file, 0o600)
    journal_file = Path(f"{session_base}.session-journal")
    if journal_file.exists():
        os.chmod(journal_file, 0o600)
    transfer_credentials({"api_id": int(api_id_text), "api_hash": api_hash})

    return {
        "event": "ready",
        "status": "ready",
        "session_path": str(session_base),
        "proof": {
            "authorized": True,
            "account_ref": hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()[:16],
            "session_persisted": True,
            "credentials_transferred": True,
        },
        "dialogs": dialogs,
        "capture_started": False,
    }


def transfer_credentials(value: dict[str, Any]) -> None:
    try:
        with os.fdopen(3, "w", encoding="utf-8", closefd=False) as output:
            json.dump(value, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
    except OSError as error:
        raise SafePairingError("credential_transfer_failed") from error


def required_session_base() -> Path:
    value = os.environ.get("OLYMPUS_TELEGRAM_SESSION_PATH", "").strip()
    if not value:
        raise SafePairingError("session_path_required")
    if value.endswith(".session"):
        value = value[: -len(".session")]
    return Path(value).expanduser().resolve()


class Terminal:
    def __init__(self, stream: TextIO) -> None:
        self.stream = stream

    def __enter__(self) -> TextIO:
        return self.stream

    def __exit__(self, *_: object) -> None:
        self.stream.close()


def controlling_terminal() -> Terminal:
    try:
        stream = open("/dev/tty", "r+", encoding="utf-8", buffering=1)
    except OSError as error:
        raise SafePairingError("controlling_terminal_required") from error
    return Terminal(stream)


def prompt(terminal: TextIO, label: str) -> str:
    terminal.write(label)
    terminal.flush()
    value = terminal.readline()
    if value == "":
        raise SafePairingError("controlling_terminal_closed")
    return value.strip()


def prompt_secret(terminal: TextIO, label: str) -> str:
    try:
        return getpass.getpass(label, stream=terminal).strip()
    except (EOFError, OSError) as error:
        raise SafePairingError("controlling_terminal_closed") from error


def safe_one_line(value: str) -> str:
    return " ".join(value.replace("\x00", "").split())


if __name__ == "__main__":
    raise SystemExit(main())
