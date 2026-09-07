# ADR-0002：Worker 集中托管期望配置与协议身份

- 状态：Accepted（替代 ADR-0001；2026-09-08 修订：协议身份改由 Worker 生成下发）
- 日期：2026-09-06

## 背景

在 ADR-0001 中，TunnelAtlas 采用“本地自治、云端注册发现”模型。随后期望配置所有权移交 Worker（`tunnel_configs`），但密码、UUID、Reality 密钥仍由 Agent 本地生成。链式代理需要入口节点拿到出口的客户端参数，且订阅不应等待 Agent 首次上报。

## 决策

1. **期望配置与协议身份的权威在 Worker**：
   - 管理员在控制台创建、编辑、隐藏、轮换或删除隧道；可选为入口隧道配置最多 3 个跨节点 hops。
   - 创建与轮换时 Worker 生成协议身份（SS 密码、UUID、Reality 密钥对等），以 AES-256-GCM 写入 `tunnel_configs.credentials_ciphertext`（AAD `creds:${nodeId}:${tunnelId}`）。
   - `desiredConfig` 向拥有该 inbound 的节点下发其服务端凭据，并向入口节点下发 hops 的**客户端**参数（不含 Reality/TLS 私钥）。
   - Hysteria2/TUIC 的 TLS 自签名证书仍由 Agent 按隧道 ID 与 `credentialGeneration` 在本地签发；私钥不出节点。

2. **Agent 收敛**：
   - 若 `credentials` 存在，写入 `secrets.json` 并渲染；缺失时保留本地生成以兼容未轮换的旧隧道。
   - hops 全部就绪时渲染 outbound 链与 `route.rules`；任一跳未就绪则将该 inbound 指到 `block`，禁止 fallback `direct`。
   - 完整 sing-box JSON 仍由 Agent 渲染、校验、热切换；Worker 不下发配置 blob。

3. **切割**：
   - 先部署含 migration `0008_hosted_credentials_and_hops.sql` 的 Worker。
   - 新隧道立即拥有托管凭据。旧隧道在轮换（或类型/SS method/HY2·TUIC serverName 变更）时生成。
   - Reality/AnyTLS 私钥从未上报，旧隧道必须显式轮换后新 Agent 才能与订阅一致。
   - 订阅优先使用观测认证；观测为空时回落到托管客户端视图。

## 结果

- 控制台可立即配置入口→出口链，不必等出口 Agent 上报。
- `ADMIN_TOKEN` + `CREDENTIALS_KEY` 可解密全部协议身份（含 Reality 私钥）。TLS 私钥仍留在节点。
- 入口节点只拿到 hop 的客户端参数；出口 Reality 私钥只出现在出口自己的 `desiredConfig` 中。
