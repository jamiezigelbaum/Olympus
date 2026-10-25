/**
 * Layout rules: what is wrong with a screen's look that the page itself can tell exactly, read from the rendered page in the test
 * browser rather than judged from a picture. They exist because the AI reviewer (reviewer.ts) did not see these kinds in its first
 * qualification (2026-10-25: a fixed-width font 0 of 15, a misaligned button 0 of 12, a clipped heading 0 of 12, faint text 5 of 15),
 * and because the first two are what only a person caught in the first visual baselines (2026-10-23).
 *
 *   monospace-text       most of the page's ordinary text renders in a fixed-width font (measured, so a missing system font that
 *                        falls back to one counts, whatever the stylesheet asks for); a code box or two in a fixed-width font is fine
 *   clipped-text         text cut off by its own box: wider or taller than the box, which hides the rest, without an ellipsis
 *   overlapping-text     lines of text from two different elements drawn over each other
 *   misaligned-controls  buttons stacked in one column that line up by none of their left edges, right edges or centres, off by a
 *                        few pixels (a different layout is further apart than that)
 *   faint-text           text faded by opacity until it is hard to read, outside disabled controls
 *
 * Each rule is generic: nothing names a product page, a class or a label. The screens step runs them on every screen in every frame
 * (journey-driver.ts), and a qualification run runs them on the planted pictures too (reviewer-plants.ts), so every rule is held to
 * the bug planted for it and to the screens with nothing planted.
 *
 * Blocking since 2026-10-25: a finding fails the run. Earned by Linux qualification run 20261025t130646-d27f (every planted bug caught,
 * 23 of 23, nothing on the 20 screens with nothing planted) and full runs with nothing found on all 20 screens on Linux
 * (20261025t130925-32c3) and the Mac (20261025t130313-a558). A rule changed later is qualified again before it ships.
 */
import type { CheckResult } from './report.ts';

export const LAYOUT_RULES = ['monospace-text', 'clipped-text', 'overlapping-text', 'misaligned-controls', 'faint-text'] as const;
export type LayoutRule = typeof LAYOUT_RULES[number];

/** Whether a finding fails the run. Turned on in a reviewed change, with the qualification run that earned it. */
export const LAYOUT_RULES_BLOCKING = true;

export const isLayoutRule = (kind: unknown): kind is LayoutRule => (LAYOUT_RULES as readonly unknown[]).includes(kind);

export interface LayoutFinding {
  rule: LayoutRule;
  /** What is wrong, in a sentence. */
  what: string;
  /** Which element, by tag, its words and where it is on the page. */
  where: string;
}

