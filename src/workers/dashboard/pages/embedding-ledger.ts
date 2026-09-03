/**
 * The embedding decision ledger, as a page.
 *
 * WHY THIS PAGE EXISTS. On 2026-08-20 an endpoint retarget changed the
 * embedding config hash, the config hash drove an invalidation, and roughly a
 * quarter of a million stored vectors were deleted across five connector
 * stores. Nobody had approved it. Days later nobody could answer the four
 * questions that matter after an event like that — what was done, on what
 * model, why, and who agreed to it — because nothing anywhere wrote them
 * down. The owner's ruling is that every embedding-affecting event is recorded
 * append-only, and that any future embedding change or re-embed needs his
 * approval in advance.
 *
 * So this page is a record, not a dashboard. It has no controls, no denominator
 * and no live state: those belong to the Background page, which reads the
 * drain's and the guard's own files. Everything here is a past event with a
 * timestamp, and the page's whole job is to be readable months later by someone
 * who was not in the room.
 *
 * WHAT IT WILL NOT DO. It never infers an approval. An entry whose approval is
 * `unattributed-historical` renders as "no approval on record" and never as
 * "approved" — the 2026-08-20 wipe is exactly the event that would be
 * laundered by a friendlier default, and it is the reason the ledger exists.
 * Endpoints are printed in full: they are loopback URLs, and a redacted
 * endpoint would have hidden the port change that caused the incident.
 */
import {
  EMBEDDING_LEDGER_APPROVAL_TEXT,
  EMBEDDING_LEDGER_KIND_TEXT,
  EMBEDDING_LEDGER_STATUS_TEXT,
  embeddingLedgerScopeText,
  type EmbeddingLedgerEntry,
  type EmbeddingLedgerReadResult,
} from '../../embedding-ledger.ts';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../nav.ts';
import { escapeHtml, pageShell, safeHref } from '../components.ts';
import { dashboardCount, dashboardRelativeFromMs } from '../vocabulary.ts';

const DEFAULT_BASE_PATH = '/dashboard';

/**
 * Duplicated from index.ts rather than imported, exactly as the other pages
 * duplicate their own query params: index.ts imports the pages, so reading the
 * constant back from there would close an import cycle for one string.
 */
const BACKGROUND_QUERY_PARAM = 'background';

export interface EmbeddingLedgerPageOptions {
  /** Injected so the rendered relative times are testable. */
  now?: Date;
  /** Path prefix the page's own links are built from. Defaults to /dashboard. */
  basePath?: string;
}

/**
 * The page.
 *
 * Takes the already-read ledger rather than a path, for the same reason the
 * Background page takes its runtime facts: these renderers are synchronous and
 * pure, and every read behind this one touches the filesystem.
 */
export function renderEmbeddingLedgerPage(
  ledger: EmbeddingLedgerReadResult,
  options?: EmbeddingLedgerPageOptions,
): string {
  const now = options?.now ?? new Date();
  const basePath = options?.basePath ?? DEFAULT_BASE_PATH;
  return pageShell({
    title: 'Olympus',
    crumb: 'Embedding decisions',
    basePath,
    meta: metaLine(ledger),
    body: renderDashboardNav('background', { basePath })
      + renderEmbeddingLedgerBody(ledger, now, basePath),
    styles: [DASHBOARD_NAV_CSS, EMBEDDING_LEDGER_CSS],
  });
}

/** The body without the shell, so the page's composition can be read alone. */
export function renderEmbeddingLedgerBody(
  ledger: EmbeddingLedgerReadResult,
  now: Date,
  basePath: string,
): string {
  return [
    renderBackLink(basePath),
    renderBlurb(),
    renderSkipped(ledger),
    renderEntries(ledger.entries, now),
  ].filter((section) => section.length > 0).join('');
}

/**
 * The header's right-hand line. It counts entries and says the sort order,
 * because a record whose order is guessed at is a record that gets misread.
 */
function metaLine(ledger: EmbeddingLedgerReadResult): string {
  if (ledger.entries.length === 0) return 'no entries recorded';
  const entries = `${dashboardCount(ledger.entries.length)} ${plural(ledger.entries.length, 'entry', 'entries')}`;
  return `${entries} · newest first`;
}

/**
 * One link back, and no nav: another builder owns the dashboard's navigation
 * and two of them inventing it separately is how pages end up disagreeing
 * about where they sit.
 */
function renderBackLink(basePath: string): string {
  const separator = basePath.includes('?') ? '&' : '?';
  const href = safeHref(`${basePath}${separator}${BACKGROUND_QUERY_PARAM}`);
  if (href === undefined) return '';
  return `
        <div class="ledgerback"><a href="${escapeHtml(href)}">← Background</a></div>`;
}

/** What a reader who has never seen this page is owed before the first entry. */
function renderBlurb(): string {
  return `
        <div class="blurb">Every change that affects the stored embeddings is written down here, in
        the order it happened. A change to the model, the endpoint or the epoch, an invalidation of
        stored vectors, and the start and finish of every re-embed. Each entry says who approved it —
        and an entry that nobody approved says so plainly.</div>`;
}

/**
 * A damaged line is reported rather than hidden.
 *
 * The reader is entitled to know the record in front of them is incomplete: a
 * ledger that silently drops what it cannot parse is worse than no ledger,
 * because it reads as complete.
 */
