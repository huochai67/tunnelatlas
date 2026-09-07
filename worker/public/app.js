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

  tunnelDialog: $("#tunnel-dialog"), tunnelForm: $("#tunnel-form"), tunnelTitle: $("#tunnel-dialog-title"),
  tunnelId: $("#tunnel-id"), tunnelNodeId: $("#tunnel-node-id"), tunnelNodeSelect: $("#tunnel-node-select"),
  tunnelName: $("#tunnel-name"), tunnelType: $("#tunnel-type"), tunnelPort: $("#tunnel-port"),
  tunnelListen: $("#tunnel-listen"), tunnelPublicHost: $("#tunnel-public-host"),
  tunnelSsMethod: $("#tunnel-ss-method"), tunnelServerName: $("#tunnel-server-name"),
  tunnelTuicCc: $("#tunnel-tuic-cc"), tunnelVmessPath: $("#tunnel-vmess-path"), tunnelVmessHost: $("#tunnel-vmess-host"),
  tunnelHop1: $("#tunnel-hop-1"), tunnelHop2: $("#tunnel-hop-2"), tunnelHop3: $("#tunnel-hop-3"),
  tunnelOptSs: $("#tunnel-opt-ss"), tunnelOptServerName: $("#tunnel-opt-server-name"),
  tunnelOptTuicCc: $("#tunnel-opt-tuic-cc"), tunnelOptVmess: $("#tunnel-opt-vmess"),
  tunnelCredWarning: $("#tunnel-cred-warning"), tunnelError: $("#tunnel-error"),
  tunnelCancelBtn: $("#tunnel-cancel-btn"),
};

const INSTALLER_URL = "https://raw.githubusercontent.com/huochai67/tunnelatlas/main/deploy/install.sh";

