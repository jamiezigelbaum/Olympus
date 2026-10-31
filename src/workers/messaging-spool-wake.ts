import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Watch the spool and its nearest existing parent, including when pairing creates it later. */
export function createSpoolChangeSubscription(spoolDir: string, options: {
  watch?: typeof watch;
  retryInitialMs?: number;
  retryMaxMs?: number;
} = {}): (wake: () => void) => () => void {
  const target = resolve(spoolDir);
  return (wake) => {
    let closed = false;
    let watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = options.retryInitialMs ?? 1000;
    const maxDelay = options.retryMaxMs ?? 60_000;
    const watchDir = options.watch ?? watch;
    const retry = (): void => {
      if (closed || timer) return;
      recovering = true;
      for (const watcher of watchers) watcher.close();
      watchers = [];
      timer = setTimeout(() => { timer = undefined; arm(); }, delay);
      timer.unref();
      delay = Math.min(delay * 2, maxDelay);
    };
    let recovering = false;
    const arm = (): void => {
      if (closed) return;
      for (const watcher of watchers) watcher.close();
      watchers = [];
      let parent = dirname(target);
      while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
      const next = target.slice(parent.length + (parent === '/' ? 0 : 1)).split('/')[0];
      try {
        const watcher = watchDir(parent, { persistent: false }, (_event, name) => {
          if (name === null || (name.toString() === next || name.toString().startsWith(`${next}/`))) { arm(); wake(); }
        });
        watcher.on('error', retry);
        watchers.push(watcher);
        if (existsSync(target)) {
          const spool = watchDir(target, { persistent: false }, (_event, name) => {
            if (name === null || name.toString().endsWith('.jsonl')) wake();
          });
          spool.on('error', retry);
          watchers.push(spool);
        }
        delay = options.retryInitialMs ?? 1000;
        // Changes may have arrived while the watcher was unavailable.
        if (recovering) wake();
        recovering = false;
      } catch {
        recovering = true;
        retry();
      }
    };
    arm();
    return () => { closed = true; if (timer) clearTimeout(timer); for (const watcher of watchers) watcher.close(); watchers = []; };
  };
}
