# GitHub 与 Cloudflare 自动部署

生产部署使用 Cloudflare Workers Builds 原生 GitHub 集成。GitHub Actions 只负责检查，不持有 Cloudflare 凭据；Cloudflare 在 `main` 更新后从仓库拉取、构建并部署。

## 1. 创建生产资源

登录 Wrangler 后创建 D1：

```bash
cd worker
pnpm exec wrangler d1 create tunnelatlas
```

将返回的 `database_id` 写入 `worker/wrangler.jsonc` 并提交。D1 ID 不是密钥，可以进入 Git。Worker 名称保持为配置中的 `tunnelatlas-api`。

首次应用 migration：

```bash
pnpm db:migrate:remote
```

`0003_merge_sites_and_agents_into_nodes.sql` 是破坏性 migration，会清空旧站点、Agent、注册码和隧道数据。升级到单一节点模型时，必须先在发布分支的目标提交上推送 `v0.0.9` 标签并等待 Release 制品完成，再备份 D1，最后才将同一提交合入 `main` 触发 Worker migration 和部署。旧节点需要从控制台重新创建和部署。

## 2. 配置运行时 Secret

在 Cloudflare Dashboard 的 Worker 设置中创建四个加密变量：

- `ADMIN_TOKEN`：管理控制台、节点和注册码管理权限；
- `READ_TOKEN`：只读隧道发现权限；
- `ENROLLMENT_PEPPER`：注册码摘要的服务端 pepper；
- `CREDENTIALS_KEY`：加密 inbound 认证参数的 32 字节 AES 密钥。

四者都应使用独立的高熵随机值。它们是运行时 Secret，不是 Workers Builds 的构建变量，也不能提交到 GitHub。
`worker/wrangler.jsonc` 已启用 `keep_vars`，因此自动部署会保留 Dashboard 中配置的普通变量；Cloudflare 的加密 Secret 本身也不会被常规 `wrangler deploy` 删除。敏感值仍必须选择 **Secret** 类型，不能作为明文变量保存。

可以使用 OpenSSL 分别生成四个 256-bit、URL-safe 的随机值：

```bash
ADMIN_TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
READ_TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
ENROLLMENT_PEPPER="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
CREDENTIALS_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
```

检查变量已经生成，但不要打印具体值或把它们写入构建日志：

```bash
printf 'ADMIN_TOKEN: %s characters\n' "${#ADMIN_TOKEN}"
printf 'READ_TOKEN: %s characters\n' "${#READ_TOKEN}"
printf 'ENROLLMENT_PEPPER: %s characters\n' "${#ENROLLMENT_PEPPER}"
printf 'CREDENTIALS_KEY: %s characters\n' "${#CREDENTIALS_KEY}"
```

通过 Wrangler 写入 Worker Secret。以下命令从标准输入读取值，不会把 Secret 放进命令行参数：

```bash
printf '%s' "$ADMIN_TOKEN" | pnpm exec wrangler secret put ADMIN_TOKEN
printf '%s' "$READ_TOKEN" | pnpm exec wrangler secret put READ_TOKEN
printf '%s' "$ENROLLMENT_PEPPER" | pnpm exec wrangler secret put ENROLLMENT_PEPPER
printf '%s' "$CREDENTIALS_KEY" | pnpm exec wrangler secret put CREDENTIALS_KEY
```

写入完成后清除当前 Shell 中的变量：

```bash
unset ADMIN_TOKEN READ_TOKEN ENROLLMENT_PEPPER CREDENTIALS_KEY
```

## 3. 连接 GitHub

在 Cloudflare Dashboard 创建或打开名为 `tunnelatlas-api` 的 Worker，然后进入 **Settings → Builds** 连接 GitHub 仓库：

| 设置 | 值 |
|---|---|
| Production branch | `main` |
| Root directory | `worker` |
| Build command | `pnpm run verify` |
| Deploy command | `pnpm deploy:production` |
| Build cache | Enabled |

`deploy:production` 会先应用尚未执行的 D1 migration，再部署 Worker 和控制台静态资源。为此，Workers Builds 使用的自定义用户 API Token 必须至少拥有该账户的 Workers Scripts Edit 和 D1 Edit 权限。

