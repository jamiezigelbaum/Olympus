// Developer harness: run a recovery-only zkAPI session for an unresolved fence.
//
// The consult lane that will offer recovery to owners has not landed, so this
// is the only way to clear a fence today. It sends one fixed question with no
// content through the same supervised, Tor-routed session as a consult, which
// authorizes up to the model's per-request allowance (Olympus counts $6).
//
//   bun scripts/zkapi-consult-recover.ts --yes [--profile <id>]
//
// It prints a content-free result: ok, the error code if any, and the receipt.

import { recoverZkapiSession } from '../src/core/consult-transport-zkapi.ts';
import { resolveSecretRefValue } from '../src/core/secret-store.ts';
import { loadSovereigntyEngine } from '../src/core/sovereignty.ts';

async function main(argv: string[]): Promise<number> {
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
  console.log(JSON.stringify(result.ok
    ? { ok: true, receipt: result.receipt }
    : { ok: false, code: result.error.code, receipt: result.error.receipt }, null, 2));
  return result.ok ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
