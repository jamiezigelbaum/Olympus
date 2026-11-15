// Checks the answer meaning judge (answer-judge.ts) against the strict word
// rule on fictional test data only: the demo Private set (Robin Vale,
// chatgpt-plugin/demo-data). Each answerable question is answered by the
// local Analyst from three packs (every item, the expected items removed,
// the expected items only), so the answers include right and wrong ones, and
// each is judged. Prints the question, expected values, answer and both
// verdicts, because all of it is made up, for checking every verdict by eye.
//   bun eval/answer-judge-check.ts [--out <file.jsonl>]
// Uses the eval's local Analyst profile (the already-loaded model on its live
// route) for both answering and judging.
import { writeFileSync } from 'node:fs';
import { createAnalyst, withPromptBudget } from '../src/core/analyst.ts';
import { createDelphiAnalystModel } from '../src/core/analyst-delphi.ts';
import { loadConfig, parseModelProfile } from '../src/core/config.ts';
import { DelphiClient } from '../src/core/delphi.ts';
import { DEFAULT_LOCAL_ANALYST_PROMPT_BYTES } from '../src/workers/source-index/analyst-answer.ts';
import { answerMeaningJudge } from './answer-judge.ts';
import { DEMO_PRIVATE_CORPUS, DEMO_PRIVATE_QUESTIONS, demoPrivatePack, loadDemoPrivateEvidence } from './fixtures/demo-private-questions.ts';
import { gradeAnswer } from './grade.ts';
import { localEvalModel } from './local-model.ts';

async function main(): Promise<void> {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
  const config = loadConfig();
  const profile = parseModelProfile(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE ?? 'source_answer');
  const analyst = createAnalyst(createDelphiAnalystModel(new DelphiClient(config), { profile }), { evidenceFormat: 'compact' });
  const judge = answerMeaningJudge(localEvalModel(config));
  const evidence = loadDemoPrivateEvidence();
  const lines: string[] = [];
  const tally = { answers: 0, strictRight: 0, meaningCorrect: 0, agree: 0, unreadable: 0 };
  for (const question of DEMO_PRIVATE_QUESTIONS.filter(q => q.shape !== 'coverage_negative')) {
    const expectedIds = new Set((question.expectedEvidence ?? []).map(item => item.providerItemId));
    const packs = {
      all: evidence,
      without_expected: evidence.filter(item => !expectedIds.has(item.id)),
      expected_only: evidence.filter(item => expectedIds.has(item.id)),
    };
    for (const [condition, items] of Object.entries(packs)) {
      let answer = ''; let strict = false; let error: string | undefined;
      try {
        const result = await analyst.analyze(withPromptBudget(demoPrivatePack(question.question, items), DEFAULT_LOCAL_ANALYST_PROMPT_BYTES), { localOnly: true });
        answer = result.answer;
        strict = gradeAnswer(question, result, undefined, { citationCorpusIds: result.citations.map(() => DEMO_PRIVATE_CORPUS) }).answerCorrect;
      } catch (caught) { error = caught instanceof Error ? caught.name : 'Error'; }
      const expected = (question.expectedAnswerContains ?? []).join('; ');
      const meaning = error ? null : await judge(question.question, expected, answer);
      tally.answers += 1;
      if (strict) tally.strictRight += 1;
      if (meaning === 'correct') tally.meaningCorrect += 1;
      if (meaning === null) tally.unreadable += 1;
      if (meaning !== null && (meaning === 'correct') === strict) tally.agree += 1;
      const line = JSON.stringify({ id: question.id, condition, question: question.question, expected, answer, strict, meaning, ...(error ? { error } : {}) });
      lines.push(line);
      console.log(line);
    }
  }
  console.log(JSON.stringify({ summary: tally }));
  if (out) writeFileSync(out, `${lines.join('\n')}\n${JSON.stringify({ summary: tally })}\n`);
}

await main();
