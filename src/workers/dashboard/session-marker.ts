import { createHash } from 'node:crypto';

// The dashboard poll compares this marker with the page's to tell a new
// control session from the one the page was rendered with. One function owns
// the formula: the page reads it from the server (rendered page or the local
// unlock response) and never recomputes it (#728).
export function dashboardSessionMarker(csrfToken: string): string {
  return createHash('sha256').update('olympus-dashboard-session-marker\0').update(csrfToken).digest('hex').slice(0, 24);
}