const APPLY_ERROR_LABELS = {
  invalid_desired_config: "下发配置格式无效",
  sing_box_validation_failed: "sing-box 配置校验失败",
  sing_box_start_failed: "sing-box 启动失败",
  local_apply_failed: "本地应用配置失败",
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
    + tunnels.filter((tunnel) => !["healthy", "stopped", "pending"].includes(tunnel.status)).length;
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

function nodeSyncBadge(node) {
  if (node.appliedConfigVersion === null || node.appliedConfigVersion === undefined) {
    return `<span class="sync-badge legacy">旧配置 / 未同步</span>`;
  }
  if (node.configApplyError) {
    const text = APPLY_ERROR_LABELS[node.configApplyError] || node.configApplyError;
    return `<span class="sync-badge error" title="${escapeAttr(text)}">应用失败：${escapeHtml(text)}</span>`;
  }
  if (node.appliedConfigVersion === node.configVersion) {
    return `<span class="sync-badge synced">已同步 (v${node.configVersion})</span>`;
  }
  return `<span class="sync-badge pending">待应用 (v${node.appliedConfigVersion} → v${node.configVersion})</span>`;
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
    <div class="agent-meta">
      <strong>${node.tunnelCount || 0} 条隧道</strong>
      <span>${node.agentVersion ? `Agent v${escapeHtml(node.agentVersion)}` : "尚未接入"}</span>
      ${nodeSyncBadge(node)}
    </div>
    <div class="node-controls">
      <span class="agent-state ${escapeAttr(node.connectionStatus)}">${statusText(node.connectionStatus)}</span>
      ${state.mode === "admin" ? `<button class="add-tunnel-btn" type="button" data-node-action="add-tunnel" data-node-id="${escapeAttr(node.id)}">添加隧道</button>` : ""}
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

function cloudflareCell(tunnel) {
  const cf = tunnel.cloudflare;
  const host = cf ? `<span class="cf-host">${escapeHtml(cf.hostname)}</span>` : "";
  const isVmessWs = (tunnel.type === "vmess-ws" || tunnel.protocol === "vmess") &&
    (tunnel.type === "vmess-ws" || tunnel.metadata?.transport?.type === "ws");
  const isHealthy = tunnel.status === "healthy";
  const canEnable = tunnel.managed ? (isVmessWs && isHealthy) : isVmessWs;

  if (!cf) {
    if (state.mode === "admin" && canEnable) {
      return `<button class="cf-enable" type="button" data-cf-action="enable" data-node-id="${escapeAttr(tunnel.nodeId)}" data-tunnel-id="${escapeAttr(tunnel.id)}">启用 Cloudflare</button>`;
    }
    return `<span class="cf-none">—</span>`;
  }
  const labels = { provisioning: "开通中", active: "已启用", error: "错误", deleting: "停用中" };
  const chip = `<span class="cf-status ${escapeAttr(cf.status)}">${labels[cf.status] || escapeHtml(cf.status)}</span>`;
  if (state.mode !== "admin" || cf.status === "provisioning" || cf.status === "deleting") {
    return `${host}${chip}`;
  }
  const actions = cf.status === "error"
    ? `<button type="button" data-cf-action="retry" data-node-id="${escapeAttr(tunnel.nodeId)}" data-tunnel-id="${escapeAttr(tunnel.id)}">重试</button>`
    : `<button type="button" data-cf-action="resync" data-node-id="${escapeAttr(tunnel.nodeId)}" data-tunnel-id="${escapeAttr(tunnel.id)}">重新同步</button>`;
  const disable = `<button class="cf-disable" type="button" data-cf-action="disable" data-node-id="${escapeAttr(tunnel.nodeId)}" data-tunnel-id="${escapeAttr(tunnel.id)}">停用</button>`;
  const error = cf.error ? `<small class="cf-error" title="${escapeAttr(cf.error)}">${escapeHtml(cf.error.length > 48 ? `${cf.error.slice(0, 48)}…` : cf.error)}</small>` : "";
  return `<div class="cf-cell">${host}${chip}<span class="cf-actions">${actions}${disable}</span>${error}</div>`;
}

function subscriptionCell(tunnel) {
  const isHidden = !tunnel.subscriptionEnabled;
  const chip = `<span class="sub-status${isHidden ? " is-hidden" : ""}">${isHidden ? "已从订阅隐藏" : "参与订阅下发"}</span>`;
  if (state.mode !== "admin" || !tunnel.managed) return chip;
  const button = `<button class="sub-toggle${isHidden ? " is-hidden" : ""}" type="button" data-tunnel-action="subscription" data-node-id="${escapeAttr(tunnel.nodeId)}" data-tunnel-id="${escapeAttr(tunnel.id)}">${isHidden ? "恢复下发" : "隐藏下发"}</button>`;
  return `<div class="sub-cell">${chip}${button}</div>`;
}

function renderTunnels(tunnels) {
  const query = els.search.value.trim().toLowerCase();
  const nodeId = els.nodeFilter.value;
  const filtered = tunnels.filter((tunnel) => (nodeId === "all" || tunnel.nodeId === nodeId)
    && (!query || [tunnel.name, tunnel.endpoint, tunnel.type || tunnel.protocol, tunnel.nodeName].join(" ").toLowerCase().includes(query)));
  if (!filtered.length) {
    els.tunnels.innerHTML = `<tr><td colspan="9" class="table-empty">没有符合条件的隧道</td></tr>`;
    return;
  }
  els.tunnels.innerHTML = filtered.map((tunnel) => {
    const isManaged = Boolean(tunnel.managed);
    const isPending = isManaged && tunnel.status === "pending";
    const statusClass = isPending ? "pending" : (tunnel.status || "unknown");
    const statusLabel = isPending ? "待应用" : (statusText(tunnel.status) || tunnel.status);
    const protocolLabel = tunnel.type || tunnel.protocol || "—";
    const hopCount = Array.isArray(tunnel.hops) ? tunnel.hops.length : 0;
    const hopLabel = hopCount > 0 ? ` · ${hopCount} 跳` : "";
    const directionLabel = tunnel.metadata?.direction || tunnel.kind?.split("/").pop() || "inbound";

    let actionsCell = "";
    if (isManaged) {
      if (state.mode === "admin") {
        actionsCell = `<div class="tunnel-actions">
          <button type="button" data-tunnel-action="edit" data-node-id="${escapeAttr(tunnel.nodeId)}" data-tunnel-id="${escapeAttr(tunnel.id)}">编辑</button>
          <button type="button" data-tunnel-action="rotate" data-node-id="${escapeAttr(tunnel.nodeId)}" data-tunnel-id="${escapeAttr(tunnel.id)}">轮换凭据</button>
          <button type="button" class="tunnel-delete" data-tunnel-action="delete" data-node-id="${escapeAttr(tunnel.nodeId)}" data-tunnel-id="${escapeAttr(tunnel.id)}">删除</button>
        </div>`;
      } else {
        actionsCell = "—";
      }
    } else {
      actionsCell = `<span class="legacy-note">本地旧配置（需在控制台重建）</span>`;
    }

    return `<tr>
      <td><span class="table-status ${escapeAttr(statusClass)}">${escapeHtml(statusLabel)}</span></td>
      <td class="tunnel-name"><strong>${escapeHtml(tunnel.name)}</strong><small>${escapeHtml(tunnel.nodeName)}</small></td>
      <td>${escapeHtml(directionLabel)} / ${escapeHtml(protocolLabel)}${escapeHtml(hopLabel)}</td>
      <td class="endpoint">${escapeHtml(tunnel.endpoint || "—")}</td>
      <td>${escapeHtml(tunnel.nodeName)}</td>
      <td class="sub-column">${subscriptionCell(tunnel)}</td>
      <td class="cf-column">${cloudflareCell(tunnel)}</td>
      <td>${relativeTime(tunnel.lastSeenAt)}</td>
      <td class="actions-column">${actionsCell}</td>
    </tr>`;
  }).join("");
}

function showEnrollment(data, nodeName) {
  els.tokenValue.textContent = data.token;
  els.tokenExpiry.textContent = `${new Date(data.expiresAt).toLocaleTimeString("zh-CN", { hour12: false })} 失效`;
  els.deployLabel.textContent = `${nodeName} · 一键部署命令`;
  updateDeploymentCommand();
  els.tokenResult.classList.remove("hidden");
}

function openAuth() { els.authToken.value = state.token; els.authError.classList.add("hidden"); els.dialog.showModal(); setTimeout(() => els.authToken.focus(), 50); }
function disconnect() { clearInterval(state.timer); state.token = ""; state.mode = ""; state.overview = { nodes: [], tunnels: [] }; sessionStorage.removeItem("tunnelatlas.token"); sessionStorage.removeItem("tunnelatlas.mode"); setSync("", "等待连接"); els.tokenResult.classList.add("hidden"); render(); openAuth(); }
function startAutoRefresh() { clearInterval(state.timer); state.timer = setInterval(() => refresh({ quiet: true }), 15000); }
function setSync(type, value) { els.syncDot.className = type; els.syncLabel.textContent = value; }
function toast(message) { els.toast.textContent = message; els.toast.classList.add("show"); setTimeout(() => els.toast.classList.remove("show"), 2600); }
function statusText(value) { return ({ pending: "待接入", online: "在线", stale: "陈旧", offline: "离线", healthy: "正常", degraded: "降级", failed: "失败", stopped: "已停止", unknown: "未知" })[value] || value; }
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
function updateDeploymentCommand() {
  els.deployCommand.textContent = deploymentCommand(els.tokenValue.textContent.trim());
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]); }
function escapeAttr(value) { return escapeHtml(value); }

