// Whether scans and pictures of text are read, and the one command that fixes
// it, per distribution. Pure: the probe answer, platform and os-release text
// are all injected, so this runs the same on every host.

import { describe, expect, test } from 'bun:test';
import {
  checkOcrReadiness,
  describeOcrReadiness,
  linuxFamilyFromOsRelease,
  ocrInstallRemedy,
} from '../src/core/ocr-readiness.ts';
import { ocrDependencyFinding } from '../src/core/setup.ts';
import type { OcrCapabilitySnapshot } from '../src/workers/file-extraction/extractors/ocr-capability.ts';

const OMARCHY = 'NAME="Omarchy"\nPRETTY_NAME="Omarchy"\nID=omarchy\nID_LIKE=arch\nBUILD_ID=rolling\n';
const ARCH = 'NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n';
const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n';
const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n';
const MINT = 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n';
const FEDORA = 'NAME="Fedora Linux"\nID=fedora\n';
const ROCKY = 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n';
const ALPINE = 'NAME="Alpine Linux"\nID=alpine\n';

const snapshot = (over: Partial<OcrCapabilitySnapshot>): OcrCapabilitySnapshot => ({
  tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing', pdfEngine: undefined, imageEngine: undefined, checkedAt: 1, ...over,
});

describe('distribution family from /etc/os-release', () => {
  test('Omarchy and Arch are arch; Ubuntu, Debian and Mint are debian; Fedora and Rocky are fedora', () => {
    expect(linuxFamilyFromOsRelease(OMARCHY)).toBe('arch');
    expect(linuxFamilyFromOsRelease(ARCH)).toBe('arch');
    expect(linuxFamilyFromOsRelease(UBUNTU)).toBe('debian');
    expect(linuxFamilyFromOsRelease(DEBIAN)).toBe('debian');
    expect(linuxFamilyFromOsRelease(MINT)).toBe('debian');
    expect(linuxFamilyFromOsRelease(FEDORA)).toBe('fedora');
    expect(linuxFamilyFromOsRelease(ROCKY)).toBe('fedora');
  });

  test('anything else, or no file, is other', () => {
    expect(linuxFamilyFromOsRelease(ALPINE)).toBe('other');
    expect(linuxFamilyFromOsRelease('ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n')).toBe('other');
    expect(linuxFamilyFromOsRelease(undefined)).toBe('other');
    expect(linuxFamilyFromOsRelease('')).toBe('other');
  });

  test('an unknown ID that says it is like arch is arch', () => {
    expect(linuxFamilyFromOsRelease("ID='someremix'\nID_LIKE='arch'\n")).toBe('arch');
  });
});

describe('the one remedy per distribution', () => {
  test('exact commands', () => {
    expect(ocrInstallRemedy({ platform: 'linux', family: 'arch' })).toBe('sudo pacman -S --needed tesseract tesseract-data-eng poppler');
    expect(ocrInstallRemedy({ platform: 'linux', family: 'debian' })).toBe('sudo apt install tesseract-ocr poppler-utils');
    expect(ocrInstallRemedy({ platform: 'linux', family: 'fedora' })).toBe('sudo dnf install tesseract poppler-utils');
    expect(ocrInstallRemedy({ platform: 'darwin', family: 'other' })).toBe('brew install tesseract poppler');
  });

  test('an unknown distribution gets the package names, never a guess at a package manager', () => {
    const remedy = ocrInstallRemedy({ platform: 'linux', family: 'other' });
    expect(remedy).toContain('tesseract');
    expect(remedy).toContain('pdftoppm');
    expect(remedy).not.toContain('sudo');
  });

  test('ocrmypdf is never part of the remedy', () => {
    for (const family of ['arch', 'debian', 'fedora', 'other'] as const) {
      expect(ocrInstallRemedy({ platform: 'linux', family })).not.toContain('ocrmypdf');
    }
  });
});

