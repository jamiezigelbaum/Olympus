# Contributing to Olympus

Development and release packaging use Bun. The CLI and worker service run
through the Bun shebang or an absolute Bun executable resolved by the managed
installation; repository scripts must not assume a version-pinned runtime path.

Olympus is in a friends-testing phase. You have read access: explore
everything, run it, break it, and tell us how it went.

## How to suggest changes

1. Fork the repository (your fork of a private repo stays private).
2. Branch, make your change, and open a pull request.
3. The maintainer reviews and merges. There is no direct push access —
   every change lands through a PR.

Bug reports and rough edges are as valuable as patches — open an issue
with what you saw, what you expected, and (if it's the install/onboarding
flow) what your agent said.

## Contribution terms

By submitting a pull request or other contribution, you agree that:

1. The contribution is your own work, or you have the right to submit it.
2. You grant the Olympus copyright holder a perpetual, worldwide, irrevocable,
   royalty-free license to use, reproduce, modify, distribute, sublicense,
   and relicense your contribution as part of Olympus or derivative works,
   under any terms.
3. Your own use of Olympus remains governed by the [MIT](LICENSE) license.

Plain-English version: contributions are welcomed and credited in the
history, and the project — including future licensing decisions — stays
wholly with its owner.
