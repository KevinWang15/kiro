const state = {
  accounts: [],
  proxies: [],
  metricsRange: {
    from: new Date(Date.now() - 24 * 60 * 60 * 1000),
    to: new Date(),
    label: "Last 24 hours",
    isRolling: true,
  },
  historyRange: {
    from: new Date(Date.now() - 24 * 60 * 60 * 1000),
    to: new Date(),
    label: "Last 24 hours",
    isRolling: true,
  },
  historyEntries: [],
  historyPage: 1,
  historyTotalPages: 1,
  historyTotal: 0,
  historyExpanded: new Set(),
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const number = (value, digits = 1) =>
  Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
const date = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
const notyf = new Notyf({
  duration: 3500,
  dismissible: true,
  position: { x: "right", y: "bottom" },
  types: [
    { type: "success", background: "#1f6f46", icon: false },
    { type: "error", background: "#9b3a44", icon: false },
  ],
});
function toast(message, error = false) {
  notyf.open({ type: error ? "error" : "success", message });
}
function refreshIcons() {
  lucide.createIcons({ attrs: { "stroke-width": 1.7 } });
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard access was denied");
  }
}
function openDialog(id) {
  $(id).showModal();
}
function closeDialog(id) {
  $(id).close();
}
// Loading indicators are delayed so fast responses never flash a spinner.
// First loads show inline spinners/skeletons (already in the HTML); refreshes
// keep the current content, dim it slightly and show a thin progress bar.
const LOADING_DELAY_MS = 180;
let activeLoads = 0;
let progressTimer;
function trackLoading(pageName, promise) {
  const page = $(`#${pageName}-page`);
  activeLoads++;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    if (activeLoads > 0) $("#progress-bar").classList.add("active");
  }, LOADING_DELAY_MS);
  const dimTimer = page?.dataset.loaded
    ? setTimeout(() => page.classList.add("refreshing"), LOADING_DELAY_MS)
    : null;
  return Promise.resolve(promise).finally(() => {
    clearTimeout(dimTimer);
    page?.classList.remove("refreshing");
    if (page) page.dataset.loaded = "true";
    if (--activeLoads === 0) {
      clearTimeout(progressTimer);
      $("#progress-bar").classList.remove("active");
    }
  });
}

function showPage(name) {
  $$(".page").forEach((p) => p.classList.toggle("hidden", p.id !== `${name}-page`));
  $$("[data-nav]").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === name),
  );
  if (name === "metrics" || name === "history") syncRangeFromUrl(name);
  if (name === "accounts") trackLoading("accounts", loadAccounts());
  if (name === "metrics") trackLoading("metrics", loadMetrics());
  if (name === "history") trackLoading("history", loadHistory());
  if (name === "proxies") trackLoading("proxies", loadProxies());
  requestAnimationFrame(() => chartInstances.forEach((chart) => chart.resize()));
}

// Client-side navigation: switching views no longer reloads the document,
// so the titlebar, rail and already-fetched data stay on screen.
// Rail links point at bare paths; reuse the range last shown on that page.
const lastRangeSearch = {};
function navigate(path) {
  const url = new URL(path, location.origin);
  const page = pageForPath(url.pathname);
  if (!url.search && lastRangeSearch[page]) url.search = lastRangeSearch[page];
  const target = url.pathname + url.search;
  if (location.pathname + location.search !== target)
    history.pushState({}, "", target);
  showPage(currentPage());
}
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href^='/']");
  if (!link || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});

// Remember the last known account count so a full reload shows it at once
// instead of a placeholder; it is corrected as soon as the API answers.
const ACCOUNT_COUNT_KEY = "kiro.accountCount";
function setAccountCount(count) {
  const pill = $("#tab-account-count");
  pill.textContent = count;
  pill.setAttribute("aria-label", `${count} accounts`);
  try {
    localStorage.setItem(ACCOUNT_COUNT_KEY, String(count));
  } catch {}
}
try {
  const cached = localStorage.getItem(ACCOUNT_COUNT_KEY);
  if (cached !== null) setAccountCount(Number(cached));
} catch {}

async function loadAccounts() {
  const button = $("#reload-accounts");
  button.disabled = true;
  button.classList.add("is-loading");
  button.setAttribute("aria-busy", "true");
  try {
    const data = await api("/api/accounts");
    state.accounts = data.accounts;
    renderAccounts();
    refreshIcons();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
  }
}
function renderAccounts() {
  const accounts = state.accounts;
  $("#account-count").textContent = `${accounts.length} total`;
  setAccountCount(accounts.length);
  $("#accounts-empty").classList.toggle("hidden", accounts.length > 0);
  const active = accounts.filter((a) => a.enabled && !a.autoDisabled).length;
  const credits = accounts.reduce(
    (sum, a) => sum + Number(a.statusInfo?.remaining || 0),
    0,
  );
  const used = accounts.reduce(
    (sum, a) => sum + Number(a.usage?.totalKiroCredits || 0),
    0,
  );
  const usd = accounts.reduce(
    (sum, a) => sum + Number(a.usage?.totalCostUsd || 0),
    0,
  );
  $("#account-summary").innerHTML = [
    summary(
      "Pool accounts",
      accounts.length,
      `${active} available for routing`,
    ),
    summary(
      "Credits remaining",
      number(credits),
      "Across accounts with fetched usage",
    ),
    summary(
      "Kiro credits consumed",
      number(used),
      "Reported by upstream metering",
    ),
    summary(
      "Estimated USD consumed",
      `$${number(usd, 2)}`,
      "Local token-based estimate",
    ),
  ].join("");
  $("#accounts-body").innerHTML = accounts
    .map((account) => {
      const status = account.statusInfo;
      const remaining = Number(status?.remaining || 0),
        limit = Number(status?.usageLimit || 0),
        percent = limit > 0 ? Math.min(100, (remaining / limit) * 100) : 0;
      const level = percent < 10 ? "low" : percent < 30 ? "medium" : "";
      const normal = account.enabled && !account.autoDisabled;
      const proxy = state.proxies.find((p) => p.id === account.proxyId);
      return `<tr><td>${account.id}</td><td class="provider">kiro</td><td class="token" title="${escapeHtml(account.maskedToken)}">${escapeHtml(account.maskedToken) || "—"}</td><td class="priority">${account.priority}</td><td><span class="badge ${normal ? "normal" : "disabled"}">${normal ? "Normal" : "Disabled"}</span>${account.disabledReason ? `<small title="${escapeHtml(account.disabledReason)}"> ⚠</small>` : ""}</td><td class="source">${escapeHtml(account.source)}</td><td class="date">${date(account.createdAt)}</td><td><div class="credit-label">Credits (${number(remaining, 2)}/${number(limit, 0)})</div><div class="credit-track"><div class="credit-fill ${level}" style="width:${percent}%"></div></div><div class="usage">Kiro usage<small>${number(account.usage?.totalKiroCredits)} credits / $${number(account.usage?.totalCostUsd)}</small></div></td><td class="proxy-name">${escapeHtml(proxy?.name || "Direct")}</td><td><div class="row-actions"><button class="button small" data-action="test" data-id="${account.id}" title="Test account"><i data-lucide="play"></i><span>Test</span></button><button class="button small" data-action="edit" data-id="${account.id}" title="Edit account"><i data-lucide="pencil"></i><span>Edit</span></button><button class="button small icon-only" data-action="refresh" data-id="${account.id}" title="Refresh OAuth token" aria-label="Refresh OAuth token"><i data-lucide="refresh-cw"></i></button><button class="button small danger icon-only" data-action="delete" data-id="${account.id}" title="Delete account" aria-label="Delete account"><i data-lucide="trash-2"></i></button></div></td></tr>`;
    })
    .join("");
}
function summary(label, value, note) {
  return `<div class="summary-card"><span class="label">${label}</span><strong>${value}</strong><small>${note}</small></div>`;
}

