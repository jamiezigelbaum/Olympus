// The gate against a private-evidence pack (moved from the retired
// consult-orchestrator tests on 2026-10-10, when the automatic escalation was
// removed): ask_anonymously at Strict still runs this gate.

import { describe, expect, test } from 'bun:test';
import { privateEvidencePack } from '../src/core/analyst-built-in.ts';
import { consultWriterContextFromPack, evaluateConsultRequest } from '../src/core/consult-gate.ts';
import { DEFAULT_CONSULT_SETTINGS, consultGateOptionsFromSettings } from '../src/core/consult-settings.ts';

const QUESTION = 'When does my lease end?';
const ANSWER = 'Your lease ends in May.';
const GAPS = ['The deposit terms are not stated.'];
const PACK = privateEvidencePack(QUESTION, [{ id: 'lease-1', title: 'Lease', text: 'The lease for the flat ends in May and the landlord holds the deposit.' }]);
const CLEAN_QUESTION = 'How are rental deposit disputes usually resolved between tenants and landlords?';
const COPIED_QUESTION = 'Does the lease for the flat ends in May and the landlord holds the deposit?';
// Refused at both levels: it copies four words of the question the owner asked
// (a copy of the documents alone may go out at the unnamed level).
const OWNER_COPY_QUESTION = 'When does my lease end in practice?';

describe('the gate against a private-evidence pack', () => {
  test('a clean question passes and a copied one is refused against the pack', () => {
    const context = consultWriterContextFromPack(PACK, { writerVisibleTexts: [QUESTION, ANSWER, ...GAPS] });
    expect(evaluateConsultRequest([CLEAN_QUESTION], context, {}, {}, { languages: ['en'] })).toEqual({ decision: 'pass', reasons: [] });
    expect(evaluateConsultRequest([COPIED_QUESTION], context, {}, {}, { languages: ['en'] }).decision).toBe('refuse');
    for (const level of ['general', 'unnamed'] as const) {
      expect(evaluateConsultRequest([OWNER_COPY_QUESTION], context, {}, {}, { languages: ['en'], level, askedQuestionTexts: [QUESTION] }).reasons).toContain('owner_question_copy');
    }
  });

  test('the implied-place case (M0 round 2): "Portugal" with countries and places on, absent from or present in the pack, and with both packs off; unit words pass', () => {
    const texts = (place: string) => ['What should I prepare for the trip?', `Your itinerary covers three days in ${place} with a morning flight and a hotel near the river.`, 'The documents do not say what the trip requires.'];
    const lisbon = privateEvidencePack('What should I prepare for the trip?', [
      { id: 'itinerary', text: 'Three days in Lisbon: the flight lands in the morning and the hotel is near the river.' },
    ]);
    const portugalPack = privateEvidencePack('What should I prepare for the trip?', [
      { id: 'itinerary', text: 'Three days in Portugal: the flight lands in the morning and the hotel is near the river.' },
    ]);
    const absent = consultWriterContextFromPack(lisbon, { writerVisibleTexts: texts('Lisbon') });
    const present = consultWriterContextFromPack(portugalPack, { writerVisibleTexts: texts('Portugal') });
    const defaults = consultGateOptionsFromSettings(DEFAULT_CONSULT_SETTINGS);
    expect(defaults.domains).toMatchObject({ countries: true, places: true, technical: true });
    const question = ['What entry rules apply to visitors arriving in Portugal?'];
    // Countries are admitted by default (owner decision 2026-10-07): an implied
    // country the documents never write passes; one they do write is refused by
    // the snapshot name rule; with the countries and places packs off the
    // vocabulary refuses it.
    expect(evaluateConsultRequest(question, absent, {}, {}, defaults)).toEqual({ decision: 'pass', reasons: [] });
    const held = evaluateConsultRequest(question, present, {}, {}, defaults);
    expect(held.decision).toBe('refuse');
    expect(held.reasons).toContain('snapshot_name');
    expect(held.reasons).not.toContain('unknown_word');
    const off = evaluateConsultRequest(question, absent, {}, {}, { ...defaults, domains: { ...defaults.domains, countries: false, places: false } });
    expect(off.decision).toBe('refuse');
    expect(off.reasons).toContain('unknown_word');
    expect(evaluateConsultRequest(['What passport validity do most countries require from visitors?'], absent, {}, {}, defaults)).toEqual({ decision: 'pass', reasons: [] });
    // The temperature scale names (C4b review round 1 found them refused) are
    // in the olympus-terms pack since 2026-10-07, capitalised or not.
    for (const scale of ['How are Celsius and Fahrenheit readings converted in practice?', 'How are celsius and fahrenheit readings converted in practice?']) {
      expect({ scale, verdict: evaluateConsultRequest([scale], absent, {}, {}, defaults) }).toEqual({ scale, verdict: { decision: 'pass', reasons: [] } });
    }
    expect(evaluateConsultRequest(['How are temperature scales usually converted in practice?'], absent, {}, {}, defaults)).toEqual({ decision: 'pass', reasons: [] });
  });
});
