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
    expect(docs).toContain('Secure corpora remain lexical-only in v0.4');
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
    expect(install).toContain('Keep `olympus dashboard` open as the operator-facing progress view.');
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

  test('README first-run path opens the dashboard only after worker and gateway checks', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const getStarted = readme.slice(
      readme.indexOf('## Get started'),
      readme.indexOf('Full walkthrough with what to expect at each step:'),
    );

    expect(getStarted.indexOf('olympus worker install')).toBeLessThan(getStarted.indexOf('olympus dashboard'));
    expect(getStarted.indexOf('olympus worker status')).toBeLessThan(getStarted.indexOf('olympus dashboard'));
    expect(getStarted.indexOf('openclaw config validate')).toBeLessThan(getStarted.indexOf('openclaw gateway restart'));
    expect(getStarted.indexOf('openclaw doctor --lint')).toBeLessThan(getStarted.indexOf('openclaw gateway restart'));
    expect(getStarted.indexOf('openclaw gateway restart')).toBeLessThan(getStarted.indexOf('olympus dashboard'));
    expect(readme).toContain('treat plugin install/enable, gateway');
    expect(readme).toMatch(/repo docs and commands should never require raw edits to\s+OpenClaw runtime config/);
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
