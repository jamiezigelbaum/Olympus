/**
 * The Olympus tab's own frame: the panel fills the tab, and a state line
 * (not connected, no read access) reads like OpenClaw's own. Everything the
 * panel shows is styled inside the panel (workers/dashboard/chatgpt/page.ts).
 * Shadow DOM contains every selector, so Olympus cannot restyle OpenClaw.
 */
export const OLYMPUS_CONTROL_UI_CSS = `
:host { display: block; height: 100%; }
.olympus-control-ui { height: 100%; min-height: 32rem; }
.olympus-panel { display: block; width: 100%; height: 100%; min-height: 32rem; border: 0; background: transparent; }
.native-state { padding: 1.5rem 1rem; font: inherit; color: inherit; opacity: 0.8; }
`;
