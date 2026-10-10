/**
 * Writes the olympusplugin.ai /open/ pages: one static page per olympus://
 * target (src/core/open-targets.ts), which the ChatGPT panel opens for
 * "do this on your computer" (the panel may only open olympusplugin.ai links).
 *
 *   bun scripts/build-open-pages.ts           # write site/open/
 *   bun scripts/build-open-pages.ts --check   # fail when site/open/ is stale
 *
 * Each page tries its olympus:// link once with a meta refresh, offers the
 * same link as a button (a click is the gesture some browsers want), and
 * always shows the two steps by hand for a phone or a computer without the
 * link handler, plus the two lines for Olympus on a server (an SSH tunnel and
 * a one-time link). No script, no tracking, nothing from another site: the
 * site's own Content-Security-Policy (site/deploy/Caddyfile.site) allows no
 * script at all, and a meta refresh is navigation, which it does not govern.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  OPEN_CONNECT_SOURCES,
  allOpenTargets,
  olympusOpenUrl,
  openTargetPath,
  type OpenTarget,
} from '../src/core/open-targets.ts';
import { DEFAULT_ENGINE_PORT, remoteOpenInstructions } from '../src/core/remote-open.ts';

const SITE_OPEN_DIR = join(import.meta.dir, '..', 'site', 'open');

/** What to do by hand once the dashboard is open, per target. */
function handStep(target: OpenTarget): string | undefined {
  if (target.kind === 'connect') {
    return `Under <strong>Sources</strong>, choose <strong>Connect</strong> (or <strong>Reconnect</strong>) next to <strong>${OPEN_CONNECT_SOURCES[target.source].label}</strong>.`;
  }
  if (target.kind === 'fix') {
    switch (target.section) {
      case 'connect': return 'Under <strong>Sources</strong>, choose <strong>Connect</strong> next to the source.';
      case 'reconnect': return 'Under <strong>Sources</strong>, choose <strong>Reconnect</strong> next to the source.';
      case 'answers': return 'Open <strong>Models</strong> and check the answer model.';
      case 'search': return 'Open <strong>Models</strong> and check the search model.';
      case 'models': return 'Open <strong>Models</strong>.';
    }
  }
  return undefined;
}

/** The help page section that explains this target at length. */
function helpAnchor(target: OpenTarget): string {
  if (target.kind === 'connect') return 'connect';
  if (target.kind === 'fix') return target.section;
  return 'open-olympus';
}

/**
 * Remote mode by hand (core/remote-open.ts): a static page cannot know the
 * engine's port or the server's name, so it shows the default port and says
 * what to change. The panel shows the real port when the engine declares it
 * runs on a server.
 */
function remoteSection(target: OpenTarget): string {
  const lines = remoteOpenInstructions({ port: DEFAULT_ENGINE_PORT, target });
  return `<h2 id="on-a-server">If Olympus runs on a server</h2>
      <p>Open it on your computer through a secure tunnel. On your computer, run:</p>
      <pre><code>${lines.onComputer}</code></pre>
      <p>Then on the server, run this and open the link it prints in your computer's browser:</p>
      <pre><code>${lines.onServer}</code></pre>
      <p>${DEFAULT_ENGINE_PORT} is the usual port. If the printed link shows another number, use that number on both sides of the tunnel: the link only works on that port. Replace <code>you@your-server</code> with how you sign in to the server.</p>
      <p>If your assistant runs on the server and your computer is paired with it (OpenClaw), you can ask it instead: <strong>Open Olympus on my computer</strong>.</p>`;
}

export function renderOpenPage(target: OpenTarget): string {
  const link = olympusOpenUrl(target);
  const step = handStep(target);
  const steps = [
    '<li>On the computer running Olympus, open Terminal and run <code>olympus dashboard</code>. Olympus opens in your browser.</li>',
    ...(step ? [`<li>${step}</li>`] : []),
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Opening Olympus on your computer - Olympus</title>
  <meta name="description" content="Opens Olympus on your computer, or says how to open it by hand.">
  <meta name="robots" content="noindex">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="refresh" content="0; url=${link}">
  <link rel="stylesheet" href="/style.css">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site">
    <div class="wrap">
      <a class="brand" href="/"><svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M2 27 12.5 9l4.2 7.2L20 11l10 16Z" fill="currentColor"/></svg><span>Olympus</span></a>
    </div>
  </header>
  <main id="main">
    <div class="wrap">
      <h1>Opening Olympus on your computer…</h1>
      <p class="lede">If your browser asks whether to open Olympus, choose <strong>Open</strong>. Olympus opens in your browser, ready to use.</p>
      <p class="cta"><a class="button" href="${link}">Open Olympus</a></p>

      <h2 id="by-hand">If nothing happens</h2>
      <p>On a phone, or on a computer where Olympus is not installed yet or is older, do it by hand:</p>
      <ol class="flow">
        ${steps.join('\n        ')}
      </ol>

      ${remoteSection(target)}
      <p class="meta">More help: <a href="/help/on-your-computer/#${helpAnchor(target)}">Fix it on your computer</a>.</p>
    </div>
  </main>
  <footer class="site">
    <div class="wrap">
      <ul>
        <li><a href="/install/">Install</a></li>
        <li><a href="/support/">Support</a></li>
        <li><a href="/privacy/">Privacy</a></li>
        <li><a href="/terms/">Terms</a></li>
      </ul>
      <p>Olympus is published by Open Coordination Unlimited, Inc. Olympus is not made by or affiliated with OpenAI.</p>
    </div>
  </footer>
</body>
</html>
`;
}

/** Every file under site/open/, by path relative to it, as it should be. */
export function expectedOpenPages(): Map<string, string> {
  const pages = new Map<string, string>();
  for (const target of allOpenTargets()) {
    pages.set(join(openTargetPath(target), 'index.html'), renderOpenPage(target));
  }
  // /open/ itself opens the plain dashboard.
  pages.set('index.html', renderOpenPage({ kind: 'dashboard' }));
  return pages;
}

function currentOpenPages(): Map<string, string> {
  const pages = new Map<string, string>();
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else pages.set(relative(SITE_OPEN_DIR, path), readFileSync(path, 'utf8'));
    }
  };
  walk(SITE_OPEN_DIR);
  return pages;
}

if (import.meta.main) {
  const expected = expectedOpenPages();
  if (process.argv.includes('--check')) {
    const current = currentOpenPages();
    const stale = [...new Set([...expected.keys(), ...current.keys()])]
      .filter((path) => expected.get(path) !== current.get(path));
    if (stale.length > 0) {
      console.error(`site/open/ is stale (${stale.join(', ')}); run bun scripts/build-open-pages.ts.`);
      process.exit(1);
    }
  } else {
    rmSync(SITE_OPEN_DIR, { recursive: true, force: true });
    for (const [path, html] of expected) {
      mkdirSync(dirname(join(SITE_OPEN_DIR, path)), { recursive: true });
      writeFileSync(join(SITE_OPEN_DIR, path), html);
    }
  }
}
