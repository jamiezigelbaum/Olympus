// The extraction factory's HTTP surface, and the alias property the cutover
// depends on.
//
// Six supervisor lanes drive extraction over HTTP, not over sqlite. They must
// keep hitting exactly the handler they hit today while the factory ships dark,
// and then reach the factory on the SAME URLs once the legacy lane is unwired —
// with no route edit, no supervisor edit and no unit change. Both halves of
// that are asserted here, because only one of them is observable at a time in
// any given deployment.

import { describe, expect, test } from 'bun:test';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type { ExtractionLaneKey } from '../src/workers/file-extraction/job-store.ts';
import type {
  ExtractionPlanRequest,
  ExtractionPlanResult,
  ExtractionReclassificationResult,
  ExtractionReclassifyRequest,
  ExtractionRunRequest,
  ExtractionRunResult,
  FileExtractionRunner,
} from '../src/workers/file-extraction/runner.ts';

const BASE = 'http://worker.test/v1';
const CORPUS_ID = 'secure_local.dropbox.files';
const LANE_BODY = {
  provider: 'dropbox',
  account: 'personal',
  approved_scope_key: 'dropbox.personal:/1 Projects',
};

interface RunnerCalls {
  run: ExtractionRunRequest[];
  plan: ExtractionPlanRequest[];
  reclassify: ExtractionReclassifyRequest[];
  recycle: unknown[];
  janitor: unknown[];
  counts: ExtractionLaneKey[];
}

function runResult(corpusId: string): ExtractionRunResult {
  return {
    kind: 'file_extraction_run',
    corpusId,
    provider: 'dropbox',
    accountScope: 'personal',
    scopeKeyHash: 'a'.repeat(64),
    workerIdHash: 'b'.repeat(64),
    leasedJobs: 1,
    processedJobs: 1,
    abandonedLeases: 0,
    records: [{
      jobId: 'fx_1',
      status: 'indexed',
      extractorKind: 'local_text',
      extractorVersion: '2026-05-22',
      attempts: 1,
      chunksIndexed: 3,
    }],
    counts: {
      indexed: 1,
      metadata_only: 0,
      skipped_unsupported: 0,
      skipped_too_large: 0,
      blocked_policy: 0,
      failed_retryable: 0,
      failed_terminal: 0,
    },
    paused: false,
    consecutiveRetryableFailures: 0,
    policy: {
      workerPrivateSurface: true,
      rawSourceExposed: false,
      sourceTextReturned: false,
      fileBytesPersisted: false,
      tempBytesCleaned: true,
      localOnly: true,
      trustDomain: 'secure_local',
    },
  };
}

function planResult(corpusId: string): ExtractionPlanResult {
  return {
    kind: 'file_extraction_plan',
    corpusId,
    candidates: 2,
    jobsQueued: 2,
    jobsExisting: 0,
    jobsForced: 0,
    jobsSkippedTooLarge: 0,
    jobsUnroutable: 0,
    extractorKinds: ['local_text'],
    done: true,
    policy: {
      workerPrivateSurface: true,
      rawSourceExposed: false,
      sourceTextReturned: false,
      fileBytesDownloaded: false,
      localOnly: true,
      trustDomain: 'secure_local',
    },
  };
}

function reclassificationResult(corpusId: string): ExtractionReclassificationResult {
  return {
    kind: 'file_extraction_terminal_reclassification',
    corpusId,
    rules: [{
      fromExtractorKind: 'local_ocr_tesseract',
      lastErrorKind: 'ocrmypdf_pdf_signed',
      toExtractorKind: 'local_vlm_pdf',
      matchedJobs: 4,
      jobsEscalated: 4,
      skippedTargetExists: 0,
    }],
    jobsEscalated: 4,
    dryRun: false,
  };
}

