#!/usr/bin/env python3
"""Local/private Telegram reader for Olympus.

Reads a single JSON request from stdin and writes a JSON object to stdout.
This script intentionally implements read-only operations only: message
history access (read_messages) and dialog metadata listing (list_dialogs,
for operator chat-selection — ids, kinds, titles; never message content). It
does not expose send, forward, mark-read, join, leave, or contact-management
operations.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import fcntl
import hashlib
import json
import os
import sys
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_MESSAGES_DEFAULT = 500
MAX_MESSAGES_HARD_CAP = 5000
TELEGRAM_GATEWAY_ENDPOINT_ID = "telegram_local_telethon_reader"
INTERNAL_TELEGRAM_CORPUS_ID = "internal.telegram.messages"
PROTECTED_TELEGRAM_CORPUS_ID = "secure_local.telegram.protected.messages"
EVENT_SENDER_CACHE_MAX = 1024
EVENT_LANE_COUNTER_KEYS = (
    "events_seen",
    "events_appended",
    "events_dropped_unapproved",
    "errors",
    "reactions_seen",
    "reactions_appended",
    "reactions_dropped_unapproved",
    "reactions_dropped_unresolved",
)

# Bounds mirroring src/core/source-index/reactions.ts. The store REFUSES an
# aggregate past any of them, and a refusal aborts a whole replay run, so
# capture selects down to what the store accepts instead of emitting a record
# that cannot land. Counted the way the TypeScript store counts (UTF-16 code
# units), so an emoji costs the same here as at the bound that would refuse it.
MAX_REACTION_TOKENS = 32
MAX_REACTION_KEY_CHARS = 64
MAX_REACTION_COUNT = 1_000_000
MAX_REACTION_ACTORS_PER_TOKEN = 32
MAX_REACTION_ACTOR_FIELD_CHARS = 120
MAX_REACTIONS_SERIALIZED_CHARS = 4_000
CUSTOM_REACTION_TOKEN_PREFIX = "custom:"


def main() -> int:
    try:
        if "--gateway" in sys.argv[1:]:
            asyncio.run(run_gateway("--once" in sys.argv[1:]))
            return 0
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, dict):
            raise SafeConfigError("request_must_be_object")
        operation = request.get("operation")
        if operation == "list_dialogs":
            result = asyncio.run(list_dialogs(request))
        else:
            result = asyncio.run(read_messages(request))
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
        sys.stdout.write("\n")
        return 0
    except SafeConfigError as error:
        sys.stderr.write(json.dumps({"error": error.code}, separators=(",", ":")) + "\n")
        return 2
    except Exception:
        sys.stderr.write(json.dumps({"error": "telegram_reader_failed"}, separators=(",", ":")) + "\n")
        return 1


class SafeConfigError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


async def list_dialogs(request: dict[str, Any]) -> dict[str, Any]:
    account = require_text(request, "account")
    approved_scopes = approved_dialog_scopes(request, account)
    api_id = require_int_env("OLYMPUS_TELEGRAM_API_ID")
    api_hash = require_env("OLYMPUS_TELEGRAM_API_HASH")
    session_path = require_env("OLYMPUS_TELEGRAM_SESSION_PATH")
    limit = normalize_max_messages(request.get("max_dialogs"))

    try:
        from telethon import TelegramClient
    except Exception as error:  # pragma: no cover - live runtime only
        raise SafeConfigError("telethon_not_installed") from error

    dialogs: list[dict[str, Any]] = []
    async with TelegramClient(session_path, api_id, api_hash) as client:
        provider_contacted_at = now_iso()
        async for dialog in client.iter_dialogs(limit=limit):
            entity = dialog.entity
            if dialog.is_user:
                kind = "bot" if bool(getattr(entity, "bot", False)) else "dm"
            elif dialog.is_channel and not bool(getattr(entity, "megagroup", False)):
                kind = "channel"
            else:
                kind = "group"
            chat_scope = f"{account}:chat:{dialog.id}"
            if chat_scope not in approved_scopes:
                continue
            dialogs.append({
                "chat_id": dialog.id,
                "kind": kind,
                "title": str(dialog.name or "")[:120],
                "username": getattr(entity, "username", None),
                "last_message_at": dialog.date.isoformat() if dialog.date else None,
            })
    return {
        "kind": "telegram_dialogs",
        "account": account,
        "dialog_count": len(dialogs),
        "dialogs": dialogs,
        "provider_contacted_at": provider_contacted_at,
        "raw_source_exposed": False,
    }


async def read_messages(request: dict[str, Any]) -> dict[str, Any]:
    if request.get("operation") != "read_messages":
        raise SafeConfigError("unsupported_operation")

    chat_scope = require_text(request, "chat_scope")
    account = require_text(request, "account")
    provider_cursor = optional_text(request.get("provider_cursor"))
    sync_direction = sync_direction_from_request(request.get("sync_direction"), provider_cursor)
    chat_id = chat_id_from_scope(chat_scope)
    assert_chat_scope_allowed(chat_scope)

    api_id = require_int_env("OLYMPUS_TELEGRAM_API_ID")
    api_hash = require_env("OLYMPUS_TELEGRAM_API_HASH")
    session_path = require_env("OLYMPUS_TELEGRAM_SESSION_PATH")
    max_messages = normalize_max_messages(request.get("max_messages"))
    try:
        from telethon import TelegramClient
    except Exception as error:  # pragma: no cover - exercised only in live runtime
        raise SafeConfigError("telethon_not_installed") from error

    async with TelegramClient(session_path, api_id, api_hash) as client:
        return await read_messages_with_client(
            client, account, chat_id, provider_cursor, sync_direction, max_messages
        )


async def read_messages_with_client(
    client: Any,
    account: str,
    chat_id: str | int,
    provider_cursor: str | None,
    sync_direction: str,
    max_messages: int,
) -> dict[str, Any]:
    offset_id = offset_id_from_cursor(provider_cursor) if sync_direction == "backfill" else 0
    min_id = min_id_from_cursor(provider_cursor) if sync_direction == "forward" else 0
    entity = await client.get_entity(chat_id)
    chat_title = chat_title_from_entity(entity)
    chat_type = chat_type_from_entity(entity)
    provider_contacted_at = gateway_now_iso()
    messages = []
    newest_id = None
    oldest_id = None
    oldest_date = None
    reverse = bool(sync_direction == "forward" and min_id > 0)
    sender_display_names: dict[str, str] = {}
    async for message in client.iter_messages(
        entity,
        limit=max_messages,
        offset_id=offset_id,
        min_id=min_id,
        reverse=reverse,
    ):
        normalized = normalize_message(message, account, str(chat_id), chat_title, chat_type)
        sender_id = normalized.get("senderId")
        if isinstance(sender_id, str):
            display_name = sender_display_names.get(sender_id)
            if display_name is None:
                try:
                    display_name = display_name_from_entity(await message.get_sender())
                except Exception:
                    display_name = None
                if display_name:
                    sender_display_names[sender_id] = display_name
            if display_name:
                normalized["senderDisplayName"] = display_name
                normalized["participantDisplayNames"] = {sender_id: display_name}
        messages.append(normalized)
        message_id = int(normalized["id"])
        newest_id = message_id if newest_id is None else max(newest_id, message_id)
        oldest_id = message_id if oldest_id is None else min(oldest_id, message_id)
        date_value = normalized.get("sentAt")
        if isinstance(date_value, str):
            oldest_date = date_value if oldest_date is None else min(oldest_date, date_value)

    result: dict[str, Any] = {
        "messages": messages,
        "providerContactedAt": provider_contacted_at,
        "coverageEnd": provider_contacted_at,
        "syncDirection": sync_direction,
    }
    if oldest_date:
        result["coverageStart"] = oldest_date
    if sync_direction == "forward" and newest_id is not None:
        result["providerCursor"] = f"min_id:{newest_id}"
    elif sync_direction == "backfill" and oldest_id is not None:
        result["providerCursor"] = f"offset_id:{oldest_id}"
    if newest_id is not None:
        result["sourceVersion"] = f"telethon:{newest_id}"
    return result


@dataclass(frozen=True)
class GatewayConfig:
    account: str
    approved_scopes: tuple[str, ...]
    classifications: dict[str, dict[str, str]]
    state_dir: Path
    spool_dir: Path
    state_path: Path
    report_path: Path
    backfill_path: Path
    max_messages: int
    interval_seconds: int
    stale_threshold_seconds: int


async def run_gateway(run_once: bool = False) -> None:
    config = gateway_config()
    api_id = require_int_env("OLYMPUS_TELEGRAM_API_ID")
    api_hash = require_env("OLYMPUS_TELEGRAM_API_HASH")
    session_path = require_env("OLYMPUS_TELEGRAM_SESSION_PATH")
    try:
        from telethon import TelegramClient, events
        from telethon.tl.types import UpdateMessageReactions
    except Exception as error:  # pragma: no cover - live runtime only
        raise SafeConfigError("telethon_not_installed") from error

    config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    config.spool_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(config.state_dir, 0o700)
    os.chmod(config.spool_dir, 0o700)
    with gateway_process_lock(config.state_dir / "gateway.lock"):
        state = read_gateway_state(config.state_path)
        state_lock = asyncio.Lock()
        sender_cache_lock = asyncio.Lock()
        sender_display_names: OrderedDict[str, str | None] = OrderedDict()
        reaction_entities: dict[str, Any] = {}
        async with TelegramClient(session_path, api_id, api_hash) as client:
            event_scopes, event_entities = await resolve_gateway_event_scopes(client, config)

            async def capture_new_message(event: Any) -> None:
                await capture_gateway_event(
                    event,
                    config,
                    state,
                    state_lock,
                    event_scopes,
                    event_entities,
                    sender_display_names,
                    sender_cache_lock,
                )

            async def capture_reaction(update: Any) -> None:
                await capture_gateway_reaction(
                    update,
                    client,
                    config,
                    state,
                    state_lock,
                    event_scopes,
                    event_entities,
                    reaction_entities,
                    sender_display_names,
                    sender_cache_lock,
                )

            client.add_event_handler(capture_new_message, events.NewMessage())
            # A reaction is delivered as a bare update, never as a message, so
            # the new-message lane cannot see one. It rides its own raw handler
            # and its own counters; the message lane above is untouched.
            client.add_event_handler(capture_reaction, events.Raw(types=[UpdateMessageReactions]))
            while True:
                event_appended_before_cycle = gateway_event_lane_appended(state)
                # Give callbacks already queued by Telethon a chance to land before
                # the reconcile sweep snapshots its per-scope forward cursors.
                await asyncio.sleep(0)
                captured = 0
                for chat_scope in config.approved_scopes:
                    cursor = state["forward_cursors"].get(chat_scope)
                    page = await read_messages_with_client(
                        client,
                        config.account,
                        chat_id_from_scope(chat_scope),
                        cursor,
                        "forward",
                        config.max_messages,
                    )
                    async with state_lock:
                        page = forward_page_after_cursor(
                            page,
                            state["forward_cursors"].get(chat_scope),
                        )
                        appended = append_gateway_page(config, chat_scope, page, "forward")
                        captured += appended
                        if appended:
                            advance_forward_cursor(
                                state,
                                chat_scope,
                                newest_message_id(page),
                            )
                        state["cycles"] += 1
                        write_json_atomic(config.state_path, state)

                captured += await process_backfill_requests(client, config, state, state_lock)
                captured += max(
                    0,
                    gateway_event_lane_appended(state) - event_appended_before_cycle,
                )
                report = gateway_report(config, state, captured)
                write_json_atomic(config.report_path, report)
                sys.stdout.write(json.dumps(report, separators=(",", ":")) + "\n")
                sys.stdout.flush()
                if run_once:
                    return
                await asyncio.sleep(config.interval_seconds)


async def resolve_gateway_event_scopes(
    client: Any,
    config: GatewayConfig,
) -> tuple[dict[str, str], dict[str, Any]]:
    scopes: dict[str, str] = {}
    entities: dict[str, Any] = {}
    for chat_scope in config.approved_scopes:
        chat_ref = chat_id_from_scope(chat_scope)
        if isinstance(chat_ref, int):
            scopes[str(chat_ref)] = chat_scope
            continue
        try:
            entity = await client.get_entity(chat_ref)
            event_chat_id = await client.get_peer_id(entity)
        except Exception:
            # The periodic sweep remains the reconciliation path when an alias
            # cannot be resolved for event delivery at startup.
            continue
        scopes.setdefault(str(event_chat_id), chat_scope)
        entities[chat_scope] = entity
    return scopes, entities


async def capture_gateway_event(
    event: Any,
    config: GatewayConfig,
    state: dict[str, Any],
    state_lock: asyncio.Lock,
    event_scopes: dict[str, str],
    event_entities: dict[str, Any],
    sender_display_names: OrderedDict[str, str | None],
    sender_cache_lock: asyncio.Lock,
) -> None:
    async with state_lock:
        gateway_event_lane(state)["events_seen"] += 1
    try:
        chat_scope = event_scopes.get(str(getattr(event, "chat_id", "")))
        if not chat_scope:
            async with state_lock:
                gateway_event_lane(state)["events_dropped_unapproved"] += 1
            return

        message = getattr(event, "message", None)
        if message is None:
            raise SafeConfigError("invalid_gateway_event")
        entity = getattr(event, "chat", None) or event_entities.get(chat_scope)
        chat_ref = chat_id_from_scope(chat_scope)
        normalized = normalize_message(
            message,
            config.account,
            str(chat_ref),
            chat_title_from_entity(entity),
            chat_type_from_entity(entity) if entity is not None else None,
        )
        sender_id = normalized.get("senderId")
        if isinstance(sender_id, str):
            display_name = await cached_sender_display_name(
                message,
                sender_id,
                sender_display_names,
                sender_cache_lock,
            )
            if display_name:
                normalized["senderDisplayName"] = display_name
                normalized["participantDisplayNames"] = {sender_id: display_name}
        message_id = normalized_message_id(normalized)

        async with state_lock:
            current_id = min_id_from_cursor(state["forward_cursors"].get(chat_scope))
            if message_id <= current_id:
                write_json_atomic(config.state_path, state)
                return
            appended = append_gateway_page(
                config,
                chat_scope,
                {"messages": [normalized]},
                "forward",
            )
            if appended:
                advance_forward_cursor(state, chat_scope, message_id)
                gateway_event_lane(state)["events_appended"] += appended
            write_json_atomic(config.state_path, state)
    except Exception:
        # Event capture is an acceleration lane. Any miss remains eligible for
        # the periodic sweep and must never terminate the long-lived gateway.
        try:
            async with state_lock:
                gateway_event_lane(state)["errors"] += 1
                write_json_atomic(config.state_path, state)
        except Exception:
            pass


async def capture_gateway_reaction(
    update: Any,
    client: Any,
    config: GatewayConfig,
    state: dict[str, Any],
    state_lock: asyncio.Lock,
    event_scopes: dict[str, str],
    event_entities: dict[str, Any],
    reaction_entities: dict[str, Any],
    sender_display_names: OrderedDict[str, str | None],
    sender_cache_lock: asyncio.Lock,
) -> None:
    """Capture a reaction as metadata on the message it reacted to.

    A reaction lands on a message of any age, so this lane deliberately does
    NOT consult the forward cursor — that cursor answers "how far forward have
    we read", which is a new-message test and would drop every reaction on an
    older message — and never advances it. What the sweep and the new-message
    lane believe about forward progress is exactly what they made it.

    There is no capture-side aggregation state: the record carries the
    provider's complete current aggregate, read from the fetched message. The
    capture id moves with the aggregate's digest and the store keeps the last
    record per message, so idempotence and ordering are free.

    Fail-closed at every step: a peer outside the approved scopes, a target
    that cannot be fetched, or any error at all drops the whole reaction and
    leaves a counter behind. Never a partial record.
    """
    async with state_lock:
        gateway_event_lane(state)["reactions_seen"] += 1
    try:
        chat_scope = await reaction_chat_scope(client, update, event_scopes)
        if not chat_scope:
            async with state_lock:
                gateway_event_lane(state)["reactions_dropped_unapproved"] += 1
                write_json_atomic(config.state_path, state)
            return

        chat_ref = chat_id_from_scope(chat_scope)
        entity = await reaction_chat_entity(
            client,
            chat_scope,
            chat_ref,
            event_entities,
            reaction_entities,
        )
        # The full original text has to ride every reaction record: the store
        # replaces an item's representation on write, and an empty re-emit
        # would delete the stored chunks of the message being confirmed.
        message = await client.get_messages(entity, ids=reaction_target_message_id(update))
        if message is None or getattr(message, "id", None) is None:
            async with state_lock:
                gateway_event_lane(state)["reactions_dropped_unresolved"] += 1
                write_json_atomic(config.state_path, state)
            return

        normalized = normalize_message(
            message,
            config.account,
            str(chat_ref),
            chat_title_from_entity(entity),
            chat_type_from_entity(entity) if entity is not None else None,
            reactions_known=True,
        )
        sender_id = normalized.get("senderId")
        if isinstance(sender_id, str):
            display_name = await cached_sender_display_name(
                message,
                sender_id,
                sender_display_names,
                sender_cache_lock,
            )
            if display_name:
                normalized["senderDisplayName"] = display_name
                normalized["participantDisplayNames"] = {sender_id: display_name}

        async with state_lock:
            appended = append_gateway_page(
                config,
                chat_scope,
                {"messages": [normalized]},
                "forward",
            )
            gateway_event_lane(state)["reactions_appended"] += appended
            write_json_atomic(config.state_path, state)
    except Exception:
        # Same containment as the new-message lane: a miss must never terminate
        # the long-lived gateway, and the reacted message stays eligible for the
        # next reaction on it or the periodic sweep.
        try:
            async with state_lock:
                gateway_event_lane(state)["errors"] += 1
                write_json_atomic(config.state_path, state)
        except Exception:
            pass


async def reaction_chat_scope(
    client: Any,
    update: Any,
    event_scopes: dict[str, str],
) -> str | None:
    """Approved scope for a reaction update's peer, or None to drop it.

    Same resolution the new-message lane uses, so an unapproved chat is
    invisible to the reaction lane too.
    """
    peer = getattr(update, "peer", None)
    if peer is None:
        raise SafeConfigError("invalid_gateway_reaction")
    return event_scopes.get(str(await client.get_peer_id(peer)))


async def reaction_chat_entity(
    client: Any,
    chat_scope: str,
    chat_ref: str | int,
    event_entities: dict[str, Any],
    cache: dict[str, Any],
) -> Any:
    """Chat entity for a reaction target, resolved once per scope.

    Resolution is lazy rather than done for every approved chat at startup:
    the reaction lane must not add provider calls to the gateway's boot path.
    A concurrent double-resolve is harmless — it costs one extra cached read.
    """
    entity = event_entities.get(chat_scope) or cache.get(chat_scope)
    if entity is not None:
        return entity
    entity = await client.get_entity(chat_ref)
    cache[chat_scope] = entity
    return entity


def reaction_target_message_id(update: Any) -> int:
    value = getattr(update, "msg_id", None)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise SafeConfigError("invalid_gateway_reaction")
    return value


async def cached_sender_display_name(
    message: Any,
    sender_id: str,
    cache: OrderedDict[str, str | None],
    cache_lock: asyncio.Lock,
) -> str | None:
    async with cache_lock:
        if sender_id in cache:
            value = cache.pop(sender_id)
            cache[sender_id] = value
            return value
        try:
            value = display_name_from_entity(await message.get_sender())
        except Exception:
            value = None
        cache[sender_id] = value
        while len(cache) > EVENT_SENDER_CACHE_MAX:
            cache.popitem(last=False)
        return value


def normalized_message_id(message: dict[str, Any]) -> int:
    try:
        return int(str(message.get("id", "")))
    except ValueError as error:
        raise SafeConfigError("invalid_gateway_message") from error


def newest_message_id(page: dict[str, Any]) -> int:
    messages = page.get("messages", [])
    if not isinstance(messages, list) or not messages:
        raise SafeConfigError("invalid_gateway_message")
    return max(
        normalized_message_id(message)
        for message in messages
        if isinstance(message, dict)
    )


def forward_page_after_cursor(
    page: dict[str, Any],
    cursor: str | None,
) -> dict[str, Any]:
    current_id = min_id_from_cursor(cursor)
    messages = page.get("messages", [])
    if not isinstance(messages, list):
        raise SafeConfigError("invalid_gateway_message")
    return {
        **page,
        "messages": [
            message
            for message in messages
            if isinstance(message, dict) and normalized_message_id(message) > current_id
        ],
    }


def advance_forward_cursor(state: dict[str, Any], chat_scope: str, message_id: int) -> None:
    current_id = min_id_from_cursor(state["forward_cursors"].get(chat_scope))
    if message_id > current_id:
        state["forward_cursors"][chat_scope] = f"min_id:{message_id}"


async def process_backfill_requests(
    client: Any,
    config: GatewayConfig,
    state: dict[str, Any],
    state_lock: asyncio.Lock,
) -> int:
    captured = 0
    requests = replay_jsonl(config.backfill_path)
    start_line = int(state.get("backfill_request_line", 0))
    for line_number, request in enumerate(requests[start_line:], start=start_line + 1):
        if not isinstance(request, dict):
            raise SafeConfigError("invalid_backfill_request")
        request_id = require_text(request, "request_id")
        chat_scope = require_text(request, "chat_scope")
        if chat_scope not in config.approved_scopes:
            raise SafeConfigError("chat_scope_not_allowed")
        provider_cursor = require_text(request, "provider_cursor")
        offset_id_from_cursor(provider_cursor)
        max_messages = normalize_max_messages(request.get("max_messages"))
        page = await read_messages_with_client(
            client,
            config.account,
            chat_id_from_scope(chat_scope),
            provider_cursor,
            "backfill",
            max_messages,
        )
        captured += append_gateway_page(config, chat_scope, page, "backfill", request_id)
        next_cursor = optional_text(page.get("providerCursor"))
        if next_cursor:
            offset_id_from_cursor(next_cursor)
        async with state_lock:
            state["backfill_request_line"] = line_number
            state["last_backfill_result"] = {
                "request_id_hash": sha256_text(request_id),
                "records": len(page.get("messages", [])),
                **({"next_cursor_hash": sha256_text(next_cursor)} if next_cursor else {}),
            }
            write_json_atomic(config.state_path, state)
    return captured


def gateway_config() -> GatewayConfig:
    account = os.environ.get("OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT", "telegram.personal").strip()
    approved_raw = first_env(
        "OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES",
        "OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES",
    )
    approved_scopes = exact_chat_scopes(approved_raw, account, "approved_chat_scopes_required")
    protected_raw = first_env(
        "OLYMPUS_SOURCE_INDEX_TELEGRAM_PROTECTED_CHAT_SCOPES",
        "OLYMPUS_TELEGRAM_PROTECTED_CHAT_SCOPES",
    )
    protected_scopes = exact_chat_scopes(protected_raw, account, None)
    classification_raw = first_env(
        "OLYMPUS_SOURCE_INDEX_TELEGRAM_CHAT_CLASSIFICATIONS_JSON",
        "OLYMPUS_TELEGRAM_CHAT_CLASSIFICATIONS_JSON",
    )
    classifications = parse_gateway_classifications(classification_raw, account)
    for scope in protected_scopes:
        existing = classifications.get(scope)
        if existing and existing["trust_domain"] != "secure_local":
            raise SafeConfigError("conflicting_chat_classification")
        classifications.setdefault(scope, {
            "trust_domain": "secure_local",
            "reason": "legacy_protected_scope",
            "source": "legacy_protected_chat_scopes",
        })
    for scope in classifications:
        if scope not in approved_scopes:
            raise SafeConfigError("classification_scope_not_approved")

    state_dir = Path(os.environ.get(
        "OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR",
        str(Path.home() / ".local/state/olympus/telegram-capture-gateway"),
    ))
    spool_dir = Path(os.environ.get(
        "OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR",
        str(Path.home() / ".local/share/olympus/telegram-capture/spool"),
    ))
    report_path = Path(value_after(sys.argv[1:], "--report") or os.environ.get(
        "OLYMPUS_TELEGRAM_GATEWAY_REPORT_PATH",
        "/tmp/olympus-source-processing-supervisor/telegram-capture-gateway-current.json",
    ))
    return GatewayConfig(
        account=account,
        approved_scopes=tuple(approved_scopes),
        classifications=classifications,
        state_dir=state_dir,
        spool_dir=spool_dir,
        state_path=state_dir / "state.json",
        report_path=report_path,
        backfill_path=Path(os.environ.get(
            "OLYMPUS_TELEGRAM_GATEWAY_BACKFILL_REQUESTS_PATH",
            str(state_dir / "backfill-requests.jsonl"),
        )),
        max_messages=positive_int_env("OLYMPUS_TELEGRAM_GATEWAY_MAX_MESSAGES", 150, MAX_MESSAGES_HARD_CAP),
        interval_seconds=positive_int_env("OLYMPUS_TELEGRAM_GATEWAY_INTERVAL_SECONDS", 900, 86400),
        stale_threshold_seconds=positive_int_env("OLYMPUS_TELEGRAM_GATEWAY_SPOOL_STALE_THRESHOLD_SECONDS", 64800, 604800),
    )


def parse_gateway_classifications(value: str | None, account: str) -> dict[str, dict[str, str]]:
    if not value:
        return {}
    try:
        entries = json.loads(value)
    except json.JSONDecodeError as error:
        raise SafeConfigError("invalid_chat_classifications") from error
    if not isinstance(entries, list):
        raise SafeConfigError("invalid_chat_classifications")
    result: dict[str, dict[str, str]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise SafeConfigError("invalid_chat_classifications")
        scope = entry.get("chatScope", entry.get("chat_scope"))
        trust = entry.get("trustDomain", entry.get("trust_domain"))
        reason = entry.get("reason")
        if not isinstance(scope, str) or scope not in exact_chat_scopes(scope, account, "invalid_chat_scope"):
            raise SafeConfigError("invalid_chat_classifications")
        if trust not in ("internal", "secure_local") or not isinstance(reason, str) or not reason.strip():
            raise SafeConfigError("invalid_chat_classifications")
        normalized = {"trust_domain": trust, "reason": reason.strip()}
        for source_key, target_key in (("owner", "owner"), ("reviewedAt", "reviewed_at"), ("reviewed_at", "reviewed_at"), ("source", "source")):
            field = entry.get(source_key)
            if isinstance(field, str) and field.strip():
                normalized[target_key] = field.strip()
        if scope in result and result[scope] != normalized:
            raise SafeConfigError("conflicting_chat_classification")
        result[scope] = normalized
    return result


def append_gateway_page(
    config: GatewayConfig,
    chat_scope: str,
    page: dict[str, Any],
    sync_direction: str,
    request_id: str | None = None,
) -> int:
    captured_at = gateway_now_iso()
    classification = config.classifications.get(chat_scope, {
        "trust_domain": "internal",
        "reason": "approved_ordinary_chat",
        "source": "approved_chat_scopes",
    })
    corpus_id = PROTECTED_TELEGRAM_CORPUS_ID if classification["trust_domain"] == "secure_local" else INTERNAL_TELEGRAM_CORPUS_ID
    records = []
    for message in page.get("messages", []):
        if not isinstance(message, dict):
            raise SafeConfigError("invalid_gateway_message")
        conversation_id = str(message.get("conversationId", message.get("chatId", ""))).strip()
        message_id = str(message.get("id", "")).strip()
        if not conversation_id or not message_id or conversation_id != str(chat_id_from_scope(chat_scope)):
            raise SafeConfigError("gateway_message_outside_scope")
        capture_id = sha256_text("\x1f".join([
            config.account,
            conversation_id,
            message_id,
            str(message.get("sourceVersion", "")),
        ]))
        records.append({
            "schema_version": 1,
            "capture_id": capture_id,
            "captured_at": captured_at,
            "provider": "telegram",
            "account": config.account,
            "chat_scope": chat_scope,
            "conversation_id": conversation_id,
            "corpus_id": corpus_id,
            "trust_domain": classification["trust_domain"],
            "classification": classification,
            "sync_direction": sync_direction,
            **({"backfill_request_id": request_id} if request_id else {}),
            "message": message,
        })
    if records:
        append_spool_records(config.spool_dir, records, captured_at[:10])
    return len(records)


def append_spool_records(spool_dir: Path, records: list[dict[str, Any]], date_name: str) -> None:
    spool_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(spool_dir, 0o700)
    path = spool_dir / f"{date_name}.jsonl"
    with open(path, "a+b") as spool:
        os.chmod(path, 0o600)
        fcntl.flock(spool.fileno(), fcntl.LOCK_EX)
        truncate_partial_tail(spool)
        spool.seek(0, os.SEEK_END)
        payload = "".join(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n" for record in records)
        spool.write(payload.encode("utf-8"))
        spool.flush()
        os.fsync(spool.fileno())


def truncate_partial_tail(spool: Any) -> None:
    spool.seek(0, os.SEEK_END)
    size = spool.tell()
    if size == 0:
        return
    spool.seek(-1, os.SEEK_END)
    if spool.read(1) == b"\n":
        return
    position = size
    while position > 0:
        read_size = min(4096, position)
        position -= read_size
        spool.seek(position)
        block = spool.read(read_size)
        newline = block.rfind(b"\n")
        if newline >= 0:
            spool.truncate(position + newline + 1)
            return
    spool.truncate(0)


def replay_jsonl(path: Path) -> list[Any]:
    try:
        payload = path.read_bytes()
    except FileNotFoundError:
        return []
    complete = payload[:payload.rfind(b"\n") + 1] if b"\n" in payload else b""
    result = []
    for line in complete.splitlines():
        if not line.strip():
            continue
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise SafeConfigError("invalid_spool_record") from error
    return result


def gateway_report(config: GatewayConfig, state: dict[str, Any], captured: int) -> dict[str, Any]:
    records = []
    for path in sorted(config.spool_dir.glob("*.jsonl")):
        records.extend(replay_jsonl(path))
    newest = max((record.get("captured_at", "") for record in records if isinstance(record, dict)), default="")
    age = seconds_since(newest) if newest else None
    if age is None:
        freshness_status, freshness_reason = "unavailable", "no_valid_message_timestamp"
    elif age > config.stale_threshold_seconds:
        freshness_status, freshness_reason = "stale", "age_exceeds_threshold"
    else:
        freshness_status, freshness_reason = "fresh", "within_threshold"
    return {
        "kind": "telegram_capture_gateway_report",
        "provider": "telegram",
        "generated_at": gateway_now_iso(),
        "status": "attention" if freshness_status in ("stale", "unavailable") else "ok",
        "credential_endpoint_id": TELEGRAM_GATEWAY_ENDPOINT_ID,
        "approved_chats": len(config.approved_scopes),
        "protected_chats": sum(1 for value in config.classifications.values() if value["trust_domain"] == "secure_local"),
        "records_captured": captured,
        "spool_records": len(records),
        **({"spool_newest_age_seconds": age} if age is not None else {}),
        "spool_stale_threshold_seconds": config.stale_threshold_seconds,
        "spool_freshness_status": freshness_status,
        "spool_freshness_reason": freshness_reason,
        "backfill_requests_processed": int(state.get("backfill_request_line", 0)),
        "event_lane": dict(gateway_event_lane(state)),
        "policy": {
            "read_only": True,
            "send": False,
            "forward": False,
            "mark_read": False,
            "join": False,
            "leave": False,
            "contact_management": False,
            "connector_store_writes": False,
            "content_logged": False,
        },
    }


def read_gateway_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "schema_version": 1,
            "forward_cursors": {},
            "backfill_request_line": 0,
            "cycles": 0,
            "event_lane": {key: 0 for key in EVENT_LANE_COUNTER_KEYS},
        }
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SafeConfigError("invalid_gateway_state") from error
    if not isinstance(state, dict) or state.get("schema_version") != 1 or not isinstance(state.get("forward_cursors"), dict):
        raise SafeConfigError("invalid_gateway_state")
    state.setdefault("backfill_request_line", 0)
    state.setdefault("cycles", 0)
    gateway_event_lane(state)
    return state


def gateway_event_lane(state: dict[str, Any]) -> dict[str, int]:
    lane = state.setdefault("event_lane", {})
    if not isinstance(lane, dict):
        raise SafeConfigError("invalid_gateway_state")
    for key in EVENT_LANE_COUNTER_KEYS:
        value = lane.setdefault(key, 0)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise SafeConfigError("invalid_gateway_state")
    return lane


def gateway_event_lane_appended(state: dict[str, Any]) -> int:
    """Records the event lanes have spooled, both messages and reactions.

    The cycle report counts what was captured, and a reaction capture is a
    captured record like any other.
    """
    lane = gateway_event_lane(state)
    return lane["events_appended"] + lane["reactions_appended"]


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    with open(temporary, "w", encoding="utf-8") as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, sort_keys=True, separators=(",", ":"))
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


@contextmanager
def gateway_process_lock(path: Path):
    with open(path, "a", encoding="utf-8") as lock:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SafeConfigError("gateway_already_running") from error
        yield


def exact_chat_scopes(value: str | None, account: str, empty_error: str | None) -> list[str]:
    scopes = []
    for scope in (value or "").split(","):
        normalized = scope.strip()
        if not normalized:
            continue
        if "*" in normalized:
            raise SafeConfigError("wildcard_chat_scope_denied")
        if not normalized.startswith(f"{account}:chat:") or not normalized.rsplit(":", 1)[-1]:
            raise SafeConfigError("invalid_chat_scope")
        if normalized not in scopes:
            scopes.append(normalized)
    if not scopes and empty_error:
        raise SafeConfigError(empty_error)
    return scopes


def first_env(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return None


def positive_int_env(name: str, default: int, hard_cap: int) -> int:
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError as error:
        raise SafeConfigError(f"invalid_{name.lower()}") from error
    if parsed < 1 or parsed > hard_cap:
        raise SafeConfigError(f"invalid_{name.lower()}")
    return parsed


def value_after(args: list[str], flag: str) -> str | None:
    try:
        value = args[args.index(flag) + 1].strip()
    except (ValueError, IndexError):
        return None
    return value or None


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def gateway_now() -> dt.datetime:
    frozen = os.environ.get("OLYMPUS_TELEGRAM_GATEWAY_NOW", "").strip()
    if frozen:
        try:
            value = dt.datetime.fromisoformat(frozen.replace("Z", "+00:00"))
        except ValueError as error:
            raise SafeConfigError("invalid_olympus_telegram_gateway_now") from error
        if value.tzinfo is None:
            raise SafeConfigError("invalid_olympus_telegram_gateway_now")
        return value.astimezone(dt.timezone.utc)
    return dt.datetime.now(dt.timezone.utc)


def gateway_now_iso() -> str:
    return gateway_now().isoformat().replace("+00:00", "Z")


def seconds_since(value: str) -> int | None:
    try:
        timestamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    return max(0, int((gateway_now() - timestamp.astimezone(dt.timezone.utc)).total_seconds()))


def normalize_message(
    message: Any,
    account: str,
    chat_id: str,
    chat_title: str | None = None,
    chat_type: str | None = None,
    reactions_known: bool = False,
) -> dict[str, Any]:
    """Normalize one Telegram message into a spool record's `message` object.

    `reactions_known` is the reaction lane's flag: that lane only runs because
    the provider just spoke about this message's reactions, so a fetched
    message carrying no aggregate means every reaction was REMOVED, not that
    reactions are unknown. Only an explicit empty list can carry a clear to the
    store, and only a caller who knows the provider spoke may say it.
    """
    item: dict[str, Any] = {
        "id": str(message.id),
        "chatId": chat_id,
        "conversationId": chat_id,
        "sentAt": iso_or_none(getattr(message, "date", None)),
    }
    if chat_title:
        item["chatTitle"] = chat_title
    if chat_type:
        item["chatType"] = chat_type
    edit_date = iso_or_none(getattr(message, "edit_date", None))
    if edit_date:
        item["editedAt"] = edit_date
    sender_id = getattr(message, "sender_id", None)
    if sender_id is not None:
        item["senderId"] = str(sender_id)
    outgoing = getattr(message, "out", None)
    if isinstance(outgoing, bool):
        item["senderIsOwner"] = outgoing
    text = getattr(message, "raw_text", None)
    if isinstance(text, str) and text.strip():
        item["boundedText"] = text.strip()
    reply_to = getattr(message, "reply_to_msg_id", None)
    if reply_to is not None:
        item["replyToMessageId"] = str(reply_to)
    forward = getattr(message, "forward", None)
    if forward is not None:
        item["forwardSource"] = "telegram_forward"
    attachments = attachment_metadata(message)
    if attachments:
        item["attachments"] = attachments
    reactions = message_reaction_aggregate(message)
    if reactions is None and reactions_known:
        reactions = []
    if reactions is not None:
        item["reactions"] = reactions
    item["sourceVersion"] = f"{account}:{chat_id}:{message.id}:{edit_date or item.get('sentAt') or ''}"
    if reactions is not None:
        # The aggregate is part of what this capture observed, so it has to move
        # the source version: the capture id is a hash over it, and without this
        # a re-capture that only changed reactions would be indistinguishable
        # from the record already spooled. A message the provider said nothing
        # about keeps today's source version byte for byte.
        item["sourceVersion"] += f":r{sha256_text(serialize_reactions(reactions))[:8]}"
    # An explicit empty reaction list survives the strip: absence means "this
    # capture says nothing about reactions, keep what is stored", and an empty
    # list means "there are none any more". Dropping it would make a clear
    # inexpressible.
    return {
        key: value
        for key, value in item.items()
        if key == "reactions" or value not in (None, "", [])
    }


def message_reaction_aggregate(message: Any) -> list[dict[str, Any]] | None:
    """The provider's COMPLETE current reaction aggregate for one message.

    None means the provider said nothing about reactions. A list — possibly
    empty — is the whole truth as of this read: no deltas, no merging with
    anything captured before, no capture-side aggregation state. Telegram is
    the aggregation authority and every record carries its current answer.

    Selection is bounded BEFORE emitting, and it truncates rather than throws:
    the store refuses an over-sized aggregate with a run-aborting error, so
    capture must never hand it one. What survives is the largest counts, whose
    totals stay true even when their actor lists are capped.
    """
    container = getattr(message, "reactions", None)
    if container is None:
        return None
    actors_by_token = reaction_actors_by_token(container)
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for result in listed(getattr(container, "results", None)):
        key = reaction_token(getattr(result, "reaction", None))
        count = getattr(result, "count", None)
        if key is None or key in seen:
            continue
        if isinstance(count, bool) or not isinstance(count, int):
            continue
        if count < 1 or count > MAX_REACTION_COUNT:
            continue
        seen.add(key)
        actors = actors_by_token.get(key, [])[:MAX_REACTION_ACTORS_PER_TOKEN]
        entries.append({
            "key": key,
            # The provider's true total, never the length of a capped actor
            # list: the actor list is recent-only even before the cap.
            "count": count,
            **({"actors": actors} if actors else {}),
        })
    # Canonical order, matching the shared representation, so a provider that
    # reorders its results does not churn the digest or the stored aggregate.
    entries.sort(key=lambda entry: (-entry["count"], entry["key"]))
    del entries[MAX_REACTION_TOKENS:]
    while entries and utf16_length(serialize_reactions(entries)) > MAX_REACTIONS_SERIALIZED_CHARS:
        entries.pop()
    return entries


def reaction_actors_by_token(container: Any) -> dict[str, list[dict[str, str]]]:
    """Recent actors grouped by reaction token.

    Telegram's recent-reaction list is partial by design, and partial actors
    are legal downstream. Only the opaque provider id is carried: resolving a
    display name would cost an RPC per actor, and the store treats a missing
    label as "counts only".
    """
    grouped: dict[str, list[dict[str, str]]] = {}
    for entry in listed(getattr(container, "recent_reactions", None)):
        key = reaction_token(getattr(entry, "reaction", None))
        actor_id = reaction_actor_id(getattr(entry, "peer_id", None))
        if key is None or actor_id is None:
            continue
        actors = grouped.setdefault(key, [])
        if any(actor["providerActorId"] == actor_id for actor in actors):
            continue
        actors.append({"providerActorId": actor_id})
    for actors in grouped.values():
        actors.sort(key=lambda actor: actor["providerActorId"])
    return grouped


def reaction_token(reaction: Any) -> str | None:
    """Opaque token for one reaction, or None when it cannot be named.

    A standard reaction is its emoji. A custom emoji has no printable form
    without another RPC, so it becomes a stable prefixed token that survives
    unchanged through the store. A reaction shape this build does not
    understand is skipped rather than given an invented name.
    """
    emoticon = getattr(reaction, "emoticon", None)
    if isinstance(emoticon, str) and emoticon.strip():
        token = emoticon.strip()
    else:
        document_id = getattr(reaction, "document_id", None)
        if isinstance(document_id, bool) or not isinstance(document_id, (int, str)):
            return None
        token = f"{CUSTOM_REACTION_TOKEN_PREFIX}{str(document_id).strip()}"
    return token if bounded_reaction_field(token, MAX_REACTION_KEY_CHARS) else None


def reaction_actor_id(peer: Any) -> str | None:
    if isinstance(peer, bool):
        return None
    if isinstance(peer, int):
        value: int | None = peer
    else:
        value = None
        for attribute in ("user_id", "channel_id", "chat_id"):
            candidate = getattr(peer, attribute, None)
            if isinstance(candidate, int) and not isinstance(candidate, bool):
                value = candidate
                break
    if value is None:
        return None
    actor_id = str(value)
    return actor_id if bounded_reaction_field(actor_id, MAX_REACTION_ACTOR_FIELD_CHARS) else None


def bounded_reaction_field(value: str, limit: int) -> bool:
    if not value or utf16_length(value) > limit:
        return False
    # The rendered reaction line is a single line by contract downstream; a
    # token or actor id carrying a control character would corrupt it.
    return not any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)


def serialize_reactions(entries: list[dict[str, Any]]) -> str:
    """Byte-for-byte what the TypeScript store serializes into its column."""
    return json.dumps(entries, ensure_ascii=False, separators=(",", ":"))


def utf16_length(value: str) -> int:
    """Length as the TypeScript store counts characters (UTF-16 code units)."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def listed(value: Any) -> list[Any]:
    return list(value) if isinstance(value, (list, tuple)) else []


