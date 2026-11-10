// A long extraction command (a stand-in for a transcription that runs for
// minutes): it records its pid in EVENTS_PATH and then runs until killed.
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.EVENTS_PATH!, `${JSON.stringify({ role: 'extraction', event: 'start', pid: process.pid })}\n`);
setInterval(() => {}, 60_000);