function stubRunner(corpusIds: readonly string[] = [CORPUS_ID]): {
  runner: FileExtractionRunner;
  calls: RunnerCalls;
} {
  const calls: RunnerCalls = { run: [], plan: [], reclassify: [], recycle: [], janitor: [], counts: [] };
  const runner: FileExtractionRunner = {
    corpusIds: () => corpusIds,
    async run(request) {
      calls.run.push(request);
      return runResult(request.corpusId);
    },
    async plan(request) {
      calls.plan.push(request);
      return planResult(request.corpusId);
    },
    reclassifyTerminal(request) {
      calls.reclassify.push(request);
      return reclassificationResult(request.corpusId);
    },
    recycleLeases(request) {
      calls.recycle.push(request);
      return {
        extractorKindPrefix: request.extractorKindPrefix,
        matchedJobs: 2,
        jobsRequeued: 2,
        dryRun: false,
        staleOnly: false,
      };
    },
    janitorRequeue(request) {
      calls.janitor.push(request);
      return {
        mode: request.mode,
        matchedJobs: 1,
        jobsRequeued: 1,
        jobsEscalated: 0,
        skippedAttemptBudget: 0,
        skippedAlreadyJanitorRequeued: 0,
        skippedPolicyExcluded: 0,
        skippedEscalationBudget: 0,
        skippedTargetExists: 0,
        networkGuardOverrideUsed: false,
        dryRun: false,
        reason: request.reason,
      };
    },
    counts(lane) {
      calls.counts.push(lane);
      return [{ status: 'queued', extractorKind: 'local_text', jobs: 7 }];
    },
  };
  return { runner, calls };
}

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const GENERIC_ROUTES = [
  '/source/index/files/extract',
  '/source/index/files/plan',
  '/source/index/files/transcribe',
  '/source/index/files/recycle-leases',
  '/source/index/files/janitor-requeue',
  '/source/index/files/status',
];