def chat_title_from_entity(entity: Any) -> str | None:
    return display_name_from_entity(entity)


def display_name_from_entity(entity: Any) -> str | None:
    if entity is None:
        return None
    title = getattr(entity, "title", None)
    if not isinstance(title, str) or not title.strip():
        first_name = getattr(entity, "first_name", None)
        last_name = getattr(entity, "last_name", None)
        name_parts = [
            part.strip()
            for part in (first_name, last_name)
            if isinstance(part, str) and part.strip()
        ]
        title = " ".join(name_parts)
    if not isinstance(title, str) or not title.strip():
        username = getattr(entity, "username", None)
        if isinstance(username, str) and username.strip():
            title = "@" + username.strip().lstrip("@")
    if not isinstance(title, str) or not title.strip():
        return None
    return title.strip()[:120]


def chat_type_from_entity(entity: Any) -> str:
    if bool(getattr(entity, "bot", False)):
        return "bot"
    if bool(getattr(entity, "broadcast", False)) and not bool(getattr(entity, "megagroup", False)):
        return "channel"
    if bool(getattr(entity, "megagroup", False)) or isinstance(getattr(entity, "title", None), str):
        return "group"
    return "dm"


def attachment_metadata(message: Any) -> list[dict[str, Any]]:
    media = getattr(message, "media", None)
    if media is None:
        return []
    document = getattr(message, "document", None)
    photo = getattr(message, "photo", None)
    if document is not None:
        mime_type = getattr(document, "mime_type", None)
        size = getattr(document, "size", None)
        name = document_file_name(document)
        return [{
            "attachmentId": f"document:{getattr(document, 'id', 'unknown')}",
            "type": attachment_type_from_mime(mime_type),
            **({"name": name} if name else {}),
            **({"mimeType": mime_type} if isinstance(mime_type, str) else {}),
            **({"sizeBytes": size} if isinstance(size, int) else {}),
        }]
    if photo is not None:
        return [{
            "attachmentId": f"photo:{getattr(photo, 'id', 'unknown')}",
            "type": "image",
        }]
    return [{
        "attachmentId": f"media:{type(media).__name__}",
        "type": "other",
    }]


