# TunnelAtlas（隧图）

TunnelAtlas 是一个基于 Cloudflare Workers 与本机 Rust 守护程序的隧道注册、托管和发现服务。

管理员在 Cloudflare Worker 控制台集中定义期望隧道（支持 Shadowsocks、Hysteria2、TUIC、VLESS Reality、AnyTLS Reality 和 VMess WebSocket，以及跨节点链式出站），本机 `tunnelatlasd` 负责安全接入、应用 Worker 下发的协议凭据、本地签发 HY2/TUIC 证书、校验并原子收敛 sing-box 配置，并定期上报运行观测状态。业务流量不经过 TunnelAtlas。

## 仓库结构

- `agent/`：Rust 守护程序，负责注册、签名、期望配置拉取、凭据落地、sing-box 监督和观测状态上报。
- `worker/`：TypeScript Worker、D1 migration 与控制台前端。
- `deploy/`：一键安装脚本与 systemd/OpenRC 托管文件。
- `docs/`：架构、协议、安全、ADR 和开发文档。

## 核心特性

- **云端集中管理**：在 Worker 控制台统一创建、编辑、隐藏、轮换或删除隧道，并配置入口到其他节点的 hops。协议密码、UUID 与 Reality 密钥由 Worker 生成并加密存储；HY2/TUIC 证书仍在节点本地签发。
- **配置版本控制与原子收敛**：Worker 单调递增 `config_version`；Agent 在本地执行事务收敛，经 `sing-box check` 校验、热启动及 500 ms 存活探查确认无误后才切换提交，任何失败无损回滚。
- **防重放与请求验签**：基于 Ed25519 签名与严格单调自增序列号，杜绝乱序与重放。
- **自动灾备与进程监督**：sing-box 异常退出自动重启；Worker 宕机或网络离线不影响本地正常运行与启动。
- **丰富订阅与分发发现**：内置在线动态判定、Base64 订阅输出、Cloudflare CDN 边缘接入联动及细粒度隧道隐藏控制。
- **极简运维 CLI**：提供交互式管理菜单以及配置检查、服务启停、日志查看、自动更新和干净卸载。

## 快速开始

见 [本地开发指南](docs/development.md)。生产部署前请先阅读[安全模型](docs/security.md)和[GitHub 与 Cloudflare 自动部署](docs/deployment.md)。

### 一键部署 Agent

先在控制台创建节点并取得一次性注册码。默认启动交互式向导（支持 systemd 和 OpenRC）：

```bash
curl -fsSL https://raw.githubusercontent.com/huochai67/tunnelatlas/main/deploy/install.sh -o /tmp/tunnelatlas-install.sh
sudo bash /tmp/tunnelatlas-install.sh
rm -f /tmp/tunnelatlas-install.sh
```

向导会依次询问 Worker URL 与 sing-box 安装方式，最后静默读取一次性注册码并完成接入。节点接入后会自动从 Worker 获取期望隧道配置并启动。

自动化部署使用 `--non-interactive`；该模式不会读取终端，所有必填值必须通过参数或环境变量传入：

```bash
curl -fsSL https://raw.githubusercontent.com/huochai67/tunnelatlas/main/deploy/install.sh -o /tmp/tunnelatlas-install.sh
export TUNNELATLAS_ENROLLMENT_TOKEN='一次性注册码'
sudo --preserve-env=TUNNELATLAS_ENROLLMENT_TOKEN bash /tmp/tunnelatlas-install.sh \
  --non-interactive \
  --server-url https://你的-worker-域名
unset TUNNELATLAS_ENROLLMENT_TOKEN
rm -f /tmp/tunnelatlas-install.sh
```

脚本会自动识别 x86_64/ARM64 及 systemd/OpenRC、校验并安装最新 Release 和 sing-box、注册节点并启用开机服务。安装器仅支持干净系统；发现旧 TunnelAtlas 状态、外部 sing-box 配置或正在运行的独立 sing-box 服务时会直接停止。

日常管理：

```bash
sudo tunnelatlasd manage
sudo tunnelatlasd config show
sudo tunnelatlasd config check
sudo tunnelatlasd service status
sudo tunnelatlasd service logs
```

## 升级与版本发布顺序

TunnelAtlas 从本地自治升级为 Worker 托管模型时采用手动重建平滑切割。部署与发布必须严格遵循以下顺序：

1. **部署加法 Worker**：首先部署包含 `0007_worker_managed_tunnel_configs.sql` 的新版 Worker。该版本完全兼容旧版 Agent。
2. **在控制台重建期望隧道**：管理员登录 Worker 控制台，为各个节点创建所需的期望隧道配置（包括公网地址）。
3. **发布与升级 Agent**：发布并升级各节点 Agent。升级后的 Agent 收到 Worker 下发的权威配置后完成收敛，主动清空旧本地 YAML 中的 `protocols` 与 `publicHost`，并发送首个数字版本报告触发服务端遗留数据清理。若升级前未在控制台配置隧道，空配置将停止本地旧隧道。
