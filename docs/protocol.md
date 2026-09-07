# 通信协议

## 管理 API

管理 API 使用 `Authorization: Bearer <ADMIN_TOKEN>`：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/admin/nodes` | 创建待接入节点并生成首次注册码 |
| POST | `/v1/admin/nodes/{nodeId}/enrollment-tokens` | 为待接入节点废止旧码并生成新注册码 |
| POST | `/v1/admin/nodes/{nodeId}/enrollment:reset` | 撤销旧 Agent 身份、清空已观测隧道并生成新注册码 |
| DELETE | `/v1/admin/nodes/{nodeId}` | 永久删除节点、注册码、期望隧道与观测隧道 |
| GET | `/v1/admin/overview` | 获取控制台所需的节点和隧道概况（包含期望与观测状态） |
| POST | `/v1/admin/nodes/{nodeId}/tunnels` | 为节点创建期望隧道配置（递增 `config_version`） |
| PUT | `/v1/admin/nodes/{nodeId}/tunnels/{tunnelId}` | 完整更新期望隧道字段（必要时递增 `credential_generation` 和 `config_version`） |
| PATCH | `/v1/admin/nodes/{nodeId}/tunnels/{tunnelId}` | 修改隧道的订阅可见性（`subscriptionEnabled`，不递增 `config_version`） |
| POST | `/v1/admin/nodes/{nodeId}/tunnels/{tunnelId}/credentials:rotate` | 显式触发该隧道凭据轮换（递增 `credential_generation` 和 `config_version`） |
| DELETE | `/v1/admin/nodes/{nodeId}/tunnels/{tunnelId}` | 删除期望隧道与观测状态，清理 Cloudflare 前端并递增 `config_version` |
| PUT | `/v1/admin/nodes/{nodeId}/tunnels/{tunnelId}/cloudflare` | 启用/重试/重新同步 VMess-WS 隧道的 Cloudflare 前端 |
| DELETE | `/v1/admin/nodes/{nodeId}/tunnels/{tunnelId}/cloudflare` | 停用前端：删除代理 DNS、Flexible SSL 与 Origin 端口规则 |

### 隧道配置 CRUD 规则

1. `POST /v1/admin/nodes/{nodeId}/tunnels`：
   - 接收完整的期望隧道参数：`name` (`^[A-Za-z0-9_-]{1,64}$`)、`type`、`port` (`1..=65535`)、可选 `listen`（默认 `::`）、可选 `publicHost`、对应协议选项，以及可选 `hops`（最多 3 项 `{ nodeId, tunnelId }`）。
   - hops 必须指向其他节点上已存在的隧道，禁止自引用、同节点和环；否则 400/404。
   - 插入时 Worker 生成协议身份并加密存储，原子递增 `nodes.config_version`，返回 `{ tunnel }`（状态 201，不含明文密钥）。
   - 每个节点最多 64 条期望隧道；`name` 或 `port` 冲突返回 409。

2. `PUT /v1/admin/nodes/{nodeId}/tunnels/{tunnelId}`：
   - 完整替换可编辑字段（含 `hops`），保持 `id`、`node_id` 与 `subscription_enabled`。
   - 当协议类型、Shadowsocks `method` 或 Hysteria2/TUIC `serverName` 改变时递增 `credential_generation` 并重新生成托管凭据。
   - 期望字段或 hops 实际改变时递增 `config_version`；被其他入口引用为 hop 的隧道变更还会递增那些入口节点的版本。

3. `PATCH /v1/admin/nodes/{nodeId}/tunnels/{tunnelId}`：
   - 仅接收 `{ "subscriptionEnabled": boolean }`，不递增 `config_version`。

4. `POST /v1/admin/nodes/{nodeId}/tunnels/{tunnelId}/credentials:rotate`：
   - Worker 重新生成该隧道协议身份，递增 `credential_generation` 与相关节点 `config_version`（含把它当作 hop 的入口节点）。

5. `DELETE /v1/admin/nodes/{nodeId}/tunnels/{tunnelId}`：
   - 若该隧道被其他隧道引用为 hop，返回 409 `Tunnel is used as a next hop`。
   - 否则按原规则清理 Cloudflare 前端、期望行与观测行，并递增 `config_version`。


## Agent 注册

Agent 本地生成 Ed25519 密钥，通过 HTTPS 提交公钥、平台和 labels：

```http
POST /v1/enrollments:exchange
Authorization: Enrollment <one-time-token>
```

注册码直接绑定节点，以加 pepper 的 SHA-256 摘要存储。Worker 通过条件更新保证竞争请求中只有一个能够认领节点，响应为 `{ "agentId": "node_..." }`。

## Agent 报告与期望状态同步

```http
POST /v1/agent/report
X-Agent-ID: node_...
X-Timestamp: 2026-07-14T02:00:00Z
X-Sequence: 42
X-Content-SHA256: <hex>
X-Signature: <base64url-ed25519-signature>
```

签名原文为：

```text
METHOD\nPATH\nTIMESTAMP\nSEQUENCE\nBODY_SHA256
```

### 请求体与版本语义

请求体 JSON 包含：
- `agentVersion`: string
- `labels`: map
- `tunnels`: 观测到的 inbound 快照
- `appliedConfigVersion`: 三态字段：
  - 省略（未提供）：旧 Agent 兼容模式，执行遗留全量观测 upsert/delete。
  - 显式 `null`：新 Agent 初始启动或未应用 Worker 期望配置，推进 sequence/心跳/元数据并记录 `configApplyError`，但不修改观测隧道、Cloudflare 前端或 `nodes.applied_config_version`。
  - 非负安全整数（`<= nodes.config_version`）：新 Agent 已应用的期望版本号。只接受存在于 `tunnel_configs` 中的隧道并用 `EXISTS tunnel_configs` 条件保障 upsert，同时清除未被接受的遗留/孤儿观测行。
- `configApplyError`: 可选非机密错误码：`invalid_desired_config`、`sing_box_validation_failed`、`sing_box_start_failed`、`local_apply_failed`。

### 响应体

响应始终携带权威期望配置快照：

```json
{
  "acceptedSequence": 42,
  "serverTime": "2026-09-06T12:00:00Z",
  "observedAddress": "203.0.113.8",
  "desiredConfig": {
    "version": 1,
    "tunnels": [
      {
        "id": "tunnel_xxx",
        "name": "ss-in",
        "type": "shadowsocks",
        "listen": "::",
        "port": 8388,
        "publicHost": null,
        "credentialGeneration": 1,
        "method": "2022-blake3-aes-128-gcm",
        "credentials": { "password": "<ss2022>" },
        "hops": []
      }
    ]
  }
}
```

响应先读取节点版本号，再组装带托管凭据与已解析 hops 的期望隧道列表；并发变更将使返回的隧道行更新于版本号，迫使 Agent 后续重新收敛。


## 发现 API

```http
GET /v1/tunnels?nodeId=node_xxx
Authorization: Bearer <READ_TOKEN>
```

返回仍在线节点的 inbound，最多 1000 条。对于已确认数字版本的节点，仅展示关联到 `tunnel_configs` 的隧道；对于未确认数字版本的遗留/引导节点，继续展示已保存的观测行。每项的 `authentication` 包含解密后的认证参数。

## 节点订阅 API

```http
GET /v1/subscription?nodeId=node_xxx
Authorization: Bearer <READ_TOKEN>
```

支持 `?token=<READ_TOKEN>` 查询参数。托管节点通过 `tunnel_configs.subscription_enabled` 控制下发；遗留节点通过 `tunnels.subscription_enabled` 控制。仅输出在线且状态为 `healthy` 的隧道。

## 发布与升级顺序

1. 先部署包含 `0007_worker_managed_tunnel_configs.sql` 的加法 Worker。
2. 管理员在控制台为各节点手动创建期望隧道配置（包括公网地址）。
3. 升级 Agent：新 Agent 启动后请求期望配置，完成收敛后本地停用并清除旧配置文件中的 `protocols` 与 `publicHost`，并发送首个数字版本报告触发服务端遗留清理。
