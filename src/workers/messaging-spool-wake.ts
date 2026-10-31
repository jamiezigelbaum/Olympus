import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Watch the spool and its nearest existing parent, including when pairing creates it later. */
export function createSpoolChangeSubscription(spoolDir: string): (wake: () => void) => () => void {
  const target = resolve(spoolDir);
  return (wake) => {
    let closed = false;
    let watchers: FSWatcher[] = [];
    const arm = (): void => {
      if (closed) return;
      for (const watcher of watchers) watcher.close();
      watchers = [];
      let parent = dirname(target);
      while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
      const next = target.slice(parent.length + (parent === '/' ? 0 : 1)).split('/')[0];
      try {
        const watcher = watch(parent, { persistent: false }, (_event, name) => {
          if (name === null || (name.toString() === next || name.toString().startsWith(`${next}/`))) { arm(); wake(); }
        });
        watcher.on('error', () => watcher.close());
        watchers.push(watcher);
        if (existsSync(target)) {
          const spool = watch(target, { persistent: false }, (_event, name) => {
            if (name === null || name.toString().endsWith('.jsonl')) wake();
          });
          spool.on('error', () => spool.close());
          watchers.push(spool);
        }
      } catch {
        // The scheduler's normal polling remains the backstop when watching fails.
      }
    };
    arm();
    return () => { closed = true; for (const watcher of watchers) watcher.close(); watchers = []; };
  };
}
