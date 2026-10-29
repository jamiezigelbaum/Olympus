// Candidate descriptions for the photo judge (eval/photo-judge/scores.ts).
// The shipped set is a subset: its keys match MEDIA_JUDGE_PROMPTS
// (src/workers/source-index/media-judge.ts). The rest are tried here first.

import { MEDIA_JUDGE_PROMPTS } from '../../src/workers/source-index/media-judge.ts';

export const PHOTO_JUDGE_CANDIDATE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ...MEDIA_JUDGE_PROMPTS,
  // Sharper sensitive documents: named by what they say.
  medical_record: 'a medical report, prescription or lab test results with a patient\'s name and values',
  financial_record: 'a bank statement, payslip or tax form with account numbers and amounts',
  // Everyday pictures of writing, which are not sensitive.
  whiteboard: 'a whiteboard or flip chart with meeting notes or a plan',
  handwritten_notes: 'handwritten notes, a to-do list or a notebook page',
  screenshot: 'a screenshot of an app, a website or a chat conversation',
  slide: 'a presentation slide or a diagram',
  printed_page: 'a printed page of ordinary text, a letter, a flyer or an article',
  poster_menu: 'a poster, a sign or a restaurant menu',
  calendar: 'a calendar, a schedule or a timetable',
  receipt: 'a shop receipt, a ticket or a boarding pass',
  book: 'a book cover or a page from a book',
  chart: 'a chart, a graph or a map',
  code: 'a screenshot of computer code or a terminal',
  // Everyday photos, split.
  ordinary_people: 'a photo of people, family or friends',
  ordinary_place: 'a photo of a place, a building, a street or a landscape',
  ordinary_things: 'a photo of food, an object, a pet or a room',
};
