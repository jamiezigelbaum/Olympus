// Synthetic multi-version documents for the version-consistency eval: a
// fictional purchase offer saved as a first draft, a revision and a signed
// final copy (each later version changes the price, the deposit or the
// deadline), a later contract for the same deal that sets a different
// deposit, an older offer for another buyer on the same template wording,
// and an unrelated lease. No real person, property or value.
//
// The trap (owner report 2026-10-08): retrieval surfaces a different subset of
// the versions on each run, and an answer that silently reads whichever one
// it got states different facts each time.

export interface VersionedFixtureItem {
  id: string;
  title: string;
  /** ISO time the file was last modified. */
  saved: string;
  folder: string;
  text: string;
}

const offerBody = (input: { buyer: string; price: string; deposit: string; deadline: string; status: string }) => [
  `OFFER TO PURCHASE. Property: 14 Larch Court, Elmbridge. Seller: Robin Ashdown. Buyer: ${input.buyer}.`,
  `The buyer offers a purchase price of ${input.price} for the property, free of charges and tenants, subject to the terms below.`,
  `On acceptance the buyer pays a reservation deposit of ${input.deposit} to the agent's client account, credited against the price at completion.`,
  `The parties will sign the private purchase contract no later than ${input.deadline}. If the buyer withdraws before that date the reservation deposit is forfeited; if the seller withdraws it is returned in full.`,
  'Furniture listed in the inventory annex is included. The buyer has inspected the property and accepts its condition. Each party pays its own costs and taxes as provided by law.',
  `Status: ${input.status}.`,
].join(' ');

export const VERSIONED_FIXTURE_ITEMS: readonly VersionedFixtureItem[] = [
  {
    id: 'offer-v1',
    title: 'Offer 14 Larch Court draft.docx',
    saved: '2025-11-02T10:12:00Z',
    folder: '/Home/Sale/Offer',
    text: offerBody({ buyer: 'Kim Okafor', price: '€640,000', deposit: '€5,000', deadline: '1 December 2025', status: 'draft for discussion' }),
  },
  {
    id: 'offer-v2',
    title: 'Offer 14 Larch Court revised.docx',
    saved: '2025-11-20T16:40:00Z',
    folder: '/Home/Sale/Offer',
    text: offerBody({ buyer: 'Kim Okafor', price: '€625,000', deposit: '€6,000', deadline: '12 December 2025', status: 'revised after counter-offer' }),
  },
  {
    id: 'offer-v3',
    title: 'Offer_14_Larch_Court_signed.pdf',
    saved: '2025-12-03T09:05:00Z',
    folder: '/Home/Sale/Offer',
    text: offerBody({ buyer: 'Kim Okafor', price: '€620,000', deposit: '€6,000', deadline: '19 December 2025', status: 'signed by both parties' }),
  },
  {
    id: 'contract',
    title: 'Private purchase contract 14 Larch Court.docx',
    saved: '2026-01-10T12:00:00Z',
    folder: '/Home/Sale/Contract',
    text: [
      'PRIVATE PURCHASE CONTRACT between Robin Ashdown (seller) and Kim Okafor (buyer) for 14 Larch Court, Elmbridge.',
      'Price: €620,000. On signing, the buyer pays a contract deposit of 10% of the price, €62,000, by bank transfer, credited against the price.',
      'Completion before a notary no later than 15 March 2026. If the buyer fails to complete the deposit is forfeited; if the seller fails it is returned doubled.',
    ].join(' '),
  },
  {
    id: 'old-offer',
    title: 'Offer 14 Larch Court 2023 (withdrawn).pdf',
    saved: '2023-05-14T08:30:00Z',
    folder: '/Home/Sale/_Old',
    text: [
      'Earlier offer from Dana Whitfield, received in May 2023 and withdrawn before acceptance.',
      'Proposed purchase price €590,000 with a reservation deposit of €3,000 and a contract by 30 June 2023.',
      'The seller declined and the offer lapsed.',
    ].join(' '),
  },
  {
    id: 'lease',
    title: 'Lease summary 3 Birch Row.pdf',
    saved: '2024-02-01T09:00:00Z',
    folder: '/Home/Rentals',
    text: 'Lease of 3 Birch Row to a tenant for 24 months from 1 March 2024 at €1,450 a month, with a deposit of two months. Rent reviewed yearly by inflation.',
  },
];

export interface VersionedFixtureQuestion {
  id: string;
  question: string;
  /** Values the newest version gives: every run's answer must contain them. */
  expectedNewest: readonly string[];
  /** Values only superseded versions give: an answer naming one must also name its version or date. */
  supersededValues: readonly string[];
}

export const VERSIONED_FIXTURE_QUESTIONS: readonly VersionedFixtureQuestion[] = [
  {
    id: 'v01',
    question: 'What purchase price and reservation deposit are in the offer for 14 Larch Court?',
    expectedNewest: ['620,000', '6,000'],
    supersededValues: ['640,000', '625,000', '5,000'],
  },
  {
    id: 'v02',
    question: 'By when must the purchase contract for 14 Larch Court be signed under the offer?',
    expectedNewest: ['19 December 2025'],
    supersededValues: ['1 December 2025', '12 December 2025'],
  },
];

/** The fixture's items as private search hits, in the given retrieval order. */
export function versionedFixtureHits(order: readonly string[]): Array<Record<string, unknown>> {
  const byId = new Map(VERSIONED_FIXTURE_ITEMS.map((item) => [item.id, item]));
  return order.map((id) => {
    const item = byId.get(id)!;
    return {
      sourceItem: { provider: 'fixture', family: 'file', accountScope: 'personal', localItemId: id, providerItemId: id },
      provenance: { citation: { title: item.title, authoredAt: item.saved, uri: `${item.folder}/${item.title}`, sourceLabel: 'files' } },
      chunks: [item.text],
      trustDomain: 'secure_local',
    };
  });
}