def document_file_name(document: Any) -> str | None:
    for attribute in getattr(document, "attributes", None) or []:
        value = getattr(attribute, "file_name", None)
        if isinstance(value, str) and value.strip():
            return value.strip()[:512]
    return None


def attachment_type_from_mime(mime_type: Any) -> str:
    if not isinstance(mime_type, str):
        return "file"
    if mime_type.startswith("image/"):
        return "image"
    if mime_type.startswith("video/"):
        return "video"
    if mime_type.startswith("audio/"):
        return "audio"
    return "file"


def chat_id_from_scope(chat_scope: str) -> str | int:
    parts = chat_scope.split(":")
    if len(parts) < 3 or parts[-2] != "chat" or not parts[-1]:
        raise SafeConfigError("invalid_chat_scope")
    chat_ref = parts[-1]
    return int(chat_ref) if chat_ref.lstrip("-").isdigit() else chat_ref


def assert_chat_scope_allowed(chat_scope: str) -> None:
    if chat_scope == "*":
        raise SafeConfigError("wildcard_chat_scope_denied")
    configured = [
        item.strip()
        for item in os.environ.get("OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES", "").split(",")
        if item.strip()
    ]
    if configured and chat_scope not in configured:
        raise SafeConfigError("chat_scope_not_allowed")