describe('file-extraction routes: the generic surface', () => {
  for (const route of GENERIC_ROUTES) {
    test(`${route} refuses honestly when the factory is not configured`, async () => {
      const worker = createEmailSourceWorker({});
      const response = await worker.fetch(post(route, { corpus_id: CORPUS_ID, ...LANE_BODY }));
      expect(response.status).toBe(501);
      const body = await response.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe('file_extraction_not_supported');
    });
  }

  test('extract drives the runner and answers in the surface\'s own casing', async () => {
    const { runner, calls } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });

    const response = await worker.fetch(post('/source/index/files/extract', {
      corpus_id: CORPUS_ID,
      ...LANE_BODY,
      limit: 25,
      extractor_kind: 'local_text',
    }));

    expect(response.status).toBe(200);
    expect(calls.run[0]).toMatchObject({
      corpusId: CORPUS_ID,
      provider: 'dropbox',
      accountScope: 'personal',
      approvedScopeKey: 'dropbox.personal:/1 Projects',
      limit: 25,
      extractorKind: 'local_text',
    });
    const body = await response.json() as Record<string, unknown>;
    expect(body.corpus_id).toBe(CORPUS_ID);
    expect(body.leased_jobs).toBe(1);
    expect(body.paused).toBe(false);
    expect((body.records as Array<Record<string, unknown>>)[0]).toMatchObject({
      job_id: 'fx_1',
      status: 'indexed',
      extractor_kind: 'local_text',
      chunks_indexed: 3,
    });
    expect(body.policy).toMatchObject({ source_text_returned: false, local_only: true });
  });

  test('plan passes its bounds through', async () => {
    const { runner, calls } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });

    const response = await worker.fetch(post('/source/index/files/plan', {
      corpus_id: CORPUS_ID,
      ...LANE_BODY,
      limit: 50,
      mime_types: ['application/pdf'],
      policy_decision: 'needs_review',
      max_bytes_per_file: 1_000,
    }));

    expect(response.status).toBe(200);
    expect(calls.plan[0]).toMatchObject({
      limit: 50,
      mimeTypes: ['application/pdf'],
      policyDecision: 'needs_review',
      maxBytesPerFile: 1_000,
    });
    const body = await response.json() as Record<string, unknown>;
    expect(body.jobs_queued).toBe(2);
    expect(body.extractor_kinds).toEqual(['local_text']);
  });

  test('transcribe is the plan pass with the transcription lane pinned', async () => {
    const { runner, calls } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });

    const response = await worker.fetch(post('/source/index/files/transcribe', {
      corpus_id: CORPUS_ID,
      ...LANE_BODY,
    }));

    expect(response.status).toBe(200);
    expect(calls.plan[0]!.extractorKind).toBe('whisper_transcription');
  });

  test('janitor-requeue with no mode runs the reopening pass', async () => {
    // The default matters: a reopening that needs a separate timer and a
    // hand-written body is one that stops being run.
    const { runner, calls } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });

    const response = await worker.fetch(post('/source/index/files/janitor-requeue', {
      corpus_id: CORPUS_ID,
      ...LANE_BODY,
    }));

    expect(response.status).toBe(200);
    expect(calls.reclassify).toHaveLength(1);
    expect(calls.janitor).toEqual([]);
    const body = await response.json() as Record<string, unknown>;
    expect(body.jobs_escalated).toBe(4);
    expect((body.rules as Array<Record<string, unknown>>)[0]).toMatchObject({
      from_extractor_kind: 'local_ocr_tesseract',
      last_error_kind: 'ocrmypdf_pdf_signed',
      to_extractor_kind: 'local_vlm_pdf',
    });
  });

  test('janitor-requeue with an explicit error kind runs the ordinary pass', async () => {
    const { runner, calls } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });

    const response = await worker.fetch(post('/source/index/files/janitor-requeue', {
      corpus_id: CORPUS_ID,
      ...LANE_BODY,
      mode: 'terminal_reclassification',
      reason: 'operator sweep',
      extractor_kind: 'local_ocr_tesseract',
      last_error_kind: 'network_unreachable',
      allow_network_terminal_requeue_after_prior_janitor: true,
    }));

    expect(response.status).toBe(200);
    expect(calls.reclassify).toEqual([]);
    expect(calls.janitor[0]).toMatchObject({
      mode: 'terminal_reclassification',
      lastErrorKind: 'network_unreachable',
      allowNetworkTerminalRequeueAfterPriorJanitor: true,
    });
  });

  test('recycle-leases requires the kind prefix it recycles by', async () => {
    const { runner } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });

    const missing = await worker.fetch(post('/source/index/files/recycle-leases', {
      corpus_id: CORPUS_ID,
      ...LANE_BODY,
    }));
    expect(missing.status).toBe(400);

    const supplied = await worker.fetch(post('/source/index/files/recycle-leases', {
      corpus_id: CORPUS_ID,
      ...LANE_BODY,
      extractor_kind_prefix: 'local_vlm',
    }));
    expect(supplied.status).toBe(200);
    const body = await supplied.json() as Record<string, unknown>;
    expect(body.extractor_kind_prefix).toBe('local_vlm');
  });

  test('status reports the queue by kind', async () => {
    const { runner } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });

    const response = await worker.fetch(post('/source/index/files/status', {
      corpus_id: CORPUS_ID,
      ...LANE_BODY,
    }));

    const body = await response.json() as Record<string, unknown>;
    expect(body.counts).toEqual([{ status: 'queued', extractor_kind: 'local_text', jobs: 7 }]);
  });

  test('a corpus the factory does not serve is refused rather than dispatched', async () => {
    const { runner, calls } = stubRunner(['internal.drive.docs']);
    const worker = createEmailSourceWorker({ fileExtraction: runner });

    const response = await worker.fetch(post('/source/index/files/extract', {
      corpus_id: CORPUS_ID,
      ...LANE_BODY,
    }));

    expect(response.status).toBe(400);
    expect(calls.run).toEqual([]);
  });

  test('the lane key is required in full, because a partial lane is a wrong lane', async () => {
    const { runner } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });
    for (const omitted of ['provider', 'account', 'approved_scope_key']) {
      const body: Record<string, unknown> = { corpus_id: CORPUS_ID, ...LANE_BODY };
      delete body[omitted];
      const response = await worker.fetch(post('/source/index/files/extract', body));
      expect(response.status).toBe(400);
    }
  });
});

