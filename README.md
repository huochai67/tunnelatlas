# TunnelAtlas（隧图）

TunnelAtlas 是一个基于 Cloudflare Workers 与本机 Rust 守护程序的隧道注册和发现服务。

本机 `tunnelatlasd` 维护 sing-box 配置和进程，并定期批量上报从配置中发现的 inbound 及其连接认证参数；Cloudflare Worker 不下发部署命令，只负责注册、鉴权、加密存储和查询。业务流量不经过 TunnelAtlas。

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
- 同域管理控制台展示站点、Agent 和隧道，并可创建站点及一次性注册码。
- Rust CLI 支持 `check`、`enroll`、`report-once` 和 `run`。

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

脚本会静默询问注册码，自动识别 x86_64/ARM64 及 systemd/OpenRC、校验并安装最新 Release、注册节点及启用开机服务。如果缺少 sing-box 或 `/etc/sing-box/config.json`，脚本会通过固定版本并校验过的 [`huochai67/singbox-deploy`](https://github.com/huochai67/singbox-deploy) 安装器自动部署随机端口的 Shadowsocks；已有二进制和配置不会被改写。

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

使用 `--skip-sing-box-install` 可要求必须预先存在 sing-box；使用 `--install-sing-box` 可在首次接入时强制重新部署，原配置会备份为 `config.json.pre-tunnelatlas`。部署完成后，脚本停用独立的 sing-box 服务并交由 `tunnelatlasd` 监管。再次执行脚本会保留节点配置和身份，仅升级程序并重启服务。

## 发布 Agent

将 `agent/Cargo.toml` 中的版本提交到 `main` 后，推送同版本的 `vX.Y.Z` 标签会触发 GitHub Actions。流水线通过检查后自动创建 GitHub Release，并附带 Linux x86_64、Linux ARM64 的 glibc/musl 压缩包及 `SHA256SUMS`：

```bash
git tag v0.0.3
git push origin v0.0.3
```

标签版本必须与 `tunnelatlasd` 的 Cargo 包版本一致，否则发布会停止。
