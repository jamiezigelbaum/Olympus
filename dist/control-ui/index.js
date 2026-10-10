// src/control-ui-contract.ts
var OLYMPUS_DASHBOARD_TOOL_METHOD = "olympus.dashboard.tool";
var OLYMPUS_DASHBOARD_PANEL_PATH = "/olympus/dashboard/panel";

// src/control-ui/styles.ts
var OLYMPUS_CONTROL_UI_CSS = `
:host { display: block; height: 100%; }
.olympus-control-ui { height: 100%; min-height: 32rem; }
.olympus-panel { display: block; width: 100%; height: 100%; min-height: 32rem; border: 0; background: transparent; }
.native-state { padding: 1.5rem 1rem; font: inherit; color: inherit; opacity: 0.8; }
`;

// src/workers/chatgpt/dashboard-contract.ts
var DASHBOARD_TOOL_NAME = "olympus_dashboard";
var CONNECT_SOURCE_TOOL_NAME = "olympus_connect_source";
var SCOPE_LIST_TOOL_NAME = "olympus_scope_list";
var SCOPE_SET_TOOL_NAME = "olympus_scope_set";
var DISCONNECT_SOURCE_TOOL_NAME = "olympus_disconnect_source";
var MODEL_SET_TOOL_NAME = "olympus_model_set";
var MODEL_RETRY_TOOL_NAME = "olympus_model_retry";
var SYNC_SOURCE_TOOL_NAME = "olympus_sync_source";
var OLYMPUS_HOST_CONTEXT_KEY = "olympus/host";
var INDEX_FASTER_TOOL_NAME = "olympus_index_faster";
var UNPAIR_SOURCE_TOOL_NAME = "olympus_unpair_source";
var OPEN_UNREADABLE_FILE_TOOL_NAME = "olympus_open_unreadable_file";
var PANEL_TOOL_NAMES = [
  DASHBOARD_TOOL_NAME,
  CONNECT_SOURCE_TOOL_NAME,
  SCOPE_LIST_TOOL_NAME,
  SCOPE_SET_TOOL_NAME,
  DISCONNECT_SOURCE_TOOL_NAME,
  MODEL_SET_TOOL_NAME,
  MODEL_RETRY_TOOL_NAME,
  "olympus_privacy_get",
  "olympus_privacy_set",
  SYNC_SOURCE_TOOL_NAME
];
var COMPUTER_HOST_TOOL_NAMES = [
  ...PANEL_TOOL_NAMES,
  INDEX_FASTER_TOOL_NAME,
  UNPAIR_SOURCE_TOOL_NAME,
  OPEN_UNREADABLE_FILE_TOOL_NAME
];

// src/workers/dashboard/host-bridge.ts
function dashboardHostBridge(config, io) {
  const view = io.frame.ownerDocument.defaultView || window;
  const media = typeof view.matchMedia === "function" ? view.matchMedia("(prefers-color-scheme: dark)") : null;
  let readOnly = config.readOnly;
  let landing = config.landing;
  function theme() {
    return media && media.matches ? "dark" : "light";
  }
  function hostContext(initial) {
    const context = {
      theme: theme(),
      displayMode: "fullscreen",
      availableDisplayModes: ["fullscreen"]
    };
    const own = { kind: config.kind, readOnly, links: config.links };
    if (initial && landing) {
      own.landing = { sourceId: landing.sourceId };
      landing = undefined;
    }
    context[config.contextKey] = own;
    return context;
  }
  function post(message) {
    const target = io.frame.contentWindow;
    if (target)
      target.postMessage(message, "*");
  }
  function reply(id, result) {
    post({ jsonrpc: "2.0", id, result });
  }
  function fail(id, code, message) {
    post({ jsonrpc: "2.0", id, error: { code, message } });
  }
  function refused(text) {
    return { isError: true, content: [{ type: "text", text }] };
  }
  function localTarget(url) {
    const base = config.openBase;
    if (url.href.indexOf(base) !== 0)
      return "";
    const path = url.pathname.slice(new URL(base).pathname.length).replace(/\/$/, "");
    return Object.prototype.hasOwnProperty.call(config.openTargets, path) ? config.openTargets[path] : "";
  }
  function openLink(raw) {
    if (typeof raw !== "string")
      return false;
    const local = Object.keys(config.links).some((key) => config.links[key] === raw);
    if (local) {
      io.openUrl(raw);
      return true;
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" || url.username || url.password)
      return false;
    io.openUrl(localTarget(url) || url.href);
    return true;
  }
  function callTool(id, params) {
    const name = params && typeof params.name === "string" ? params.name : "";
    const args = params && params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    if (config.tools.indexOf(name) < 0) {
      reply(id, refused("This tool is not available here."));
      return;
    }
    if (readOnly && name !== config.readTool) {
      reply(id, refused("Open dashboard controls first."));
      return;
    }
    io.callTool(name, args).then((result) => reply(id, result), () => reply(id, refused("Could not reach Olympus.")));
  }
  function onMessage(event) {
    if (event.source !== io.frame.contentWindow)
      return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string")
      return;
    const id = message.id;
    const params = message.params;
    switch (message.method) {
      case "ui/initialize":
        reply(id, {
          protocolVersion: params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2026-01-26",
          hostInfo: { name: "olympus", version: "1" },
          hostCapabilities: { openLinks: {}, serverTools: {} },
          hostContext: hostContext(true)
        });
        return;
      case "tools/call":
        callTool(id, params);
        return;
      case "ui/open-link":
        if (openLink(params && params.url))
          reply(id, {});
        else
          fail(id, -32602, "That link cannot be opened.");
        return;
      case "ui/request-display-mode":
        reply(id, { mode: "fullscreen" });
        return;
      case "ui/notifications/size-changed":
        if (io.resize && params && typeof params.height === "number" && Number.isFinite(params.height))
          io.resize(params.height);
        return;
      default:
        if (id !== undefined)
          fail(id, -32601, "Method not found.");
    }
  }
  function onTheme() {
    post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: hostContext() });
  }
  view.addEventListener("message", onMessage);
  if (media && typeof media.addEventListener === "function")
    media.addEventListener("change", onTheme);
  return {
    lock() {
      if (readOnly)
        return;
      readOnly = true;
      onTheme();
    },
    dispose() {
      view.removeEventListener("message", onMessage);
      if (media && typeof media.removeEventListener === "function")
        media.removeEventListener("change", onTheme);
    }
  };
}

