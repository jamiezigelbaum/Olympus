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

## Unnamed level

Date: 2026-10-07. The "Your situation, without names" level (owner decision
2026-10-07; rules in `docs/design/consult-writer-instructions.md`). Run
`bun eval/consult-leak/unnamed-level.ts`; the leak corpus runs at both levels
in `bun eval/consult-leak/run.ts`.

**Set.** 30 situation cases (`eval/consult-leak/unnamed-questions.ts`):
housing, employment, health, family, finance, consumer, travel, education.
Each carries the documents the answer read (names, towns, dates, amounts,
account numbers, titles), the answer and its gaps, one legitimate question as
a careful writer at this level would send it, and 67 leak variants (the same
question with a name, place, date or year, exact amount, identifier or title
put back). Written before the gate was widened and not edited against its
verdicts, except one canary ("Greg") that the independent oracle's ROT13 view
matched in ordinary prose ("after they").

**Review round 1 and the owner's ruling (2026-10-07).** Round 1 found three
leaks in the first widening: a bare "per" counted as a percent ("120 per
hour" let 120 through), a figure in digits masked the same value in number
words ("120 days ... one hundred twenty euros"), and the combined copy
relaxations admitted a lower-case name copied from the answer ("the red
lion"). The first two are fixed: a percent must be "%", "percent" or a
single-word equivalent, and a snapshot figure is repeated only when every
occurrence of its value, in digits or in words, and every occurrence in the
question is followed by a duration or percent. The owner then ruled "err on
the side of allowing more through": the copy relaxations stay, with the
lower-case-name case recorded as an accepted residual, and a dictionary word
(or a country) that the snapshot also writes in lower case is no longer taken
for a name. The loaded example now reads "requires 60 days", because a bare
repeated figure is refused.

**Before and after (hand-written legitimate questions).**

| | general gate | unnamed, first version (26ae361d) | unnamed, after round 1 |
|---|---|---|---|
| legitimate refused | 29 / 30 (97%) | 24 / 30 (80%) | 16 / 30 (53%) |
| leak variants passed | 0 / 67 | 0 / 67 | 0 / 67 |
| leak corpus: canary leaks, leak cases passed | 0, 0 | 0, 0 | 0, 0 |
| leak corpus clean set refused | 22.6% | 22.6% | 22.6% |

The 16 left: 6 copies of five or more document words; 3 figures (two year
counts, refused as possible ages, and a bare 180); 4 the name rules on a
word the snapshot only ever capitalizes or also puts in a title ("St Aldhelm
Primary", "Estate valuation: house", "Offer letter" beside its title, and a
country written once in a heading); 1 a generic document title ("Fit
note"); 2 unknown words (INR, timesheets). Two-sentence situations now pass.

**Soft residuals (counted, not failures).** Sample given names, surnames and
cities (`eval/consult-leak/name-sample.ts`) written once at a sentence start
and named in the question in lower case: the unnamed level lets through
exactly what the general level does (2 of 223 given names, 4 of 215
surnames, 0 of 102 cities: short or dictionary words). Exempting every
sentence-initial dictionary word as well would have let 39 given names, 47
surnames and 17 cities through and passed no extra legitimate question, so
it is not done. Not counted by the corpora, and accepted by the owner: a
lower-case or dictionary-word name copied from the documents or the answer
("the red lion"), and a dictionary-word name the snapshot also uses in lower
case.

**Real local writer.** The built-in Qwen3.5 4B writer on this set with the
unnamed rules (`eval/consult-reid/run-real.ts`, recorded in
`eval/consult-reid/recorded-unnamed-set.json`, re-recorded after the prompt
change): 30 of 30 proposed; 20 pass the unnamed gate (first version: 15 of
the earlier recording), against 6 of the same outputs at the general gate;
no output that passes carries a canary. Re-identification
(`eval/consult-reid/`): 3 of 10 pass the gate, none narrows to a person,
keeps all three quasi-identifiers, an exact figure or a canary.

**Review round 2 (both levels, stricter).** "7 Park street" beside "a park"
let "Is 7 park street safe?" through at the unnamed level (lower-case "park"
exempted the capital, a one-digit house number is under the figure threshold,
and mixed case defeated the pair match). Address spans (a house number within
five words of a street word, in every configured language) are now protected
at both levels whatever their capitalization. The unnamed false refusals
stayed at 16 of 30, the general and held-out rates did not move, and the
real-writer pass counts stayed 20 (unnamed) and 6 (general).

**Gate fix found on the way (both levels, stricter).** A snapshot amount with
a zero fraction ("2,400.00") was keyed only as "240000" and "24", so "2,400"
in a question was not matched; it now also keys as "2400" and is refused.
This tightens the general level too.

**Words of the question ChatGPT sent (2026-10-08, unnamed level only).** A
live consult was refused for "Catalonia", a place named in the question
ChatGPT already sent. Owner ruling: a word of that question is exempt from
the name and figure rules at the unnamed level; hard identifiers stay
refused at both levels, and copying its wording is refused at both levels as
`owner_question_copy` (any four-word window with two content words, or four
content words, in any order, number words read as digits), since the
provider also sees the conversation (rule:
`CONSULT_GATE_ASKED_WORDS_MAX_FIGURE_RUN_DIGITS` in
`src/core/consult-gate.ts`). The evals now pass the question to the gate as
the orchestrator does (`askedQuestionTexts`). Review round 1 (account numbers
as amounts, number words, reordering, the whole retained question) left
every number below unchanged.

| unnamed level | before | after |
|---|---|---|
| legitimate refused (this set) | 16 / 30 | 14 / 30 |
| leak variants passed | 0 / 67 | 0 / 67 |
| leak corpus: canary leaks | 0 | 0 |
| leak corpus clean set refused | 22.6% | 19.4% |
| leak corpus: copies of the owner's question passed | 0 / 3 | 0 / 3 (now `owner_question_copy`) |
| real-writer recording passed (unnamed / general) | 20 / 6 | 18 / 6 (two copy four words of the owner's question) |
| held-out sets, soft residuals | unchanged | unchanged |
| re-identification set: pass the gate / narrow / canary | 3 / 0 / 0 | 4 / 0 / 0 |

The general level and the false-refusal set (general level) are unchanged.

**Copied document wording (2026-10-08, unnamed level only).** The PII
bake-off (`docs/design/consult-pii-bakeoff.md`, PR #197) found the copy rule,
not unknown names, behind most of this level's refusals. Owner ruling: a copy
of the documents may go out at the unnamed level unless it carries a hard
identifier (rule: `CONSULT_GATE_UNNAMED_COPIED_WORDING_MAY_PASS` in
`src/core/consult-gate.ts`). Every other rule still reads every copied word,
and inside a copy every word the documents capitalize counts as a name
however it is written, even at a sentence start beside a lower-case use
(review round 1; the counts below did not move). Copies of the owner's question stay
refused at both levels. The general level is unchanged: every
general-level verdict over these fixtures is pinned by digest
(`test/consult-gate-unnamed-copy.test.ts`).

| unnamed level | before | after |
|---|---|---|
| legitimate refused (this set) | 14 / 30 | 9 / 30 |
| leak variants passed | 0 / 67 | 0 / 67 |
| leak corpus: canary leaks, identifier/figure/date/encoded cases passed | 0, 0 | 0, 0 |
| leak corpus: copied document wording passed (`verbatim`, soft residual) | 0 / 12 | 6 / 12 (none carries a canary) |
| leak corpus: copies of the owner's question passed | 0 / 3 | 0 / 3 |
| leak corpus clean set refused | 19.4% | 12.9% |
| real-writer recording passed (unnamed / general) | 18 / 6 | 20 / 6 |
| re-identification set: pass the gate / narrow / figure / canary | 4 / 0 / 0 / 0 | 4 / 0 / 0 / 0 |
| bake-off harness, gate only: situation / recorded 40 / leak corpus legitimate refused | 16 / 17 / 14 | 12 / 15 / 12 |
| bake-off harness, gate only: name probes / identifier probes passed | 1 / 500, 0 / 32 | 1 / 500, 0 / 32 |
| held-out sets, false-refusal set, sentence-initial name residual | unchanged | unchanged |

(The bake-off harness does not pass the question ChatGPT sent to the gate,
so its situation count is higher than this eval's.) The 9 left: 3 figures
(two year counts, a bare 180), 2 snapshot identifiers ("Fit note", "St
Aldhelm Primary"), 2 unknown words (INR, timesheets), and 2 names written
only capitalized: a country in a heading ("Canada"), and "Three", which
its documents write only at the start of sentences (an older name-rule
false positive the copy refusal used to hide).

The unnamed false-refusal rate is held by a regression ceiling at the
measured 9 of 30 (`UNNAMED_LEVEL_GATES`), not a usability target.
