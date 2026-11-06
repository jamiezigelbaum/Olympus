# Embedding first-pass test

Can a small classifier on stored EmbeddingGemma vectors clear items to Personal before the privacy judge? Results and rules are in issue #939.

These scripts hold no data. They read vectors and verdicts read-only from a machine's own stores, and read hand labels from the calibration folder. Everything stays on your machines. Never print item text from them.

1. `extract.py`: pull vectors and the judge's verdicts from the stores, read-only. Set `OLYMPUS_CALIBRATION_JUDGE_MODEL` to the judge's model id.
2. `embed_labels.py`: embed the hand-labelled items locally with the same model.
3. `probes.py`: embed the topic probe phrases.
4. `train.py`: train on judge verdicts only, excluding anything that matches a labelled item.
5. `score.py`, `analyze.py`, `analyze2.py`, `analyze3.py`: score against hand labels only. Judge verdicts are never the answer key.

`embed_lib.py`, `load.py` and `hj.py` are shared helpers.