暂时关闭 non-production branch builds。默认的预览版本会绑定生产 D1；创建独立 preview D1 并配置 `preview_database_id` 后，再启用 `pnpm exec wrangler versions upload`。

## 4. GitHub 分支保护

在 GitHub 为 `main` 启用分支保护并要求以下检查通过：

- `Rust agent`
- `Cloudflare Worker`

推荐只允许通过 Pull Request 合并。合并后，Cloudflare 收到 `main` push 并自动发布；构建状态会回写到 GitHub。

## 5. Migration 约束

自动部署先迁移数据库、后发布代码，因此 migration 必须向后兼容当前线上版本。优先使用新增表、字段和索引；删除或重命名字段应拆成多个版本完成。

## 6. 可选：VMess-WS 隧道的 Cloudflare 前端

Worker 可以为单个 VMess-WS 隧道开通 Cloudflare 前端：生成 `ta-<20位hex>.<zone>` 主机名、创建代理 DNS 记录、启用 WebSockets，并安装精确主机名的 Flexible SSL 配置规则与精确主机名+路径的目标端口改写 Origin 规则。Worker 本身仍然不转发 VMess 字节，流量经 Cloudflare 边缘 TLS 后回源到原直连端点。

### 6.1 前置条件

- 一个处于 **active** 状态、由当前账户拥有的 Cloudflare Zone；`CLOUDFLARE_ZONE_NAME` 填写 zone 顶点（如 `example.com`，不带 `www.` 和尾点）。只使用第一级主机名，确保 Universal SSL 可以签发证书；`ta-` 前缀为 TunnelAtlas 保留，请勿手动占用。
- 一个**仅限该 zone** 的 API Token，作为 Secret `CLOUDFLARE_API_TOKEN`。最小权限：

| 权限 | 作用 |
|---|---|
| Zone → Zone → Read | 解析 zone ID |
| Zone → DNS → Edit | 创建/更新/删除 `ta-` 代理记录 |
| Zone → Zone Settings → Edit | 启用 WebSockets |
| Zone → Config Rules → Edit | Flexible SSL 配置规则 |
| Zone → Origin Rules → Edit | 目标端口改写规则 |

不要把账户级 Token 交给 Worker。两个变量都不存在或 token 权限不足时，启用操作返回 503/502，错误显示在对应隧道的状态中，不影响 Agent 心跳。

### 6.2 配置与迁移顺序

在 Cloudflare Dashboard 的 Worker 设置中创建 Secret `CLOUDFLARE_API_TOKEN` 与普通变量 `CLOUDFLARE_ZONE_NAME`（`keep_vars` 已启用，自动部署会保留变量）。`0004_tunnel_cloudflare_frontends.sql` 是纯增量 migration，随 `deploy:production` 自动应用，无需手工步骤。

### 6.3 规则配额

Free 计划每个 zone 各 10 条 Config Rules 和 10 条 Origin Rules，每个已启用隧道各消耗 1 条。配额错误会以 `error` 状态保留在隧道记录中，需要先停用其他隧道或升级计划后由管理员重试。

### 6.4 证书传播与冒烟测试

DNS 与 SSL 证书传播通常需要几十秒到几分钟。生产冒烟测试：

1. 在控制台对 VMess-WS 隧道点击「启用 Cloudflare」，等待状态变为「已启用」。
2. 解码 `/v1/subscription`，确认 `add`/`sni`/`host` 为生成的 `ta-` 主机名、`port=443`、`tls=tls`、路径和 UUID 不变。
3. 对 `https://<生成主机名><路径>` 发起 HTTP/1.1 WebSocket Upgrade，应返回 `101 Switching Protocols`；同时确认 sing-box 只监听原始端口。
4. 点击「停用」，确认代理 DNS 与两条规则删除后，D1 跟踪记录才消失。

故障排查使用 Cloudflare Trace（`https://<主机名>/cdn-cgi/trace`）定位 403/5xx；WAF 拦截不会被绕过，VMess 认证强度不变。
