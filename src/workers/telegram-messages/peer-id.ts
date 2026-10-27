// Telegram's marked peer ids, as Telethon writes them (`utils.get_peer_id`):
// a user (or bot) is its own id, a basic group is its id negated, and a
// supergroup or channel is `-(1000000000000 + id)`. Live capture keys every
// chat and sender this way (the helper takes Telethon's own ids), and the
// export input computes the same ids here, by number, never by joining text:
// joining `-100` and a short id gives another peer's id.

const CHANNEL_OFFSET = 1_000_000_000_000n;

export type TelegramPeerKind = 'user' | 'chat' | 'channel';

/** The marked id of a peer from its kind and bare (positive) id, or undefined when the id is not one. */
export function telegramPeerId(kind: TelegramPeerKind, bareId: string): string | undefined {
  if (!/^\d{1,19}$/.test(bareId)) return undefined;
  const id = BigInt(bareId);
  if (id <= 0n) return undefined;
  if (kind === 'user') return id.toString();
  if (kind === 'chat') return (-id).toString();
  return (-(CHANNEL_OFFSET + id)).toString();
}
