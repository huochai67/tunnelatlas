# 通信协议

## 管理 API

管理 API 使用 `Authorization: Bearer <ADMIN_TOKEN>`：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/admin/sites` | 创建站点 |
| POST | `/v1/admin/sites/{siteId}/enrollment-tokens` | 创建一次性注册码 |
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

报告是从 sing-box `inbounds`、`outbounds` 和 `endpoints` 脱敏提取的完整快照，最多包含 64 条隧道，最大 256 KiB。所有字段在写 D1 前校验。

## 发现 API

```http
GET /v1/tunnels?siteId=site-home
Authorization: Bearer <READ_TOKEN>
```

返回仍在线且未撤销 Agent 的隧道，最多 1000 条。`ADMIN_TOKEN` 也具有读取权限。

## 管理控制台

Worker Static Assets 在 `/` 提供管理控制台，`/v1/*` 和 `/healthz` 仍优先进入 Worker 脚本。控制台接受管理或只读 token，并仅存入当前标签页的 `sessionStorage`；管理 token 可创建站点和注册码，只读 token 只能查看在线隧道。
