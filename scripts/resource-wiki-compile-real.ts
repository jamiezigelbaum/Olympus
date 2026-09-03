import {
  writeResourceWikiPages,
  type ResourceWikiEvidencePacket,
  type ResourceWikiModelAuthoredBody,
  type ResourceWikiPageCompileInput,
} from '../src/core/resource-wiki.ts';
import { resolveResourceWikiVaultRoot } from './resource-wiki-vault-root.ts';

export const OLYMPUS_KNOWLEDGE_ARCHITECTURE_PAGE_PATH = '03 Resources/Olympus Knowledge Architecture.md';

export interface ResourceWikiCompileRealCliOptions {
  resetVault: boolean;
}

export function parseResourceWikiCompileRealArgs(args: string[]): ResourceWikiCompileRealCliOptions {
  const allowed = new Set(['--reset-vault']);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`Unknown Resource Wiki real compile flag: ${arg}`);
    }
  }

  return {
    resetVault: args.includes('--reset-vault'),
  };
}

export function createOlympusKnowledgeArchitecturePageInput(validAsOf = '2026-05-19'): ResourceWikiPageCompileInput {
  return {
    packet: createOlympusKnowledgeArchitecturePacket(validAsOf),
    path: OLYMPUS_KNOWLEDGE_ARCHITECTURE_PAGE_PATH,
    reviewStatus: 'proposed',
    body: createOlympusKnowledgeArchitectureBody(),
  };
}

export function createOlympusKnowledgeArchitecturePacket(validAsOf = '2026-05-19'): ResourceWikiEvidencePacket {
  return {
    packetId: 'rw-live.olympus-knowledge-architecture.2026-05-19',
    title: 'Olympus Knowledge Architecture',
    canonicalId: 'resource-wiki/olympus-knowledge-architecture',
    resourceKind: 'topic',
    trustDomain: 'internal',
    sensitivity: 'internal_notes',
    validAsOf,
    sourceRefs: [
      {
        id: 'readwise.karpathy.llm-knowledge-bases',
        family: 'readwise',
        label: 'Andrej Karpathy note on LLM-built personal knowledge bases',
        provider: 'readwise',
        corpusId: 'internal.readwise.library',
        providerItemId: 'highlight:1002715743',
        uri: 'https://readwise.io/bookreview/59454390',
        trustDomain: 'internal',
        sensitivity: 'internal_notes',
        validAsOf,
      },
      {
        id: 'readwise.erc8004.trustless-agents',
        family: 'readwise',
        label: 'ERC-8004 Trustless Agents article',
        provider: 'readwise',
        corpusId: 'internal.readwise.library',
        providerItemId: '01k30ey1xwjjf50j4sw59v6hwe',
        uri: 'https://eips.ethereum.org/EIPS/eip-8004',
        trustDomain: 'internal',
        sensitivity: 'internal_notes',
        validAsOf,
      },
      {
        id: 'readwise.open-source-memory-agents',
        family: 'readwise',
        label: 'Andy Nguyen note on open-source memory for agents',
        provider: 'readwise',
        corpusId: 'internal.readwise.library',
        providerItemId: 'highlight:1002912918',
        uri: 'https://readwise.io/bookreview/59463780',
        trustDomain: 'internal',
        sensitivity: 'internal_notes',
        validAsOf,
      },
      {
        id: 'readwise.obsidian-agent-crew',
        family: 'readwise',
        label: 'Guri Singh note on AI agents managing an Obsidian vault',
        provider: 'readwise',
        corpusId: 'internal.readwise.library',
        providerItemId: 'highlight:1003464151',
        uri: 'https://readwise.io/bookreview/59512911',
        trustDomain: 'internal',
        sensitivity: 'internal_notes',
        validAsOf,
      },
      {
        id: 'readwise.karpathy.idea-file',
        family: 'readwise',
        label: 'Andrej Karpathy note on idea files for agent-era sharing',
        provider: 'readwise',
        corpusId: 'internal.readwise.library',
        providerItemId: 'highlight:1003203338',
        uri: 'https://readwise.io/bookreview/59454390',
        trustDomain: 'internal',
        sensitivity: 'internal_notes',
        validAsOf,
      },
      ...xBookmarkSourceRefs(validAsOf),
    ],
    evidence: [
      {
        id: 'knowledge-base-shift',
        sourceRefIds: ['readwise.karpathy.llm-knowledge-bases'],
        knowledgeRoles: ['claim', 'pattern', 'attention_signal'],
        summary:
          'The selected Readwise evidence frames LLM work as building and maintaining personal knowledge bases around research topics, not only manipulating code.',
      },
      {
        id: 'structured-vault-memory',
        sourceRefIds: ['readwise.open-source-memory-agents', 'readwise.obsidian-agent-crew'],
        knowledgeRoles: ['claim', 'pattern', 'implementation_context'],
        summary:
          'Two selected Readwise items point toward structured Markdown or Obsidian vaults as an inspectable memory substrate for agent workflows.',
      },
      {
        id: 'agent-trust-boundary',
        sourceRefIds: ['readwise.erc8004.trustless-agents'],
        knowledgeRoles: ['claim', 'constraint', 'rationale'],
        summary:
          'The selected agent-trust article treats identity, reputation, validation, and task-risk matching as explicit infrastructure for agent-to-agent systems.',
      },
      {
        id: 'idea-file-pattern',
        sourceRefIds: ['readwise.karpathy.idea-file'],
        knowledgeRoles: ['pattern', 'attention_signal'],
        summary:
          'The selected idea-file evidence suggests that durable, portable ideas can be more useful than app-specific artifacts in an agent-heavy workflow.',
      },
      {
        id: 'x-ai-folder-signal',
        sourceRefIds: [
          'x.bookmark.2050925665319342524',
          'x.bookmark.2051045196260167790',
          'x.bookmark.2050290961452839331',
          'x.bookmark.2050509509542678744',
          'x.bookmark.2049779422291460576',
        ],
        knowledgeRoles: ['attention_signal', 'source_quality', 'open_question'],
        summary:
          'The selected X evidence confirms relevant AI-folder bookmark provenance, but the current official-API window carries folder metadata rather than post bodies, so it is useful as an attention signal rather than claim evidence.',
      },
    ],
    whatChanged: [
      'Retitled the initial live Resource Wiki proof as an Olympus architecture page after editorial review.',
      'Used Readwise items for substantive claims and X bookmark folder provenance as an attention signal.',
      'Kept general Readwise/X corpus taxonomy out of this page until the full corpus map is generated.',
    ],
  };
}