def approved_dialog_scopes(request: dict[str, Any], account: str) -> set[str]:
    configured = [
        item.strip()
        for item in os.environ.get("OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES", "").split(",")
        if item.strip()
    ]
    requested = optional_text_list(request.get("approved_chat_scopes"))
    scopes = requested or configured
    if not scopes:
        raise SafeConfigError("approved_chat_scopes_required")
    allowed = set(configured) if configured else None
    approved: set[str] = set()
    for scope in scopes:
        if scope == "*":
            raise SafeConfigError("wildcard_chat_scope_denied")
        if not scope.startswith(f"{account}:chat:"):
            raise SafeConfigError("invalid_chat_scope")
        if allowed is not None and scope not in allowed:
            raise SafeConfigError("chat_scope_not_allowed")
        approved.add(scope)
    if not approved:
        raise SafeConfigError("approved_chat_scopes_required")
    return approved


def offset_id_from_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    if cursor.startswith("offset_id:"):
        try:
            return max(0, int(cursor.split(":", 1)[1]))
        except ValueError as error:
            raise SafeConfigError("invalid_provider_cursor") from error
    raise SafeConfigError("invalid_provider_cursor")


def min_id_from_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    if cursor.startswith("min_id:"):
        try:
            return max(0, int(cursor.split(":", 1)[1]))
        except ValueError as error:
            raise SafeConfigError("invalid_provider_cursor") from error
    raise SafeConfigError("invalid_provider_cursor")