let parseDebounce;
function openImport() {
  $("#import-dialog-title").textContent = "Bulk import Kiro accounts";
  $("#submit-import").textContent = "Convert & import";
  $("#import-text").value = "";
  $("#detected-accounts").textContent = "0";
  $("#parse-error").textContent = "";
  $("#import-result").classList.add("hidden");
  $("#import-progress").classList.add("hidden");
  openDialog("#import-dialog");
}
async function parseImport() {
  const text = $("#import-text").value;
  if (!text.trim()) {
    $("#detected-accounts").textContent = "0";
    $("#parse-error").textContent = "";
    return;
  }
  try {
    const data = await api("/api/accounts/parse", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    $("#detected-accounts").textContent =
      `${data.count} — ${data.accounts.map((a) => a.label).join(", ")}`;
    $("#parse-error").textContent = "";
  } catch (error) {
    $("#detected-accounts").textContent = "0";
    $("#parse-error").textContent = error.message;
  }
}
async function submitImport() {
  const text = $("#import-text").value;
  if (!text.trim()) return toast("Paste credentials first", true);
  const button = $("#submit-import");
  button.disabled = true;
  $("#import-progress").classList.remove("hidden");
  $("#import-result").classList.add("hidden");
  try {
    const result = await api("/api/accounts/import", {
      method: "POST",
      body: JSON.stringify({ text, proxyMode: $("#import-proxy-mode").value }),
    });
    const output = $("#import-result");
    output.textContent = `Created: ${result.created}\nSkipped duplicates: ${result.skipped}\nWorking proxies: ${result.proxyCount}${result.failed.length ? `\nFailures:\n${result.failed.map((f) => `#${f.index + 1}: ${f.error}`).join("\n")}` : ""}`;
    output.classList.remove("hidden");
    await loadAccounts();
    if (!result.failed.length)
      setTimeout(() => closeDialog("#import-dialog"), 900);
  } catch (error) {
    $("#parse-error").textContent = error.message;
  } finally {
    button.disabled = false;
    $("#import-progress").classList.add("hidden");
  }
}
// ---------- Edit account ----------
let editingCredentialsJson = "";
const SIGN_IN_ICONS = {
  "API key": "key-square",
  Google: "log-in",
  GitHub: "log-in",
  "AWS Builder ID": "key-round",
  "IAM Identity Center": "building-2",
};
function relativeTime(value) {
  if (!value) return "—";
  const ms = new Date(value).getTime() - Date.now();
  const abs = Math.abs(ms);
  const units = [["day", 86400000], ["hour", 3600000], ["minute", 60000]];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) if (abs >= size) return fmt.format(Math.round(ms / size), unit);
  return ms >= 0 ? "in under a minute" : "just now";
}
function fact(label, value, title = "") {
  return `<div><dt>${label}</dt><dd${title ? ` title="${escapeHtml(title)}"` : ""}>${value}</dd></div>`;
}
function renderAccountOverview(account) {
  const status = account.statusInfo;
  const summary = account.credentialSummary || {};
  const remaining = Number(status?.remaining || 0);
  const limit = Number(status?.usageLimit || 0);
  const percent = limit > 0 ? Math.min(100, (remaining / limit) * 100) : 0;
  const level = percent < 10 ? "low" : percent < 30 ? "medium" : "";
  const active = account.enabled && !account.autoDisabled;
  const state = account.autoDisabled
    ? `<span class="badge disabled" title="${escapeHtml(account.disabledReason || "")}">Auto-disabled</span>`
    : `<span class="badge ${active ? "normal" : "disabled"}">${active ? "Active" : "Paused"}</span>`;
  $("#edit-overview").innerHTML = `
    <div class="overview-main">
      <span class="method-icon"><i data-lucide="${SIGN_IN_ICONS[summary.signIn] || "user"}"></i></span>
      <div>
        <strong>${escapeHtml(summary.email || summary.signIn || "Kiro account")}</strong>
        <small>${escapeHtml(summary.email ? summary.signIn : status?.subscriptionTitle || "Plan unknown")}${summary.email && status?.subscriptionTitle ? ` · ${escapeHtml(status.subscriptionTitle)}` : ""}</small>
      </div>
      ${state}
    </div>
    <div class="overview-credits">
      <div class="credit-label">${status ? `${number(remaining, 2)} of ${number(limit, 0)} credits left` : "Credits not fetched yet"}${status?.nextResetAt ? ` · resets ${relativeTime(status.nextResetAt)}` : ""}</div>
      <div class="credit-track"><div class="credit-fill ${level}" style="width:${percent}%"></div></div>
      <small>Used through this adapter: ${number(account.usage?.totalKiroCredits)} credits · $${number(account.usage?.totalCostUsd, 2)} estimated</small>
    </div>
    ${account.autoDisabled && account.disabledReason ? `<p class="overview-warning"><i data-lucide="triangle-alert"></i>${escapeHtml(account.disabledReason)}</p>` : ""}`;
  const expired = summary.expiresAt && new Date(summary.expiresAt).getTime() < Date.now();
  $("#edit-credential-facts").innerHTML = [
    fact("Signed in with", escapeHtml(summary.signIn || "—")),
    fact("Region", escapeHtml(summary.runtimeRegion && summary.runtimeRegion !== summary.region ? `${summary.region} · runs in ${summary.runtimeRegion}` : summary.region || "—")),
    summary.method === "api_key"
      ? fact("API key", `<code>${escapeHtml(summary.accessTokenHint || "—")}</code>`)
      : fact("Access token", summary.expiresAt ? `<span class="${expired ? "text-warn" : ""}">${expired ? "expired" : "expires"} ${relativeTime(summary.expiresAt)}</span>` : "—", summary.expiresAt ? date(summary.expiresAt) : ""),
    summary.method === "api_key"
      ? ""
      : fact("Refresh token", summary.hasRefreshToken ? `<code>${escapeHtml(summary.refreshTokenHint)}</code> · renewed automatically` : '<span class="text-warn">missing — sign in again to keep this account working</span>'),
    summary.startUrl ? fact("Start URL", escapeHtml(summary.startUrl)) : "",
  ].join("");
  $("#edit-refresh-token").hidden = summary.method === "api_key" || !summary.hasRefreshToken;
}
async function editAccount(id) {
  try {
    const account = await api(`/api/accounts/${id}`);
    $("#edit-account-id").value = id;
    $("#account-dialog-eyebrow").textContent = `Account #${id}`;
    $("#account-dialog-title").textContent = account.comment && !/^(Bulk imported Kiro account|Added manually|Signed in with .*)$/.test(account.comment)
      ? account.comment
      : account.credentialSummary?.email || account.credentialSummary?.signIn || `Account ${id}`;
    renderAccountOverview(account);
    editingCredentialsJson = JSON.stringify(account.credentials, null, 2);
    $("#edit-credentials").value = editingCredentialsJson;
    $("#edit-advanced").open = false;
    $("#edit-convert").checked = false;
    $("#edit-priority").value = account.priority;
    $("#edit-comment").value = account.comment;
    $("#edit-enabled").checked = account.enabled && !account.autoDisabled;
    $("#edit-enabled-hint").textContent = account.autoDisabled
      ? "Turned off automatically. Switch on to try it again."
      : "Requests can be routed to this account.";
    $("#edit-proxy").value = account.proxyId || "";
    $("#edit-error").textContent = "";
    refreshIcons();
    openDialog("#account-dialog");
    // New accounts may not have credits yet; fetch them now instead of waiting
    // for the background refresh.
    if (!account.statusInfo)
      api(`/api/accounts/${id}/usage`, { method: "POST" })
        .then(() => api(`/api/accounts/${id}`))
        .then((fresh) => {
          if ($("#account-dialog").open && $("#edit-account-id").value === String(id)) {
            renderAccountOverview(fresh);
            refreshIcons();
          }
        })
        .catch(() => {});
  } catch (error) {
    toast(error.message, true);
  }
}
async function saveAccount() {
  const id = $("#edit-account-id").value;
  const button = $("#save-account");
  const payload = {
    priority: Math.max(1, Number($("#edit-priority").value) || 1),
    comment: $("#edit-comment").value,
    enabled: $("#edit-enabled").checked,
    autoDisabled: $("#edit-enabled").checked ? false : undefined,
    disabledReason: $("#edit-enabled").checked ? null : undefined,
    proxyId: $("#edit-proxy").value ? Number($("#edit-proxy").value) : null,
  };
  // Only send credentials when the advanced editor was actually changed.
  const raw = $("#edit-credentials").value;
  if (raw.trim() !== editingCredentialsJson.trim() || $("#edit-convert").checked) {
    try {
      payload.credentials = JSON.parse(raw);
    } catch {
      $("#edit-advanced").open = true;
      $("#edit-error").textContent = "The raw credential isn't valid JSON.";
      return;
    }
    payload.convert = $("#edit-convert").checked;
  }
  button.disabled = true;
  try {
    await api(`/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
    closeDialog("#account-dialog");
    await loadAccounts();
    toast("Account saved");
  } catch (error) {
    $("#edit-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
async function runEditAction(button, work, done) {
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    await work();
    toast(done);
    const account = await api(`/api/accounts/${$("#edit-account-id").value}`);
    renderAccountOverview(account);
    editingCredentialsJson = JSON.stringify(account.credentials, null, 2);
    if (!$("#edit-advanced").open) $("#edit-credentials").value = editingCredentialsJson;
    refreshIcons();
    loadAccounts();
  } catch (error) {
    $("#edit-error").textContent = error.message;
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

// ---------- New account ----------
const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) && location.protocol === "http:";
const newAccount = { method: null, step: "choose", login: null, pollTimer: null, popup: null };
const NA_STEPS = ["choose", "configure", "waiting", "manual", "done"];
const METHOD_TITLES = {
  kiro: "Sign in with Kiro",
  "builder-id": "Sign in with AWS Builder ID",
  "identity-center": "Sign in with IAM Identity Center",
  manual: "Enter account details",
};

function naShow(step) {
  newAccount.step = step;
  for (const name of NA_STEPS) $(`#na-${name}`).hidden = name !== step;
  const method = newAccount.method;
  $("#new-account-title").textContent = step === "choose" ? "Add a Kiro account" : step === "done" ? "Account added" : METHOD_TITLES[method];
  $("#new-account-step").textContent = step === "choose" ? "Step 1 of 2" : step === "done" ? "Done" : "Step 2 of 2";
  $("#na-back").hidden = step === "choose" || step === "done";
  $("#na-settings-wrap").hidden = !(step === "configure" || step === "manual" || step === "waiting");
  const primary = $("#na-primary");
  primary.hidden = !(step === "configure" || step === "manual" || step === "done");
  primary.disabled = false;
  primary.innerHTML = step === "configure"
    ? '<i data-lucide="log-in"></i><span>Continue to sign-in</span>'
    : step === "manual"
      ? '<i data-lucide="user-plus"></i><span>Add account</span>'
      : '<span>Add another</span>';
  $("#na-cancel").textContent = step === "done" ? "Close" : "Cancel";
  refreshIcons();
}
function naReset() {
  naStopPolling(true);
  newAccount.method = null;
  newAccount.login = null;
  $("#na-configure-error").textContent = "";
  $("#na-manual-error").textContent = "";
  $("#na-priority").value = 1;
  $("#na-comment").value = "";
  $("#na-proxy").value = "";
  $("#na-settings").open = false;
  for (const id of ["nm-api-key", "nm-refresh", "nm-client-id", "nm-client-secret", "nm-starturl", "na-starturl"]) $(`#${id}`).value = "";
  naShow("choose");
}
function openNewAccount() {
  naReset();
  $("#na-current-host").textContent = location.host;
  $("#na-loopback-note").hidden = isLoopback;
  $$("[data-loopback-tag]").forEach((tag) => (tag.hidden = isLoopback));
  $$('.method-card[data-method="kiro"], .method-card[data-method="identity-center"]').forEach((card) => {
    card.disabled = !isLoopback;
    card.title = isLoopback ? "" : "Open the dashboard at localhost or 127.0.0.1 to use this option";
  });
  openDialog("#new-account-dialog");
}
function naChoose(method) {
  newAccount.method = method;
  if (method === "manual") {
    naSetKind("api_key");
    naShow("manual");
    $("#nm-api-key").focus();
    return;
  }
  const idc = method === "identity-center";
  $("#na-starturl-field").hidden = !idc;
  $("#na-region-hint").textContent = idc
    ? "The region your organization's IAM Identity Center is in."
    : method === "builder-id"
      ? "Builder ID always signs in through us-east-1."
      : "Kiro's sign-in region. Most accounts use us-east-1.";
  $("#na-region").value = "us-east-1";
  $("#na-region").disabled = method === "builder-id";
  if (method === "kiro" || method === "builder-id") return naStartLogin();
  naShow("configure");
  $("#na-starturl").focus();
}
function naCommonOptions(prefix = "na") {
  return {
    priority: Math.max(1, Number($(`#${prefix}-priority`).value) || 1),
    comment: $(`#${prefix}-comment`).value,
    proxyId: $(`#${prefix}-proxy`).value || null,
  };
}
async function naStartLogin() {
  const method = newAccount.method;
  const body = {
    region: $("#na-region").value,
    origin: location.origin,
    proxyId: $("#na-proxy").value || null,
  };
  if (method === "identity-center") {
    body.startUrl = $("#na-starturl").value.trim();
    if (!/^https:\/\/.+/.test(body.startUrl)) {
      $("#na-configure-error").textContent = "Enter your start URL, starting with https://";
      naShow("configure");
      return;
    }
  }
  // Open the tab right away (inside the click) so popup blockers allow it;
  // it's pointed at the real sign-in URL once the server returns it.
  const popup = method === "builder-id" ? null : window.open("about:blank", "_blank");
  newAccount.popup = popup;
  const primary = $("#na-primary");
  primary.disabled = true;
  try {
    const login = await api(`/api/logins/${method}`, { method: "POST", body: JSON.stringify(body) });
    if (login.status === "failed") throw new Error(login.error || "Sign-in could not start");
    newAccount.login = login;
    $("#na-open-link").href = login.verificationUrl;
    $("#na-device").hidden = method !== "builder-id";
    $("#na-user-code").textContent = login.userCode || "";
    $("#na-waiting-text").textContent = method === "builder-id"
      ? "Open the AWS page, check that it shows this code, and approve. You can do this on any device."
      : method === "kiro"
        ? "Choose Google, GitHub or your organization in the Kiro tab that just opened. This page updates when you're done."
        : "Sign in with your organization in the tab that just opened. This page updates when you're done.";
    $("#na-status-text").textContent = "Waiting for you to finish…";
    if (popup && !popup.closed) popup.location.href = login.verificationUrl;
    naShow("waiting");
    naPoll();
  } catch (error) {
    if (popup && !popup.closed) popup.close();
    naShow(method === "identity-center" ? "configure" : "choose");
    if (method === "identity-center") $("#na-configure-error").textContent = error.message;
    else toast(error.message, true);
  } finally {
    primary.disabled = false;
  }
}
function naStopPolling(cancel = false) {
  clearTimeout(newAccount.pollTimer);
  newAccount.pollTimer = null;
  if (cancel && newAccount.login?.status === "pending")
    api(`/api/logins/${newAccount.login.id}`, { method: "DELETE" }).catch(() => {});
}
async function naPoll() {
  const login = newAccount.login;
  if (!login || newAccount.step !== "waiting") return;
  try {
    const current = await api(`/api/logins/${login.id}`);
    newAccount.login = current;
    if (current.status === "complete") return naFinishLogin(current);
    if (current.status !== "pending") {
      $("#na-status-text").textContent = current.error || "Sign-in stopped.";
      $(".signin-status .spinner").hidden = true;
      $(".signin-status").classList.add("is-error");
      return;
    }
  } catch (error) {
    $("#na-status-text").textContent = error.message;
  }
  newAccount.pollTimer = setTimeout(naPoll, 1500);
}
async function naFinishLogin(login) {
  $("#na-status-text").textContent = "Signed in. Adding the account…";
  try {
    const created = await api(`/api/logins/${login.id}/account`, { method: "POST", body: JSON.stringify(naCommonOptions()) });
    naDone(created.id, `Signed in with ${login.label}. Credits will appear in a moment.`);
  } catch (error) {
    $("#na-status-text").textContent = error.message;
    $(".signin-status .spinner").hidden = true;
    $(".signin-status").classList.add("is-error");
  }
}
function naDone(id, text) {
  newAccount.popup = null;
  $("#na-done-title").textContent = `Account #${id} added`;
  $("#na-done-text").textContent = text;
  naShow("done");
  loadAccounts();
}
function naSetKind(kind) {
  $$('input[name="na-kind"]').forEach((input) => (input.checked = input.value === kind));
  $$("#na-manual-fields [data-kind]").forEach((field) => {
    field.hidden = !field.dataset.kind.split(" ").includes(kind);
  });
  naUpdateStartUrlField();
  $("#na-manual-error").textContent = "";
}
function naUpdateStartUrlField() {
  const kind = $('input[name="na-kind"]:checked').value;
  $("#nm-starturl-field").hidden = !(kind === "idc" && $("#nm-idc-provider").value === "Enterprise");
}
async function naSubmitManual() {
  const kind = $('input[name="na-kind"]:checked').value;
  const region = $("#nm-region").value;
  const value = (id) => $(`#${id}`).value.trim();
  let credentials;
  if (kind === "api_key") {
    if (!value("nm-api-key")) return naManualError("Enter the API key.", "nm-api-key");
    credentials = { accessToken: value("nm-api-key"), authMethod: "api_key", region, runtimeRegion: region };
  } else if (kind === "social") {
    if (!value("nm-refresh")) return naManualError("Enter the refresh token.", "nm-refresh");
    credentials = { refreshToken: value("nm-refresh"), authMethod: "social", provider: $("#nm-provider").value, region };
  } else {
    const provider = $("#nm-idc-provider").value;
    if (!value("nm-refresh")) return naManualError("Enter the refresh token.", "nm-refresh");
    if (!value("nm-client-id")) return naManualError("Enter the client ID.", "nm-client-id");
    if (!value("nm-client-secret")) return naManualError("Enter the client secret.", "nm-client-secret");
    if (provider === "Enterprise" && !/^https:\/\/.+/.test(value("nm-starturl"))) return naManualError("Enter the start URL, starting with https://", "nm-starturl");
    credentials = {
      refreshToken: value("nm-refresh"),
      clientId: value("nm-client-id"),
      clientSecret: value("nm-client-secret"),
      authMethod: "IdC",
      provider,
      region,
      startUrl: provider === "Enterprise" ? value("nm-starturl") : "https://view.awsapps.com/start",
    };
  }
  const button = $("#na-primary");
  button.disabled = true;
  button.classList.add("is-loading");
  button.innerHTML = '<i data-lucide="loader-circle"></i><span>Checking…</span>';
  refreshIcons();
  try {
    const created = await api("/api/accounts/create", {
      method: "POST",
      body: JSON.stringify({ credentials, ...naCommonOptions(), source: kind === "api_key" ? "Added with an API key" : "Added manually" }),
    });
    naDone(created.id, kind === "api_key" ? "The API key was saved." : "The token was checked and a fresh access token was fetched.");
  } catch (error) {
    naManualError(error.message);
  } finally {
    button.classList.remove("is-loading");
    if (newAccount.step === "manual") naShow("manual");
  }
}
function naManualError(message, focusId) {
  $("#na-manual-error").textContent = message;
  if (focusId) $(`#${focusId}`).focus();
}
async function accountAction(action, id) {
  try {
    if (action === "edit") return editAccount(id);
    if (action === "delete" && $("#account-dialog").open) closeDialog("#account-dialog");
    if (action === "delete") {
      if (
        !confirm(
          `Delete account ${id}? Usage logs will be retained without an account link.`,
        )
      )
        return;
      await api(`/api/accounts/${id}`, { method: "DELETE" });
      toast("Account deleted");
    } else if (action === "refresh") {
      await api(`/api/accounts/${id}/refresh`, { method: "POST" });
      toast("Access token refreshed");
    } else if (action === "test") {
      toast(`Testing account ${id}…`);
      await api(`/api/accounts/${id}/test`, { method: "POST" });
      toast(`Account ${id} responded successfully`);
    }
    await loadAccounts();
  } catch (error) {
    toast(error.message, true);
    await loadAccounts();
  }
}
async function refreshAllUsage() {
  const button = $("#refresh-usage");
  const content = button.innerHTML;
  button.disabled = true;
  button.innerHTML =
    '<i data-lucide="loader-circle"></i><span>Refreshing…</span>';
  button.classList.add("is-loading");
  refreshIcons();
  let updated = 0;
  for (const account of state.accounts) {
    try {
      const result = await api(`/api/accounts/${account.id}/usage`, {
        method: "POST",
      });
      if (result.success) updated++;
    } catch {}
  }
  await loadAccounts();
  button.disabled = false;
  button.classList.remove("is-loading");
  button.innerHTML = content;
  refreshIcons();
  toast(`Updated credits for ${updated} account${updated === 1 ? "" : "s"}`);
}

async function loadProxies() {
  try {
    const data = await api("/api/proxies");
    state.proxies = data.proxies;
    renderProxies();
    renderProxyOptions();
    if (state.accounts.length) renderAccounts();
    refreshIcons();
  } catch (error) {
    toast(error.message, true);
  }
}
function renderProxies() {
  $("#proxies-empty").classList.toggle("hidden", state.proxies.length > 0);
  $("#proxies-body").innerHTML = state.proxies
    .map(
      (p) =>
        `<tr><td>${p.id}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.type)}</td><td>${escapeHtml(p.url)}</td><td>${p.basicAuthUsername ? "Basic auth" : "None"}</td><td><div class="row-actions"><button class="button small" data-proxy-action="test" data-id="${p.id}" title="Test proxy"><i data-lucide="play"></i><span>Test</span></button><button class="button small" data-proxy-action="edit" data-id="${p.id}" title="Edit proxy"><i data-lucide="pencil"></i><span>Edit</span></button><button class="button small danger icon-only" data-proxy-action="delete" data-id="${p.id}" title="Delete proxy" aria-label="Delete proxy"><i data-lucide="trash-2"></i></button></div></td></tr>`,
    )
    .join("");
}
function renderProxyOptions() {
  for (const select of $$("[data-proxy-select]")) renderProxySelect(select);
}
function renderProxySelect(select) {
  const current = select.value;
  select.innerHTML =
    '<option value="">Direct / environment</option>' +
    state.proxies
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
      .join("");
  select.value = current;
}
function editProxy(proxy) {
  $("#proxy-id").value = proxy?.id || "";
  $("#proxy-dialog-title").textContent = proxy ? "Edit proxy" : "Add proxy";
  $("#proxy-name").value = proxy?.name || "";
  $("#proxy-type").value = proxy?.type || "HTTPS_CONNECT";
  $("#proxy-url").value = proxy?.url || "";
  $("#proxy-username").value = proxy?.basicAuthUsername || "";
  $("#proxy-password").value = proxy?.basicAuthPassword || "";
  $("#proxy-error").textContent = "";
  openDialog("#proxy-dialog");
}
async function saveProxy() {
  const id = $("#proxy-id").value;
  try {
    await api(id ? `/api/proxies/${id}` : "/api/proxies", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify({
        name: $("#proxy-name").value,
        type: $("#proxy-type").value,
        url: $("#proxy-url").value,
        basicAuthUsername: $("#proxy-username").value,
        basicAuthPassword: $("#proxy-password").value,
      }),
    });
    closeDialog("#proxy-dialog");
    await loadProxies();
    toast("Proxy saved");
  } catch (error) {
    $("#proxy-error").textContent = error.message;
  }
}
async function proxyAction(action, id) {
  const proxy = state.proxies.find((p) => p.id === id);
  try {
    if (action === "edit") return editProxy(proxy);
    if (action === "delete") {
      if (!confirm(`Delete proxy ${proxy.name}?`)) return;
      await api(`/api/proxies/${id}`, { method: "DELETE" });
    } else {
      toast("Testing proxy connectivity…");
      const result = await api(`/api/proxies/${id}/test`, { method: "POST" });
      toast(result.message, result.success === false);
    }
    await loadProxies();
  } catch (error) {
    toast(error.message, true);
  }
}

const chartInstances = new Map();
const chartColors = [
  "#8b5cf6",
  "#f5b544",
  "#4ade80",
  "#f87171",
  "#7aa2ff",
  "#2dd4bf",
  "#f472b6",
];
const chartFont = '"Inter Variable", ui-sans-serif, sans-serif';
const tooltipStyle = {
  backgroundColor: "#1e1e24f2",
  borderColor: "#33333c",
  textStyle: { color: "#e8e8ec", fontSize: 12, fontFamily: chartFont },
  extraCssText:
    "box-shadow:0 10px 30px #0009;border-radius:8px;padding:10px 12px;",
};

function metricSummary(data) {
  $("#metrics-summary").innerHTML = [
    summary(
      "Estimated cost",
      `$${number(data.totalCostUsd, 4)}`,
      "Selected time range",
    ),
    summary(
      "Total requests",
      data.totalRequests,
      `${data.successRequests} success / ${data.failedRequests} failed`,
    ),
    summary(
      "Average latency",
      `${number(data.avgLatencyMs)} ms`,
      `TTFT ${number(data.avgTtftMs)} ms`,
    ),
    summary(
      "Total tokens",
      Number(data.totalTokens).toLocaleString(),
      "Input, output and cache",
    ),
  ].join("");
}

function timeAxis() {
  return {
    type: "time",
    axisLine: { lineStyle: { color: "#33333c" } },
    axisLabel: { color: "#84848f", fontSize: 11, fontFamily: chartFont, hideOverlap: true },
    axisTick: { show: false },
    splitLine: { show: false },
  };
}

function valueAxis(formatter) {
  return {
    type: "value",
    axisLabel: { color: "#84848f", fontSize: 11, fontFamily: chartFont, formatter },
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: "#26262d", type: "dashed" } },
  };
}

