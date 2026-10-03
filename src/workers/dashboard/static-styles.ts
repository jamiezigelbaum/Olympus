/** Browser-safe static styles shared by standalone and native dashboard surfaces. */
export const DASHBOARD_LANE_CSS = `.bgrow { position: relative; display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; color: inherit; text-decoration: none; }
.bgrow .bgl { display: grid; grid-template-columns: 20px 110px 1fr 220px; gap: 12px; align-items: center; padding: 4px 28px 4px 0; }
.bgrow .bgl::before { content: ''; }
.bgrow .nm { font-weight: 500; font-size: var(--fs-body); color: var(--t2); }
.bgrow .fx { color: var(--t3); font-size: var(--fs-caption); }
.bgrow .go { position: absolute; right: 16px; top: 14px; color: var(--t4); font-size: var(--fs-body); }
.bgrow:hover .go, .bgrow:focus-visible .go { color: var(--link); }
.bgrow:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
.minibar { display: block; width: 64px; height: 8px; background: var(--line2); border: 1px solid var(--line); border-radius: 5px; overflow: hidden; justify-self: end; }
.minibar i { display: block; height: 100%; background: var(--run-fill); }
/* Finished work is not in progress: a full bar reads ready, never yellow. */
.minibar.done i { background: var(--good); }
/* A bar always carries its number: the percent sits beside the track. */
.labeledbar { display: flex; align-items: center; gap: 8px; justify-self: stretch; }
.labeledbar .minibar { flex: 1; width: auto; }
.labeledbar .pct { color: var(--t1); font-size: var(--fs-caption); font-weight: 600; font-variant-numeric: tabular-nums; min-width: 4ch; text-align: right; }
.lanerow { display: grid; grid-template-columns: 110px 64px 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.lanerow .nm { font-weight: 500; font-size: var(--fs-body); color: var(--t2); }
.lanerow .st { color: var(--t3); font-size: var(--fs-caption); }
.lanerow .minibar { justify-self: start; }
.lanestrip { display: flex; gap: 2px; }
.lanestrip i { display: block; width: 7px; height: 20px; border-radius: 2px; }
.disp { font-family: system-ui, sans-serif; font-size: var(--fs-caption); letter-spacing: .04em; }
.disp.heal { color: var(--good); }
.disp.attn { color: var(--warn); }
@media (max-width: 700px) {
  .lanerow { grid-template-columns: 110px 1fr; }
  .lanerow .minibar, .lanerow .lanestrip { display: none; }
  /* The go arrow is absolutely positioned at the right edge, so the facts
     column keeps clear of it rather than running underneath. */
  .bgrow .bgl { grid-template-columns: 1fr auto; padding-right: 18px; }
  .bgrow .bgl::before { display: none; }
  .bgrow .labeledbar { grid-column: 1 / -1; }
}
`;

export const DASHBOARD_PROGRESS_CSS = `.phase { margin: 0 0 14px; max-width: 520px; }
.phase .ph { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.phase .pn { font-size: var(--fs-caption); font-weight: 600; color: var(--t2); }
.phase .pv { font-size: var(--fs-caption); color: var(--t3); font-variant-numeric: tabular-nums; text-align: right; }
.phase .bar { max-width: none; margin-top: 6px; height: 5px; border-radius: 3px; }
.phase .pv .st { display: inline-block; margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--line2); font-weight: 600; color: var(--t2); }
.phase.done .pv .st { color: var(--good); }
.phase.working .pv .st { color: var(--run); }
.phase.stalled .pv .st { color: var(--warn); }
.phase.waiting .pv .st { color: var(--t4); }
.phase.waiting .bar { background: var(--line2); }
.phase.waiting .bar i { display: none; }
.bar.indet.working { position: relative; }
.bar.indet.working i { width: 34%; background: var(--run-fill); animation: dashsweep 1.6s ease-in-out infinite; }
@keyframes dashsweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(294%); } }
.settled { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; color: var(--t2); font-size: var(--fs-body); max-width: 520px; }
.banner { margin-bottom: 6px; }
.advanced { border-top: 1px solid var(--line); margin-top: 28px; padding-top: 4px; }
.advanced > summary { font-size: var(--fs-body); font-weight: 600; color: var(--t2); cursor: pointer; padding: 12px 0; list-style: none; }
.advanced > summary::-webkit-details-marker { display: none; }
.advanced > summary::before { content: '\\25B8 '; display: inline-block; transition: transform .12s ease; }
.advanced[open] > summary::before { transform: rotate(90deg); }
.advanced > summary:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  .bar.indet.working i { animation: none; width: 100%; background: var(--line2); }
}
`;

