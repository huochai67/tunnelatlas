# ADR-0001：本地自治、云端注册发现

- 状态：Accepted
- 日期：2026-07-14

## 决策

Cloudflare Worker 不向 Agent 下发部署命令。Rust Agent 根据本机配置部署和维护隧道，再以约定协议注册、续租并上报实际状态。Worker 和 D1 只构成注册发现控制面，业务数据面由现有隧道软件承担。

## 结果

系统不需要 Queues、Durable Objects 或 WebSocket 即可完成 MVP。已有隧道不依赖控制面在线；代价是云端不能直接修改本机期望状态，配置管理需要由本地文件或其他运维系统完成。