function legend() {
  return {
    top: 12,
    right: 16,
    itemWidth: 10,
    itemHeight: 7,
    textStyle: { color: "#b4b4bd", fontSize: 12, fontFamily: chartFont },
  };
}

function points(data, key) {
  return data.map((point) => [point.timestamp, Number(point[key] || 0)]);
}

function line(name, data, color, yAxisIndex = 0) {
  return {
    name,
    type: "line",
    yAxisIndex,
    data,
    smooth: 0.25,
    showSymbol: false,
    symbolSize: 6,
    lineStyle: { width: 2, color },
    itemStyle: { color },
    areaStyle: { color, opacity: 0.08 },
    emphasis: { focus: "series" },
  };
}

function bar(name, data, color, yAxisIndex = 0, stack) {
  return {
    name,
    type: "bar",
    yAxisIndex,
    data,
    stack,
    barMaxWidth: 18,
    itemStyle: { color, borderRadius: stack ? 0 : [3, 3, 0, 0] },
    emphasis: { focus: "series" },
  };
}

function emptyGraphic(show) {
  return show
    ? []
    : [
        {
          type: "text",
          left: "center",
          top: "middle",
          style: {
            text: "No requests in this time range",
            fill: "#84848f",
            fontSize: 13,
            fontFamily: chartFont,
          },
        },
      ];
}

