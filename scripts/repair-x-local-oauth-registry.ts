#!/usr/bin/env bun
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JsonCredentialOAuth2StateStore } from '../src/workers/credential-broker/index.ts';
import {
  defaultHandleRegistryPath,
  repairXLocalOAuthRegistryPosture,
} from '../src/workers/credential-broker/connected-handles.ts';

const registryPath = process.env.OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH?.trim()
  || defaultHandleRegistryPath();
const statePath = process.env.OLYMPUS_CREDENTIAL_BROKER_STATE_PATH?.trim()
  || join(homedir(), '.local', 'share', 'openclaw', 'olympus', 'credential-broker-state.json');

const result = await repairXLocalOAuthRegistryPosture({
  registryPath,
  oauth2StateStore: new JsonCredentialOAuth2StateStore(statePath),
});
console.log(JSON.stringify({
  ok: true,
  handle: 'x.bookmarks.personal',
  posture: 'local_oauth_state',
  result,
  policy: {
    counts_only: true,
    raw_source_exposed: false,
    raw_runtime_secrets_exposed: false,
  },
}));
