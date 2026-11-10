/**
 * A spool volume with plenty of room, for Telegram fixtures that are not about
 * the media disk floor. Without it the receipt reads the host's real free
 * space (statfs), and a CI or remote-build disk under the floor adds
 * `telegram_media_disk_low` to every receipt (#932). The floor itself is
 * tested with explicit volumes in test/telegram-live-media.test.ts.
 */
import type { DiskSpace } from '../../src/workers/telegram-messages/media-child.ts';

const GB = 1024 ** 3;

export const AMPLE_DISK_SPACE: DiskSpace = () => ({ free: 900 * GB, total: 1_000 * GB });
