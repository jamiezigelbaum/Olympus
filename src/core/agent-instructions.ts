/**
 * What an agent outside OpenClaw is told about WHEN to ask Olympus.
 *
 * Connecting an agent gives it the tools; this text is what makes it use them
 * "in the background", without the owner naming Olympus in every question.
 * One text serves every vendor (owner ruling: no per-vendor policy): the
 * dashboard shows it for pasting into Claude project instructions or Grok's
 * custom instructions, and the packaged Agent Skills file
 * (`integrations/agent-skills/ask-olympus/SKILL.md`) carries it verbatim for
 * vendors that load skills. A test holds the two equal.
 *
 * It names only the remote tools (`olympus_search`, `source_answer`,
 * `source_answer_result`, `source_index_status`, `ask_anonymously`, which an
 * agent uses only when asked: it can cost money) and promises nothing the
 * privacy rules do not already enforce. Agents reaching `/mcp` from outside
 * get `olympus_search` (workers/remote-search.ts), and source_answer only
 * where an answer model runs on the computer; agents on the computer (stdio
 * MCP, the skill) have source_answer and no search. So the text names the
 * search conditionally and falls back to source_answer.
 */

export const AGENT_SKILL_NAME = 'ask-olympus';
export const AGENT_SKILL_PATH = 'integrations/agent-skills/ask-olympus/SKILL.md';

export const AGENT_SKILL_DESCRIPTION = 'Ask Olympus, the owner\'s private search over their own email, files, '
  + 'messages, notes and saved reading, whenever a question may be answered from their own records.';

export const AGENT_INSTRUCTION_TEXT = [
  'Olympus is my private search over my own email, files, messages, notes, bookmarks and saved reading.',
  '',
  'Use it whenever my question might be answered from my own records: what someone told me, '
    + 'what a document or contract says, or when something happened. '
    + 'If you are not sure, use it anyway. You do not need me to mention Olympus.',
  '',
  'If Olympus lists an olympus_search tool, search with it: it returns matching excerpts from my records for you to answer from. '
    + 'If the first search misses, try once more with different words.',
  '',
  'Otherwise ask its source_answer tool, one question at a time, and pass on its answer. '
    + 'Answers can take a few minutes. If it says it is still working and gives you a job_id, '
    + 'call source_answer_result with that job_id, again while it says working. Do not ask the same question again.',
  '',
  'Answer only from what Olympus returns, with its citations, and say plainly what it could not find. '
    + 'Do not guess past it or fill gaps from memory.',
  '',
  'Use source_index_status only to check which of my sources are ready.',
  '',
  'Use ask_anonymously only when I ask you to send a question anonymously.',
].join('\n');

/** The packaged SKILL.md, byte for byte. */
export function agentSkillMarkdown(): string {
  return [
    '---',
    `name: ${AGENT_SKILL_NAME}`,
    `description: ${AGENT_SKILL_DESCRIPTION}`,
    '---',
    '',
    '# Ask Olympus',
    '',
    AGENT_INSTRUCTION_TEXT,
    '',
  ].join('\n');
}
