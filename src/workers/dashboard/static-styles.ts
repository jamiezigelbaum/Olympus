/** Browser-safe static styles shared by standalone and native dashboard surfaces. */
export const DASHBOARD_LANE_CSS = `.bgrow { position: relative; display: block; background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 10px 14px; color: inherit; text-decoration: none; }
.bgrow .bgl { display: grid; grid-template-columns: 110px 1fr 64px; gap: 12px; align-items: center; padding: 3px 0; }
.bgrow .nm { font-weight: 500; font-size: 13px; color: var(--t2); }
.bgrow .fx { color: var(--t3); font-size: 12px; }
.bgrow .go { position: absolute; right: 14px; top: 10px; color: var(--t4); font-size: 13px; }
.bgrow:hover .go, .bgrow:focus-visible .go { color: var(--link); }
.bgrow:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
.minibar { display: block; width: 64px; height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; justify-self: end; }
.minibar i { display: block; height: 100%; background: var(--t3); }
.lanerow { display: grid; grid-template-columns: 110px 64px 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.lanerow .nm { font-weight: 500; font-size: 13px; color: var(--t2); }
.lanerow .st { color: var(--t3); font-size: 12px; }
.lanerow .minibar { justify-self: start; }
.lanestrip { display: flex; gap: 2px; }
.lanestrip i { display: block; width: 7px; height: 20px; border-radius: 2px; }
.disp { font-family: system-ui, sans-serif; font-size: 11px; letter-spacing: .04em; }
.disp.heal { color: var(--good); }
.disp.attn { color: var(--warn); }
@media (max-width: 700px) {
  .lanerow { grid-template-columns: 110px 1fr; }
  .lanerow .minibar, .lanerow .lanestrip { display: none; }
  /* The go arrow is absolutely positioned at the right edge, so the facts
     column keeps clear of it rather than running underneath. */
  .bgrow .bgl { grid-template-columns: 1fr auto; padding-right: 18px; }
}
`;

export const DASHBOARD_PROGRESS_CSS = `.phase { margin: 0 0 14px; max-width: 520px; }
.phase .ph { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.phase .pn { font-size: 12.5px; font-weight: 600; color: var(--t2); }
.phase .pv { font-size: 12px; color: var(--t3); font-variant-numeric: tabular-nums; text-align: right; }
.phase .bar { max-width: none; margin-top: 6px; height: 5px; border-radius: 3px; }
.phase .pv .st { display: inline-block; margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--line2); font-weight: 600; color: var(--t2); }
.phase.done .pv .st { color: var(--good); }
.phase.working .pv .st { color: var(--run); }
.phase.stalled .pv .st { color: var(--warn); }
.phase.waiting .pv .st { color: var(--t4); }
.phase.waiting .bar { background: var(--line2); }
.phase.waiting .bar i { display: none; }
.bar.indet.working { position: relative; }
.bar.indet.working i { width: 34%; background: var(--run); animation: dashsweep 1.6s ease-in-out infinite; }
@keyframes dashsweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(294%); } }
.settled { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; color: var(--t2); font-size: 13px; max-width: 520px; }
.banner { margin-bottom: 6px; }
.advanced { border-top: 1px solid var(--line); margin-top: 28px; padding-top: 4px; }
.advanced > summary { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--t4); cursor: pointer; padding: 12px 0; list-style: none; }
.advanced > summary::-webkit-details-marker { display: none; }
.advanced > summary::before { content: '\\25B8 '; display: inline-block; transition: transform .12s ease; }
.advanced[open] > summary::before { transform: rotate(90deg); }
.advanced > summary:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  .bar.indet.working i { animation: none; width: 100%; background: var(--line2); }
}
`;