describe('readiness report', () => {
  test('ready names the engines', () => {
    const viaOcrmypdf = describeOcrReadiness({
      platform: 'linux', family: 'debian',
      snapshot: snapshot({ tesseract: 'ok', pdftoppm: 'ok', ocrmypdf: 'ok', pdfEngine: 'ocrmypdf', imageEngine: 'tesseract' }),
    });
    expect(viaOcrmypdf).toMatchObject({ state: 'ready', pdfEngine: 'ocrmypdf', imageEngine: 'tesseract' });
    expect(viaOcrmypdf.remedy).toBeUndefined();
    const viaRaster = describeOcrReadiness({
      platform: 'linux', family: 'arch',
      snapshot: snapshot({ tesseract: 'ok', pdftoppm: 'ok', pdfEngine: 'pdftoppm_tesseract', imageEngine: 'tesseract' }),
    });
    expect(viaRaster).toMatchObject({ state: 'ready', pdfEngine: 'pdftoppm + tesseract', imageEngine: 'tesseract' });
    expect(viaRaster.detail).toContain('pdftoppm + tesseract');
  });

  test('a Mac with Vision is ready with nothing to install', () => {
    expect(describeOcrReadiness({ platform: 'darwin', family: 'other', snapshot: undefined, vision: true }))
      .toMatchObject({ state: 'ready', pdfEngine: 'Apple Vision', imageEngine: 'Apple Vision' });
  });

  test('missing tesseract: missing, with the distribution command, and it says files are read automatically later', () => {
    const arch = describeOcrReadiness({ platform: 'linux', family: 'arch', snapshot: snapshot({}) });
    expect(arch.state).toBe('missing');
    expect(arch.remedy).toBe('sudo pacman -S --needed tesseract tesseract-data-eng poppler');
    expect(arch.detail).toContain('tesseract is not installed');
    expect(arch.detail).toContain('read automatically');
  });

  test('a tesseract that cannot read the test picture says so (language data), with the same remedy', () => {
    const report = describeOcrReadiness({ platform: 'linux', family: 'debian', snapshot: snapshot({ tesseract: 'failed' }) });
    expect(report.state).toBe('missing');
    expect(report.detail).toContain('could not read a test picture');
    expect(report.remedy).toBe('sudo apt install tesseract-ocr poppler-utils');
  });

  test('pictures but no scanned PDFs is partial and names what is missing', () => {
    const report = describeOcrReadiness({
      platform: 'linux', family: 'fedora',
      snapshot: snapshot({ tesseract: 'ok', imageEngine: 'tesseract', pdftoppm: 'missing' }),
    });
    expect(report).toMatchObject({ state: 'partial', imageEngine: 'tesseract', remedy: 'sudo dnf install tesseract poppler-utils' });
    expect(report.detail).toContain('pdftoppm (poppler) is not installed');
  });

  test('a check that did not run is reported as missing, not as ready', () => {
    expect(describeOcrReadiness({ platform: 'linux', family: 'arch', snapshot: undefined }).state).toBe('missing');
  });
});

describe('checkOcrReadiness', () => {
  test('probes the machine and reads the distribution from os-release text', async () => {
    const report = await checkOcrReadiness({
      platform: 'linux', osRelease: OMARCHY, vision: false, probe: async () => snapshot({}),
    });
    expect(report).toMatchObject({ state: 'missing', remedy: 'sudo pacman -S --needed tesseract tesseract-data-eng poppler' });
  });

  test('Vision on a Mac is ready and no command is probed', async () => {
    let probed = false;
    const report = await checkOcrReadiness({
      platform: 'darwin', vision: true, probe: async () => { probed = true; return snapshot({}); },
    });
    expect(report.state).toBe('ready');
    expect(probed).toBe(false);
  });

  test('a probe that throws is missing, not a crash', async () => {
    const report = await checkOcrReadiness({
      platform: 'linux', osRelease: UBUNTU, vision: false, probe: async () => { throw new Error('boom'); },
    });
    expect(report).toMatchObject({ state: 'missing', remedy: 'sudo apt install tesseract-ocr poppler-utils' });
  });
});

