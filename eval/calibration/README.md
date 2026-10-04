# Calibration kit: is Olympus's Private really private?

Step 1 of [the categorization precision plan](../../docs/design/categorization-precision.md).
This kit stands apart from the plugin. It reads your files and Olympus's code
and models, but never opens an Olympus store, ledger or engine, and never
changes what Olympus stores or serves.

Its data lives in `~/.local/share/olympus-calibration/` (owner-only), outside
the repository and outside Olympus's own data. Set `OLYMPUS_CALIBRATION_DIR`
to use another folder.

## 1. Sample (done once)

```bash
bun eval/calibration/sample.ts
```

- **What it reads:** your Dropbox folder on this Mac. It picks 150 real
  documents that already have readable text (PDF, Word, Excel, PowerPoint,
  text, Markdown, CSV, HTML), using Olympus's own text extractor.
  - Online-only files are skipped, so nothing is downloaded.
  - Scans with no text layer are skipped.
- **How it picks:**
  - Half the sample is files whose folder or name suggests someone's own
    records (health, tax, bank, insurance, legal, and so on). These are taken
    where they are densest.
  - The other half is spread across every area for breadth.
  - At most 8 files per area, and 3 per folder.
- **Reproducible:** the same `--seed` gives the same sample. `--force`
  replaces an existing sample.

## 2. Label (about 20 minutes)

```bash
bun eval/calibration/label.ts
```

This opens a page on `127.0.0.1` only, behind a one-time link. Each file shows
its name, folder and text.

| Key | Label |
|---|---|
| **P** | Personal |
| **X** | Private |
| **U** | Not sure |
| **S** | Skip |
| **F** | Show the file in Finder |
| **N** | Next unlabeled |
| ← → | Previous / next file |

Every key saves straight away, so you can stop and come back at any time.

## 3. Score

```bash
bun eval/calibration/score.ts
```

This runs Olympus's production classifier over your labeled files. The
built-in private model answers in its own local process, and the running
engine is not touched. Your privacy words and folder rules are read, never
written. It prints:

- **Private precision**: of the files Olympus made Private, how many you call
  Private.
- **Private recall**: of the files you call Private, how many Olympus made
  Private.
- **Misses**: every miss, listed by file name.

The full result is saved beside the labels. A file Olympus still holds for the
model counts as Private, because that is what you experience.

Targets: 95% precision and 99% recall. It takes about 2 to 3 seconds per file.
