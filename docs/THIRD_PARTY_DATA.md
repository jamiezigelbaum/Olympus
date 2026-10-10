# Third-party data

Olympus's code is MIT-licensed (see [`LICENSE`](../LICENSE)). It also ships data
files written by others, each under its own licence. They are listed here.

## Consult gate vocabulary packs

The consult outbound gate (`src/core/consult-gate.ts`) admits a consult
question only if every word is in a configured vocabulary.

- **Location:** the word packs live in
  [`assets/consult/vocabulary/`](../assets/consult/vocabulary/).
- **Format:** each pack is a gzip-compressed, sorted word list built by
  `scripts/build-consult-vocabulary.ts`.
- **Integrity:** each pack's SHA-256 is pinned in `CONSULT_VOCABULARY_PACKS`.
- **Licence files:** each pack has a `<pack>.LICENSE.txt` beside it, holding the
  upstream licence and notices, the exact source (download URL and SHA-256),
  the generator, and a description of the transformation.

**What gets loaded.** The gate loads only the packs the owner's settings select
(`ConsultGateOptions`):

- **Consult languages:** English by default; the owner may add more.
- **Domain packs:** switched on or off separately, with the defaults shown in
  the table.

Every other pack stays on disk unused.

| File | Content | Source | Licence | Selected by | Words | Size |
|---|---|---|---|---|---|---|
| `en-esdb.txt.gz` | English | English Speller Database (SCOWL) rel-2026.02.25, size 70; source tarball https://github.com/en-wl/wordlist/archive/refs/tags/rel-2026.02.25.tar.gz (SHA-256 74e7cc3e9e03e609c1c74bb7e8862fcd988cdd64768dcbee4611581b7e633852) | SCOWL/ESDB notice (permissive) | language `en` (default) | 129,952 | 0.35 MB |
| `nl-opentaal.txt.gz` | Dutch | npm dictionary-nl 2.0.0 (OpenTaal) | BSD-3-Clause (chosen from BSD-3-Clause OR CC-BY-3.0) | language `nl` | 279,034 | 0.82 MB |
| `fr-grammalecte.txt.gz` | French | npm dictionary-fr 3.0.0, https://registry.npmjs.org/dictionary-fr/-/dictionary-fr-3.0.0.tgz (SHA-256 b20ab69249881bc36b1dcdfbfd2df226660a7cecc95f2cf122714008b491c78e) | MPL-2.0 | language `fr` | 413,225 | 1.00 MB |
| `es-hunspell.txt.gz` | Spanish | npm dictionary-es 4.0.0, https://registry.npmjs.org/dictionary-es/-/dictionary-es-4.0.0.tgz (SHA-256 b46986527b23ff1a578d601db7f1e6dc80cc36b728fdcb6044b5212e12e202d5) | MPL-1.1 (chosen) | language `es` | 587,002 | 1.38 MB |
| `pt-br-hunspell.txt.gz` | Portuguese (Brazil) | npm dictionary-pt 4.0.0, https://registry.npmjs.org/dictionary-pt/-/dictionary-pt-4.0.0.tgz (SHA-256 644a05af5c6d2c16eea1093c7ac4c14b45637170cf5b3dd1c07ae0f13256b54d) | MPL-2.0 (chosen) | language `pt-BR` | 2,611,573 | 6.59 MB |
| `pt-pt-hunspell.txt.gz` | Portuguese (Portugal) | npm dictionary-pt-pt 2.0.0, https://registry.npmjs.org/dictionary-pt-pt/-/dictionary-pt-pt-2.0.0.tgz (SHA-256 91dfb9749a4221dcdd7a7dd9a0270ed1cf878fe5f93c65599a789dbfda2ced5c) | MPL-1.1 (chosen) | language `pt-PT` | 383,286 | 0.89 MB |
| `cldr-units.txt.gz` | Unit names, 7 languages | Unicode CLDR 48.2 (npm cldr-units-full 48.2.0) | Unicode-3.0 | domain `units` (default on) | 1,614 | 0.00 MB |
| `cldr-countries.txt.gz` | Country names, 7 languages | Unicode CLDR 48.2 (npm cldr-localenames-full 48.2.0) | Unicode-3.0 | domain `countries` (default on) | 1,239 | 0.00 MB |
| `places.txt.gz` | Place names: populated places of 15,000 or more and first-level regions (name and ASCII name only; no alternate names) | GeoNames, `cities15000.zip` (SHA-256 865724f89e3274c5172df2f6068596dfb25bb604737ac2711b5ca6d31aebbf32) and `admin1CodesASCII.txt` (SHA-256 1da92a6323a5fec3176f3f743bf4cf4040fd56a876da55e46fbca23c863aa60a), downloaded 2026-10-07 from https://download.geonames.org/export/dump/ | CC BY 4.0; attribution: GeoNames, https://www.geonames.org/ | domain `places` (default on) | 34,063 | 0.11 MB |
| `olympus-terms.txt.gz` | General terms: units CLDR drops (Celsius, Fahrenheit), file formats, protocols, device and network terms, regions, a few stable general proper terms | Olympus-authored: `scripts/data/consult-olympus-terms.txt` (no third-party data) | Olympus-authored (see `olympus-terms.LICENSE.txt`) | domain `technical` (default on) | 187 | 0.00 MB |
| `rx-ingredients.txt.gz` | Medicine ingredient names | NLM RxNorm Current Prescribable Content 2026-10-05 (IN, PIN; single words) | Public domain; NLM attribution | domain `medicines` (default on) | 2,197 | 0.01 MB |
| `rx-brands.txt.gz` | Medicine brand names | NLM RxNorm Current Prescribable Content 2026-10-05 (BN; single words) | Public domain; NLM attribution | domain `medicineBrands` (default off) | 3,217 | 0.01 MB |

