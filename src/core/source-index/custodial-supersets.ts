/**
 * Compatibility surface retained for downstream consumers. Canonical
 * connector stores expose disjoint corpus counts, so there are no custodial
 * supersets to subtract after Slice 2.
 */
export interface CustodialSupersetCorpus {
  custodial_corpus_id: string;
  band_corpus_ids: readonly string[];
}

export const CUSTODIAL_SUPERSET_CORPORA: readonly CustodialSupersetCorpus[] = [];

/**
 * The custodial superset whose count already contains this corpus, if any.
 */
export function custodialSupersetForBandCorpus(
  bandCorpusId: string,
): CustodialSupersetCorpus | undefined {
  return CUSTODIAL_SUPERSET_CORPORA
    .find((entry) => entry.band_corpus_ids.includes(bandCorpusId));
}
