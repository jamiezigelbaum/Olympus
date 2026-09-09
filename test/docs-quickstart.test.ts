import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');

describe('first-run docs', () => {
  test('quickstart documents the explicit alpha CLI flags', () => {
    const quickstart = readFileSync(join(ROOT, 'docs', 'QUICKSTART.md'), 'utf8');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const docs = `${readme}\n${quickstart}`;

    expect(docs).toContain('olympus setup --preset private-cloud-only --cloud-lane subscription --yes');
    expect(docs).toContain('privacy-approved private cloud inference');
    expect(docs).toContain('Secure search remains lexical-only in `private-cloud-only`');
    expect(docs).toContain('local presets configure local secure embeddings');
    expect(docs).not.toContain('Secure corpora remain lexical-only in v0.4');
    expect(docs).toContain('does not provide or qualify E2EE');
    expect(docs).toContain('custom integrations are user-owned');
    expect(docs).not.toContain('end-to-end-encrypted inference');
    expect(docs).toContain('olympus setup --preset no-sensitive --yes --dry-run');
    expect(docs).toContain('olympus sensitivity validate');
    expect(docs).toContain('olympus connect google --client-id <google-oauth-client-id>');
    expect(docs).toContain('olympus connect telegram --session-path ~/.local/share/olympus/telegram.session --session-ready');
    expect(docs).toContain("printf '%s' \"$VENICE_API_KEY\" | olympus connect venice --api-key-stdin");
    expect(docs).toContain('secure answers are served by the approved Venice');
    expect(docs).not.toContain('E2EE secure-answer ids remain gated until');
    expect(docs).toContain('raise-only guidance');

    expect(docs).not.toMatch(/^olympus setup\s*(?:#.*)?$/m);
    expect(docs).not.toMatch(/^olympus connect (?:google|gmail|google-drive|dropbox|telegram|whatsapp|x|venice|readwise)\s*(?:#.*)?$/m);
    expect(docs).not.toContain('olympus connect gcp');
    expect(docs).not.toContain('olympus connect notion');
    expect(docs).not.toContain('unlocks the sensitive tier without local hardware');
    expect(docs).not.toContain('without owning a GPU');
  });

  test('agent installer walks sensitivity mapping before posture and connects sources one at a time', () => {
    const install = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');

    const normalizedInstall = install.replace(/>\s*/g, '').replace(/\s+/g, ' ');
    expect(normalizedInstall).toContain('So tell me about your data: what do you want your assistant to know about, and what are you protective of?');
    expect(install.indexOf('olympus sensitivity validate')).toBeLessThan(install.indexOf('How do you want to handle your secure data?'));
    expect(install).toContain('Gmail already lives on Google\'s servers');
    expect(normalizedInstall).toContain('Default categories to **secure** unless the operator explicitly says **secrets**');
    expect(install).toContain('Run only the command for the source currently being connected.');
    expect(normalizedInstall).toContain('Setup is complete. In the Olympus dashboard, connect the sources you use.');
    expect(normalizedInstall).toContain('Source selection happens in the dashboard.');
    expect(install).not.toContain('Ask which sources they want now');
    expect(install).toContain('Keep the selected Olympus dashboard open as the operator-facing progress view.');
    expect(install).toContain('MUST explain the credential in one plain sentence before asking for it.');
    expect(install).toContain('MUST NOT show internal config keys such as');
    expect(install).toContain('MUST NOT invent keychain, `security add-generic-password`, 1Password, or');
    expect(normalizedInstall).toContain('packaged publisher-owned Desktop client ID is already present');
    expect(normalizedInstall).toContain('Google documents `client_secret` as optional');
    expect(install).not.toContain('Connect as few or as many as you like. Connecting records');
  });

  test('quickstart documents the post-Slice-2 canonical runtime boundary', () => {
    const quickstart = readFileSync(join(ROOT, 'docs', 'QUICKSTART.md'), 'utf8');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const docs = `${readme}\n${quickstart}`;

    expect(docs).toContain('All seven declared');
    expect(docs).toContain('sources sync through the canonical connector-store runtime');
    expect(docs).toContain('v0.4 supports one');
    expect(docs).toContain('connected account per provider');
    expect(docs).not.toContain('Gmail and Google Drive connection is recorded');
    expect(docs).not.toContain('default to `legacy_index`');
    expect(docs).toContain('Sync now');
    expect(docs).not.toContain('background scheduler currently runs the Dropbox file pipeline');
  });

  test('required user-facing transition and full tier explainer preserve approved copy', () => {
    const install = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const scripts = [
      ["> Olympus is installed. Quick proof:", 'd3f1f9fddd7d6b9a376a7ffcfa81ad841ca87524f8298a58d8a1df62934a9aab'],
      ["> Here's how Olympus treats your data", '6572236609c7e45c9f11f3f2974605f752f98dddda33dc47d7c2a4fb7966f5ad'],
    ];
    for (const [start, digest] of scripts) {
      const from = install.indexOf(start!);
      expect(from).toBeGreaterThan(0);
      const block = install.slice(from, install.indexOf('\n\n', from));
      expect(createHash('sha256').update(block).digest('hex')).toBe(digest!);
    }
    expect(install).toContain('required user-facing transition');
    expect(install).toContain('Required user-facing four-tier explanation');
    expect(install).toContain('before asking any sensitivity or posture question');
    expect(install.indexOf(scripts[0]![0]!)).toBeLessThan(install.indexOf(scripts[1]![0]!));
    expect(install.indexOf(scripts[1]![0]!)).toBeLessThan(install.indexOf('> Do you run local AI models'));
  });

  test('base activation precedes optional source choice and source answer proof', () => {
    const install = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const quickstart = readFileSync(join(ROOT, 'docs/QUICKSTART.md'), 'utf8');
    for (const [doc, steps] of [
      [install, ['## Step 4 — Verify the worker', '## Step 5 — Validate', '## Step 6 — Optional source setup', '## Step 7 — Verify the chosen source']],
      [quickstart, ['## 3. Check the worker', '## 4. Validate', '## 5. Optionally connect a source', '## 6. Verify a cited answer']],
    ] as const) {
      const positions = steps.map((step) => doc.indexOf(step));
      expect(positions.every((position) => position > 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
      const activation = doc.slice(positions[1], positions[2]);
      expect(activation).toContain('openclaw config validate');
      expect(activation).toContain('openclaw gateway restart');
      const sourceSetup = doc.slice(positions[2], positions[3]);
      expect(sourceSetup).toMatch(/source.*later/);
      expect(sourceSetup).toContain('checklist');
      expect(doc.slice(positions[3])).toMatch(/initial sync and answer\s+readiness|initial sync and\s+reports answer readiness/);
      expect(doc).not.toContain('Connect Gmail in step 4');
    }
    expect(install).toContain('The restart is its own consent gate');
    expect(install).toContain('Each credential here is its own Rule one gate');
    expect(install).toContain('Now clear the second gate, before you run setup');
    expect(install).toContain('base installation verified; cited-answer');
  });

  test('credential sourcing distinguishes manual web access from authenticated CLI access', () => {
    for (const path of ['INSTALL_FOR_AGENTS.md', 'docs/SOVEREIGNTY_CONFIG.md']) {
      const doc = readFileSync(join(ROOT, path), 'utf8').replace(/\s+/g, ' ');
      expect(doc).toContain('op://vault/item/field');
      expect(doc).toContain('authenticated `op` access');
      expect(doc).toMatch(/No password-manager desktop app or CLI is required|requires no password-manager desktop app or CLI/);
      expect(doc).toContain('silent terminal input');
    }
  });

  test('private cloud only distinguishes secure search from ordinary embeddings', () => {
    const install = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const posture = install.slice(install.indexOf('> 3. **Private cloud only**'), install.indexOf('> 4. **Do not add'))
      .replace(/>\s*/g, '').replace(/\s+/g, ' ');
    expect(posture).toContain('Secure content goes only to Venice');
    expect(posture).toContain('public and ordinary-private search indexing');
    expect(posture).toContain('keyword search');
    expect(posture).toContain('secure content never goes to Gemini');
    expect(posture).toContain('“Only” describes secure-data handling');
  });

  test('native dashboard guidance checks artifact support and preserves standalone authentication', () => {
    for (const path of ['INSTALL_FOR_AGENTS.md', 'README.md', 'docs/QUICKSTART.md']) {
      const doc = readFileSync(join(ROOT, path), 'utf8').replace(/\s+/g, ' ');
      expect(doc).toContain('2026.9.2');
      expect(doc).toContain('artifact includes native Control UI support');
      expect(doc).toContain('standalone dashboard');
    }
    const install = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    expect(install).toContain('Settings → Labs → Custom plugin UI');
    expect(install).toContain('gateway.publicOrigin');
    expect(install).toContain('never paste it into chat');
    expect(install).toContain('`dash_` token is not the worker token');
  });

  test('active top-level docs use resolvable relative links', () => {
    const unresolved: string[] = [];
    for (const markdownPath of activeMarkdownFiles()) {
      const markdown = readFileSync(markdownPath, 'utf8');
      for (const link of relativeMarkdownLinks(markdown)) {
        const target = join(dirname(markdownPath), link.path);
        if (!existsSync(target)) {
          unresolved.push(`${relative(ROOT, markdownPath)} -> ${link.href}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });

  test('contributor docs describe the installed Bun runtime accurately', () => {
    const development = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
    const normalized = development.replace(/\s+/g, ' ');

    expect(development).toContain('Development and release packaging use Bun.');
    expect(normalized).toContain('CLI and worker service run through the Bun shebang or an absolute Bun');
    expect(development).not.toContain('runs on Node-compatible JavaScript');
  });
});

function activeMarkdownFiles(): string[] {
  return [
    join(ROOT, 'README.md'),
    join(ROOT, 'INSTALL_FOR_AGENTS.md'),
    join(ROOT, 'CONTRIBUTING.md'),
    ...[...new Bun.Glob('docs/**/*.md').scanSync({ cwd: ROOT })]
      .map((entry) => join(ROOT, entry)),
  ];
}

function relativeMarkdownLinks(markdown: string): Array<{ href: string; path: string }> {
  const links: Array<{ href: string; path: string }> = [];
  for (const match of markdown.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const href = match[1]!.trim();
    if (isExternalOrAnchorHref(href)) continue;
    links.push({ href, path: href.split('#')[0]! });
  }
  return links;
}

function isExternalOrAnchorHref(href: string): boolean {
  return href.startsWith('#')
    || href.startsWith('mailto:')
    || /^[a-z][a-z0-9+.-]*:/i.test(href);
}
