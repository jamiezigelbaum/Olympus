# Fresh-install canary on test-omarchy

The mandatory `limits` release stage runs on the release-check driver's
throwaway machine, returned by `machine.ts`'s `provision` verb. The candidate
runner (`run.ts`) always runs it after a usable fresh install, and after an
upgrade on the candidate version. There is no opt-in or skip flag. The
fresh-install flow also calls it after its install checks, with a test seam.
An existing machine obtained through `machineFor`, including the older canary
invocation below, cannot supply this proof: the stage fails before issuing any
machine commands. Never run it on Sparta, an owner's machine or the frozen
reviewer demo. Provision, execute and destroy through the release-check driver.

The stage saves only its two nonsecret environment settings and the owner limit
settings in private `/tmp` scratch, preserving all other worker environment
entries without copying credentials. It sets `OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_DAY=1` in the
installed worker environment, seeds two synthetic records from `fixture.ts`
through the existing Telegram archive live-seed connector hook,
and restarts once before taking observations. It installs no account-wide
privacy rule and needs no real source account. The worker opens the seeded
stores at boot and judges their pending items with its configured privacy model.
Fresh identities and material prevent earlier fixture judgments satisfying this
proof. In the candidate runner this stage follows the other product journeys,
so its injected stops cannot change their screenshots or backup contents.
Daily usage counters are preserved, including usage before the stage.

