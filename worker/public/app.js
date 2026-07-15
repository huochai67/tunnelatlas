const state = {
  token: sessionStorage.getItem("tunnelatlas.token") || "",
  mode: sessionStorage.getItem("tunnelatlas.mode") || "",
  overview: { nodes: [], tunnels: [] },
  nodeStatusFilter: "all",
  timer: null,
};

const $ = (selector) => document.querySelector(selector);
const els = {
  dialog: $("#auth-dialog"), authForm: $("#auth-form"), authToken: $("#access-token"), authError: $("#auth-error"),
  session: $("#session-button"), refresh: $("#refresh-button"), syncDot: $("#sync-dot"), syncLabel: $("#sync-label"),
  clock: $("#server-clock"), date: $("#server-date"), nodes: $("#node-list"), tunnels: $("#tunnel-table"),
  nodeFilter: $("#node-filter"), nodeForm: $("#node-form"), nodeName: $("#node-name"), readonlyNote: $("#readonly-note"),
  tokenResult: $("#token-result"), tokenValue: $("#token-value"), tokenExpiry: $("#token-expiry"), deployLabel: $("#deploy-label"),
  deployCommand: $("#deploy-command"), copyDeployCommand: $("#copy-deploy-command"), search: $("#tunnel-search"), toast: $("#toast"),
};

const INSTALLER_URL = "https://raw.githubusercontent.com/huochai67/tunnelatlas/main/deploy/install.sh";

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
      state.overview = { nodes: nodesFromTunnels(data.tunnels), tunnels: data.tunnels, serverTime: data.serverTime };
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
      state.overview = { nodes: nodesFromTunnels(data.tunnels), tunnels: data.tunnels, serverTime: data.serverTime };
    }
    setSync("online", "已同步");
    render();
  } catch (error) {
    setSync("error", "同步失败");
    if (!quiet) toast(error.message);
  } finally { els.refresh.classList.remove("loading"); }
}

function nodesFromTunnels(tunnels) {
  const map = new Map();
  for (const tunnel of tunnels) {
    const value = map.get(tunnel.nodeId) || { id: tunnel.nodeId, name: tunnel.nodeName, tunnelCount: 0, connectionStatus: "online", lastSeenAt: tunnel.lastSeenAt };
    value.tunnelCount += 1;
    map.set(tunnel.nodeId, value);
  }
  return [...map.values()];
}

function render() {
  const { nodes = [], tunnels = [], serverTime } = state.overview;
  const online = nodes.filter((node) => node.connectionStatus === "online").length;
  const pending = nodes.filter((node) => node.connectionStatus === "pending").length;
  const healthy = tunnels.filter((tunnel) => tunnel.status === "healthy").length;
  const alerts = nodes.filter((node) => ["stale", "offline"].includes(node.connectionStatus)).length
    + tunnels.filter((tunnel) => !["healthy", "stopped"].includes(tunnel.status)).length;
  $("#metric-online").textContent = online;
  $("#metric-total-nodes").textContent = `${nodes.length} 个已创建节点`;
  $("#metric-tunnels").textContent = healthy;
  $("#metric-tunnel-detail").textContent = `${tunnels.length} 条已发现路径`;
  $("#metric-pending").textContent = pending;
  $("#metric-alerts").textContent = alerts;
  renderClock(serverTime);
  renderNodes(nodes);
  renderNodeFilter(nodes);
  renderTunnels(tunnels);
  els.session.textContent = state.mode === "admin" ? "管理员会话" : state.mode === "read" ? "只读会话" : "连接控制面";
  els.readonlyNote.classList.toggle("hidden", state.mode !== "read");
  els.nodeForm.classList.toggle("hidden", state.mode !== "admin");
}