function setChart(id, option) {
  let chart = chartInstances.get(id);
  if (!chart) {
    chart = echarts.init(document.getElementById(id), null, {
      renderer: "canvas",
    });
    chartInstances.set(id, chart);
  }
  document.getElementById(id).classList.remove("loading");
  chart.setOption(
    {
      backgroundColor: "transparent",
      animationDuration: 350,
      textStyle: { fontFamily: chartFont },
      ...option,
    },
    true,
  );
  if (id === "overview-chart") {
    setupOverviewRangeSelection(id, {
      onChange: handleMetricsRangeChange,
      rightMargin: 112,
    });
  }
  if (id === "history-usage-chart") {
    setupOverviewRangeSelection(id, {
      onChange: handleHistoryRangeChange,
      rightMargin: 30,
    });
  }
}

const rangeSelectionCharts = new Set();
function setupOverviewRangeSelection(chartId, { onChange, rightMargin }) {
  if (rangeSelectionCharts.has(chartId)) return;
  rangeSelectionCharts.add(chartId);
  const element = document.getElementById(chartId);
  const chart = chartInstances.get(chartId);
  const selection = document.createElement("div");
  selection.className = "chart-selection";
  element.appendChild(selection);
  let dragging = false;
  let startX = 0;
  let currentX = 0;
  let pointerId = null;
  const position = (event) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.max(
        70,
        Math.min(rect.width - rightMargin, event.clientX - rect.left),
      ),
      y: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
  };
  const drawSelection = () => {
    selection.style.display = "block";
    selection.style.left = `${Math.min(startX, currentX)}px`;
    selection.style.width = `${Math.abs(currentX - startX)}px`;
    selection.style.top = "50px";
    selection.style.bottom = "40px";
  };

  element.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      const point = position(event);
      if (
        point.y < 50 ||
        point.y > point.height - 40 ||
        point.x !== event.clientX - element.getBoundingClientRect().left
      )
        return;
      dragging = true;
      pointerId = event.pointerId;
      startX = point.x;
      currentX = point.x;
      chart.dispatchAction({ type: "hideTip" });
      element.setPointerCapture(pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  element.addEventListener(
    "pointermove",
    (event) => {
      if (!dragging) return;
      currentX = position(event).x;
      drawSelection();
      event.preventDefault();
    },
    true,
  );
  const finishSelection = (event, canceled = false) => {
    if (!dragging) return;
    dragging = false;
    selection.style.display = "none";
    if (element.hasPointerCapture(pointerId))
      element.releasePointerCapture(pointerId);
    pointerId = null;
    if (canceled || Math.abs(currentX - startX) < 8) return;
    const left = Math.min(startX, currentX);
    const right = Math.max(startX, currentX);
    const from = Number(chart.convertFromPixel({ xAxisIndex: 0 }, left));
    const to = Number(chart.convertFromPixel({ xAxisIndex: 0 }, right));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return;
    const fromDate = new Date(from);
    const toDate = new Date(to);
    onChange({
      from: fromDate,
      to: toDate,
      label: `${displayDateTime(fromDate)} - ${displayDateTime(toDate)}`,
      isRolling: false,
    });
  };
  element.addEventListener(
    "pointerup",
    (event) => finishSelection(event),
    true,
  );
  element.addEventListener(
    "pointercancel",
    (event) => finishSelection(event, true),
    true,
  );
}