`olympus limits` must report `judge.daily_calls` within 180 seconds, with a
nonempty label, unit `calls`, limit 1, used calls at least 1 and a valid
`resumesAt`. Home is read through the engine's own `/dashboard?panel-read`
JSON, using the fresh-dashboard owner socket and bearer pattern. Its wait
must match the stop's label, amounts, unit and resume time and expose a Raise
fix calling `olympus_limits`. One `olympus limits continue judge.daily_calls`
with `--to` set 50 above the larger of the limit and the calls already used
today (earlier stages keep the day's count) must return `ok:true`, clear both
views and allow the persisted daily call counter to increase within 180
seconds. Both engine and judge worker process ids must stay the
same across the continuation.

For `venice.credit`, the stage writes the same `kind: venice` marker shape as
`writeProviderPause`, at the configured pause file (or a temporary path
configured with `OLYMPUS_VENICE_CREDIT_STATUS_PROVIDER_PAUSE_FILE` before the
restart). It refuses to overwrite an existing marker. It then seeds fresh
synthetic items, so the stop has work to hold; seeding restarts the engine, so
the no-restart window starts once the engine is ready again. Within 90 seconds the
CLI must show the billing reason and Home must offer the matching Refill fix.
One `olympus limits continue venice.credit` uses the product's constant Venice
billing URL. With a credential, it must return `ok:true`, clear the stop from
both views, remove the marker and let the judge call counter increase within
180 seconds, all without a restart. Without a credential, it
must return `ok:false` with `has not confirmed canConsume=true`, leaving both
the stop and marker in place. That lift is explicitly **inconclusive**, with
the reason in its row and a skip check; it is never recorded as a pass.

All waits poll with the stage clock and a deadline. A failed assertion fails
the stage; the other leg can still produce its own evidence. Cleanup always
removes the injected marker and restores the saved environment and owner
settings, restarting only after the no-restart observation interval. The
driver destroys the machine through its normal teardown. Bundles and private
scratch live under `/tmp`; failed restoration keeps its receipt there for
diagnosis. The JSON `limits.rows` and `limits.checks` and HTML Limits table
contain only limit ids, counts, units, times and fixed outcome reasons; no
item text, titles, senders, marker paths or machine diagnostics are reported.

Run with the existing SSH driver config and report destination:

```sh
bun scripts/release-check/canary.ts \
  --config <driver.json> --machine test-omarchy --os linux --out <reports-dir> \
  --fresh-install --accounts <canary-accounts.json> \
  --candidate <olympus-version.tgz> --cdp 127.0.0.1:9334
```

Without `--candidate`, install the published release. A candidate is a tarball,
not the upgrade mode's bundle directory. The site's Linux bundle builder renders
the same checksum-pinned non-interactive installer for that tarball in the run's
report folder. Runtime downloads still use the site's pinned Bun release.
`--cdp` defaults to `127.0.0.1:9334`; loopback endpoints use the driver's tunnel,
other hosts must be reachable from the runner. The freshBrowser Brave profile must already be running
as zig with the single Google and Dropbox test accounts signed in. This mode
never launches a browser or types a password; it only accepts the provider's connect consent in an already signed-in account.

Add `fresh` to each existing `sources` entry for `gmail` and `dropbox`:

```json
{
  "sources": [
    {
      "id": "gmail", "label": "Gmail",
      "known": { "question": "What is the canary meeting venue?", "expect": ["Harbour Room"] },
      "fresh": {
        "scope": "Canary",
        "outside": { "question": "What is the excluded test invoice reference?", "expect": ["EXCLUDED-INVOICE-8391", "Excluded test invoice"] },
        "withinS": 900
      }
    },
    {
      "id": "dropbox", "label": "Dropbox",
      "known": { "question": "What is the canary project colour?", "expect": ["cerulean"] },
      "fresh": {
        "scope": "/Canary",
        "outside": { "question": "What is the excluded test project reference?", "expect": ["EXCLUDED-PROJECT-1492", "Excluded project.txt"] }
      }
    }
  ]
}
```

`known` keeps the live-accounts format. Its facts must occur in an answered MCP
response with a citation to that source, as well as in the existing search
check. Optional `plant` commands retain the existing live-accounts behavior.
Use harmless, individually Personal test fixtures so the remote MCP can answer
them; the harness does not create account-wide privacy rules.

`fresh.scope` is a Gmail label's exact displayed name or a Dropbox folder path.
The existing Gmail picker is an exclusion interface: the harness leaves that
label checked and unchecks the other listed labels, preserving the default time
window and category choices. This does not impose label-only inclusion on
unlabelled mail. Put the Gmail outside fixture under a different listed label,
and its known fixture under the retained label, within the time/category scope.
Dropbox selects Full on just the named folder; parent path components are opened
through the picker. The harness follows folder pagination when necessary.

`fresh.outside.question` queries an existing item outside the chosen scope.
`expect` must contain distinctive content and title markers for that item. None
may occur in the returned answer, citations, or search evidence. Failed or
unreadable calls fail the check. `withinS` bounds first indexing (default 900).
All fields in `fresh` are optional for other canary modes, required here except
`withinS`. No credentials belong in this file.

The report uses the existing canary v1 JSON/HTML layout under `<out>/<run-id>`,
with leg `canary-test-omarchy-fresh`. Checks name install, engine, dashboard,
the first-run privacy choice (Local models with Venice fallback, Recommended),
each source's connect/consent/callback/scope/first items, known answers and scope
absence, and restoration. Exit codes remain 0 pass, 1 product failure, 2 invalid
invocation, 3 inconclusive. Password, verification, signed-out and ambiguous
account pages identify which browser sign-in to renew. No consent screenshots,
OAuth URLs, ordinary account answers, cookies or tokens are included in the fresh report.

The dedicated `olyfresh` account gets linger and a clean home each run. Zig's
engine is stopped before installation. Engine readiness uses olyfresh's worker
socket, since this user has no graphical session. The harness bundles its current
machine-agent and runs that agent's existing owner-socket forward as olyfresh on
loopback port 8010 for zig's browser; the CDP tunnel carries browser control only.
The forward lives until the dashboard closes; the restore guard also stops it
if the runner disappears. An already-listening desktop bridge is reused.
Google's desktop OAuth redirect is `http://127.0.0.1:8010/oauth/callback/gmail`.
Dropbox registers the HTTPS publisher relay, which bounces the browser back to
the dashboard origin on 8010. Both reach olyfresh through the same forward.
Before connecting sources, the harness answers the Keys page's first-run form
with its Recommended choice, then reloads and verifies the persisted mode.
The machine-side lease guard traps exit and termination and restores zig when
the runner releases the lease, or after two hours if the runner disappears.
Handled runner interrupts finish the active mutation before cleanup. Restoration
stops olyfresh, starts zig and verifies both the user service and worker socket,
even if zig's desktop TCP bridge is down.
The fresh install and its private install log remain for post-mortem. Provider
grants are retained. A failed restore leaves
`~zig/.olympus-canary/fresh-run/guard.log` and blocks another run until inspected;
never remove an active run's lease directory to start a competing canary.

Add `--on-demand-timing` to run read-on-demand timing after the fresh Gmail and
Dropbox checks succeed. This mode uses `freshBrowser` (Brave on test-omarchy,
CDP `127.0.0.1:9334`, the fresh leg's default) signed in to
`jamiez.olympus@gmail.com` on Google and Dropbox. No provider write tokens or
`on_demand_timing` account section are required. If token commands are supplied,
the existing API seeder is used instead; both commands and pinned account IDs
are required together.

The stage turns on `worker.engineSplit` in the config path reported by
`olympus engine status`, preserves the other settings, and runs
`olympus engine restart`. It waits for healthy front/background services and
records that proof and the installed build in `onDemandTiming.preflight` in
JSON and HTML. The existing fresh MCP connection survives this restart.

Drive connects through its dashboard Connect/consent/callback flow, using the
same signed-in Google account as Gmail. A Drive connection already established
by Google consent is reused. If the candidate has no Drive web connect control,
the four Drive cases are listed under `onDemandTiming.notRun` and in HTML with
`product has no web connect for Drive`; they have no timing rows and no passing
read checks. Unreadable dashboard state or a failed connection is a failure,
not evidence that Drive lacks web connect.

The browser creates or reuses `/Olympus RC on demand` on Dropbox and a Google
Drive folder with the same name. PDFs upload through each provider's web file
chooser; the native Google Doc is created in that folder with Google Docs and
its text is typed into the editor. Existing fixture names are skipped without
rewriting them. Their made-up facts are fixed by a versioned seed, so this mode
needs the fresh leg's empty store on every run. Do not edit those fixtures in
place: an old or altered fixture fails the expected-fact check. No account-wide
privacy rule is installed.

The seed folders are added through the dashboard as **Names with read on
demand**, preserving the other scope selections. Before each timed read, the
stage waits for the file's name in Your items and requires its Read this file
control to be available. The probe resolves its actual provider identity and
source version from names-only metadata; it does not read its body. The shared
accounts-stage timing table, 30-second bound, wait-wording checks and four step
timings are used unchanged. The additional Dropbox owner case temporarily uses
Names only and presses Read this file.

The normal fresh-leg cleanup restores zig even if setup or timing fails.
Seeded provider files remain in the test accounts for reuse. Browser upload
scratch, probe bundles and their local counterparts use `/tmp` and are removed
when the stage closes. The fresh install's existing diagnostic files remain as
before. Timing replies and logs contain the synthetic fixtures and are included
in the report; ordinary fresh account answers and OAuth pages remain excluded.
