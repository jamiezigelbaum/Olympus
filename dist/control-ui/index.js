// src/control-ui-contract.ts
var OLYMPUS_DASHBOARD_READ_METHOD = "olympus.dashboard.read";
var OLYMPUS_DASHBOARD_CONTROL_METHOD = "olympus.dashboard.control";

// src/control-ui/browser-controller.ts
function mountDashboardController(options) {
  let canWrite = options.canWrite;
  let csrfToken = options.csrfToken || "";
  let signature = options.signature || "";
  let pollIntervalMs = options.pollIntervalMs || 15000;
  let interval;
  let inFlight = false;
  let disposed = false;
  let deferredSince = 0;
  let presented = options.presented !== false;
  const root = options.root;
  const oauthSubmittedValues = new WeakMap;
  function query(selector) {
    return root.querySelector(selector);
  }
  function queryAll(selector) {
    return Array.from(root.querySelectorAll(selector));
  }
  function say(form, message) {
    const slot = form.querySelector("[data-action-message]");
    if (slot)
      slot.textContent = message;
  }
  function errorMessage(result) {
    const error = result.body.error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = error.message;
      if (typeof message === "string" && message.trim() !== "")
        return message;
    }
    return "Request failed.";
  }
  function applyWriteCapability() {
    root.querySelectorAll("form[data-connect-kind],form[data-sync-kind],form[data-embedding-kind]," + "form[data-disconnect-kind],form[data-unpair-kind]").forEach((form) => {
      form.querySelectorAll('button,input:not([type="hidden"])').forEach((control) => {
        if (control.dataset.olympusOriginallyDisabled === undefined) {
          control.dataset.olympusOriginallyDisabled = control.disabled ? "true" : "false";
        }
        const oauthUnavailable = form.hasAttribute("data-native-oauth-unavailable");
        if (!canWrite || oauthUnavailable) {
          control.disabled = true;
          control.setAttribute("aria-disabled", "true");
        } else {
          control.disabled = control.dataset.olympusOriginallyDisabled === "true";
          if (!control.disabled)
            control.removeAttribute("aria-disabled");
        }
      });
    });
  }
  function clearAuthorizationFallback(form) {
    const slot = form.querySelector("[data-authorization-fallback]");
    if (slot)
      slot.textContent = "";
  }
  function showAuthorizationFallback(form, url) {
    const slot = form.querySelector("[data-authorization-fallback]");
    if (!slot || !url.startsWith("https://"))
      return;
    slot.textContent = "";
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "hint";
    link.textContent = "If a new tab didn't open, open it here";
    slot.appendChild(link);
  }
  function nativeExternalLinkPoster() {
    try {
      const handler = window.webkit?.messageHandlers?.openclawLink;
      if (!handler || typeof handler.postMessage !== "function")
        return;
      return handler.postMessage.bind(handler);
    } catch {
      return;
    }
  }
  function openAuthorizationExternally(url) {
    const postMessage = nativeExternalLinkPoster();
    if (!postMessage)
      return false;
    try {
      postMessage({ type: "open-link", url: new URL(url).href, target: "external" });
      return true;
    } catch {
      return false;
    }
  }
  function openAuthorizationTab() {
    if (nativeExternalLinkPoster())
      return null;
    let tab = null;
    try {
      tab = window.open("", "_blank");
    } catch {
      tab = null;
    }
    if (tab) {
      try {
        tab.opener = null;
      } catch {}
    }
    return tab;
  }
  function closeAuthorizationTab(tab) {
    if (!tab)
      return;
    try {
      tab.close();
    } catch {}
  }
  function formRecord(form) {
    return Object.fromEntries(Array.from(new FormData(form).entries()).filter((entry) => typeof entry[1] === "string"));
  }
  function sameFormRecord(form, expected) {
    const actual = formRecord(form);
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    return [...keys].every((key) => actual[key] === expected[key]);
  }
  function releaseSubmittedOAuthPanel(form, submittedValues) {
    const sheet = form.closest(".sheet");
    const unchanged = submittedValues !== undefined && sameFormRecord(form, submittedValues);
    if (!unchanged)
      return false;
    form.reset();
    const active = activeElement();
    if (sheet) {
      sheet.classList.remove("on");
      sheet.setAttribute("aria-hidden", "true");
      if (sheet.id) {
        queryAll("[data-sheet-toggle]").forEach((toggle) => {
          if (toggle.dataset.sheetToggle === `#${sheet.id}`) {
            toggle.setAttribute("aria-expanded", "false");
          }
        });
      }
    }
    if (active && (active === form || form.contains(active)) && active instanceof HTMLElement) {
      active.blur();
    }
    return true;
  }
  function controlParams(form) {
    const body = formRecord(form);
    const connect = form.dataset.connectKind;
    if (connect === "oauth") {
      return {
        action: "start_oauth",
        source: body.source,
        ...body.client_id ? { client_id: body.client_id } : {},
        ...body.client_secret ? { client_secret: body.client_secret } : {}
      };
    }
    if (connect === "oauth_cancel") {
      return {
        action: "cancel_oauth",
        source: body.source
      };
    }
    if (connect === "api_key") {
      return {
        action: "connect_api_key",
        source: body.source,
        api_key: body.api_key || ""
      };
    }
    if (form.hasAttribute("data-sync-kind")) {
      return {
        action: "sync_now",
        source: body.source
      };
    }
    if (form.hasAttribute("data-embedding-kind")) {
      return { action: "set_embedding_priority", on: body.on === "true" };
    }
    if (form.hasAttribute("data-disconnect-kind")) {
      return {
        action: "disconnect",
        source_id: body.source_id,
        acknowledge: true
      };
    }
    if (form.hasAttribute("data-unpair-kind")) {
      return {
        action: "unpair",
        source_id: body.source_id,
        acknowledge: true
      };
    }
    return;
  }
  async function unlock(form) {
    const field = form.querySelector("[data-dashboard-control-token]");
    const pasted = field?.value.trim() || "";
    if (!pasted) {
      say(form, "Paste the worker bearer token.");
      field?.focus();
      return;
    }
    if (pasted.startsWith("dash_")) {
      say(form, "That is the read-only view token; use the worker bearer token from setup.");
      field.value = "";
      field?.focus();
      return;
    }
    if (!options.transport.unlock)
      return;
    say(form, "Unlocking…");
    const result = await options.transport.unlock(pasted);
    field.value = "";
    if (!result.ok || !result.csrf_token) {
      say(form, "That token was not accepted.");
      return;
    }
    csrfToken = result.csrf_token;
    canWrite = true;
    applyWriteCapability();
    await refreshNow(true);
  }
  async function lock(form) {
    if (!options.transport.lock)
      return;
    say(form, "Locking…");
    if (!await options.transport.lock()) {
      say(form, "Could not lock.");
      return;
    }
    csrfToken = "";
    canWrite = false;
    applyWriteCapability();
    await refreshNow(true);
  }
  async function submitControl(form, authorizationTab, submittedValues) {
    if (!canWrite && !csrfToken) {
      closeAuthorizationTab(authorizationTab);
      say(form, "Your OpenClaw connection has read-only access.");
      return;
    }
    const params = controlParams(form);
    if (!params) {
      closeAuthorizationTab(authorizationTab);
      return;
    }
    if (params.action === "disconnect" || params.action === "unpair") {
      const fallback = params.action === "unpair" ? "Unpair this source?" : "Disconnect this source?";
      if (!window.confirm(form.dataset.confirmation || fallback)) {
        closeAuthorizationTab(authorizationTab);
        return;
      }
    }
    if (params.action === "start_oauth")
      clearAuthorizationFallback(form);
    say(form, "Starting…");
    try {
      const result = await options.transport.control(params);
      if (result.status === 401 || result.status === 403) {
        closeAuthorizationTab(authorizationTab);
        if (options.authority === "worker-session") {
          csrfToken = "";
          say(form, "The control session expired — unlock controls in Setup, then try again.");
        } else {
          canWrite = false;
          applyWriteCapability();
          say(form, "Your write access expired. Reconnect with operator.write access, then try again.");
        }
        return;
      }
      const authorizationUrl = result.body.authorization_url;
      if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
        closeAuthorizationTab(authorizationTab);
        say(form, errorMessage(result));
        return;
      }
      if (typeof authorizationUrl === "string" && authorizationUrl.startsWith("https://")) {
        if (authorizationTab) {
          authorizationTab.location.href = authorizationUrl;
          say(form, "Authorization opened in a new tab. Approve it there, then come back to Olympus.");
          if (releaseSubmittedOAuthPanel(form, submittedValues))
            refreshNow(false, true);
        } else if (openAuthorizationExternally(authorizationUrl)) {
          say(form, "Authorization opened in your default browser. Approve it there, then come back to Olympus.");
          if (releaseSubmittedOAuthPanel(form, submittedValues))
            refreshNow(false, true);
        } else {
          say(form, "Open the authorization page to continue.");
          showAuthorizationFallback(form, authorizationUrl);
        }
        return;
      }
      closeAuthorizationTab(authorizationTab);
      form.reset();
      const statusMessage = result.body.status_message;
      say(form, typeof statusMessage === "string" ? statusMessage : "Done. Waiting for the next refresh.");
      await refreshNow(false);
    } catch {
      closeAuthorizationTab(authorizationTab);
      say(form, "Could not reach Olympus.");
    }
  }
  function copyText(node) {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
      return node.value;
    return node.innerText || node.textContent || "";
  }
  function announceCopy(button, message) {
    const status = button.parentElement?.querySelector("[data-copy-status]");
    if (status)
      status.textContent = message;
  }
  function focusKey(node) {
    if (!node || node === root)
      return "";
    if (node.id)
      return `#${node.id}`;
    const action = node.getAttribute("data-connect-kind") || node.getAttribute("data-sync-kind") || node.getAttribute("data-embedding-kind") || node.getAttribute("data-disconnect-kind") || node.getAttribute("data-unpair-kind");
    if (action)
      return `${node.tagName}:${action}`;
    return node.textContent?.trim().slice(0, 120) || "";
  }
  function findByFocusKey(key) {
    if (!key)
      return null;
    if (key.startsWith("#"))
      return query(`#${CSS.escape(key.slice(1))}`);
    return queryAll("a,button,summary,[tabindex]").find((node) => focusKey(node) === key) || null;
  }
  function activeElement() {
    const tree = root.getRootNode();
    if (tree instanceof ShadowRoot)
      return tree.activeElement;
    return root.ownerDocument.activeElement;
  }
  function hasDirtyInput() {
    return queryAll('input:not([type="hidden"]),textarea,select').some((field) => field instanceof HTMLSelectElement ? Array.from(field.options).some((option) => option.selected !== option.defaultSelected) : field.value !== field.defaultValue);
  }
  function hasFocusedControl() {
    const active = activeElement();
    return active !== null && root.contains(active);
  }
  function replaceBody(result, force) {
    canWrite = result.can_write;
    if (!force && result.signature === signature) {
      const next = document.createElement("template");
      next.innerHTML = result.body;
      const meta = query(".top .meta");
      const nextMeta = next.content.querySelector(".top .meta");
      if (meta && nextMeta)
        meta.textContent = nextMeta.textContent;
      applyWriteCapability();
      return;
    }
    const open = new Set(queryAll("details[open]").map((node) => node.dataset.pollKey || node.querySelector("summary")?.textContent?.trim() || ""));
    const active = activeElement();
    const focused = focusKey(active);
    if (options.replaceHtml)
      options.replaceHtml(root, result.body);
    else
      root.innerHTML = result.body;
    queryAll("details").forEach((node) => {
      const key = node.dataset.pollKey || node.querySelector("summary")?.textContent?.trim() || "";
      if (open.has(key))
        node.open = true;
    });
    findByFocusKey(focused)?.focus();
    signature = result.signature;
    pollIntervalMs = result.poll_interval_ms;
    deferredSince = 0;
    applyWriteCapability();
  }
  async function refreshNow(force, requested = false) {
    if (disposed || inFlight || options.signal.aborted || !force && !presented)
      return;
    const ownerDocument = root.ownerDocument;
    if (!force && !requested && ownerDocument.visibilityState === "hidden")
      return;
    if (!force && query(".sheet.on"))
      return;
    if (!force && hasDirtyInput())
      return;
    if (!force && hasFocusedControl()) {
      if (deferredSince === 0)
        deferredSince = Date.now();
      if (Date.now() - deferredSince < 120000)
        return;
    }
    inFlight = true;
    try {
      const result = await options.refresh();
      if (!result || disposed || options.signal.aborted)
        return;
      if (!force && (hasDirtyInput() || hasFocusedControl())) {
        canWrite = result.can_write;
        applyWriteCapability();
        return;
      }
      replaceBody(result, force);
    } catch {} finally {
      inFlight = false;
    }
  }
  function restartPoll() {
    if (interval)
      clearInterval(interval);
    interval = pollIntervalMs > 0 ? setInterval(() => {
      refreshNow(false);
    }, pollIntervalMs) : undefined;
  }
  function onSubmit(event) {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !root.contains(form))
      return;
    if (form.hasAttribute("data-control-session-kind")) {
      event.preventDefault();
      if (form.dataset.controlSessionKind === "lock")
        lock(form);
      else
        unlock(form);
      return;
    }
    if (!form.matches("[data-connect-kind],[data-sync-kind],[data-embedding-kind],[data-disconnect-kind],[data-unpair-kind]"))
      return;
    event.preventDefault();
    const submittedValues = form.dataset.connectKind === "oauth" ? formRecord(form) : undefined;
    if (submittedValues)
      oauthSubmittedValues.set(form, submittedValues);
    const tab = form.dataset.connectKind === "oauth" ? openAuthorizationTab() : null;
    submitControl(form, tab, submittedValues);
  }
  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target))
      return;
    const toggle = target.closest("[data-sheet-toggle]");
    if (toggle) {
      const selector = toggle.dataset.sheetToggle;
      const sheet = selector ? query(selector) : null;
      if (!sheet)
        return;
      const open = sheet.classList.toggle("on");
      sheet.setAttribute("aria-hidden", open ? "false" : "true");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      return;
    }
    const copy = target.closest("[data-copy-target]");
    if (copy) {
      const selector = copy.dataset.copyTarget;
      const source = selector ? query(selector) : null;
      if (!source)
        return;
      const label = copy.textContent || "";
      if (!navigator.clipboard) {
        announceCopy(copy, "Clipboard unavailable — select the text and copy it with your keyboard.");
        return;
      }
      navigator.clipboard.writeText(copyText(source)).then(() => {
        copy.textContent = "Copied";
        announceCopy(copy, "Copied to the clipboard.");
        setTimeout(() => {
          if (!disposed)
            copy.textContent = label;
        }, 1600);
      }).catch(() => {
        announceCopy(copy, "Clipboard unavailable — select the text and copy it with your keyboard.");
      });
      return;
    }
    const controlLink = target.closest("[data-control-link]");
    if (controlLink) {
      event.preventDefault();
      if (!canWrite && !csrfToken) {
        say(controlLink.closest(".rowlink") || controlLink, "Your OpenClaw connection has read-only access.");
        return;
      }
      const href2 = controlLink.dataset.controlLink;
      if (href2)
        options.navigate(href2);
      return;
    }
    const anchor = target.closest("a[href]");
    if (!anchor)
      return;
    const fallback = target.closest("[data-authorization-fallback] a");
    if (fallback) {
      const form = fallback.closest('form[data-connect-kind="oauth"]');
      const submittedValues = form ? oauthSubmittedValues.get(form) : undefined;
      if (form && submittedValues) {
        setTimeout(() => {
          if (disposed || !releaseSubmittedOAuthPanel(form, submittedValues))
            return;
          refreshNow(false, true);
        }, 0);
      }
      return;
    }
    const href = anchor.dataset.olympusNav || anchor.getAttribute("href") || "";
    const modified = event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
    if (href.startsWith("/dashboard") && !modified) {
      event.preventDefault();
      options.navigate(href);
    }
  }
  root.addEventListener("submit", onSubmit);
  root.addEventListener("click", onClick);
  applyWriteCapability();
  restartPoll();
  const dispose = () => {
    if (disposed)
      return;
    disposed = true;
    if (interval)
      clearInterval(interval);
    root.removeEventListener("submit", onSubmit);
    root.removeEventListener("click", onClick);
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  return {
    refresh: () => refreshNow(false, true),
    update(input) {
      canWrite = input.canWrite;
      if (input.presented !== undefined)
        presented = input.presented;
      if (input.signature !== undefined)
        signature = input.signature;
      if (input.pollIntervalMs !== undefined && input.pollIntervalMs !== pollIntervalMs) {
        pollIntervalMs = input.pollIntervalMs;
        restartPoll();
      }
      applyWriteCapability();
    },
    dispose
  };
}
function mountDispositionsController(options) {
  let canWrite = options.canWrite;
  let signature = options.signature || "";
  let disposed = false;
  let dirty = false;
  let inFlight = false;
  let presented = options.presented !== false;
  let interval;
  let renewalInterval;
  let lastActivityMs = 0;
  let lastRenewalMs = Date.now();
  let appliedCanWrite;
  const root = options.root;
  const labels = {
    ingest: "Full ingestion",
    metadata_only: "Metadata only",
    exclude: "No ingestion"
  };
  const scopeDrafts = new Map;
  function scopeMessage(form, text) {
    const slot = form.querySelector("[data-scope-message]");
    if (slot)
      slot.textContent = text;
  }
  function scopeDraft(form) {
    let draft = scopeDrafts.get(form);
    if (!draft) {
      draft = {
        generation: form.dataset.accountGeneration || "",
        revision: form.dataset.scopeRevision || "",
        selections: new Map,
        names: new Map,
        ancestors: new Map,
        nodes: [],
        catalog: new Map,
        branches: new Map,
        branchCursors: new Map,
        expanded: new Set,
        loaded: false,
        busy: false,
        invalid: false,
        edited: false,
        whole: form.querySelector("[data-scope-whole-account]")?.checked === true
      };
      scopeDrafts.set(form, draft);
    }
    return draft;
  }
  function scopeAllowed(form, draft) {
    return canWrite && form.dataset.connected === "true" && !draft.busy && !draft.invalid;
  }
  function inheritedScopeState(draft, key) {
    let state = draft.whole ? "ingest" : undefined;
    for (const ancestor of draft.ancestors.get(key) || []) {
      const choice = draft.selections.get(ancestor);
      if (choice === "exclude")
        return "exclude";
      if (choice === "metadata_only")
        state = "metadata_only";
      else if (choice === "ingest" && state === undefined)
        state = "ingest";
    }
    return state;
  }
  function effectiveScopeState(draft, key) {
    const inherited = inheritedScopeState(draft, key);
    const own = draft.selections.get(key);
    if (inherited === "exclude" || own === "exclude")
      return "exclude";
    if (inherited === "metadata_only")
      return "metadata_only";
    return own || inherited || "exclude";
  }
  function scopeChoiceAllowed(draft, state) {
    if (!draft.selected?.selectable)
      return false;
    const inherited = inheritedScopeState(draft, draft.selected.key);
    if (inherited === "exclude")
      return state === "exclude";
    if (inherited === "metadata_only")
      return state === "metadata_only" || state === "exclude";
    return state === "ingest" || state === "metadata_only" || state === "exclude";
  }
  function scopeControls(form, draft) {
    const allowed = scopeAllowed(form, draft);
    form.querySelectorAll("button").forEach((button) => {
      button.disabled = !allowed;
    });
    form.querySelectorAll("input").forEach((input) => {
      input.disabled = !allowed || !draft.loaded;
    });
    form.querySelectorAll("[data-scope-state]").forEach((button) => {
      button.disabled = !allowed || !scopeChoiceAllowed(draft, button.dataset.scopeState || "");
      button.classList.toggle("on", draft.selected !== undefined && effectiveScopeState(draft, draft.selected.key) === button.dataset.scopeState);
    });
    const hasSelection = Array.from(draft.selections.keys()).some((key) => effectiveScopeState(draft, key) !== "exclude");
    const confirmation = form.querySelector("[data-scope-whole-confirm]");
    const submit = form.querySelector("[data-scope-start]");
    if (submit)
      submit.disabled = !allowed || !draft.loaded || !draft.generation || !draft.revision || !draft.whole && !hasSelection && !draft.edited || draft.whole && confirmation?.checked !== true;
    if (submit)
      submit.textContent = draft.whole || hasSelection ? "Save scope and start" : "Save scope (no ingestion)";
    const cancel = form.querySelector("[data-scope-cancel]");
    if (cancel)
      cancel.disabled = draft.busy;
    const confirmationLabel = form.querySelector(".scope-whole-confirm");
    if (confirmationLabel)
      confirmationLabel.hidden = !draft.whole;
  }
  function renderScopeReview(form, draft) {
    const summary = form.querySelector("[data-scope-summary]");
    if (summary)
      summary.textContent = draft.whole ? "Entire account, including future folders, except the choices below." : `${Array.from(draft.selections.keys()).filter((key) => effectiveScopeState(draft, key) !== "exclude").length} folder(s) selected. All other folders stay out.`;
    const list = form.querySelector("[data-scope-selections]");
    if (list) {
      list.replaceChildren();
      for (const [key, state] of draft.selections) {
        const item = root.ownerDocument.createElement("li");
        item.textContent = `${labels[effectiveScopeState(draft, key)]} — ${draft.names.get(key) || key}`;
        list.appendChild(item);
      }
    }
    scopeControls(form, draft);
  }
  function updateScopeRows(form, draft) {
    form.querySelectorAll(".scope-folder").forEach((row) => {
      const key = row.querySelector("[data-scope-select]")?.dataset.scopeSelect;
      if (!key)
        return;
      row.classList.toggle("selected", draft.selected?.key === key);
      const status = row.querySelector(".scope-folder-status");
      const inherited = inheritedScopeState(draft, key);
      if (status)
        status.textContent = draft.selections.has(key) || inherited ? `${labels[effectiveScopeState(draft, key)]}${inherited ? " · inherited" : ""}` : "Not selected";
    });
    renderScopeReview(form, draft);
  }
  function scopeTrail(draft, key) {
    return [...draft.ancestors.get(key) || [], key].map((ancestor) => ({ key: ancestor, name: draft.catalog.get(ancestor)?.name || ancestor }));
  }
  function renderScopeNodes(form, draft) {
    const list = form.querySelector("[data-scope-nodes]");
    if (!list)
      return;
    list.replaceChildren();
    const appendNodes = (host, nodes, seen = new Set) => {
      for (const node of nodes) {
        if (seen.has(node.key))
          continue;
        const wrapper = root.ownerDocument.createElement("div");
        wrapper.className = "node";
        const row = root.ownerDocument.createElement("div");
        row.className = "folder-row scope-folder";
        row.setAttribute("role", "listitem");
        row.classList.toggle("selected", draft.selected?.key === node.key);
        const disclosure = root.ownerDocument.createElement(node.has_children ? "button" : "span");
        disclosure.className = "disclosure";
        if (disclosure instanceof HTMLButtonElement) {
          disclosure.type = "button";
          disclosure.dataset.scopeOpen = node.key;
          disclosure.textContent = draft.expanded.has(node.key) ? "▾" : "▸";
          disclosure.setAttribute("aria-label", `${draft.expanded.has(node.key) ? "Collapse" : "Expand"} ${node.name}`);
          disclosure.setAttribute("aria-expanded", String(draft.expanded.has(node.key)));
        }
        const select = root.ownerDocument.createElement("button");
        select.type = "button";
        select.dataset.scopeSelect = node.key;
        select.textContent = node.name;
        const status = root.ownerDocument.createElement("span");
        status.className = "scope-folder-status";
        const inherited = inheritedScopeState(draft, node.key);
        status.textContent = draft.selections.has(node.key) || inherited ? `${labels[effectiveScopeState(draft, node.key)]}${inherited ? " · inherited" : ""}` : "Not selected";
        const icon = root.ownerDocument.createElement("span");
        icon.className = "folder-icon";
        icon.textContent = "▰";
        row.append(disclosure, icon, select, status);
        wrapper.appendChild(row);
        if (draft.expanded.has(node.key)) {
          const children = root.ownerDocument.createElement("div");
          children.className = "children";
          children.setAttribute("role", "group");
          children.setAttribute("aria-label", node.name);
          appendNodes(children, draft.branches.get(node.key) || [], new Set([...seen, node.key]));
          if (draft.branchCursors.has(node.key)) {
            const more2 = root.ownerDocument.createElement("button");
            more2.type = "button";
            more2.dataset.scopeMore = node.key;
            more2.textContent = "Show more folders";
            children.appendChild(more2);
          }
          wrapper.appendChild(children);
        }
        host.appendChild(wrapper);
      }
    };
    appendNodes(list, draft.nodes);
    if (draft.nodes.length === 0) {
      const empty = root.ownerDocument.createElement("p");
      empty.textContent = "No folders returned in this page.";
      list.appendChild(empty);
    }
    const needle = form.querySelector("[data-scope-search]")?.value.trim().toLowerCase() || "";
    list.querySelectorAll(".scope-folder").forEach((row) => {
      row.hidden = !!needle && !(row.textContent || "").toLowerCase().includes(needle);
    });
    const more = form.querySelector('[data-scope-more=""]');
    if (more)
      more.hidden = !draft.nextCursor;
    renderScopeReview(form, draft);
  }
  async function browseScope(form, trail, append = false) {
    const draft = scopeDraft(form);
    if (!scopeAllowed(form, draft) || !options.transport.read)
      return;
    const parent = trail.at(-1)?.key;
    const cursor = append ? parent ? draft.branchCursors.get(parent) : draft.nextCursor : undefined;
    draft.busy = true;
    scopeControls(form, draft);
    scopeMessage(form, "Listing folder names…");
    try {
      const result = await options.transport.read({
        view: "dispositions",
        action: "browse_folder_scope",
        source_id: form.dataset.folderScopeSource,
        ...parent ? { parent_key: parent } : {},
        ...cursor ? { cursor } : {}
      });
      if (disposed || options.signal.aborted || !root.contains(form))
        return;
      if (result.status === 401 || result.status === 403 || !result.can_write) {
        canWrite = false;
        scopeMessage(form, "Write access expired. Reconnect before browsing private folders.");
        return;
      }
      const page = result.scope_browser;
      if (result.status < 200 || result.status >= 300 || !page || page.source_id !== form.dataset.folderScopeSource || !page.account_generation || !page.scope_revision || !Array.isArray(page.nodes) || page.nodes.some((node) => typeof node.key !== "string" || typeof node.name !== "string" || node.kind !== "folder" || typeof node.selectable !== "boolean")) {
        scopeMessage(form, "Could not list folders. Check the connection and reopen this picker.");
        return;
      }
      if (draft.loaded && (draft.generation !== page.account_generation || draft.revision !== page.scope_revision)) {
        draft.invalid = true;
        scopeMessage(form, "The account or saved scope changed. Reopen this picker before applying choices.");
        return;
      }
      if (!draft.loaded) {
        draft.generation = page.account_generation;
        draft.revision = page.scope_revision;
        draft.selections = new Map(page.selections.map((selection) => [selection.key, selection.state]));
        page.selections.forEach((selection) => draft.ancestors.set(selection.key, selection.ancestor_keys || []));
        draft.whole = page.whole_account_selected;
        const whole = form.querySelector("[data-scope-whole-account]");
        if (whole)
          whole.checked = draft.whole;
      }
      if (page.nodes.some((node) => trail.some((ancestor) => ancestor.key === node.key))) {
        scopeMessage(form, "The folder listing contains a cycle. Reopen the picker before continuing.");
        draft.invalid = true;
        return;
      }
      draft.loaded = true;
      const previous = parent ? draft.branches.get(parent) || [] : draft.nodes;
      const nodes = append ? [...previous, ...page.nodes.filter((node) => !previous.some((old) => old.key === node.key))] : page.nodes;
      if (parent) {
        draft.branches.set(parent, nodes);
        draft.expanded.add(parent);
        if (page.next_cursor)
          draft.branchCursors.set(parent, page.next_cursor);
        else
          draft.branchCursors.delete(parent);
      } else {
        draft.nodes = nodes;
        draft.nextCursor = page.next_cursor;
      }
      page.nodes.forEach((node) => {
        draft.catalog.set(node.key, node);
        draft.names.set(node.key, [...trail.map((entry) => entry.name), node.name].join(" / "));
        draft.ancestors.set(node.key, trail.map((entry) => entry.key));
      });
      renderScopeNodes(form, draft);
      scopeMessage(form, "Only folder names were listed. Review your choices, then save and start.");
    } catch {
      if (!disposed && root.contains(form))
        scopeMessage(form, "Folder browsing failed. Your choices are still here; retry when the connection is ready.");
    } finally {
      draft.busy = false;
      if (!disposed && root.contains(form))
        scopeControls(form, draft);
    }
  }
  async function approveScope(form) {
    const draft = scopeDraft(form);
    const confirmation = form.querySelector("[data-scope-whole-confirm]")?.checked === true;
    if (!scopeAllowed(form, draft) || !draft.loaded || !draft.generation || !draft.revision || !draft.whole && !draft.edited && !Array.from(draft.selections.keys()).some((key) => effectiveScopeState(draft, key) !== "exclude") || draft.whole && !confirmation) {
      scopeMessage(form, "Choose folders first. Entire-account access also needs explicit confirmation.");
      return;
    }
    draft.busy = true;
    scopeControls(form, draft);
    scopeMessage(form, "Saving your approved scope…");
    try {
      const result = await options.transport.control({
        action: "approve_source_scope_and_start",
        source_id: form.dataset.folderScopeSource,
        account_generation: draft.generation,
        expected_scope_revision: draft.revision,
        selections: Array.from(draft.selections.keys(), (key) => ({ key, state: effectiveScopeState(draft, key), ancestor_keys: draft.ancestors.get(key) || [] })),
        whole_account: draft.whole,
        explicit_whole_account_confirmation: confirmation
      });
      if (disposed || options.signal.aborted || !root.contains(form))
        return;
      if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
        if (result.status === 401 || result.status === 403)
          canWrite = false;
        if (result.status === 409)
          draft.invalid = true;
        const error = result.body.error;
        const message2 = error && typeof error === "object" ? error.message : undefined;
        scopeMessage(form, typeof message2 === "string" ? message2 : "Scope was not activated. Your choices are still here.");
        return;
      }
      draft.edited = false;
      scopeMessage(form, "Scope saved. Opening the source status…");
      if (!dirty && !Array.from(scopeDrafts.values()).some((other) => other.edited)) {
        options.navigate(`/dashboard?source=${encodeURIComponent(form.dataset.folderScopeSource || "")}`);
      }
    } catch {
      if (!disposed && root.contains(form))
        scopeMessage(form, "Could not confirm the result. Reopen the picker to check saved scope before retrying.");
    } finally {
      draft.busy = false;
      if (!disposed && root.contains(form))
        scopeControls(form, draft);
    }
  }
  function scopeClick(target) {
    const form = target.closest("form[data-folder-scope-source]");
    if (!form || !root.contains(form))
      return false;
    const draft = scopeDraft(form);
    if (target.closest("[data-scope-cancel]")) {
      if (draft.busy)
        return true;
      scopeDrafts.delete(form);
      const list = form.querySelector("[data-scope-nodes]");
      list?.replaceChildren();
      form.querySelectorAll("input").forEach((input) => {
        input.checked = input.defaultChecked;
      });
      const empty = form.querySelector("[data-scope-inspector-empty]");
      if (empty)
        empty.hidden = false;
      const content = form.querySelector("[data-scope-inspector-content]");
      if (content)
        content.hidden = true;
      form.querySelectorAll("[data-scope-more]").forEach((element) => {
        element.hidden = true;
      });
      const location = form.querySelector("[data-scope-location]");
      if (location)
        location.textContent = "Top level";
      const fresh = scopeDraft(form);
      renderScopeReview(form, fresh);
      scopeMessage(form, "Changes cancelled. Browse again to review the saved scope.");
      return true;
    }
    if (!scopeAllowed(form, draft))
      return true;
    if (target.closest("[data-scope-browse-root]")) {
      browseScope(form, []);
      return true;
    }
    const more = target.closest("[data-scope-more]");
    if (more) {
      const key = more.dataset.scopeMore;
      if (key && draft.branchCursors.has(key))
        browseScope(form, scopeTrail(draft, key), true);
      else if (!key && draft.nextCursor)
        browseScope(form, [], true);
      return true;
    }
    const open = target.closest("[data-scope-open]");
    if (open) {
      const node = draft.catalog.get(open.dataset.scopeOpen || "");
      if (node && draft.expanded.has(node.key)) {
        draft.expanded.delete(node.key);
        renderScopeNodes(form, draft);
      } else if (node && draft.branches.has(node.key)) {
        draft.expanded.add(node.key);
        renderScopeNodes(form, draft);
      } else if (node)
        browseScope(form, scopeTrail(draft, node.key));
      return true;
    }
    const select = target.closest("[data-scope-select]");
    if (select) {
      draft.selected = draft.catalog.get(select.dataset.scopeSelect || "");
      const empty = form.querySelector("[data-scope-inspector-empty]");
      if (empty)
        empty.hidden = !!draft.selected;
      const content = form.querySelector("[data-scope-inspector-content]");
      if (content)
        content.hidden = !draft.selected;
      const name = form.querySelector("[data-scope-selected-name]");
      if (name)
        name.textContent = draft.selected?.name || "";
      const path = form.querySelector("[data-scope-selected-path]");
      if (path)
        path.textContent = draft.selected ? draft.names.get(draft.selected.key) || draft.selected.name : "";
      const note = form.querySelector("[data-scope-selected-note]");
      if (note)
        note.textContent = "This choice applies to this folder and its contents. Review narrower choices before starting.";
      updateScopeRows(form, draft);
      return true;
    }
    const choice = target.closest("[data-scope-state]");
    const state = choice?.dataset.scopeState;
    if (draft.selected?.selectable && state && scopeChoiceAllowed(draft, state) && (state === "ingest" || state === "metadata_only" || state === "exclude")) {
      draft.selections.set(draft.selected.key, state);
      draft.edited = true;
      updateScopeRows(form, draft);
    }
    return true;
  }
  function query(selector) {
    return root.querySelector(selector);
  }
  function selectFolder(row) {
    const form = row.closest("form[data-dispositions-source]");
    if (!form)
      return;
    form.querySelectorAll(".folder-row.selected").forEach((item) => item.classList.remove("selected"));
    row.classList.add("selected");
    form.dataset.selectedPath = row.dataset.path || "";
    const inspector = form.querySelector(".finder-inspector");
    if (!inspector)
      return;
    const empty = inspector.querySelector("[data-inspector-empty]");
    const content = inspector.querySelector("[data-inspector-content]");
    if (empty)
      empty.hidden = true;
    if (content)
      content.hidden = false;
    const name = inspector.querySelector("[data-inspector-name]");
    const path = inspector.querySelector("[data-inspector-path]");
    const count = inspector.querySelector("[data-inspector-count]");
    const note = inspector.querySelector("[data-inspector-note]");
    if (name)
      name.textContent = row.dataset.name || "";
    if (path)
      path.textContent = row.dataset.path || "";
    if (count)
      count.textContent = row.dataset.counts || "";
    if (note) {
      note.textContent = row.dataset.locked || form.dataset.locked || (row.dataset.origin === "default" ? "Uses the Full ingestion default until you choose otherwise." : row.dataset.origin === "inherited" ? "Inherited from the nearest folder choice above." : "This folder has its own choice.");
    }
    const selectable = new Set((row.dataset.selectable || "").split(",").filter(Boolean));
    inspector.querySelectorAll("button[data-picker-state]").forEach((button) => {
      const state = button.dataset.pickerState || "";
      button.disabled = !canWrite || !selectable.has(state);
      button.classList.toggle("on", row.dataset.state === state);
    });
  }
  function message(text) {
    const slot = query("#save-message");
    if (slot)
      slot.textContent = text;
  }
  function applyWriteCapability() {
    root.querySelectorAll("form[data-folder-scope-source]").forEach((form) => scopeControls(form, scopeDraft(form)));
    if (appliedCanWrite === canWrite)
      return;
    appliedCanWrite = canWrite;
    root.querySelectorAll('form[data-dispositions-source] button[type="submit"]').forEach((button) => {
      if (button.dataset.olympusOriginallyDisabled === undefined) {
        button.dataset.olympusOriginallyDisabled = button.disabled ? "true" : "false";
      }
      button.disabled = !canWrite || button.dataset.olympusOriginallyDisabled === "true";
    });
    const selected = query(".folder-row.selected");
    if (selected)
      selectFolder(selected);
  }
  async function save(form) {
    if (!canWrite) {
      message("Your OpenClaw connection has read-only access. Your folder choices are still here.");
      return;
    }
    const edits = [];
    form.querySelectorAll('input[type="radio"]:checked').forEach((input) => {
      if (input.value === input.dataset.initial)
        return;
      if (input.value !== "ingest" && input.value !== "metadata_only" && input.value !== "exclude")
        return;
      edits.push({ path: input.dataset.path || "", state: input.value });
    });
    if (edits.length === 0) {
      message("Nothing changed.");
      return;
    }
    message(`Saving ${edits.length} change(s)…`);
    try {
      const result = await options.transport.control({
        action: "save_dispositions",
        source: form.dataset.dispositionsSource || "",
        edits
      });
      if (result.status === 401 || result.status === 403) {
        if (options.authority === "worker-session") {
          message("The control session expired. Your folder choices are still here — unlock controls on the dashboard, then reopen this picker to save them.");
        } else {
          canWrite = false;
          applyWriteCapability();
          message("Your write access expired. Your folder choices are still here — reconnect with operator.write access to save them.");
        }
        return;
      }
      if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
        const error = result.body.error;
        const reason = error && typeof error === "object" && !Array.isArray(error) ? error.message : undefined;
        message(typeof reason === "string" ? reason : "Save failed.");
        return;
      }
      const resultBody = result.body.result;
      const refused = resultBody && typeof resultBody === "object" && !Array.isArray(resultBody) ? resultBody.refused : undefined;
      if (Array.isArray(refused) && refused.length > 0) {
        message(refused.map((entry) => {
          const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
          return `${String(record.path || "")}: ${String(record.message || "refused")}`;
        }).join(" "));
        return;
      }
      dirty = false;
      message("Saved. Reloading…");
      await refreshNow(true);
    } catch (error) {
      message(error instanceof Error ? error.message : "Save failed.");
    }
  }
  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target))
      return;
    if (scopeClick(target))
      return;
    const row = target.closest(".folder-row");
    if (row) {
      selectFolder(row);
      return;
    }
    const choice = target.closest("button[data-picker-state]");
    if (choice) {
      const form = choice.closest("form[data-dispositions-source]");
      const path = form?.dataset.selectedPath;
      const state = choice.dataset.pickerState;
      if (!form || !path || !state || choice.disabled || !canWrite)
        return;
      const rowForPath = Array.from(form.querySelectorAll(".folder-row")).find((item) => item.dataset.path === path);
      const radio = Array.from(form.querySelectorAll('input[type="radio"]')).find((input) => input.dataset.path === path && input.value === state);
      if (!rowForPath || !radio)
        return;
      radio.checked = true;
      rowForPath.dataset.state = state;
      const status = rowForPath.querySelector("[data-folder-status]");
      if (status)
        status.textContent = labels[state] || state;
      dirty = true;
      selectFolder(rowForPath);
      return;
    }
    if (target.closest("[data-cancel-picker]")) {
      refreshNow(true);
      return;
    }
    const copy = target.closest("[data-copy-target]");
    if (!copy)
      return;
    const selector = copy.dataset.copyTarget;
    const source = selector ? query(selector) : null;
    if (!source || !navigator.clipboard)
      return;
    navigator.clipboard.writeText(source.value);
  }
  function onKeydown(event) {
    if (event.target instanceof Element && event.target.closest("form[data-folder-scope-source]"))
      return;
    if (!(event instanceof KeyboardEvent) || event.key !== "Enter" && event.key !== " ")
      return;
    const row = event.target instanceof Element ? event.target.closest(".folder-row") : null;
    if (!row || !root.contains(row))
      return;
    event.preventDefault();
    selectFolder(row);
  }
  function onInput(event) {
    if (event.target instanceof HTMLInputElement && root.contains(event.target)) {
      const form2 = event.target.closest("form[data-folder-scope-source]");
      if (form2 && event.target.matches("[data-scope-search]")) {
        renderScopeNodes(form2, scopeDraft(form2));
        return;
      }
      if (form2 && (event.target.matches("[data-scope-whole-account]") || event.target.matches("[data-scope-whole-confirm]"))) {
        const draft = scopeDraft(form2);
        if (!scopeAllowed(form2, draft) || !draft.loaded)
          return;
        draft.whole = form2.querySelector("[data-scope-whole-account]")?.checked === true;
        if (!draft.whole) {
          const confirm = form2.querySelector("[data-scope-whole-confirm]");
          if (confirm)
            confirm.checked = false;
        }
        draft.edited = true;
        renderScopeReview(form2, draft);
        return;
      }
    }
    const input = event.target instanceof HTMLInputElement && event.target.matches("[data-folder-search]") ? event.target : null;
    if (!input || !root.contains(input))
      return;
    const needle = input.value.trim().toLowerCase();
    const form = input.closest("form[data-dispositions-source]");
    form?.querySelectorAll(".folder-row").forEach((row) => {
      row.hidden = needle !== "" && !(row.dataset.search || "").includes(needle);
    });
  }
  function onSubmit(event) {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !root.contains(form))
      return;
    if (form.hasAttribute("data-folder-scope-source")) {
      event.preventDefault();
      approveScope(form);
      return;
    }
    if (!form.hasAttribute("data-dispositions-source"))
      return;
    event.preventDefault();
    save(form);
  }
  function onActivity() {
    lastActivityMs = Date.now();
  }
  async function renew() {
    if (!options.transport.renew || lastActivityMs <= lastRenewalMs)
      return;
    lastRenewalMs = Date.now();
    try {
      await options.transport.renew();
    } catch {}
  }
  async function refreshNow(force) {
    if (disposed || inFlight || options.signal.aborted || !force && (!presented || dirty || Array.from(scopeDrafts.values()).some((draft) => draft.loaded || draft.busy)))
      return;
    inFlight = true;
    try {
      const result = await options.refresh();
      if (!result || disposed || options.signal.aborted)
        return;
      canWrite = result.can_write;
      if (!force && (dirty || Array.from(scopeDrafts.values()).some((draft) => draft.loaded || draft.busy))) {
        applyWriteCapability();
        return;
      }
      if (!force && result.signature === signature) {
        applyWriteCapability();
        return;
      }
      const searches = new Map;
      root.querySelectorAll("[data-folder-search]").forEach((input) => {
        const source = input.closest("form[data-dispositions-source]")?.dataset.dispositionsSource;
        if (source)
          searches.set(source, input.value);
      });
      const selected = new Map;
      root.querySelectorAll("form[data-dispositions-source]").forEach((form) => {
        if (form.dataset.dispositionsSource && form.dataset.selectedPath) {
          selected.set(form.dataset.dispositionsSource, form.dataset.selectedPath);
        }
      });
      const open = new Set(Array.from(root.querySelectorAll("details[open]")).map((node) => node.querySelector(".folder-row")?.dataset.path || ""));
      const tree = root.getRootNode();
      const active = tree instanceof ShadowRoot ? tree.activeElement : root.ownerDocument.activeElement;
      const activeForm = active instanceof Element ? active.closest("form[data-dispositions-source]") : null;
      const focus = activeForm?.dataset.dispositionsSource ? {
        source: activeForm.dataset.dispositionsSource,
        path: active instanceof HTMLElement && active.classList.contains("folder-row") ? active.dataset.path : activeForm.dataset.selectedPath,
        pickerState: active instanceof HTMLElement ? active.dataset.pickerState : undefined,
        search: active instanceof HTMLInputElement && active.matches("[data-folder-search]")
      } : undefined;
      if (options.replaceHtml)
        options.replaceHtml(root, result.body);
      else
        root.innerHTML = result.body;
      dirty = false;
      scopeDrafts.clear();
      signature = result.signature;
      appliedCanWrite = undefined;
      root.querySelectorAll("details").forEach((node) => {
        const path = node.querySelector(".folder-row")?.dataset.path || "";
        if (open.has(path))
          node.open = true;
      });
      root.querySelectorAll("form[data-dispositions-source]").forEach((form) => {
        const source = form.dataset.dispositionsSource || "";
        const search = form.querySelector("[data-folder-search]");
        const needle = searches.get(source) || "";
        if (search)
          search.value = needle;
        form.querySelectorAll(".folder-row").forEach((row2) => {
          row2.hidden = needle.trim() !== "" && !(row2.dataset.search || "").includes(needle.trim().toLowerCase());
        });
        const path = selected.get(source);
        const row = path ? Array.from(form.querySelectorAll(".folder-row")).find((entry) => entry.dataset.path === path) : undefined;
        if (row)
          selectFolder(row);
        if (focus?.source === source) {
          const restore = focus.search ? search : focus.pickerState ? form.querySelector(`[data-picker-state="${focus.pickerState}"]`) : focus.path ? Array.from(form.querySelectorAll(".folder-row")).find((entry) => entry.dataset.path === focus.path) : undefined;
          restore?.focus();
        }
      });
      applyWriteCapability();
    } catch {} finally {
      inFlight = false;
    }
  }
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeydown);
  root.addEventListener("input", onInput);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("pointerdown", onActivity, { passive: true });
  root.addEventListener("keydown", onActivity, { passive: true });
  applyWriteCapability();
  const pollMs = options.pollIntervalMs === undefined ? 15000 : options.pollIntervalMs;
  if (pollMs > 0)
    interval = setInterval(() => {
      refreshNow(false);
    }, pollMs);
  if (options.authority === "worker-session" && options.transport.renew) {
    renewalInterval = setInterval(() => {
      renew();
    }, 4 * 60 * 1000);
  }
  const dispose = () => {
    if (disposed)
      return;
    disposed = true;
    if (interval)
      clearInterval(interval);
    if (renewalInterval)
      clearInterval(renewalInterval);
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKeydown);
    root.removeEventListener("input", onInput);
    root.removeEventListener("submit", onSubmit);
    root.removeEventListener("pointerdown", onActivity);
    root.removeEventListener("keydown", onActivity);
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  return {
    refresh: () => refreshNow(false),
    update(input) {
      canWrite = input.canWrite;
      if (input.presented !== undefined)
        presented = input.presented;
      if (input.signature !== undefined)
        signature = input.signature;
      applyWriteCapability();
    },
    dispose
  };
}