function dateInputValue(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timeInputValue(value) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function displayDateTime(value) {
  return `${dateInputValue(value).replaceAll("-", "/")} ${timeInputValue(value)}`;
}

let timeRangePickerId = 0;
function createTimeRangePicker(root, { stateKey, onChange }) {
  const id = `picker-${++timeRangePickerId}`;
  root.innerHTML = `
    <button class="button time-range-button" id="${id}-button" aria-haspopup="dialog" aria-expanded="false"><i data-lucide="calendar"></i><span id="${id}-label">${state[stateKey].label}</span><i data-lucide="chevron-down"></i></button>
    <div class="time-range-popover hidden" id="${id}-popover" role="dialog" aria-label="Select time range">
      <div class="time-range-tabs" role="tablist"><button class="active" data-range-tab="quick" role="tab" aria-selected="true">Quick ranges</button><button data-range-tab="absolute" role="tab" aria-selected="false">Custom range</button></div>
      <div id="${id}-quick" class="time-range-panel">${QUICK_RANGES.map((range) => `<button data-quick-ms="${range.ms}">${range.label}</button>`).join("")}</div>
      <div id="${id}-absolute" class="time-range-panel hidden">
        <label>From<div class="datetime-inputs"><input id="${id}-from-date" type="date"><input id="${id}-from-time" type="time"></div></label>
        <label>To<div class="datetime-inputs"><input id="${id}-to-date" type="date"><input id="${id}-to-time" type="time"></div></label>
        <div class="range-validation" id="${id}-validation"></div><button class="button primary apply-range" id="${id}-apply">Apply range</button>
      </div>
    </div>`;
  const button = root.querySelector(`#${id}-button`);
  const popover = root.querySelector(`#${id}-popover`);
  const close = () => {
    popover.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
  };
  const validate = () => {
    const fromDate = root.querySelector(`#${id}-from-date`).value;
    const toDate = root.querySelector(`#${id}-to-date`).value;
    if (!fromDate || !toDate) return { valid: false, error: "" };
    const from = new Date(
      `${fromDate}T${root.querySelector(`#${id}-from-time`).value || "00:00"}`,
    );
    const to = new Date(
      `${toDate}T${root.querySelector(`#${id}-to-time`).value || "23:59"}`,
    );
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      from >= to
    ) {
      return { valid: false, error: "Start time must be before end time." };
    }
    if ((to.getTime() - from.getTime()) / 86400000 > 31) {
      return { valid: false, error: "Custom range cannot exceed 31 days." };
    }
    return { valid: true, error: "", from, to };
  };
  const updateValidation = () => {
    const result = validate();
    root.querySelector(`#${id}-validation`).textContent = result.error;
    root.querySelector(`#${id}-apply`).disabled = !result.valid;
    return result;
  };
  const select = (range) => {
    state[stateKey] = range;
    root.querySelector(`#${id}-label`).textContent = range.label;
    close();
    onChange(range);
  };
  button.addEventListener("click", () => {
    if (!popover.classList.contains("hidden")) return close();
    const { from, to } = state[stateKey];
    root.querySelector(`#${id}-from-date`).value = dateInputValue(from);
    root.querySelector(`#${id}-from-time`).value = timeInputValue(from);
    root.querySelector(`#${id}-to-date`).value = dateInputValue(to);
    root.querySelector(`#${id}-to-time`).value = timeInputValue(to);
    updateValidation();
    popover.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
  });
  popover.querySelectorAll("[data-range-tab]").forEach((tabButton) => {
    tabButton.addEventListener("click", () => {
      popover.querySelectorAll("[data-range-tab]").forEach((tab) => {
        const active = tab === tabButton;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
      });
      popover
        .querySelector(`#${id}-quick`)
        .classList.toggle("hidden", tabButton.dataset.rangeTab !== "quick");
      popover
        .querySelector(`#${id}-absolute`)
        .classList.toggle("hidden", tabButton.dataset.rangeTab !== "absolute");
    });
  });
  popover.querySelectorAll("[data-quick-ms]").forEach((quickButton) => {
    quickButton.addEventListener("click", () => {
      const duration = Number(quickButton.dataset.quickMs);
      select({
        from: new Date(Date.now() - duration),
        to: new Date(),
        label: quickButton.textContent,
        isRolling: true,
      });
    });
  });
  popover
    .querySelectorAll("input")
    .forEach((input) => input.addEventListener("input", updateValidation));
  root.querySelector(`#${id}-apply`).addEventListener("click", () => {
    const result = validate();
    if (!result.valid) {
      root.querySelector(`#${id}-validation`).textContent =
        result.error || "Select both start and end dates.";
      return;
    }
    select({
      from: result.from,
      to: result.to,
      label: `${displayDateTime(result.from)} - ${displayDateTime(result.to)}`,
      isRolling: false,
    });
  });
  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  refreshIcons();
}