function renderSkipped(ledger: EmbeddingLedgerReadResult): string {
  if (ledger.skipped === 0) return '';
  const lines = `${dashboardCount(ledger.skipped)} ${plural(ledger.skipped, 'line', 'lines')}`;
  return `
        <div class="ledgerwarn">${lines} in the ledger file could not be read and ${
    ledger.skipped === 1 ? 'was' : 'were'
  } skipped. Everything below is what remains readable, so treat this record as incomplete.</div>`;
}

function renderEntries(entries: readonly EmbeddingLedgerEntry[], now: Date): string {
  if (entries.length === 0) {
    return `
        <div class="foot">Nothing has been recorded yet. That means no embedding change has been
        logged — not that none happened.</div>`;
  }
  const rows = entries.map((entry) => renderEntry(entry, now)).join('');
  return `
        <div class="dsect">What was done to the embeddings</div>${rows}`;
}

/**
 * One entry.
 *
 * The sentence leads and the fields follow, because the reader's question is
 * "what happened" and every field under it is only ever a qualifier on the
 * answer. An absent field renders nothing at all: a blank "Model: —" row would
 * claim the ledger asked and got no answer, when in truth the event had no
 * model to name.
 */
function renderEntry(entry: EmbeddingLedgerEntry, now: Date): string {
  const facts: string[] = [];
  pushFact(facts, 'Model', entry.model_id);
  pushFact(facts, 'Epoch', entry.epoch);
  // Deliberately unredacted: these are loopback URLs, and the port inside one
  // of them is the whole story of the 2026-08-20 incident.
  pushFact(facts, 'Endpoint', entry.endpoint);
  pushFact(facts, 'Scope', embeddingLedgerScopeText(entry.scope));
  pushFact(facts, 'Why', entry.why);
  const approval = EMBEDDING_LEDGER_APPROVAL_TEXT[entry.approved_by];
  const status = EMBEDDING_LEDGER_STATUS_TEXT[entry.status];
  return `
        <div class="ledgerentry">
          <div class="ledgerhead"><span class="ledgerkind">${
    escapeHtml(EMBEDDING_LEDGER_KIND_TEXT[entry.kind])
  }</span><span class="ledgerwhen">${escapeHtml(whenText(entry.recorded_at, now))}</span></div>
          <div class="ledgerwhat">${escapeHtml(entry.what)}</div>${facts.join('')}
          <div class="ledgerfoot"><span class="${
    approvalClass(entry)
  }">${escapeHtml(approval)}</span>${status === '' ? '' : `<span class="ledgerstatus">${escapeHtml(status)}</span>`}</div>
        </div>`;
}

function pushFact(facts: string[], label: string, value: string | undefined): void {
  const text = (value ?? '').trim();
  if (text === '') return;
  facts.push(`
          <div class="ledgerfact"><span class="l">${escapeHtml(label)}</span><span class="v">${
    escapeHtml(text)
  }</span></div>`);
}

/**
 * The approval line's tone.
 *
 * An unapproved change is drawn as a failure because it was one. This is the
 * single most load-bearing pixel on the page: the incident that created the
 * ledger is an entry nobody approved, and a reader skimming must be able to
 * find it without reading a word.
 */
function approvalClass(entry: EmbeddingLedgerEntry): string {
  if (entry.approved_by === 'jamie') return 'ledgerapproval ok';
  return 'ledgerapproval no';
}

/**
 * "20 Aug 2026, 02:42 UTC · 4d ago".
 *
 * Both halves, always. The absolute stamp is what a record is for; the
 * relative one is what makes it readable at a glance. An unparsable stamp says
 * so rather than rendering an epoch date.
 */
function whenText(recordedAt: string, now: Date): string {
  const at = Date.parse(recordedAt);
  if (!Number.isFinite(at)) return 'time not recorded';
  const relative = dashboardRelativeFromMs(now.getTime() - at);
  const absolute = utcStamp(new Date(at));
  return relative === '' ? absolute : `${absolute} · ${relative}`;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** UTC, spelled out. The ledger's stamps are UTC and the page will not pretend otherwise. */
function utcStamp(at: Date): string {
  const day = at.getUTCDate();
  const month = MONTHS[at.getUTCMonth()] ?? '';
  const hours = String(at.getUTCHours()).padStart(2, '0');
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${at.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** This page's own layout. Nothing else on the dashboard uses it. */
const EMBEDDING_LEDGER_CSS = `.ledgerback { margin-bottom: 10px; font-size: 12px; }
.ledgerback a { color: var(--t3); text-decoration: none; }
.ledgerback a:hover { color: var(--t1); }
.ledgerwarn { background: var(--panel); border: 1px solid var(--warn); border-radius: 9px; padding: 10px 14px; margin-bottom: 10px; color: var(--warn); font-size: 12px; line-height: 1.5; }
.ledgerentry { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin-bottom: 8px; }
.ledgerhead { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 5px; }
.ledgerkind { font-size: 13px; font-weight: 600; }
.ledgerwhen { color: var(--t3); font-size: 11px; white-space: nowrap; }
.ledgerwhat { font-size: 13px; line-height: 1.5; margin-bottom: 7px; }
.ledgerfact { display: grid; grid-template-columns: 82px 1fr; gap: 10px; font-size: 12px; line-height: 1.5; margin-bottom: 2px; }
.ledgerfact .l { color: var(--t3); }
.ledgerfact .v { color: var(--t2); word-break: break-word; }
.ledgerfoot { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 12px; }
.ledgerapproval.ok { color: var(--good); }
.ledgerapproval.no { color: var(--bad); }
.ledgerstatus { color: var(--t3); }
`;
