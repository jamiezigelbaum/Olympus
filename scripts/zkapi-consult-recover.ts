// Developer harness: run a recovery-only zkAPI session for an unresolved fence,
// or, as an explicit last resort, abandon a fence whose wallet can no longer run.
//
// The consult lane that will offer recovery to owners has not landed, so this
// is the only way to clear a fence today. Recovery sends one fixed question
// with no content through the same supervised, Tor-routed session as a
// consult, which authorizes up to the model's per-request allowance (Olympus
// counts $6). It must run with the wallet directory that holds the fence.
//
//   bun scripts/zkapi-consult-recover.ts --yes [--profile <id>]
//   bun scripts/zkapi-consult-recover.ts --abandon <scope> --yes-abandon
//
// Exit codes: 0 recovered (settlement confirmed, fence clear); 1 the session
// failed; 3 the session ran but the fence is still held; 2 usage or setup.

import {
  abandonZkapiFence,
  defaultZkapiStatePath,
  formatZkapiStageTable,
  recoverZkapiSession,
  zkapiOutstandingFences,
} from '../src/core/consult-transport-zkapi.ts';
import { resolveSecretRefValue } from '../src/core/secret-store.ts';
import { loadSovereigntyEngine } from '../src/core/sovereignty.ts';

async function main(argv: string[]): Promise<number> {
  const abandonFlag = argv.indexOf('--abandon');
  if (abandonFlag >= 0) {
    const scope = argv[abandonFlag + 1];
    const fences = zkapiOutstandingFences(defaultZkapiStatePath());
    if (!scope || !fences[scope]) {
      console.error(`Name one outstanding fence scope. Outstanding: ${Object.keys(fences).join(', ') || 'none'}.`);
      return 2;
    }
    if (!argv.includes('--yes-abandon')) {
      console.error('Abandoning a fence means a lease left unsettled may later settle under another session\'s network identity, linking the two. Re-run with --yes-abandon to proceed.');
      return 2;
    }
    abandonZkapiFence(defaultZkapiStatePath(), scope, new Date());
    console.log(`Fence ${scope} marked abandoned; it no longer blocks consults and stays in the ledger as a record.`);
    return 0;
  }
  if (!argv.includes('--yes')) {
    console.error('A recovery session sends one content-free request and authorizes up to the model\'s per-request allowance (counted as $6). Re-run with --yes to proceed.');
    return 2;
  }
  const profileFlag = argv.indexOf('--profile');
  const wanted = profileFlag >= 0 ? argv[profileFlag + 1] : undefined;
  const engine = loadSovereigntyEngine();
  const profiles = Object.entries(engine.config.modelProfiles)
    .filter(([id, profile]) => profile.provider === 'zkapi' && (!wanted || id === wanted));
  if (profiles.length !== 1) {
    console.error(profiles.length === 0
      ? 'No zkapi profile found in the sovereignty policy.'
      : 'More than one zkapi profile: pass --profile <id>.');
    return 2;
  }
  const [, profile] = profiles[0]!;
  const apiKey = await resolveSecretRefValue(profile.secretRef);
  const result = await recoverZkapiSession({
    baseUrl: profile.baseUrl!,
    model: 'model' in profile && profile.model ? profile.model : '',
    ...(apiKey ? { apiKey } : {}),
    settings: profile.zkapi!,
  });
  const receipt = result.ok ? result.receipt : result.error.receipt;
  console.log(JSON.stringify(result.ok
    ? { ok: true, receipt }
    : { ok: false, code: result.error.code, receipt }, null, 2));
  console.log(`Stage timings:\n${formatZkapiStageTable(receipt?.stageMs)}`);
  if (!result.ok) {
    console.error('Recovery did not complete; the fence is still held.');
    return 1;
  }
  if (receipt?.fence !== 'clear' || receipt.settlement !== 'confirmed') {
    console.error('The recovery session ran, but settlement was not confirmed; the fence is still held. Run it again later.');
    return 3;
  }
  console.log('Recovered: settlement confirmed and the fence cleared.');
  return 0;
}

process.exit(await main(process.argv.slice(2)));
