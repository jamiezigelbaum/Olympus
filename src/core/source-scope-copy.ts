/** The owner-facing prompt and action for a connected source awaiting scope. */
export const SOURCE_SCOPE_CHOICE_COPY = {
  mail: { reason: 'choose which mail to include', label: 'Choose mail' },
  folders: { reason: 'choose which folders to include', label: 'Choose folders' },
} as const;
