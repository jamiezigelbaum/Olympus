#!/usr/bin/env python3
"""Local/private Telegram connector setup helper for Olympus.

1Password is the only static secret authority for Telegram API material.
This helper reads api_id/api_hash through the Olympus credential broker, creates the local
Telethon session under ~/.local/share/olympus, and lists chat ids so the owner can
approve one bounded Olympus chat scope.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
from pathlib import Path


ACCOUNT = "telegram.personal"
DEFAULT_1PASSWORD_VAULT = "Olympus Secure"
DEFAULT_1PASSWORD_ITEM = "Telegram-Olympus-Reader"
DEFAULT_API_ID_FIELDS = ("App api_id", "api_id", "API ID")
DEFAULT_API_HASH_FIELDS = ("App api_hash", "api_hash", "API hash")
DEFAULT_BROKER_READ = Path.home() / ".openclaw/bin/op-cached-read"
SESSION_BASE = Path.home() / ".local/share/olympus/telegram/telegram.personal"
SESSION_FILE = SESSION_BASE.parent / f"{SESSION_BASE.name}.session"
VENVS_DIR = Path.home() / ".local/share/olympus/venvs"
TELEGRAM_DIR = Path.home() / ".local/share/olympus/telegram"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Set up the local Olympus Telegram connector.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("configure", help="Verify the Telegram API item is readable from 1Password.")

    authorize = subparsers.add_parser("authorize", help="Create or refresh the local Telethon session.")
    authorize.add_argument("--phone", help="Telegram phone number with country code. If omitted, prompts locally.")

    list_chats = subparsers.add_parser("list-chats", help="List recent Telegram chats and their ids.")
    list_chats.add_argument("--limit", type=int, default=50)

    subparsers.add_parser("doctor", help="Check local connector readiness without printing secrets.")

    args = parser.parse_args(argv)
    ensure_private_dirs()
    if args.command == "configure":
        return configure()
    if args.command == "authorize":
        return run_async(authorize_session(args.phone))
    if args.command == "list-chats":
        return run_async(list_chats_command(args.limit))
    if args.command == "doctor":
        return doctor()
    raise AssertionError(args.command)


def ensure_private_dirs() -> None:
    for path in (TELEGRAM_DIR, VENVS_DIR):
        path.mkdir(parents=True, exist_ok=True)
        ensure_private_mode(path)


def ensure_private_mode(path: Path) -> None:
    try:
        os.chmod(path, 0o700)
    except PermissionError:
        if path.stat().st_mode & 0o777 == 0o700:
            return
        raise


def configure() -> int:
    try:
        load_credentials()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("Found telegram.personal API material in 1Password.")
    print("Nothing was copied to macOS Keychain.")
    return 0


async def authorize_session(phone: str | None) -> int:
    api_id, api_hash = load_credentials()
    entered_phone = phone or input("Telegram phone number, including country code: ").strip()
    if not entered_phone:
        print("Telegram phone number is required.", file=sys.stderr)
        return 2
    TelegramClient = import_telegram_client()
    async with TelegramClient(str(SESSION_BASE), int(api_id), api_hash) as client:
        await client.start(phone=entered_phone)
        me = await client.get_me()
        safe_name = getattr(me, "username", None) or getattr(me, "id", "unknown")
    print(f"Authorized local Telethon session for telegram.personal: {safe_name}")
    print(f"Session base path: {SESSION_BASE}")
    return 0


async def list_chats_command(limit: int) -> int:
    api_id, api_hash = load_credentials()
    TelegramClient = import_telegram_client()
    async with TelegramClient(str(SESSION_BASE), int(api_id), api_hash) as client:
        if not await client.is_user_authorized():
            print("telegram.personal is not authorized. Run authorize first.", file=sys.stderr)
            return 2
        print("chat_id\tchat_name")
        async for dialog in client.iter_dialogs(limit=max(1, min(limit, 200))):
            name = safe_one_line(getattr(dialog, "name", "") or "")
            print(f"{dialog.id}\t{name}")
    return 0


def doctor() -> int:
    broker_ok = broker_available()
    api_id = read_1password_field(candidate_api_id_fields(), missing_ok=True) if broker_ok else ""
    api_hash = read_1password_field(candidate_api_hash_fields(), missing_ok=True) if broker_ok else ""
    checks = [
        ("credential_broker", broker_ok),
        ("api_id_1password", bool(api_id)),
        ("api_hash_1password", bool(api_hash)),
        ("session_file", SESSION_FILE.exists()),
    ]
    try:
        import_telegram_client()
        checks.append(("telethon_import", True))
    except RuntimeError:
        checks.append(("telethon_import", False))

    ok = True
    for name, passed in checks:
        ok = ok and passed
        print(f"{name}: {'ok' if passed else 'missing'}")
    print(f"reader_wrapper: {Path(__file__).with_name('telegram-1password-reader.zsh')}")
    print("scope_format: telegram.personal:chat:<chat-id>")
    return 0 if ok else 1


def load_credentials() -> tuple[str, str]:
    api_id = read_1password_field(candidate_api_id_fields())
    api_hash = read_1password_field(candidate_api_hash_fields())
    if not api_id.isdigit():
        raise RuntimeError("Telegram API ID from 1Password is not numeric.")
    if not api_hash:
        raise RuntimeError("Telegram API hash from 1Password is empty.")
    return api_id, api_hash


def candidate_api_id_fields() -> list[str]:
    return candidate_fields("OLYMPUS_TELEGRAM_1PASSWORD_API_ID_FIELD", DEFAULT_API_ID_FIELDS)


def candidate_api_hash_fields() -> list[str]:
    return candidate_fields("OLYMPUS_TELEGRAM_1PASSWORD_API_HASH_FIELD", DEFAULT_API_HASH_FIELDS)


def candidate_fields(env_key: str, defaults: tuple[str, ...]) -> list[str]:
    configured = os.environ.get(env_key, "").strip()
    fields = [configured] if configured else []
    for field in defaults:
        if field not in fields:
            fields.append(field)
    return fields


def read_1password_field(fields: list[str], *, missing_ok: bool = False) -> str:
    vault = os.environ.get("OLYMPUS_1PASSWORD_VAULT", DEFAULT_1PASSWORD_VAULT).strip()
    item = os.environ.get("OLYMPUS_TELEGRAM_1PASSWORD_ITEM", DEFAULT_1PASSWORD_ITEM).strip()
    last_error = ""
    for field in fields:
        reference = f"op://{vault}/{item}/{field}"
        try:
            result = subprocess.run(
                [broker_read_command(), reference],
                env=broker_env(),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        except FileNotFoundError as error:
            raise RuntimeError("Olympus credential broker client is not installed.") from error
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        last_error = safe_one_line(result.stderr)
    if missing_ok:
        return ""
    raise RuntimeError(
        f"Could not read Telegram API field through the credential broker for item '{item}' in vault '{vault}'. "
        f"Tried: {', '.join(fields)}."
    )


def broker_available() -> bool:
    try:
        result = subprocess.run(
            [broker_read_command(), "--health"],
            env=broker_env(),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError:
        return False
    return result.returncode == 0


def broker_read_command() -> str:
    return os.environ.get("OLYMPUS_OP_BROKER_READ_BIN", str(DEFAULT_BROKER_READ)).strip()


def broker_env() -> dict[str, str]:
    env = os.environ.copy()
    env["OLYMPUS_OP_BROKER_CALLER"] = "telegram-reader"
    return env


def import_telegram_client():
    try:
        from telethon import TelegramClient
    except Exception as error:
        raise RuntimeError("Telethon is not installed in this Python environment.") from error
    return TelegramClient


def run_async(awaitable) -> int:
    try:
        return asyncio.run(awaitable)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1


def safe_one_line(value: str) -> str:
    return " ".join(value.split())


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
