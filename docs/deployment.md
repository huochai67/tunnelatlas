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

## 2. 配置运行时 Secret

在 Cloudflare Dashboard 的 Worker 设置中创建三个加密变量：

- `ADMIN_TOKEN`：管理控制台、站点和注册码管理权限；
- `READ_TOKEN`：只读隧道发现权限；
- `ENROLLMENT_PEPPER`：注册码摘要的服务端 pepper。

三者都应使用独立的高熵随机值。它们是运行时 Secret，不是 Workers Builds 的构建变量，也不能提交到 GitHub。

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
