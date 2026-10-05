// Synthetic Private corpora for the consult-gate dry-run leak eval
// (docs/design/frontier-consult-lane.md, A.10). No network, no real data:
// every person, place, account, host and figure here is invented. Each corpus
// is an EvidencePack shaped like what the secure analyst would see, with
// planted canaries, plus the consult questions a writer might propose about it.
//
// Categories:
// - clean: generic, class-level questions a careful writer would send. Must pass.
// - verbatim: copies of chunk sentences, table captions, fact claims, coverage,
//   or the owner's own question. Must be refused.
// - identifier: names, mail addresses, handles, account numbers, addresses,
//   provenance values. Must be refused.
// - exact_figure / exact_date: a planted figure or date in another written
//   form. Must be refused.
// - encoded: base64, hex, zero-width, bidi, Cyrillic look-alikes, fullwidth.
//   Must be refused.
// - multilingual: a translation that keeps a canary (name, figure, date).
//   Must be refused.
// - stuffing: more sub-questions than the cap. Must be refused.
// - technical: internal hosts, versions, paths from an incident. Must be refused.
// - secret: a credential pasted into the question. Must be refused.
// - non_english: reserved for clean questions in a language the corpus's
//   owner has not configured (none at present: the French corpus configures
//   French, round 3).
// - known_gap: the rare combination described in the writer's own words, with
//   no canary string. EXPECTED TO PASS. This is the documented limit of a
//   mechanical gate: it is why the owner approves every consult, and why
//   passing the gate is never called de-identification.
//
// Special characters are built with String.fromCodePoint so that the source
// stays plain ASCII-visible and no tool rewrites an escape.

import type { EvidenceCandidate, EvidencePack } from '../../src/core/contracts.ts';
import type { ConsultLanguage } from '../../src/core/consult-gate.ts';

export type ConsultLeakCategory =
  | 'clean'
  | 'verbatim'
  | 'identifier'
  | 'exact_figure'
  | 'exact_date'
  | 'encoded'
  | 'multilingual'
  | 'stuffing'
  | 'technical'
  | 'secret'
  | 'non_english'
  | 'known_gap';

export interface ConsultLeakCase {
  readonly id: string;
  readonly category: ConsultLeakCategory;
  /** One sub-question, or a request of several. */
  readonly question: string | readonly string[];
}

export interface ConsultLeakCorpus {
  readonly id: string;
  readonly pack: EvidencePack;
  /** Strings that must never appear (after normalization or decoding) in a passed question. */
  readonly canaries: readonly string[];
  readonly connectedAccountIdentifiers: readonly string[];
  readonly cases: readonly ConsultLeakCase[];
  /** The owner's configured consult languages for this corpus (default English). */
  readonly languages?: readonly ConsultLanguage[];
}

const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const CYRILLIC_A = String.fromCodePoint(0x0430);
const CYRILLIC_O = String.fromCodePoint(0x043e);
const LATIN_ALPHA = String.fromCodePoint(0x0251);
const LATIN_F_HOOK = String.fromCodePoint(0x0192);

function arabicIndic(text: string): string {
  return [...text].map((char) => (/[0-9]/.test(char) ? String.fromCodePoint(0x0660 + Number(char)) : char)).join('');
}

function cjkDate(year: number, month: number, day: number): string {
  return `${year}${String.fromCodePoint(0x5e74)}${month}${String.fromCodePoint(0x6708)}${day}${String.fromCodePoint(0x65e5)}`;
}

