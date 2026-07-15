# 通信协议

## 管理 API

管理 API 使用 `Authorization: Bearer <ADMIN_TOKEN>`：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/admin/nodes` | 创建待接入节点并生成首次注册码 |
| POST | `/v1/admin/nodes/{nodeId}/enrollment-tokens` | 为待接入节点废止旧码并生成新注册码 |
| POST | `/v1/admin/nodes/{nodeId}/enrollment:reset` | 撤销旧 Agent 身份、清空隧道并生成新注册码 |
| DELETE | `/v1/admin/nodes/{nodeId}` | 永久删除节点、注册码和隧道 |
| GET | `/v1/admin/overview` | 获取控制台所需的节点和隧道概况 |

`POST /v1/admin/nodes` 只接收显示名称，节点 ID 由 Worker 生成；显示名称允许重复。创建响应包含 `node`、`token` 和 `expiresAt`。节点在 Agent 认领前为 `pending`，已接入节点只能通过显式重置重新注册。

## Agent 注册

Agent 在本地生成 Ed25519 密钥，通过 HTTPS 提交公钥、平台和 labels：

```http
POST /v1/enrollments:exchange
Authorization: Enrollment <one-time-token>
```

注册码直接绑定节点，以加 pepper 的 SHA-256 摘要存储。Worker 通过条件更新保证竞争请求中只有一个能够认领节点，响应继续使用 `{ "agentId": "node_..." }`，本地 identity 和签名协议保持 `agentId` 命名。

## Agent 报告

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

服务端要求时间偏差不超过 5 分钟，并要求 sequence 严格大于该 Agent 已接受的值。Agent 在发送前原子持久化下一个 sequence；请求失败可以跳号，但不能复用。重置接入会立即清除服务端公钥和 sequence，旧身份随即失效。

报告是 Agent 当前已应用协议声明的完整快照，最多包含 64 条 inbound，最大 256 KiB。`authentication` 仅允许约定的认证字段；认证对象使用 AES-256-GCM 加密后写入 D1。响应包含 Worker 观察到的 `observedAddress`，Agent 将其缓存供本地链接展示使用。

## 发现 API

```http
GET /v1/tunnels?nodeId=node_xxx
Authorization: Bearer <READ_TOKEN>
```

返回仍在线节点的 inbound，最多 1000 条。响应使用 `nodeId` 和 `nodeName` 标识归属；`nodeId` 可选，省略时返回全部节点。每项的 `authentication` 包含解密后的认证参数，因此 `READ_TOKEN` 本身属于敏感凭据；`ADMIN_TOKEN` 也具有读取权限。

## 节点订阅 API

```http
GET /v1/subscription?nodeId=node_xxx
Authorization: Bearer <READ_TOKEN>
```

不支持自定义请求头的订阅客户端可以将令牌放入 URL：

```text
https://atlas.example/v1/subscription?nodeId=node_xxx&token=<READ_TOKEN>
```

返回 `text/plain` 格式的标准 Base64；解码后每行一个节点 URI。接口只接受 `READ_TOKEN`，并仅输出在线节点上状态为 `healthy`、端点和认证信息完整的受支持 inbound。当前支持 Shadowsocks、VLESS Reality、VMess WebSocket、Hysteria 2、TUIC 和 AnyTLS Reality。订阅显示名称使用 `节点名称/协议名称/用户`。URL token 可能进入浏览器历史、代理或访问日志；支持请求头时仍应优先使用 Bearer 认证。

## 管理控制台

Worker Static Assets 在 `/` 提供管理控制台。控制台令牌仅存入当前标签页的 `sessionStorage`；管理令牌可创建、重置和删除节点，只读令牌只能查看在线隧道。创建或重置节点后，控制台会生成包含当前 Worker 地址和注册码的一键部署命令。

## 破坏性模型变更

`0003_merge_sites_and_agents_into_nodes.sql` 会删除旧站点、Agent、注册码和隧道表并创建单一节点模型，不迁移旧数据。必须先发布兼容的 `tunnelatlasd 0.0.9`，再应用该 migration 和部署 Worker。