// src/core/open-targets.ts
var OPEN_PAGE_BASE_URL = "https://olympusplugin.ai/open/";

// src/control-ui.ts
function renderState(root, message) {
  const state = document.createElement("div");
  state.className = "native-state";
  state.setAttribute("role", "status");
  state.textContent = message;
  root.replaceChildren(state);
}
function connectionKey(host) {
  return `${host.connection.connected}:${host.connection.canRead}:${host.connection.canWrite}`;
}
function createDashboardPage() {
  return {
    id: "dashboard",
    label: "Olympus",
    mount(container, initialContext) {
      const shadow = container.shadowRoot ?? container.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = OLYMPUS_CONTROL_UI_CSS;
      const root = document.createElement("div");
      root.className = "olympus-control-ui";
      shadow.replaceChildren(style, root);
      let context = initialContext;
      let bridge;
      let shown = "";
      let disposed = false;
      function show() {
        const key = connectionKey(context.host);
        if (key === shown)
          return;
        shown = key;
        bridge?.dispose();
        bridge = undefined;
        if (!context.host.connection.connected) {
          renderState(root, "Connect to the OpenClaw Gateway to open Olympus.");
          return;
        }
        if (!context.host.connection.canRead) {
          renderState(root, "This OpenClaw connection does not have operator.read access.");
          return;
        }
        const frame = document.createElement("iframe");
        frame.className = "olympus-panel";
        frame.title = "Olympus dashboard";
        frame.setAttribute("sandbox", "allow-scripts");
        bridge = dashboardHostBridge({
          contextKey: OLYMPUS_HOST_CONTEXT_KEY,
          kind: "openclaw",
          readOnly: !context.host.connection.canWrite,
          links: {},
          tools: PANEL_TOOL_NAMES,
          readTool: DASHBOARD_TOOL_NAME,
          openTargets: {},
          openBase: OPEN_PAGE_BASE_URL
        }, {
          frame,
          callTool: (name, args) => context.host.request(OLYMPUS_DASHBOARD_TOOL_METHOD, { name, arguments: args }),
          openUrl(url) {
            window.open(url, "_blank", "noopener");
          }
        });
        frame.src = OLYMPUS_DASHBOARD_PANEL_PATH;
        root.replaceChildren(frame);
      }
      const unsubscribe = initialContext.host.subscribe(() => {
        if (!disposed)
          show();
      });
      show();
      return {
        update(nextContext) {
          context = nextContext;
          show();
        },
        focus() {
          root.querySelector("iframe")?.focus();
        },
        dispose() {
          if (disposed)
            return;
          disposed = true;
          bridge?.dispose();
          unsubscribe();
          shadow.replaceChildren();
        }
      };
    }
  };
}
var plugin = {
  id: "olympus",
  activate(host) {
    const disposePage = host.ui.registerPage(createDashboardPage());
    const disposeNavigation = host.ui.registerNavigation({
      id: "dashboard",
      label: "Olympus",
      page: { id: "dashboard" },
      icon: "database",
      order: 40
    });
    return () => {
      disposeNavigation();
      disposePage();
    };
  }
};
var control_ui_default = plugin;
export {
  control_ui_default as default
};