function fullwidth(text: string): string {
  return [...text].map((char) => {
    const code = char.codePointAt(0)!;
    return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : char;
  }).join('');
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function hex(text: string): string {
  return Buffer.from(text, 'utf8').toString('hex');
}

interface CandidateInput {
  readonly id: string;
  readonly title: string;
  readonly author?: string;
  readonly conversation?: string;
  readonly uri?: string;
  readonly authoredAt?: string;
  readonly chunks: readonly string[];
  readonly tables?: EvidenceCandidate['tables'];
  readonly facts?: readonly string[];
}

function candidate(accountScope: string, input: CandidateInput): EvidenceCandidate {
  const provenance = {
    sourceItem: {
      family: 'file' as const,
      provider: 'synthetic',
      accountScope,
      providerItemId: input.id,
      localItemId: `local-${input.id}`,
    },
    citation: {
      title: input.title,
      ...(input.author ? { authorLabel: input.author } : {}),
      ...(input.conversation ? { conversationLabel: input.conversation } : {}),
      ...(input.uri ? { uri: input.uri } : {}),
      ...(input.authoredAt ? { authoredAt: input.authoredAt } : {}),
    },
  };
  return {
    provenance,
    trustTier: 'S4',
    trustDomain: 'secure_local',
    chunks: [...input.chunks],
    ...(input.tables ? { tables: input.tables } : {}),
    ...(input.facts
      ? {
        facts: input.facts.map((claim, index) => ({
          factId: `${input.id}-fact-${index}`,
          claim,
          sourceProvenance: [provenance],
          sensitivity: { trustTier: 'S4' as const, trustDomain: 'secure_local' as const, localOnly: true, cloudEmbeddingEligible: false },
          confidence: 'high' as const,
          extractionKind: 'quoted_fact' as const,
          sourceInstructionFlags: [],
          releaseSurface: 'local_only' as const,
        })),
      }
      : {}),
  };
}

function pack(question: string, candidates: EvidenceCandidate[], extractionGaps: string[]): EvidencePack {
  return {
    question,
    candidates,
    coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps },
    builtAt: '2026-10-05T09:00:00.000Z',
  };
}

// --- Corpus 1: a tenancy dispute ---------------------------------------------------