export const DASHBOARD_POLICY_CSS = `.scoperow { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 10px 14px; margin-bottom: 6px; }
.scoperow .rid { font-family: var(--mono); font-size: var(--fs-caption); font-weight: 600; color: var(--t2); }
.scoperow .what { color: var(--t3); font-size: var(--fs-caption); }
.sect.gap { margin-top: 44px; }
.quiet { color: var(--t4); font-size: var(--fs-caption); margin: -2px 0 10px; max-width: 66ch; }
.quiet.after { margin: 8px 0 0; }
.tiersnote { color: var(--t3); font-size: var(--fs-caption); margin: 0 0 12px; max-width: 66ch; }
.tiernote { font-size: var(--fs-caption); margin-top: 10px; }
.pm { color: var(--t4); }
.pm.yes { color: var(--good); }
.tname { color: var(--t1); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: var(--panel); border: 1px solid var(--line2); border-radius: 999px; padding: 3px 11px; color: var(--t3); font-size: var(--fs-caption); }
.chip b { color: var(--t2); font-weight: 600; font-variant-numeric: tabular-nums; }
.vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

export const DASHBOARD_NAV_CSS = `.top { position: sticky; top: 0; z-index: 12; background: var(--bg); padding-top: 2px; }
.dnav { position: sticky; top: 39px; z-index: 11; display: flex; gap: 4px; margin: -8px 0 22px; border-bottom: 1px solid var(--line2); background: var(--bg); }
.dnav .dnavlink { color: var(--t3); text-decoration: none; font-size: var(--fs-caption); padding: 6px 12px 8px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dnav .dnavlink:hover { color: var(--link); }
.dnav .dnavlink:focus-visible { outline: 1px solid var(--link); outline-offset: -2px; border-radius: 4px; }
.dnav .dnavlink.on { color: var(--t1); border-bottom-color: var(--link-line); }
`;

export const SETUP_JOURNEY_CSS = `.setupsummary { color: var(--t2); font-size: var(--fs-body); margin: 0 0 18px; }`;

export const BACKGROUND_CSS = `.lane { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.lane .lanehd { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.lane .lnm { font-weight: 600; font-size: var(--fs-body); color: var(--t2); }
.lane .lstate { font-size: var(--fs-caption); white-space: nowrap; }
.lane .lfacts { color: var(--t2); font-size: var(--fs-caption); margin-top: 5px; font-variant-numeric: tabular-nums; }
.lane .lmove { color: var(--t3); font-size: var(--fs-caption); margin-top: 3px; font-variant-numeric: tabular-nums; }
.lane .lreason { color: var(--warn); font-size: var(--fs-caption); margin-top: 5px; max-width: 74ch; }
.lane .lreason.stuck { color: var(--bad); }
.lane .lreason.unknown { color: var(--t3); }
.lane .lbar { margin-top: 8px; }
.lane .lbar .minibar { width: 100%; max-width: 420px; }
.lane .lbar .labeledbar { max-width: 480px; }
.lane .lanestrip { margin-top: 8px; }
.lane .lqueue { margin-top: 8px; border-top: 1px solid var(--line2); padding-top: 7px; }
.lane .lq { color: var(--t3); font-size: var(--fs-caption); line-height: 1.55; }
.lane .lq b { color: var(--t2); font-weight: 600; font-variant-numeric: tabular-nums; }
.lane.quiet { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 9px 14px; }
.lane.quiet .lquiet { color: var(--t4); font-size: var(--fs-caption); }
.info { color: var(--t3); font-size: var(--fs-caption); line-height: 1.6; max-width: 74ch; }
.infolink { margin-top: 8px; font-size: var(--fs-caption); }
.embblock { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin: -3px 0 7px; }
.embblock .embstate { font-size: var(--fs-body); font-weight: 500; margin-bottom: 6px; }
.embblock .embline { color: var(--t3); font-size: var(--fs-caption); line-height: 1.5; margin-bottom: 4px; }
.embblock .embline.warn { color: var(--warn); }
.embblock .rowform { margin: 8px 0 6px; }
@media (max-width: 700px) {
  .lane .lanehd { flex-wrap: wrap; }
}
`;

export const DISPOSITIONS_CSS = `
      /* The folder and mail pickers. Element rules are scoped with :where()
         to the picker page, so they keep zero extra specificity and never
         restyle the dashboard pages that share the native stylesheet. */
      :root {
        color-scheme: dark;
        --accent: var(--link);
        --accent-strong: var(--link);
        --accent-soft: var(--panel2);
        --border: var(--line);
        --muted: var(--t3);
        --faint: var(--t4);
        --card: var(--bg);
        --radius-card: 10px;
        --radius-control: 8px;
      }
      :where(.picker-page) { color: var(--t1); font-size: var(--fs-body); line-height: 1.55; }
      :where(.picker-page) h1 { font-size: var(--fs-title); line-height: 1.15; margin: 0; letter-spacing: -0.01em; }
      :where(.picker-page) h2 { font-size: var(--fs-section); font-weight: 600; margin: 0; }
      :where(.picker-page) h3 { font-size: var(--fs-row); font-weight: 600; margin: 0; }
      :where(.picker-page) p { margin: 0; color: var(--t3); max-width: 72ch; }
      .eyebrow { color: var(--t3); font-size: var(--fs-caption); }
      .subtle { color: var(--t3); font-size: var(--fs-caption); }
      :where(.picker-page) code { background: var(--panel2); border-radius: 4px; padding: 1px 5px; font-size: var(--fs-caption); }
      .warn-note { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: var(--radius-card); padding: 11px 14px; color: var(--t2); font-size: var(--fs-body); }
      .warn-note strong { color: var(--t1); }
      .warn-note::before { content: '! '; color: var(--warn); font-weight: 800; }
      .node-name { font-weight: 500; }
      .node-counts { color: var(--t3); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
      :where(.picker-page) label { display: grid; gap: 5px; color: var(--t3); font-size: var(--fs-caption); }
      :where(.picker-page) input { border: 1px solid var(--field); border-radius: var(--radius-control); padding: 7px 10px; font: inherit; font-size: var(--fs-body); min-width: 0; background: var(--panel); color: var(--t1); }
      :where(.picker-page) input::placeholder { color: var(--t4); }
      :where(.picker-page) button { border: 1px solid var(--link-line); background: transparent; color: var(--link); border-radius: var(--radius-control); padding: 7px 14px; font: inherit; font-size: var(--fs-body); font-weight: 500; cursor: pointer; justify-self: start; }
      :where(.picker-page) :is(button, input, summary):focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
      :where(.picker-page) form { display: grid; gap: 10px; }
      .action-message { color: var(--t3); font-size: var(--fs-caption); min-height: 18px; }

      @media (max-width: 720px) {
        .node > .children { margin-left: 8px; padding-left: 8px; }
      }

      .picker-page { max-width: 1180px; margin: 0 auto; padding: 28px 24px 72px; }
      .picker-header { margin: 0 0 18px; display: grid; gap: 5px; }
      .picker-header h1 { color: var(--t1); font-size: var(--fs-title); }
      .picker-header p { color: var(--t3); }
      .picker-header strong { color: var(--t2); }
      .source-dispositions { padding: 0; margin: 0 0 14px; border: 0; background: transparent; display: block; }
      .source-dispositions[hidden] { display: none !important; }
      .scope-back { margin: 0 0 12px; }
      .finder-sidebar a.location { text-decoration: none; }
      .finder-window { min-height: 590px; display: grid; grid-template-columns: 180px minmax(420px, 1fr) 270px; grid-template-rows: 1fr auto; overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); box-shadow: 0 12px 38px rgba(0,0,0,.34); }
      .finder-sidebar { grid-column: 1; grid-row: 1; padding: 15px 10px; background: rgba(255,255,255,.025); border-right: 1px solid var(--line2); }
      .sidebar-label { padding: 0 9px 8px; color: var(--t4); font-size: var(--fs-caption); font-weight: 600; }
      .location { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 6px; color: var(--t2); font-size: var(--fs-caption); }
      .location.selected { background: var(--panel2); color: var(--t1); }
      .location .folder-icon { color: var(--link); font-size: var(--fs-caption); }
      .finder-browser { grid-column: 2; grid-row: 1; min-width: 0; border-right: 1px solid var(--line2); }
      .finder-toolbar { min-height: 68px; display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 12px 16px; border-bottom: 1px solid var(--line2); }
      .finder-toolbar h2 { color: var(--t1); font-size: var(--fs-row); }
      .finder-toolbar p { color: var(--t4); font-size: var(--fs-caption); margin-top: 2px; }
      .finder-toolbar input { width: 180px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--t1); font-size: var(--fs-caption); }
      .finder-columns { display: grid; grid-template-columns: minmax(180px, 1fr) 64px 128px; gap: 10px; padding: 6px 14px 6px 36px; border-bottom: 1px solid var(--line2); color: var(--t4); font-size: var(--fs-caption); }
      .tree { height: 468px; overflow: auto; display: block; padding: 6px; }
      /* Under the tree, not inside it: these count folders and items the tree
         does not list, so a reader who scrolls to the bottom of the tree has
         not seen them. */
      .tree-notes { padding: 8px 14px 10px; border-top: 1px solid var(--line2); display: grid; gap: 4px; }
      .tree-notes .subtle { color: var(--t4); font-size: var(--fs-caption); }
      .node { border: 0; padding: 0; }
      .node > .children { margin-left: 18px; padding-left: 0; border-left: 1px solid var(--line2); }
      details.node > summary.folder-row { list-style: none; }
      details.node > summary.folder-row::-webkit-details-marker { display: none; }
      details.node > summary.folder-row::before { content: "\\25B8"; width: 12px; color: var(--t4); font-size: var(--fs-caption); }
      details.node[open] > summary.folder-row::before { content: "\\25BE"; }
      .folder-row { min-height: 31px; display: grid; grid-template-columns: 12px 15px minmax(150px, 1fr) 64px 128px; gap: 7px; align-items: center; padding: 4px 8px; border-radius: 6px; cursor: default; color: var(--t2); }
      .folder-row:hover { background: rgba(255,255,255,.035); }
      .folder-row.selected { background: var(--selected); color: var(--t1); }
      .folder-row:focus-visible { outline: 1px solid var(--link); outline-offset: -1px; }
      .node.leaf .folder-row .disclosure { width: 12px; }
      .folder-icon { color: var(--link); font-size: var(--fs-caption); }
      .node-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
      .node-counts, .node-state { color: var(--t3); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
      .folder-row.selected .node-counts, .folder-row.selected .node-state { color: var(--t1); }
      .stored-controls { display: none; }
      .finder-inspector { grid-column: 3; grid-row: 1; padding: 22px 18px; background: rgba(255,255,255,.015); }
      .finder-inspector [data-inspector-empty] { padding-top: 120px; text-align: center; color: var(--t4); }
      .inspector-folder { color: var(--link); font-size: 30px; margin-bottom: 10px; }
      .finder-inspector h3 { color: var(--t1); font-size: var(--fs-row); margin-bottom: 4px; }
      .inspector-path { color: var(--t4); font-size: var(--fs-caption); overflow-wrap: anywhere; }
      .inspector-count { color: var(--t3); font-size: var(--fs-caption); margin: 9px 0 18px; }
      .choice-stack { display: grid; gap: 7px; }
      .choice-stack button { width: 100%; display: grid; gap: 2px; justify-items: start; padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--t2); text-align: left; font-size: var(--fs-caption); }
      .choice-stack button span { color: var(--t4); font-size: var(--fs-caption); font-weight: 400; }
      .choice-stack button.on { border-color: var(--link-line); background: var(--panel2); color: var(--t1); }
      .choice-stack button:disabled { opacity: .38; cursor: not-allowed; }
      .inspector-note { color: var(--t4); font-size: var(--fs-caption); margin-top: 12px; }
      .finder-footer { grid-column: 1 / -1; grid-row: 2; min-height: 54px; display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 10px 14px; border-top: 1px solid var(--line2); color: var(--t3); font-size: var(--fs-caption); }
      .footer-actions { display: flex; gap: 8px; }
      .finder-footer button { padding: 6px 16px; border: 1px solid var(--link-line); border-radius: 6px; background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-accent); font-size: var(--fs-caption); }
      .finder-footer button.secondary { background: transparent; color: var(--t2); border-color: var(--line); }
      .action-message { color: var(--t3); min-height: 18px; margin-top: 8px; }
      .scope-connection, .scope-browser-note { color: var(--t3); font-size: var(--fs-caption); padding: 8px 12px; }
      /* The folder picker (Dropbox, Google Drive): the approved ChatGPT
         layout. One level per screen, one thin line per folder with the
         drill-in chevron beside the name, and one pill control flush right. */
      .scope-picker { max-width: 760px; }
      .scope-picker form { display: block; container-type: inline-size; }
      .scope-picker [hidden] { display: none !important; }
      .scope-back a, .scope-picker button.back { display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--t1); font-size: var(--fs-caption); font-weight: 500; text-decoration: none; }
      .scope-picker button.back::before { content: "\\2190\\00a0"; }
      .scope-locations { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
      .scope-locations .location { padding: 5px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--t2); text-decoration: none; }
      .scope-locations .location.selected { border-color: var(--field); background: var(--panel2); color: var(--t1); }
      .scope-locations .folder-icon { display: none; }
      .scope-picker .scope-browser-note { padding: 0; margin: 0 0 8px; }
      .scope-picker .fpath { margin: 14px 0 12px; color: var(--t1); font-size: var(--fs-section); font-weight: 600; }
      .scope-picker .fpath-up { color: var(--t3); font-weight: 400; }
      .scope-picker .this-row { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 4px 4px 4px 12px; margin: 0 0 12px; background: var(--panel); border-radius: 12px; }
      .scope-picker .this-label { flex: 1 1 auto; min-width: 0; margin: 0; color: var(--t1); font-weight: 600; }
      .scope-picker .fsection { margin-top: 18px; }
      .scope-picker .fsection h2 { margin: 0 0 6px; color: var(--t1); font-size: var(--fs-row); }
      .scope-picker .flist { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line2); }
      .scope-picker .frow { display: flex; align-items: center; gap: 4px; min-height: 48px; border-bottom: 1px solid var(--line2); }
      .scope-picker .fname { position: relative; flex: 1 1 auto; display: flex; align-items: center; gap: 0 8px; min-width: 44px; height: 44px; margin: 0; padding: 0 0 0 23px; border: 0; border-radius: 8px; background: none; color: var(--t1); font: inherit; font-weight: 500; text-align: left; white-space: nowrap; overflow: hidden; cursor: pointer; }
      .scope-picker .fname.leaf { cursor: default; }
      .scope-picker .fopen, .scope-picker .fopen-gap { position: absolute; left: 0; top: 0; width: 18px; height: 44px; line-height: 44px; text-align: center; }
      .scope-picker .fopen { color: var(--t3); font-size: var(--fs-title); }
      .scope-picker button.fname:hover:not(:disabled) .fopen { color: var(--t1); }
      .scope-picker button.fname:disabled { cursor: default; }
      .scope-picker .fname-main { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
      .scope-picker .fname-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .scope-picker .ftag { flex: none; padding: 0 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--t3); font-size: var(--fs-caption); font-weight: 500; line-height: 20px; }
      .scope-picker .seg { flex: none; margin-left: auto; display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); }
      .scope-picker .seg-opt { position: relative; display: inline-flex; align-items: center; justify-content: center; min-width: 44px; height: 32px; margin: 0; padding: 0 12px; border: 0; border-radius: 999px; background: none; color: var(--t1); font: inherit; font-size: var(--fs-caption); font-weight: 500; white-space: nowrap; cursor: pointer; }
      .scope-picker .seg-opt::before { content: ""; position: absolute; inset: -7px 0; }
      .scope-picker .seg-opt + .seg-opt::after { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 1px; background: var(--line); }
      .scope-picker .seg-opt.on::after, .scope-picker .seg-opt.on + .seg-opt::after, .scope-picker .seg-opt.inherited::after, .scope-picker .seg-opt.inherited + .seg-opt::after { display: none; }
      .scope-picker .seg-opt:hover:not(:disabled):not(.on) { background: var(--panel2); }
      .scope-picker .seg-opt.on { background: var(--t1); color: var(--bg); font-weight: 600; }
      .scope-picker .seg-opt.inherited { background: var(--panel2); box-shadow: inset 0 0 0 1px var(--t3); }
      .scope-picker .seg-opt:disabled { color: var(--t3); opacity: .5; cursor: not-allowed; }
      .scope-picker .seg-opt:disabled.inherited, .scope-picker .seg-opt:disabled.on { opacity: 1; }
      .scope-picker .seg-short { display: none; }
      @container (max-width: 420px) {
        .scope-picker .seg-long { display: none; }
        .scope-picker .seg-short { display: inline; }
        .scope-picker .seg-opt { padding: 0 8px; }
        .scope-picker .picker-footer { padding: 12px; }
        .scope-picker :is(.actions, .fmore, .scope-error) button { padding: 0 12px; }
      }
      @media (max-width: 720px) {
        .picker-page { padding: 20px 16px 56px; }
      }
      .scope-picker .jump-btn { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 48px; margin: 0; padding: 0; border: 0; background: none; color: var(--t1); font: inherit; font-weight: 500; text-align: left; cursor: pointer; }
      .scope-picker .jtag { flex: none; margin-left: auto; color: var(--t3); font-size: var(--fs-caption); font-weight: 400; }
      .scope-picker .chev { flex: none; color: var(--t3); font-size: var(--fs-title); line-height: 1; }
      .scope-picker .fstate, .scope-picker .fempty { margin: 0; padding: 12px 0; color: var(--t3); }
      .scope-picker .fmore { padding: 8px 0; }
      .scope-picker .confirm-box { display: flex; flex-direction: column; gap: 8px; margin: -4px 0 12px; padding: 12px; border: 1px solid var(--warn-line); border-radius: 12px; background: var(--warn-bg); }
      .scope-picker .confirm-box .strong { color: var(--t1); font-weight: 600; }
      .scope-picker .scope-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 12px; padding: 12px; border: 1px solid var(--err-line); border-radius: 12px; background: var(--err-bg); }
      .scope-picker .scope-error p { color: var(--t1); }
      .scope-picker .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .scope-picker :is(.actions, .fmore, .scope-error) button { min-height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--t1); font-size: var(--fs-body); font-weight: 500; }
      .scope-picker :is(.actions, .fmore, .scope-error) button:hover:not(:disabled) { background: var(--panel2); }
      .scope-picker .actions button.primary { border-color: var(--accent-fill); background: var(--accent-fill); color: var(--on-accent); }
      .scope-picker .actions button.danger { border-color: var(--bad); color: var(--bad); }
      .scope-picker :is(.actions, .fmore, .scope-error) button:disabled { border-style: dashed; background: var(--panel); color: var(--t3); cursor: not-allowed; }
      .scope-picker .picker-footer { margin-top: 24px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); display: flex; flex-direction: column; gap: 12px; }
      .scope-picker .summary { display: flex; flex-direction: column; gap: 4px; }
      .scope-picker .summary p { color: var(--t1); }
      .scope-picker .save { display: flex; flex-direction: column; gap: 6px; }
      .scope-picker .reason { color: var(--t3); font-size: var(--fs-caption); }
      .scope-picker .reason:empty, .scope-picker .action-message:empty { display: none; }
      .warn-note { margin: 10px 14px; background: var(--warn-bg); border-color: var(--warn-line); color: var(--t2); }
      /* Mail scope picker: the same Finder frame, with form groups where the
         folder tree sits and the estimate where the inspector sits. */
      .mail-scope-main { grid-column: 2; grid-row: 1; min-width: 0; border-right: 1px solid var(--line2); padding: 6px 0; }
      .mail-scope-group { border: 0; border-bottom: 1px solid var(--line2); margin: 0; padding: 12px 16px 14px; display: grid; gap: 8px; }
      .mail-scope-group:last-child { border-bottom: 0; }
      .mail-scope-group legend { float: left; width: 100%; padding: 0; color: var(--t1); font-size: var(--fs-body); font-weight: 600; }
      .mail-scope-help { color: var(--t4); font-size: var(--fs-caption); }
      .mail-scope-options { display: flex; flex-wrap: wrap; gap: 6px; }
      .mail-scope-option { display: flex; align-items: flex-start; gap: 7px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--t2); font-size: var(--fs-caption); cursor: pointer; }
      .mail-scope-option:has(input:checked) { border-color: var(--link-line); background: var(--panel2); color: var(--t1); }
      .mail-scope-option input { width: auto; margin: 2px 0 0; padding: 0; }
      .mail-scope-option span { display: grid; gap: 1px; }
      .mail-scope-option small { color: var(--t4); font-size: var(--fs-caption); }
      .mail-scope-labels { display: flex; flex-wrap: wrap; gap: 6px; max-height: 190px; overflow: auto; }
      .mail-scope-senders { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .mail-scope-senders label { display: grid; gap: 4px; color: var(--t2); font-size: var(--fs-caption); }
      .mail-scope-senders small { color: var(--t4); font-size: var(--fs-caption); }
      .mail-scope-senders textarea { width: 100%; resize: vertical; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--t1); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 7px 9px; }
      .mail-scope-suggestions ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 3px; }
      .mail-scope-suggestions li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 8px; align-items: center; padding: 3px 6px; border-radius: 5px; color: var(--t2); font-size: var(--fs-caption); }
      .mail-scope-suggestions li:hover { background: rgba(255,255,255,.035); }
      .mail-scope-suggestions .sender { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mail-scope-suggestions .count { color: var(--t4); font-variant-numeric: tabular-nums; font-size: var(--fs-caption); }
      .mail-scope-suggestions button { padding: 3px 9px; font-size: var(--fs-caption); color: var(--t2); background: transparent; border: 1px solid var(--line); border-radius: 5px; }
      .mail-scope-estimate { display: grid; align-content: start; gap: 10px; }
      .mail-scope-figures { margin: 0; display: grid; gap: 8px; }
      .mail-scope-figures div { display: flex; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line2); padding-bottom: 6px; }
      .mail-scope-figures dt { color: var(--t3); font-size: var(--fs-caption); }
      .mail-scope-figures dd { margin: 0; color: var(--t1); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; text-align: right; }
      .mail-scope-estimate button { justify-self: start; padding: 6px 12px; font-size: var(--fs-caption); color: var(--t2); background: transparent; border: 1px solid var(--line); border-radius: 6px; }
      /* The same pill buttons and footer rhythm as the folder picker. */
      .mail-scope-window .finder-footer { padding: 12px 16px; }
      .mail-scope-window .finder-footer button, .mail-scope-estimate button { min-height: 36px; padding: 0 14px; border-radius: 999px; font-size: var(--fs-body); }
      [data-mail-scope-source] [hidden] { display: none !important; }
      [data-mail-scope-source] button:disabled, [data-mail-scope-source] input:disabled, [data-mail-scope-source] textarea:disabled { opacity: .45; cursor: not-allowed; }
      @media (max-width: 860px) {
        .mail-scope-senders { grid-template-columns: 1fr; }
        .finder-window { grid-template-columns: 130px minmax(300px, 1fr); }
        .finder-inspector { grid-column: 1 / -1; grid-row: 2; border-top: 1px solid var(--line2); }
        .finder-footer { grid-row: 3; }
      }
