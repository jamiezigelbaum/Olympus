# Read-on-demand timing on the accounts machines

Add `--on-demand-timing` to `canary.ts` on the `accounts-test-omarchy` or
`accounts-test-mac` leg. Use the normal exact-main candidate and harness SHA
receipts. The stage checks the running engine's `worker.engineSplit` setting
and healthy front/background services before it changes either test account.
It records the installed build in `onDemandTiming.preflight`.

For example, with the main build already installed:

```sh
bun scripts/release-check/canary.ts \
  --config /tmp/rc-driver.json --machine test-omarchy --os linux \
  --accounts /tmp/rc-accounts.json --accounts-only --on-demand-timing \
  --cdp 127.0.0.1:9333 --out /tmp/rc-results \
  --sha <main-sha> --harness-commit <main-sha>
```

For the Mac, use `--machine test-mac --os macos`. CDP reaches the canary's
Chromium on the test machine, using the driver's tunnel for loopback addresses.
The browser must already be running with remote debugging enabled. No provider
sign-in is automated by this stage; the accounts must already be connected to
Olympus. `run.ts` rejects this flag because its throwaway machines have no real
accounts.

Add this section to the existing private accounts JSON:

```json
{
  "on_demand_timing": {
    "dropbox": {
      "tokenCommand": ["<test-token-helper>", "dropbox"],
      "accountId": "<demo Dropbox account_id>"
    },
    "drive": {
      "tokenCommand": ["<test-token-helper>", "drive"],
      "accountId": "<test Gmail email address>"
    }
  }
}
```

Commands execute on the harness computer and print a short-lived access token.
They use the approved test accounts' existing credential tooling. Tokens remain
in memory and never go in the report, argv, fixture metadata or engine config.
Dropbox needs account identity plus file read/write access; Google needs account
identity and Drive read/write access to these test files. Both identities are
checked against the provider before creating or updating anything. API errors
report the route and HTTP status without echoing provider bodies.

The stage reuses `/Olympus RC on demand` and stable file IDs, overwriting only
its named RC fixtures through Dropbox and Drive APIs. Every run writes new
made-up body facts and new revisions. Each account gets a text PDF, a 200-page
PDF with its single fact in a paragraph on page 100, and an image-only PDF with
no text layer. Drive also gets a native Google Doc, imported and updated through
[Drive's upload conversion](https://developers.google.com/workspace/drive/api/guides/manage-uploads#import_to_google_docs_types).
An additional Dropbox PDF exercises the owner's Read this file button with its
folder temporarily in Names only mode.

Folder changes and Sync now use the actual dashboard. The exact previous
explicit folder choice, including no explicit choice (inheritance), is restored
in `finally`, including after failed saves or uploads. Other folder choices and
whole-account selection remain as they were. Fixtures stay in the accounts for
the next run. Local bundles and machine-side bridge/probe scratch use `/tmp`.

Each question uses the canary's connection to the engine MCP endpoint and calls
`source_answer`, which exercises the Analyst and its automatic read requests.
If an answer returns a working job, subsequent polls collect it using
`source_answer_result`; once a reply completes without the fact, the next poll
asks the question again. Poll slots are ten seconds from t0, with no overlapping
asks and a 180-second total request budget. A slow initial answer counts in full.
For the owner row, t0 is immediately before pressing Read this file, and the
button's response is preserved before asking for the answer.

`report.json` retains every observed reply and the filtered engine timing lines.
`report.html` adds a table with file discovery, indexed job state, a fact in the
answer with this file cited, elapsed seconds, asks, the first reply's file/read
flags, actual wait wording, and fetch/extract/judge/embed milliseconds.
`ondemand.<file>.slow` fails above 30 seconds or without an answer;
`ondemand.<file>.silent` fails if any reply neither states the fact nor says a
file is being read. A generic working message does not pass the reading check.
File, read-job, paragraph and timing-proof checks also report missing evidence.

Engine step lines currently carry no file IDs. The probe brackets sequential
reads with log byte offsets and a read-queue cursor, matching the item's exact
provider ID and new source version. Only an interval with one new read, no
already-running reads and no multi-item timing batch is attributed to that file.
Concurrent reads, reads started by an earlier question, missing steps and rotated
logs are explicit failed timing proofs; they are never silently assigned or
reported as zero milliseconds. Questions still run if an earlier question has
already read their file. The read column reports that version's indexed job,
while the timing proof exposes its reuse.

Local proof without a machine:

```sh
bun run test:focus -- test/release-check-on-demand-timing.test.ts
bun run typecheck
```
