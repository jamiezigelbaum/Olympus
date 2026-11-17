/** Process-local holder sizes. Writers update at mutation sites; readers never walk or query. */
const counts = {
  connector_stores: 0,
  tier_visibility_items: 0,
  hidden_child_items: 0,
  embedding_queue: 0,
  people: 0,
  identities: 0,
  tasks_embed: 0,
  tasks_sync: 0,
  tasks_extract: 0,
  tasks_watch: 0,
};
export type MemoryCounter = keyof typeof counts;
export function changeMemoryCounter(key: MemoryCounter, delta: number): void { counts[key] += delta; }
export function memoryHolderCounts() {
  const { tasks_embed, tasks_sync, tasks_extract, tasks_watch, ...holders } = counts;
  return holders;
}
export type MemoryActivity = 'judging' | 'embedding' | 'recount' | 'import' | 'extract' | 'idle';
export function memoryActivity(judging: boolean, recount: boolean): MemoryActivity {
  if (judging) return 'judging';
  if (counts.tasks_embed > 0) return 'embedding';
  if (recount) return 'recount';
  if (counts.tasks_sync > 0 || counts.tasks_watch > 0) return 'import';
  if (counts.tasks_extract > 0) return 'extract';
  return 'idle';
}
