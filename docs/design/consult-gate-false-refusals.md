# Consult gate: false refusals on ordinary questions

Date: 2026-10-07. Question: how often does the outbound check (`evaluateConsultRequest`, `src/core/consult-gate.ts`) refuse an ordinary, legitimate general-knowledge question a local writer might produce? Reported, not gated. Run `bun eval/consult-leak/false-refusals.ts` (questions in `eval/consult-leak/false-refusals-questions.ts`; `--refused a` lists every refusal for a configuration).

## Method

- 223 English questions in ten categories (about 22 each) plus 8 each in pt-BR, es, fr and de. Written for the measurement as a careful writer would: background only, no names, figures or identifiers; not tuned against the gate.
- Snapshot: a one-candidate synthetic `EvidencePack` of ordinary prose that shares no word with the questions, so a refusal is vocabulary or shape driven, never copying.
- Configurations: (a) defaults (English, units, medicine ingredients); (b) a plus `countries`; (c) all six shipped languages; (d) c plus countries; (e) d with German requested but its pack not installed.
- The refused words are recomputed against the same packs (letter-run test of `hasUnknownWord`).

## Refusal rate

| Category | a defaults | b +countries | c all langs | d all langs +countries |
|---|---|---|---|---|
| cooking (22) | 0% | 0% | 0% | 0% |
| medicine (23) | 0% | 0% | 0% | 0% |
| law and tax (22) | 4.5% | 4.5% | 0% | 0% |
| travel (22) | **86.4%** | 27.3% | 72.7% | 22.7% |
| finance (22) | 4.5% | 4.5% | 4.5% | 4.5% |
| technology (23) | **30.4%** | 30.4% | 26.1% | 26.1% |
| science and units (23) | 13.0% | 13.0% | 4.3% | 4.3% |
| health and fitness (22) | 9.1% | 9.1% | 4.5% | 4.5% |
| home and DIY (22) | 0% | 0% | 0% | 0% |
| education (22) | 9.1% | 9.1% | 9.1% | 9.1% |
| **All English (223)** | **15.7% (35)** | **9.9% (22)** | 12.1% (27) | 7.2% (16) |
| pt-BR, es, fr (8 each) | 100% | 100% | 0% | 0% |
| de (8) | 100% | 100% | 100% | 100% |

Configuration e is identical to d: a requested but uninstalled German pack still refuses German as `unknown_word` (it does not surface `vocabulary_unavailable`), so the owner is not told the pack is missing from the refusal alone.

## Reason codes

Every refusal in every configuration is `unknown_word`. No other code (content-word cap, sentence count, shape, snapshot rules, length) fired on any of the 223 English questions or 32 foreign-language ones. The false-refusal problem is entirely vocabulary coverage.

## Refused words (configuration a, then what should hold them)

- Countries pack (12 words, 13 questions): Canada (2), Australia, Belgium, Germany, India, Ireland, Italy, Mexico, Portugal, Spain, Switzerland, Thailand. Already shipped; fixed by `countries: true` (config b).
- Cities and regions (no pack ships them): Paris, London, New York (York), Boston, Lisbon, Rome, Florence, Tokyo, Schengen. These stay refused with countries on (5 city questions, plus Schengen). Cities are a location disclosure and several are given names (Paris), so these are correctly a policy decision, not a gap.
- Units (should be in the units pack): Celsius (2), Fahrenheit (2), BTU. The CLDR pack lacks temperature-scale names.
- Technical terms, formats, protocols, brands: Bluetooth, DOCX, JPEG, PNG, Ethernet, Wi-Fi (tokens `wi`, `fi`), HDD, IMAP, iOS, GPA, VO2 (`vo`). No shipped pack has them; `SSD`, `PDF`, `CSV`, `DNS`, `VPN`, `HTTP`, `USB` pass.
- Proper nouns and loanwords: Roth, Mediterranean, Montessori, majeure (from "force majeure").

Non-English under defaults: every word of a non-English question is unknown, so 100% refused until the language is enabled; with the matching shipped language enabled all 24 pt-BR, es and fr questions passed (accented text included). German is 100% refused in every configuration without the user-installed pack, as designed.

## Recommendation

1. Add to the units pack: temperature scale names (Celsius, Fahrenheit) and BTU, or generally the CLDR "degrees ..." display names that the generator drops. Fixes 3 questions (1.3%).
2. Add a small shipped technical pack (about 100 to 200 file formats, protocols and device terms: DOCX, JPEG, PNG, Bluetooth, Ethernet, Wi-Fi, HDD, IMAP, iOS, GPA) in the same generic-tooling spirit as units. These are not personal names. Fixes 7 to 8 questions (3%). Watch Wi-Fi: the tokenizer splits it into `wi` and `fi`, so either list both halves or fold hyphenated forms.
3. Enable `countries` by default, or have setup ask once and explain the cost. It is the single largest lever: travel falls from 86% to 27% and English overall from 15.7% to 9.9%. The disclosure cost is real (a country in a question narrows where the owner is or travels) and the owner decides; that trade-off is outside this measurement.
4. Leave cities refused. Add a short list of stable proper-noun general terms (Roth, Mediterranean, Montessori, Schengen) only if the pack owner accepts them as non-personal; otherwise accept the refusal.
5. Tell the writer (instructions) that proper nouns, brands and place names refuse; "a mid-size European city" and "a Roth-style account" phrased generically pass. Writers should prefer class words.
6. When a requested language pack is not installed, say so in the refusal surface; today it looks like an ordinary refusal.

Expected residual false-refusal rate on ordinary English questions, estimated by removing the fixable words and re-running the same refusals: defaults as shipped 15.7%; with fixes 1 and 2 and countries on, 10 questions (4.5%) remain, falling to 5 (2.2%) if the four proper-noun terms also go in; the remainder is cities. Without countries by default, expect about 10%. Travel-heavy usage will be above these averages, since this set is travel-light by design; non-English owners must enable their language or see 100% refusal.

## Latency

1,275 gate calls across five configurations (warm, plus one vocabulary load per distinct pack selection): median under 1 ms (0.4 to 0.9 ms across runs), p95 1 to 7 ms. The first call with a given pack selection pays vocabulary decompression, up to about 10 s on a cold first call in this run. The gate is not a latency concern after the first call.