export const DASHBOARD_POLICY_CSS = `.catrow { display: grid; grid-template-columns: 140px 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.catrow .name { font-weight: 600; color: var(--t2); }
.catrow .what { color: var(--t4); font-size: 12px; }
.catrow .tier { color: var(--t3); font-size: 12px; font-variant-numeric: tabular-nums; }
.scoperow { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 10px 14px; margin-bottom: 6px; }
.scoperow .rid { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--t2); }
.scoperow .what { color: var(--t3); font-size: 12.5px; }
.sect.gap { margin-top: 44px; }
.quiet { color: var(--t4); font-size: 12px; margin: -2px 0 10px; max-width: 66ch; }
.quiet.after { margin: 8px 0 0; }
.tiersnote { color: var(--t3); font-size: 12.5px; margin: 0 0 12px; max-width: 66ch; }
.tiernote { font-size: 12.5px; margin-top: 10px; }
.pm { color: var(--t4); }
.pm.yes { color: var(--good); }
.tname { color: var(--t1); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: var(--panel); border: 1px solid var(--line2); border-radius: 999px; padding: 3px 11px; color: var(--t3); font-size: 12px; }
.chip b { color: var(--t2); font-weight: 600; font-variant-numeric: tabular-nums; }
.vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (max-width: 700px) {
  .catrow { grid-template-columns: 1fr; gap: 4px; }
}
`;

export const DASHBOARD_NAV_CSS = `.top { position: sticky; top: 0; z-index: 12; background: var(--bg); padding-top: 2px; }
.dnav { position: sticky; top: 39px; z-index: 11; display: flex; gap: 4px; margin: -8px 0 22px; border-bottom: 1px solid var(--line2); background: var(--bg); }
.dnav .dnavlink { color: var(--t3); text-decoration: none; font-size: 12.5px; padding: 6px 12px 8px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dnav .dnavlink:hover { color: var(--link); }
.dnav .dnavlink:focus-visible { outline: 1px solid var(--link); outline-offset: -2px; border-radius: 4px; }
.dnav .dnavlink.on { color: var(--t1); border-bottom-color: var(--link-line); }
`;

export const SETUP_JOURNEY_CSS = `.setupsummary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 18px; }
.setupsummary .sumcard { min-width: 0; border: 1px solid var(--line2); border-radius: 8px; padding: 11px 12px; background: var(--panel); }
.setupsummary b { display: block; color: var(--t4); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 4px; }
.setupsummary span { display: block; color: var(--t2); font-size: 13px; line-height: 1.3; }
.pilotnote { border: 1px solid var(--warn-line); background: var(--warn-bg); border-radius: 8px; color: var(--t3); font-size: 12px; padding: 10px 12px; margin-bottom: 18px; }
.pilotnote b { color: var(--warn); }
@media (max-width: 700px) { .setupsummary { grid-template-columns: 1fr; } }`;

export const BACKGROUND_CSS = `.lane { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.lane .lanehd { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.lane .lnm { font-weight: 600; font-size: 13.5px; color: var(--t2); }
.lane .lstate { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
.lane .lfacts { color: var(--t2); font-size: 12.5px; margin-top: 5px; font-variant-numeric: tabular-nums; }
.lane .lmove { color: var(--t3); font-size: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; }
.lane .lreason { color: var(--warn); font-size: 12px; margin-top: 5px; max-width: 74ch; }
.lane .lreason.stuck { color: var(--bad); }
.lane .lreason.unknown { color: var(--t3); }
.lane .lbar { margin-top: 8px; }
.lane .lbar .minibar { width: 100%; max-width: 340px; }
.lane .lanestrip { margin-top: 8px; }
.lane .lqueue { margin-top: 8px; border-top: 1px solid var(--line2); padding-top: 7px; }
.lane .lq { color: var(--t3); font-size: 12px; line-height: 1.55; }
.lane .lq b { color: var(--t2); font-weight: 600; font-variant-numeric: tabular-nums; }
.lane.quiet { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 9px 14px; }
.lane.quiet .lquiet { color: var(--t4); font-size: 12px; }
.info { color: var(--t3); font-size: 12.5px; line-height: 1.6; max-width: 74ch; }
.infolink { margin-top: 8px; font-size: 12.5px; }
.embblock { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin: -3px 0 7px; }
.embblock .embstate { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
.embblock .embline { color: var(--t3); font-size: 12px; line-height: 1.5; margin-bottom: 4px; }
.embblock .embline.warn { color: var(--warn); }
.embblock .rowform { margin: 8px 0 6px; }
@media (max-width: 700px) {
  .lane .lanehd { flex-wrap: wrap; }
}
`;