function updateRangeLabel(root, label) {
  root.querySelector(".time-range-button span").textContent = label;
}

function handleMetricsRangeChange(range) {
  state.metricsRange = range;
  updateRangeLabel($("#metrics-time-range"), range.label);
  pushRange("metrics", range);
  loadMetrics();
}

function handleHistoryRangeChange(range) {
  state.historyRange = range;
  state.historyPage = 1;
  state.historyExpanded.clear();
  updateRangeLabel($("#history-time-range"), range.label);
  pushRange("history", range);
  loadHistory();
}

// ---------- Range <-> URL ----------
// Quick ranges are stored as ?range=1h (relative to now when loaded); custom
// and drag-selected ranges as ?from=<ISO>&to=<ISO>. The default (last 24 hours)
// keeps the bare path, so plain /metrics and /history stay unchanged.
const QUICK_RANGES = [
  { key: "15m", ms: 15 * 60 * 1000, label: "Last 15 minutes" },
  { key: "1h", ms: 60 * 60 * 1000, label: "Last hour" },
  { key: "24h", ms: 24 * 60 * 60 * 1000, label: "Last 24 hours" },
  { key: "3d", ms: 3 * 24 * 60 * 60 * 1000, label: "Last 3 days" },
  { key: "7d", ms: 7 * 24 * 60 * 60 * 1000, label: "Last 7 days" },
  { key: "30d", ms: 30 * 24 * 60 * 60 * 1000, label: "Last 30 days" },
];
const DEFAULT_RANGE_KEY = "24h";

function quickRange(quick, now = new Date()) {
  return {
    from: new Date(now.getTime() - quick.ms),
    to: now,
    label: quick.label,
    isRolling: true,
  };
}

function rangeToSearch(range) {
  if (range.isRolling) {
    const ms = range.to.getTime() - range.from.getTime();
    const quick = QUICK_RANGES.find((candidate) => candidate.ms === ms);
    if (quick) return quick.key === DEFAULT_RANGE_KEY ? "" : `?range=${quick.key}`;
  }
  return `?from=${range.from.toISOString()}&to=${range.to.toISOString()}`;
}

function rangeFromSearch(search) {
  const params = new URLSearchParams(search);
  const key = params.get("range");
  if (key) {
    const quick = QUICK_RANGES.find((candidate) => candidate.key === key);
    return quick ? quickRange(quick) : null;
  }
  const from = new Date(params.get("from") || "");
  const to = new Date(params.get("to") || "");
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to)
    return null;
  return {
    from,
    to,
    label: `${displayDateTime(from)} - ${displayDateTime(to)}`,
    isRolling: false,
  };
}

function pushRange(page, range) {
  const search = rangeToSearch(range);
  lastRangeSearch[page] = search;
  if (location.search !== search)
    history.pushState({}, "", location.pathname + search);
}

// Apply the URL's range to the page state (initial load, back/forward, rail).
function syncRangeFromUrl(page) {
  const stateKey = `${page}Range`;
  const parsed = location.search ? rangeFromSearch(location.search) : null;
  if (location.search && !parsed)
    history.replaceState({}, "", location.pathname);
  const range =
    parsed ||
    quickRange(QUICK_RANGES.find((quick) => quick.key === DEFAULT_RANGE_KEY));
  const changed = rangeToSearch(range) !== rangeToSearch(state[stateKey]);
  state[stateKey] = range;
  lastRangeSearch[page] = location.search;
  updateRangeLabel($(`#${page}-time-range`), range.label);
  if (page === "history" && changed) {
    state.historyPage = 1;
    state.historyExpanded.clear();
  }
}

function resolveRollingRange(range, now = new Date()) {
  if (!range.isRolling) return range;
  const duration = range.to.getTime() - range.from.getTime();
  return { ...range, from: new Date(now.getTime() - duration), to: now };
}

function rangeQuery(range) {
  return `startTime=${encodeURIComponent(range.from.toISOString())}&endTime=${encodeURIComponent(range.to.toISOString())}`;
}

