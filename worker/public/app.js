const state = {
  token: sessionStorage.getItem("tunnelatlas.token") || "",
  mode: sessionStorage.getItem("tunnelatlas.mode") || "",
  overview: { sites: [], agents: [], tunnels: [] },
  agentFilter: "all",
  timer: null,
};

const $ = (selector) => document.querySelector(selector);
const els = {
  dialog: $("#auth-dialog"), authForm: $("#auth-form"), authToken: $("#access-token"), authError: $("#auth-error"),
  session: $("#session-button"), refresh: $("#refresh-button"), syncDot: $("#sync-dot"), syncLabel: $("#sync-label"),
  clock: $("#server-clock"), date: $("#server-date"), agents: $("#agent-list"), tunnels: $("#tunnel-table"),
  siteSelect: $("#site-select"), siteFilter: $("#site-filter"), createToken: $("#create-token-button"),
  siteForm: $("#site-form"), showSiteForm: $("#show-site-form"), readonlyNote: $("#readonly-note"),
  tokenResult: $("#token-result"), tokenValue: $("#token-value"), tokenExpiry: $("#token-expiry"),
  search: $("#tunnel-search"), toast: $("#toast"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Authorization": `Bearer ${state.token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.title || `请求失败 (${response.status})`);
  }
  return response.json();
}

async function connect(token) {
  state.token = token.trim();
  try {
    state.overview = await api("/v1/admin/overview");
    state.mode = "admin";
  } catch (adminError) {
    try {
      const data = await api("/v1/tunnels");
      state.overview = { sites: uniqueSites(data.tunnels), agents: agentsFromTunnels(data.tunnels), tunnels: data.tunnels, serverTime: data.serverTime };
      state.mode = "read";
    } catch {
      state.token = "";
      throw adminError;
    }
  }
  sessionStorage.setItem("tunnelatlas.token", state.token);
  sessionStorage.setItem("tunnelatlas.mode", state.mode);
  els.dialog.close();
  startAutoRefresh();
  render();
}

async function refresh({ quiet = false } = {}) {
  if (!state.token) return openAuth();
  if (!quiet) els.refresh.classList.add("loading");
  try {
    if (state.mode === "admin") state.overview = await api("/v1/admin/overview");
    else {
      const data = await api("/v1/tunnels");
      state.overview = { sites: uniqueSites(data.tunnels), agents: agentsFromTunnels(data.tunnels), tunnels: data.tunnels, serverTime: data.serverTime };
    }
    setSync("online", "已同步");
    render();
  } catch (error) {
    setSync("error", "同步失败");
    if (!quiet) toast(error.message);
  } finally { els.refresh.classList.remove("loading"); }
}

function uniqueSites(tunnels) {
  return [...new Set(tunnels.map((item) => item.siteId))].sort().map((id) => ({ id, name: id }));
}
function agentsFromTunnels(tunnels) {
  const map = new Map();
  for (const tunnel of tunnels) {
    const value = map.get(tunnel.agentId) || { id: tunnel.agentId, name: tunnel.agentName, siteId: tunnel.siteId, tunnelCount: 0, connectionStatus: "online", lastSeenAt: tunnel.lastSeenAt };
    value.tunnelCount += 1; map.set(tunnel.agentId, value);
  }
  return [...map.values()];
}