export const DISPOSITIONS_CSS = `
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #1c2523;
        background: #f6f7f5;
        --accent: #2f7d67;
        --accent-strong: #276a57;
        --accent-soft: #e7f0ec;
        --warn: #9a6b1f;
        --warn-soft: #f7efdd;
        --danger: #b04a38;
        --border: #e0e5e1;
        --muted: #4d5955;
        --faint: #616e69;
        --card: #ffffff;
        --radius-card: 10px;
        --radius-control: 8px;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-size: 14px; line-height: 1.55; }
      main { max-width: 880px; margin: 0 auto; padding: 40px 24px 72px; }
      header { margin-bottom: 24px; display: grid; gap: 8px; }
      h1 { font-size: 24px; line-height: 1.15; margin: 0; letter-spacing: -0.01em; }
      h2 { font-size: 16px; font-weight: 600; margin: 0; }
      h3 { font-size: 14px; font-weight: 600; margin: 0; }
      p { margin: 0; color: var(--muted); max-width: 72ch; }
      .eyebrow { color: var(--faint); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
      .subtle { color: var(--muted); font-size: 13px; }
      code { background: #f0f3f1; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }

      .warn-note { background: var(--warn-soft); border: 1px solid #e2c888; border-radius: var(--radius-card); padding: 11px 14px; color: #6f551f; font-size: 13px; }
      .warn-note strong { color: #59410f; }

      .auth { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-card); padding: 14px 16px; display: grid; gap: 6px; margin-bottom: 16px; }
      .auth-status { font-size: 13px; }
      .auth-status.authorized { color: var(--accent); font-weight: 500; }

      .source-dispositions { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-card); padding: 18px 20px; display: grid; gap: 12px; margin-bottom: 16px; }
      .source-head { display: grid; gap: 3px; }

      .tree { display: grid; gap: 2px; }
      .node { border-top: 1px solid var(--border); padding: 8px 0 8px 0; }
      .node > .children { margin-left: 18px; border-left: 1px solid var(--border); padding-left: 12px; }
      .node-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; cursor: default; }
      /* A flex summary drops the native disclosure triangle in every engine, so
         the affordance is drawn here. Without it a folder with children looks
         exactly like one without, and the whole tree reads as flat. */
      details.node > summary.node-head { cursor: pointer; list-style: none; }
      details.node > summary.node-head::-webkit-details-marker { display: none; }
      details.node > summary.node-head::before { content: "\\25B8"; color: var(--faint); font-size: 11px; width: 10px; }
      details.node[open] > summary.node-head::before { content: "\\25BE"; }
      .node.leaf > .node-head::before { content: ""; width: 10px; }
      .node-name { font-weight: 500; }
      .node-counts { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }

      /* Explicit and inherited are the distinction this page exists to draw, so
         they are separated by fill, weight and a note — never by colour alone,
         which a reader with low colour vision would not see at all. */
      .chip { display: inline-flex; align-items: baseline; gap: 5px; border-radius: 999px; font-size: 12px; padding: 1px 9px; border: 1px solid var(--border); }
      .chip-note { font-size: 11px; opacity: 0.85; }
      .chip.explicit { font-weight: 600; }
      .chip.explicit.exclude { background: #f6e2de; border-color: #dcb0a6; color: #7d2f20; }
      .chip.explicit.metadata_only { background: var(--warn-soft); border-color: #d9c9a3; color: #6f551f; }
      .chip.explicit.ingest { background: var(--accent-soft); border-color: #b6d3c8; color: var(--accent-strong); }
      .chip.inherited { background: transparent; border-style: dashed; color: var(--faint); font-weight: 400; }
      .chip.default { background: transparent; color: var(--faint); }
      .mixed { font-size: 11.5px; color: var(--warn); border: 1px dotted #d9c9a3; border-radius: 999px; padding: 0 8px; }

      .control { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0 0 0; font-size: 13px; }
      .control label { display: inline-flex; gap: 5px; align-items: center; color: var(--muted); }
      .control label.locked { opacity: 0.5; }
      .control-locked { font-size: 12.5px; color: var(--faint); margin: 6px 0 0; max-width: 70ch; }

      .media-rules { background: #fbfcfb; border: 1px solid var(--border); border-radius: var(--radius-card); padding: 14px 16px; display: grid; gap: 6px; }
      .media-rules ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
      .media-rules li { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
      .rule-criterion { font-size: 12.5px; color: #2a3733; }

      .cleanup { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-card); padding: 18px 20px; display: grid; gap: 10px; margin-bottom: 16px; }
      .copy-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
      label { display: grid; gap: 5px; color: var(--muted); font-size: 13px; }
      input[readonly] { background: #f6f8f6; color: #2a3733; }
      input { border: 1px solid #ccd5d1; border-radius: var(--radius-control); padding: 7px 10px; font: inherit; font-size: 13.5px; min-width: 0; }
      button { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: var(--radius-control); padding: 7px 14px; font: inherit; font-size: 13.5px; font-weight: 500; cursor: pointer; justify-self: start; }
      button.secondary { background: transparent; color: var(--accent); }
      button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      form { display: grid; gap: 10px; }
      .action-message { color: var(--muted); font-size: 13px; min-height: 18px; }

      @media (max-width: 720px) {
        main { padding: 28px 16px 48px; }
        .node > .children { margin-left: 8px; padding-left: 8px; }
      }

      /* Finder-style Olympus picker. These rules intentionally override the
         retired light form above while the underlying save contract remains
         unchanged. */
      :root {
        color-scheme: dark;
        color: var(--t1);
        background: #0B0B0E;
        --accent: var(--link);
        --accent-strong: var(--link);
        --accent-soft: var(--panel2);
        --border: var(--line);
        --muted: var(--t3);
        --faint: var(--t4);
        --card: var(--bg);
      }
      body { background: #0B0B0E; color: var(--t1); }
      .picker-page { max-width: 1180px; margin: 0 auto; padding: 28px 24px 72px; }
      .picker-header { margin: 0 0 18px; display: grid; gap: 5px; }
      .picker-header h1 { color: var(--t1); font-size: 22px; }
      .picker-header p { color: var(--t3); }
      .picker-header strong { color: var(--t2); }
      .source-dispositions { padding: 0; margin: 0 0 14px; border: 0; background: transparent; display: block; }
      .finder-window { min-height: 590px; display: grid; grid-template-columns: 180px minmax(420px, 1fr) 270px; grid-template-rows: 1fr auto; overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); box-shadow: 0 12px 38px rgba(0,0,0,.34); }
      .finder-sidebar { grid-column: 1; grid-row: 1; padding: 15px 10px; background: rgba(255,255,255,.025); border-right: 1px solid var(--line2); }
      .sidebar-label { padding: 0 9px 8px; color: var(--t4); font-size: 10px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
      .location { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 6px; color: var(--t2); font-size: 12.5px; }
      .location.selected { background: var(--panel2); color: var(--t1); }
      .location .folder-icon { color: var(--link); font-size: 10px; }
      .finder-browser { grid-column: 2; grid-row: 1; min-width: 0; border-right: 1px solid var(--line2); }
      .finder-toolbar { min-height: 68px; display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 12px 16px; border-bottom: 1px solid var(--line2); }
      .finder-toolbar h2 { color: var(--t1); font-size: 15px; }
      .finder-toolbar p { color: var(--t4); font-size: 11.5px; margin-top: 2px; }
      .finder-toolbar input { width: 180px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--t1); font-size: 12px; }
      .finder-columns { display: grid; grid-template-columns: minmax(180px, 1fr) 64px 128px; gap: 10px; padding: 6px 14px 6px 36px; border-bottom: 1px solid var(--line2); color: var(--t4); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; }
      .tree { height: 468px; overflow: auto; display: block; padding: 6px; }
      /* Under the tree, not inside it: these count folders and items the tree
         does not list, so a reader who scrolls to the bottom of the tree has
         not seen them. */
      .tree-notes { padding: 8px 14px 10px; border-top: 1px solid var(--line2); display: grid; gap: 4px; }
      .tree-notes .subtle { color: var(--t4); font-size: 11.5px; }
      .node { border: 0; padding: 0; }
      .node > .children { margin-left: 18px; padding-left: 0; border-left: 1px solid var(--line2); }
      details.node > summary.folder-row { list-style: none; }
      details.node > summary.folder-row::-webkit-details-marker { display: none; }
      details.node > summary.folder-row::before { content: "\\25B8"; width: 12px; color: var(--t4); font-size: 10px; }
      details.node[open] > summary.folder-row::before { content: "\\25BE"; }
      .folder-row { min-height: 31px; display: grid; grid-template-columns: 12px 15px minmax(150px, 1fr) 64px 128px; gap: 7px; align-items: center; padding: 4px 8px; border-radius: 6px; cursor: default; color: var(--t2); }
      .folder-row:hover { background: rgba(255,255,255,.035); }
      .folder-row.selected { background: var(--link-line); color: var(--t1); }
      .folder-row:focus-visible { outline: 1px solid var(--link); outline-offset: -1px; }
      .node.leaf .folder-row .disclosure { width: 12px; }
      .folder-icon { color: var(--link); font-size: 11px; }
      .node-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
      .node-counts, .node-state { color: var(--t3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
      .folder-row.selected .node-counts, .folder-row.selected .node-state { color: var(--t1); }
      .stored-controls { display: none; }
      .finder-inspector { grid-column: 3; grid-row: 1; padding: 22px 18px; background: rgba(255,255,255,.015); }
      .finder-inspector [data-inspector-empty] { padding-top: 120px; text-align: center; color: var(--t4); }
      .inspector-folder { color: var(--link); font-size: 30px; margin-bottom: 10px; }
      .finder-inspector h3 { color: var(--t1); font-size: 15px; margin-bottom: 4px; }
      .inspector-path { color: var(--t4); font-size: 11px; overflow-wrap: anywhere; }
      .inspector-count { color: var(--t3); font-size: 12px; margin: 9px 0 18px; }
      .choice-stack { display: grid; gap: 7px; }
      .choice-stack button { width: 100%; display: grid; gap: 2px; justify-items: start; padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--t2); text-align: left; font-size: 12.5px; }
      .choice-stack button span { color: var(--t4); font-size: 10.5px; font-weight: 400; }
      .choice-stack button.on { border-color: var(--link-line); background: var(--panel2); color: var(--t1); }
      .choice-stack button:disabled { opacity: .38; cursor: not-allowed; }
      .inspector-note { color: var(--t4); font-size: 11px; margin-top: 12px; }
      .finder-footer { grid-column: 1 / -1; grid-row: 2; min-height: 54px; display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 10px 14px; border-top: 1px solid var(--line2); color: var(--t3); font-size: 11.5px; }
      .footer-actions { display: flex; gap: 8px; }
      .finder-footer button { padding: 6px 16px; border: 1px solid var(--link-line); border-radius: 6px; background: var(--link-line); color: #E8EDF8; font-size: 12.5px; }
      .finder-footer button.secondary { background: transparent; color: var(--t2); border-color: var(--line); }
      .action-message { color: var(--t3); min-height: 18px; margin-top: 8px; }
      .scope-connection, .scope-browser-note { color: var(--t3); font-size: 12px; padding: 8px 12px; }
      .scope-browser-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line2); }
      .scope-browser-toolbar button, .scope-browser-list button, [data-scope-more] { color: var(--t2); background: transparent; border: 1px solid var(--line); border-radius: 5px; padding: 6px 10px; cursor: pointer; }
      .scope-browser-list .scope-folder { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
      .scope-folder [data-scope-select] { flex: 1; border: 0; background: transparent; padding: 0; color: inherit; text-align: left; overflow-wrap: anywhere; }
      .scope-folder.selected [data-scope-select] { background: transparent; }
      .scope-folder [data-scope-open] { padding: 0; width: 14px; border: 0; background: transparent; color: inherit; }
      .scope-folder-status { color: var(--t3); font-size: 11px; }
      .scope-folder.selected .scope-folder-status { color: var(--t1); }
      .scope-whole-account, .scope-whole-confirm { margin: 12px; font-size: 12px; color: var(--t2); }
      .scope-whole-account { display: block; }
      .scope-whole-confirm:not([hidden]) { display: block; color: var(--warn); }
      [data-folder-scope-source] input[type="checkbox"] { width: auto; display: inline-block; margin: 0 6px 0 0; vertical-align: middle; }
      [data-folder-scope-source] [hidden] { display: none !important; }
      .scope-review { border-top: 1px solid var(--line2); margin: 12px; padding-top: 12px; font-size: 12px; }
      .scope-review li { overflow-wrap: anywhere; margin: 5px 0; }
      [data-folder-scope-source] button:disabled { opacity: .4; cursor: not-allowed; }
      .warn-note { margin: 10px 14px; background: var(--warn-bg); border-color: var(--warn-line); color: var(--t2); }
      @media (max-width: 860px) {
        .finder-window { grid-template-columns: 130px minmax(300px, 1fr); }
        .finder-inspector { grid-column: 1 / -1; grid-row: 2; border-top: 1px solid var(--line2); }
        .finder-footer { grid-row: 3; }
      }
`;