// src/workers/dashboard/theme.ts
var DASHBOARD_THEME_TOKENS = {
  bg: "#101014",
  panel: "#15161A",
  panel2: "#17181D",
  line: "#26272C",
  line2: "#1E1F24",
  t1: "#ECECEA",
  t2: "#B9BAC0",
  t3: "#7C7E86",
  t4: "#55575E",
  good: "#4E9468",
  warn: "#B08430",
  run: "#8F7BD8",
  bad: "#C4574D",
  off: "#6B6E76",
  warnBg: "#1B1913",
  warnLine: "#4A3D22",
  link: "#8FA8E8",
  linkLine: "#3A5AA8"
};
var DASHBOARD_STATUS_COLORS = {
  Fresh: DASHBOARD_THEME_TOKENS.good,
  Working: DASHBOARD_THEME_TOKENS.run,
  Waiting: DASHBOARD_THEME_TOKENS.off,
  "Needs you": DASHBOARD_THEME_TOKENS.warn,
  Failing: DASHBOARD_THEME_TOKENS.bad,
  Off: DASHBOARD_THEME_TOKENS.line
};
var CSS_VARIABLE_NAMES = {
  bg: "--bg",
  panel: "--panel",
  panel2: "--panel2",
  line: "--line",
  line2: "--line2",
  t1: "--t1",
  t2: "--t2",
  t3: "--t3",
  t4: "--t4",
  good: "--good",
  warn: "--warn",
  run: "--run",
  bad: "--bad",
  off: "--off",
  warnBg: "--warn-bg",
  warnLine: "--warn-line",
  link: "--link",
  linkLine: "--link-line"
};
var PAGE_BACKDROP = "#0B0B0E";
var MONO_STACK = '"Berkeley Mono","SF Mono",Menlo,Consolas,monospace';
var ROOT_BLOCK = [
  ":root {",
  ...Object.keys(CSS_VARIABLE_NAMES).map((key) => `  ${CSS_VARIABLE_NAMES[key]}: ${DASHBOARD_THEME_TOKENS[key]};`),
  `  --mono: ${MONO_STACK};`,
  "}"
].join(`
`);
var DASHBOARD_THEME_CSS = `${ROOT_BLOCK}
* { box-sizing: border-box; }
body { margin: 0; background: ${PAGE_BACKDROP}; color: var(--t1); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 0 20px 80px; }
a { color: var(--link); }
.frame { max-width: 920px; margin: 0 auto; }
.page { background: var(--bg); border: 1px solid var(--line); border-radius: 14px; padding: 30px 34px 38px; margin-top: 20px; box-shadow: 0 2px 12px rgba(0,0,0,.4); }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; margin-bottom: 24px; }
.brand { font-weight: 600; letter-spacing: .02em; font-size: 15px; }
.brand .lead { color: var(--t3); text-decoration: none; }
.brand a.lead:hover, .brand a.lead:focus-visible { color: var(--link); }
.brand .crumb { color: var(--t3); font-weight: 400; }
.meta { color: var(--t3); font-size: 12px; }
.meta b { font-weight: 600; }
.sect { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--t4); margin: 0 0 8px; }
.sect.attn { color: var(--warn); }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
.attncard { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 9px; padding: 12px 15px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; gap: 14px; }
.attncard.plain { background: var(--panel); border-color: var(--line2); }
.attncard .grow { flex: 1; }
/* The source page's ONE banner, and only it. A bare flex:1 gave the
   description a zero basis, so a banner carrying Sync now, its status text and
   an agent-prompt button squeezed a whole paragraph into a ~30-character column
   while the controls kept their intrinsic width (owner, 2026-09-04). With a
   basis the text keeps its width and the controls drop to their own row.
   Scoped to .banner: the list rows and the whole-row links are a different
   shape, and the mobile block below still owns what they do at 375px. */
.attncard.banner { flex-wrap: wrap; }
.attncard.banner .grow { flex: 1 1 320px; min-width: 0; }
.attncard .name { font-weight: 600; }
.attncard .why { color: var(--t3); font-size: 12.5px; }
/* A warning row that carries no control is itself the link to the detail page,
   so its whole rectangle is the hit zone. */
a.attncard.rowzone { display: flex; color: inherit; text-decoration: none; -webkit-user-drag: none; }
a.attncard.rowzone:hover { border-color: var(--link); }
a.attncard.rowzone:hover .name, a.attncard.rowzone:hover .go { color: var(--link); }
a.attncard.rowzone:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
a.attncard.rowzone .go { color: var(--t4); font-size: 13px; }
/* A warning row that DOES carry a control keeps the control and links its name. */
.attncard a.name { color: inherit; text-decoration: underline; text-decoration-color: var(--line2); text-underline-offset: 3px; }
.attncard a.name:hover { color: var(--link); text-decoration-color: var(--link); }
.attncard a.go { color: var(--t4); font-size: 13px; text-decoration: none; padding: 0 2px; }
.attncard a.go:hover { color: var(--link); }
.attncard a.name:focus-visible { outline: 1px solid var(--link); outline-offset: 3px; border-radius: 4px; }
.rowlink { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rowlink .btn { text-decoration: none; display: inline-block; }
.blurb .ext { color: var(--link); }
.hint { color: var(--t4); font-size: 12px; }
.btn { border: 1px solid var(--link-line); color: var(--link); border-radius: 6px; padding: 4px 13px; font-size: 12.5px; background: none; cursor: pointer; white-space: nowrap; font: inherit; }
.btn:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
.btn.primary { background: var(--link-line); color: #E8EDF8; }
.btn.quiet { border-color: transparent; color: var(--t4); }
.btn.quiet:hover { border-color: var(--line2); color: var(--t2); }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 22px; }
.cards.four { grid-template-columns: repeat(4, 1fr); }
.card { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; }
.card .hd { display: flex; gap: 9px; align-items: center; font-weight: 600; font-size: 13.5px; }
.card .ln { color: var(--t3); font-size: 12px; margin-top: 6px; }
/* The whole card is the link. Hover and focus land on the card, not the name:
   the border warms and the name follows it, so the affordance is the shape the
   pointer is actually over. -webkit-user-drag keeps a text selection inside the
   card from turning into a link drag. */
a.card.cardlink { display: block; color: inherit; text-decoration: none; -webkit-user-drag: none; }
a.card.cardlink:hover { border-color: var(--link-line); }
a.card.cardlink:hover .hd { color: var(--link); }
a.card.cardlink:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
.bar { height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; margin-top: 9px; max-width: 340px; }
.bar i { display: block; height: 100%; background: var(--run); }
.foot { color: var(--t4); font-size: 12px; margin-top: 22px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0 22px; }
.kpi { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 11px 13px; }
.kpi .u { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--t4); }
.kpi .n { font-size: 17px; font-weight: 650; margin-top: 3px; font-variant-numeric: tabular-nums; }
.kpi .s { font-size: 11px; color: var(--t3); margin-top: 1px; }
.selectioncounts { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 22px; }
.selectioncounts div { display: flex; gap: 8px; align-items: baseline; }
.selectioncounts span { color: var(--t3); font-size: 12.5px; }
.selectioncounts b { color: var(--t1); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsect { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--t4); margin: 24px 0 8px; }
/* A heading one level under .dsect: sentence case, because it is a sentence
   about the chips beneath it rather than another section label. */
.subsect { font-size: 11.5px; color: var(--t3); margin: 12px 0 6px; }
/* The who-acts summary, directly under its section heading — .foot's 22px top
   margin would detach it from the total it is explaining. */
.reviewsum { color: var(--t3); font-size: 12px; margin: 0 0 4px; }
.bigstrip { display: flex; gap: 3px; margin: 8px 0 4px; }
.bigstrip i { width: 14px; height: 30px; border-radius: 2.5px; display: block; }
.stripcap { display: flex; justify-content: space-between; color: var(--t4); font-size: 11px; margin-bottom: 4px; }
.tip { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 11px 14px; font-family: var(--mono); font-size: 11.5px; color: var(--t2); margin: 10px 0 4px; max-width: 520px; }
.tip .h { color: var(--t4); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; font-family: system-ui, sans-serif; margin-bottom: 4px; }
/* The consequence line under a failing check: plain language, in the page's own
   font, so the mechanical row above it stays the evidence and this stays the
   meaning. */
.tip .cq { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 12px; color: var(--t3); margin: 2px 0 8px 15px; }
.tip > .cq:last-child { margin-bottom: 0; }
/* Passing checks, collapsed. A page whose header reports a fault opens with the
   fault; the green rows are evidence a reader may unfold. */
.evidence { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; font-family: var(--mono); font-size: 11.5px; color: var(--t2); margin: 6px 0 4px; max-width: 520px; }
.evidence > summary { color: var(--t4); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; font-family: system-ui, sans-serif; cursor: pointer; }
.evidence > summary:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
.evidence[open] > summary { margin-bottom: 4px; }
.ok { color: var(--good); }
.no { color: var(--bad); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--t4); font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); }
td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--line2); color: var(--t2); }
.setrow { display: grid; grid-template-columns: 15px 140px 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px dashed var(--line); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.setrow.noblurb { grid-template-columns: 15px 1fr auto; }
.setrow .name { font-weight: 600; color: var(--t2); }
.setrow .blurb { color: var(--t4); font-size: 12px; }
.rowform { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.keyfield { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--t1); font: inherit; font-size: 12.5px; padding: 4px 9px; width: 170px; }
.keyfield:focus-visible { outline: 1px solid var(--link); outline-offset: 1px; }
.actmsg { color: var(--t3); font-size: 11.5px; }
.actmsg:empty { display: none; }
.copystatus { color: var(--t3); font-size: 11.5px; margin-left: 8px; }
.sheet { display: none; background: var(--panel2); border: 1px solid var(--line); border-radius: 9px; padding: 16px 18px; margin: 12px 0 0; }
.sheet.on { display: block; }
.sheet h4 { margin: 0 0 6px; font-size: 13.5px; }
.sheet p { color: var(--t3); font-size: 12.5px; margin: 0 0 10px; max-width: 66ch; }
.promptbox { background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 12px 14px; font-family: var(--mono); font-size: 11.5px; color: var(--t2); white-space: pre-wrap; user-select: all; margin-bottom: 10px; word-break: break-all; }
/* The popup-blocked authorization link. Empty on every render that did not
   need it, so it must take no space until the script fills it in. */
.authfallback { margin-left: 8px; }
.authfallback:empty { display: none; }
/* A sheet's own labels above the redirect URI and under it. .hint is a 12px
   quiet line everywhere else on the page; inside a sheet it needs its own
   block spacing so the URI is not glued to the guidance under it. */
.sheet .hint { display: block; margin: 0 0 6px; }
/* The numbered callback-registration walkthrough. Numbers are the point — the
   owner is following them in another window — so they stay outside the text
   column and the rows breathe. */
.sheet .steps { margin: 0 0 14px; padding-left: 22px; color: var(--t3); font-size: 12.5px; max-width: 66ch; }
.sheet .steps li { margin-bottom: 10px; }
.sheet .steps li:last-child { margin-bottom: 0; }
.sheet .steps b { color: var(--t2); font-weight: 600; }
.sheet .steps .promptbox { margin-top: 6px; }
.sheet .steps .ext { color: var(--link); }
/* The agent prompt, now secondary to the steps above it. */
.sheet .agentprompt { margin-top: 14px; }
.sheet .agentprompt summary { color: var(--t3); font-size: 12.5px; cursor: pointer; margin-bottom: 8px; }
.sheet .agentprompt summary:hover { color: var(--link); }
@media (max-width: 700px) {
  .page { padding: 22px 18px 28px; }
  .cards, .cards.four { grid-template-columns: 1fr 1fr; }
  .kpis { grid-template-columns: 1fr 1fr; }
  .setrow { grid-template-columns: 15px 1fr auto; }
  .setrow .blurb { grid-column: 1 / -1; grid-row: 2; }
  .setrow .btn { justify-self: end; width: max-content; }
  /* A row's control and its hint wrap under the reason rather than squeezing
     the name to nothing on a 375px screen. A whole-row link is excluded: its
     arrow is one glyph and belongs beside the text, not on a line of its own. */
  .attncard:not(.rowzone) { flex-wrap: wrap; }
  .attncard:not(.rowzone) .grow { flex-basis: 100%; }
  .rowlink { width: 100%; justify-content: flex-end; }
}
`;