describe('file-extraction routes: the family-scoped paths are aliases', () => {
  const ALIAS_PAIRS: ReadonlyArray<{ alias: string; generic: string }> = [
    { alias: '/source/index/dropbox/content/extract', generic: '/source/index/files/extract' },
    { alias: '/source/index/dropbox/content/plan', generic: '/source/index/files/plan' },
    { alias: '/source/index/dropbox/content/recycle-leases', generic: '/source/index/files/recycle-leases' },
    { alias: '/source/index/dropbox/content/janitor-requeue', generic: '/source/index/files/janitor-requeue' },
    { alias: '/source/index/dropbox/transcribe', generic: '/source/index/files/transcribe' },
  ];

  test('every alias reaches the factory with the corpus id injected', async () => {
    // The caller never names a corpus. That is the whole of what the generic
    // route needs and the family-scoped one never carried.
    const { runner, calls } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });

    const extract = await worker.fetch(post('/source/index/dropbox/content/extract', { ...LANE_BODY }));
    expect(extract.status).toBe(200);
    expect(calls.run[0]!.corpusId).toBe(CORPUS_ID);

    const plan = await worker.fetch(post('/source/index/dropbox/content/plan', { ...LANE_BODY }));
    expect(plan.status).toBe(200);
    expect(calls.plan[0]!.corpusId).toBe(CORPUS_ID);
  });

  test('an alias serves the body the fleet actually sends, which names no provider', async () => {
    // The supervisor units post corpus_id-free AND provider-free bodies today,
    // because the family-scoped route never needed either. "No supervisor edit,
    // no unit change" is only true if those exact bodies still reach the
    // factory, so this posts the real shape rather than a lane-key fixture.
    const supervisorBody = {
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/1 Projects',
    };
    const { runner, calls } = stubRunner();
    const worker = createEmailSourceWorker({ fileExtraction: runner });
    const expectedLane = {
      corpusId: CORPUS_ID,
      provider: 'dropbox',
      accountScope: 'personal',
      approvedScopeKey: 'dropbox.personal:/1 Projects',
    };

    const extract = await worker.fetch(post('/source/index/dropbox/content/extract', {
      ...supervisorBody,
      extractor_kind: 'local_text',
      extractor_version: '2026-05-22',
      limit: 10,
    }));
    expect(extract.status).toBe(200);
    expect(calls.run[0]).toMatchObject(expectedLane);

    const plan = await worker.fetch(post('/source/index/dropbox/content/plan', {
      ...supervisorBody,
      limit: 50,
    }));
    expect(plan.status).toBe(200);
    expect(calls.plan[0]).toMatchObject(expectedLane);

    const transcribe = await worker.fetch(post('/source/index/dropbox/transcribe', supervisorBody));
    expect(transcribe.status).toBe(200);
    expect(calls.plan[1]).toMatchObject(expectedLane);

    const recycle = await worker.fetch(post('/source/index/dropbox/content/recycle-leases', {
      ...supervisorBody,
      extractor_kind_prefix: 'local_',
    }));
    expect(recycle.status).toBe(200);
    expect(calls.recycle[0]).toMatchObject(expectedLane);

    const janitor = await worker.fetch(post('/source/index/dropbox/content/janitor-requeue', supervisorBody));
    expect(janitor.status).toBe(200);
    expect(calls.reclassify[0]).toMatchObject(expectedLane);
  });

  test('an alias and its generic twin produce the same outcome', async () => {
    for (const pair of ALIAS_PAIRS) {
      const body = {
        ...LANE_BODY,
        ...(pair.generic.endsWith('recycle-leases') ? { extractor_kind_prefix: 'local_' } : {}),
      };
      const viaAlias = await createEmailSourceWorker({ fileExtraction: stubRunner().runner })
        .fetch(post(pair.alias, body));
      const viaGeneric = await createEmailSourceWorker({ fileExtraction: stubRunner().runner })
        .fetch(post(pair.generic, { corpus_id: CORPUS_ID, ...body }));

      expect(viaAlias.status).toBe(viaGeneric.status);
      expect(await viaAlias.json()).toEqual(await viaGeneric.json());
    }
  });

  test('with no factory configured the retired family aliases are absent', async () => {
    const worker = createEmailSourceWorker({});
    for (const pair of ALIAS_PAIRS) {
      const response = await worker.fetch(post(pair.alias, { ...LANE_BODY }));
      expect(response.status).toBe(404);
    }
  });
});