def sync_direction_from_request(value: Any, cursor: str | None) -> str:
    if value in ("forward", "backfill"):
        direction = str(value)
    elif cursor and cursor.startswith("offset_id:"):
        direction = "backfill"
    else:
        direction = "forward"
    if cursor:
        if direction == "forward" and not cursor.startswith("min_id:"):
            raise SafeConfigError("invalid_provider_cursor")
        if direction == "backfill" and not cursor.startswith("offset_id:"):
            raise SafeConfigError("invalid_provider_cursor")
    return direction


def optional_text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise SafeConfigError("invalid_text_list")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise SafeConfigError("invalid_text_list")
        text = item.strip()
        if text:
            result.append(text)
    return result


def normalize_max_messages(value: Any) -> int:
    if value is None:
        return MAX_MESSAGES_DEFAULT
    if not isinstance(value, int):
        raise SafeConfigError("invalid_max_messages")
    return max(1, min(value, MAX_MESSAGES_HARD_CAP))


def require_text(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SafeConfigError(f"missing_{key}")
    return value.strip()


def optional_text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def require_env(key: str) -> str:
    value = os.environ.get(key, "").strip()
    if not value:
        raise SafeConfigError(f"missing_{key.lower()}")
    return value


def require_int_env(key: str) -> int:
    value = require_env(key)
    try:
        return int(value)
    except ValueError as error:
        raise SafeConfigError(f"invalid_{key.lower()}") from error


def iso_or_none(value: Any) -> str | None:
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt.timezone.utc)
        return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    return None


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    raise SystemExit(main())