function render() {
  const { sites = [], agents = [], tunnels = [], serverTime } = state.overview;
  const online = agents.filter((a) => a.connectionStatus === "online").length;
  const healthy = tunnels.filter((t) => t.status === "healthy").length;
  const alerts = agents.filter((a) => a.connectionStatus !== "online").length + tunnels.filter((t) => !["healthy", "stopped"].includes(t.status)).length;
  $("#metric-online").textContent = online; $("#metric-total-agents").textContent = `${agents.length} 个已注册节点`;
  $("#metric-tunnels").textContent = healthy; $("#metric-tunnel-detail").textContent = `${tunnels.length} 条已发现路径`;
  $("#metric-sites").textContent = sites.length; $("#metric-alerts").textContent = alerts;
  renderClock(serverTime); renderAgents(agents); renderSites(sites); renderTunnels(tunnels);
  els.session.textContent = state.mode === "admin" ? "管理员会话" : state.mode === "read" ? "只读会话" : "连接控制面";
  els.readonlyNote.classList.toggle("hidden", state.mode !== "read");
  els.createToken.disabled = state.mode !== "admin" || !els.siteSelect.value;
  els.showSiteForm.classList.toggle("hidden", state.mode !== "admin");
}

function renderClock(serverTime) {
  if (!serverTime) return;
  const date = new Date(serverTime);
  els.clock.textContent = date.toLocaleTimeString("zh-CN", { hour12: false });
  els.date.textContent = date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function renderAgents(agents) {
  const filtered = agents.filter((agent) => state.agentFilter === "all" || (state.agentFilter === "online" ? agent.connectionStatus === "online" : agent.connectionStatus !== "online"));
  if (!filtered.length) { els.agents.innerHTML = `<div class="empty-state"><span class="radar"></span><p>没有符合条件的节点</p></div>`; return; }
  els.agents.innerHTML = filtered.map((agent) => `<div class="agent-item">
    <span class="node-icon">${escapeHtml((agent.name || "A").slice(0, 2).toUpperCase())}</span>
    <div class="agent-name"><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.id)}</span></div>
    <div class="agent-meta"><strong>${agent.tunnelCount || 0} 条隧道</strong><span>${escapeHtml(agent.siteId)} · v${escapeHtml(agent.agentVersion || "—")}</span></div>
    <span class="agent-state ${agent.connectionStatus}">${statusText(agent.connectionStatus)}</span>
  </div>`).join("");
}

function renderSites(sites) {
  const previous = els.siteSelect.value;
  els.siteSelect.innerHTML = sites.length ? sites.map((site) => `<option value="${escapeAttr(site.id)}">${escapeHtml(site.name)} · ${escapeHtml(site.id)}</option>`).join("") : `<option value="">暂无站点</option>`;
  if (sites.some((site) => site.id === previous)) els.siteSelect.value = previous;
  const filterPrevious = els.siteFilter.value;
  els.siteFilter.innerHTML = `<option value="all">所有站点</option>${sites.map((site) => `<option value="${escapeAttr(site.id)}">${escapeHtml(site.name)}</option>`).join("")}`;
  if (["all", ...sites.map((s) => s.id)].includes(filterPrevious)) els.siteFilter.value = filterPrevious;
}

function renderTunnels(tunnels) {
  const query = els.search.value.trim().toLowerCase();
  const site = els.siteFilter.value;
  const filtered = tunnels.filter((tunnel) => (site === "all" || tunnel.siteId === site) && (!query || [tunnel.name, tunnel.endpoint, tunnel.protocol, tunnel.agentName].join(" ").toLowerCase().includes(query)));
  if (!filtered.length) { els.tunnels.innerHTML = `<tr><td colspan="6" class="table-empty">没有符合条件的隧道</td></tr>`; return; }
  els.tunnels.innerHTML = filtered.map((tunnel) => `<tr>
    <td><span class="table-status ${escapeAttr(tunnel.status)}">${escapeHtml(tunnel.status)}</span></td>
    <td class="tunnel-name"><strong>${escapeHtml(tunnel.name)}</strong><small>${escapeHtml(tunnel.siteId)}</small></td>
    <td>${escapeHtml(tunnel.metadata?.direction || tunnel.kind.split("/").pop())} / ${escapeHtml(tunnel.protocol)}</td>
    <td class="endpoint">${escapeHtml(tunnel.endpoint)}</td><td>${escapeHtml(tunnel.agentName || tunnel.agentId)}</td>
    <td>${relativeTime(tunnel.lastSeenAt)}</td></tr>`).join("");
}

function openAuth() { els.authToken.value = state.token; els.authError.classList.add("hidden"); els.dialog.showModal(); setTimeout(() => els.authToken.focus(), 50); }
function disconnect() { clearInterval(state.timer); state.token = ""; state.mode = ""; state.overview = { sites: [], agents: [], tunnels: [] }; sessionStorage.removeItem("tunnelatlas.token"); sessionStorage.removeItem("tunnelatlas.mode"); setSync("", "等待连接"); render(); openAuth(); }
function startAutoRefresh() { clearInterval(state.timer); state.timer = setInterval(() => refresh({ quiet: true }), 15000); }
function setSync(type, text) { els.syncDot.className = type; els.syncLabel.textContent = text; }
function toast(message) { els.toast.textContent = message; els.toast.classList.add("show"); setTimeout(() => els.toast.classList.remove("show"), 2600); }
function statusText(value) { return ({ online: "在线", stale: "陈旧", offline: "离线", revoked: "已撤销" })[value] || value; }
function relativeTime(value) { if (!value) return "从未"; const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000); if (seconds < 60) return `${Math.floor(seconds)} 秒前`; if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`; return `${Math.floor(seconds / 3600)} 小时前`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]); }
function escapeAttr(value) { return escapeHtml(value); }

els.authForm.addEventListener("submit", async (event) => { event.preventDefault(); els.authError.classList.add("hidden"); try { await connect(els.authToken.value); toast("控制面已连接"); } catch (error) { els.authError.textContent = error.message; els.authError.classList.remove("hidden"); } });
$("#auth-cancel").addEventListener("click", () => els.dialog.close());
els.session.addEventListener("click", () => state.token ? disconnect() : openAuth());
els.refresh.addEventListener("click", () => refresh());
$("#agent-filter").addEventListener("click", (event) => { const button = event.target.closest("button[data-filter]"); if (!button) return; state.agentFilter = button.dataset.filter; document.querySelectorAll("#agent-filter button").forEach((item) => item.classList.toggle("active", item === button)); renderAgents(state.overview.agents || []); });
els.search.addEventListener("input", () => renderTunnels(state.overview.tunnels || [])); els.siteFilter.addEventListener("change", () => renderTunnels(state.overview.tunnels || []));
els.siteSelect.addEventListener("change", () => { els.createToken.disabled = state.mode !== "admin" || !els.siteSelect.value; });
els.showSiteForm.addEventListener("click", () => els.siteForm.classList.remove("hidden")); $("#cancel-site").addEventListener("click", () => els.siteForm.classList.add("hidden"));
els.siteForm.addEventListener("submit", async (event) => { event.preventDefault(); try { const site = await api("/v1/admin/sites", { method: "POST", body: JSON.stringify({ id: $("#site-id").value.trim(), name: $("#site-name").value.trim() }) }); els.siteForm.reset(); els.siteForm.classList.add("hidden"); await refresh({ quiet: true }); els.siteSelect.value = site.id; els.createToken.disabled = false; toast("站点已创建"); } catch (error) { toast(error.message); } });
els.createToken.addEventListener("click", async () => { try { const data = await api(`/v1/admin/sites/${encodeURIComponent(els.siteSelect.value)}/enrollment-tokens`, { method: "POST" }); els.tokenValue.textContent = data.token; els.tokenExpiry.textContent = `${new Date(data.expiresAt).toLocaleTimeString("zh-CN", { hour12: false })} 失效`; els.tokenResult.classList.remove("hidden"); } catch (error) { toast(error.message); } });
$("#copy-token").addEventListener("click", async () => { await navigator.clipboard.writeText(els.tokenValue.textContent); toast("注册码已复制"); });

if (state.token) { refresh().then(startAutoRefresh); } else { render(); openAuth(); }
