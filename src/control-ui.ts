/**
 * The Olympus tab in OpenClaw's Control UI (unified dashboard phase 4, owner
 * decision 2026-10-09: the ChatGPT panel is the only dashboard).
 *
 * The tab frames the same panel ChatGPT loads (`ui://olympus/dashboard`),
 * served by the Gateway at OLYMPUS_DASHBOARD_PANEL_PATH, and answers its
 * calls like ChatGPT's host does (workers/dashboard/host-bridge.ts): its
 * tools go to the Gateway method OLYMPUS_DASHBOARD_TOOL_METHOD under the
 * operator's own scopes, and its links open a tab.
 *
 * The frame is a Gateway HTTP route rather than srcdoc or a blob because the
 * Control UI's own policy (script-src limited to its hashes) would bind a
 * srcdoc or blob frame; a route answers with a policy of its own.
 */
import {
  OLYMPUS_DASHBOARD_PANEL_PATH,
  OLYMPUS_DASHBOARD_TOOL_METHOD,
} from './control-ui-contract.ts';
import { OLYMPUS_CONTROL_UI_CSS } from './control-ui/styles.ts';
import { DASHBOARD_TOOL_NAME, OLYMPUS_HOST_CONTEXT_KEY, PANEL_TOOL_NAMES } from './workers/chatgpt/dashboard-contract.ts';
import { dashboardHostBridge, type DashboardHostBridge } from './workers/dashboard/host-bridge.ts';
import { OPEN_PAGE_BASE_URL } from './core/open-targets.ts';

type ControlUiPageTarget = {
  id: string;
  params?: Readonly<Record<string, string>>;
};

type ControlUiContext = {
  host: ControlUiHost;
  signal: AbortSignal;
  props: Readonly<Record<string, string>>;
  presented: boolean;
};

type ControlUiHost = {
  readonly connection: { connected: boolean; canRead: boolean; canWrite: boolean };
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  subscribe(listener: () => void): () => void;
  navigation: {
    openPage(target: ControlUiPageTarget, options?: { replace?: boolean }): void;
    pageHref(target: ControlUiPageTarget): string;
  };
  ui: {
    registerPage(page: {
      id: string;
      label: string;
      mount(container: HTMLElement, context: ControlUiContext): {
        update(context: ControlUiContext): void;
        focus(): void;
        dispose(): void;
      };
    }): () => void;
    registerNavigation(item: {
      id: string;
      label: string;
      page: ControlUiPageTarget;
      icon?: string;
      order?: number;
    }): () => void;
  };
};

function renderState(root: HTMLElement, message: string): void {
  const state = document.createElement('div');
  state.className = 'native-state';
  state.setAttribute('role', 'status');
  state.textContent = message;
  root.replaceChildren(state);
}

function connectionKey(host: ControlUiHost): string {
  return `${host.connection.connected}:${host.connection.canRead}:${host.connection.canWrite}`;
}

function createDashboardPage() {
  return {
    id: 'dashboard',
    label: 'Olympus',
    mount(container: HTMLElement, initialContext: ControlUiContext) {
      const shadow = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = OLYMPUS_CONTROL_UI_CSS;
      const root = document.createElement('div');
      root.className = 'olympus-control-ui';
      shadow.replaceChildren(style, root);

      let context = initialContext;
      let bridge: DashboardHostBridge | undefined;
      let shown = '';
      let disposed = false;

      function show(): void {
        const key = connectionKey(context.host);
        if (key === shown) return;
        shown = key;
        bridge?.dispose();
        bridge = undefined;
        if (!context.host.connection.connected) {
          renderState(root, 'Connect to the OpenClaw Gateway to open Olympus.');
          return;
        }
        if (!context.host.connection.canRead) {
          renderState(root, 'This OpenClaw connection does not have operator.read access.');
          return;
        }
        const frame = document.createElement('iframe');
        frame.className = 'olympus-panel';
        frame.title = 'Olympus dashboard';
        // Scripts only: an opaque origin that reaches nothing of this page
        // and talks only through postMessage.
        frame.setAttribute('sandbox', 'allow-scripts');
        bridge = dashboardHostBridge({
          contextKey: OLYMPUS_HOST_CONTEXT_KEY,
          kind: 'openclaw',
          // operator.read without operator.write: the panel shows, every control waits.
          readOnly: !context.host.connection.canWrite,
          links: {},
          tools: PANEL_TOOL_NAMES,
          readTool: DASHBOARD_TOOL_NAME,
          openTargets: {},
          openBase: OPEN_PAGE_BASE_URL,
        }, {
          frame,
          callTool: (name, args) => context.host.request(OLYMPUS_DASHBOARD_TOOL_METHOD, { name, arguments: args }),
          openUrl(url) {
            window.open(url, '_blank', 'noopener');
          },
        });
        frame.src = OLYMPUS_DASHBOARD_PANEL_PATH;
        root.replaceChildren(frame);
      }

      const unsubscribe = initialContext.host.subscribe(() => {
        if (!disposed) show();
      });
      show();

      return {
        update(nextContext: ControlUiContext): void {
          context = nextContext;
          show();
        },
        focus(): void {
          root.querySelector<HTMLElement>('iframe')?.focus();
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          bridge?.dispose();
          unsubscribe();
          shadow.replaceChildren();
        },
      };
    },
  };
}

const plugin = {
  id: 'olympus',
  activate(host: ControlUiHost) {
    const disposePage = host.ui.registerPage(createDashboardPage());
    const disposeNavigation = host.ui.registerNavigation({
      id: 'dashboard',
      label: 'Olympus',
      page: { id: 'dashboard' },
      icon: 'database',
      order: 40,
    });
    return () => {
      disposeNavigation();
      disposePage();
    };
  },
};

export default plugin;
