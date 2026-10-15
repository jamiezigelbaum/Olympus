# Contributing to Olympus

Development and release packaging use Bun. The CLI and worker service run
through the Bun shebang or an absolute Bun executable resolved by the managed
installation; repository scripts must not assume a version-pinned runtime path.

Olympus is open source under the [MIT License](LICENSE) and is published by
Open Coordination Unlimited, Inc. Explore everything, run it, break it, and
tell us how it went.

## How to suggest changes

1. Fork the repository.
2. Branch, make your change, sign off each commit (`git commit -s`), and open
   a pull request.
3. The maintainer reviews and merges. There is no direct push access —
   every change lands through a PR.

Adding a new source connector? Start with
[docs/CREATE_CONNECTOR.md](docs/CREATE_CONNECTOR.md): it walks the frozen
contracts, corpus definition, store mount, scheduler tasks, request budget, and
tests, with copyable templates in `docs/connector-templates/`.

Bug reports and rough edges are as valuable as patches — open an issue
with what you saw, what you expected, and (if it's the install/onboarding
flow) what your agent said.

## Maintainer notes

- **Private history stays private.** The public repository is a fresh root: the
  pre-publication history holds personal data and lives only in the private
  `olympus-archived` repository. Never push `archive/*` tags, `--mirror`,
  `--all` or any old-history branch to this repository, and never make
  `olympus-archived` public. The details are in the
  [public flip runbook](docs/ops/PUBLIC_FLIP_RUNBOOK.md).
- **Keep the plugin bundle tree-shakeable.** `dist/` is committed. In modules
  reachable from `src/native-plugin.ts`, a class-field initializer
  (`private x = new Map()`) counts as a side effect for bun's bundler, so it
  pulls the whole module graph (including `bun:sqlite` stores) into
  `dist/index.js`. Declare the field optional and initialize it lazily
  (`(this.x ??= new Map())`). After a rebuild, an unexplained jump of thousands
  of lines in the `dist/index.js` diff means tree-shaking broke; confirm by
  rebuilding with the suspect file reverted.
  `test/plugin-bundle-no-bun-sqlite.test.ts` catches only the `bun:sqlite` case.

## Contribution terms

By submitting a pull request or other contribution, you agree that:

1. You have the right to submit it, as certified by the
   [Developer Certificate of Origin 1.1](https://developercertificate.org/).
   The `Signed-off-by` line that `git commit -s` adds is that certification.
2. You license the contribution under the [MIT License](LICENSE), like the
   rest of Olympus.
3. You also grant Open Coordination Unlimited, Inc., which publishes Olympus,
   a perpetual, worldwide, irrevocable, royalty-free license to use,
   reproduce, modify, distribute, sublicense, and relicense your contribution
   as part of Olympus or derivative works, under any terms.
4. You provide the contribution as is, without warranty of any kind.

Plain-English version: contributions are welcome and credited in the history,
everyone can use them under MIT, and the publisher can make future licensing
decisions for the project as a whole.