describe('the worker\'s engine setting', () => {
  const PINNED = { OLYMPUS_FILE_EXTRACTION_OCR_ENGINE: 'tesseract' };

  test('pinned to tesseract on a Mac, Vision is not used, so a Mac is not reported ready on its strength', async () => {
    let probed = false;
    const report = await checkOcrReadiness({
      platform: 'darwin', env: PINNED,
      probe: async () => { probed = true; return snapshot({}); },
    });
    expect(probed).toBe(true);
    expect(report.state).toBe('missing');
    expect(report.detail).not.toContain('Apple Vision');
  });

  test('pinned with a working ocrmypdf: PDFs only, pictures are not read, and the remedy is the setting', async () => {
    const report = await checkOcrReadiness({
      platform: 'linux', osRelease: UBUNTU, env: PINNED, vision: false,
      probe: async () => snapshot({ tesseract: 'ok', pdftoppm: 'ok', ocrmypdf: 'ok', pdfEngine: 'ocrmypdf', imageEngine: 'tesseract' }),
    });
    expect(report).toMatchObject({ state: 'partial', pdfEngine: 'ocrmypdf' });
    expect(report.imageEngine).toBeUndefined();
    expect(report.remedy).toContain('OLYMPUS_FILE_EXTRACTION_OCR_ENGINE=auto');
  });

  test('pinned: pdftoppm and tesseract alone are not an engine, because the pinned worker never falls back to them', async () => {
    const report = await checkOcrReadiness({
      platform: 'linux', osRelease: OMARCHY, env: PINNED, vision: false,
      probe: async () => snapshot({ tesseract: 'ok', pdftoppm: 'ok', pdfEngine: 'pdftoppm_tesseract', imageEngine: 'tesseract' }),
    });
    expect(report.state).toBe('missing');
    expect(report.detail).toContain('ocrmypdf is not installed');
    // The install command would not fix it; changing the setting does.
    expect(report.remedy).toBe('Set OLYMPUS_FILE_EXTRACTION_OCR_ENGINE=auto (or remove it) for the worker.');
  });

  test('auto, unset or invalid values report as before', async () => {
    const working = snapshot({ tesseract: 'ok', pdftoppm: 'ok', pdfEngine: 'pdftoppm_tesseract', imageEngine: 'tesseract' });
    for (const env of [{}, { OLYMPUS_FILE_EXTRACTION_OCR_ENGINE: 'auto' }, { OLYMPUS_FILE_EXTRACTION_OCR_ENGINE: 'bogus' }]) {
      const report = await checkOcrReadiness({ platform: 'linux', osRelease: ARCH, env, vision: false, probe: async () => working });
      expect(report).toMatchObject({ state: 'ready', pdfEngine: 'pdftoppm + tesseract', imageEngine: 'tesseract' });
    }
  });

  test('describeOcrReadiness takes the preference directly', () => {
    expect(describeOcrReadiness({ platform: 'linux', family: 'arch', snapshot: undefined, preference: 'tesseract' }).state).toBe('missing');
  });
});

describe('setup finding', () => {
  test('optional, ok when ready, and the repair hint is the one command otherwise', () => {
    expect(ocrDependencyFinding({ state: 'ready', detail: 'read', pdfEngine: 'ocrmypdf', imageEngine: 'tesseract' }))
      .toMatchObject({ id: 'ocr', required: false, ok: true, repairHint: '' });
    expect(ocrDependencyFinding({ state: 'missing', detail: 'not read', remedy: 'sudo apt install tesseract-ocr poppler-utils' }))
      .toMatchObject({ id: 'ocr', required: false, ok: false, repairHint: 'sudo apt install tesseract-ocr poppler-utils' });
  });
});
