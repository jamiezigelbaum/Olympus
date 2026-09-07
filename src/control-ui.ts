import {
  OLYMPUS_DASHBOARD_CONTROL_METHOD,
  OLYMPUS_DASHBOARD_READ_METHOD,
  type OlympusDashboardControlParams,
  type OlympusDashboardControlResult,
  type OlympusDashboardReadParams,
  type OlympusDashboardReadResult,
} from './control-ui-contract.ts';
import {
  mountDashboardController,
  mountDispositionsController,
  type OlympusBrowserController,
} from './control-ui/browser-controller.ts';
import { OLYMPUS_CONTROL_UI_CSS } from './control-ui/styles.ts';

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

function routeFromProps(props: Readonly<Record<string, string>>): OlympusDashboardReadParams {
  const view = props.view;
  if (view === 'setup' || view === 'background' || view === 'embedding_ledger'
    || view === 'sensitivity' || view === 'dispositions') return { view };
  if (view === 'source' && props.source_id) return { view, source_id: props.source_id };
  return { view: 'home' };
}

function routeFromHref(href: string): OlympusDashboardReadParams | undefined {
  if (!href.startsWith('/dashboard') || href.startsWith('//')) return undefined;
  let url: URL;
  try { url = new URL(href, 'https://olympus.invalid'); } catch { return undefined; }
  if (url.pathname === '/dashboard/dispositions') return { view: 'dispositions' };
  if (url.pathname !== '/dashboard') return undefined;
  const sourceId = url.searchParams.get('source');
  if (sourceId) return { view: 'source', source_id: sourceId };
  if (url.searchParams.has('setup')) return { view: 'setup' };
  if (url.searchParams.has('background')) return { view: 'background' };
  if (url.searchParams.has('embedding-ledger')) return { view: 'embedding_ledger' };
  if (url.searchParams.has('sensitivity')) return { view: 'sensitivity' };
  return { view: 'home' };
}

function targetFor(route: OlympusDashboardReadParams): ControlUiPageTarget {
  return {
    id: 'dashboard',
    params: {
      view: route.view,
      ...(route.source_id ? { source_id: route.source_id } : {}),
    },
  };
}

/** Returned HTML is server-owned but still crosses a process boundary. */
export function setInertBody(root: HTMLElement | ShadowRoot, html: string): void {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script,style,link,meta,base,iframe,object,embed').forEach((node) => node.remove());
  template.content.querySelectorAll('*').forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'action' || name === 'formaction') {
        node.removeAttribute(attribute.name);
      } else if ((name === 'href' || name === 'src') && (value.startsWith('javascript:') || value.startsWith('data:'))) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  root.replaceChildren(template.content.cloneNode(true));
}

function rewriteInternalLinks(root: HTMLElement | ShadowRoot, host: ControlUiHost): void {
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    const route = routeFromHref(href);
    if (!route) return;
    anchor.dataset.olympusNav = href;
    anchor.href = host.navigation.pageHref(targetFor(route));
  });
}

function renderState(root: HTMLElement, message: string): void {
  const state = document.createElement('div');
  state.className = 'native-state';
  state.setAttribute('role', 'status');
  state.textContent = message;
  root.replaceChildren(state);
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

      const lifetime = new AbortController();
      let context = initialContext;
      let route = routeFromProps(context.props);
      let controller: OlympusBrowserController | undefined;
      let generation = 0;
      let disposed = false;
      let connectionSnapshot = `${initialContext.host.connection.connected}:${initialContext.host.connection.canRead}:${initialContext.host.connection.canWrite}`;

      const abort = () => lifetime.abort();
      initialContext.signal.addEventListener('abort', abort, { once: true });

      const read = (): Promise<OlympusDashboardReadResult> => context.host.request(
        OLYMPUS_DASHBOARD_READ_METHOD,
        { ...route },
      );

      const control = (params: OlympusDashboardControlParams): Promise<OlympusDashboardControlResult> =>
        context.host.request(OLYMPUS_DASHBOARD_CONTROL_METHOD, params as unknown as Record<string, unknown>);

      const navigate = (href: string): void => {
        const next = routeFromHref(href);
        if (!next) return;
        context.host.navigation.openPage(targetFor(next));
      };

      async function load(): Promise<void> {
        const currentGeneration = ++generation;
        controller?.dispose();
        controller = undefined;
        if (!context.host.connection.connected) {
          renderState(root, 'Connect to the OpenClaw Gateway to open Olympus.');
          return;
        }
        if (!context.host.connection.canRead) {
          renderState(root, 'This OpenClaw connection does not have operator.read access.');
          return;
        }
        renderState(root, 'Loading Olympus…');
        try {
          const result = await read();
          if (disposed || lifetime.signal.aborted || currentGeneration !== generation) return;
          if (result.status < 200 || result.status >= 300) {
            renderState(root, 'Olympus could not load this page.');
            return;
          }
          setInertBody(root, result.body);
          rewriteInternalLinks(root, context.host);
          const mount = result.controller === 'dispositions'
            ? mountDispositionsController
            : mountDashboardController;
          controller = mount({
            root,
            transport: { control },
            navigate,
            refresh: read,
            returnUrl: context.host.navigation.pageHref(targetFor(route)),
            canWrite: result.can_write,
            authority: 'gateway',
            replaceHtml(nextRoot, html) {
              setInertBody(nextRoot, html);
              rewriteInternalLinks(nextRoot, context.host);
            },
            presented: context.presented,
            signal: lifetime.signal,
            signature: result.signature,
            pollIntervalMs: result.poll_interval_ms,
          });
        } catch {
          if (!disposed && currentGeneration === generation) {
            renderState(root, 'Olympus could not reach its private source worker.');
          }
        }
      }

      const unsubscribe = initialContext.host.subscribe(() => {
        if (disposed) return;
        const next = `${context.host.connection.connected}:${context.host.connection.canRead}:${context.host.connection.canWrite}`;
        if (next === connectionSnapshot) return;
        const [wasConnected, couldRead, couldWrite] = connectionSnapshot.split(':');
        connectionSnapshot = next;
        const connectionChanged = wasConnected !== String(context.host.connection.connected)
          || couldRead !== String(context.host.connection.canRead);
        if (connectionChanged) {
          void load();
          return;
        }
        if (couldWrite !== String(context.host.connection.canWrite)) {
          controller?.update({ canWrite: context.host.connection.canWrite, presented: context.presented });
          // Non-forced refresh respects dirty inputs and folder edits.
          void controller?.refresh();
        }
      });
      void load();

      return {
        update(nextContext: ControlUiContext): void {
          context = nextContext;
          const nextRoute = routeFromProps(nextContext.props);
          const changed = JSON.stringify(nextRoute) !== JSON.stringify(route);
          route = nextRoute;
          if (changed) void load();
          else controller?.update({
            canWrite: nextContext.host.connection.canWrite,
            presented: nextContext.presented,
          });
        },
        focus(): void {
          root.querySelector<HTMLElement>('a,button,input,summary,[tabindex]')?.focus();
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          generation += 1;
          controller?.dispose();
          unsubscribe();
          initialContext.signal.removeEventListener('abort', abort);
          lifetime.abort();
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
      page: { id: 'dashboard', params: { view: 'home' } },
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
