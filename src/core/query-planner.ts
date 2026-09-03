// Multi-query retrieval expansion (query planning).
//
// The held-out eval showed that retrieving with a single literal query misses
// evidence whose wording differs from the question (cross-document synthesis,
// second-value lookups). This planner asks the injected AnalystModel for up to
// 3 short, diverse search queries; the EvidencePack builder runs one retrieval
// lane per query and RRF-fuses the results.
//
// The prompt is GENERIC — one prompt for every question, no templates and no
// query regexes (the architecture guard's whole point). Parsing fails OPEN: on
// any model or parse failure the planner returns [], leaving retrieval on the
// literal query exactly as before.

import type { AnalystModel } from './analyst.ts';
import {
  recordSourceAnswerQueryPlanner,
  recordSourceAnswerQueryPlannerDisposition,
} from '../workers/source-index/answer-latency-trace.ts';

export type AnalystQueryPlanner = (question: string) => Promise<readonly string[]>;

const QUERY_PLANNER_SYSTEM =
  'Generate up to 3 short, diverse search queries for finding documents that answer this question. '
  + 'Return ONLY a JSON array of strings.';

const MAX_PLANNED_QUERIES = 3;

// Three short queries in a JSON array; bounds the local model's output.
const MAX_PLANNER_OUTPUT_CHARS = 400;

export function createAnalystQueryPlanner(model: AnalystModel): AnalystQueryPlanner {
  return async (question: string): Promise<readonly string[]> => {
    const startedAt = Date.now();
    let formulationCount = 0;
    try {
      const completion = await model.complete({
        system: QUERY_PLANNER_SYSTEM,
        prompt: question,
        // The planner runs BEFORE retrieval, so the evidence sensitivity is
        // unknown; treat the question as local-only so a localOnly-aware model
        // adapter can never route it to a cloud lane.
        localOnly: true,
        maxOutputChars: MAX_PLANNER_OUTPUT_CHARS,
      });
      const queries = parsePlannedQueries(completion.text);
      formulationCount = queries.length;
      return queries;
    } catch {
      // Fail OPEN, but leave a content-free mark: the consumer sees a normal
      // empty plan, so without this counter a broken planner lane is
      // indistinguishable from a planner that simply had nothing to add.
      recordSourceAnswerQueryPlannerDisposition('failed');
      return [];
    } finally {
      recordSourceAnswerQueryPlanner(Date.now() - startedAt, formulationCount);
    }
  };
}

function parsePlannedQueries(text: string): readonly string[] {
  const stripped = stripCodeFences(text);
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const queries: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const query = value.trim();
    if (!query || queries.includes(query)) continue;
    queries.push(query);
    if (queries.length >= MAX_PLANNED_QUERIES) break;
  }
  return queries;
}

function stripCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
}