/** The page script: an array of findings for the frame it runs in. Run with `everyFrame` (journey-driver.ts). */
export function layoutRulesScript(): string {
  return String.raw`(() => {
  const out = [];
  if (!document.body) return out;
  // Text kept for screen readers only (a 1 px clipped box) is hidden on purpose, not clipped by mistake.
  const forReaders = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const s = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      if (/^rect\(0(px)?,? 0/.test(s.clip || '') || /^inset\(50%/.test(s.clipPath || '') || (r.width <= 1 && r.height <= 1 && /hidden|clip/.test(s.overflow))) return true;
    }
    return false;
  };
  const hidden = (el) => { const s = getComputedStyle(el); return s.visibility === 'hidden' || s.display === 'none' || !!el.closest('details:not([open]) > :not(summary), [hidden], [aria-hidden="true"]') || forReaders(el); };
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !hidden(el); };
  const own = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').replace(/\s+/g, ' ').trim();
  const words = (el) => (own(el) || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const where = (el) => { const r = el.getBoundingClientRect(); return el.tagName.toLowerCase() + ' "' + words(el) + '" at ' + Math.round(r.left + scrollX) + ',' + Math.round(r.top + scrollY); };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'IFRAME']);
  const texts = Array.from(document.body.querySelectorAll('*')).filter((el) => !SKIP.has(el.tagName) && own(el).length >= 2 && shown(el));
  const inField = (el) => !!el.closest('textarea, input, select, code, pre, kbd, samp');

  // monospace-text: measured, not read from the stylesheet. In a fixed-width font a run of i and a run of M are the same width.
  const canvas = document.createElement('canvas').getContext('2d');
  const fixedCache = new Map();
  const fixed = (el) => {
    if (!canvas) return false;
    const s = getComputedStyle(el);
    const font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily;
    if (!fixedCache.has(font)) { canvas.font = font; fixedCache.set(font, Math.abs(canvas.measureText('iiiiiiiiii').width - canvas.measureText('MMMMMMMMMM').width) < 0.5); }
    return fixedCache.get(font);
  };
  const prose = texts.filter((el) => !inField(el));
  const mono = prose.filter(fixed);
  if (prose.length >= 5 && mono.length / prose.length >= 0.5) {
    out.push({ rule: 'monospace-text', what: mono.length + ' of ' + prose.length + ' pieces of ordinary text render in a fixed-width font (' + getComputedStyle(mono[0]).fontFamily.slice(0, 80) + ')', where: where(mono[0]) });
  }

  // clipped-text: the box hides part of its own text, with no ellipsis to say so.
  for (const el of texts) {
    if (inField(el)) continue;
    const s = getComputedStyle(el);
    if (s.textOverflow === 'ellipsis') continue;
    const clipsX = /hidden|clip/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const clipsY = /hidden|clip/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1 && s.webkitLineClamp === 'none';
    if (clipsX || clipsY) out.push({ rule: 'clipped-text', what: 'the text is cut off by its box (' + (clipsX ? el.scrollWidth + ' px of text in ' + el.clientWidth + ' px' : el.scrollHeight + ' px of text in ' + el.clientHeight + ' px') + ')', where: where(el) });
  }

  // overlapping-text: the drawn lines of two unrelated elements cover each other.
  const lines = [];
  for (const el of texts) {
    const range = document.createRange();
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.nodeValue.trim()) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 2 && r.height > 2) lines.push({ el, r });
    }
  }
  const reported = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i], b = lines[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (w * h < 30 || w * h < 0.2 * smaller) continue;
      const key = [a.el, b.el].map(where).sort().join(' / ');
      if (reported.has(key)) continue;
      reported.add(key);
      out.push({ rule: 'overlapping-text', what: 'two lines of text are drawn over each other (' + Math.round(h) + ' px deep)', where: key });
    }
  }

  // misaligned-controls: buttons of one repeated structure (rows of a list) stacked in one column that line up by nothing, off by a few
  // pixels. Buttons of unrelated parts of the page may sit a few pixels apart on purpose, so they are not compared, whatever their
  // label (2026-10-25: an "Open" inside a padded notice was compared with the "Open" buttons of the list below it).
  const controls = Array.from(document.body.querySelectorAll('button, [role="button"], a.button, input[type="submit"], input[type="button"]')).filter(shown);
  const shape = (el) => { const parts = []; for (let node = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) parts.push(node.tagName + '.' + Array.from(node.classList).sort().join('.')); return parts.join('<'); };
  const groups = new Map();
  for (const el of controls) groups.set(shape(el), [...(groups.get(shape(el)) || []), { el, r: el.getBoundingClientRect() }]);
  const misaligned = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const column = (x, y) => Math.min(x.r.right, y.r.right) - Math.max(x.r.left, y.r.left) > 0;
    const inLine = (x, y) => Math.abs(x.r.left - y.r.left) <= 1 || Math.abs(x.r.right - y.r.right) <= 1 || Math.abs((x.r.left + x.r.right) / 2 - (y.r.left + y.r.right) / 2) <= 1;
    for (const box of group) {
      const stacked = group.filter((other) => other !== box && column(box, other) && (other.r.top >= box.r.bottom || other.r.bottom <= box.r.top));
      if (stacked.length === 0 || stacked.some((other) => inLine(box, other))) continue;
      // Out of line with every button of its kind in its column, and by a few pixels only: a different layout is further apart.
      const off = Math.min(...stacked.map((other) => Math.min(Math.abs(box.r.left - other.r.left), Math.abs(box.r.right - other.r.right))));
      if (off > 24 || misaligned.has(box.el)) continue;
      // Of two that line up with nothing, report the one the others do not line up with either.
      if (stacked.length === 1 && group.filter((other) => other !== stacked[0] && column(stacked[0], other)).some((other) => other !== box && inLine(stacked[0], other))) continue;
      misaligned.add(box.el);
      out.push({ rule: 'misaligned-controls', what: 'a button is out of line with the others like it in its column by ' + Math.round(off) + ' px', where: where(box.el) });
    }
  }

  // faint-text: faded by opacity, outside disabled controls (which are faded on purpose).
  const faint = new Set();
  for (const el of texts) {
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    let opacity = 1;
    let fader = null;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const o = parseFloat(getComputedStyle(node).opacity);
      if (o < 1 && !fader) fader = node;
      opacity *= o;
    }
    if (opacity < 0.55 && fader && !faint.has(fader)) { faint.add(fader); out.push({ rule: 'faint-text', what: 'text is faded to ' + Math.round(opacity * 100) + '% opacity', where: where(el) }); }
  }
  return out;
})()`;
}

