# The 24-hour run on the owner's install (1.5)

Owner decision, 18 Nov 2026: 1.5 ships when the full release check is clean in
the default configuration on Mac and Linux, both upgrade legs included, and the
candidate has then run 24 hours on the owner's install against the conditions
below. It replaces the 48 hours in the release plan entry of 11 Nov 2026
([docs/V0_4_RELEASE.md](../../docs/V0_4_RELEASE.md), Decisions).

## When it runs

- On the final candidate only, after that release check.
- It starts at the candidate's install, so the install's own start-up is the
  first thing measured.
- For the 24 hours the machine does only what the owner's Olympus does: no
  test runs, stress runs or builds beside it, and the local model server serves
  that engine only.
- Results are posted at the start, at 12 hours and at the end; a failed gating
  line is posted at once.

## Gating: any one of these fails the run

1. Start-up: once the front has answered for the first time, the dashboard
   never goes unanswered for more than 10 s. A "starting" page counts as an
   answer.
2. Steady running (after start-up): no front freeze over 1 s in the freeze log.
3. From outside the engine, Home and Sources opened once a minute for the
   whole run: every request answered, none over 1 s.
4. Background: no beat over 30 s, and capture, judging and embedding keep
   moving (their counts advance or their queues drain) in every hour.
5. No background restart caused by a memory burst. A restart on the memory
   floor is allowed, but it must not cause a front freeze over 1 s or an
   unanswered probe.
6. WAL: back at or under 64 MB within 60 s of any crossing; never over 1 GB.
7. A known-answer Ask at the start, at about 12 hours and at the end: evidence
   within 5 s, then streaming, and it cites the expected item. Question and
   answer text stay on the install; the post carries only pass or fail and the
   timings.
8. Nothing fails silently: health is never stale, every guard trip or hold is
   reported, and a source shows an error only for a true ingest failure with
   its reason.
9. Data at the end: item counts are not lower than at the start except for
   deletions the engine itself logged (and the owner's own tier moves and rule
   changes), and the tier ledgers agree with the stores.

The owner uses the install during the run; that use is part of the load. Four
owner findings stop the clock like a failed gating line: the dashboard hangs
over 1 s in normal use or over 10 s while starting; anything Private or Secret
reaches ChatGPT or Claude, even a title; a click says saved and it was not;
data is missing. Other findings are recorded and do not stop the clock.

## Reported, not gating

- Front and background memory floor at the start, 12 hours and the end; the
  background's drift per hour; every restart with its cause.
- Dashboard load p95 and click acknowledgement p95 against 300 ms and 100 ms.
- Peak WAL, peak swap, 1-minute load and memory pressure beside any freeze.
- Any front freeze between 0.5 s and 1 s, with its timeline split.

## If it fails

The failure gets one owner, a case that makes the candidate fail the same way
off the install, and a fix. The 24 hours start again on the new candidate. A
failure caused by something else on the machine (a job that should not have
run) voids the run instead of failing it, and it starts again.

Click acknowledgement and "stays withheld across a restart" are proven in the
release check on test data; the owner's clicks are the check on real items.
