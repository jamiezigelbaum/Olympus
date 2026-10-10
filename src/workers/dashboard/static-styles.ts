/** Browser-safe static styles for the computer's own dashboard pages (pages/local.ts, pages/outside-help.ts). */

/** The row list and the page title and notes, after the ChatGPT panel's rows. */
export const LOCAL_PAGE_CSS = `
.srows { border-top: 1px solid var(--line); margin-bottom: 8px; }
.srow { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.srow .smain { grid-column: 1; grid-row: 1; min-width: 0; }
.srow .sact { grid-column: 2; grid-row: 1; flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.srow .sact form { margin: 0; }
.srow .sline { margin: 4px 0 0 20px; color: var(--t2); font-size: var(--fs-body); }
.srow .sline.strong { margin-left: 0; color: var(--t1); font-size: var(--fs-row); }
.srow.nodot .sline { margin-left: 0; }
.privacy { max-width: 760px; }
.privacy .sect { margin-top: 24px; }
.ptitle { font-size: var(--fs-title); font-weight: 650; margin: 8px 0 6px; color: var(--t1); }
.pintro { color: var(--t2); margin: 0 0 18px; max-width: 72ch; }
.pnote { color: var(--t2); margin: 0 0 12px; }
.plabel { display: block; font-weight: 600; font-size: var(--fs-body); color: var(--t1); margin: 0 0 6px; }
.ptextline { flex: 1 1 240px; width: auto; }
.ptextline:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.pbuttons { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.pbuttons a.btn { text-decoration: none; }
@media (max-width: 700px) {
  .srow { grid-template-columns: minmax(0, 1fr); }
  .srow .sact { grid-column: 1; grid-row: 2; justify-content: flex-start; }
}
`;


/* The Agents page: the agent picker is a list of disclosures inside the
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
 * Models section layout on the Keys page. A card reads as three lines at most:
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

export const DASHBOARD_OUTSIDE_HELP_CSS = `
/* The status line: the state and today's count, the switch beside them. */
.outside .ohpanel { margin: 0 0 12px; padding: 14px 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; display: grid; gap: 6px; }
.outside .ohhead { display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; }
.outside .ohstatewrap { display: grid; gap: 2px; min-width: 0; flex: 1 1 320px; }
.outside .ohhead > .pbuttons { flex: none; }
.outside .ohstate { display: flex; align-items: center; gap: 10px; margin: 0; font-size: var(--fs-row); font-weight: 600; color: var(--t1); }
.outside .dot.on { background: var(--good); }
.outside .dot.off { background: transparent; border: 2px solid var(--off); }
.outside .dot.attn { background: var(--warn-fill); }
.outside .ohline { margin: 0 0 0 20px; color: var(--t2); font-size: var(--fs-body); }
.outside .ohline.attn { color: var(--warn); font-weight: 600; }
.outside .ohsmall { font-size: var(--fs-caption); color: var(--t3); max-width: 78ch; }
.outside .ohwarn { color: var(--t1); padding: 10px 12px; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; }
/* Problems: one tinted list, a line each, its one button in the line. */
.outside .ohfix { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 6px; }
.outside .ohfix li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; padding: 10px 14px; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; color: var(--t1); }
.outside .ohfix li > span { flex: 1 1 200px; min-width: 0; }
.outside .ohfix li::before { content: '!'; flex: 0 0 20px; height: 20px; border-radius: 50%; background: var(--warn-fill); color: var(--bg); font-weight: 800; font-size: var(--fs-caption); line-height: 20px; text-align: center; }
.outside .ohfix .ohform { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.outside .ohfix .ohactions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.outside .ohfix .actmsg:empty, .outside .ohpanel .actmsg:empty { display: none; }
/* The statements, in full only until accepted. */
.outside .ohaccept { margin: 0 0 12px; padding: 14px 18px; border: 1px solid var(--warn-line); border-radius: 10px; }
.outside .ohaccept .sect { margin-top: 0; }
.outside .ohaccept .ohlist { margin-bottom: 4px; }
.outside .ohshort { margin: 0 0 4px; padding-left: 20px; color: var(--t1); }
.outside .ohshort li { margin: 0 0 4px; max-width: 78ch; }
.outside .ohlist, .outside .ohsteps, .outside .ohfacts { margin: 6px 0 10px; padding-left: 20px; color: var(--t1); }
.outside .ohlist li, .outside .ohsteps li { margin: 0 0 6px; max-width: 78ch; overflow-wrap: anywhere; }
.outside .ohfacts { color: var(--t2); font-size: var(--fs-caption); }
.outside .ohfacts li { margin: 0 0 4px; overflow-wrap: anywhere; }
/* Secondary sections: one line each (title and a short summary), open only when they need attention. */
.outside details.ohsect { border-top: 1px solid var(--line); }
.outside .ohmore { margin: 20px 0 0; }
.outside .ohmore > details.ohsect:last-child { border-bottom: 1px solid var(--line); }
.outside details.ohsect > summary { display: flex; align-items: baseline; gap: 6px 14px; flex-wrap: wrap; padding: 12px 0; cursor: pointer; list-style: none; }
.outside details.ohsect > summary::-webkit-details-marker { display: none; }
.outside details.ohsect > summary::before { content: '\\25B8'; color: var(--t3); font-size: var(--fs-body); width: 12px; flex: none; }
.outside details.ohsect[open] > summary::before { content: '\\25BE'; }
.outside details.ohsect > summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 4px; }
.outside .ohsect-title { font-size: var(--fs-section); font-weight: 600; color: var(--t1); }
.outside .ohsect-sum { color: var(--t3); font-size: var(--fs-body); }
.outside .ohsect-sum:empty { display: none; }
.outside details.ohsect > summary:hover .ohsect-title { color: var(--link); }
.outside .ohsect-body { padding: 0 0 16px 18px; }
.outside .ohgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0 16px; margin: 0 0 8px; }
.outside .ohform { display: grid; gap: 8px; margin: 8px 0 0; }
.outside .ohform.ohinline { margin: 0 0 12px; }
.outside .ohform .keyfield { width: 100%; max-width: 220px; }
.outside .ohack { display: flex; align-items: flex-start; gap: 10px; min-height: 32px; cursor: pointer; color: var(--t1); max-width: 78ch; }
.outside .ohack input { width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--link); flex: none; }
.outside .ohack input:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.outside .ohoff { color: var(--t3); }
.outside .actmsg[data-state="error"] { color: var(--bad); }
.outside .ohunlock { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin: 0 0 12px; padding: 10px 14px; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; }
.outside .ohunlock .hint { color: var(--t2); }
.outside .ohunlock .actmsg:empty { display: none; }
@media (max-width: 700px) {
  .outside .ohpanel { padding: 14px; }
  .outside .ohhead .pbuttons, .outside .ohhead .blocked { width: 100%; }
  .outside .ohline { margin-left: 0; }
  .outside .btn { white-space: normal; text-align: left; }
  .outside .ohsect-body { padding-left: 0; }
}
`;