`;


/* Setup's Agents section: the agent picker is a list of disclosures inside the
   Connect an agent sheet, and a pairing code or key is shown once in a
   read-only field beside its own Copy and Done. The remote-access row carries
   Turn on / Turn off, and the agreement panel opens beneath it. */
export const AGENT_CONNECT_CSS = `.agentpick { display: grid; gap: 6px; margin: 4px 0 0; }
.agentchoice { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.agentchoice > summary { list-style: none; cursor: pointer; padding: 10px 14px; display: flex; gap: 8px; align-items: baseline; font-size: var(--fs-body); color: var(--t2); }
.agentchoice > summary::-webkit-details-marker { display: none; }
.agentchoice > summary::after { content: '\\25B8'; margin-left: auto; color: var(--t4); transition: transform .12s ease; }
.agentchoice[open] > summary::after { transform: rotate(90deg); }
.agentchoice > summary:hover .name, .agentchoice > summary:focus-visible .name { color: var(--link); }
.agentchoice > summary:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; border-radius: 8px; }
.agentchoice > summary .name { font-weight: 600; }
.agentchoice .agentbody { padding: 2px 14px 14px; }
.agentchoice .agentbody > p { margin: 0 0 10px; }
.agentchoice .steps li { margin-bottom: 14px; }
.agentchoice .steps .rowform { margin-top: 8px; }
.agentchoice .steps .hint { display: block; margin: 6px 0 0; }
.agentsecret { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.agentsecret[hidden] { display: none; }
.agentsecret .keyfield { font-family: var(--mono); min-width: 18ch; flex: 1 1 18ch; max-width: 46ch; }
.agentsecret [data-agent-secret-note] { flex-basis: 100%; margin: 0; }
#agents { margin-top: 26px; }
[data-remote-access] > .rowform { flex: 0 0 auto; margin-left: 8px; }
.remoteterms { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 12px 14px; margin: 6px 0 10px; font-size: var(--fs-body); color: var(--t2); }
.remoteterms[hidden] { display: none; }
.remoteterms p { margin: 0 0 8px; max-width: 72ch; }
.remoteterms .rowform { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 4px; }
.promptbox.prose { word-break: normal; overflow-wrap: anywhere; }`;

/**
 * Models section layout, shared by the standalone Setup page and the native
 * Control UI (src/control-ui/styles.ts). A card reads as three lines at most:
 * name and state, what the model is for, then one wrapping action row (key
 * field, Connect, and the "Get a key" link side by side).
 */
export const MODEL_SETUP_CSS = `
.modelcards{display:grid;gap:12px;margin:16px 0 20px}.modelcard{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;min-width:0}
.modelcard header{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 10px;margin:0}.modelcard header [role=status]{color:var(--t3);font-size:var(--fs-caption)}
.modelcard header b{font-size:var(--fs-row)}.modelcard p{margin:6px 0 0;color:var(--t2)}.modelintro{color:var(--t2);margin:0 0 4px;max-width:72ch}
.modelaction{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin-top:12px}
.modelaction form{display:flex;flex:1 1 320px;flex-wrap:wrap;align-items:center;gap:8px;margin:0;min-width:0}
.modelaction input[type=password]{flex:1 1 180px;min-width:0;width:auto}.modelaction a{white-space:nowrap}.modelaction .modelnote{color:var(--t3)}
.modelcards .modelrow,.modelcards .sheet{margin:0}.modelcards .sheet .modelaction{margin:0}
.modeltools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 16px}.modeltools p{margin:0;flex-basis:100%}
.modeltools form,.modelextras form{display:inline-flex;align-items:center;gap:8px;margin:0}
.modelextras{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 24px}
`;

/** The rows' layout, after the ChatGPT dashboard's list rows. */
export const DASHBOARD_SOURCE_ROWS_CSS = `
.srows { border-top: 1px solid var(--line); margin-bottom: 8px; }
.srow { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: start; gap: 8px 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.srow .smain { grid-column: 1; grid-row: 1; min-width: 0; }
.srow .sact { grid-column: 2; grid-row: 1; }
.srow .smenu { grid-column: 3; grid-row: 1; }
.srow .shead { display: flex; align-items: center; gap: 10px; }
.srow .shead .name { font-weight: 600; font-size: var(--fs-row); color: var(--t1); text-decoration: none; }
.srow .shead a.name:hover { color: var(--link); text-decoration: underline; }
.srow .shead a.name:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; border-radius: 4px; }
.srow .sneed { font-size: var(--fs-row); color: var(--t1); }
.srow .sline { margin: 4px 0 0 20px; color: var(--t2); font-size: var(--fs-body); }
.srow .sline.strong { margin-left: 0; color: var(--t1); font-size: var(--fs-row); }
.srow.nodot .sline { margin-left: 0; }
.srow .sact { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.srow .sact form { margin: 0; }
.dot.tone-good { background: var(--good); }
.dot.tone-run { background: var(--run-fill); }
.dot.tone-warn { background: var(--warn-fill); }
.dot.tone-bad { background: var(--bad); }
.dot.tone-off { background: var(--off); }
.sprog { margin: 0; }
.srow .sprog .bar { max-width: none; height: 6px; margin: 8px 0 0 20px; }
.sprog.overall .sline { margin: 0 0 8px; color: var(--t1); }
.sprog.overall .bar { max-width: none; height: 6px; margin: 0 0 8px; }
.sprog.stalled .sline { color: var(--t1); }
.bar.stalled i { background: var(--warn-fill); }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
/* No border of its own: the list above already ends in one, and two read as a double divider. */
.modelsrow { margin: 28px 0 0; }
details.models > summary { font-size: var(--fs-section); font-weight: 600; color: var(--t1); cursor: pointer; padding: 4px 0; }
details.models > summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 4px; }
details.models .modelsbody { margin-top: 12px; }
.mlist { margin: 0 0 12px; padding-left: 20px; color: var(--t2); }
.minstalls { display: grid; gap: 10px; margin: 8px 0 0; }
.minstall .sline { margin: 0; color: var(--t2); font-size: var(--fs-body); }
.minstall .bar { max-width: none; height: 6px; margin-top: 6px; }
.minstall.failed .sline { color: var(--t1); font-weight: 600; }
@media (max-width: 700px) {
  .srow { grid-template-columns: minmax(0, 1fr) auto; }
  .srow .sact { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; padding-left: 20px; }
  .srow .smenu { grid-column: 2; grid-row: 1; }
  .srow.nodot .sact { padding-left: 0; }
  .srow .sact .rowlink { width: auto; justify-content: flex-start; }
}
`;

/** The Privacy editor (pages/privacy.ts), after the ChatGPT privacy screen. */
export const DASHBOARD_PRIVACY_CSS = `
.privacy { max-width: 760px; }
.ptitle { font-size: var(--fs-title); font-weight: 650; margin: 8px 0 6px; color: var(--t1); }
.pintro { color: var(--t2); margin: 0 0 18px; max-width: 72ch; }
.pnote { color: var(--t2); margin: 0 0 12px; }
.plabel { display: block; font-weight: 600; font-size: var(--fs-body); color: var(--t1); margin: 0 0 6px; }
.ptext { display: block; width: 100%; min-height: 120px; resize: vertical; background: var(--bg); border: 1px solid var(--field); border-radius: 8px; color: var(--t1); font: inherit; font-size: var(--fs-row); padding: 10px 12px; }
.ptext:focus-visible, .ptextline:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.privacy .sect { margin-top: 24px; }
.prule.removed .sline { text-decoration: line-through; color: var(--t3); }
.pempty { margin: 8px 0 0; }
.padd { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; }
.ppanel { margin: 12px 0 0; padding: 14px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
.ppanel .srows { margin: 8px 0; }
.ppanel .ppath { margin: 0 0 8px; color: var(--t2); }
.ppanel .ppath:empty { display: none; }
.psources { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 8px; }
.psources:empty { display: none; }
.psources .btn[aria-pressed="true"] { background: var(--selected); border-color: var(--link-line); color: var(--t1); }
.prow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ptextline { flex: 1 1 240px; width: auto; }
.pfooter { margin: 24px 0 0; padding: 16px 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; display: grid; gap: 12px; }
.pfooter p { margin: 0; color: var(--t1); }
.pbuttons { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.pbuttons a.btn { text-decoration: none; }
/* The confirm and conflict steps: a tinted box with a 1px border, never a stripe. */
.pprompt { padding: 12px 14px; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; display: grid; gap: 8px; }
.pprompt p { margin: 0; color: var(--t1); }
`;