function historyUsd(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function detailCard(title, rows) {
  return `<section class="detail-card"><h3>${title}</h3><dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl></section>`;
}

function modelBadge(model) {
  const name = String(model || "");
  const family = ["opus", "sonnet", "haiku"].find((value) =>
    name.toLowerCase().includes(value),
  );
  return `<span class="badge model-badge ${family ? `model-${family}` : ""}">${escapeHtml(name)}</span>`;
}

function renderHistoryDetails() {
  $("#history-details-title").textContent =
    `Details for Selected Time Range (${state.historyRange.label})`;
  $("#history-total").textContent = `${state.historyTotal} requests`;
  $("#history-empty").classList.toggle(
    "hidden",
    state.historyEntries.length > 0,
  );
  $("#history-body").innerHTML = state.historyEntries
    .map((entry) => {
      const expanded = state.historyExpanded.has(entry.id);
      const usage = entry.usage || {};
      const cost = entry.cost || {};
      const timing = entry.timing || {};
      const mainRow = `<tr><td><button class="history-expand" data-history-index="${entry.id}" aria-label="${expanded ? "Collapse" : "Expand"} request details"><i data-lucide="chevron-${expanded ? "down" : "right"}"></i></button></td><td>${date(entry.createdAt)}</td><td>${modelBadge(entry.model)}</td><td class="history-amount">${historyUsd(entry.costUsd)}</td><td>${historyUsd(entry.cumulativeCostUsd)}</td><td>${number(entry.kiroCredits, 2)}</td></tr>`;
      if (!expanded) return mainRow;
      const details = `<tr class="detail-row"><td colspan="6"><div class="detail-grid">
      ${detailCard("Token usage", [
        ["Input", Number(usage.input_tokens || 0).toLocaleString()],
        ["Output", Number(usage.output_tokens || 0).toLocaleString()],
        [
          "Cache read",
          Number(usage.cache_read_input_tokens || 0).toLocaleString(),
        ],
        [
          "Cache create",
          Number(usage.cache_creation_input_tokens || 0).toLocaleString(),
        ],
      ])}
      ${detailCard("Cost breakdown", [
        ["Input", historyUsd(cost.input_cost_usd)],
        ["Output", historyUsd(cost.output_cost_usd)],
        ["Cache read", historyUsd(cost.cache_read_cost_usd)],
        ["Cache create", historyUsd(cost.cache_creation_cost_usd)],
        ["Total", historyUsd(cost.total_cost_usd)],
      ])}
      ${detailCard("Timing", [
        ["TTFT", `${Number(timing.ttft_ms || 0).toLocaleString()} ms`],
        ["Total", `${Number(timing.total_time_ms || 0).toLocaleString()} ms`],
      ])}
      ${detailCard("Kiro request", [
        ["Credits", number(entry.kiroCredits, 2)],
        ["Account", `#${entry.accountId}`],
      ])}
    </div></td></tr>`;
      return mainRow + details;
    })
    .join("");

  const page = state.historyPage;
  const totalPages = Math.max(1, state.historyTotalPages);
  const first =
    state.historyTotal === 0 ? 0 : (page - 1) * HISTORY_PAGE_SIZE + 1;
  const last = Math.min(page * HISTORY_PAGE_SIZE, state.historyTotal);
  $("#history-pagination").innerHTML =
    totalPages <= 1
      ? ""
      : `<span>Showing ${first}–${last} of ${state.historyTotal}</span><div><button class="button small" data-history-page="${page - 1}" ${page === 1 ? "disabled" : ""}>Previous</button><span>Page ${page} / ${totalPages}</span><button class="button small" data-history-page="${page + 1}" ${page === totalPages ? "disabled" : ""}>Next</button></div>`;
  $$("#history-pagination [data-history-page]").forEach((button) => {
    button.onclick = () => {
      state.historyPage = Number(button.dataset.historyPage);
      loadHistory();
    };
  });
  refreshIcons();
}

function renderHistoryChart(data) {
  $("#history-chart-meta").textContent =
    `${data.buckets.length} buckets · Estimated spend ${historyUsd(data.totalSpent)}`;
  const spent = data.buckets.map((bucket) => [bucket.timestamp, bucket.spent]);
  setChart("history-usage-chart", {
    color: chartColors,
    legend: legend(),
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      valueFormatter: historyUsd,
    },
    grid: { left: 70, right: 30, top: 50, bottom: 40 },
    xAxis: timeAxis(),
    yAxis: valueAxis((value) => `$${value.toFixed(4)}`),
    graphic: emptyGraphic(data.totalSpent > 0),
    series: [bar("Usage", spent, "#8b5cf6", 0, "usd")],
  });
}

const HISTORY_PAGE_SIZE = 100;
let historyRequestId = 0;
async function loadHistory() {
  const requestId = ++historyRequestId;
  const button = $("#refresh-history");
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    state.historyRange = resolveRollingRange(state.historyRange, new Date());
    const query = rangeQuery(state.historyRange);
    const pageQuery = `${query}&limit=${HISTORY_PAGE_SIZE}&offset=${(state.historyPage - 1) * HISTORY_PAGE_SIZE}`;
    const [chart, history] = await Promise.all([
      api(`/api/history/aggregated?${query}`),
      api(`/api/history?${pageQuery}`),
    ]);
    if (requestId !== historyRequestId) return;
    state.historyEntries = history.entries;
    state.historyTotal = history.total;
    state.historyTotalPages = history.totalPages;
    renderHistoryChart(chart);
    renderHistoryDetails();
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (requestId === historyRequestId) {
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  }
}

$("#history-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-index]");
  if (!button) return;
  const index = Number(button.dataset.historyIndex);
  if (state.historyExpanded.has(index)) state.historyExpanded.delete(index);
  else state.historyExpanded.add(index);
  renderHistoryDetails();
});

let metricsRequestId = 0;
async function loadMetrics() {
  const requestId = ++metricsRequestId;
  const refreshButton = $("#refresh-metrics");
  refreshButton.disabled = true;
  refreshButton.classList.add("is-loading");
  try {
    state.metricsRange = resolveRollingRange(state.metricsRange, new Date());
    const query = rangeQuery(state.metricsRange);
    const [metrics, series, models, modelCost] = await Promise.all([
      api(`/api/metrics/performance?${query}`),
      api(`/api/metrics/performance/timeseries?${query}`),
      api(`/api/metrics/performance/models?${query}`),
      api(`/api/metrics/performance/model-cost-timeseries?${query}`),
    ]);
    if (requestId !== metricsRequestId) return;
    const data = series.timeseries;
    const hasRequests = data.some((point) => point.totalRequests > 0);
    metricSummary(metrics);

    setChart("overview-chart", {
      color: chartColors,
      legend: legend(),
      tooltip: {
        trigger: "axis",
        ...tooltipStyle,
        formatter: (params) => {
          const rows = params.map((item) => {
            const unit =
              item.seriesName === "Estimated cost"
                ? `$${Number(item.value[1]).toFixed(6)}`
                : item.seriesName === "Requests"
                  ? Number(item.value[1]).toLocaleString()
                  : `${Number(item.value[1]).toFixed(1)} ms`;
            return `${item.marker}${item.seriesName}: <b>${unit}</b>`;
          });
          return `${new Date(params[0].value[0]).toLocaleString()}<br>${rows.join("<br>")}`;
        },
      },
      grid: { left: 70, right: 112, top: 50, bottom: 40 },
      xAxis: timeAxis(),
      yAxis: [
        valueAxis((value) => `$${Number(value).toFixed(4)}`),
        {
          ...valueAxis((value) => Number(value).toLocaleString()),
          splitLine: { show: false },
        },
        {
          ...valueAxis((value) => `${Number(value).toFixed(0)} ms`),
          position: "right",
          offset: 52,
          splitLine: { show: false },
        },
      ],
      graphic: emptyGraphic(hasRequests),
      series: [
        line("Estimated cost", points(data, "totalCostUsd"), chartColors[0], 0),
        bar("Requests", points(data, "totalRequests"), "#4a4a56", 1),
        line(
          "Average latency",
          points(data, "avgLatencyMs"),
          chartColors[1],
          2,
        ),
      ],
    });

    setChart("cost-chart", {
      tooltip: {
        trigger: "axis",
        ...tooltipStyle,
        valueFormatter: (value) => `$${Number(value).toFixed(6)}`,
      },
      grid: { left: 65, right: 20, top: 25, bottom: 36 },
      xAxis: timeAxis(),
      yAxis: valueAxis((value) => `$${Number(value).toFixed(4)}`),
      graphic: emptyGraphic(hasRequests),
      series: [
        line("Estimated cost", points(data, "totalCostUsd"), chartColors[0]),
      ],
    });

    setChart("requests-chart", {
      legend: legend(),
      tooltip: { trigger: "axis", ...tooltipStyle },
      grid: { left: 52, right: 20, top: 48, bottom: 36 },
      xAxis: timeAxis(),
      yAxis: valueAxis((value) => Number(value).toLocaleString()),
      graphic: emptyGraphic(hasRequests),
      series: [
        bar(
          "Success",
          points(data, "successRequests"),
          "#4ade80",
          0,
          "requests",
        ),
        bar("Failed", points(data, "failedRequests"), "#f87171", 0, "requests"),
      ],
    });

    setChart("latency-chart", {
      legend: legend(),
      tooltip: {
        trigger: "axis",
        ...tooltipStyle,
        valueFormatter: (value) => `${Number(value).toFixed(1)} ms`,
      },
      grid: { left: 65, right: 20, top: 48, bottom: 36 },
      xAxis: timeAxis(),
      yAxis: valueAxis((value) => `${Number(value).toFixed(0)} ms`),
      graphic: emptyGraphic(hasRequests),
      series: [
        line("Average latency", points(data, "avgLatencyMs"), chartColors[1]),
        line("Time to first token", points(data, "avgTtftMs"), chartColors[4]),
      ],
    });

    setChart("tokens-chart", {
      tooltip: {
        trigger: "axis",
        ...tooltipStyle,
        valueFormatter: (value) => Number(value).toLocaleString(),
      },
      grid: { left: 68, right: 20, top: 25, bottom: 36 },
      xAxis: timeAxis(),
      yAxis: valueAxis((value) => Number(value).toLocaleString()),
      graphic: emptyGraphic(hasRequests),
      series: [bar("Tokens", points(data, "totalTokens"), chartColors[5])],
    });

    setChart("model-cost-chart", {
      color: chartColors,
      legend: { ...legend(), type: "scroll" },
      tooltip: {
        trigger: "axis",
        ...tooltipStyle,
        valueFormatter: (value) => `$${Number(value).toFixed(6)}`,
      },
      grid: { left: 65, right: 20, top: 50, bottom: 38 },
      xAxis: {
        ...timeAxis(),
        type: "category",
        data: modelCost.timestamps.map((timestamp) =>
          new Date(timestamp).toLocaleString([], {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }),
        ),
      },
      yAxis: valueAxis((value) => `$${Number(value).toFixed(4)}`),
      graphic: emptyGraphic(modelCost.models.length > 0),
      series: modelCost.models.map((model, index) =>
        bar(
          model,
          modelCost.series[model],
          chartColors[index % chartColors.length],
          0,
          "cost",
        ),
      ),
    });

    $("#models-body").innerHTML = models.models.length
      ? models.models
          .map(
            (model) =>
              `<tr><td>${escapeHtml(model.model)}</td><td>${model.totalRequests}</td><td>$${number(model.totalCostUsd, 6)}</td><td>${Number(model.totalTokens).toLocaleString()}</td><td>${number(model.avgLatencyMs)} ms</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="5" class="empty">No requests in this range</td></tr>';
    requestAnimationFrame(() =>
      chartInstances.forEach((chart) => chart.resize()),
    );
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (requestId === metricsRequestId) {
      refreshButton.disabled = false;
      refreshButton.classList.remove("is-loading");
    }
  }
}

