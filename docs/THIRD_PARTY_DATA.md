# Third-party data

Olympus's code is MIT-licensed (see [`LICENSE`](../LICENSE)). It also ships data
files written by others, each under its own licence. They are listed here.

## Consult gate vocabulary packs

The consult outbound gate (`src/core/consult-gate.ts`) only lets a consult
question through if every word in it is in an allowed vocabulary. These word
packs live in [`assets/consult/vocabulary/`](../assets/consult/vocabulary/).

- **Format:** each pack is a gzip-compressed, sorted word list built by
  `scripts/build-consult-vocabulary.ts`.
- **Integrity:** each pack's SHA-256 is pinned in `CONSULT_VOCABULARY_PACKS`.
- **Licence files:** each pack has a `<pack>.LICENSE.txt` beside it, holding the
  upstream licence, its notices, and the source statement.

| File | Language or content | Source | Licence | Words | Size |
|---|---|---|---|---|---|
| `en-esdb.txt.gz` | English | English Speller Database (SCOWL) rel-2026.02.25, size 70 | SCOWL/ESDB notice (permissive) | 129,952 | 0.35 MB |
| `nl-opentaal.txt.gz` | Dutch | OpenTaal, npm dictionary-nl 2.0.0 | BSD-3-Clause (chosen from BSD-3-Clause OR CC-BY-3.0) | 279,716 | 0.82 MB |
| `fr-grammalecte.txt.gz` | French | Grammalecte dictionaries 7.5, npm dictionary-fr 3.0.0 | MPL-2.0 | 414,229 | 1.00 MB |
| `es-hunspell.txt.gz` | Spanish | es_ES 2.8, npm dictionary-es 4.0.0 | MPL-1.1 (chosen from GPL-3.0+ OR LGPL-3.0+ OR MPL-1.1+) | 587,509 | 1.38 MB |
| `pt-br-hunspell.txt.gz` | Portuguese (Brazil) | VERO, npm dictionary-pt 4.0.0 | MPL-2.0 (chosen from LGPL-3.0 OR MPL-2.0) | 2,614,939 | 6.60 MB |
| `pt-pt-hunspell.txt.gz` | Portuguese (Portugal) | npm dictionary-pt-pt 2.0.0 | MPL-1.1 (chosen from GPL-2.0 OR LGPL-2.1 OR MPL-1.1) | 383,619 | 0.89 MB |
| `cldr-names.txt.gz` | Units, countries (7 languages) | Unicode CLDR 48.2 | Unicode-3.0 | 2,895 | 0.01 MB |
| `rx-rxnorm.txt.gz` | Medicines | NLM RxNorm Current Prescribable Content, 2026-10-05 (IN, PIN, MIN, BN) | Public domain; NLM attribution | 9,965 | 0.04 MB |

### Mozilla Public License packs

These packs are Covered Software under the Mozilla Public License:

- `fr-grammalecte.txt.gz` (MPL-2.0)
- `es-hunspell.txt.gz` (MPL-1.1)
- `pt-br-hunspell.txt.gz` (MPL-2.0)
- `pt-pt-hunspell.txt.gz` (MPL-1.1)

The MPL covers each pack file only. No MPL-covered material is in any code
file of this repository.

The source form of each pack is:

- the upstream npm package named in its header and licence file, and
- `scripts/build-consult-vocabulary.ts`, which turns that package into the pack.

Where upstream offered a choice of licences, the MPL option was chosen, and the
choice is recorded in the pack's header and licence file.

### NLM attribution (medicines pack)

This product uses publicly available data courtesy of the U.S. National Library of Medicine (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product.

### Optional packs Olympus does not ship (German, Italian)

The only German and Italian word lists found are GPL-licensed, so Olympus does
not ship them. A user who wants them runs:

```sh
bun scripts/install-consult-language-pack.ts de   # or: it
```

That command does three things on the user's own machine:

1. It downloads the upstream hunspell dictionary (npm `dictionary-de` 3.0.0, or
   `dictionary-it` 2.0.0) and checks it against the registry's integrity hash.
2. It builds a pack from it into `~/.olympus/consult/vocabulary/` (or into
   `OLYMPUS_CONSULT_VOCABULARY_DIR` if set).
3. It records the pack's SHA-256 in a local `manifest.json`.

The gate checks each installed pack against that hash when it loads. A pack that
does not match is skipped.

Nothing is written to this repository or to `dist/`. The installed packs stay
under their upstream GPL licences.

- `--status` lists the installed packs.
- `--remove de` (or `it`) deletes one.
