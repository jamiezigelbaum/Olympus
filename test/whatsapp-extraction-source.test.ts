import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { WhatsAppExtractionSource } from '../src/workers/whatsapp/extraction-source.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WhatsApp shared extraction source', () => {
  test('enumerates unrepresented audio and returns local bytes', async () => {
    const root = fixtureRoot();
    const mediaRoot = join(root, 'media', 'audio');
    mkdirSync(mediaRoot, { recursive: true });
    const mediaPath = join(mediaRoot, 'voice.ogg');
    writeFileSync(mediaPath, 'audio-bytes');
    const source = sourceFor(mediaRoot, mediaPath);

    const page = await source.listCandidates({ limit: 10 });
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0]).toMatchObject({
      corpusId: 'secure_local.whatsapp.messages',
      provider: 'whatsapp',
      accountScope: 'personal',
      approvedScopeKey: 'whatsapp.personal.messages',
      providerItemId: 'voice-1',
      name: 'voice.ogg',
      mimeType: 'audio/ogg',
    });
    expect(new TextDecoder().decode((await source.fetch(page.candidates[0]!, {})).bytes))
      .toBe('audio-bytes');
  });

  test('refuses a locator outside the configured media root', async () => {
    const root = fixtureRoot();
    const mediaRoot = join(root, 'media', 'audio');
    mkdirSync(mediaRoot, { recursive: true });
    const outside = join(root, 'outside.ogg');
    writeFileSync(outside, 'private-outside-bytes');
    const source = sourceFor(mediaRoot, outside);
    const [ref] = (await source.listCandidates({ limit: 10 })).candidates;

    await expect(source.fetch(ref!, {})).rejects.toMatchObject({
      errorKind: 'source_permission_denied',
      message: 'source_permission_denied',
    });
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-whatsapp-extraction-'));
  roots.push(root);
  return root;
}

function sourceFor(mediaRoot: string, locatorUri: string): WhatsAppExtractionSource {
  return new WhatsAppExtractionSource({
    id: 'whatsapp-test-extraction',
    corpusId: 'secure_local.whatsapp.messages',
    provider: 'whatsapp',
    accountScope: 'personal',
    approvedScopeKey: 'whatsapp.personal.messages',
    mediaRoots: [mediaRoot],
    candidates: {
      extractionCandidates: () => ({
        candidates: [{
          localItemId: 'personal:chat-1:voice-1',
          providerItemId: 'voice-1',
          accountScope: 'personal',
          provider: 'whatsapp',
          mimeType: 'audio/ogg',
          locatorUri,
          sourceVersion: '2026-08-27T10:00:00Z',
        }],
        done: true,
      }),
    },
    locators: { localContent: () => ({ locatorUri }) },
  });
}
