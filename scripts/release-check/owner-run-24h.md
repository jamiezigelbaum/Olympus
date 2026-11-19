# The 24-hour run on the owner's install (1.5)

Owner decision, 18 Nov 2026: 1.5 ships when the full release check is clean in
the default configuration on Mac and Linux, both upgrade legs included, and the
candidate has then run 24 hours on the owner's install against the conditions
below. It replaces the 48 hours in the release plan entry of 11 Nov 2026
([docs/V0_4_RELEASE.md](../../docs/V0_4_RELEASE.md), Decisions).

## When it runs

- On the final candidate only, after that release check.
- It starts at the candidate's install, so the install's own start-up is the
  first thing measured, from a clean boot of the machine. Swap used (machine,
  front, background) is recorded at the start, 12 hours and the end. No swap
  setting is changed for the run: the product must hold by itself.
- For the 24 hours the machine does only what the owner's Olympus does: no
  test runs, stress runs or builds beside it, and the local model server serves
  that engine only.
- Results are posted at the start, at 12 hours and at the end; a failed gating
  line is posted at once.

## Ready (one definition, 19 Nov 2026)

Start-up ends, and the engine is READY, when both the front and the background
have logged that their hidden-copy sets are built after a start
(`[olympus] front: built N stores' hidden-copy sets in M ms` and the same line
for the background). Start-up runs from the front's first answer until ready.
Every line below says which side of that line it applies to.

## Gating: any one of these fails the run

1. Start-up (from the front's first answer until ready): the dashboard never
   goes unanswered for more than 10 s. A "starting" page counts as an answer.
   The outside probe of Home and Sources is scored by this line during
   start-up.
2. After ready: no front freeze over 1 s in the freeze log. The freeze log
   stays on for the run, and a front-thread sampler runs for the whole 24 hours
   so any freeze has its split (running, CPU wait, page-fault wait, IO wait).
3. After ready: from outside the engine, Home and Sources opened once a minute:
   every request answered, none over 1 s.
4. Background: no beat over 30 s, and capture, judging and embedding keep
   moving (their counts advance or their queues drain) in every hour. A new
   item is searchable within about 10 minutes.
5. No background restart caused by a memory burst. A restart on the memory
   floor is allowed, but it must not cause a front freeze over 1 s or an
   unanswered probe.
6. WAL: back at or under 64 MB within 60 s of any crossing; never over 1 GB.
7. Ask, after ready: a known-answer Ask at the start (once ready), at about 12
   hours and at the end shows evidence within 10 s and cites the expected item.
   The whole answer is reported against a target of about 20 s. An Ask accepted
   during start-up is not judged on time: it must say that Olympus is still
   starting, never be cancelled, and complete by itself; one such Ask is taken
   in the first two minutes and its time is reported. The answer does not
   stream in 1.5 (a card with the match count, then the whole answer with its
   sources); 5 s to evidence is 1.6 work. Question and answer text stay on the
   install; the post carries only pass or fail and the timings.
8. Nothing fails silently: health is never stale, every guard trip or hold is
   reported, and a source shows an error only for a true ingest failure with
   its reason.
9. Data at the end: no per-source item count is lower than at the start (the
   engine logs no deletions, so any drop fails until explained; the owner's own
   tier moves and rule changes are not losses), and the tier ledgers agree with
   the stores. The ledger check runs once, straight after the 24 hours end, on
   a backup-API copy, and counts as part of the run.

The owner uses the install during the run; that use is part of the load. Four
owner findings stop the clock like a failed gating line: the dashboard hangs
over 1 s in normal use or over 10 s while starting; anything Private or Secret
reaches ChatGPT or Claude, even a title; a click says saved and it was not;
data is missing. Other findings are recorded and do not stop the clock.

## Reported, not gating

- Front and background memory floor at the start, 12 hours and the end; the
  background's drift per hour; every restart with its cause.
- Dashboard load p95 against 300 ms, from the outside probe. Click
  acknowledgement has no log line; it is judged by the release check and by the
  owner's own clicks.
- Peak WAL, 1-minute load and memory pressure beside any freeze. Swap is a
  symptom to read, not a goal: Olympus's own processes' swap (front,
  background, helpers) beside machine swap, and the background's disk read
  volume per hour. The goal is that background work runs while the dashboard
  stays responsive and new items keep getting indexed.
- Any front freeze between 0.5 s and 1 s, with its timeline split.

## If it fails

The failure gets one owner, a case that makes the candidate fail the same way
off the install, and a fix. The 24 hours start again on the new candidate. A
failure caused by something else on the machine (a job that should not have
run) voids the run instead of failing it, and it starts again.

## How the release check matches this

The release check uses the same definition of ready. On the upgrade legs
`upgrade.cutover.startup` probes Home and Sources every 2 s from the new
front's first answer until both hidden-copy lines appear and fails on a gap
over 10 s; `qualify.dashboard` then fails on any probe over 1 s or unanswered
through the archive stage. `qualify.ask` warns when evidence takes over 10 s on
a ready engine and reports the whole answer against about 20 s;
`qualify.ask-startup` takes one Ask during start-up and fails only if it is
cancelled, lost or never says Olympus is still starting. Click acknowledgement
and "stays withheld across a restart" are proven there on test data
(`qualify.private`); the owner's clicks are the check on real items.
