# Paragraph-pick test bed, deep-read sample

Scratch branch, not for merging. Public data only: 15 papers and questions from
QASPER (Dasigi et al., 2021, CC BY 4.0), as an Olympus fixture data root.

- `root15.tar.gz` unpacks to `root15/`, a data root for `--data-root`.
- `deep-read-missed-15.json` is the deep-read dataset over it.

    bun run eval:deep-read -- --data-root root15 deep-read-missed-15.json --no-baseline --judge-answers --output deep-read.bed15.json