let tunnelDialogMode = "add";
let initialTunnelData = null;

function updateTunnelDialogFields() {
  const type = els.tunnelType.value;
  els.tunnelOptSs.classList.toggle("hidden", type !== "shadowsocks");
  els.tunnelOptServerName.classList.toggle("hidden", !["hysteria2", "tuic", "vless-reality", "anytls-reality"].includes(type));
  els.tunnelOptTuicCc.classList.toggle("hidden", type !== "tuic");
  els.tunnelOptVmess.classList.toggle("hidden", type !== "vmess-ws");

  if (tunnelDialogMode === "edit" && initialTunnelData) {
    const typeChanged = type !== initialTunnelData.type;
    const ssMethodChanged = type === "shadowsocks" && els.tunnelSsMethod.value !== initialTunnelData.method;
    const hy2Changed = type === "hysteria2" && els.tunnelServerName.value !== initialTunnelData.serverName;
    const tuicChanged = type === "tuic" && els.tunnelServerName.value !== initialTunnelData.serverName;
    const willRotate = typeChanged || ssMethodChanged || hy2Changed || tuicChanged;
    els.tunnelCredWarning.classList.toggle("hidden", !willRotate);
  } else {
    els.tunnelCredWarning.classList.add("hidden");
  }
}
function hopSelects() {
  return [els.tunnelHop1, els.tunnelHop2, els.tunnelHop3];
}