export function createOlympusKnowledgeArchitectureBody(): ResourceWikiModelAuthoredBody {
  return {
    lead:
      'Olympus knowledge architecture is the part of the system that turns owner source material into durable understanding. Its job is not to mirror Readwise, X, Gmail, or Drive. Its job is to decide what deserves to become a readable Resource Wiki page, keep that page grounded in source refs, and preserve the trust boundary around each source family.[^knowledge-base-shift][^structured-vault-memory]',
    sections: [
      {
        heading: 'Current Shape',
        markdown:
          'The useful architecture is a staged loop: source adapters preserve provider truth, retrieval selects bounded evidence, a compiler proposes prose, and deterministic checks attach source refs, trust domain, review state, and vault layout. The wiki page is the human reading layer over that loop, not the place where provider records are dumped.[^knowledge-base-shift][^structured-vault-memory]',
      },
      {
        heading: 'Main Patterns',
        markdown:
          'Three patterns matter for Olympus now. First, preserve provenance so every durable claim can be traced back to a source family. Second, keep the wiki page as prose, because the point is a human-usable knowledge layer, not a database view. Third, treat folders, highlights, saves, and repeat appearances as signals about owner attention rather than automatic page content.[^structured-vault-memory][^idea-file-pattern][^x-ai-folder-signal]',
      },
      {
        heading: 'Trust Boundary',
        markdown:
          'Agent systems need explicit trust infrastructure. The selected agent-trust source is not an Olympus implementation spec, but it reinforces the direction: identity, reputation, validation, and risk-sensitive routing belong in the architecture rather than in ad hoc prompt discipline.[^agent-trust-boundary]',
      },
      {
        heading: 'Olympus Take',
        markdown:
          'The Resource Wiki compiler should not choose pages from whatever engineering query is convenient. It needs a corpus map first: what topics recur across Readwise and X, which source families contribute real claims, which are only attention signals, and where the owner already has an implied area or project. Only after that should Olympus write a general encyclopedia page.[^knowledge-base-shift][^structured-vault-memory][^x-ai-folder-signal]',
      },
      {
        heading: 'Open Questions',
        markdown:
          'The main gap is editorial taxonomy. The first proof page showed that the compiler can write a page, but it also showed why Olympus needs a corpus-level topic pass before publishing general Resource pages. X completeness is the second gap: the current official-API capture preserves folders such as AI, but a stronger collector should recover enough post-level context to let X contribute claims rather than only attention signals.[^x-ai-folder-signal][^idea-file-pattern]',
      },
    ],
    relatedPages: [
      '[[00 Meta/Resource Wiki/log|Resource Wiki compile log]]',
    ],
  };
}

export async function runResourceWikiCompileRealCli(args = Bun.argv.slice(2)): Promise<void> {
  const options = parseResourceWikiCompileRealArgs(args);
  const result = await writeResourceWikiPages({
    vaultRoot: resolveResourceWikiVaultRoot(),
    resetVault: options.resetVault,
    pages: [createOlympusKnowledgeArchitecturePageInput()],
  });

  console.log(JSON.stringify({
    proof_id: 'resource-wiki.compile-real-readwise-x',
    vault_root: result.vaultRoot,
    reset_vault: options.resetVault,
    pages_written: result.pages.map((page) => page.path),
    log_written: result.log.path,
  }, null, 2));
}

function xBookmarkSourceRefs(validAsOf: string): ResourceWikiEvidencePacket['sourceRefs'] {
  return [
    '2050925665319342524',
    '2051045196260167790',
    '2050290961452839331',
    '2050509509542678744',
    '2049779422291460576',
  ].map((postId) => ({
    id: `x.bookmark.${postId}`,
    family: 'x',
    label: `X bookmark ${postId}`,
    provider: 'x',
    corpusId: 'internal.x.bookmarks',
    providerItemId: postId,
    uri: `https://x.com/i/web/status/${postId}`,
    folderNames: ['AI'],
    trustDomain: 'internal',
    sensitivity: 'internal_notes',
    validAsOf,
  }));
}

if (import.meta.main) {
  runResourceWikiCompileRealCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
