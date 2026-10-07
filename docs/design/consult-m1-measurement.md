# Consult M1: live zkAPI route timing

Date: 2026-10-07. Stage M1 of `frontier-consult-lane.md`: ten real consults through today's transport, one at a time, owner-funded. Measured with `scripts/zkapi-consult-timing.ts`. Raw numbers: `consult-m1-results/run-1.json` (run 1) and `consult-m1-results/runs-2-10.json` (runs 2 to 10, numbered 1 to 9 inside the file). They hold timings, labels, the questions and the model id only; the ten questions are short, generic and content-free.

## Setup

- Apple M3, 24 GB, macOS 26. Quiet machine, no other load deliberately applied.
- zkapi-clientd 0.1.6, Tor 0.4.9.13 (Homebrew), model `openai/gpt-5-mini`.
- Settings: Tor per consult on port 19050, sandbox self-test on. Confinement level for every run: `non_loopback_blocked`. Route label for every run: "payment privacy; a fresh Tor client was started and the daemon reports SOCKS5 mode, but the actual route is not verified". Network identity: not verified.
- **Setup requirement found.** The first attempt was refused with `key_reuse_on`: the daemon's default 60 s key-reuse window is linkable, so Olympus will not send. Run `zkapi-clientd config --key-reuse-window-seconds 0` before any consult.

## Result

All ten consults succeeded, fence clear after each, $6 reserved each, $60 worst-case reservation in total. Times are seconds.

| Run | Elapsed (reported) | Total | Self-test | Tor | Daemon ready | Verify | Policy warm | Reserve | Dispatch to first byte | Settlement | Tor stop | Teardown |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 28.7 | 71.9 | 3.2 | 9.6 | 0.3 | 0.2 | 10.5 | 0.1 | 28.7 | 19.1 | 0.1 | 0.1 |
| 2 | 28.3 | 70.0 | 3.1 | 7.5 | 0.3 | 0.2 | 8.4 | 0.1 | 28.3 | 21.9 | 0.1 | 0.1 |
| 3 | 31.0 | 95.8 | 3.1 | 28.6 | 0.3 | 0.2 | 11.0 | 0.1 | 31.0 | 21.3 | 0.1 | 0.1 |
| 4 | 29.1 | 72.7 | 3.1 | 11.9 | 0.3 | 0.2 | 8.1 | 0.1 | 29.1 | 19.7 | 0.1 | 0.1 |
| 5 | 34.0 | 178.5 | 3.2 | 103.6 | 0.3 | 0.2 | 14.8 | 0.1 | 34.0 | 22.0 | 0.1 | 0.1 |
| 6 | 32.5 | 75.2 | 3.1 | 9.0 | 0.3 | 0.2 | 9.0 | 0.1 | 32.5 | 20.7 | 0.1 | 0.1 |
| 7 | 48.4 | 156.1 | 3.1 | 9.8 | 0.3 | 0.2 | 66.2 | 0.1 | 48.4 | 27.8 | 0.1 | 0.1 |
| 8 | 28.1 | 104.7 | 3.2 | 32.8 | 0.3 | 0.2 | 12.5 | 0.1 | 28.1 | 27.4 | 0.1 | 0.1 |
| 9 | 51.9 | 172.5 | 3.1 | 60.0 | 0.3 | 0.3 | 11.6 | 0.1 | 51.9 | 40.2 | 1.4 | 0.4 |
| 10 | 40.2 | 97.9 | 4.9 | 16.1 | 0.8 | 1.1 | 10.7 | 0.2 | 40.2 | 22.9 | 0.4 | 0.2 |

"Elapsed" is the `elapsedMs` the transport reports, which tracks the request round trip (it matches dispatch to first byte). "Total" is the whole session through teardown. Lease, first byte to completion, correlation wait and the post-stop probe are each 0 to 0.1 s apart from one 0.1 s correlation wait and are left out of the table; they are in the JSON.

Per-stage, all ten runs (recomputed from the JSON; p95 is nearest-rank, which with ten runs is the maximum):

| Stage | Median ms | p95 ms | Min ms | Max ms |
|---|---|---|---|---|
| lease acquire | 0 | 10 | 0 | 10 |
| confinement self-test | 3,109 | 4,911 | 3,089 | 4,911 |
| Tor start to bootstrapped | 14,025 | 103,615 | 7,476 | 103,615 |
| daemon start to ready | 257 | 766 | 254 | 766 |
| daemon verification | 177 | 1,111 | 159 | 1,111 |
| models/policy warm | 10,832 | 66,244 | 8,075 | 66,244 |
| reservation | 95 | 248 | 80 | 248 |
| dispatch to first byte | 31,715 | 51,902 | 28,056 | 51,902 |
| first byte to completion | 1 | 2 | 0 | 2 |
| request correlation wait | 0 | 102 | 0 | 102 |
| settlement wait | 21,967 | 40,203 | 19,105 | 40,203 |
| Tor stop | 103 | 1,377 | 101 | 1,377 |
| post-stop probe | 1 | 23 | 1 | 23 |
| teardown | 104 | 447 | 102 | 447 |
| total | 96,827 | 178,526 | 70,048 | 178,526 |

Time to reply versus after the reply (the reply is in hand once first byte to completion ends; everything after is correlation, settlement, Tor stop, probe and teardown):

| | Median | Max |
|---|---|---|
| Until the reply is in hand | 74.2 s | 156.2 s |
| After the reply (settlement and teardown) | 22.2 s | 42.0 s |
| Whole session | 96.8 s | 178.5 s |

Against the design's reference of 3 to 4.5 minutes, the median whole session is about 1.6 minutes and the worst was about 3.0 minutes. Time to reply is about 1.2 minutes at the median.

## What this means

1. **Hand the reply off before settlement.** Settlement wait plus teardown is about 22 s at the median (up to 42 s). Nothing the reader needs depends on it, so releasing the reply at completion removes it from the wait.
2. **Overlap the start-up with the writer.** Self-test, Tor, daemon ready, verification and policy warm come to about 28 s at the median before anything can be sent. They do not depend on the question, so running them while the writer drafts hides roughly that much, and more on slow runs.
3. **Tor bootstrap is the big variance.** Median 14 s, but 8 to 104 s across runs (three of ten over 28 s). A seeded directory cache is worth measuring; this run did not test one.
4. **Policy warm is the daemon's own behaviour.** Median 10.8 s, one run at 66 s. It is the daemon polling its model list until the policy loads; Olympus waits and cannot shorten it. Worth raising upstream rather than working around here.

Dispatch to first byte (median 31.7 s) is the outside model's answer arriving over Tor; the reply body then arrives at once. It is the largest single stage and is not ours to reduce, other than by choice of model.

## What this run did not measure

- Writer time (drafting the question), and the panel or approval path before a send.
- A loaded machine versus a quiet one; all runs were on one machine in one session.
- Any change from the C2 design (overlapped warm-up, early hand-off): this is the baseline for those.
- Longer or content-bearing questions: the questions were short, so generation time on real consults will differ.
