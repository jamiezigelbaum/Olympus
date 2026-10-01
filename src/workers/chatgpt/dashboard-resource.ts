/**
 * The `ui://olympus/dashboard` MCP Apps resource.
 *
 * PLACEHOLDER. The dashboard lane replaces `dashboardResourceHtml` with the
 * real page; this module is the single path the MCP surface loads the HTML
 * from, so that swap touches nothing else. The placeholder renders the tool's
 * structuredContent as plain text and runs a Fix's tool through `tools/call`,
 * which is enough to prove the MCP Apps wiring end to end.
 */
import { DASHBOARD_RESOURCE_URI } from './dashboard-contract.ts';

/** MCP Apps resource MIME type (modelcontextprotocol.io MCP Apps extension). */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const DASHBOARD_RESOURCE = {
  uri: DASHBOARD_RESOURCE_URI,
  name: 'Olympus dashboard',
  mimeType: MCP_APP_MIME_TYPE,
} as const;

/** `_meta` on the resource contents: no external origins, fullscreen preferred. */
export function dashboardResourceMeta(): Record<string, unknown> {
  return {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
    'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] },
  };
}

export function dashboardResourceHtml(): string {
  return PLACEHOLDER_HTML;
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Olympus</title>
<style>
  :root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; }
  body { margin: 16px; }
  .note { padding: 8px 10px; border: 1px dashed currentColor; opacity: .7; margin-bottom: 12px; }
  pre { white-space: pre-wrap; word-break: break-word; }
  button { margin: 4px 6px 4px 0; }
</style>
</head>
<body>
<div class="note">Placeholder dashboard. The real Olympus dashboard replaces this page.</div>
<div id="fixes"></div>
<pre id="out">Waiting for Olympus…</pre>
<script>
(function () {
  var nextId = 1;
  var pending = {};
  function send(method, params) {
    var id = nextId++;
    window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params || {} }, '*');
  }
  function render(result) {
    var data = result && result.structuredContent;
    document.getElementById('out').textContent = data ? JSON.stringify(data, null, 2) : 'No dashboard data.';
    var fixes = document.getElementById('fixes');
    fixes.textContent = '';
    var items = [];
    if (data) {
      if (data.blocker) items.push(data.blocker.fix);
      (data.needsYou || []).forEach(function (item) { items.push(item.fix); });
      (data.sources || []).forEach(function (source) { if (source.primary) items.push(source.primary); });
    }
    items.forEach(function (fix) {
      if (!fix) return;
      var button = document.createElement('button');
      button.textContent = fix.label;
      if (!fix.tool) { button.disabled = true; button.title = fix.disabledReason || ''; }
      else button.onclick = function () {
        send('tools/call', { name: fix.tool, arguments: fix.args || {} }).then(render, function () {
          document.getElementById('out').textContent = 'Could not reach Olympus.';
        });
      };
      fixes.appendChild(button);
    });
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending[message.id]) {
      var entry = pending[message.id];
      delete pending[message.id];
      if (message.error) entry.reject(message.error); else entry.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') render(message.params);
  });
  send('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'olympus-dashboard-placeholder', version: '0' },
    appCapabilities: {}
  }).then(function () { notify('ui/notifications/initialized'); }, function () {});
  if (window.openai && window.openai.toolOutput) render({ structuredContent: window.openai.toolOutput });
})();
</script>
</body>
</html>
`;
