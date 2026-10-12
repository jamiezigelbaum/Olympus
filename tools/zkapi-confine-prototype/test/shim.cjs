// PROTOTYPE: stands in for the watchdog. It spawns the launcher exactly as the
// supervisor's watchdog does: its own fd 3 (the supervisor's private status
// pipe) is passed through as the launcher's fd 3 and then closed here, so the
// pipe reaches EOF when the launcher exits; any further descriptors named in
// the spec are passed through too. It mirrors the launcher's exit status. The
// matrix also kills it with SIGKILL to prove the whole session dies with it.
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const spec = JSON.parse(process.argv[2]);
const legacy = Array.isArray(spec); // a bare argv: no status pipe is passed
const { argv, extraFds = [] } = legacy ? { argv: spec } : spec;
const [launcher, ...args] = argv;
const child = spawn(launcher, args, { stdio: ['ignore', 'inherit', 'inherit', legacy ? 'ignore' : 3, ...extraFds] });
if (!legacy) { try { fs.closeSync(3); } catch {} }
child.on('exit', (code) => process.exit(code === null ? 1 : code));
setInterval(() => {}, 1000);
