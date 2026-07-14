# TunnelAtlas（隧图）

TunnelAtlas 是一个基于 Cloudflare Workers 与本机 Rust 守护程序的隧道注册和发现服务。

本机 `tunnelatlasd` 维护 sing-box 配置和进程，并定期批量上报从配置中发现的入站、出站和 endpoint；Cloudflare Worker 不下发部署命令，只负责注册、鉴权、存储和查询。业务流量不经过 TunnelAtlas。

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
- 单次报告批量同步该 Agent 的全部 sing-box 隧道。
- D1 保存 Agent、隧道状态和最后活跃时间。
- 发现 API 只返回在线 Agent 的隧道。
- 同域管理控制台展示站点、Agent 和隧道，并可创建站点及一次性注册码。
- Rust CLI 支持 `check`、`enroll`、`report-once` 和 `run`。

## 快速开始

见 [本地开发指南](docs/development.md)。生产部署前请先阅读[安全模型](docs/security.md)和[GitHub 与 Cloudflare 自动部署](docs/deployment.md)。
