# TunnelAtlas（隧图）

TunnelAtlas 是一个基于 Cloudflare Workers 与本机 Rust 守护程序的隧道注册和发现服务。

本机 `tunnelatlasd` 维护协议声明、私密凭据、sing-box 配置和进程，并定期批量上报当前已应用的 inbound；Cloudflare Worker 不下发部署命令，只负责注册、鉴权、加密存储和查询。业务流量不经过 TunnelAtlas。

## 仓库结构

- `agent/`：Rust 守护程序，负责注册、签名和批量状态上报。
- `worker/`：TypeScript Worker 和 D1 migration。
- `deploy/`：systemd unit。
- `docs/`：架构、协议、安全和开发文档。

## 已实现

- 管理员创建站点和 10 分钟有效的一次性注册码。
- Agent 本地生成 Ed25519 密钥，私钥不离开主机。
- Agent 使用签名请求和持久化单调序列号防止重放。
- sing-box 配置在替换前通过 `sing-box check -c` 校验。
- 合法配置原子替换并触发进程重启；非法配置不会影响当前实例。
- sing-box 异常退出自动重启，SIGTERM/SIGINT 时优雅停止。
- 单次报告批量同步该 Agent 的全部 sing-box inbound。
- inbound 认证参数按字段白名单提取，并以 AES-256-GCM 加密后写入 D1。
- D1 保存 Agent、隧道状态和最后活跃时间。
- 发现 API 只返回在线 Agent 的隧道。
- 节点订阅 API 使用 `READ_TOKEN` 鉴权，提供 Base64 编码的节点 URI 列表。
- 同域管理控制台展示站点、Agent 和隧道，并可创建站点及一次性注册码。
- Rust CLI 提供交互式中文管理菜单，以及协议、链接、配置、服务、更新和卸载命令。

## 快速开始

见 [本地开发指南](docs/development.md)。生产部署前请先阅读[安全模型](docs/security.md)和[GitHub 与 Cloudflare 自动部署](docs/deployment.md)。

### 一键部署 Agent

先在控制台为目标站点生成一次性注册码，然后在 Linux 节点上执行（支持 systemd 和 OpenRC）：

```bash
curl -fsSL https://raw.githubusercontent.com/huochai67/tunnelatlas/main/deploy/install.sh -o /tmp/tunnelatlas-install.sh
sudo bash /tmp/tunnelatlas-install.sh \
  --server-url https://你的-worker-域名 \
  --site-id site-home \
  --agent-name edge-01
rm -f /tmp/tunnelatlas-install.sh
```

脚本会静默询问注册码，自动识别 x86_64/ARM64 及 systemd/OpenRC、校验并安装最新 Release 和 sing-box、创建随机凭据、注册节点并启用开机服务。安装器仅支持干净系统；发现旧 TunnelAtlas 状态、外部 sing-box 配置或正在运行的独立 sing-box 服务时会直接停止。

可按参考安装器的协议选项部署，例如 SS 和 VLESS Reality：

```bash
sudo bash /tmp/tunnelatlas-install.sh \
  --server-url https://你的-worker-域名 \
  --site-id site-home \
  --agent-name edge-01 \
  --sing-box-protocols ss,reality \
  --sing-box-reality-port 443 \
  --sing-box-reality-sni addons.mozilla.org
```

使用 `--skip-sing-box-install` 可要求必须预先存在 sing-box；使用 `--install-sing-box` 可强制安装 sing-box。Agent 永远不会读取 `/etc/sing-box/config.json`，生成配置位于 `/var/lib/tunnelatlas/sing-box.json`。

日常管理：

```bash
sudo tunnelatlasd manage
sudo tunnelatlasd protocol list
sudo tunnelatlasd protocol add reality --port 443 --server-name addons.mozilla.org
sudo tunnelatlasd protocol rotate vless-in
sudo tunnelatlasd links
sudo tunnelatlasd service status
```

## 发布 Agent

将 `agent/Cargo.toml` 中的版本提交到 `main` 后，推送同版本的 `vX.Y.Z` 标签会触发 GitHub Actions。流水线通过检查后自动创建 GitHub Release，并附带 Linux x86_64、Linux ARM64 的 glibc/musl 压缩包及 `SHA256SUMS`：

```bash
git tag v0.0.8
git push origin v0.0.8
```

标签版本必须与 `tunnelatlasd` 的 Cargo 包版本一致，否则发布会停止。