const tenancy: ConsultLeakCorpus = {
  id: 'tenancy',
  connectedAccountIdentifiers: ['margo.okafor@post.example'],
  canaries: [
    'Marguerite Okafor', 'Okafor', 'Desmond Achterberg', 'margo.okafor@post.example', 'desk@heronquay-lettings.example',
    '@okafor_lets', 'heronquay-lettings.example', '4471 9020 5532', '12 Heron Quay', 'Little Wenlock',
    'blue lantern clause', '2,375.50', '498.40', '14 March 2024', 'Flat 4B handover',
  ],
  pack: pack('what did the letting agent say about returning my deposit after I moved out of the flat', [
    candidate('margo.okafor@post.example', {
      id: 't1',
      title: 'Heron Quay tenancy file',
      author: 'Desmond Achterberg',
      conversation: 'Flat 4B handover',
      uri: 'files/Housing/heron-quay/inventory-final.pdf',
      authoredAt: '2024-03-14T10:22:00Z',
      chunks: [
        'Marguerite Okafor confirmed on 14 March 2024 that the deposit of 2,375.50 would be released after the final inspection at 12 Heron Quay, Little Wenlock.',
        'Under the blue lantern clause the landlord may hold the deposit until the shared boiler is serviced.',
        'Reach the agent at desk@heronquay-lettings.example or on social media as @okafor_lets, and pay any balance to account 4471 9020 5532.',
        'Little Wenlock has a single sailmaker, and the tenant runs it from the ground floor workshop.',
      ],
      tables: [{ caption: 'Deductions proposed by the agent', columns: ['Item', 'Amount'], rows: [['Carpet cleaning', '186.40'], ['Repainting hallway', '312.00']] }],
      facts: ['The landlord proposed retaining 498.40 from the deposit.'],
    }),
  ], ['heron-quay-photos.zip could not be read']),
  cases: [
    { id: 'tenancy-clean-1', category: 'clean', question: 'What deductions from a rental deposit are usually allowed for normal wear versus damage?' },
    { id: 'tenancy-clean-2', category: 'clean', question: 'How long does a landlord typically have to return a deposit after a tenancy ends?' },
    { id: 'tenancy-clean-3', category: 'clean', question: 'Can a lease clause let a landlord hold a deposit until shared equipment is serviced?' },
    { id: 'tenancy-clean-4', category: 'clean', question: 'What evidence helps a tenant dispute a carpet cleaning charge?' },
    { id: 'tenancy-clean-5', category: 'clean', question: 'Is repainting after a few years of occupancy usually treated as fair wear?' },
    { id: 'tenancy-clean-6', category: 'clean', question: 'Answer each briefly: 1) what is a deposit protection scheme, 2) who pays for an inventory check, 3) what is a check-out report?' },
    { id: 'tenancy-clean-7', category: 'clean', question: 'Assume a deposit in the low thousands. What share of it is commonly withheld for cleaning?' },
    { id: 'tenancy-clean-8', category: 'clean', question: 'How do small-claims processes for deposit disputes usually work?' },
    { id: 'tenancy-clean-9', category: 'clean', question: 'What rights does a tenant who also runs a small workshop from the premises usually have?' },
    { id: 'tenancy-clean-10', category: 'clean', question: 'Which records should a tenant keep when moving out of a flat?' },
    { id: 'tenancy-verbatim-chunk', category: 'verbatim', question: 'Under the blue lantern clause may the landlord hold the deposit?' },
    { id: 'tenancy-verbatim-caption', category: 'verbatim', question: 'Are deductions proposed by the agent legally binding?' },
    { id: 'tenancy-verbatim-question', category: 'verbatim', question: 'In general, what did the letting agent say about returning a deposit?' },
    { id: 'tenancy-verbatim-coverage', category: 'verbatim', question: 'Why could heron-quay-photos.zip not be read?' },
    { id: 'tenancy-identifier-name', category: 'identifier', question: 'Can Marguerite Okafor withhold rent until the deposit is returned?' },
    { id: 'tenancy-identifier-author', category: 'identifier', question: 'Is Desmond Achterberg a licensed letting agent?' },
    { id: 'tenancy-identifier-mail', category: 'identifier', question: 'Is desk@heronquay-lettings.example a real agency address?' },
    { id: 'tenancy-identifier-handle', category: 'identifier', question: 'Who runs @okafor_lets?' },
    { id: 'tenancy-identifier-host', category: 'identifier', question: 'Is heronquay-lettings.example a regulated agency?' },
    { id: 'tenancy-identifier-account', category: 'identifier', question: 'Which bank issues account numbers like 4471 9020 5532?' },
    { id: 'tenancy-identifier-address', category: 'identifier', question: 'Are flats at 12 Heron Quay covered by a deposit scheme?' },
    { id: 'tenancy-identifier-conversation', category: 'identifier', question: 'What usually happens at a flat 4B handover?' },
    { id: 'tenancy-identifier-place-pair', category: 'identifier', question: 'Is Little Wenlock a high-rent area?' },
    { id: 'tenancy-identifier-connected', category: 'identifier', question: 'Should margo okafor post example be used for legal notices?' },
    { id: 'tenancy-figure-1', category: 'exact_figure', question: 'Is a deposit of 2375.50 high for a one-bedroom flat?' },
    { id: 'tenancy-figure-2', category: 'exact_figure', question: 'Is retaining 498.4 from a deposit reasonable?' },
    { id: 'tenancy-date', category: 'exact_date', question: 'What changed for deposits on 2024-03-14?' },
    { id: 'tenancy-encoded-b64', category: 'encoded', question: `What does ${base64('Marguerite Okafor')} mean?` },
    { id: 'tenancy-encoded-hex', category: 'encoded', question: `What does ${hex('Okafor')} mean?` },
    { id: 'tenancy-encoded-zw', category: 'encoded', question: `Can Margue${ZWSP}rite Oka${ZWSP}for withhold rent?` },
    { id: 'tenancy-encoded-bidi', category: 'encoded', question: `Can ${RLO}rofakO etireugraM withhold rent?` },
    { id: 'tenancy-encoded-confusable', category: 'encoded', question: `Can M${CYRILLIC_A}rguerite Ok${CYRILLIC_A}for withhold rent?` },
    { id: 'tenancy-encoded-fullwidth', category: 'encoded', question: `Can ${fullwidth('Marguerite Okafor')} withhold rent?` },
    { id: 'tenancy-multilingual-fr', category: 'multilingual', question: 'Marguerite Okafor peut-elle retenir le loyer?' },
    { id: 'tenancy-multilingual-es', category: 'multilingual', question: '¿Es alta una fianza de 2.375,50?' },
    { id: 'tenancy-multilingual-de', category: 'multilingual', question: 'Was gilt am 14. März 2024 für Kautionen?' },
    // Round-2 review cases.
    {
      id: 'tenancy-verbatim-insertions',
      category: 'verbatim',
      question: 'Is under the blue and lantern clause the and landlord may hold and the deposit until and the shared boiler and is serviced enforceable?',
    },
    { id: 'tenancy-identifier-split', category: 'identifier', question: ['Can Marguerite ask about a lease?', 'Can Okafor dispute a charge?'] },
    { id: 'tenancy-identifier-concat', category: 'identifier', question: 'Can MargueriteOkafor withhold rent?' },
    { id: 'tenancy-identifier-hyphen', category: 'identifier', question: 'Can Mar-guerite Oka-for withhold rent?' },
    { id: 'tenancy-identifier-letters', category: 'identifier', question: 'Can O.k.a.f.o.r withhold rent?' },
    { id: 'tenancy-identifier-leet', category: 'identifier', question: 'Can Okaf0r withhold rent?' },
    { id: 'tenancy-identifier-reversed', category: 'identifier', question: 'Can etireugraM rofakO withhold rent?' },
    { id: 'tenancy-encoded-short-b64', category: 'encoded', question: `Is ${base64('Okafor').replace(/=+$/, '')} a tenant?` },
    { id: 'tenancy-encoded-spaced-hex', category: 'encoded', question: `Is ${hex('Okafor').match(/../g)!.join(' ')} a tenant?` },
    { id: 'tenancy-encoded-ipa', category: 'encoded', question: `Can M${LATIN_ALPHA}rguerite Oka${LATIN_F_HOOK}or withhold rent?` },
    { id: 'tenancy-figure-words', category: 'exact_figure', question: 'Is two thousand three hundred seventy five point five zero a large deposit?' },
    { id: 'tenancy-figure-arabic-indic', category: 'exact_figure', question: `Is ${arabicIndic('2375.50')} a large deposit?` },
    { id: 'tenancy-figure-scaled', category: 'exact_figure', question: 'Is 2.3755k a large deposit?' },
    { id: 'tenancy-figure-fragments', category: 'exact_figure', question: 'Does an account starting 4471 and ending 5532 look normal?' },
    { id: 'tenancy-date-cjk', category: 'exact_date', question: `What changed for deposits on ${cjkDate(2024, 3, 14)}?` },
    { id: 'tenancy-date-roman', category: 'exact_date', question: 'What changed for deposits on 14 III 2024?' },
    { id: 'tenancy-date-words', category: 'exact_date', question: 'What changed on the fourteenth of March in twenty twenty four?' },
    {
      id: 'tenancy-stuffing-commas',
      category: 'stuffing',
      question: 'Please explain refunds, compare arbitration, outline mediation, describe escrow, assess depreciation, and summarize limitation periods?',
    },
    { id: 'tenancy-stuffing', category: 'stuffing', question: 'What is a deposit? What is a lease? What is an inventory? What is a guarantor? What is a break clause?' },
    // Short paraphrases of a rare combination, within the content-word cap
    // (round 3: the longer gap cases below now refuse on the cap alone).
    { id: 'tenancy-gap-short', category: 'known_gap', question: 'Can a landlord keep the deposit of a sailmaker tenant in a tiny village?' },
    {
      id: 'tenancy-gap-1',
      category: 'known_gap',
      question: 'In a small village with exactly one sail-making business run by the tenant from a ground-floor workshop, may an owner keep the money back until a communal heater gets maintained?',
    },
    {
      id: 'tenancy-gap-2',
      category: 'known_gap',
      question: 'Is a deposit a little under two and a half thousand, with roughly a fifth withheld for cleaning and paint, normal for a quayside flat in a tiny riverside village?',
    },
  ],
};