function fillHopOptions(entryNodeId, selected = []) {
  const tunnels = (state.overview.tunnels || []).filter((tunnel) => tunnel.managed && tunnel.nodeId !== entryNodeId);
  const blank = ["不经过下一跳", "无第二跳", "无第三跳"];
  hopSelects().forEach((select, index) => {
    const current = selected[index] ? `${selected[index].nodeId}:${selected[index].tunnelId}` : "";
    select.innerHTML = `<option value="">${blank[index]}</option>` + tunnels.map((tunnel) => {
      const value = `${tunnel.nodeId}:${tunnel.id}`;
      return `<option value="${escapeAttr(value)}"${value === current ? " selected" : ""}>${escapeHtml(tunnel.nodeName)} / ${escapeHtml(tunnel.name)} (${escapeHtml(tunnel.type || tunnel.protocol)})</option>`;
    }).join("");
  });
}

function selectedHops() {
  const hops = [];
  for (const select of hopSelects()) {
    const value = select.value;
    if (!value) continue;
    const separator = value.indexOf(":");
    if (separator <= 0) continue;
    hops.push({ nodeId: value.slice(0, separator), tunnelId: value.slice(separator + 1) });
  }
  return hops;
}

function openTunnelDialog(mode, nodeId, tunnelId = null) {
  tunnelDialogMode = mode;
  els.tunnelError.classList.add("hidden");
  els.tunnelCredWarning.classList.add("hidden");

  const nodes = state.overview.nodes || [];
  els.tunnelNodeSelect.innerHTML = nodes.map((n) => `<option value="${escapeAttr(n.id)}">${escapeHtml(n.name)} (${escapeHtml(n.id)})</option>`).join("");

  if (mode === "add") {
    els.tunnelTitle.textContent = "添加隧道";
    els.tunnelId.value = "";
    els.tunnelNodeId.value = nodeId || (nodes[0]?.id || "");
    els.tunnelNodeSelect.value = els.tunnelNodeId.value;
    els.tunnelNodeSelect.disabled = Boolean(nodeId);

    els.tunnelName.value = "";
    els.tunnelType.value = "shadowsocks";
    els.tunnelPort.value = "";
    els.tunnelListen.value = "::";
    els.tunnelPublicHost.value = "";
    els.tunnelSsMethod.value = "2022-blake3-aes-128-gcm";
    els.tunnelServerName.value = "www.bing.com";
    els.tunnelTuicCc.value = "bbr";
    els.tunnelVmessPath.value = "/vmess";
    els.tunnelVmessHost.value = "";
    initialTunnelData = null;
    fillHopOptions(els.tunnelNodeSelect.value, []);
  } else {
    const tunnel = (state.overview.tunnels || []).find((t) => t.nodeId === nodeId && t.id === tunnelId);
    if (!tunnel) return;
    els.tunnelTitle.textContent = "编辑隧道";
    els.tunnelId.value = tunnelId;
    els.tunnelNodeId.value = nodeId;
    els.tunnelNodeSelect.value = nodeId;
    els.tunnelNodeSelect.disabled = true;

    els.tunnelName.value = tunnel.name || "";
    els.tunnelType.value = tunnel.type || "shadowsocks";
    els.tunnelPort.value = tunnel.port || "";
    els.tunnelListen.value = tunnel.listen || "::";
    els.tunnelPublicHost.value = tunnel.publicHost || "";
    els.tunnelSsMethod.value = tunnel.method || "2022-blake3-aes-128-gcm";
    els.tunnelServerName.value = tunnel.serverName || (tunnel.type === "vless-reality" || tunnel.type === "anytls-reality" ? "addons.mozilla.org" : "www.bing.com");
    els.tunnelTuicCc.value = tunnel.congestionControl || "bbr";
    els.tunnelVmessPath.value = tunnel.path || "/vmess";
    els.tunnelVmessHost.value = tunnel.host || "";

    initialTunnelData = {
      type: tunnel.type,
      method: tunnel.method || "2022-blake3-aes-128-gcm",
      serverName: tunnel.serverName || (tunnel.type === "vless-reality" || tunnel.type === "anytls-reality" ? "addons.mozilla.org" : "www.bing.com"),
    };
    fillHopOptions(nodeId, tunnel.hops || []);
  }

  updateTunnelDialogFields();
  els.tunnelDialog.showModal();
}

