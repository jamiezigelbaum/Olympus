import { expect, test } from 'bun:test';
import type { AnalystModel } from '../src/core/analyst.ts';
import { createBuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { runInboxEval, type InboxSet } from '../eval/classification/inbox.ts';

// Semantic prompt quality requires the actual judge, never a scripted answer.
// PRIVACY_REGRESSION_REAL_TEST=1 PRIVACY_REGRESSION_MODEL_DIR=/tmp/model-cache
// Explicitly opt in to the pinned local 4B model; no configured cloud lane.
// PRIVACY_REGRESSION_SETS=chat-canary,owner-exemptions resumes just those sets.
const realTest = process.env.PRIVACY_REGRESSION_REAL_TEST === '1' ? test : test.skip;
const sets = ['inbox', 'chat-canary', 'owner-exemptions'] as const satisfies readonly InboxSet[];
const selected = process.env.PRIVACY_REGRESSION_SETS?.split(',');
if (selected?.some(set => !sets.includes(set as InboxSet))) throw new Error('Invalid privacy regression set');
for (const set of sets.filter(set => !selected || selected.includes(set))) {
  realTest(`#636: sharing clauses and record mentions (${set})`, async () => {
    const model = createBuiltInAnalystModel({ waitForInstall: true, env: { ...process.env, OLYMPUS_BUILT_IN_ANALYST_MODEL: 'standard', OLYMPUS_BUILT_IN_REASONING_DIR: process.env.PRIVACY_REGRESSION_MODEL_DIR } });
    try {
      await model.prepare();
      let calls = 0;
      const measured: AnalystModel = { async complete(request) {
        const response = await model.complete(request);
        if (++calls % 10 === 0) console.log(`Privacy regression eval (${set}): ${calls} local judgments completed`);
        return response;
      } };
      const report = await runInboxEval({ model: measured, modelId: `built_in/${model.spec.modelId}/${model.spec.file.sha256}`, set });
      console.log(JSON.stringify({ set, ...report }));
      const floor = { 'chat-canary': 75, 'owner-exemptions': 19, inbox: 48 }[set];
      expect(report.correct).toBeGreaterThanOrEqual(floor);
      if (report.results.some(row => row.expected === 'secure')) expect(report.privateRecall).toBe(1);
      expect(report.secretDispatches).toBe(0);
      if (set === 'chat-canary') {
        for (const id of ['wa-05', 'wa-08', 'wa-08-bare']) {
          expect(report.results.find(row => row.id === id)).toMatchObject({ actual: 'private' });
        }
      }
    } finally { await model.stop(); }
  }, 3_600_000);
}