// src/workers/dashboard/static-styles.ts
var DASHBOARD_LANE_CSS = `.bgrow { position: relative; display: block; background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 10px 14px; color: inherit; text-decoration: none; }
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
var DASHBOARD_PROGRESS_CSS = `.phase { margin: 0 0 14px; max-width: 520px; }
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
var DASHBOARD_POLICY_CSS = `.catrow { display: grid; grid-template-columns: 140px 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
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
var DASHBOARD_NAV_CSS = `.top { position: sticky; top: 0; z-index: 12; background: var(--bg); padding-top: 2px; }
.dnav { position: sticky; top: 39px; z-index: 11; display: flex; gap: 4px; margin: -8px 0 22px; border-bottom: 1px solid var(--line2); background: var(--bg); }
.dnav .dnavlink { color: var(--t3); text-decoration: none; font-size: 12.5px; padding: 6px 12px 8px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dnav .dnavlink:hover { color: var(--link); }
.dnav .dnavlink:focus-visible { outline: 1px solid var(--link); outline-offset: -2px; border-radius: 4px; }
.dnav .dnavlink.on { color: var(--t1); border-bottom-color: var(--link-line); }
`;
var SETUP_JOURNEY_CSS = `.setupsummary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 18px; }
.setupsummary .sumcard { min-width: 0; border: 1px solid var(--line2); border-radius: 8px; padding: 11px 12px; background: var(--panel); }
.setupsummary b { display: block; color: var(--t4); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 4px; }
.setupsummary span { display: block; color: var(--t2); font-size: 13px; line-height: 1.3; }
.pilotnote { border: 1px solid var(--warn-line); background: var(--warn-bg); border-radius: 8px; color: var(--t3); font-size: 12px; padding: 10px 12px; margin-bottom: 18px; }
.pilotnote b { color: var(--warn); }
@media (max-width: 700px) { .setupsummary { grid-template-columns: 1fr; } }`;
var BACKGROUND_CSS = `.lane { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
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
var DISPOSITIONS_CSS = `
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

// src/control-ui/styles.ts
function forShadowRoot(css) {
  return css.replaceAll(":root", ":host").replaceAll("body {", ".olympus-control-ui {");
}
var OLYMPUS_CONTROL_UI_CSS = forShadowRoot([
  DASHBOARD_THEME_CSS,
  DASHBOARD_NAV_CSS,
  DASHBOARD_LANE_CSS,
  DASHBOARD_PROGRESS_CSS,
  DASHBOARD_POLICY_CSS,
  SETUP_JOURNEY_CSS,
  BACKGROUND_CSS,
  DISPOSITIONS_CSS
].join(`
`)) + `
:host { display: block; min-width: 0; color-scheme: dark; contain: content; }
.olympus-control-ui { min-height: 100%; }
.olympus-control-ui [data-write-capability-note] { margin: 0 auto 12px; max-width: 920px; }
.olympus-control-ui .native-state { max-width: 920px; margin: 24px auto; padding: 18px 20px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--t2); }
`;

// src/control-ui.ts
function routeFromProps(props) {
  const view = props.view;
  if (view === "dispositions")
    return { view, ...props.source_id ? { source_id: props.source_id } : {} };
  if (view === "setup" || view === "background" || view === "sensitivity")
    return { view };
  if (view === "source" && props.source_id)
    return { view, source_id: props.source_id };
  return { view: "home" };
}
function routeFromHref(href) {
  if (!href.startsWith("/dashboard") || href.startsWith("//"))
    return;
  let url;
  try {
    url = new URL(href, "https://olympus.invalid");
  } catch {
    return;
  }
  if (url.pathname === "/dashboard/dispositions") {
    const sourceId2 = url.searchParams.get("source_id");
    return { view: "dispositions", ...sourceId2 ? { source_id: sourceId2 } : {} };
  }
  if (url.pathname !== "/dashboard")
    return;
  const sourceId = url.searchParams.get("source");
  if (sourceId)
    return { view: "source", source_id: sourceId };
  if (url.searchParams.has("setup"))
    return { view: "setup" };
  if (url.searchParams.has("background"))
    return { view: "background" };
  if (url.searchParams.has("sensitivity"))
    return { view: "sensitivity" };
  return { view: "home" };
}
function targetFor(route) {
  return {
    id: "dashboard",
    params: {
      view: route.view,
      ...route.source_id ? { source_id: route.source_id } : {}
    }
  };
}
function setInertBody(root, html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script,style,link,meta,base,iframe,object,embed").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "action" || name === "formaction") {
        node.removeAttribute(attribute.name);
      } else if ((name === "href" || name === "src") && (value.startsWith("javascript:") || value.startsWith("data:"))) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  root.replaceChildren(template.content.cloneNode(true));
}
function rewriteInternalLinks(root, host) {
  root.querySelectorAll("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    const route = routeFromHref(href);
    if (!route)
      return;
    anchor.dataset.olympusNav = href;
    anchor.href = host.navigation.pageHref(targetFor(route));
  });
}
function renderState(root, message) {
  const state = document.createElement("div");
  state.className = "native-state";
  state.setAttribute("role", "status");
  state.textContent = message;
  root.replaceChildren(state);
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
      const lifetime = new AbortController;
      let context = initialContext;
      let route = routeFromProps(context.props);
      let controller;
      let generation = 0;
      let disposed = false;
      let connectionSnapshot = `${initialContext.host.connection.connected}:${initialContext.host.connection.canRead}:${initialContext.host.connection.canWrite}`;
      const abort = () => lifetime.abort();
      initialContext.signal.addEventListener("abort", abort, { once: true });
      const read = () => context.host.request(OLYMPUS_DASHBOARD_READ_METHOD, { ...route });
      const control = (params) => context.host.request(OLYMPUS_DASHBOARD_CONTROL_METHOD, params);
      const navigate = (href) => {
        const next = routeFromHref(href);
        if (!next)
          return;
        context.host.navigation.openPage(targetFor(next));
      };
      async function load() {
        const currentGeneration = ++generation;
        controller?.dispose();
        controller = undefined;
        if (!context.host.connection.connected) {
          renderState(root, "Connect to the OpenClaw Gateway to open Olympus.");
          return;
        }
        if (!context.host.connection.canRead) {
          renderState(root, "This OpenClaw connection does not have operator.read access.");
          return;
        }
        renderState(root, "Loading Olympus…");
        try {
          const result = await read();
          if (disposed || lifetime.signal.aborted || currentGeneration !== generation)
            return;
          if (result.status < 200 || result.status >= 300) {
            renderState(root, "Olympus could not load this page.");
            return;
          }
          setInertBody(root, result.body);
          rewriteInternalLinks(root, context.host);
          const mount = result.controller === "dispositions" ? mountDispositionsController : mountDashboardController;
          controller = mount({
            root,
            transport: {
              control,
              read: (params) => context.host.request(OLYMPUS_DASHBOARD_READ_METHOD, { ...params })
            },
            navigate,
            refresh: read,
            returnUrl: context.host.navigation.pageHref(targetFor(route)),
            canWrite: result.can_write,
            authority: "gateway",
            replaceHtml(nextRoot, html) {
              setInertBody(nextRoot, html);
              rewriteInternalLinks(nextRoot, context.host);
            },
            presented: context.presented,
            signal: lifetime.signal,
            signature: result.signature,
            pollIntervalMs: result.poll_interval_ms
          });
        } catch {
          if (!disposed && currentGeneration === generation) {
            renderState(root, "Olympus could not reach its private source worker.");
          }
        }
      }
      const unsubscribe = initialContext.host.subscribe(() => {
        if (disposed)
          return;
        const next = `${context.host.connection.connected}:${context.host.connection.canRead}:${context.host.connection.canWrite}`;
        if (next === connectionSnapshot)
          return;
        const [wasConnected, couldRead, couldWrite] = connectionSnapshot.split(":");
        connectionSnapshot = next;
        const connectionChanged = wasConnected !== String(context.host.connection.connected) || couldRead !== String(context.host.connection.canRead);
        if (connectionChanged) {
          load();
          return;
        }
        if (couldWrite !== String(context.host.connection.canWrite)) {
          controller?.update({ canWrite: context.host.connection.canWrite, presented: context.presented });
          controller?.refresh();
        }
      });
      load();
      return {
        update(nextContext) {
          context = nextContext;
          const nextRoute = routeFromProps(nextContext.props);
          const changed = JSON.stringify(nextRoute) !== JSON.stringify(route);
          route = nextRoute;
          if (changed)
            load();
          else
            controller?.update({
              canWrite: nextContext.host.connection.canWrite,
              presented: nextContext.presented
            });
        },
        focus() {
          root.querySelector("a,button,input,summary,[tabindex]")?.focus();
        },
        dispose() {
          if (disposed)
            return;
          disposed = true;
          generation += 1;
          controller?.dispose();
          unsubscribe();
          initialContext.signal.removeEventListener("abort", abort);
          lifetime.abort();
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
      page: { id: "dashboard", params: { view: "home" } },
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
  setInertBody,
  control_ui_default as default
};
