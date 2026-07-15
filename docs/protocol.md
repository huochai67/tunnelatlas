# 通信协议

## 管理 API

管理 API 使用 `Authorization: Bearer <ADMIN_TOKEN>`：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/admin/sites` | 创建站点 |
| DELETE | `/v1/admin/sites/{siteId}` | 永久删除站点及其注册码、Agent 和隧道 |
| POST | `/v1/admin/sites/{siteId}/enrollment-tokens` | 创建一次性注册码 |
| DELETE | `/v1/admin/agents/{agentId}` | 永久删除 Agent 及其隧道 |
| GET | `/v1/admin/overview` | 获取控制台所需的站点、Agent 和隧道概况 |

## Agent 注册

Agent 在本地生成 Ed25519 密钥，通过 HTTPS 提交公钥：

```http
POST /v1/enrollments:exchange
Authorization: Enrollment <one-time-token>
```

Worker 只保存公钥。注册码以加 pepper 的 SHA-256 摘要存储，并通过条件更新保证竞争请求中只有一个能够消费成功。

## Agent 报告

```http
POST /v1/agent/report
X-Agent-ID: agent_...
X-Timestamp: 2026-07-14T02:00:00Z
X-Sequence: 42
X-Content-SHA256: <hex>
X-Signature: <base64url-ed25519-signature>
```

签名原文为：

```text
METHOD\nPATH\nTIMESTAMP\nSEQUENCE\nBODY_SHA256
```

服务端要求时间偏差不超过 5 分钟，并要求 sequence 严格大于该 Agent 已接受的值。Agent 在发送前原子持久化下一个 sequence；请求失败可以跳号，但不能复用。

报告是 Agent 当前已应用协议声明的完整快照，最多包含 64 条 inbound，最大 256 KiB。`authentication` 仅允许约定的认证字段；所有字段在入库前校验，认证对象再使用 AES-256-GCM 加密。响应包含 Worker 观察到的 `observedAddress`，Agent 将其缓存供本地链接展示使用。

## 发现 API

```http
GET /v1/tunnels?siteId=site-home
Authorization: Bearer <READ_TOKEN>
```

返回仍在线且未撤销 Agent 的 inbound，最多 1000 条。每项的 `authentication` 包含解密后的认证参数，因此 `READ_TOKEN` 本身属于敏感凭据；`ADMIN_TOKEN` 也具有读取权限。

## 节点订阅 API

```http
GET /v1/subscription?siteId=site-home
Authorization: Bearer <READ_TOKEN>
```

返回 `text/plain` 格式的标准 Base64；解码后的内容为每行一个节点 URI。接口只接受 `READ_TOKEN`，并仅输出在线 Agent 上状态为 `healthy`、端点和认证信息完整的受支持节点。当前支持 Shadowsocks、VLESS Reality、VMess WebSocket、Hysteria 2、TUIC 和 AnyTLS Reality。Agent 上报通配监听地址时，Worker 使用 Cloudflare 看到的 Agent 公网 IP 作为订阅地址。Reality 只上报公钥、SNI 和 short-id，私钥不会离开节点。`siteId` 可选，省略时返回全部站点，最多读取 1000 条 inbound。

## 管理控制台

Worker Static Assets 在 `/` 提供管理控制台，`/v1/*` 和 `/healthz` 仍优先进入 Worker 脚本。控制台接受管理或只读 token，并仅存入当前标签页的 `sessionStorage`；管理 token 可创建站点和注册码，也可永久删除节点或站点，只读 token 只能查看在线隧道。生成注册码后，控制台会按当前 Worker 地址和站点生成可复制的一键部署命令，默认使用目标主机名作为节点名并创建 Shadowsocks inbound。删除正在运行的节点前应先在节点上停止或卸载 Agent，否则它会持续收到未授权响应且无法自动重新注册。
