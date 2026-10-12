// PROTOTYPE: stands in for the watchdog. It spawns the launcher exactly as the
// supervisor's watchdog does (own parent, status descriptor) and then idles; the
// matrix kills it with SIGKILL to prove the whole session dies with it.
'use strict';
const { spawn } = require('node:child_process');
const [launcher, ...args] = JSON.parse(process.argv[2]);
const child = spawn(launcher, args, { stdio: ['ignore', 'ignore', 'ignore', 'ignore'] });
child.on('exit', () => process.exit(0));
setInterval(() => {}, 1000);
