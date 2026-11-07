# Fresh-install canary on test-omarchy

Run with the existing SSH driver config and report destination:

```sh
bun scripts/release-check/canary.ts \
  --config <driver.json> --machine test-omarchy --os linux --out <reports-dir> \
  --fresh-install --accounts <canary-accounts.json> \
  --candidate <olympus-version.tgz> --cdp 127.0.0.1:9333
```

Without `--candidate`, install the published release. A candidate is a tarball,
not the upgrade mode's bundle directory. The site's Linux bundle builder renders
the same checksum-pinned non-interactive installer for that tarball in the run's
report folder. Runtime downloads still use the site's pinned Bun release.
`--cdp` defaults to `127.0.0.1:9333`; loopback endpoints use the driver's tunnel,
other hosts must be reachable from the runner. Chromium must already be running
as zig with the single Google and Dropbox test accounts signed in. This mode
never launches a browser, types a password, or changes a provider's grant.

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
OAuth URLs, answers, cookies or tokens are included in the fresh report.

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
