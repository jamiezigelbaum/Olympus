/**
 * A relay child that starts, reports ready for its exact instance and pid,
 * then crashes shortly after: the crash loop the supervisor must back off from.
 * Each start appends a timestamp to TEST_SPAWN_LOG.
 */
import { appendFileSync } from 'node:fs';
import { emptyRemoteAccessStatus, remoteAccessDir, writeRemoteAccessStatus } from '../../../src/core/remote-access.ts';

const [, instanceId] = process.argv.slice(2);
appendFileSync(process.env.TEST_SPAWN_LOG!, `${Date.now()}\n`);
writeRemoteAccessStatus(remoteAccessDir(process.env), {
  ...emptyRemoteAccessStatus('relay'),
  instance_id: instanceId!,
  pid: process.pid,
  relay: { state: 'connecting', reason: null, retry_in_ms: null },
});
setTimeout(() => process.exit(1), 150);