/** The findings `everyFrame` brought back from each frame, checked and flattened; anything malformed is dropped. */
export function layoutFindings(perFrame: readonly unknown[]): LayoutFinding[] {
  const out: LayoutFinding[] = [];
  for (const frame of perFrame) {
    if (!Array.isArray(frame)) continue;
    for (const item of frame) {
      const record = item as Partial<LayoutFinding> | null;
      if (!record || !isLayoutRule(record.rule) || typeof record.what !== 'string' || typeof record.where !== 'string') continue;
      out.push({ rule: record.rule as LayoutRule, what: record.what.slice(0, 300), where: record.where.slice(0, 300) });
    }
  }
  return out;
}

/** One check per screen: it passes only with no finding; a finding fails it once the rules are blocking, and warns until then. */
export function layoutChecks(screens: ReadonlyArray<{ name: string; layout?: LayoutFinding[] }>, blocking = LAYOUT_RULES_BLOCKING): CheckResult[] {
  return screens.filter((screen) => Array.isArray(screen.layout)).map((screen) => {
    const findings = screen.layout!;
    return {
      id: `layout.${screen.name}`,
      title: `Layout rules on ${screen.name}${blocking ? '' : ' (advisory)'}`,
      status: findings.length === 0 ? 'pass' : blocking ? 'fail' : 'warn',
      detail: findings.length === 0 ? 'no fixed-width text, clipped or overlapping text, misaligned buttons or faded text' : findings.map((finding) => `${finding.rule}: ${finding.what} — ${finding.where}`).join('; ').slice(0, 1_500),
    };
  });
}

export interface LayoutScore {
  /** Per planted bug that a rule answers for: how many of its pictures the rule caught. */
  perPlant: Array<{ plant: string; rule: LayoutRule; looked: number; found: number }>;
  /** Findings on the pictures with nothing planted (each a false alarm or a real problem a person decides). */
  clean: Array<{ picture: string } & LayoutFinding>;
  /** Rules no planted picture tested. */
  unproven: LayoutRule[];
  /** Every planted bug caught on every picture, and nothing on the pictures with nothing planted. */
  qualified: boolean;
}

/**
 * Scores the rules over a qualification run's pictures: each bug planted for a rule (its kind is the rule) must be found by that rule,
 * and the pictures with nothing planted must have no finding. Pictures the rules did not look at are left out.
 */
export function scoreLayoutRules(pictures: ReadonlyArray<{ picture: string; plant: string | null; kind: string | null; layout?: LayoutFinding[] }>): LayoutScore {
  const perPlant = new Map<string, { plant: string; rule: LayoutRule; looked: number; found: number }>();
  const clean: LayoutScore['clean'] = [];
  for (const picture of pictures) {
    if (!Array.isArray(picture.layout)) continue;
    const findings = picture.layout;
    if (!picture.plant) { for (const finding of findings) clean.push({ picture: picture.picture, ...finding }); continue; }
    const rule = picture.kind;
    if (!isLayoutRule(rule)) continue;
    const entry = perPlant.get(picture.plant) ?? { plant: picture.plant, rule, looked: 0, found: 0 };
    entry.looked += 1;
    if (findings.some((finding) => finding.rule === rule)) entry.found += 1;
    perPlant.set(picture.plant, entry);
  }
  const plants = [...perPlant.values()];
  // Every rule is held to a bug planted for it: a plant that took on no page leaves its rule unproven.
  const unproven = LAYOUT_RULES.filter((rule) => !plants.some((entry) => entry.rule === rule && entry.looked > 0));
  return { perPlant: plants, clean, unproven, qualified: unproven.length === 0 && plants.every((entry) => entry.found === entry.looked) && clean.length === 0 };
}

/** The score as a check of the qualification run (never of a release). */
export function layoutQualificationCheck(score: LayoutScore): CheckResult {
  const missed = score.perPlant.filter((entry) => entry.found < entry.looked).map((entry) => `${entry.plant} (${entry.rule}) found on ${entry.found} of ${entry.looked}`);
  const alarms = score.clean.map((finding) => `${finding.picture}: ${finding.rule}: ${finding.what} — ${finding.where}`);
  return {
    id: 'layout.qualification',
    title: 'The layout rules caught every planted bug and nothing on the pictures with nothing planted',
    status: score.qualified ? 'pass' : 'fail',
    detail: score.perPlant.length === 0 ? 'no planted picture was measured' : [
      score.perPlant.map((entry) => `${entry.plant}: ${entry.found}/${entry.looked}`).join(', '),
      ...(score.unproven.length ? [`no bug was planted for: ${score.unproven.join(', ')}`] : []),
      ...(missed.length ? [`missed: ${missed.join('; ')}`] : []),
      ...(alarms.length ? [`on pictures with nothing planted: ${alarms.join('; ')}`] : []),
    ].join('. ').slice(0, 2_000),
  };
}
