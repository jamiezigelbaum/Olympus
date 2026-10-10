# Consult gate PII detector bake-off

Evaluation only. It changes nothing in the gate. Results and the recommendation are in
[docs/design/consult-pii-bakeoff.md](../../docs/design/consult-pii-bakeoff.md).

It runs open PII/NER models over every synthetic consult question the gate evals already use. Then it scores
them three ways:

- alone, for detection recall and false flags;
- inside the combined policy: the gate as shipped, plus a model that may rescue a question the unnamed level
  refused only for `unknown_word` or `snapshot_name`;
- for speed and size on Apple silicon.

It uses only the synthetic eval data in this repository.

## Files

- `export.ts` (Bun) writes `out/items.jsonl` and `out/cases.jsonl`.
  - **Items:** each distinct question, with its truth (carries a hard identifier, or not).
  - **Cases:** each gate request at the unnamed level. Each row holds:
    - the gate's reasons;
    - the reasons a second pass finds once the unknown words are admitted (the gate stops at the vocabulary rule
      before it reads the snapshot);
    - the unknown or capitalised tokens a model must clear.
- `probes.ts` holds the hand-written multilingual hard-identifier probes: EN, PT, ES, FR and DE, eight identifier
  kinds each.
- `run_models.py` (Python) runs one candidate over `out/items.jsonl` on the CPU. The candidates are listed in
  `CANDIDATES`. The `gliner-multi-pii-onnx-*` candidates export the model to ONNX once, into `out/onnx/`. It writes:
  - `out/pred-<candidate>.jsonl`: spans mapped to one category set;
  - `out/perf-<candidate>.json`: load time, p50/p95 per question, RSS, download size.
- `score.ts` (Bun) prints the tables in the design doc and writes `out/results.json`.

`out/` is git-ignored.

## Rerun

Latency has to be measured on the Mac that would run the model, so the model runs are local by design. Prefix
them with `REMOTE_BUILD_LOCAL_REASON=mac-latency-bakeoff`. The Bun steps are quick and can run anywhere.

```sh
# 1. Python environment, outside the repo (about 15 GB with every candidate's weights)
B=/Users/zig/Code/Claude/pii-bakeoff
UV_PYTHON_INSTALL_DIR=$B/python UV_CACHE_DIR=$B/uv-cache uv venv --python 3.12 $B/venv
UV_CACHE_DIR=$B/uv-cache uv pip install --python $B/venv/bin/python \
  torch transformers gliner gliner2 peft presidio-analyzer spacy psutil huggingface_hub \
  onnxruntime "onnx==1.18.0" ml_dtypes \
  "en_core_web_lg @ https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl" \
  "sporelabs-scrub @ https://huggingface.co/SporeLabs/scrub/resolve/main/package/sporelabs_scrub-0.1.1-py3-none-any.whl"

# 2. Export the questions and gate verdicts
bun eval/consult-pii/export.ts

# 3. Run the candidates, one process each (weights download into $HF_HOME on first use)
export HF_HOME=$B/hf XDG_CACHE_HOME=$B/cache
$B/venv/bin/python eval/consult-pii/run_models.py --all
#   or: --candidate openai-privacy-filter --candidate pii-tracer ...

# 4. Score
bun eval/consult-pii/score.ts
```

`pii-tracer` loads with `trust_remote_code=True`, which runs Perplexity's `modeling_pii_masking.py` from the Hub.
It was read before the first run on 2026-10-08 at revision `d25c16f2`; it imports only torch and transformers. Read
it again before running a newer revision.

## Notes

- **Hard identifiers** (the owner's ruling for the unnamed level) are: person, organisation, place finer than a
  country, street address, date, money amount, account or ID number, email, phone, URL, handle and secret.
  - A span made only of country names (the gate's `cldr-countries` pack) is not one.
  - Each model's labels map onto these categories in `run_models.py` (`category`).
- **Truth** comes from the evals' own labels. Unnamed leak variants and probes carry a kind. Leak-corpus cases in the
  `identifier`, `exact_figure`, `exact_date` and `multilingual` categories count as hard when the independent canary
  oracle (`eval/consult-leak/run.ts`) finds a planted string. Every legitimate set counts as no hard identifier.
- **German** has no shipped vocabulary pack, so the gate refuses every German question for `vocabulary_unavailable`.
  The policy tables leave German out. The detection tables still report it.