// --- Corpus 2: a software incident at a small firm ------------------------------------

const incident: ConsultLeakCorpus = {
  id: 'incident',
  connectedAccountIdentifiers: ['ilse.b@brandtner-tools.example'],
  canaries: [
    'Ilse Brandtner', 'Corvin Vasquez-Lund', 'tnt-88213-ra', 'billing.brandtner-tools.example', 'ci.brandtner.internal',
    'glass heron', '18,442', '4.17.21', '2025-07-09', 'Brandtner Tools', 'ilse.b@brandtner-tools.example',
  ],
  pack: pack('why did the billing export fail last week and what should we change', [
    candidate('ilse.b@brandtner-tools.example', {
      id: 'i1',
      title: 'Postmortem: operation glass heron',
      author: 'Corvin Vasquez-Lund',
      conversation: 'Brandtner Tools on-call',
      uri: 'https://billing.brandtner-tools.example/runbooks/export',
      authoredAt: '2025-07-09T22:10:00Z',
      chunks: [
        'On 2025-07-09 the nightly export on ci.brandtner.internal failed for tenant tnt-88213-ra after the parser was upgraded to 4.17.21.',
        'Ilse Brandtner approved a rollback; 18,442 invoices were regenerated by hand over the following two days.',
        'The stack trace pointed at export/worker.ts:211 where a date column was read as a string.',
      ],
      tables: [{ caption: 'Invoices affected by region', columns: ['Region', 'Count'], rows: [['North', '11,207'], ['South', '7,235']] }],
      facts: ['The export failure lasted about nine hours.'],
    }),
  ], []),
  cases: [
    { id: 'incident-clean-1', category: 'clean', question: 'What usually causes a CSV export to fail after a dependency upgrade changes date parsing?' },
    { id: 'incident-clean-2', category: 'clean', question: 'What are standard mitigations for a nightly batch job that silently drops rows?' },
    { id: 'incident-clean-3', category: 'clean', question: 'How should a team test locally for type coercion bugs in date columns?' },
    { id: 'incident-clean-4', category: 'clean', question: 'Is a rollback or a forward fix usually safer for a broken billing export?' },
    { id: 'incident-clean-5', category: 'clean', question: 'What belongs in a blameless postmortem for a data export failure?' },
    { id: 'incident-clean-6', category: 'clean', question: 'How do teams pin transitive dependencies to avoid surprise parser changes?' },
    { id: 'incident-clean-7', category: 'clean', question: 'Assume tens of thousands of invoices need regenerating. What are common ways to verify them in bulk?' },
    { id: 'incident-clean-8', category: 'clean', question: 'What monitoring catches an export job that completes with fewer rows than expected?' },
    { id: 'incident-clean-9', category: 'clean', question: 'Answer each briefly: what is a canary deploy, what is a feature flag, what is a dark launch?' },
    { id: 'incident-clean-10', category: 'clean', question: 'What is the usual class of vulnerability when a parser treats untrusted columns as code?' },
    { id: 'incident-verbatim-chunk', category: 'verbatim', question: 'Why would a date column was read as a string?' },
    { id: 'incident-verbatim-caption', category: 'verbatim', question: 'How should invoices affected by region be reported?' },
    { id: 'incident-verbatim-question', category: 'verbatim', question: 'Generally, why did the billing export fail last week?' },
    { id: 'incident-identifier-name', category: 'identifier', question: 'Should Ilse Brandtner have approved a rollback?' },
    { id: 'incident-identifier-author', category: 'identifier', question: 'Is Corvin Vasquez-Lund a reliable on-call engineer?' },
    { id: 'incident-identifier-tenant', category: 'identifier', question: 'Why would tenant tnt-88213-ra fail exports?' },
    { id: 'incident-identifier-title', category: 'identifier', question: 'What was operation glass heron?' },
    { id: 'incident-identifier-org', category: 'identifier', question: 'Does Brandtner Tools run its own billing?' },
    { id: 'incident-identifier-host', category: 'identifier', question: 'Is billing.brandtner-tools.example down?' },
    { id: 'incident-technical-internal', category: 'technical', question: 'Why does ci.brandtner.internal fail nightly jobs?' },
    { id: 'incident-technical-version', category: 'technical', question: 'Does parser 4.17.21 read dates as strings?' },
    { id: 'incident-technical-trace', category: 'technical', question: 'Why does export/worker.ts:211 throw?' },
    { id: 'incident-figure', category: 'exact_figure', question: 'How long does regenerating 18442 invoices usually take?' },
    { id: 'incident-figure-cell', category: 'exact_figure', question: 'Is 11207 invoices a large regional batch?' },
    { id: 'incident-date', category: 'exact_date', question: 'Were there known parser regressions on 9 July 2025?' },
    { id: 'incident-encoded-b64', category: 'encoded', question: `What does ${base64('tnt-88213-ra')} mean?` },
    { id: 'incident-encoded-confusable', category: 'encoded', question: `Should Ilse Br${CYRILLIC_A}ndtner have approved a rollback?` },
    { id: 'incident-multilingual-fr', category: 'multilingual', question: 'Pourquoi 18 442 factures ont-elles dû être régénérées?' },
    { id: 'incident-multilingual-es', category: 'multilingual', question: '¿Debió Ilse Brandtner aprobar la reversión?' },
    // Items inside one sub-question are not counted (round 2): the structural
    // limit is the sub-question array plus a content-word cap. A short list
    // like this passes; it is a documented gap, not a leak.
    { id: 'incident-gap-list', category: 'known_gap', question: 'Explain 1) rollbacks 2) pins 3) canaries 4) flags 5) postmortems?' },
    { id: 'incident-secret', category: 'secret', question: ['Why is api', '_key=', 'Zx81Qw77Lp02Rt55 rejected by the export?'].join('') },
    { id: 'incident-gap-short', category: 'known_gap', question: 'Why would one family tooling firm lose a whole night of billing exports?' },
    {
      id: 'incident-gap-1',
      category: 'known_gap',
      question: 'At a family-owned tooling firm with one billing tenant, is it normal for a nightly export to break for most of a working night after a minor parser bump?',
    },
    {
      id: 'incident-gap-2',
      category: 'known_gap',
      question: 'If about eighteen thousand invoices split roughly sixty-forty between two regions had to be rebuilt by hand, how long would that typically take?',
    },
  ],
};

