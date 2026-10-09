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
  let awaitingAuthorizationReturn = false;
  const root = options.root;
  const submittedFormValues = new WeakMap;
  const startedFromSheet = new WeakSet;
  const pendingForms = new WeakSet;
  let pendingFormCount = 0;
  function query(selector) {
    return root.querySelector(selector);
  }
  function queryAll(selector) {
    return Array.from(root.querySelectorAll(selector));
  }
  function setSheetOpen(sheet, open) {
    sheet.classList.toggle("on", open);
    sheet.setAttribute("aria-hidden", open ? "false" : "true");
    if (!sheet.id)
      return;
    queryAll("[data-sheet-toggle]").forEach((toggle) => {
      if (toggle.dataset.sheetToggle === `#${sheet.id}`)
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
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
    root.querySelectorAll("form[data-connect-kind],form[data-sync-kind],form[data-embedding-kind],form[data-model-retry]," + "form[data-disconnect-kind],form[data-unpair-kind],form[data-model-check],form[data-agent-kind],form[data-privacy-form]").forEach((form) => {
      const pending = pendingForms.has(form) || form.dataset.keyAccepted === "true";
      form.querySelectorAll('button,input:not([type="hidden"])').forEach((control) => {
        if (control.dataset.olympusOriginallyDisabled === undefined) {
          control.dataset.olympusOriginallyDisabled = control.disabled ? "true" : "false";
        }
        const oauthUnavailable = form.hasAttribute("data-native-oauth-unavailable");
        if (pending && isSubmitControl(control) || !canWrite || oauthUnavailable) {
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
  function isSubmitControl(control) {
    const type = (control.getAttribute("type") || "").toLowerCase();
    if (control instanceof HTMLButtonElement)
      return type === "" || type === "submit";
    return type === "submit";
  }
  function setFormPending(form, pending, message) {
    if (pending) {
      if (!pendingForms.has(form))
        pendingFormCount++;
      pendingForms.add(form);
      form.setAttribute("aria-busy", "true");
      if (message !== undefined)
        say(form, message);
    } else {
      if (pendingForms.has(form))
        pendingFormCount--;
      pendingForms.delete(form);
      form.removeAttribute("aria-busy");
    }
    applyWriteCapability();
  }
  function pendingMessage(params) {
    const action = params.action;
    if (params.action === "retry_model" && params.model === "transcription")
      return "Starting…";
    switch (action) {
      case "start_oauth":
        return "Connecting…";
      case "connect_api_key":
        return "Validating the key…";
      case "cancel_oauth":
        return "Cancelling…";
      case "sync_now":
        return "Starting sync…";
      case "set_embedding_priority":
        return "Saving…";
      case "retry_model":
        return "Starting the download again…";
      default:
        return "Working…";
    }
  }
  function successMessage(params) {
    const action = params.action;
    if (params.action === "retry_model" && params.model === "transcription")
      return "Started. This row updates as it goes.";
    switch (action) {
      case "connect_api_key":
        return "Key accepted. This card updates when Olympus confirms the connection.";
      case "start_oauth":
        return "Waiting for authorization. This card updates when the connection completes.";
      case "cancel_oauth":
        return "Connection attempt cancelled. Press Connect when you are ready to start a new one.";
      case "sync_now":
        return "Checking. This card shows what was found.";
      case "set_embedding_priority":
        return "Saved.";
      case "disconnect":
        return "Disconnected. This card updates when Olympus confirms it.";
      case "unpair":
        return "Unpaired on this computer.";
      case "retry_model":
        return "Downloading again. This row updates as it goes.";
      default:
        return "Saved.";
    }
  }
  function unreleasedMessage(action) {
    return action === "connect_api_key" ? "Key accepted. Your newer entry is still in the form — press Connect to submit it." : "Sent. Your newer entry is still in the form.";
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
  function releaseSubmittedForm(form, submittedValues) {
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
    if (form.hasAttribute("data-model-check"))
      return { action: "check_model_setup" };
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
    if (form.hasAttribute("data-model-retry")) {
      const model = form.dataset.modelRetry;
      return model === "embedding" || model === "answers" || model === "transcription" ? { action: "retry_model", model } : undefined;
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
    if (pendingForms.has(form) || form.dataset.keyAccepted === "true") {
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
    setFormPending(form, true, form.dataset.pendingMessage || pendingMessage(params));
    let result;
    try {
      result = await options.transport.control(params);
    } catch {
      closeAuthorizationTab(authorizationTab);
      say(form, "Could not reach Olympus.");
      return;
    } finally {
      setFormPending(form, false);
      if (params.action !== "start_oauth")
        submittedFormValues.delete(form);
    }
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
      awaitingAuthorizationReturn = true;
      if (authorizationTab) {
        authorizationTab.location.href = authorizationUrl;
        say(form, "Authorization opened in a new tab. Approve it there, then come back to Olympus — this card updates when the connection completes.");
        if (releaseSubmittedForm(form, submittedValues))
          refreshNow(false, true);
      } else if (openAuthorizationExternally(authorizationUrl)) {
        say(form, "Authorization opened in your default browser. Approve it there, then come back to Olympus — this card updates when the connection completes.");
        if (releaseSubmittedForm(form, submittedValues))
          refreshNow(false, true);
      } else {
        say(form, "Waiting for authorization. Open the page to continue — this card updates when the connection completes.");
        showAuthorizationFallback(form, authorizationUrl);
      }
      return;
    }
    closeAuthorizationTab(authorizationTab);
    const statusMessage = result.body.status_message;
    const released = releaseSubmittedForm(form, submittedValues);
    if (released && params.action === "connect_api_key") {
      form.dataset.keyAccepted = "true";
      form.querySelectorAll('input[name="api_key"]').forEach((input) => {
        input.value = "";
        input.hidden = true;
      });
      form.querySelectorAll('button[type="submit"],button:not([type])').forEach((button) => {
        button.textContent = params.source === "readwise" ? "Connected" : "Key saved";
      });
      applyWriteCapability();
    }
    if (params.action === "cancel_oauth")
      awaitingAuthorizationReturn = false;
    say(form, typeof statusMessage === "string" ? statusMessage : released ? successMessage(params) : unreleasedMessage(params.action));
    await refreshNow(false, released);
  }
  function agentParams(form) {
    const kind = form.dataset.agentKind;
    if (kind === "pair")
      return { action: "mint_agent_pairing_code" };
    if (kind === "key")
      return { action: "create_agent_key", name: formRecord(form).name || "" };
    if (kind === "revoke")
      return { action: "revoke_agent_connection", connection_id: formRecord(form).connection_id || "" };
    if (kind === "remote-on")
      return { action: "set_remote_access", enabled: true };
    if (kind === "remote-off")
      return { action: "set_remote_access", enabled: false };
    if (kind === "remote-accept") {
      if (form.dataset.termsShown !== "true")
        return;
      return { action: "set_remote_access", enabled: true, accept_terms: { url: form.dataset.termsUrl || null } };
    }
    return;
  }
  function showRemoteTerms(from, body, message) {
    const panel = query("[data-remote-terms]");
    const accept = panel?.querySelector('form[data-agent-kind="remote-accept"]');
    const terms = body.terms && typeof body.terms === "object" && !Array.isArray(body.terms) ? body.terms : undefined;
    if (!panel || !accept || !terms) {
      say(from, message);
      return;
    }
    const url = typeof terms.url === "string" && /^https:\/\//.test(terms.url) ? terms.url : "";
    const readUrl = typeof terms.read_url === "string" && /^https:\/\//.test(terms.read_url) ? terms.read_url : url;
    const link = panel.querySelector("[data-remote-terms-link]");
    if (link && readUrl)
      link.href = readUrl;
    accept.dataset.termsUrl = url;
    accept.dataset.termsShown = "true";
    say(from, "");
    say(accept, from === accept ? message : "");
    panel.hidden = false;
    if (!panel.hasAttribute("tabindex"))
      panel.setAttribute("tabindex", "-1");
    panel.focus();
  }
  function hideRemoteTerms() {
    const panel = query("[data-remote-terms]");
    if (!panel)
      return;
    panel.hidden = true;
    const accept = panel.querySelector('form[data-agent-kind="remote-accept"]');
    if (accept) {
      delete accept.dataset.termsShown;
      delete accept.dataset.termsUrl;
      say(accept, "");
    }
  }
  function showAgentSecret(form, value, note) {
    const holder = form.closest("[data-agent-step]") || form.parentElement || form;
    const slot = holder.querySelector("[data-agent-secret-slot]");
    const field = slot?.querySelector("[data-agent-secret]");
    if (!slot || !field)
      return;
    field.value = value;
    const noteSlot = slot.querySelector("[data-agent-secret-note]");
    if (noteSlot)
      noteSlot.textContent = note;
    slot.hidden = false;
    field.focus();
    field.select();
  }
  function clearAgentSecret(slot) {
    slot.querySelectorAll("[data-agent-secret]").forEach((field) => {
      field.value = "";
    });
    const noteSlot = slot.querySelector("[data-agent-secret-note]");
    if (noteSlot)
      noteSlot.textContent = "";
    slot.hidden = true;
  }
  async function refreshAgentList() {
    const current = query("[data-agent-connections-list]");
    if (!current || disposed || options.signal.aborted)
      return;
    let result;
    try {
      result = await options.refresh();
    } catch {
      return;
    }
    if (!result || disposed || options.signal.aborted)
      return;
    const next = document.createElement("template");
    next.innerHTML = result.body;
    const fresh = next.content.querySelector("[data-agent-connections-list]");
    if (!fresh)
      return;
    current.innerHTML = fresh.innerHTML;
    applyWriteCapability();
  }
  async function submitAgentControl(form) {
    if (!canWrite && !csrfToken) {
      say(form, options.authority === "worker-session" ? "Unlock dashboard controls above first." : "Your OpenClaw connection has read-only access.");
      return;
    }
    const params = agentParams(form);
    if (!params || pendingForms.has(form))
      return;
    if (params.action === "revoke_agent_connection" && !window.confirm(form.dataset.confirmation || "Revoke this connection?"))
      return;
    if (params.action === "set_remote_access" && !params.enabled && !window.confirm(form.dataset.confirmation || "Turn off remote access?"))
      return;
    setFormPending(form, true, params.action === "revoke_agent_connection" ? "Revoking…" : params.action === "set_remote_access" ? params.enabled ? "Turning on…" : "Turning off…" : "Working…");
    let result;
    try {
      result = await options.transport.control(params);
    } catch {
      say(form, "Could not reach Olympus.");
      return;
    } finally {
      setFormPending(form, false);
    }
    if (result.status === 401 || result.status === 403) {
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
    if (params.action === "set_remote_access" && result.status === 409) {
      const code = result.body.error?.code;
      if (code === "terms_required" || code === "terms_changed") {
        showRemoteTerms(form, result.body, errorMessage(result));
        return;
      }
    }
    if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
      say(form, errorMessage(result));
      return;
    }
    if (params.action === "set_remote_access") {
      hideRemoteTerms();
      const statusMessage2 = result.body.status_message;
      const row = form.closest("[data-remote-access]");
      say(row && row.contains(form) ? form : query("[data-remote-access] form") || form, typeof statusMessage2 === "string" ? statusMessage2 : "Saved.");
      return;
    }
    if (params.action === "mint_agent_pairing_code" && typeof result.body.code === "string") {
      say(form, "");
      showAgentSecret(form, result.body.code, "Type this code on the Olympus approval page. It works once and expires in 10 minutes.");
      return;
    }
    if (params.action === "create_agent_key" && typeof result.body.token === "string") {
      say(form, "");
      showAgentSecret(form, result.body.token, "Copy it now. Olympus keeps only a fingerprint of this key and cannot show it again.");
      await refreshAgentList();
      return;
    }
    const statusMessage = result.body.status_message;
    say(form, typeof statusMessage === "string" ? statusMessage : "Revoked.");
    form.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    await refreshAgentList();
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
    const action = node.getAttribute("data-connect-kind") || node.getAttribute("data-sync-kind") || node.getAttribute("data-embedding-kind") || node.getAttribute("data-model-retry") || node.getAttribute("data-disconnect-kind") || node.getAttribute("data-unpair-kind");
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
    if (active === null || !root.contains(active))
      return false;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement)
      return !active.disabled;
    return active instanceof HTMLElement && active.isContentEditable;
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
    const openSheets = queryAll(".sheet.on").map((sheet) => sheet.id);
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
    for (const id of openSheets) {
      const sheet = queryAll(".sheet").find((candidate) => candidate.id === id);
      sheet?.classList.add("on");
      queryAll("[data-sheet-toggle]").filter((toggle) => toggle.dataset.sheetToggle === `#${id}`).forEach((toggle) => toggle.setAttribute("aria-expanded", "true"));
    }
    findByFocusKey(focused)?.focus();
    signature = result.signature;
    pollIntervalMs = result.poll_interval_ms;
    deferredSince = 0;
    applyWriteCapability();
  }
  async function refreshNow(force, requested = false) {
    if (disposed || inFlight || pendingFormCount > 0 || options.signal.aborted || !force && !presented)
      return;
    const ownerDocument = root.ownerDocument;
    if (!force && !requested && ownerDocument.visibilityState === "hidden")
      return;
    if (!force && query('.sheet.on input:not([type="hidden"]),.sheet.on textarea,.sheet.on select'))
      return;
    if (!force && query("[data-remote-terms]:not([hidden])"))
      return;
    if (!force && query('form[data-privacy-form][data-dirty="true"],[data-privacy-panel]:not([hidden]),[data-privacy-confirm],[data-privacy-conflict]'))
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
  function privacyCopy(form) {
    try {
      return JSON.parse(form.dataset.copy || "{}");
    } catch {
      return {};
    }
  }
  function privacyFill(template, values) {
    let out = template || "";
    for (const key of Object.keys(values))
      out = out.split(`{${key}}`).join(values[key]);
    return out;
  }
  function privacyJson(value, fallback) {
    try {
      const parsed = JSON.parse(value || "");
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }
  function privacyFolderSources(form) {
    const list = privacyJson(form.dataset.folderSources, []);
    return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.id === "string") : [];
  }
  function privacySourceNames(form) {
    const names = privacyJson(form.dataset.sourceNames, {});
    return names && typeof names === "object" ? names : {};
  }
  function privacyLogicFor(form) {
    const topicWords = privacyJson(form.dataset.questions, null);
    return options.privacyLogic ? options.privacyLogic({
      mailSourceId: "gmail.email",
      folderSources: privacySourceNames(form),
      ...topicWords && typeof topicWords === "object" ? { topicWords } : {}
    }) : undefined;
  }
  function renderPrivacyQuestions(form, focus, message = "") {
    const holder = form.querySelector("[data-privacy-questions]");
    const field = form.querySelector('textarea[name="description"]');
    const logic = privacyLogicFor(form);
    if (!holder || !field || !logic)
      return;
    const words = privacyJson(form.dataset.questions, null) || {};
    const asked = logic.questions(field.value);
    shownPrivacyQuestions.set(holder, logic.questionsKey(field.value));
    holder.setAttribute("data-privacy-questions", asked.map((topic) => topic.id).join(","));
    holder.hidden = asked.length === 0;
    const children = [];
    if (asked.length > 0) {
      const title = document.createElement("h3");
      title.className = "sect";
      title.textContent = words.title || "";
      const intro = document.createElement("p");
      intro.className = "pnote";
      intro.textContent = words.intro || "";
      children.push(title, intro);
    }
    const locked = !canWrite && !csrfToken;
    for (const topic of asked) {
      const group = document.createElement("div");
      group.className = "pqtopic";
      const heading = document.createElement("h4");
      heading.className = "pqtitle";
      heading.id = `privacy-q-${topic.id}`;
      heading.textContent = topic.question;
      group.append(heading);
      for (const option of topic.options) {
        const id = `privacy-q-${topic.id}-${option.id}`;
        const row = document.createElement("div");
        row.className = "pqopt";
        row.setAttribute("role", "radiogroup");
        row.setAttribute("aria-labelledby", `${heading.id} ${id}`);
        const name = document.createElement("span");
        name.className = "pqlabel";
        name.id = id;
        name.textContent = option.label;
        const choices = document.createElement("span");
        choices.className = "pqchoices";
        for (const side of ["private", "share"]) {
          const label = document.createElement("label");
          label.className = "pqchoice";
          const input = document.createElement("input");
          input.type = "radio";
          input.name = id;
          input.value = side;
          input.setAttribute("data-privacy-topic", topic.id);
          input.setAttribute("data-privacy-option", option.id);
          input.checked = option.side === side;
          input.defaultChecked = input.checked;
          if (locked) {
            input.disabled = true;
            input.setAttribute("aria-disabled", "true");
          }
          const text = document.createElement("span");
          text.textContent = side === "private" ? words.private || "" : words.share || "";
          label.append(input, text);
          choices.append(label);
        }
        row.append(name, choices);
        group.append(row);
      }
      children.push(group);
    }
    if (message) {
      const note = document.createElement("p");
      note.className = "pnote pqmessage";
      note.setAttribute("data-privacy-questions-message", "");
      note.setAttribute("role", "alert");
      note.textContent = message;
      children.push(note);
    }
    holder.replaceChildren(...children);
    if (focus) {
      holder.querySelectorAll("input[data-privacy-topic]").forEach((input) => {
        if (input.dataset.privacyTopic === focus.topic && input.dataset.privacyOption === focus.option && input.value === focus.side)
          input.focus();
      });
    }
  }
  const shownPrivacyQuestions = new WeakMap;
  function onPrivacyInput(event) {
    const field = event.target instanceof HTMLTextAreaElement ? event.target : null;
    const form = field?.closest("form[data-privacy-form]");
    if (!field || !form || field.name !== "description")
      return;
    const holder = form.querySelector("[data-privacy-questions]");
    const logic = privacyLogicFor(form);
    if (!holder || !logic)
      return;
    const shown = shownPrivacyQuestions.get(holder) ?? logic.questionsKey(field.defaultValue);
    if (logic.questionsKey(field.value) !== shown || holder.querySelector("[data-privacy-questions-message]"))
      renderPrivacyQuestions(form);
    syncPrivacySave(form);
  }
  function onPrivacyChange(event) {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const form = input?.closest("form[data-privacy-form]");
    if (!input || !form || !input.checked || input.dataset.privacyTopic === undefined)
      return;
    const field = form.querySelector('textarea[name="description"]');
    const logic = privacyLogicFor(form);
    const side = input.value === "share" ? "share" : "private";
    if (!field || !logic)
      return;
    const topic = input.dataset.privacyTopic || "";
    const option = input.dataset.privacyOption || "";
    const next = logic.answerTopic(field.value, topic, option, side);
    if (!next.fits) {
      const words = privacyJson(form.dataset.questions, null) || {};
      renderPrivacyQuestions(form, { topic, option, side: side === "share" ? "private" : "share" }, words.tooLong || "");
      return;
    }
    field.value = next.description;
    setPrivacyDirty(form);
    renderPrivacyQuestions(form, { topic, option, side });
  }
  function privacyDisplay(form, logic, rule) {
    const names = privacySourceNames(form);
    return logic.displayOf(rule, privacyFill(privacyCopy(form).folderUnnamed || "", { source: names[rule.source_id] || rule.source_id }));
  }
  function privacyKindText(form, rule) {
    const copy = privacyCopy(form);
    if (rule.kind === "sender")
      return copy.kindSender || "";
    if (rule.kind === "label")
      return copy.kindLabel || "";
    const names = privacySourceNames(form);
    return privacyFill(copy.kindFolder || "", { source: names[rule.source_id] || rule.source_id });
  }
  function privacyViewRules(form) {
    return Array.from(form.querySelectorAll("[data-privacy-rule]")).flatMap((row) => {
      const rule = privacyJson(row.getAttribute("data-privacy-rule") || undefined, null);
      if (!rule || typeof rule.kind !== "string" || typeof rule.source_id !== "string")
        return [];
      const saved = row.hasAttribute("data-privacy-saved");
      const view2 = {
        kind: rule.kind,
        source_id: rule.source_id,
        display: row.querySelector(".sline.strong")?.textContent || "",
        removed: row.hasAttribute("data-removed"),
        saved,
        ...typeof rule.key === "string" ? { key: rule.key } : {},
        ...typeof rule.value === "string" ? { value: rule.value } : {},
        ...saved ? { raw: rule } : {}
      };
      return [view2];
    });
  }
  function privacyKept(form) {
    return privacyViewRules(form).filter((rule) => !rule.removed);
  }
  function privacyRulesOut(form, logic) {
    const hidden = privacyJson(form.dataset.hidden, []);
    return privacyKept(form).map((rule) => logic.ruleOut(rule)).concat(Array.isArray(hidden) ? hidden : []);
  }
  function syncPrivacySave(form) {
    const button = form.querySelector("button[data-privacy-save]");
    const field = form.querySelector('textarea[name="description"]');
    const logic = privacyLogicFor(form);
    if (!button || !logic || !canWrite && !csrfToken)
      return;
    const value = field ? field.value : "";
    const changes = form.dataset.dirty === "true" || field !== null && value !== field.defaultValue || logic.withShownAnswers(value) !== value;
    button.disabled = !changes;
    if (changes)
      button.removeAttribute("aria-disabled");
    else
      button.setAttribute("aria-disabled", "true");
  }
  function setPrivacyDirty(form) {
    form.dataset.dirty = "true";
    form.querySelectorAll("[data-privacy-confirm]").forEach((node) => node.remove());
    const empty = form.querySelector("[data-privacy-empty]");
    if (empty)
      empty.hidden = privacyKept(form).length > 0;
    syncPrivacySave(form);
  }
  function privacyRow(form, logic, rule) {
    const view2 = rule;
    const display = typeof view2.display === "string" && view2.display ? view2.display : privacyDisplay(form, logic, rule);
    const copy = privacyCopy(form);
    const row = document.createElement("div");
    row.className = "srow nodot prule";
    row.setAttribute("data-privacy-rule", JSON.stringify(view2.saved && view2.raw ? view2.raw : logic.ruleOut({ ...rule, display })));
    if (view2.saved)
      row.setAttribute("data-privacy-saved", "");
    const main = document.createElement("div");
    main.className = "smain";
    const name = document.createElement("p");
    name.className = "sline strong";
    name.textContent = display;
    const kind = document.createElement("p");
    kind.className = "sline";
    kind.textContent = privacyKindText(form, rule);
    main.append(name, kind);
    const actions = document.createElement("div");
    actions.className = "sact";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn";
    remove.setAttribute("data-privacy-remove", "");
    remove.setAttribute("aria-label", privacyFill(copy.removeFor || "", { name: display }));
    remove.textContent = copy.remove || "Remove";
    actions.append(remove);
    row.append(main, actions);
    if (view2.removed)
      markPrivacyRemoved(form, row, true);
    return row;
  }
  function addPrivacyRule(form, rule) {
    const logic = privacyLogicFor(form);
    if (!logic)
      return false;
    const identity = logic.identity(rule);
    const existing = Array.from(form.querySelectorAll("[data-privacy-rule]")).find((row) => {
      const current = privacyJson(row.getAttribute("data-privacy-rule") || undefined, null);
      return current !== null && logic.identity(current) === identity;
    });
    if (existing) {
      if (!existing.hasAttribute("data-removed"))
        return false;
      togglePrivacyRemoved(form, existing);
      return true;
    }
    form.querySelector("[data-privacy-rules]")?.append(privacyRow(form, logic, rule));
    setPrivacyDirty(form);
    return true;
  }
  function markPrivacyRemoved(form, row, removed) {
    const copy = privacyCopy(form);
    const name = row.querySelector(".sline.strong")?.textContent || "";
    const button = row.querySelector("[data-privacy-remove]");
    row.toggleAttribute("data-removed", removed);
    row.classList.toggle("removed", removed);
    if (button) {
      button.textContent = removed ? copy.undo || "Undo" : copy.remove || "Remove";
      button.setAttribute("aria-label", removed ? privacyFill(copy.undoFor || "", { name }) : privacyFill(copy.removeFor || "", { name }));
    }
  }
  function togglePrivacyRemoved(form, row) {
    const copy = privacyCopy(form);
    const name = row.querySelector(".sline.strong")?.textContent || "";
    const removed = !row.hasAttribute("data-removed");
    markPrivacyRemoved(form, row, removed);
    setPrivacyDirty(form);
    say(form, removed ? privacyFill(copy.removed || "", { name }) : "");
  }
  function privacyPanel(form, kind) {
    return form.querySelector(`[data-privacy-panel="${kind}"]`);
  }
  function panelSay(panel, message) {
    const slot = panel.querySelector("[data-privacy-panel-message]");
    if (slot)
      slot.textContent = message;
  }
  function openPrivacyPanel(form, kind) {
    form.querySelectorAll("[data-privacy-panel]").forEach((panel2) => {
      panel2.hidden = panel2.dataset.privacyPanel !== kind;
    });
    const panel = privacyPanel(form, kind);
    if (!panel)
      return;
    if (kind === "sender") {
      panel.querySelector("[data-privacy-sender]")?.focus();
      return;
    }
    if (kind === "label" && panel.dataset.loaded !== "true")
      loadPrivacyLabels(form, panel);
    if (kind === "folder") {
      const sources = privacyFolderSources(form);
      const holder = panel.querySelector("[data-privacy-folder-sources]");
      if (holder && holder.childElementCount === 0 && sources.length > 1) {
        for (const source of sources) {
          const choose = document.createElement("button");
          choose.type = "button";
          choose.className = "btn";
          choose.setAttribute("data-privacy-folder-source", source.id);
          choose.textContent = source.label;
          holder.append(choose);
        }
      }
      if (!panel.dataset.source && sources[0])
        loadPrivacyFolders(form, panel, sources[0].id, []);
    }
    if (!panel.hasAttribute("tabindex"))
      panel.setAttribute("tabindex", "-1");
    panel.focus();
  }
  function closePrivacyPanel(panel) {
    panel.hidden = true;
    panelSay(panel, "");
    const form = panel.closest("form[data-privacy-form]");
    const opener = form?.querySelector(`[data-privacy-add="${panel.dataset.privacyPanel}"]`);
    opener?.focus();
  }
  function privacyPickRow(form, label, rule, open) {
    const copy = privacyCopy(form);
    const row = document.createElement("div");
    row.className = "srow nodot";
    const main = document.createElement("div");
    main.className = "smain";
    const name = document.createElement("p");
    name.className = "sline strong";
    name.textContent = label;
    main.append(name);
    const actions = document.createElement("div");
    actions.className = "sact";
    if (open) {
      const inside = document.createElement("button");
      inside.type = "button";
      inside.className = "btn";
      inside.setAttribute("data-privacy-folder-open", JSON.stringify(open));
      inside.textContent = copy.folderOpen || "Open";
      actions.append(inside);
    }
    const logic = privacyLogicFor(form);
    const already = !!logic && privacyKept(form).some((current) => logic.identity(current) === logic.identity(rule));
    const make = document.createElement("button");
    make.type = "button";
    make.className = "btn";
    make.setAttribute("data-privacy-make-private", JSON.stringify(rule));
    make.textContent = already ? copy.alreadyPrivate || "Already private" : copy.makePrivate || "Make private";
    make.disabled = already;
    actions.append(make);
    row.append(main, actions);
    return row;
  }
  async function loadPrivacyLabels(form, panel) {
    const copy = privacyCopy(form);
    const list = panel.querySelector("[data-privacy-list]");
    if (!list || panel.dataset.loading === "true")
      return;
    panel.dataset.loading = "true";
    panelSay(panel, copy.loading || "");
    let draft;
    try {
      draft = JSON.parse(form.dataset.mailDraft || "null");
    } catch {
      draft = null;
    }
    try {
      const result = await options.transport.control({
        action: "browse_mail_scope",
        source_id: "gmail.email",
        draft
      });
      if (disposed || !root.contains(form))
        return;
      const summary = result.body.summary && typeof result.body.summary === "object" ? result.body.summary : undefined;
      const labels = summary && Array.isArray(summary.labels) ? summary.labels : undefined;
      if (result.status < 200 || result.status >= 300 || !labels) {
        panelSay(panel, copy.loadFailed || "");
        return;
      }
      list.replaceChildren();
      const own = labels.filter((label) => typeof label.id === "string" && typeof label.name === "string" && label.system !== true);
      for (const label of own) {
        list.append(privacyPickRow(form, String(label.name), {
          kind: "label",
          source_id: "gmail.email",
          key: String(label.id),
          value: String(label.name)
        }));
      }
      panel.dataset.loaded = "true";
      panelSay(panel, own.length === 0 ? copy.noLabels || "" : "");
    } catch {
      if (!disposed)
        panelSay(panel, copy.loadFailed || "");
    } finally {
      delete panel.dataset.loading;
    }
  }
  async function loadPrivacyFolders(form, panel, sourceId, path, cursor) {
    const copy = privacyCopy(form);
    const list = panel.querySelector("[data-privacy-list]");
    if (!list || panel.dataset.loading === "true")
      return;
    panel.dataset.loading = "true";
    panelSay(panel, copy.loading || "");
    const parent = path.length > 0 ? path[path.length - 1].key : undefined;
    try {
      const result = await options.transport.control({
        action: "browse_folder_scope",
        source_id: sourceId,
        ...parent ? { parent_key: parent } : {},
        ...cursor ? { cursor } : {}
      });
      if (disposed || !root.contains(form))
        return;
      const page = result.body.scope_browser;
      if (result.status < 200 || result.status >= 300 || !page || !Array.isArray(page.nodes)) {
        panelSay(panel, copy.loadFailed || "");
        return;
      }
      panel.dataset.source = sourceId;
      panel.dataset.path = JSON.stringify(path);
      panel.querySelectorAll("[data-privacy-folder-source]").forEach((choice) => {
        choice.setAttribute("aria-pressed", choice.dataset.privacyFolderSource === sourceId ? "true" : "false");
      });
      if (!cursor)
        list.replaceChildren();
      list.querySelector("[data-privacy-folder-more]")?.remove();
      const where = panel.querySelector("[data-privacy-folder-path]");
      if (where) {
        where.replaceChildren();
        if (path.length > 0) {
          const up = document.createElement("button");
          up.type = "button";
          up.className = "btn";
          up.setAttribute("data-privacy-folder-up", "");
          up.textContent = copy.folderUp || "Back";
          const name = document.createElement("span");
          name.textContent = ` ${path.map((step) => step.name).join(" / ")}`;
          where.append(up, name);
        }
      }
      for (const node of page.nodes) {
        if (typeof node.key !== "string" || typeof node.name !== "string" || node.selectable === false)
          continue;
        list.append(privacyPickRow(form, node.name, { kind: "folder", source_id: sourceId, key: node.key, display: node.name }, node.has_children ? { key: node.key, name: node.name } : undefined));
      }
      if (page.next_cursor) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "btn";
        more.setAttribute("data-privacy-folder-more", page.next_cursor);
        more.textContent = copy.folderMore || "Load more folders";
        list.append(more);
      }
      panelSay(panel, list.querySelector("[data-privacy-make-private]") ? "" : copy.folderEmpty || "");
    } catch {
      if (!disposed)
        panelSay(panel, copy.loadFailed || "");
    } finally {
      delete panel.dataset.loading;
    }
  }
  function privacyPath(panel) {
    try {
      const path = JSON.parse(panel.dataset.path || "[]");
      return Array.isArray(path) ? path : [];
    } catch {
      return [];
    }
  }
  function addPrivacySender(form) {
    const copy = privacyCopy(form);
    const panel = privacyPanel(form, "sender");
    const field = panel?.querySelector("[data-privacy-sender]");
    if (!panel || !field)
      return;
    const value = privacyLogicFor(form)?.senderValue(field.value) || "";
    if (!value) {
      panelSay(panel, copy.senderInvalid || "");
      field.focus();
      return;
    }
    if (!addPrivacyRule(form, { kind: "sender", source_id: "gmail.email", value })) {
      panelSay(panel, copy.senderDuplicate || "");
      return;
    }
    field.value = "";
    panelSay(panel, "");
    field.focus();
  }
  function privacySavedDescription(form) {
    return form.dataset.savedDescription || "";
  }
  function privacyLowering(form, logic) {
    const field = form.querySelector('textarea[name="description"]');
    const change = logic.lowering(privacyViewRules(form), field ? field.value : privacySavedDescription(form), privacySavedDescription(form));
    return { removed: change.removed.map((rule) => rule.display), description: change.described };
  }
  function clearPrivacyPrompts(form) {
    form.querySelectorAll("[data-privacy-confirm],[data-privacy-conflict]").forEach((node) => node.remove());
  }
  function privacyPrompt(form, kind, lines, items, buttons) {
    clearPrivacyPrompts(form);
    const box = document.createElement("div");
    box.className = "pprompt";
    box.setAttribute(`data-privacy-${kind}`, "");
    box.setAttribute("role", "alert");
    for (const line of lines) {
      const text = document.createElement("p");
      text.textContent = line;
      box.append(text);
    }
    if (items.length > 0) {
      const list = document.createElement("ul");
      for (const item of items) {
        const entry = document.createElement("li");
        entry.textContent = item;
        list.append(entry);
      }
      box.append(list);
    }
    const row = document.createElement("div");
    row.className = "pbuttons";
    for (const [attribute, label] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.setAttribute(attribute, "");
      button.textContent = label;
      row.append(button);
    }
    box.append(row);
    const footer = form.querySelector(".pfooter");
    (footer || form).prepend(box);
    row.querySelector("button")?.focus();
  }
  function showPrivacyConfirm(form, lowering) {
    const copy = privacyCopy(form);
    const lines = [];
    if (lowering.removed.length > 0)
      lines.push(privacyFill(copy.confirmRemoves || "", { list: lowering.removed.join(", ") }));
    if (lowering.description)
      lines.push(copy.confirmDescription || "");
    privacyPrompt(form, "confirm", lines, [], [
      ["data-privacy-confirm-yes", copy.confirm || "Confirm"],
      ["data-privacy-confirm-no", copy.cancel || "Cancel"]
    ]);
  }
  function showPrivacyConflict(form, logic, current) {
    const copy = privacyCopy(form);
    const description = typeof current.description === "string" ? current.description.trim() : "";
    const rules = Array.isArray(current.rules) ? current.rules.filter((rule) => logic.validRule(rule)) : [];
    const items = [description ? privacyFill(copy.conflictDescription || "", { text: description }) : copy.conflictNoDescription || ""];
    if (rules.length === 0)
      items.push(copy.rulesEmpty || "");
    for (const rule of rules)
      items.push(`${privacyDisplay(form, logic, rule)} · ${privacyKindText(form, rule)}`);
    privacyPrompt(form, "conflict", [copy.conflict || "", copy.conflictNow || ""], items, [
      ["data-privacy-apply-again", copy.applyAgain || "Apply my changes again"],
      ["data-privacy-discard-mine", copy.discardMine || "Discard my changes"]
    ]);
  }
  function privacyApplyAgain(form) {
    const logic = privacyLogicFor(form);
    const current = privacyJson(form.dataset.server, null);
    if (!logic || !current)
      return;
    const field = form.querySelector('textarea[name="description"]');
    const draft = {
      rules: privacyViewRules(form),
      description: field ? field.value : privacySavedDescription(form),
      savedDescription: privacySavedDescription(form)
    };
    const saved = Array.isArray(current.rules) ? current.rules : [];
    const fresh = saved.filter((rule) => logic.validRule(rule)).map((rule) => logic.viewRule(rule, privacyDisplay(form, logic, rule)));
    const replayed = logic.replay(draft, fresh);
    const description = typeof current.description === "string" ? current.description : "";
    form.dataset.revision = typeof current.revision === "string" ? current.revision : "";
    form.dataset.savedDescription = description;
    form.dataset.hidden = JSON.stringify(saved.filter((rule) => !logic.validRule(rule)));
    delete form.dataset.server;
    const list = form.querySelector("[data-privacy-rules]");
    if (list)
      list.replaceChildren(...replayed.rules.map((rule) => privacyRow(form, logic, rule)));
    if (field) {
      field.defaultValue = description;
      field.value = replayed.description !== null ? replayed.description : description;
    }
    renderPrivacyQuestions(form);
    setPrivacyDirty(form);
    clearPrivacyPrompts(form);
    savePrivacy(form);
  }
  async function savePrivacy(form, confirmed = false) {
    const copy = privacyCopy(form);
    const logic = privacyLogicFor(form);
    if (!logic)
      return;
    if (!canWrite && !csrfToken) {
      say(form, "Your OpenClaw connection has read-only access.");
      return;
    }
    if (pendingForms.has(form) || form.dataset.server)
      return;
    if (form.querySelector("button[data-privacy-save]")?.disabled)
      return;
    const shownField = form.querySelector('textarea[name="description"]');
    const shown = shownField ? logic.withShownAnswers(shownField.value) : "";
    if (shownField && shown !== shownField.value) {
      shownField.value = shown;
      setPrivacyDirty(form);
      renderPrivacyQuestions(form);
    }
    const lowering = privacyLowering(form, logic);
    const lowers = lowering.removed.length > 0 || lowering.description;
    if (lowers && !confirmed) {
      showPrivacyConfirm(form, lowering);
      return;
    }
    clearPrivacyPrompts(form);
    const field = form.querySelector('textarea[name="description"]');
    const description = field ? field.value.trim() : undefined;
    const revision = form.dataset.revision || "";
    setFormPending(form, true, copy.saving || "Saving…");
    let result;
    try {
      result = await options.transport.control({
        action: "save_privacy",
        ...description !== undefined ? { description } : {},
        rules: privacyRulesOut(form, logic),
        revision,
        ...lowers ? { confirm: true } : {}
      });
    } catch {
      say(form, copy.saveFailed || "Could not reach Olympus.");
      return;
    } finally {
      setFormPending(form, false);
    }
    if (result.status === 401 || result.status === 403) {
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
    const error = result.body.error && typeof result.body.error === "object" ? result.body.error : {};
    if (result.status === 409 && error.code === "conflict") {
      const current = result.body.settings && typeof result.body.settings === "object" ? result.body.settings : {};
      form.dataset.server = JSON.stringify(current);
      form.dataset.dirty = "true";
      syncPrivacySave(form);
      say(form, "");
      showPrivacyConflict(form, logic, current);
      return;
    }
    if (result.status === 409 && error.code === "privacy_owner_only") {
      showPrivacyConfirm(form, privacyLowering(form, logic));
      return;
    }
    if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
      say(form, result.status === 400 ? errorMessage(result) : copy.saveFailed || errorMessage(result));
      return;
    }
    delete form.dataset.dirty;
    if (field)
      field.defaultValue = field.value;
    say(form, copy.saved || "Saved.");
    await refreshNow(true);
    const next = query("form[data-privacy-form]");
    if (next)
      say(next, copy.saved || "Saved.");
  }
  function onPrivacyClick(target, event) {
    const form = target.closest("form[data-privacy-form]");
    if (!form)
      return false;
    const remove = target.closest("[data-privacy-remove]");
    if (remove) {
      const row = remove.closest("[data-privacy-rule]");
      if (row)
        togglePrivacyRemoved(form, row);
      return true;
    }
    const add = target.closest("[data-privacy-add]");
    if (add) {
      openPrivacyPanel(form, add.dataset.privacyAdd || "");
      return true;
    }
    const close = target.closest("[data-privacy-panel-close]");
    if (close) {
      const panel2 = close.closest("[data-privacy-panel]");
      if (panel2)
        closePrivacyPanel(panel2);
      return true;
    }
    if (target.closest("[data-privacy-sender-add]")) {
      addPrivacySender(form);
      return true;
    }
    if (target.closest("[data-privacy-confirm-yes]")) {
      savePrivacy(form, true);
      return true;
    }
    if (target.closest("[data-privacy-confirm-no]")) {
      clearPrivacyPrompts(form);
      form.querySelector('button[type="submit"]')?.focus();
      return true;
    }
    if (target.closest("[data-privacy-apply-again]")) {
      privacyApplyAgain(form);
      return true;
    }
    if (target.closest("[data-privacy-discard-mine]")) {
      delete form.dataset.dirty;
      delete form.dataset.server;
      clearPrivacyPrompts(form);
      const field = form.querySelector('textarea[name="description"]');
      if (field)
        field.value = field.defaultValue;
      refreshNow(true);
      return true;
    }
    const make = target.closest("[data-privacy-make-private]");
    if (make) {
      try {
        const rule = JSON.parse(make.dataset.privacyMakePrivate || "");
        if (addPrivacyRule(form, rule)) {
          make.textContent = privacyCopy(form).alreadyPrivate || "Already private";
          make.disabled = true;
        }
      } catch {}
      return true;
    }
    const panel = target.closest('[data-privacy-panel="folder"]');
    if (panel) {
      const source = target.closest("[data-privacy-folder-source]");
      if (source) {
        loadPrivacyFolders(form, panel, source.dataset.privacyFolderSource || "", []);
        return true;
      }
      const open = target.closest("[data-privacy-folder-open]");
      if (open && panel.dataset.source) {
        try {
          const step = JSON.parse(open.dataset.privacyFolderOpen || "");
          loadPrivacyFolders(form, panel, panel.dataset.source, [...privacyPath(panel), step]);
        } catch {}
        return true;
      }
      if (target.closest("[data-privacy-folder-up]") && panel.dataset.source) {
        loadPrivacyFolders(form, panel, panel.dataset.source, privacyPath(panel).slice(0, -1));
        return true;
      }
      const more = target.closest("[data-privacy-folder-more]");
      if (more && panel.dataset.source) {
        loadPrivacyFolders(form, panel, panel.dataset.source, privacyPath(panel), more.dataset.privacyFolderMore || undefined);
        return true;
      }
    }
    const cancel = target.closest("[data-privacy-cancel]");
    if (cancel) {
      const field = form.querySelector('textarea[name="description"]');
      const edited = form.dataset.dirty === "true" || field !== null && field.value !== field.defaultValue;
      if (edited && !window.confirm(privacyCopy(form).discard || "Discard your changes?")) {
        event.preventDefault();
        return true;
      }
      delete form.dataset.dirty;
      if (field)
        field.value = field.defaultValue;
      return false;
    }
    return false;
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
    if (form.hasAttribute("data-agent-kind")) {
      event.preventDefault();
      submitAgentControl(form);
      return;
    }
    if (form.hasAttribute("data-privacy-form")) {
      event.preventDefault();
      savePrivacy(form);
      return;
    }
    if (!form.matches("[data-connect-kind],[data-sync-kind],[data-embedding-kind],[data-model-retry],[data-disconnect-kind],[data-unpair-kind],[data-model-check]"))
      return;
    event.preventDefault();
    const submittedValues = formRecord(form);
    submittedFormValues.set(form, submittedValues);
    const tab = form.dataset.connectKind === "oauth" ? openAuthorizationTab() : null;
    submitControl(form, tab, submittedValues);
  }
  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target))
      return;
    const menu = target.closest("details.rowmenu");
    queryAll("details.rowmenu[open]").forEach((open) => {
      if (open !== menu || target.closest("[data-sheet-toggle],a[href]"))
        open.open = false;
    });
    const toggle = target.closest("[data-sheet-toggle]");
    if (toggle) {
      const selector = toggle.dataset.sheetToggle;
      const sheet = selector ? query(selector) : null;
      if (!sheet)
        return;
      const open = !sheet.classList.contains("on");
      if (open) {
        queryAll(".sheet.on").forEach((other) => {
          if (other !== sheet && !other.contains(toggle))
            setSheetOpen(other, false);
        });
      }
      setSheetOpen(sheet, open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        if (!sheet.hasAttribute("tabindex"))
          sheet.setAttribute("tabindex", "-1");
        sheet.focus();
      }
      const form = sheet.querySelector('form[data-connect-kind="oauth"][data-oauth-autostart]');
      if (open && form && (canWrite || csrfToken) && !startedFromSheet.has(form) && !form.hasAttribute("data-native-oauth-unavailable")) {
        startedFromSheet.add(form);
        form.requestSubmit();
      }
      return;
    }
    if (onPrivacyClick(target, event))
      return;
    if (target.closest("[data-remote-terms-cancel]")) {
      hideRemoteTerms();
      return;
    }
    const done = target.closest("[data-agent-secret-done]");
    if (done) {
      const slot = done.closest("[data-agent-secret-slot]");
      if (slot)
        clearAgentSecret(slot);
      refreshAgentList();
      return;
    }
    const focusButton = target.closest("[data-focus-target]");
    if (focusButton) {
      const selector = focusButton.dataset.focusTarget;
      const field = selector ? query(selector) : null;
      if (field) {
        field.scrollIntoView({ block: "center" });
        field.focus();
      }
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
    if (!anchor) {
      const row = target.closest("[data-dashboard-href]");
      const modified2 = event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
      if (row && !modified2 && !target.closest("button,input,select,textarea,label,form,summary,details")) {
        event.preventDefault();
        options.navigate(row.dataset.dashboardHref);
      }
      return;
    }
    const fallback = target.closest("[data-authorization-fallback] a");
    if (fallback) {
      const form = fallback.closest('form[data-connect-kind="oauth"]');
      const submittedValues = form ? submittedFormValues.get(form) : undefined;
      if (form && submittedValues) {
        setTimeout(() => {
          if (disposed || !releaseSubmittedForm(form, submittedValues))
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
  root.addEventListener("input", onPrivacyInput);
  root.addEventListener("change", onPrivacyChange);
  const refreshOnReturn = () => {
    if (disposed || options.signal.aborted || !awaitingAuthorizationReturn)
      return;
    awaitingAuthorizationReturn = false;
    refreshNow(false, true);
  };
  const onVisibilityReturn = () => {
    if (root.ownerDocument.visibilityState !== "visible")
      return;
    refreshOnReturn();
  };
  const view = root.ownerDocument.defaultView || window;
  view.addEventListener("focus", refreshOnReturn);
  root.ownerDocument.addEventListener("visibilitychange", onVisibilityReturn);
  applyWriteCapability();
  restartPoll();
  const dispose = () => {
    if (disposed)
      return;
    disposed = true;
    if (interval)
      clearInterval(interval);
    view.removeEventListener("focus", refreshOnReturn);
    root.ownerDocument.removeEventListener("visibilitychange", onVisibilityReturn);
    root.removeEventListener("submit", onSubmit);
    root.removeEventListener("click", onClick);
    root.removeEventListener("input", onPrivacyInput);
    root.removeEventListener("change", onPrivacyChange);
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
    ingest: "Fully indexed",
    metadata_only: "Names only",
    exclude: "Skipped"
  };
  const SCOPE_STATES = ["ingest", "metadata_only", "exclude"];
  const MAX_SCOPE_RULES = 100;
  const ACCOUNT_KEY = "@account";
  const scopeDrafts = new Map;
  const scopeCopies = new WeakMap;
  function scopeMessage(form, text) {
    const slot = form.querySelector("[data-scope-message]");
    if (slot)
      slot.textContent = text;
  }
  function scopeCopy(form) {
    let copy = scopeCopies.get(form);
    if (!copy) {
      try {
        copy = JSON.parse(form.dataset.scopeCopy || "{}");
      } catch {
        copy = {};
      }
      scopeCopies.set(form, copy);
    }
    return copy;
  }
  function fillText(template, values) {
    let out = template || "";
    for (const key of Object.keys(values))
      out = out.split(`{${key}}`).join(String(values[key]));
    return out;
  }
  function scopeDraft(form) {
    let draft = scopeDrafts.get(form);
    if (!draft) {
      draft = {
        generation: form.dataset.accountGeneration || "",
        revision: form.dataset.scopeRevision || "",
        selections: new Map,
        ancestors: new Map,
        nodes: [],
        catalog: new Map,
        branches: new Map,
        branchCursors: new Map,
        path: [],
        loaded: false,
        loadAttempted: false,
        loading: false,
        busy: false,
        saving: false,
        invalid: false,
        edited: false,
        whole: false,
        wholeConfirmed: false
      };
      scopeDrafts.set(form, draft);
    }
    return draft;
  }
  function scopeAllowed(form, draft) {
    return canWrite && form.dataset.connected === "true" && !draft.busy && !draft.invalid;
  }
  function scopeInherited(draft, key) {
    let state = draft.whole ? "ingest" : "";
    let from = draft.whole ? ACCOUNT_KEY : "";
    for (const ancestor of draft.ancestors.get(key) || []) {
      const choice = draft.selections.get(ancestor);
      if (choice === "exclude") {
        state = "exclude";
        from = ancestor;
      } else if (choice === "metadata_only" && state !== "exclude") {
        state = "metadata_only";
        from = ancestor;
      } else if (choice === "ingest" && (state === "" || state === "ingest")) {
        state = "ingest";
        from = ancestor;
      }
    }
    return { state, from };
  }
  function effectiveScopeState(draft, key) {
    const inherited = scopeInherited(draft, key).state;
    const own = draft.selections.get(key);
    if (inherited === "exclude" || own === "exclude")
      return "exclude";
    if (inherited === "metadata_only")
      return "metadata_only";
    return own || inherited || "exclude";
  }
  function shownScopeState(draft, key) {
    return draft.selections.has(key) || scopeInherited(draft, key).state ? effectiveScopeState(draft, key) : "";
  }
  function scopeChoiceAllowed(draft, key, state) {
    const inherited = scopeInherited(draft, key).state;
    if (inherited === "exclude")
      return state === "exclude";
    if (inherited === "metadata_only")
      return state !== "ingest";
    return true;
  }
  function scopeMixed(draft, key) {
    const own = effectiveScopeState(draft, key);
    for (const other of draft.selections.keys()) {
      if (other === key || !(draft.ancestors.get(other) || []).includes(key))
        continue;
      const theirs = effectiveScopeState(draft, other);
      if (theirs !== own)
        return theirs;
    }
    return "";
  }
  function scopeExceptions(draft) {
    return Array.from(draft.selections.keys()).filter((key) => draft.selections.get(key) !== scopeInherited(draft, key).state);
  }
  function scopeAnyChosen(draft) {
    return Array.from(draft.selections.keys()).some((key) => effectiveScopeState(draft, key) !== "exclude");
  }
  function scopeNameOf(form, draft, key) {
    const Q = scopeCopy(form);
    if (key === ACCOUNT_KEY)
      return fillText(Q.accountRow, { source: form.dataset.scopeLabel || "" });
    const node = draft.catalog.get(key);
    if (node?.name)
      return node.name;
    const above = (draft.ancestors.get(key) || []).filter((ancestor) => draft.catalog.get(ancestor)?.name);
    return above.length ? fillText(Q.insideFolder, { name: draft.catalog.get(above[above.length - 1]).name }) : Q.unknownFolder;
  }
  function scopeShortPath(form, draft, key) {
    const node = draft.catalog.get(key);
    if (!node?.name)
      return scopeNameOf(form, draft, key);
    const ancestors = draft.ancestors.get(key) || [];
    const parent = ancestors.length ? draft.catalog.get(ancestors[ancestors.length - 1]) : undefined;
    return parent?.name ? `${parent.name} / ${node.name}` : node.name;
  }
  function scopeTrail(draft, key) {
    return [...draft.ancestors.get(key) || [], key];
  }
  function scopeEl(tag, className = "", text) {
    const node = root.ownerDocument.createElement(tag);
    if (className)
      node.className = className;
    if (text !== undefined)
      node.textContent = text;
    return node;
  }
  function scopeButton(className, text, focusKey, enabled) {
    const button = scopeEl("button", className, text);
    button.type = "button";
    button.dataset.scopeFocus = focusKey;
    button.disabled = !enabled;
    return button;
  }
  function scopeSegments(form, draft, key, name, enabled) {
    const Q = scopeCopy(form);
    const account = key === ACCOUNT_KEY;
    const own = account ? draft.whole ? "ingest" : "" : draft.selections.get(key) || "";
    const from = account ? { state: "", from: "" } : scopeInherited(draft, key);
    const now = account ? own : shownScopeState(draft, key);
    const node = draft.catalog.get(key);
    const capped = !account && !own && draft.selections.size >= MAX_SCOPE_RULES;
    const group = scopeEl("div", "seg");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", fillText(Q.choiceGroup, { name }));
    const buttons = [];
    for (const state of SCOPE_STATES) {
      const [long, short] = Q.segments[state];
      const pressed = own === state;
      const inherited = !pressed && (own ? now !== own && now === state : from.state === state);
      const button = scopeButton(`seg-opt${pressed ? " on" : inherited ? " inherited" : ""}`, "", `seg:${key}:${state}`, enabled);
      button.dataset.scopeKey = key;
      button.dataset.scopeState = state;
      button.setAttribute("aria-label", long);
      button.setAttribute("aria-pressed", String(pressed));
      button.append(scopeEl("span", "seg-long", long), scopeEl("span", "seg-short", short));
      const fromName = from.from ? scopeNameOf(form, draft, from.from) : "";
      const blocked = pressed ? "" : account ? state === "ingest" ? "" : Q.wholeOnlyFull : node && !node.selectable ? Q.cannotChoose : from.state && !scopeChoiceAllowed(draft, key, state) ? fillText(Q.notPossible, { parent: fromName, state: Q.statesLower[from.state] }) : capped ? fillText(Q.capReached, { max: MAX_SCOPE_RULES }) : "";
      const note = blocked || (own === state && now && now !== own ? fillText(Q.overridden, { own: Q.states[own], parent: fromName, state: Q.states[now] }) : "") || (!own && from.from && from.state === state ? fillText(Q.inheritedFrom, { parent: fromName }) : "");
      if (note) {
        button.setAttribute("aria-description", note);
        button.title = note;
      }
      if (blocked)
        button.disabled = true;
      buttons.push(button);
      group.appendChild(button);
    }
    const live = buttons.filter((button) => !button.disabled);
    const home = live.find((button) => button.dataset.scopeFocus === draft.focus) || live.find((button) => button.classList.contains("on")) || live.find((button) => button.classList.contains("inherited")) || live[0] || buttons[0];
    for (const button of buttons)
      button.tabIndex = button === home ? 0 : -1;
    return group;
  }
  function scopeNameCell(form, draft, node, enabled) {
    const Q = scopeCopy(form);
    let label;
    if (node.has_children) {
      const open = scopeButton("fname", "", `open:${node.key}`, enabled && !draft.loading);
      open.dataset.scopeOpen = node.key;
      open.setAttribute("aria-label", fillText(Q.openFolder, { name: node.name }));
      const chevron = scopeEl("span", "fopen", "›");
      chevron.setAttribute("aria-hidden", "true");
      open.appendChild(chevron);
      label = open;
    } else {
      label = scopeEl("p", "fname leaf");
      const gap = scopeEl("span", "fopen-gap");
      gap.setAttribute("aria-hidden", "true");
      label.appendChild(gap);
    }
    label.title = node.name;
    const main = scopeEl("span", "fname-main");
    main.appendChild(scopeEl("span", "fname-text", node.name));
    const differs = scopeMixed(draft, node.key);
    if (differs) {
      const tag = scopeEl("span", "ftag", Q.mixed);
      tag.title = fillText(Q.mixedSome, { state: Q.statesLower[differs] });
      main.appendChild(tag);
    }
    label.appendChild(main);
    return label;
  }
  function scopeLevelList(form, draft, parent, nodes, more, enabled) {
    const Q = scopeCopy(form);
    const list = scopeEl("ul", "flist");
    list.dataset.scopeNodes = parent;
    list.setAttribute("aria-busy", String(draft.loading));
    const seen = new Set;
    for (const node of nodes) {
      if (seen.has(node.key))
        continue;
      seen.add(node.key);
      const row = scopeEl("li", "frow seg-row");
      row.dataset.scopeRow = node.key;
      row.append(scopeNameCell(form, draft, node, enabled), scopeSegments(form, draft, node.key, node.name, enabled && !draft.saving));
      list.appendChild(row);
    }
    if (!nodes.length && draft.loaded && !draft.loading)
      list.appendChild(scopeEl("li", "fempty", Q.noFolders));
    if (more) {
      const item = scopeEl("li", "fmore");
      const button = scopeButton("secondary", draft.loading ? Q.loadingFolders : Q.loadMore, `more:${parent}`, enabled && !draft.loading);
      button.dataset.scopeMore = parent;
      item.appendChild(button);
      list.appendChild(item);
    }
    return list;
  }
  function scopeTopRow(text, control, className = "") {
    const row = scopeEl("div", `this-row${className ? ` ${className}` : ""}`);
    row.append(scopeEl("p", "this-label", text), control);
    return row;
  }
  function scopeRootScreen(form, draft, view, enabled) {
    const Q = scopeCopy(form);
    const source = form.dataset.scopeLabel || "";
    const accountName = fillText(Q.accountRow, { source });
    view.appendChild(scopeTopRow(accountName, scopeSegments(form, draft, ACCOUNT_KEY, accountName, enabled && draft.loaded && !draft.saving), "account-row"));
    if (draft.whole && !draft.wholeConfirmed) {
      const box = scopeEl("div", "confirm-box");
      box.dataset.scopeConfirm = "";
      const actions = scopeEl("div", "actions");
      const yes = scopeButton("danger", Q.wholeConfirm, "whole-yes", enabled && !draft.saving);
      yes.dataset.scopeWholeConfirm = "";
      const no = scopeButton("secondary", Q.wholeCancel, "whole-no", enabled && !draft.saving);
      no.dataset.scopeWholeCancel = "";
      actions.append(yes, no);
      box.append(scopeEl("p", "strong", fillText(Q.wholePrompt, { source })), actions);
      view.appendChild(box);
    }
    const exceptions = draft.loaded ? scopeExceptions(draft) : [];
    if (exceptions.length) {
      const section = scopeEl("section", "fsection exceptions");
      section.appendChild(scopeEl("h2", "", fillText(Q.exceptions, { n: exceptions.length })));
      const list = scopeEl("ul", "flist");
      for (const key of exceptions) {
        const state = draft.selections.get(key);
        const jump = scopeButton("jump-btn", "", `jump:${key}`, enabled && !draft.loading);
        jump.dataset.scopeJump = key;
        jump.title = scopeShortPath(form, draft, key);
        const chevron = scopeEl("span", "chev", "›");
        chevron.setAttribute("aria-hidden", "true");
        jump.append(scopeEl("span", "fname-text", scopeShortPath(form, draft, key)), scopeEl("span", `jtag jtag-${state}`, Q.segments[state][0]), chevron);
        const item = scopeEl("li", "frow jump");
        item.appendChild(jump);
        list.appendChild(item);
      }
      section.appendChild(list);
      view.appendChild(section);
    }
    const folders = scopeEl("section", "fsection");
    folders.appendChild(scopeEl("h2", "", Q.foldersHeading));
    folders.appendChild(scopeLevelList(form, draft, "", draft.nodes, !!draft.nextCursor, enabled));
    view.appendChild(folders);
  }
  function scopeFolderScreen(form, draft, view, enabled) {
    const Q = scopeCopy(form);
    const key = draft.path[draft.path.length - 1];
    const up = scopeButton("secondary back", Q.up, "up", !draft.saving);
    up.dataset.scopeUp = "";
    view.appendChild(up);
    const names = [form.dataset.scopeLabel || "", ...draft.path.map((entry) => scopeNameOf(form, draft, entry))];
    const shown = names.length > 3 ? [Q.pathMore, ...names.slice(-2)] : names;
    const head = scopeEl("h2", "fpath");
    shown.forEach((name, index) => {
      head.appendChild(index === shown.length - 1 ? scopeEl("span", "fpath-here", name) : scopeEl("span", "fpath-up", `${name} / `));
    });
    view.appendChild(head);
    view.appendChild(scopeTopRow(Q.thisFolder, scopeSegments(form, draft, key, scopeNameOf(form, draft, key), enabled && !draft.saving)));
    view.appendChild(scopeLevelList(form, draft, key, draft.branches.get(key) || [], draft.branchCursors.has(key), enabled));
  }
  function scopeFooter(form, draft) {
    const Q = scopeCopy(form);
    const allowed = scopeAllowed(form, draft);
    const totals = { ingest: 0, metadata_only: 0, exclude: 0 };
    for (const key of draft.selections.keys())
      totals[effectiveScopeState(draft, key)] += 1;
    const parts = [];
    for (const [state, template] of [["ingest", Q.summaryIngest], ["metadata_only", Q.summaryMetadata], ["exclude", Q.summaryExclude]]) {
      const n = totals[state];
      if (!n)
        continue;
      parts.push(fillText(template, { n: parts.length ? String(n) : `${n} ${n === 1 ? Q.summaryFolder.one : Q.summaryFolder.many}` }));
    }
    const lines = [];
    if (draft.whole)
      lines.push(fillText(Q.summaryWhole, { source: form.dataset.scopeLabel || "" }));
    if (parts.length)
      lines.push(parts.join(", "));
    else if (!draft.whole)
      lines.push(Q.summaryNone);
    if (draft.selections.size >= MAX_SCOPE_RULES)
      lines.push(fillText(Q.capReached, { max: MAX_SCOPE_RULES }));
    const summary = form.querySelector("[data-scope-summary]");
    if (summary)
      summary.replaceChildren(...lines.map((line) => scopeEl("p", "", line)));
    const chosen = scopeAnyChosen(draft);
    const ready = allowed && draft.loaded && !!draft.generation && !!draft.revision && draft.selections.size <= MAX_SCOPE_RULES;
    const blocker = draft.whole && !draft.wholeConfirmed ? Q.needConfirm : !draft.whole && !chosen && !draft.edited ? Q.needChoice : "";
    const submit = form.querySelector("[data-scope-start]");
    if (submit) {
      submit.disabled = !ready || blocker !== "";
      submit.textContent = draft.saving ? Q.saving : draft.whole || chosen ? Q.saveFolders : Q.saveNoStart;
      submit.setAttribute("aria-busy", String(draft.saving));
    }
    const reason = form.querySelector("[data-scope-reason]");
    if (reason)
      reason.textContent = draft.saving || form.dataset.connected !== "true" ? "" : blocker;
    const cancel = form.querySelector("[data-scope-cancel]");
    if (cancel)
      cancel.disabled = !canWrite || draft.busy || !draft.edited && !draft.invalid;
  }
  function renderScope(form, draft) {
    const Q = scopeCopy(form);
    const allowed = scopeAllowed(form, draft);
    const loading = form.querySelector("[data-scope-loading]");
    if (loading)
      loading.hidden = !draft.loading;
    const back = form.closest("[data-scope-panel]")?.querySelector(".scope-back");
    if (back)
      back.hidden = draft.path.length > 0;
    const view = form.querySelector("[data-scope-view]");
    const connected = form.dataset.connected === "true";
    if (view)
      view.hidden = !connected;
    const footer = form.querySelector(".picker-footer");
    if (footer)
      footer.hidden = !connected;
    if (view && connected) {
      const tree = root.getRootNode();
      const active = tree instanceof ShadowRoot ? tree.activeElement : root.ownerDocument.activeElement;
      const keep = draft.focus || (active instanceof HTMLElement && view.contains(active) ? active.dataset.scopeFocus : undefined);
      view.replaceChildren();
      if (draft.retry && !draft.loading) {
        const banner = scopeEl("div", "scope-error");
        banner.setAttribute("role", "alert");
        const retry = scopeButton("secondary", Q.tryAgain, "retry", canWrite && !draft.invalid);
        retry.dataset.scopeBrowseRoot = "";
        banner.append(scopeEl("p", "", Q.loadFailed), retry);
        view.appendChild(banner);
      }
      if (draft.path.length)
        scopeFolderScreen(form, draft, view, allowed);
      else
        scopeRootScreen(form, draft, view, allowed);
      if (!allowed)
        view.querySelectorAll("button:not([data-scope-up])").forEach((button) => {
          button.disabled = true;
        });
      draft.focus = undefined;
      if (keep) {
        const controls = Array.from(view.querySelectorAll("button[data-scope-focus]"));
        let target = controls.find((node) => node.dataset.scopeFocus === keep && !node.disabled);
        if (!target && !draft.busy) {
          const key = keep.startsWith("seg:") ? keep.slice(4, keep.lastIndexOf(":")) : "";
          const same = controls.filter((node) => !node.disabled && key !== "" && node.dataset.scopeKey === key);
          target = same.find((node) => node.classList.contains("inherited")) || same.find((node) => node.classList.contains("on")) || same[0] || controls.find((node) => !node.disabled);
        }
        target?.focus();
      }
    }
    scopeFooter(form, draft);
  }
  async function browseScope(form, trail, append = false) {
    const draft = scopeDraft(form);
    const Q = scopeCopy(form);
    if (!scopeAllowed(form, draft) || !options.transport.read)
      return false;
    const parent = trail.at(-1);
    const cursor = append ? parent ? draft.branchCursors.get(parent) : draft.nextCursor : undefined;
    draft.loadAttempted = true;
    draft.loading = true;
    draft.busy = true;
    draft.retry = undefined;
    scopeMessage(form, "");
    renderScope(form, draft);
    let listed = false;
    const again = parent && !append ? () => {
      drillScope(form, draft, parent);
    } : () => {
      browseScope(form, trail, append);
    };
    try {
      const result = await options.transport.read({
        view: "dispositions",
        action: "browse_folder_scope",
        source_id: form.dataset.folderScopeSource,
        ...parent ? { parent_key: parent } : {},
        ...cursor ? { cursor } : {}
      });
      if (disposed || options.signal.aborted || !root.contains(form))
        return false;
      if (result.status === 401 || result.status === 403 || !result.can_write) {
        canWrite = false;
        scopeMessage(form, Q.readOnly);
        return false;
      }
      const page = result.scope_browser;
      if (result.status < 200 || result.status >= 300 || !page || page.source_id !== form.dataset.folderScopeSource || !page.account_generation || !page.scope_revision || !Array.isArray(page.nodes) || page.nodes.some((node) => typeof node.key !== "string" || typeof node.name !== "string" || node.kind !== "folder" || typeof node.selectable !== "boolean")) {
        draft.retry = again;
        return false;
      }
      if (draft.loaded && (draft.generation !== page.account_generation || draft.revision !== page.scope_revision)) {
        draft.invalid = true;
        scopeMessage(form, Q.conflict);
        return false;
      }
      if (page.nodes.some((node) => trail.includes(node.key))) {
        draft.invalid = true;
        scopeMessage(form, Q.cycle);
        return false;
      }
      if (!draft.loaded) {
        draft.generation = page.account_generation;
        draft.revision = page.scope_revision;
        draft.selections = new Map(page.selections.map((selection) => [selection.key, selection.state]));
        page.selections.forEach((selection) => draft.ancestors.set(selection.key, selection.ancestor_keys || []));
        draft.whole = page.whole_account_selected;
        draft.wholeConfirmed = false;
      }
      draft.loaded = true;
      const previous = append ? parent ? draft.branches.get(parent) || [] : draft.nodes : [];
      const fresh = page.nodes.filter((node) => !previous.some((old) => old.key === node.key));
      const nodes = [...previous, ...fresh].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.key.localeCompare(b.key));
      if (parent) {
        draft.branches.set(parent, nodes);
        if (page.next_cursor)
          draft.branchCursors.set(parent, page.next_cursor);
        else
          draft.branchCursors.delete(parent);
      } else {
        draft.nodes = nodes;
        draft.nextCursor = page.next_cursor;
        if (!append) {
          draft.branches.clear();
          draft.branchCursors.clear();
          draft.path = [];
        }
      }
      page.nodes.forEach((node) => {
        draft.catalog.set(node.key, node);
        draft.ancestors.set(node.key, trail.slice());
      });
      listed = true;
      return true;
    } catch {
      if (!disposed && root.contains(form)) {
        draft.retry = again;
        scopeMessage(form, Q.browseFailed);
      }
      return false;
    } finally {
      draft.loading = false;
      draft.busy = false;
      if (!disposed && root.contains(form) && (!listed || !parent || append)) {
        if (listed && append)
          draft.focus = `more:${parent || ""}`;
        renderScope(form, draft);
      }
    }
  }
  async function drillScope(form, draft, key) {
    const trail = scopeTrail(draft, key);
    if (!draft.branches.has(key) && !await browseScope(form, trail))
      return;
    if (disposed || !root.contains(form))
      return;
    draft.path = trail;
    draft.focus = "up";
    renderScope(form, draft);
  }
  async function jumpScope(form, draft, key) {
    const trail = scopeTrail(draft, key);
    for (let index = 0;index < trail.length; index += 1) {
      if (draft.branches.has(trail[index]))
        continue;
      if (!await browseScope(form, trail.slice(0, index + 1)))
        return;
      if (disposed || !root.contains(form))
        return;
    }
    draft.path = trail;
    draft.focus = "up";
    renderScope(form, draft);
  }
  function chooseScope(form, draft, key, state) {
    if (draft.saving)
      return;
    if (key === ACCOUNT_KEY) {
      const whole = state === "ingest";
      if (whole === draft.whole)
        return;
      draft.whole = whole;
      draft.wholeConfirmed = false;
      draft.edited = true;
      draft.focus = whole ? "whole-yes" : `seg:${ACCOUNT_KEY}:ingest`;
    } else {
      if (state && (!scopeChoiceAllowed(draft, key, state) || draft.catalog.get(key)?.selectable === false))
        return;
      if (state && !draft.selections.has(key) && draft.selections.size >= MAX_SCOPE_RULES)
        return;
      if (state)
        draft.selections.set(key, state);
      else
        draft.selections.delete(key);
      draft.edited = true;
      draft.focus = `seg:${key}:${state || scopeInherited(draft, key).state || "ingest"}`;
    }
    renderScope(form, draft);
  }
  async function approveScope(form) {
    const draft = scopeDraft(form);
    const Q = scopeCopy(form);
    if (!scopeAllowed(form, draft) || !draft.loaded || !draft.generation || !draft.revision || draft.selections.size > MAX_SCOPE_RULES || !draft.whole && !draft.edited && !scopeAnyChosen(draft) || draft.whole && !draft.wholeConfirmed) {
      scopeMessage(form, draft.whole && !draft.wholeConfirmed ? Q.needConfirm : Q.needChoice);
      return;
    }
    draft.busy = true;
    draft.saving = true;
    scopeMessage(form, "");
    renderScope(form, draft);
    try {
      const result = await options.transport.control({
        action: "approve_source_scope_and_start",
        source_id: form.dataset.folderScopeSource,
        account_generation: draft.generation,
        expected_scope_revision: draft.revision,
        selections: Array.from(draft.selections.keys(), (key) => ({ key, state: effectiveScopeState(draft, key), ancestor_keys: draft.ancestors.get(key) || [] })),
        whole_account: draft.whole,
        explicit_whole_account_confirmation: draft.whole && draft.wholeConfirmed
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
        scopeMessage(form, typeof message2 === "string" ? message2 : Q.saveFailed);
        return;
      }
      draft.edited = false;
      scopeMessage(form, Q.saved);
      if (!dirty && !Array.from(scopeDrafts.values()).some((other) => other.edited)) {
        options.navigate(`/dashboard?source=${encodeURIComponent(form.dataset.folderScopeSource || "")}`);
      }
    } catch {
      if (!disposed && root.contains(form))
        scopeMessage(form, Q.unconfirmed);
    } finally {
      draft.busy = false;
      draft.saving = false;
      if (!disposed && root.contains(form))
        renderScope(form, draft);
    }
  }
  function scopeClick(target) {
    const form = target.closest("form[data-folder-scope-source]");
    if (!form || !root.contains(form))
      return false;
    const draft = scopeDraft(form);
    const Q = scopeCopy(form);
    const control = target.closest("button");
    if (control?.disabled)
      return true;
    if (target.closest("[data-scope-cancel]")) {
      if (draft.busy)
        return true;
      scopeDrafts.delete(form);
      const fresh = scopeDraft(form);
      renderScope(form, fresh);
      scopeMessage(form, Q.discarded);
      browseScope(form, []);
      return true;
    }
    if (target.closest("[data-scope-up]")) {
      if (draft.saving)
        return true;
      const left = draft.path.pop();
      draft.focus = left ? `open:${left}` : undefined;
      renderScope(form, draft);
      return true;
    }
    if (!scopeAllowed(form, draft))
      return true;
    if (target.closest("[data-scope-browse-root]")) {
      if (draft.retry)
        draft.retry();
      else
        browseScope(form, []);
      return true;
    }
    const more = target.closest("[data-scope-more]");
    if (more) {
      const key2 = more.dataset.scopeMore || "";
      if (key2 && draft.branchCursors.has(key2))
        browseScope(form, scopeTrail(draft, key2), true);
      else if (!key2 && draft.nextCursor)
        browseScope(form, [], true);
      return true;
    }
    const open = target.closest("[data-scope-open]");
    if (open?.dataset.scopeOpen) {
      drillScope(form, draft, open.dataset.scopeOpen);
      return true;
    }
    const jump = target.closest("[data-scope-jump]");
    if (jump?.dataset.scopeJump) {
      jumpScope(form, draft, jump.dataset.scopeJump);
      return true;
    }
    if (target.closest("[data-scope-whole-confirm]")) {
      draft.wholeConfirmed = true;
      draft.focus = `seg:${ACCOUNT_KEY}:ingest`;
      renderScope(form, draft);
      return true;
    }
    if (target.closest("[data-scope-whole-cancel]")) {
      chooseScope(form, draft, ACCOUNT_KEY, "");
      return true;
    }
    const segment = target.closest("[data-scope-key][data-scope-state]");
    const key = segment?.dataset.scopeKey;
    const state = segment?.dataset.scopeState;
    if (key && state && SCOPE_STATES.includes(state)) {
      const own = key === ACCOUNT_KEY ? draft.whole ? "ingest" : "" : draft.selections.get(key) || "";
      chooseScope(form, draft, key, own === state ? "" : state);
    }
    return true;
  }
  function scopeKeydown(event) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const form = target?.closest("form[data-folder-scope-source]");
    if (!target || !form || !root.contains(form))
      return;
    const draft = scopeDraft(form);
    if (event.key === "Escape" && draft.path.length && !draft.saving) {
      event.preventDefault();
      const left = draft.path.pop();
      draft.focus = left ? `open:${left}` : undefined;
      renderScope(form, draft);
      return;
    }
    const group = target.closest(".seg");
    if (!group || !target.matches(".seg-opt"))
      return;
    const live = Array.from(group.querySelectorAll(".seg-opt")).filter((button) => !button.disabled);
    const at = live.indexOf(target);
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = live[(at + 1) % live.length];
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = live[(at - 1 + live.length) % live.length];
    else if (event.key === "Home")
      next = live[0];
    else if (event.key === "End")
      next = live[live.length - 1];
    if (!next)
      return;
    event.preventDefault();
    group.querySelectorAll(".seg-opt").forEach((button) => {
      button.tabIndex = button === next ? 0 : -1;
    });
    next.focus();
  }
  const mailDrafts = new Map;
  function mailState(form) {
    let state = mailDrafts.get(form);
    if (!state) {
      state = {
        generation: form.dataset.accountGeneration || "",
        revision: form.dataset.scopeRevision || "",
        loaded: false,
        loadAttempted: false,
        loading: false,
        busy: false,
        invalid: false,
        edited: false
      };
      mailDrafts.set(form, state);
    }
    return state;
  }
  function mailAllowed(form, state) {
    return canWrite && form.dataset.connected === "true" && !state.busy && !state.invalid;
  }
  function mailLines(form, selector) {
    const value = form.querySelector(selector)?.value || "";
    return value.split(/[\n,]+/).map((line) => line.trim()).filter((line) => line !== "");
  }
  function mailSavedSkippedLabels(form) {
    try {
      const parsed = JSON.parse(form.dataset.mailSkippedLabels || "[]");
      return Array.isArray(parsed) ? parsed.filter((entry) => !!entry && typeof entry === "object" && typeof entry.id === "string" && typeof entry.name === "string") : [];
    } catch {
      return [];
    }
  }
  function readMailDraft(form) {
    const windowInput = form.querySelector("[data-mail-window]:checked");
    const windowValue = windowInput?.value;
    const labelInputs = Array.from(form.querySelectorAll("[data-mail-label]"));
    const skippedLabels = labelInputs.length > 0 ? labelInputs.filter((input) => !input.checked).map((input) => ({ id: input.value, name: input.dataset.mailLabelName || input.value })) : mailSavedSkippedLabels(form);
    return {
      window: windowValue === "6m" || windowValue === "1y" || windowValue === "5y" || windowValue === "all" ? windowValue : "2y",
      skipped_categories: Array.from(form.querySelectorAll("[data-mail-category]")).filter((input) => !input.checked).map((input) => input.value).filter((value) => value === "primary" || value === "social" || value === "promotions" || value === "updates" || value === "forums"),
      skipped_labels: skippedLabels,
      always_private_senders: mailLines(form, "[data-mail-private-senders]"),
      skip_senders: mailLines(form, "[data-mail-skip-senders]")
    };
  }
  function mailSummaryText(draft) {
    const windows = { "6m": "last 6 months", "1y": "last year", "2y": "last 2 years", "5y": "last 5 years", all: "everything" };
    const skipped = draft.skipped_categories.length + draft.skipped_labels.length;
    return `Full content: ${windows[draft.window] || draft.window}. ${skipped} ${skipped === 1 ? "category or label" : "categories and labels"} skipped.` + ` ${draft.always_private_senders.length} always Private, ${draft.skip_senders.length} skipped ${draft.skip_senders.length === 1 ? "sender" : "senders"}.`;
  }
  function mailControls(form, state) {
    const allowed = mailAllowed(form, state);
    form.querySelectorAll("input,textarea,button").forEach((control) => {
      control.disabled = !allowed;
    });
    const start = form.querySelector("[data-mail-start]");
    if (start)
      start.disabled = !allowed || !state.loaded || state.loading || !state.generation || !state.revision;
    const summary = form.querySelector("[data-mail-summary]");
    if (summary)
      summary.textContent = mailSummaryText(readMailDraft(form));
  }
  function mailCount(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
  }
  function renderMailSummary(form, summary) {
    const skipped = new Set(readMailDraft(form).skipped_labels.map((label) => label.id));
    const labelsSlot = form.querySelector("[data-mail-labels]");
    const labels2 = Array.isArray(summary.labels) ? summary.labels : [];
    if (labelsSlot) {
      labelsSlot.replaceChildren();
      if (labels2.length === 0) {
        const empty = labelsSlot.ownerDocument.createElement("p");
        empty.className = "mail-scope-help";
        empty.textContent = "This mailbox has no labels of its own.";
        labelsSlot.append(empty);
      }
      for (const label of labels2) {
        if (typeof label.id !== "string" || typeof label.name !== "string")
          continue;
        const row = labelsSlot.ownerDocument.createElement("label");
        row.className = "mail-scope-option";
        row.setAttribute("role", "listitem");
        const input = labelsSlot.ownerDocument.createElement("input");
        input.type = "checkbox";
        input.value = label.id;
        input.dataset.mailLabel = "";
        input.dataset.mailLabelName = label.name;
        input.checked = !skipped.has(label.id);
        const text = labelsSlot.ownerDocument.createElement("span");
        text.textContent = label.id === "SENT" ? "Sent" : label.name;
        row.append(input, text);
        labelsSlot.append(row);
      }
    }
    const categories = Array.isArray(summary.categories) ? summary.categories : [];
    for (const category of categories) {
      const slot = form.querySelector(`[data-mail-category-count="${String(category.category)}"]`);
      if (slot)
        slot.textContent = typeof category.messages_total === "number" ? ` · ${mailCount(category.messages_total)} in mailbox` : "";
    }
    const suggestions = Array.isArray(summary.sender_suggestions) ? summary.sender_suggestions : [];
    const box = form.querySelector("[data-mail-suggestions]");
    const list = form.querySelector("[data-mail-suggestion-list]");
    if (box && list) {
      list.replaceChildren();
      for (const suggestion of suggestions) {
        if (typeof suggestion.sender !== "string")
          continue;
        const item = list.ownerDocument.createElement("li");
        const sender = list.ownerDocument.createElement("span");
        sender.className = "sender";
        sender.textContent = suggestion.sender;
        const count = list.ownerDocument.createElement("span");
        count.className = "count";
        count.textContent = `${mailCount(suggestion.sample_messages)} of ${mailCount(summary.sample_size)}`;
        const makePrivate = list.ownerDocument.createElement("button");
        makePrivate.type = "button";
        makePrivate.textContent = "Always Private";
        makePrivate.dataset.mailSuggest = "private";
        makePrivate.dataset.sender = suggestion.sender;
        const skip = list.ownerDocument.createElement("button");
        skip.type = "button";
        skip.textContent = "Skip";
        skip.dataset.mailSuggest = "skip";
        skip.dataset.sender = suggestion.sender;
        item.append(sender, count, makePrivate, skip);
        list.append(item);
      }
      box.hidden = list.childElementCount === 0;
    }
    const estimate = summary.estimate && typeof summary.estimate === "object" ? summary.estimate : {};
    const put = (key, text) => {
      const slot = form.querySelector(`[data-mail-estimate="${key}"]`);
      if (slot)
        slot.textContent = text;
    };
    put("content_messages", `~${mailCount(estimate.content_messages)}`);
    put("metadata_messages", `~${mailCount(estimate.metadata_messages)}`);
    put("embedding_cost_usd", typeof estimate.embedding_cost_usd === "number" ? `≤ $${estimate.embedding_cost_usd.toFixed(2)}` : "—");
  }
  async function browseMail(form) {
    const state = mailState(form);
    if (!mailAllowed(form, state) || state.loading)
      return;
    state.loading = true;
    state.loadAttempted = true;
    mailControls(form, state);
    scopeMessage(form, "Reading labels, counts and a sample of senders from Gmail…");
    try {
      const result = await options.transport.control({
        action: "browse_mail_scope",
        source_id: "gmail.email",
        draft: readMailDraft(form)
      });
      if (disposed || options.signal.aborted || !root.contains(form))
        return;
      if (result.status === 401 || result.status === 403) {
        canWrite = false;
        scopeMessage(form, "Write access expired. Reconnect before reading your mailbox.");
        return;
      }
      const body = result.body;
      const summary = body.summary && typeof body.summary === "object" ? body.summary : undefined;
      if (result.status < 200 || result.status >= 300 || body.ok !== true || !summary || typeof body.account_generation !== "string" || typeof body.scope_revision !== "string") {
        const error = body.error;
        const message2 = error && typeof error === "object" ? error.message : undefined;
        scopeMessage(form, typeof message2 === "string" ? message2 : "Could not read the mailbox. Check the connection and reopen this picker.");
        return;
      }
      if (state.loaded && (state.generation !== body.account_generation || state.revision !== body.scope_revision)) {
        state.invalid = true;
        scopeMessage(form, "The mailbox or saved scope changed. Reopen this picker before saving.");
        return;
      }
      state.generation = body.account_generation;
      state.revision = body.scope_revision;
      state.loaded = true;
      renderMailSummary(form, summary);
      scopeMessage(form, "Nothing has been read yet. Review the estimate, then save and start.");
    } catch {
      if (!disposed && root.contains(form))
        scopeMessage(form, "Reading the mailbox failed. Your choices are still here; retry when the connection is ready.");
    } finally {
      state.loading = false;
      if (!disposed && root.contains(form))
        mailControls(form, state);
    }
  }
  async function approveMail(form) {
    const state = mailState(form);
    if (!mailAllowed(form, state) || !state.loaded || !state.generation || !state.revision) {
      scopeMessage(form, "Wait for the estimate to load before saving.");
      return;
    }
    state.busy = true;
    mailControls(form, state);
    scopeMessage(form, "Saving your approved mail scope…");
    try {
      const result = await options.transport.control({
        action: "approve_mail_scope_and_start",
        source_id: "gmail.email",
        account_generation: state.generation,
        expected_scope_revision: state.revision,
        scope: readMailDraft(form)
      });
      if (disposed || options.signal.aborted || !root.contains(form))
        return;
      if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
        if (result.status === 401 || result.status === 403)
          canWrite = false;
        if (result.status === 409)
          state.invalid = true;
        const error = result.body.error;
        const message2 = error && typeof error === "object" ? error.message : undefined;
        scopeMessage(form, typeof message2 === "string" ? message2 : "Scope was not activated. Your choices are still here.");
        return;
      }
      state.edited = false;
      scopeMessage(form, "Scope saved. Opening Gmail…");
      options.navigate("/dashboard?source=gmail.email");
    } catch {
      if (!disposed && root.contains(form))
        scopeMessage(form, "Could not confirm the result. Reopen the picker to check the saved scope before retrying.");
    } finally {
      state.busy = false;
      if (!disposed && root.contains(form))
        mailControls(form, state);
    }
  }
  function mailClick(target) {
    const form = target.closest("form[data-mail-scope-source]");
    if (!form || !root.contains(form))
      return false;
    const state = mailState(form);
    if (!mailAllowed(form, state))
      return true;
    if (target.closest("[data-mail-refresh]")) {
      browseMail(form);
      return true;
    }
    if (target.closest("[data-mail-cancel]")) {
      form.reset();
      state.edited = false;
      form.querySelector("[data-mail-labels]")?.querySelectorAll("[data-mail-label]").forEach((input) => {
        input.checked = !mailSavedSkippedLabels(form).some((label) => label.id === input.value);
      });
      mailControls(form, state);
      scopeMessage(form, "Changes cancelled.");
      return true;
    }
    const suggest = target.closest("[data-mail-suggest]");
    if (suggest?.dataset.sender) {
      const area = form.querySelector(suggest.dataset.mailSuggest === "skip" ? "[data-mail-skip-senders]" : "[data-mail-private-senders]");
      if (area && !mailLines(form, suggest.dataset.mailSuggest === "skip" ? "[data-mail-skip-senders]" : "[data-mail-private-senders]").includes(suggest.dataset.sender)) {
        area.value = `${area.value.trim()}${area.value.trim() ? `
` : ""}${suggest.dataset.sender}`;
        state.edited = true;
        mailControls(form, state);
      }
      return true;
    }
    return false;
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
      note.textContent = row.dataset.locked || form.dataset.locked || (row.dataset.origin === "default" ? "Fully indexed by default until you choose otherwise." : row.dataset.origin === "inherited" ? "Inherited from the nearest folder choice above." : "This folder has its own choice.");
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
    root.querySelectorAll("form[data-folder-scope-source]").forEach((form) => {
      const draft = scopeDraft(form);
      renderScope(form, draft);
      if (presented && !form.closest("[data-scope-panel]")?.hidden && !draft.loadAttempted && scopeAllowed(form, draft))
        browseScope(form, []);
    });
    root.querySelectorAll("form[data-mail-scope-source]").forEach((form) => {
      const state = mailState(form);
      mailControls(form, state);
      if (presented && !form.closest("[data-scope-panel]")?.hidden && !state.loadAttempted && mailAllowed(form, state))
        browseMail(form);
    });
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
  let activeScopeSource = root.querySelector("[data-scope-panel]:not([hidden])")?.dataset.scopePanel;
  function showScopePanel(sourceId) {
    const panels = Array.from(root.querySelectorAll("[data-scope-panel]"));
    if (!panels.some((panel) => panel.dataset.scopePanel === sourceId))
      return;
    activeScopeSource = sourceId;
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.scopePanel !== sourceId;
    });
    applyWriteCapability();
  }
  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target))
      return;
    const anchor = target.closest("a[href]");
    const modified = event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
    if (anchor && !modified) {
      if (anchor.dataset.scopeSwitch) {
        event.preventDefault();
        showScopePanel(anchor.dataset.scopeSwitch);
        return;
      }
      const href = anchor.dataset.olympusNav || anchor.getAttribute("href") || "";
      if (href.startsWith("/dashboard") && !href.startsWith("//")) {
        event.preventDefault();
        options.navigate(href);
        return;
      }
    }
    if (scopeClick(target))
      return;
    if (mailClick(target))
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
    if (event.target instanceof Element && event.target.closest("form[data-folder-scope-source]")) {
      if (event instanceof KeyboardEvent)
        scopeKeydown(event);
      return;
    }
    if (!(event instanceof KeyboardEvent) || event.key !== "Enter" && event.key !== " ")
      return;
    const row = event.target instanceof Element ? event.target.closest(".folder-row") : null;
    if (!row || !root.contains(row))
      return;
    event.preventDefault();
    selectFolder(row);
  }
  function onInput(event) {
    const mailForm = event.target instanceof Element ? event.target.closest("form[data-mail-scope-source]") : null;
    if (mailForm && root.contains(mailForm)) {
      const state = mailState(mailForm);
      state.edited = true;
      mailControls(mailForm, state);
      return;
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
    if (form.hasAttribute("data-mail-scope-source")) {
      event.preventDefault();
      approveMail(form);
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
    const pickerOpen = () => Array.from(scopeDrafts.values()).some((draft) => draft.loaded || draft.busy) || Array.from(mailDrafts.values()).some((state) => state.loaded || state.loading || state.busy || state.edited);
    if (disposed || inFlight || options.signal.aborted || !force && (!presented || dirty || pickerOpen()))
      return;
    inFlight = true;
    try {
      const result = await options.refresh();
      if (!result || disposed || options.signal.aborted)
        return;
      canWrite = result.can_write;
      if (!force && (dirty || pickerOpen())) {
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
      mailDrafts.clear();
      if (activeScopeSource)
        showScopePanel(activeScopeSource);
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
  panel: "#17181D",
  panel2: "#1B1C22",
  line: "#30323A",
  line2: "#24252B",
  t1: "#ECECEA",
  t2: "#C9CAD0",
  t3: "#A9ABB3",
  t4: "#8C8E97",
  good: "#6CC08B",
  warn: "#FB8C3C",
  run: "#FACC15",
  bad: "#F08276",
  off: "#8C8E97",
  runFill: "#FACC15",
  warnFill: "#FB8C3C",
  warnBg: "#261E10",
  warnLine: "#8A6A2A",
  errBg: "#2B1614",
  errLine: "#B04A40",
  link: "#9DB4F0",
  linkLine: "#5A7BD6",
  accent: "#3E63C8",
  onAccent: "#FFFFFF",
  field: "#6A6D77",
  selected: "#2C4485"
};
var DASHBOARD_THEME_TOKENS_LIGHT = {
  bg: "#FFFFFF",
  panel: "#F7F7F8",
  panel2: "#F0F0F2",
  line: "#D9D9DE",
  line2: "#E8E8EC",
  t1: "#0D0D0D",
  t2: "#353740",
  t3: "#55575F",
  t4: "#62646C",
  good: "#22693F",
  warn: "#A84A06",
  run: "#735600",
  bad: "#B42318",
  off: "#6B6E76",
  runFill: "#F5C518",
  warnFill: "#EA6C0A",
  warnBg: "#FFF4E5",
  warnLine: "#B45309",
  errBg: "#FDECEA",
  errLine: "#B42318",
  link: "#1F4FBF",
  linkLine: "#3E63C8",
  accent: "#3E63C8",
  onAccent: "#FFFFFF",
  field: "#767680",
  selected: "#DCE5FB"
};
var DASHBOARD_PAGE_BACKDROP = DASHBOARD_THEME_TOKENS.bg;
var DASHBOARD_TYPE_SCALE = {
  title: "22px",
  section: "16px",
  row: "15px",
  body: "14px",
  caption: "12.5px"
};
var DASHBOARD_CONTRAST_PAIRS = [
  ...["t1", "t2", "t3", "t4", "link", "warn", "bad", "good", "run"].flatMap((fg) => ["bg", "panel", "panel2", "warnBg", "errBg"].map((bg) => ({ fg, bg, min: 4.5 }))),
  { fg: "onAccent", bg: "accent", min: 4.5 },
  { fg: "t1", bg: "selected", min: 4.5 },
  { fg: "t2", bg: "selected", min: 4.5 },
  { fg: "accent", bg: "bg", min: 3 },
  { fg: "linkLine", bg: "bg", min: 3 },
  { fg: "linkLine", bg: "panel", min: 3 },
  { fg: "field", bg: "bg", min: 3 },
  { fg: "field", bg: "panel", min: 3 },
  { fg: "field", bg: "panel2", min: 3 },
  { fg: "warnLine", bg: "bg", min: 3 },
  { fg: "errLine", bg: "bg", min: 3 },
  { fg: "good", bg: "bg", min: 3 }
];
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
  runFill: "--run-fill",
  warnFill: "--warn-fill",
  warnBg: "--warn-bg",
  warnLine: "--warn-line",
  errBg: "--err-bg",
  errLine: "--err-line",
  link: "--link",
  linkLine: "--link-line",
  accent: "--accent-fill",
  onAccent: "--on-accent",
  field: "--field",
  selected: "--selected"
};
var DASHBOARD_STATUS_TOKENS = {
  Fresh: "good",
  Working: "runFill",
  Waiting: "off",
  "Needs you": "warnFill",
  Failing: "bad",
  Off: "off"
};
var DASHBOARD_STATUS_COLORS = Object.fromEntries(Object.keys(DASHBOARD_STATUS_TOKENS).map((status) => [status, `var(${dashboardThemeVariable(DASHBOARD_STATUS_TOKENS[status])})`]));
function dashboardThemeVariable(token) {
  return CSS_VARIABLE_NAMES[token];
}
var MONO_STACK = '"Berkeley Mono","SF Mono",Menlo,Consolas,monospace';
var ROOT_BLOCK = [
  ":root {",
  "  color-scheme: light dark;",
  ...Object.keys(CSS_VARIABLE_NAMES).map((key) => `  ${CSS_VARIABLE_NAMES[key]}: ${DASHBOARD_THEME_TOKENS[key]};`),
  `  --mono: ${MONO_STACK};`,
  `  --fs-title: ${DASHBOARD_TYPE_SCALE.title};`,
  `  --fs-section: ${DASHBOARD_TYPE_SCALE.section};`,
  `  --fs-row: ${DASHBOARD_TYPE_SCALE.row};`,
  `  --fs-body: ${DASHBOARD_TYPE_SCALE.body};`,
  `  --fs-caption: ${DASHBOARD_TYPE_SCALE.caption};`,
  "}",
  "@media (prefers-color-scheme: light) {",
  "  :root {",
  ...Object.keys(CSS_VARIABLE_NAMES).map((key) => `    ${CSS_VARIABLE_NAMES[key]}: ${DASHBOARD_THEME_TOKENS_LIGHT[key]};`),
  "  }",
  "}"
].join(`
`);
var DASHBOARD_THEME_CSS = `${ROOT_BLOCK}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--t1); font: var(--fs-body)/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 0 24px 80px; }
a { color: var(--link); }
/* No card around the page: the page is the surface, as wide as a reading
   layout allows, and every row below shares its left and right edges. */
.frame { max-width: 1120px; margin: 0 auto; }
.page { padding: 28px 0 40px; }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; margin-bottom: 20px; }
.brand { font-weight: 650; font-size: var(--fs-title); letter-spacing: -.01em; }
.brand .lead { color: var(--t3); text-decoration: none; }
.brand a.lead:hover, .brand a.lead:focus-visible { color: var(--link); }
.brand .crumb { color: var(--t3); font-weight: 400; }
.meta { color: var(--t3); font-size: var(--fs-caption); }
.meta b { font-weight: 600; }
/* Section headings: sentence case at a readable size, never tiny capitals. */
.sect { font-size: var(--fs-section); font-weight: 600; color: var(--t1); margin: 28px 0 10px; }
.sect.attn { color: var(--warn); }
.sect.sub { font-size: var(--fs-body); color: var(--t2); margin: 18px 0 8px; }
.sect.sub.attn { color: var(--warn); }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
.dot.hollow { background: transparent; border: 2px solid var(--off); }
/* Every row is the same shape: a 20px lead column (icon or dot), the text,
   then the controls, so names line up from section to section. */
.attncard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 52px; }
.attncard::before { content: ''; flex: 0 0 20px; align-self: center; }
/* A problem is a tinted row with a 1px border and an icon, never a stripe. */
.attncard:not(.plain) { background: var(--warn-bg); border-color: var(--warn-line); }
.attncard:not(.plain)::before { content: '!'; height: 20px; border-radius: 50%; background: var(--warn-fill); color: var(--bg); font-weight: 800; font-size: var(--fs-caption); line-height: 20px; text-align: center; }
.attncard.error { background: var(--err-bg); border-color: var(--err-line); }
.attncard.error::before { background: var(--bad); }
.attncard.plain { background: var(--panel); border-color: var(--line); }
.attncard.plain[data-remote-access]::before, .attncard.plain[data-agent-connection]::before { display: none; }
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
.attncard .name { font-weight: 600; font-size: var(--fs-row); }
.attncard .why { color: var(--t2); font-size: var(--fs-body); }
/* A warning row that carries no control is itself the link to the detail page,
   so its whole rectangle is the hit zone. */
a.attncard.rowzone { display: flex; color: inherit; text-decoration: none; -webkit-user-drag: none; }
a.attncard.rowzone:hover { border-color: var(--link); }
a.attncard.rowzone:hover .name, a.attncard.rowzone:hover .go { color: var(--link); }
a.attncard.rowzone:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
a.attncard.rowzone .go { color: var(--t3); font-size: var(--fs-body); }
/* A warning row that DOES carry a control keeps the control and links its name. */
.attncard a.name { color: inherit; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
.attncard a.name:hover { color: var(--link); text-decoration-color: var(--link); }
.attncard a.go { color: var(--t3); font-size: var(--fs-body); text-decoration: none; padding: 0 2px; }
.attncard a.go:hover { color: var(--link); }
.attncard a.name:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; border-radius: 4px; }
.rowlink { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rowlink .btn { text-decoration: none; display: inline-block; }
.blurb .ext { color: var(--link); }
.hint { color: var(--t3); font-size: var(--fs-caption); }
/* Two button styles and no third: filled for the row's one main action,
   outlined for everything else. Links are for navigation only. */
.btn { border: 1px solid var(--link-line); color: var(--link); border-radius: 7px; padding: 6px 14px; font: inherit; font-size: var(--fs-body); font-weight: 500; line-height: 1.3; background: none; cursor: pointer; white-space: nowrap; }
.btn:hover { background: var(--panel2); }
.btn:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.btn.primary { background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-accent); }
.btn.primary:hover { filter: brightness(1.12); }
/* A blocked control looks blocked and says why beside itself. */
.btn:disabled, .btn[aria-disabled="true"] { background: transparent; border: 1px dashed var(--line); color: var(--t4); cursor: not-allowed; filter: none; }
.blocked { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.blocked .hint { color: var(--t3); }
.blocked .hint::before { content: '\\1F512\\FE0E  '; font-size: 11px; }
/* The row's secondary acts (Disconnect, Provider access, Replace key, Cancel)
   live behind one ⋯ menu: a native <details>, so it works before any script. */
details.rowmenu { position: relative; flex: none; }
details.rowmenu > summary { list-style: none; padding: 4px 10px; font-size: var(--fs-row); line-height: 1.2; letter-spacing: .08em; border-color: var(--line); color: var(--t2); }
details.rowmenu > summary::-webkit-details-marker { display: none; }
details.rowmenu[open] > summary { background: var(--panel2); }
.rowmenu .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 200px; background: var(--panel2); border: 1px solid var(--line); border-radius: 9px; padding: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.45); display: grid; gap: 2px; }
.rowmenu .menu form { display: grid; gap: 2px; margin: 0; }
.rowmenu .menu .btn, .rowmenu .menu a.hint { display: block; width: 100%; text-align: left; border: 0; border-radius: 6px; padding: 7px 10px; color: var(--t1); font-size: var(--fs-body); text-decoration: none; background: none; }
.rowmenu .menu .btn:hover, .rowmenu .menu a.hint:hover { background: var(--panel); color: var(--link); }
.rowmenu .menu .actmsg { padding: 0 10px; }
/* The page's one blocker: full width at the top, a real warning colour. */
.attncard.blocker { margin: 0 0 24px; padding: 16px 18px; }
.attncard.blocker .name { color: var(--t1); font-size: var(--fs-row); }
/* Technical detail under a problem, closed by default. */
details.howto { margin: 6px 0 0; }
details.howto > summary { color: var(--link); font-size: var(--fs-caption); cursor: pointer; }
details.howto > summary:hover { text-decoration: underline; }
details.howto[open] > summary { margin-bottom: 6px; }
details.howto p { margin: 0 0 6px; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 22px; }
.cards.four { grid-template-columns: repeat(4, 1fr); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.card .hd { display: flex; gap: 9px; align-items: center; font-weight: 600; font-size: var(--fs-row); }
.card .ln { color: var(--t3); font-size: var(--fs-caption); margin-top: 6px; }
/* The whole card is the link. Hover and focus land on the card, not the name:
   the border warms and the name follows it, so the affordance is the shape the
   pointer is actually over. -webkit-user-drag keeps a text selection inside the
   card from turning into a link drag. */
a.card.cardlink { display: block; color: inherit; text-decoration: none; -webkit-user-drag: none; }
a.card.cardlink:hover { border-color: var(--link-line); }
a.card.cardlink:hover .hd { color: var(--link); }
a.card.cardlink:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.bar { height: 8px; background: var(--line2); border: 1px solid var(--line); border-radius: 5px; overflow: hidden; margin-top: 9px; max-width: 420px; }
.bar i { display: block; height: 100%; background: var(--run-fill); }
.foot { color: var(--t3); font-size: var(--fs-caption); margin-top: 24px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0 22px; }
.kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.kpi .u { font-size: var(--fs-caption); color: var(--t3); }
.kpi .n { font-size: var(--fs-section); font-weight: 650; margin-top: 3px; font-variant-numeric: tabular-nums; }
.kpi .s { font-size: var(--fs-caption); color: var(--t3); margin-top: 1px; }
.selectioncounts { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 22px; }
.selectioncounts div { display: flex; gap: 8px; align-items: baseline; }
.selectioncounts span { color: var(--t3); font-size: var(--fs-caption); }
.selectioncounts b { color: var(--t1); font-size: var(--fs-body); font-weight: 600; font-variant-numeric: tabular-nums; }
.dsect { font-size: var(--fs-section); font-weight: 600; color: var(--t1); margin: 28px 0 10px; }
/* A heading one level under .dsect: sentence case, because it is a sentence
   about the chips beneath it rather than another section label. */
.subsect { font-size: var(--fs-caption); color: var(--t3); margin: 12px 0 6px; }
/* The who-acts summary, directly under its section heading — .foot's 22px top
   margin would detach it from the total it is explaining. */
.reviewsum { color: var(--t3); font-size: var(--fs-caption); margin: 0 0 4px; }
.bigstrip { display: flex; gap: 3px; margin: 8px 0 4px; }
.bigstrip i { width: 14px; height: 30px; border-radius: 2.5px; display: block; }
.stripcap { display: flex; justify-content: space-between; color: var(--t3); font-size: var(--fs-caption); margin-bottom: 4px; }
.tip { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 11px 14px; font-family: var(--mono); font-size: var(--fs-caption); color: var(--t2); margin: 10px 0 4px; max-width: 640px; }
.tip .h { color: var(--t3); font-size: var(--fs-caption); font-family: system-ui, sans-serif; font-weight: 600; margin-bottom: 4px; }
/* The consequence line under a failing check: plain language, in the page's own
   font, so the mechanical row above it stays the evidence and this stays the
   meaning. */
.tip .cq { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: var(--fs-caption); color: var(--t3); margin: 2px 0 8px 15px; }
.tip > .cq:last-child { margin-bottom: 0; }
/* Passing checks, collapsed. A page whose header reports a fault opens with the
   fault; the green rows are evidence a reader may unfold. */
.evidence { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; font-family: var(--mono); font-size: var(--fs-caption); color: var(--t2); margin: 6px 0 4px; max-width: 640px; }
.evidence > summary { color: var(--t3); font-size: var(--fs-caption); font-family: system-ui, sans-serif; font-weight: 600; cursor: pointer; }
.evidence > summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.evidence[open] > summary { margin-bottom: 4px; }
.ok { color: var(--good); }
.no { color: var(--bad); }
table { border-collapse: collapse; width: 100%; font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--t3); font-size: var(--fs-caption); font-weight: 600; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); }
td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--line2); color: var(--t2); }
/* A not-connected source: one flat list row, like the source rows above it. */
.setrow { display: grid; grid-template-columns: 20px minmax(140px, 200px) 1fr auto; gap: 12px; align-items: center; background: none; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 12px 0; margin: 0; min-height: 52px; }
.setrow > .dot { justify-self: center; }
.setrow.noblurb { grid-template-columns: 20px 1fr auto; }
.setrow .name { font-weight: 600; font-size: var(--fs-row); color: var(--t1); }
.setrow a.name { text-decoration: none; }
.setrow a.name:hover { color: var(--link); text-decoration: underline; }
.setrow .blurb { color: var(--t2); font-size: var(--fs-body); }
.setrow .blurb .caveat { color: var(--warn); font-weight: 600; }
.setrow .blurb details.howto { color: var(--t3); font-size: var(--fs-caption); }
.rowform { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.keyfield { background: var(--bg); border: 1px solid var(--field); border-radius: 7px; color: var(--t1); font: inherit; font-size: var(--fs-body); padding: 5px 10px; width: 190px; }
.keyfield::placeholder { color: var(--t4); }
.keyfield:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.actmsg { color: var(--t3); font-size: var(--fs-caption); }
.actmsg:empty { display: none; }
.copystatus { color: var(--t3); font-size: var(--fs-caption); margin-left: 8px; }
/* A panel opens in place: directly under the row that opened it, joined to
   it, never further down the page. */
.sheet { display: none; background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: -4px 0 12px; }
.sheet.on { display: block; }
.sheet h4 { margin: 0 0 6px; font-size: var(--fs-row); }
.sheet p { color: var(--t2); font-size: var(--fs-body); margin: 0 0 10px; max-width: 72ch; }
.sheet .providernote { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; padding: 9px 12px; }
.sheet .providernote::before { content: '! '; color: var(--warn); font-weight: 800; }
.promptbox { background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 12px 14px; font-family: var(--mono); font-size: var(--fs-caption); color: var(--t2); white-space: pre-wrap; user-select: all; margin-bottom: 10px; word-break: break-all; }
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
.sheet .steps { margin: 0 0 14px; padding-left: 22px; color: var(--t2); font-size: var(--fs-body); max-width: 72ch; }
.sheet .steps li { margin-bottom: 10px; }
.sheet .steps li:last-child { margin-bottom: 0; }
.sheet .steps b { color: var(--t1); font-weight: 600; }
.sheet .steps .promptbox { margin-top: 6px; }
.sheet .steps .ext { color: var(--link); }
/* The agent prompt, now secondary to the steps above it. */
.sheet .agentprompt { margin-top: 14px; }
.sheet .agentprompt summary { color: var(--link); font-size: var(--fs-caption); cursor: pointer; margin-bottom: 8px; }
.sheet .agentprompt summary:hover { text-decoration: underline; }
@media (max-width: 700px) {
  body { padding: 0 16px 60px; }
  .page { padding: 20px 0 28px; }
  .cards, .cards.four { grid-template-columns: 1fr 1fr; }
  .kpis { grid-template-columns: 1fr 1fr; }
  .setrow { grid-template-columns: 20px 1fr auto; }
  .setrow .blurb { grid-column: 1 / -1; grid-row: 2; }
  .setrow .btn { justify-self: end; width: max-content; }
  /* A row's control and its hint wrap under the reason rather than squeezing
     the name to nothing on a 375px screen. A whole-row link is excluded: its
     arrow is one glyph and belongs beside the text, not on a line of its own. */
  .attncard:not(.rowzone) { flex-wrap: wrap; }
  .attncard:not(.rowzone) .grow { flex-basis: calc(100% - 32px); }
  .rowlink { width: 100%; justify-content: flex-end; }
}
`;

// src/workers/dashboard/static-styles.ts
var DASHBOARD_LANE_CSS = `.bgrow { position: relative; display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; color: inherit; text-decoration: none; }
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
var DASHBOARD_PROGRESS_CSS = `.phase { margin: 0 0 14px; max-width: 520px; }
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
var DASHBOARD_POLICY_CSS = `.scoperow { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 10px 14px; margin-bottom: 6px; }
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
var DASHBOARD_NAV_CSS = `.top { position: sticky; top: 0; z-index: 12; background: var(--bg); padding-top: 2px; }
.dnav { position: sticky; top: 39px; z-index: 11; display: flex; gap: 4px; margin: -8px 0 22px; border-bottom: 1px solid var(--line2); background: var(--bg); }
.dnav .dnavlink { color: var(--t3); text-decoration: none; font-size: var(--fs-caption); padding: 6px 12px 8px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dnav .dnavlink:hover { color: var(--link); }
.dnav .dnavlink:focus-visible { outline: 1px solid var(--link); outline-offset: -2px; border-radius: 4px; }
.dnav .dnavlink.on { color: var(--t1); border-bottom-color: var(--link-line); }
`;
var SETUP_JOURNEY_CSS = `.setupsummary { color: var(--t2); font-size: var(--fs-body); margin: 0 0 18px; }`;
var BACKGROUND_CSS = `.lane { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
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
var DISPOSITIONS_CSS = `
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
var AGENT_CONNECT_CSS = `.agentpick { display: grid; gap: 6px; margin: 4px 0 0; }
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
var MODEL_SETUP_CSS = `
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
var DASHBOARD_SOURCE_ROWS_CSS = `
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
var DASHBOARD_PRIVACY_CSS = `
.privacy { max-width: 760px; }
.ptitle { font-size: var(--fs-title); font-weight: 650; margin: 8px 0 6px; color: var(--t1); }
.pintro { color: var(--t2); margin: 0 0 18px; max-width: 72ch; }
.pnote { color: var(--t2); margin: 0 0 12px; }
.plabel { display: block; font-weight: 600; font-size: var(--fs-body); color: var(--t1); margin: 0 0 6px; }
.ptext { display: block; width: 100%; min-height: 120px; resize: vertical; background: var(--bg); border: 1px solid var(--field); border-radius: 8px; color: var(--t1); font: inherit; font-size: var(--fs-row); padding: 10px 12px; }
.ptext:focus-visible, .ptextline:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
/* The follow-up questions: one row per choice, its name and a Private / Fine to share radio pair. */
.pquestions .pnote { margin: 6px 0 0; }
.pqtopic { margin: 14px 0 0; }
.pqtitle { font-size: var(--fs-body); font-weight: 600; color: var(--t1); margin: 0 0 4px; }
.pqopt { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 16px; padding: 4px 0; border-bottom: 1px solid var(--line); }
.pqlabel { flex: 1 1 240px; min-width: 0; color: var(--t1); }
.pqchoices { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.pqchoice { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; cursor: pointer; color: var(--t1); }
.pqchoice input { width: 16px; height: 16px; margin: 0; accent-color: var(--link); }
.pqchoice input:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
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
  MODEL_SETUP_CSS,
  AGENT_CONNECT_CSS,
  BACKGROUND_CSS,
  DISPOSITIONS_CSS,
  DASHBOARD_SOURCE_ROWS_CSS,
  DASHBOARD_PRIVACY_CSS
].join(`
`)) + `
:host { display: block; min-width: 0; color-scheme: light dark; contain: content; }
.olympus-control-ui { min-height: 100%; }
.olympus-control-ui [data-write-capability-note] { margin: 0 auto 12px; max-width: 1120px; }
.olympus-control-ui .native-state { max-width: 1120px; margin: 24px auto; padding: 18px 20px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--t2); }
`;

// src/workers/dashboard/shared-privacy-logic.ts
function privacyLogic(config) {
  const KINDS = ["folder", "label", "sender"];
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DOMAIN = /^@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  const text = (value) => typeof value === "string" && value.trim() !== "";
  function validRule(rule) {
    if (!rule || typeof rule !== "object" || KINDS.indexOf(rule.kind) < 0)
      return false;
    if (rule.kind === "sender")
      return rule.source_id === config.mailSourceId && text(rule.value);
    if (rule.kind === "label")
      return rule.source_id === config.mailSourceId && text(rule.key) && text(rule.value);
    return Object.prototype.hasOwnProperty.call(config.folderSources, rule.source_id) && text(rule.key) && (rule.display === undefined || typeof rule.display === "string");
  }
  function displayOf(rule, unnamed) {
    if (rule.kind === "sender" || rule.kind === "label")
      return String(rule.value);
    return text(rule.display) ? String(rule.display) : unnamed;
  }
  function viewRule(rule, display) {
    const raw = {};
    for (const field of Object.keys(rule))
      raw[field] = rule[field];
    const copy = { kind: rule.kind, source_id: rule.source_id, display, removed: false, saved: true, raw };
    if (typeof rule.key === "string")
      copy.key = rule.key;
    if (typeof rule.value === "string")
      copy.value = rule.value;
    return copy;
  }
  function identity(rule) {
    const matched = rule.kind === "sender" ? typeof rule.value === "string" ? rule.value.trim().toLowerCase() : "" : typeof rule.key === "string" ? rule.key.trim() : "";
    return rule.kind + `
` + rule.source_id + `
` + matched;
  }
  function ruleOut(rule) {
    if (rule.raw)
      return rule.raw;
    const out = { kind: rule.kind, source_id: rule.source_id };
    if (typeof rule.key === "string")
      out.key = rule.key;
    if (typeof rule.value === "string")
      out.value = rule.value;
    if (rule.kind === "folder" && text(rule.display))
      out.display = rule.display;
    return out;
  }
  function addTo(rules, rule) {
    const id = identity(rule);
    const existing = rules.filter((other) => identity(other) === id)[0];
    if (existing)
      existing.removed = false;
    else
      rules.push(rule);
    return rules;
  }
  function lowering(rules, description, savedDescription) {
    return {
      removed: rules.filter((rule) => rule.saved && rule.removed),
      described: description.trim() !== savedDescription
    };
  }
  function lowers(rules, description, savedDescription) {
    const change = lowering(rules, description, savedDescription);
    return change.removed.length > 0 || change.described;
  }
  function replay(draft, fresh) {
    const removed = {};
    for (const rule of draft.rules)
      if (rule.saved && rule.removed)
        removed[identity(rule)] = true;
    const additions = draft.rules.filter((rule) => !rule.saved && !rule.removed);
    const described = draft.description.trim() !== draft.savedDescription ? draft.description : null;
    for (const rule of fresh)
      if (removed[identity(rule)])
        rule.removed = true;
    for (const rule of additions)
      addTo(fresh, rule);
    return { rules: fresh, description: described };
  }
  function senderValue(input) {
    const value = String(input || "").trim().toLowerCase();
    return EMAIL.test(value) || DOMAIN.test(value) ? value : "";
  }
  const DESCRIPTION_MAX = 2000;
  const TOPICS = [
    { id: "family", words: ["family", "families", "familial", "kid", "kids", "child", "children", "son", "sons", "daughter", "daughters", "parent", "parents", "mother", "father", "mom", "dad", "spouse", "wife", "husband", "sibling", "siblings"], options: [
      ["medical", "private"],
      ["legal_money", "private"],
      ["conversations", "private"],
      ["logistics", "share"],
      ["contacts", "share"],
      ["history", "share"]
    ] },
    { id: "health", words: ["health", "healthcare", "health care", "medical"], options: [
      ["results", "private"],
      ["prescriptions", "private"],
      ["therapy", "private"],
      ["exports", "private"],
      ["wellness", "share"],
      ["guides", "share"],
      ["product_tests", "share"]
    ] },
    { id: "money", words: ["financial", "financials", "finance", "finances", "money", "bank", "banks", "banking"], options: [
      ["statements", "private"],
      ["tax", "private"],
      ["bills", "private"],
      ["loans", "private"],
      ["articles", "share"],
      ["projects", "share"],
      ["prices", "share"]
    ] },
    { id: "work", words: ["work", "job", "jobs", "career", "employment"], options: [
      ["contracts", "private"],
      ["hr", "private"],
      ["projects", "share"],
      ["meetings", "share"],
      ["wikis", "share"]
    ] },
    { id: "relationships", words: ["relationship", "relationships", "love", "love life", "partner", "partners", "intimate", "intimacy", "dating"], options: [
      ["journals", "private"],
      ["conversations", "private"],
      ["teachings", "share"],
      ["groups", "share"]
    ] },
    { id: "home", words: ["home", "homes", "house", "houses", "property", "properties"], options: [
      ["deeds", "private"],
      ["info", "share"],
      ["plans", "share"]
    ] }
  ];
  const words = config.topicWords;
  function topicById(id) {
    return TOPICS.filter((entry) => entry.id === id)[0];
  }
  function named(topic, text2) {
    const alternatives = topic.words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
    return new RegExp("(^|[^a-z0-9])(" + alternatives.join("|") + ")(?![a-z0-9])", "i").test(text2);
  }
  function leadOf(id) {
    if (!words || !words.topics[id])
      return "";
    return words.about.split("{topic}").join(words.topics[id].name);
  }
  function lineTopic(line) {
    if (!words)
      return "";
    const trimmed = line.trim();
    const parts = [words.privateList.split("{list}")[0], words.shareList.split("{list}")[0]];
    for (const topic of TOPICS) {
      const lead = leadOf(topic.id);
      if (!lead)
        continue;
      for (const part of parts)
        if (part && trimmed.indexOf(lead + " " + part) === 0)
          return topic.id;
    }
    return "";
  }
  function detectTopics(description) {
    const lines = String(description || "").split(`
`);
    const answered = lines.map(lineTopic);
    const own = lines.filter((_line, index) => !answered[index]).join(`
`);
    return TOPICS.filter((topic) => named(topic, own) || answered.indexOf(topic.id) >= 0).map((topic) => topic.id);
  }
  function holds(segment, label) {
    let from = 0;
    for (;; ) {
      const at = segment.indexOf(label, from);
      if (at < 0)
        return false;
      const before = segment.charAt(at - 1);
      const after = segment.charAt(at + label.length);
      if (/\s/.test(before) && (after === "" || /[\s,;.…]/.test(after)))
        return true;
      from = at + 1;
    }
  }
  function topicAnswers(description) {
    const out = {};
    if (!words)
      return out;
    const privatePrefix = words.privateList.split("{list}")[0];
    const sharePrefix = words.shareList.split("{list}")[0];
    for (const line of String(description || "").split(`
`)) {
      const id = lineTopic(line);
      const topic = topicById(id);
      if (!topic || out[id])
        continue;
      const body = line.trim().slice(leadOf(id).length);
      const p = body.indexOf(privatePrefix);
      const q = body.indexOf(sharePrefix);
      const privatePart = p < 0 ? "" : body.slice(p + privatePrefix.length, q > p ? q : body.length);
      const sharePart = q < 0 ? "" : body.slice(q + sharePrefix.length, p > q ? p : body.length);
      const answer = {};
      for (const [option, side] of topic.options) {
        const label = words.topics[id].options[option] || "";
        answer[option] = label && holds(" " + privatePart, label) ? "private" : label && holds(" " + sharePart, label) ? "share" : side;
      }
      out[id] = answer;
    }
    return out;
  }
  function sentence(id, answer) {
    const topic = topicById(id);
    if (!words || !topic || !words.topics[id])
      return "";
    const kept = [];
    const shared = [];
    for (const [option, side] of topic.options) {
      const label = words.topics[id].options[option] || "";
      if (label)
        ((answer[option] || side) === "private" ? kept : shared).push(label);
    }
    const parts = [];
    if (kept.length)
      parts.push(words.privateList.split("{list}").join(kept.join(", ")));
    if (shared.length)
      parts.push(words.shareList.split("{list}").join(shared.join(", ")));
    return leadOf(id) + " " + parts.join("; ") + ".";
  }
  function refineDescription(description, answers) {
    const text2 = String(description || "").replace(/\r\n/g, `
`);
    const refined = refineUnbounded(text2, answers);
    return refined.length > DESCRIPTION_MAX ? text2 : refined;
  }
  function fitsAnswers(description, answers) {
    return refineUnbounded(String(description || "").replace(/\r\n/g, `
`), answers).length <= DESCRIPTION_MAX;
  }
  function refineUnbounded(text2, answers) {
    if (!words)
      return text2;
    const lines = text2.split(`
`);
    for (const topic of TOPICS) {
      const answer = answers[topic.id];
      const line = answer ? sentence(topic.id, answer) : "";
      if (!line)
        continue;
      const at = lines.map(lineTopic).indexOf(topic.id);
      if (at >= 0)
        lines[at] = line;
      else {
        while (lines.length && lines[lines.length - 1].trim() === "")
          lines.pop();
        lines.push(line);
      }
    }
    return lines.join(`
`);
  }
  function questions(description) {
    if (!words)
      return [];
    const saved = topicAnswers(description);
    const out = [];
    for (const id of detectTopics(description)) {
      const topic = topicById(id);
      const said = words.topics[id];
      if (!topic || !said)
        continue;
      const answer = saved[id];
      out.push({
        id,
        name: said.name,
        question: said.question,
        answered: !!answer,
        options: topic.options.map(([option, side]) => ({
          id: option,
          label: said.options[option] || option,
          side: answer && answer[option] ? answer[option] : side
        }))
      });
    }
    return out;
  }
  function choiceAnswers(description, topicId, optionId, side) {
    const question = questions(description).filter((entry) => entry.id === topicId)[0];
    if (!question || side !== "private" && side !== "share")
      return null;
    const answer = {};
    for (const option of question.options)
      answer[option.id] = option.id === optionId ? side : option.side;
    const answers = {};
    answers[topicId] = answer;
    return answers;
  }
  function answerTopic(description, topicId, optionId, side) {
    const answers = choiceAnswers(description, topicId, optionId, side);
    if (!answers)
      return { description, fits: true };
    if (!fitsAnswers(description, answers))
      return { description, fits: false };
    return { description: refineDescription(description, answers), fits: true };
  }
  function withShownAnswers(description) {
    const answers = {};
    for (const question of questions(description)) {
      const answer = {};
      for (const option of question.options)
        answer[option.id] = option.side;
      answers[question.id] = answer;
    }
    return refineDescription(description, answers);
  }
  function questionsKey(description) {
    return JSON.stringify(questions(description));
  }
  return {
    validRule,
    displayOf,
    viewRule,
    identity,
    ruleOut,
    addTo,
    lowering,
    lowers,
    replay,
    senderValue,
    detectTopics,
    topicAnswers,
    refineDescription,
    fitsAnswers,
    questions,
    questionsKey,
    answerTopic,
    withShownAnswers
  };
}

// src/control-ui.ts
function routeFromProps(props) {
  const view = props.view;
  if (view === "dispositions")
    return { view, ...props.source_id ? { source_id: props.source_id } : {} };
  if (view === "setup" || view === "background" || view === "sensitivity" || view === "privacy")
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
  if (url.searchParams.has("privacy"))
    return { view: "privacy" };
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
            privacyLogic,
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
