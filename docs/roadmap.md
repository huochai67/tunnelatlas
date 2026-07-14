# 路线图

## 已完成：注册发现纵向切片

- Worker、D1 schema、站点和注册码 API。
- Rust Agent 注册、Ed25519 请求签名、序列号和批量报告。
- 在线隧道发现 API、单元测试和本地端到端验证。

## 已完成：sing-box 本机执行面

- 源配置解析、候选配置、`sing-box check` 和原子替换。
- sing-box 子进程启动、异常重启、配置变更重启和优雅停止。
- 只发现 inbounds，按字段白名单提取认证参数并加密存储。

## 下一阶段：运行观测

1. 探测 sing-box 版本并上报兼容性信息。
2. 接入本地 Clash API；sing-box 1.14 稳定后评估新的 gRPC API。
3. 增加连接、流量、URLTest 和 outbound 健康状态。
4. 增加随机心跳抖动和结构化日志。

## 上线准备

1. Agent 撤销和重新注册流程。
2. 管理端 RBAC、审计和速率限制。
3. 集成测试覆盖注册码竞争、乱序上报和离线过滤。
4. Agent 二进制发布、签名、SBOM 和 systemd 安装脚本。
5. D1 备份恢复和负载/CPU Time 测试。
