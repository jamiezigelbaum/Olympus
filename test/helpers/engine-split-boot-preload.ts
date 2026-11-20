import { mock } from 'bun:test';
import * as starting from '../../src/core/worker-front-proxy.ts';
import { LocalConnectorStore } from '../../src/workers/connector-store/local-index.ts';
import * as cleanup from '../../src/workers/local-files/own-roots-cleanup.ts';

const gates = {
  cleanup: Promise.withResolvers<void>(),
  visibility: Promise.withResolvers<void>(),
  response: Promise.withResolvers<void>(),
};
process.on('message', (phase: keyof typeof gates) => gates[phase].resolve());

const createRecovery = cleanup.createLocalFilesOwnRootsRecovery;
mock.module('../../src/workers/local-files/own-roots-cleanup.ts', () => ({
  ...cleanup,
  createLocalFilesOwnRootsRecovery(options: Parameters<typeof createRecovery>[0]) {
    const recovery = createRecovery(options);
    return {
      ...recovery,
      // Signal when main awaits cleanup, which is later than when it starts it.
      initial: {
        then(resolve: () => void, reject: (error: unknown) => void) {
          process.send!('cleanup');
          void Promise.all([recovery.initial, gates.cleanup.promise]).then(() => resolve(), reject);
        },
      },
    };
  },
}));

const keepVisibilityCurrent = LocalConnectorStore.prototype.keepVisibilityCurrentInTurns;
LocalConnectorStore.prototype.keepVisibilityCurrentInTurns = async function () {
  LocalConnectorStore.prototype.keepVisibilityCurrentInTurns = keepVisibilityCurrent;
  process.send!('visibility');
  await gates.visibility.promise;
  await keepVisibilityCurrent.call(this);
};

const startingResponse = starting.engineStartingResponse;
mock.module('../../src/core/worker-front-proxy.ts', () => ({
  ...starting,
  engineStartingResponse(request: Request, env: Parameters<typeof startingResponse>[1]) {
    const response = startingResponse(request, env);
    if (!request.headers.has('x-test-hold-starting-response')) return response;
    process.send!('response');
    return gates.response.promise.then(() => response);
  },
}));