function renderClock(serverTime) {
  if (!serverTime) return;
  const date = new Date(serverTime);
  els.clock.textContent = date.toLocaleTimeString("zh-CN", { hour12: false });
  els.date.textContent = date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function renderNodes(nodes) {
  const filtered = nodes.filter((node) => {
    if (state.nodeStatusFilter === "all") return true;
    if (state.nodeStatusFilter === "offline") return ["stale", "offline"].includes(node.connectionStatus);
    return node.connectionStatus === state.nodeStatusFilter;
  });
  if (!filtered.length) {
    els.nodes.innerHTML = `<div class="empty-state"><span class="radar"></span><p>没有符合条件的节点</p></div>`;
    return;
  }
  els.nodes.innerHTML = filtered.map((node) => `<div class="agent-item">
    <span class="node-icon">${escapeHtml((node.name || "N").slice(0, 2).toUpperCase())}</span>
    <div class="agent-name"><strong>${escapeHtml(node.name)}</strong><span>${escapeHtml(node.id)}</span></div>
    <div class="agent-meta"><strong>${node.tunnelCount || 0} 条隧道</strong><span>${node.agentVersion ? `Agent v${escapeHtml(node.agentVersion)}` : "尚未接入"}</span></div>
    <div class="node-controls">
      <span class="agent-state ${escapeAttr(node.connectionStatus)}">${statusText(node.connectionStatus)}</span>
      ${state.mode === "admin" && node.connectionStatus === "pending" ? `<button type="button" data-node-action="token" data-node-id="${escapeAttr(node.id)}">注册码</button>` : ""}
      ${state.mode === "admin" && node.connectionStatus !== "pending" ? `<button type="button" data-node-action="reset" data-node-id="${escapeAttr(node.id)}">重置</button>` : ""}
      ${state.mode === "admin" ? `<button class="agent-delete" type="button" data-node-action="delete" data-node-id="${escapeAttr(node.id)}">删除</button>` : ""}
    </div>
  </div>`).join("");
}

function renderNodeFilter(nodes) {
  const previous = els.nodeFilter.value;
  els.nodeFilter.innerHTML = `<option value="all">所有节点</option>${nodes.map((node) => `<option value="${escapeAttr(node.id)}">${escapeHtml(node.name)}</option>`).join("")}`;
  if (["all", ...nodes.map((node) => node.id)].includes(previous)) els.nodeFilter.value = previous;
}

function renderTunnels(tunnels) {
  const query = els.search.value.trim().toLowerCase();
  const nodeId = els.nodeFilter.value;
  const filtered = tunnels.filter((tunnel) => (nodeId === "all" || tunnel.nodeId === nodeId)
    && (!query || [tunnel.name, tunnel.endpoint, tunnel.protocol, tunnel.nodeName].join(" ").toLowerCase().includes(query)));
  if (!filtered.length) {
    els.tunnels.innerHTML = `<tr><td colspan="6" class="table-empty">没有符合条件的隧道</td></tr>`;
    return;
  }
  els.tunnels.innerHTML = filtered.map((tunnel) => `<tr>
    <td><span class="table-status ${escapeAttr(tunnel.status)}">${escapeHtml(tunnel.status)}</span></td>
    <td class="tunnel-name"><strong>${escapeHtml(tunnel.name)}</strong><small>${escapeHtml(tunnel.nodeName)}</small></td>
    <td>${escapeHtml(tunnel.metadata?.direction || tunnel.kind.split("/").pop())} / ${escapeHtml(tunnel.protocol)}</td>
    <td class="endpoint">${escapeHtml(tunnel.endpoint)}</td><td>${escapeHtml(tunnel.nodeName)}</td>
    <td>${relativeTime(tunnel.lastSeenAt)}</td></tr>`).join("");
}

function showEnrollment(data, nodeName) {
  els.tokenValue.textContent = data.token;
  els.tokenExpiry.textContent = `${new Date(data.expiresAt).toLocaleTimeString("zh-CN", { hour12: false })} 失效`;
  els.deployLabel.textContent = `${nodeName} · 一键部署（默认 Shadowsocks）`;
  els.deployCommand.textContent = deploymentCommand(data.token);
  els.tokenResult.classList.remove("hidden");
}

function openAuth() { els.authToken.value = state.token; els.authError.classList.add("hidden"); els.dialog.showModal(); setTimeout(() => els.authToken.focus(), 50); }
function disconnect() { clearInterval(state.timer); state.token = ""; state.mode = ""; state.overview = { nodes: [], tunnels: [] }; sessionStorage.removeItem("tunnelatlas.token"); sessionStorage.removeItem("tunnelatlas.mode"); setSync("", "等待连接"); els.tokenResult.classList.add("hidden"); render(); openAuth(); }
function startAutoRefresh() { clearInterval(state.timer); state.timer = setInterval(() => refresh({ quiet: true }), 15000); }
function setSync(type, value) { els.syncDot.className = type; els.syncLabel.textContent = value; }
function toast(message) { els.toast.textContent = message; els.toast.classList.add("show"); setTimeout(() => els.toast.classList.remove("show"), 2600); }
function statusText(value) { return ({ pending: "待接入", online: "在线", stale: "陈旧", offline: "离线" })[value] || value; }
function relativeTime(value) { if (!value) return "从未"; const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000); if (seconds < 60) return `${Math.floor(seconds)} 秒前`; if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`; return `${Math.floor(seconds / 3600)} 小时前`; }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
function deploymentCommand(token) {
  return [
    `curl -fsSL ${shellQuote(INSTALLER_URL)} -o /tmp/tunnelatlas-install.sh && \\`,
    `sudo env TUNNELATLAS_ENROLLMENT_TOKEN=${shellQuote(token)} bash /tmp/tunnelatlas-install.sh \\`,
    "  --non-interactive \\",
    `  --server-url ${shellQuote(window.location.origin)} && \\`,
    "rm -f /tmp/tunnelatlas-install.sh",
  ].join("\n");
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]); }
function escapeAttr(value) { return escapeHtml(value); }

els.authForm.addEventListener("submit", async (event) => { event.preventDefault(); els.authError.classList.add("hidden"); try { await connect(els.authToken.value); toast("控制面已连接"); } catch (error) { els.authError.textContent = error.message; els.authError.classList.remove("hidden"); } });
$("#auth-cancel").addEventListener("click", () => els.dialog.close());
els.session.addEventListener("click", () => state.token ? disconnect() : openAuth());
els.refresh.addEventListener("click", () => refresh());
$("#node-status-filter").addEventListener("click", (event) => { const button = event.target.closest("button[data-filter]"); if (!button) return; state.nodeStatusFilter = button.dataset.filter; document.querySelectorAll("#node-status-filter button").forEach((item) => item.classList.toggle("active", item === button)); renderNodes(state.overview.nodes || []); });
els.search.addEventListener("input", () => renderTunnels(state.overview.tunnels || []));
els.nodeFilter.addEventListener("change", () => renderTunnels(state.overview.tunnels || []));
els.nodeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/v1/admin/nodes", { method: "POST", body: JSON.stringify({ name: els.nodeName.value.trim() }) });
    els.nodeForm.reset();
    await refresh({ quiet: true });
    showEnrollment(data, data.node.name);
    toast("节点已创建");
  } catch (error) { toast(error.message); }
});
els.nodes.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-node-action]");
  if (!button || state.mode !== "admin") return;
  const node = (state.overview.nodes || []).find((item) => item.id === button.dataset.nodeId);
  if (!node) return;
  const action = button.dataset.nodeAction;
  if (action === "delete" && !window.confirm(`确定删除节点“${node.name}”吗？\n\n该节点的注册码和隧道都会被永久删除。`)) return;
  if (action === "reset" && !window.confirm(`确定重置节点“${node.name}”的接入身份吗？\n\n请先在目标主机卸载旧 Agent；重置后旧身份会立即失效，现有隧道将被清空。`)) return;
  button.disabled = true;
  try {
    if (action === "delete") {
      await api(`/v1/admin/nodes/${encodeURIComponent(node.id)}`, { method: "DELETE" });
      els.tokenResult.classList.add("hidden");
      await refresh({ quiet: true });
      toast("节点已删除");
      return;
    }
    const path = action === "reset"
      ? `/v1/admin/nodes/${encodeURIComponent(node.id)}/enrollment:reset`
      : `/v1/admin/nodes/${encodeURIComponent(node.id)}/enrollment-tokens`;
    const data = await api(path, { method: "POST" });
    await refresh({ quiet: true });
    showEnrollment(data, node.name);
    toast(action === "reset" ? "接入身份已重置" : "新注册码已生成");
  } catch (error) { button.disabled = false; toast(error.message); }
});
$("#copy-token").addEventListener("click", async () => { await navigator.clipboard.writeText(els.tokenValue.textContent); toast("注册码已复制"); });
els.copyDeployCommand.addEventListener("click", async () => { await navigator.clipboard.writeText(els.deployCommand.textContent); toast("一键部署命令已复制"); });

if (state.token) { refresh().then(startAutoRefresh); } else { render(); openAuth(); }