### Proper nouns

Every pack except English and the country names is filtered for proper nouns
in two ways:

- **Global list.** The single-word capitalised entries of the ESDB size-80
  list, minus ordinary lower-case English words, are dropped wherever only an
  affix derivation produced them.
- **The dictionary's own markers.** Each dictionary's own proper nouns are
  dropped. So are its stems marked KEEPCASE, FORCEUCASE, NOSUGGEST or WARN, and
  nothing is derived from them.

Genuine lower-case dictionary entries that are also names stay in the packs,
for example French "fenwick" (a forklift). The gate's snapshot rules are the
second line of defence for these.

### Mozilla Public License packs

The MPL covers each pack file only; no MPL-covered material is in any code
file of this repository. The packs are:

- `fr-grammalecte.txt.gz` (MPL-2.0)
- `es-hunspell.txt.gz` (MPL-1.1)
- `pt-br-hunspell.txt.gz` (MPL-2.0)
- `pt-pt-hunspell.txt.gz` (MPL-1.1)

Where upstream offered a choice of licences, the MPL option was chosen, and the
choice is recorded in each pack's header and licence file.

**Source form.** For each MPL pack, the source form is three things:

- the upstream npm tarball named in its licence file, at its
  `registry.npmjs.org` URL, with its SHA-256;
- `scripts/build-consult-vocabulary.ts` in the public Olympus source
  repository, identified in the licence file by its git blob id. The id is
  content-addressed, so it stays valid across history rewrites:
  `git hash-object scripts/build-consult-vocabulary.ts` reproduces it, and
  `git log --find-object=<blob id>` names the commit that holds it;
- the command line shown there.

Each MPL licence file also carries a dated description of the modifications
Olympus made (MPL-1.1 §3.3).

### NLM attribution (medicines packs)

This product uses publicly available data courtesy of the U.S. National Library of Medicine (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product.

### Optional packs Olympus does not ship (German, Italian)

The only German and Italian word lists found are GPL-licensed, so Olympus does
not ship them.

**Source-checkout procedure.** The installer script is not in the installed
package; it runs from a checkout of the Olympus source repository (the GitHub
repository the package is released from), with [Bun](https://bun.sh)
installed:

```sh
git clone <the Olympus source repository URL> olympus
cd olympus
bun install
bun scripts/install-consult-language-pack.ts de   # or: it
```

That command does three things on the user's own machine:

1. It downloads the pinned upstream version (npm `dictionary-de` 3.0.0, or
   `dictionary-it` 2.0.0) and checks it against an integrity hash pinned in
   the script.
2. It builds a pack from it into `~/.olympus/consult/vocabulary/` (or into
   `OLYMPUS_CONSULT_VOCABULARY_DIR` if set), writing atomically.
3. It records the pack's SHA-256 in a local `manifest.json`.

The gate admits an installed pack only when the owner's consult languages
include that language. It checks the pack against the manifest hash when it
loads it, and skips a pack that does not match.

Nothing is written to this repository or to `dist/`. The installed packs stay
under their upstream GPL licences.

- `--status` lists the installed packs.
- `--remove de` (or `it`) deletes one.