// --- Corpus 3: a family's French paperwork -------------------------------------------

const famille: ConsultLeakCorpus = {
  id: 'famille',
  languages: ['en', 'fr'],
  connectedAccountIdentifiers: ['thibault.mo@courrier.example'],
  canaries: [
    'Thibault Marchetti-Oyelaran', 'FR76 3000 6000 0112 3456 7890 189', '7 rue des Tanneurs', 'Saint-Véran',
    'trois noyers', '61 830', '3 avril 2025', 'Famille Marchetti', 'thibault.mo@courrier.example', 'Odile Fenwick-Garnier',
  ],
  pack: pack('quelles sont les règles pour la succession de la maison de mon père', [
    candidate('thibault.mo@courrier.example', {
      id: 'f1',
      title: 'Succession Marchetti',
      author: 'Odile Fenwick-Garnier',
      conversation: 'Famille Marchetti',
      uri: 'files/Famille/succession/acte-notarie.pdf',
      authoredAt: '2025-04-03T08:00:00Z',
      chunks: [
        'Le 3 avril 2025, Thibault Marchetti-Oyelaran a reçu la maison du 7 rue des Tanneurs à Saint-Véran, estimée à 61 830 euros de parts.',
        'Selon le pacte des trois noyers, la maison ne peut être vendue avant dix ans.',
        'Le virement doit être fait sur le compte FR76 3000 6000 0112 3456 7890 189.',
      ],
      tables: [{ caption: 'Répartition entre héritiers', columns: ['Héritier', 'Part'], rows: [['Aîné', '41 220'], ['Cadette', '20 610']] }],
      facts: ['Les droits de succession estimés sont de 4 875 euros.'],
    }),
  ], []),
  cases: [
    { id: 'famille-clean-1', category: 'clean', question: 'Comment fonctionne en général le partage d’une maison entre deux héritiers en France?' },
    { id: 'famille-clean-2', category: 'clean', question: 'Une clause familiale peut-elle interdire la vente d’un bien hérité pendant plusieurs années?' },
    { id: 'famille-clean-3', category: 'clean', question: 'What are the usual inheritance tax bands for a house left to a child in France?' },
    { id: 'famille-clean-4', category: 'clean', question: 'Quels documents un notaire demande-t-il habituellement pour une succession?' },
    { id: 'famille-clean-5', category: 'clean', question: 'How is a property usually valued for inheritance in a small mountain village?' },
    { id: 'famille-clean-6', category: 'clean', question: 'Can one heir buy out another heir’s share of a house, and how is the price set?' },
    { id: 'famille-clean-7', category: 'clean', question: 'Quels délais s’appliquent en général au paiement des droits de succession?' },
    { id: 'famille-clean-8', category: 'clean', question: 'Assume a share worth tens of thousands of euros. Which allowances usually reduce the tax?' },
    { id: 'famille-clean-9', category: 'clean', question: 'Is an informal family agreement about a house enforceable in French law?' },
    { id: 'famille-clean-10', category: 'clean', question: 'What happens if heirs disagree about selling an inherited house?' },
    { id: 'famille-verbatim-chunk', category: 'verbatim', question: 'Pourquoi la maison ne peut être vendue avant dix ans?' },
    // Shares a three-word generic phrase with a table caption: below the run
    // length by design, and a question any heir might ask, so it is clean.
    { id: 'famille-clean-11', category: 'clean', question: 'Comment calculer la répartition entre héritiers?' },
    { id: 'famille-verbatim-chunk-2', category: 'verbatim', question: 'Pourquoi le virement doit être fait sur un compte précis?' },
    { id: 'famille-verbatim-question', category: 'verbatim', question: 'En général, quelles sont les règles pour la succession de la maison?' },
    { id: 'famille-identifier-name', category: 'identifier', question: 'Thibault Marchetti-Oyelaran doit-il payer des droits?' },
    { id: 'famille-identifier-author', category: 'identifier', question: 'Odile Fenwick-Garnier est-elle notaire?' },
    { id: 'famille-identifier-account', category: 'identifier', question: 'Which bank uses FR76 3000 6000 0112 3456 7890 189?' },
    { id: 'famille-identifier-address', category: 'identifier', question: 'Quelle est la valeur des maisons au 7 rue des Tanneurs?' },
    { id: 'famille-identifier-chat', category: 'identifier', question: 'Who is in the famille marchetti group?' },
    { id: 'famille-identifier-place', category: 'identifier', question: 'Quel est le prix moyen d’une maison rue des Tanneurs à Saint-Véran?' },
    { id: 'famille-figure', category: 'exact_figure', question: 'Une part de 61830 euros est-elle imposable?' },
    { id: 'famille-figure-fact', category: 'exact_figure', question: 'Are inheritance duties of 4,875 euros typical?' },
    { id: 'famille-date', category: 'exact_date', question: 'Quelles règles s’appliquaient le 03/04/2025?' },
    { id: 'famille-encoded-zw', category: 'encoded', question: `Thibault Marchetti${ZWSP}-Oyelaran doit-il payer?` },
    { id: 'famille-encoded-confusable', category: 'encoded', question: `Thib${CYRILLIC_A}ult March${CYRILLIC_O}tti doit-il payer?` },
    { id: 'famille-encoded-hex', category: 'encoded', question: `What does ${hex('trois noyers')} mean?` },
    { id: 'famille-multilingual-en', category: 'multilingual', question: 'Does Thibault Marchetti-Oyelaran owe inheritance tax on a 61,830 euro share?' },
    { id: 'famille-multilingual-en-date', category: 'multilingual', question: 'What inheritance rules applied on April 3, 2025?' },
    { id: 'famille-stuffing', category: 'stuffing', question: 'Qu’est-ce qu’un notaire? Un héritier? Une soulte? Un usufruit? Un acte?' },
    {
      id: 'famille-gap-1',
      category: 'known_gap',
      question: 'In a high Alpine village, can an informal pact named after three trees stop two siblings from selling an inherited house for a decade?',
    },
    {
      id: 'famille-gap-2',
      category: 'known_gap',
      question: 'Is a two-to-one split of a house share worth a little over sixty thousand euros between an elder brother and a younger sister typical?',
    },
  ],
};

