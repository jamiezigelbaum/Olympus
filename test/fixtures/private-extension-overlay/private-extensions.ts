/**
 * A private overlay module that exercises every hook of the versioned private
 * extension contract.
 *
 * It stands in for the real overlay, which lives in the private operations
 * repository. Its config keys and lane names are deliberately neutral: what is
 * under test here is the mechanism — fragments compose into a manifest, the
 * context hook reaches the operation handler, the registrar mints tools through
 * the plugin's own factory, and the expectations are declarative. The real
 * overlay's own keys are pinned by its own contract test.
 */

import {
  OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
  type OlympusPrivateExtensions,
} from '../../../src/private-extension-contract.ts';

/** Names the fixture records so the test can assert each hook actually ran. */
export const fixtureCalls: {
  configFragments: number;
  extendOperationContext: number;
  register: number;
  runtimeExpectations: number;
  registeredOperationNames: string[];
  toolContextSeen: Array<Record<string, unknown>>;
} = {
  configFragments: 0,
  extendOperationContext: 0,
  register: 0,
  runtimeExpectations: 0,
  registeredOperationNames: [],
  toolContextSeen: [],
};

export function resetFixtureCalls(): void {
  fixtureCalls.configFragments = 0;
  fixtureCalls.extendOperationContext = 0;
  fixtureCalls.register = 0;
  fixtureCalls.runtimeExpectations = 0;
  fixtureCalls.registeredOperationNames = [];
  fixtureCalls.toolContextSeen = [];
}

const extensions: OlympusPrivateExtensions = {
  contractVersion: OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
  id: 'fixture-overlay',

  configFragments() {
    fixtureCalls.configFragments += 1;
    return [
      {
        path: ['fixtureLane'],
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', description: 'Enable the fixture lane.' },
            baseUrl: { type: 'string', description: 'Base URL for the fixture lane worker.' },
          },
        },
        uiHint: { label: 'Fixture Lane', help: 'Present only in a private overlay.' },
      },
      {
        path: ['email', 'fixtureDevEnabled'],
        schema: { type: 'boolean', description: 'Proof-only fixture gate nested in a public section.' },
      },
    ];
  },

  runtimeExpectations() {
    fixtureCalls.runtimeExpectations += 1;
    return {
      env: [
        { name: 'OLYMPUS_FIXTURE_LANE_BASE_URL', required: false, description: 'Fixture lane worker base URL.' },
      ],
      services: [
        { unit: 'olympus-fixture-lane.service', description: 'Fixture lane worker.' },
      ],
      schedulerTasks: ['fixture.lane.refresh'],
    };
  },

  extendOperationContext(input) {
    fixtureCalls.extendOperationContext += 1;
    // Proves the hook sees both the raw plugin config and the parsed config,
    // and that what it returns survives into the shared operation context.
    const raw = input.pluginConfig as { fixtureLane?: { enabled?: boolean } } | undefined;
    return {
      hireBrokerAuthority: { senderIsOwner: raw?.fixtureLane?.enabled === true && input.config.worker !== undefined },
    };
  },

  register(input) {
    fixtureCalls.register += 1;
    // Generic on purpose: the overlay selects from the same registry the plugin
    // iterates, using the contract's own public-surface predicate rather than a
    // copied list that could drift.
    const candidates = input.operations
      .filter((operation) => !input.isPublicNativeOperation(operation.name)
        && !input.registeredToolNames.includes(operation.name))
      .slice(0, 2);
    const [plain, withContext] = candidates;
    if (plain) {
      input.registerOperationTool(plain);
      fixtureCalls.registeredOperationNames.push(plain.name);
    }
    if (withContext) {
      input.registerOperationTool(withContext, {
        toolContextExtension: (toolContext) => {
          fixtureCalls.toolContextSeen.push({ ...toolContext });
          return { hireBrokerAuthority: { senderIsOwner: toolContext.senderIsOwner === true } };
        },
      });
      fixtureCalls.registeredOperationNames.push(withContext.name);
    }
    input.api.registerHttpRoute?.({
      path: '/olympus/fixture-lane',
      auth: 'plugin',
      match: 'exact',
      handler: async () => {},
    });
  },
};

export default extensions;