els.tunnelType.addEventListener("change", updateTunnelDialogFields);
els.tunnelSsMethod.addEventListener("change", updateTunnelDialogFields);
els.tunnelServerName.addEventListener("input", updateTunnelDialogFields);
els.tunnelNodeSelect.addEventListener("change", () => fillHopOptions(els.tunnelNodeSelect.value, selectedHops()));
els.tunnelCancelBtn.addEventListener("click", () => els.tunnelDialog.close());

els.tunnelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.tunnelError.classList.add("hidden");

  const nodeId = els.tunnelNodeSelect.value || els.tunnelNodeId.value;
  const name = els.tunnelName.value.trim();
  const type = els.tunnelType.value;
  const port = Number(els.tunnelPort.value);
  const listen = els.tunnelListen.value.trim() || "::";
  const publicHost = els.tunnelPublicHost.value.trim() || null;

  const payload = { name, type, port, listen, publicHost, hops: selectedHops() };
  if (type === "shadowsocks") {
    payload.method = els.tunnelSsMethod.value;
  } else if (type === "hysteria2") {
    payload.serverName = els.tunnelServerName.value.trim() || "www.bing.com";
  } else if (type === "tuic") {
    payload.serverName = els.tunnelServerName.value.trim() || "www.bing.com";
    payload.congestionControl = els.tunnelTuicCc.value;
  } else if (type === "vless-reality" || type === "anytls-reality") {
    payload.serverName = els.tunnelServerName.value.trim() || "addons.mozilla.org";
  } else if (type === "vmess-ws") {
    payload.path = els.tunnelVmessPath.value.trim() || "/vmess";
    payload.host = els.tunnelVmessHost.value.trim() || null;
  }

  try {
    if (tunnelDialogMode === "add") {
      await api(`/v1/admin/nodes/${encodeURIComponent(nodeId)}/tunnels`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast("隧道已创建，待 Agent 同步");
    } else {
      const tunnelId = els.tunnelId.value;
      await api(`/v1/admin/nodes/${encodeURIComponent(nodeId)}/tunnels/${encodeURIComponent(tunnelId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      toast("隧道配置已更新，待 Agent 同步");
    }
    els.tunnelDialog.close();
    await refresh({ quiet: true });
  } catch (error) {
    els.tunnelError.textContent = error.message;
    els.tunnelError.classList.remove("hidden");
  }
});

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
  if (action === "add-tunnel") {
    openTunnelDialog("add", node.id);
    return;
  }
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

els.tunnels.addEventListener("click", async (event) => {
  const cfButton = event.target.closest("button[data-cf-action]");
  if (cfButton && state.mode === "admin") {
    const { nodeId, tunnelId } = cfButton.dataset;
    const action = cfButton.dataset.cfAction;
    if (action === "disable" && !window.confirm("确定停用该隧道的 Cloudflare 前端吗？\n\n将删除代理 DNS 记录和两条规则，订阅会立即回退到直连地址。")) return;
    cfButton.disabled = true;
    try {
      const path = `/v1/admin/nodes/${encodeURIComponent(nodeId)}/tunnels/${encodeURIComponent(tunnelId)}/cloudflare`;
      if (action === "disable") await api(path, { method: "DELETE" });
      else await api(path, { method: "PUT" });
      await refresh({ quiet: true });
      toast(action === "disable" ? "Cloudflare 前端已停用" : "Cloudflare 前端已同步");
    } catch (error) { cfButton.disabled = false; toast(error.message); }
    return;
  }
  const actionButton = event.target.closest("button[data-tunnel-action]");
  if (actionButton && state.mode === "admin") {
    const { nodeId, tunnelId } = actionButton.dataset;
    const action = actionButton.dataset.tunnelAction;
    const tunnel = (state.overview.tunnels || []).find((item) => item.nodeId === nodeId && item.id === tunnelId);
    if (!tunnel) return;

    if (action === "edit") {
      openTunnelDialog("edit", nodeId, tunnelId);
      return;
    }
    if (action === "rotate") {
      if (!window.confirm(`确定轮换隧道“${tunnel.name}”的凭据吗？\n\n轮换后新生成的配置需要 Agent 同步并重启后生效，现有连接可能中断。`)) return;
      actionButton.disabled = true;
      try {
        await api(`/v1/admin/nodes/${encodeURIComponent(nodeId)}/tunnels/${encodeURIComponent(tunnelId)}/credentials:rotate`, { method: "POST" });
        await refresh({ quiet: true });
        toast("凭据已轮换，待 Agent 同步");
      } catch (error) { actionButton.disabled = false; toast(error.message); }
      return;
    }
    if (action === "delete") {
      if (!window.confirm(`确定删除隧道“${tunnel.name}”吗？\n\n删除后 sing-box 将停止该入站，相关的 Cloudflare 前端也将被清理。`)) return;
      actionButton.disabled = true;
      try {
        await api(`/v1/admin/nodes/${encodeURIComponent(nodeId)}/tunnels/${encodeURIComponent(tunnelId)}`, { method: "DELETE" });
        await refresh({ quiet: true });
        toast("隧道已删除");
      } catch (error) { actionButton.disabled = false; toast(error.message); }
      return;
    }
    if (action === "subscription") {
      if (tunnel.subscriptionEnabled && !window.confirm(`确定在订阅下发中隐藏隧道“${tunnel.name}”吗？\n\n节点仍会继续上报，可随时恢复。`)) return;
      actionButton.disabled = true;
      try {
        const nextState = !tunnel.subscriptionEnabled;
        await api(`/v1/admin/nodes/${encodeURIComponent(nodeId)}/tunnels/${encodeURIComponent(tunnelId)}`, {
          method: "PATCH",
          body: JSON.stringify({ subscriptionEnabled: nextState }),
        });
        await refresh({ quiet: true });
        toast(nextState ? "隧道已恢复订阅下发" : "隧道已从订阅下发隐藏");
      } catch (error) { actionButton.disabled = false; toast(error.message); }
    }
  }
});

$("#copy-token").addEventListener("click", async () => { await navigator.clipboard.writeText(els.tokenValue.textContent); toast("注册码已复制"); });
els.copyDeployCommand.addEventListener("click", async () => { await navigator.clipboard.writeText(els.deployCommand.textContent); toast("一键部署命令已复制"); });

if (state.token) { refresh().then(startAutoRefresh); } else { render(); openAuth(); }
