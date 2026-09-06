# ADR-0002：Worker 集中托管期望配置与节点凭据本地生成

- 状态：Accepted（替代 ADR-0001）
- 日期：2026-09-06

## 背景

在 ADR-0001 中，TunnelAtlas 采用“本地自治、云端注册发现”模型，由本地 `config.yaml` 或 CLI 维护协议声明，并通过 `POST /v1/agent/report` 单向同步到 Worker。随着节点规模增长，本地配置导致管理分散、端口冲突难以在云端检测、且缺乏集中的配置版本管理与生命周期控制。

## 决策

1. **期望配置所有权移交 Worker**：
   - 管理员在 Worker 控制台集中创建、编辑、隐藏、轮换凭据及删除隧道定义（`tunnel_configs` 表）。
   - 节点状态由 Worker 统一维护单调递增的 `config_version`；Agent 在报告响应中获取签名的期望配置 `desiredConfig`。
   - 期望配置仅下发协议意图（名称、类型、监听地址、端口、公网主机、协议选项及凭据代数 `credentialGeneration`），绝不下发密码、UUID、Reality 私钥或 TLS 私钥。

2. **凭据本地生成与节点私有**：
   - 协议密码、UUID、Reality 密钥对与 TLS 自签名证书仍由 Agent 在本地生成并保存在 `secrets.json` 和证书目录中。
   - 凭据生命周期受 `credentialGeneration` 控制：当协议类型、Shadowsocks 加密方式或 Hysteria2/TUIC 证书域名变更，或管理员在控制台触发轮换时，凭据代数递增，Agent 重新生成该隧道的密钥并上报新认证参数。

3. **双向解耦与平滑切割**：
   - 部署顺序强制要求：先部署具备向后兼容能力的加法 Worker（包含 migration 0007）；管理员在控制台手动重建各节点的期望配置（包含公网地址）；最后发布并升级 Agent。
   - 升级后的 Agent 若收到空期望配置列表，将视为空配置为权威状态并主动停止旧本地隧道，原子清除本地 YAML 中的 `protocols` 与 `publicHost`。

## 结果

- 管理员可在云端控制台完成全生命周期隧道管理。
- 保证了节点安全边界：私钥与密码绝不进入云端数据库。
- 实现了单节点内原子收敛、安全回滚与本地诊断保留。
