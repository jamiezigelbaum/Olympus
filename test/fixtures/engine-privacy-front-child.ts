// A fresh front process with the production routes, read-only stores and release
// checks. The starting listener stays on the socket until the front can serve.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_PRIVACY_READY_QUERY } from '../../src/core/engine-split.ts';
import { answerReleaseWithheldReasonOffThread } from '../../src/core/release-manifest.ts';
import { withRequestPeer } from '../../src/core/request-peer.ts';
import { engineStartingResponse } from '../../src/core/worker-front-proxy.ts';
import { bindWorkerSocket, createUnixSocketFetch, workerSocketServe } from '../../src/core/worker-transport.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { createOwnerTierItems } from '../../src/workers/classification/tier-owner-items.ts';
import { LocalConnectorStore } from '../../src/workers/connector-store/local-index.ts';
import { createPendingItemProtection, createReleaseTierCheck, createTierVisibilityGate } from '../../src/workers/connector-store/tier-visibility.ts';
import { createEngineFront, createEngineFrontRoutes, createFrontGate } from '../../src/workers/engine-split/runtime.ts';
import { createEmailSourceWorker } from '../../src/workers/engine/index.ts';
import { withWorkerBearerAuth } from '../../src/workers/http.ts';
import { CORPORA, identityOf } from '../helpers/tier-fixtures.ts';

const [root, frontSocket, backgroundSocket, ledgerPath, internalPath, securePath] = process.argv.slice(2) as [string, string, string, string, string, string];
const authToken = process.env.FIXTURE_TOKEN!;
const ledger = new TierLedger({ dbPath: ledgerPath, readOnly: true });
const store = new LocalConnectorStore({
  dbPath: internalPath, corpusId: CORPORA.internal, trustDomain: 'internal', family: 'file', tierLedger: ledger, readOnly: true,
});
const fetchBackground = createUnixSocketFetch(backgroundSocket);
const front = createEngineFront({
  env: process.env, socketPath: backgroundSocket, authToken,
  fetch: (async (url, init) => {
    const response = await fetchBackground(url, init);
    if (response.ok && new URL(String(url)).searchParams.has(ENGINE_PRIVACY_READY_QUERY)) {
      const reply = await response.clone().json() as { privacy_raises_settled?: boolean };
      if (reply.privacy_raises_settled === false) writeFileSync(join(root, 'front-private-held'), '');
    }
    return response;
  }) as typeof fetch,
});
const protection = createPendingItemProtection();
const scopes = () => [{ ledger, corpusIds: new Set([CORPORA.internal]), stores: () => [store] }];
const visibility = createTierVisibilityGate(scopes, undefined, protection);
const release = createReleaseTierCheck(scopes, () => 'allow', {}, protection);
const worker = createEmailSourceWorker({
  connectorStores: [store], sourceIndexVisibilityGate: visibility,
  ownerTierItems: createOwnerTierItems({ storePaths: [internalPath, securePath] }),
});
const routes = createEngineFrontRoutes({ client: front.client, pendingItemProtection: protection, gate: createFrontGate(), restartFront: () => {} });
const serve = withWorkerBearerAuth(async request => {
  if (new URL(request.url).pathname === '/fixture/answer-release') {
    const reason = await answerReleaseWithheldReasonOffThread([{
      inputs: [{ ...identityOf('restart-item'), corpusId: CORPORA.internal, privateAtAnswer: false, layer: 'names' }],
      constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false },
    }], release);
    return Response.json({ released: reason === undefined });
  }
  return (await routes(request)) ?? worker.fetch(request);
}, { authToken, sessionSecret: process.env.FIXTURE_SESSION_SECRET!, requireOwnerSocket: true });
let starting = true;
bindWorkerSocket(frontSocket, () => Bun.serve(workerSocketServe({
  unix: frontSocket,
  fetch: withRequestPeer(request => starting ? engineStartingResponse(request, process.env) : serve(request), true),
})));
writeFileSync(join(root, 'front-listening'), '');
await front.waitForPendingPrivacyRaises();
starting = false;
writeFileSync(join(root, 'front-ready'), '');
