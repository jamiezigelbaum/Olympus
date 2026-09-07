import { DASHBOARD_THEME_CSS } from '../workers/dashboard/theme.ts';
import {
  BACKGROUND_CSS,
  DASHBOARD_LANE_CSS,
  DASHBOARD_NAV_CSS,
  DASHBOARD_POLICY_CSS,
  DASHBOARD_PROGRESS_CSS,
  DISPOSITIONS_CSS,
  SETUP_JOURNEY_CSS,
} from '../workers/dashboard/static-styles.ts';

/**
 * Static CSS shared with the standalone renderers. Shadow DOM contains every
 * broad selector; the two document roots are rewritten to the native host and
 * its local content wrapper so Olympus cannot restyle OpenClaw itself.
 */
function forShadowRoot(css: string): string {
  return css
    .replaceAll(':root', ':host')
    .replaceAll('body {', '.olympus-control-ui {');
}

export const OLYMPUS_CONTROL_UI_CSS = forShadowRoot([
  DASHBOARD_THEME_CSS,
  DASHBOARD_NAV_CSS,
  DASHBOARD_LANE_CSS,
  DASHBOARD_PROGRESS_CSS,
  DASHBOARD_POLICY_CSS,
  SETUP_JOURNEY_CSS,
  BACKGROUND_CSS,
  DISPOSITIONS_CSS,
].join('\n')) + `
:host { display: block; min-width: 0; color-scheme: dark; contain: content; }
.olympus-control-ui { min-height: 100%; }
.olympus-control-ui [data-write-capability-note] { margin: 0 auto 12px; max-width: 920px; }
.olympus-control-ui .native-state { max-width: 920px; margin: 24px auto; padding: 18px 20px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--t2); }
`;
