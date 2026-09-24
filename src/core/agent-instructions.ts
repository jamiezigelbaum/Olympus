/**
 * What an agent outside OpenClaw is told about WHEN to ask Olympus.
 *
 * Connecting an agent gives it the tools; this text is what makes it use them
 * "in the background", without the owner naming Olympus in every question.
 * One text serves every vendor (owner ruling: no per-vendor policy): the
 * dashboard shows it for pasting into Claude project instructions, Grok Bot
 * skills or Muse instructions, and the packaged Agent Skills file
 * (`integrations/agent-skills/ask-olympus/SKILL.md`) carries it verbatim for
 * vendors that load skills. A test holds the two equal.
 *
 * It names only the remote tool list (`source_answer`, `source_index_status`)
 * and promises nothing the privacy rules do not already enforce.
 */

export const AGENT_SKILL_NAME = 'ask-olympus';
export const AGENT_SKILL_PATH = 'integrations/agent-skills/ask-olympus/SKILL.md';

export const AGENT_SKILL_DESCRIPTION = 'Ask Olympus, the owner\'s private search over their own email, files, '
  + 'messages, notes and saved reading, whenever a question may be answered from their own records.';

export const AGENT_INSTRUCTION_TEXT = [
  'Olympus is my private search over my own email, files, messages, notes, bookmarks and saved reading. '
    + 'You can ask it through its source_answer tool.',
  '',
  'Ask Olympus whenever my question might be answered from my own records: what someone told me, '
    + 'what a document or contract says, or when something happened. '
    + 'If you are not sure, ask it anyway. You do not need me to mention Olympus.',
  '',
  'Ask one question at a time, in plain words, and wait for each answer before asking the next. '
    + 'Answers can take a minute.',
  '',
  'Pass on what Olympus answers with its citations, and say plainly what it could not find. '
    + 'Do not guess past it or fill gaps from memory.',
  '',
  'Use source_index_status only to check which of my sources are ready.',
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