window.addEventListener("resize", () =>
  chartInstances.forEach((chart) => chart.resize()),
);

$("#open-import").onclick = () => openImport("bulk");
$("[data-open-import]").onclick = () => openNewAccount();
$("#new-account").onclick = () => openNewAccount();
$$(".method-card").forEach((card) => (card.onclick = () => naChoose(card.dataset.method)));
$("#na-back").onclick = () => {
  naStopPolling(true);
  naShow(newAccount.method === "identity-center" && newAccount.step === "waiting" ? "configure" : "choose");
};
$("#na-primary").onclick = () => {
  if (newAccount.step === "configure") naStartLogin();
  else if (newAccount.step === "manual") naSubmitManual();
  else if (newAccount.step === "done") naReset();
};
$("#new-account-dialog").addEventListener("close", () => naStopPolling(true));
$$('input[name="na-kind"]').forEach((input) => (input.onchange = () => naSetKind(input.value)));
$("#nm-idc-provider").onchange = naUpdateStartUrlField;
$("#na-to-bulk").onclick = () => { closeDialog("#new-account-dialog"); openImport(); };
$("#na-copy-link").onclick = async () => {
  try { await copyText($("#na-open-link").href); toast("Sign-in link copied"); } catch (error) { toast(error.message, true); }
};
$("#na-copy-code").onclick = async () => {
  try { await copyText($("#na-user-code").textContent); toast("Code copied"); } catch (error) { toast(error.message, true); }
};
$("#na-open-link").onclick = () => { $("#na-status-text").textContent = "Waiting for you to finish…"; };
$("#na-manual").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.matches("input")) { event.preventDefault(); naSubmitManual(); }
});
$("#na-configure").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.matches("input")) { event.preventDefault(); naStartLogin(); }
});
$("#edit-delete").onclick = () => accountAction("delete", Number($("#edit-account-id").value));
$("#edit-refresh-token").onclick = () => runEditAction($("#edit-refresh-token"), () => api(`/api/accounts/${$("#edit-account-id").value}/refresh`, { method: "POST" }), "Access token refreshed");
$("#edit-test").onclick = () => runEditAction($("#edit-test"), () => api(`/api/accounts/${$("#edit-account-id").value}/test`, { method: "POST" }), "The account answered a test request");
$("#submit-import").onclick = submitImport;
$("#import-text").oninput = () => {
  clearTimeout(parseDebounce);
  parseDebounce = setTimeout(parseImport, 350);
};
$("#reload-accounts").onclick = () => trackLoading("accounts", loadAccounts());
$("#refresh-usage").onclick = refreshAllUsage;
$("#save-account").onclick = saveAccount;
$("#open-proxies").onclick = () => navigate("/proxies");
$("#add-proxy").onclick = () => editProxy();
$("#save-proxy").onclick = saveProxy;
$("#setup-base-url").textContent = location.origin;
$("#titlebar-base-url").textContent = location.origin;
$("#copy-base-url").onclick = async () => {
  try {
    await copyText(location.origin);
    toast("ANTHROPIC_BASE_URL copied");
  } catch (error) {
    toast(error.message, true);
  }
};

$("#refresh-metrics").onclick = () => trackLoading("metrics", loadMetrics());
$("#refresh-history").onclick = () => trackLoading("history", loadHistory());
$("#titlebar-copy-script").onclick = () => $("#copy-script").click();
$("#copy-script").onclick = async () => {
  try {
    await copyText($("#endpoint-script").textContent);
    toast("Claude Code setup script copied");
  } catch (error) {
    toast(error.message, true);
  }
};
$("#endpoint-script").textContent =
  `export ANTHROPIC_BASE_URL=${location.origin}\nexport ANTHROPIC_API_KEY=sk-ant-api03-dummykey123123123123\n\n# programmatically approve this API Key\n(cat ~/.claude.json 2>/dev/null || echo 'null') | jq --arg key "\${ANTHROPIC_API_KEY: -20}" '(. // {}) | .customApiKeyResponses.approved |= ([.[]?, $key] | unique)' > ~/.claude.json.tmp && mv ~/.claude.json.tmp ~/.claude.json`;
$$("[data-close]").forEach(
  (b) => (b.onclick = () => closeDialog(`#${b.dataset.close}`)),
);
$("#accounts-body").onclick = (e) => {
  const button = e.target.closest("[data-action]");
  if (button) accountAction(button.dataset.action, Number(button.dataset.id));
};
$("#proxies-body").onclick = (e) => {
  const button = e.target.closest("[data-proxy-action]");
  if (button)
    proxyAction(button.dataset.proxyAction, Number(button.dataset.id));
};
refreshIcons();
createTimeRangePicker($("#metrics-time-range"), {
  stateKey: "metricsRange",
  onChange: handleMetricsRangeChange,
});
createTimeRangePicker($("#history-time-range"), {
  stateKey: "historyRange",
  onChange: handleHistoryRangeChange,
});
function pageForPath(pathname) {
  if (pathname === "/metrics") return "metrics";
  if (pathname === "/history") return "history";
  if (pathname === "/proxies") return "proxies";
  return "accounts";
}
function currentPage() {
  return pageForPath(location.pathname);
}
if (currentPage() !== "proxies") loadProxies();
showPage(currentPage());
if (currentPage() !== "accounts") loadAccounts();

window.addEventListener("popstate", () => showPage(currentPage()));
setInterval(() => {
  if (
    !$("#accounts-page").classList.contains("hidden") &&
    !document.querySelector("dialog[open]")
  )
    loadAccounts();
}, 60000);
