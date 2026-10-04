# Categorization precision: Private only when it is private

Status: approved by the owner 2026-10-04 (Personal-first, the targets, and labeling); step 1 in progress (`eval/calibration/`).
Scope: the per-item tier classifier, the private model (sniffer), the move
machinery and the dashboard. Source-agnostic throughout.

## The goal

Olympus is only useful if ChatGPT can read most of the owner's life.
Something marked Private is invisible to ChatGPT, so every false Private is a
small outage. A false Personal sends private material to the cloud. Both
errors matter, but they cost different amounts:

- **Private precision**: of the items marked Private, the share that really
  are private. This is the number that has been too low in practice.
- **Private recall**: of the items that really are private, the share marked
  Private. This must stay near 100%.

The test for "really private" is already the sniffer's rule, and it stays:
**is this a real person's own information?** Their records and results, their
statements and bills, their legal papers, filled-in forms, therapy notes,
identity documents, intimate or family matters. A topic never decides it. A
book about gut health, a diet program's rules, an Integral Theory paper and a
course on money are all Personal.

## What actually went wrong (live data, 2026-10-04)

Of 782 Dropbox items, 37 have had their text read: 28 are Private and 9
Personal.

- All 28 Private items are the owner's own records: 25 lab, sleep-study and
  blood-work results in `/2 Areas/Health/Labs`, plus three health plans that look
  personal. All 7 diet and Ayurveda references the model judged went to Personal
  (category `reference`, confidence 0.95).
- The model's answers were right in every case checked. Every file wrongly
  held as Private got there through the **mechanics around** the model:
  1. **Hold-first.** Every item whose text is read is held Private until the
     model answers (classifier p3). A hold is effectively Private, and it is
     invisible.
  2. **Noisy borderline flags.** Topic vocabulary (`personal_life`, `health`)
     flags ordinary non-fiction. The Integral Theory paper was flagged
     `personal_life`.
  3. **Re-judges that hid items.** A classifier update re-judged that paper
     and hid it again while it waited (fixed in 92bbe7c5: re-judges now keep
     items visible).
  4. **Holds that never ended.** A move that never completed (fixed by the
     tier-move recovery work), then a question lost from the queue (fixed in
     #136). The paper was invisible from Oct 1 to Oct 4.

So the fix is mostly to stop holding, not to retrain the model, plus a way to
measure that this stays true.

## Plan

### 1. Measure first (prerequisite for everything else)

- **Owner-labeled set from the real corpus.** About 150 items sampled across
  folders: records folders, resources and books, work, and notes. The owner
  marks each one Personal or Private in the dashboard (one tap). The labels
  stay on the Mac. Every later owner override is added to the set too.
- **`olympus tier eval`.** Runs the classifier and the model on the labeled
  set and prints Private precision and recall, plus a list of the mistakes.
  It runs offline from stored text, with no source calls.
- **Live health numbers** in the dashboard's Details:
  - share of items Private, by folder;
  - items held right now, and the oldest hold;
  - questions waiting.
- **Targets** (owner to confirm):
  - Private precision of at least 95%;
  - Private recall of at least 99%;
  - median hold under 10 minutes;
  - no hold older than 1 hour that hasn't been asked again.

Done when the eval runs on the real labeled set and the dashboard shows the
hold numbers.

### 2. Hold only items that look like someone's own record

Today every read item is held until the model answers. Instead:

- **Own-record signals** decide whether an item waits. All of them are
  deterministic and source-neutral:
  - measured values with reference ranges or units;
  - a named patient, account holder or applicant;
  - filled-in form fields;
  - a structured identifier (these already raise to Private at once);
  - a records-folder path (labs, medical, taxes, statements, legal);
  - a dated title for a test, visit or statement.
- **No signal:** the item is placed Personal at once, and the model still
  checks it in the background. A Private answer raises it and hides it first.
- **Signal present:** held as today, but asked first in the queue.
- **Topic vocabulary alone** (`health`, `personal_life`, `finance` words) no
  longer flags anything. It only steers which passage the model reads.

Risk: a real private record with none of these signals would be Personal
until the model answers, usually minutes. The eval in step 1 measures exactly
this before it ships, and the signals list grows from the misses.
**This is the one owner decision in the plan** (see below).

### 3. Make the model's uncertain answers better, not just Private

- **Re-ask low-confidence answers.** A Private answer below 0.7 confidence is
  asked again with a longer excerpt, using the larger local model (Qwen3.5 9B)
  if it is installed. If it is still uncertain, the item becomes Private and
  goes into the owner's review list (step 4), not a silent Private.
- **Learn from the owner.** A few labeled examples from step 1 go into the
  prompt as few-shot cases, alongside the owner's own privacy words. A prompt
  change is a new prompt version, so affected items are re-judged without
  being hidden.
- **Folder priors.** When the owner marks several items in one folder the same
  way, the dashboard suggests a folder rule ("Treat /3 Resources as
  Personal?"). Folder rules already exist; this only proposes them.

### 4. One-tap owner corrections

- A dashboard list **"Marked Private"**, grouped by folder, with
  **"Fine to share"** on each item and each folder. A tap is an override (it
  moves the item right away), a label for the eval, and evidence for a folder
  rule.
- A short **"Not sure"** list from step 3, so uncertainty is visible and
  small.

### 5. Keep the pipeline honest

Already shipped:

- stuck-move recovery;
- re-judges that never hide;
- recovery of a lost question (#136).

Still to do:

- An alert line in the engine log and the dashboard when a hold is older than
  1 hour.
- Drop stale reasons when a newer verdict is recorded. Rows currently keep
  verdicts from older prompts, which confuses diagnosis.
- **Search on run-together file names**, e.g. `AltitudesofCommunityDevelopment`:
  - Splitting CamelCase into separate words in the keyword index helps most
    such names, and does not touch embeddings.
  - It cannot split lowercase runs like "of" in that example without a word
    list. The file's text matches either way.
  - Low priority.

## Order and proof

1. Step 1: labeled set and eval, plus the dashboard numbers. This gives the
   baseline.
2. Step 2: behind the eval. Ship only if precision rises and recall stays at
   or above 99% on the labeled set.
3. Steps 3 and 4, then the step 5 remainders.

Each step lands as its own PR into `claude/chatgpt-plugin`, with its eval
numbers in the description.

## Owner decisions needed

1. **Personal-first for items without own-record signals (step 2)?** The
   alternative is to keep holding everything until the model answers, and
   only make holds faster and rarer.
2. **The targets in step 1:** 95% precision, 99% recall, a 10-minute median
   hold.
3. **About 20 minutes to label the sampled set** once the dashboard list
   exists.
