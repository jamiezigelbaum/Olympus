// The site's Content-Security-Policy (site/deploy/Caddyfile.site) allows inline scripts only by hash. Editing an inline
// script without updating its hash would silently stop it running on olympusplugin.ai (the local preview sends no CSP).
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const caddy = readFileSync(join(ROOT, 'site/deploy/Caddyfile.site'), 'utf8');
const csp = /Content-Security-Policy "([^"]+)"/.exec(caddy)?.[1] ?? '';
const directive = (name: string) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '').split(/\s+/).slice(1);

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'deploy' || name === 'releases') return [];
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

function inlineScriptHashes(): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of htmlFiles(join(ROOT, 'site'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      hashes.set(`'sha256-${createHash('sha256').update(m[1] ?? '').digest('base64')}'`, file.slice(ROOT.length + 1));
    }
  }
  return hashes;
}

describe('site Content-Security-Policy', () => {
  test('allows every inline script by hash, and no hash for a script that no longer exists', () => {
    const allowed = directive('script-src').filter((s) => s.startsWith("'sha256-"));
    const present = inlineScriptHashes();
    expect(present.size).toBeGreaterThan(0);
    expect([...present.keys()].filter((h) => !allowed.includes(h)).map((h) => present.get(h))).toEqual([]);
    expect(allowed.filter((h) => !present.has(h))).toEqual([]);
  });

  test('loads only from the site itself, and frames only its own pages', () => {
    expect(directive('default-src')).toEqual(["'none'"]);
    for (const name of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'frame-src', 'connect-src']) {
      expect(directive(name).filter((s) => !s.startsWith("'sha256-") && s !== "'unsafe-inline'")).toEqual(["'self'"]);
    }
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
    expect(directive('frame-ancestors')).toEqual(["'self'"]);
    expect(caddy).toContain('X-Frame-Options "SAMEORIGIN"');
  });
});