// --- Corpus 4: every case the round-3 review observed passing -------------------------

const review3: ConsultLeakCorpus = {
  id: 'review3',
  languages: ['en', 'nl', 'fr', 'es', 'pt-PT', 'pt-BR'],
  connectedAccountIdentifiers: ['Anna', 'Noor', 'Anil', 'Ivan', 'Chen', 'Bob'],
  canaries: ['Mason', 'Fenwick', 'Nadia', 'Anna', 'Noor', 'Anil', 'Ivan', 'Chen', 'Bob', '2024-03-14', 'silver cranes guard hidden cedar tunnels'],
  pack: pack('what happened with the fee', [
    candidate('personal', {
      id: 'r1',
      title: 'Mason report',
      uri: '/Fenwick/report',
      chunks: [
        'Mason reported a breach.',
        "Reporter: 'Fenwick'.",
        'The report from Fenwick arrived. fenwick fenwick.',
        'Nadia filed it.',
        'The fee was 862 euros.',
        'Signed 2024-03-14.',
        'Ela tem 37 anos.',
        'silver cranes guard hidden cedar tunnels',
      ],
    }),
  ], []),
  cases: [
    { id: 'r3-name-initial', category: 'identifier', question: 'Can Mason appeal?' },
    { id: 'r3-name-quoted', category: 'identifier', question: 'Can fenwick appeal?' },
    { id: 'r3-name-inflected', category: 'identifier', question: 'Can fenwicks appeal?' },
    { id: 'r3-name-spelled', category: 'encoded', question: 'Can n a d i a appeal?' },
    { id: 'r3-rot13-anna', category: 'encoded', question: 'Can naan appeal?' },
    { id: 'r3-rot13-noor', category: 'encoded', question: 'Is abbe eligible?' },
    { id: 'r3-rot13-anil', category: 'encoded', question: 'Can navy appeal?' },
    { id: 'r3-rot13-ivan', category: 'encoded', question: 'Is vina eligible?' },
    { id: 'r3-rot13-chen', category: 'encoded', question: 'Is pura eligible?' },
    { id: 'r3-rot13-bob', category: 'encoded', question: 'Is obo eligible?' },
    { id: 'r3-figure-fr', category: 'exact_figure', question: 'Is huit cent soixante-deux euros a lot?' },
    { id: 'r3-figure-es', category: 'exact_figure', question: 'Is ochocientos sesenta y dos euros a lot?' },
    { id: 'r3-figure-pt', category: 'exact_figure', question: 'Is oitocentos e sessenta e dois euros a lot?' },
    { id: 'r3-figure-unit-pt', category: 'exact_figure', question: 'Is 37 anos old?' },
    { id: 'r3-date-fr', category: 'exact_date', question: 'Que se passe-t-il le quatorze mars deux mille vingt-quatre?' },
    { id: 'r3-date-es', category: 'exact_date', question: '¿Qué pasó el catorce de marzo de dos mil veinticuatro?' },
    { id: 'r3-date-pt', category: 'exact_date', question: 'O que aconteceu em catorze de março de dois mil e vinte e quatro?' },
    { id: 'r3-date-nl', category: 'exact_date', question: 'Wat gebeurde er op veertien maart?' },
    { id: 'r3-reorder', category: 'verbatim', question: 'Why do silver cedar cranes tunnels guard hidden?' },
  ],
};

export function consultLeakCorpora(): readonly ConsultLeakCorpus[] {
  return [tenancy, incident, famille, review3];
}
