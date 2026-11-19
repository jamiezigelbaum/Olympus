import { open } from 'node:fs/promises';

declare const self: { postMessage(message: string): void };

// Fail a publish if the control worker tries to flush its snapshot.
const file = await open(import.meta.path, 'r');
const rejectFlush = () => { throw new Error('unexpected snapshot flush'); };
const fileHandle = Object.getPrototypeOf(file);
fileHandle.sync = rejectFlush;
fileHandle.datasync = rejectFlush;
await file.close();
await import('../../src/workers/engine-split/control-worker.ts');
self.postMessage('ready');
