/**
 * A real first run of the ChatGPT folder picker: a Dropbox with dozens of
 * top-level folders of varied name length (numeric prefixes, long names),
 * sizes on some, nothing chosen yet, and one second-level folder of 30 items.
 * Used by test/chatgpt-picker-first-run.test.ts and the review screenshots.
 */
export interface FirstRunNode {
  key: string;
  name: string;
  kind: 'folder';
  has_children: boolean;
  selectable: boolean;
  size_bytes?: number;
  file_count?: number;
}

const TOP: Array<[string, number?, number?, boolean?]> = [
  ['0 Inbox', 1_200_000, 14],
  ['1 Projects', 48_300_000_000, 12_840],
  ['2 Areas', 9_700_000_000, 3_215],
  ['3 Resources', 112_000_000_000, 41_002],
  ['4 Archive', 386_000_000_000, 187_330],
  ['Apps'],
  ['Camera Uploads', 254_000_000_000, 61_870],
  ['Screenshots', 3_400_000_000, 2_911],
  ['Photos', 88_000_000_000, 22_405],
  ['Family Photos 1998–2012 (scanned from the shoebox in the attic)', 41_000_000_000, 9_870],
  ['Documents'],
  ['Desktop', 2_100_000_000, 744],
  ['Downloads', 17_500_000_000, 5_300],
  ['Music'],
  ['Public', 0, 0, false],
  ['Shared with Studio Partners — Contracts, NDAs and Invoices', 620_000_000, 418],
  ['Taxes'],
  ['Medical'],
  ['House — Renovation 2023'],
  ['Kids School'],
  ['Recipes', 74_000_000, 212],
  ['Travel'],
  ['Book Manuscript Drafts and Research Notes for the Second Edition', 1_300_000_000, 960],
  ['Clients'],
  ['Invoices', 210_000_000, 1_140],
  ['Receipts'],
  ['Talks and Slides', 6_800_000_000, 315],
  ['Teaching'],
  ['Thesis'],
  ['Old Laptop Backup (2016 MacBook Pro)', 212_000_000_000, 304_118],
  ['Video Projects'],
  ['Podcast'],
  ['Design Assets', 14_000_000_000, 8_402],
  ['Fonts'],
  ['Legal'],
  ['Insurance'],
  ['Car'],
  ['Garden'],
  ['Letters'],
  ['Journal'],
  ['Notes', 95_000_000, 2_040],
  ['Scans'],
  ['Wedding'],
  ['Website'],
  ['Z Misc'],
];

/** 45 top-level folders, nothing chosen. Every folder has children except the empty ones flagged false. */
export const FIRST_RUN_ROOT: FirstRunNode[] = TOP.map(([name, size, files, children], index) => {
  const node: FirstRunNode = { key: `fr-${index}`, name, kind: 'folder', has_children: children !== false, selectable: true };
  if (typeof size === 'number' && size > 0) node.size_bytes = size;
  if (typeof files === 'number' && files > 0) node.file_count = files;
  return node;
});

/** The key of "3 Resources", whose level lists 30 items. */
export const FIRST_RUN_RESOURCES_KEY = FIRST_RUN_ROOT.find((node) => node.name === '3 Resources')!.key;

const SECOND = [
  'Articles', 'Books', 'Cheat Sheets', 'Conference Notes 2019–2024', 'Courses', 'Datasets', 'Design Patterns',
  'Interview Prep', 'Japanese', 'Knowledge Base Exports from the Old Wiki', 'Maps', 'Meditation', 'Music Theory',
  'Newsletters', 'Papers', 'Philosophy', 'Photography', 'Podcasts Transcripts', 'Productivity', 'Programming',
  'Quotes', 'Reading List', 'Research', 'Science', 'Slides Templates', 'Stock Photos', 'Swipe File',
  'Typography', 'Woodworking Plans', 'Writing',
];

/** 30 folders inside 3 Resources; sizes on some. */
export const FIRST_RUN_RESOURCES: FirstRunNode[] = SECOND.map((name, index) => {
  const node: FirstRunNode = { key: `fr-r${index}`, name, kind: 'folder', has_children: index % 3 !== 2, selectable: true };
  if (index % 2 === 0) {
    node.size_bytes = (index + 1) * 137_000_000;
    node.file_count = (index + 1) * 53;
  }
  return node;
});
