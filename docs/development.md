# 本地开发

## Worker

```bash
cd worker
pnpm install
pnpm db:migrate:local
pnpm dev -- --var ADMIN_TOKEN:dev-admin \
  --var READ_TOKEN:dev-read \
  --var ENROLLMENT_PEPPER:dev-pepper \
  --var CREDENTIALS_KEY:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

启动后访问 `http://127.0.0.1:8787/` 打开管理控制台，输入 `dev-admin` 获得管理能力，或输入 `dev-read` 进入只读模式。

创建节点时会同时返回注册码：

```bash
curl -X POST http://127.0.0.1:8787/v1/admin/nodes \
  -H 'Authorization: Bearer dev-admin' \
  -H 'Content-Type: application/json' \
  --data '{"name":"Home"}'
```

待接入节点的注册码过期后，可使用创建响应中的节点 ID 重新生成：

```bash
curl -X POST http://127.0.0.1:8787/v1/admin/nodes/node_xxx/enrollment-tokens \
  -H 'Authorization: Bearer dev-admin'
```

生产部署前创建 D1 数据库，替换 `worker/wrangler.jsonc` 中的 `database_id`，并用 `wrangler secret put` 分别配置 `ADMIN_TOKEN`、`READ_TOKEN`、`ENROLLMENT_PEPPER` 和 `CREDENTIALS_KEY`。开发示例中的固定密钥只能用于本地测试。
## Agent

安装 sing-box，复制并调整 `agent/config.example.yaml`，填入注册码后运行。在启动 Agent 前，可在 Worker 控制台（或通过 API）为该节点创建期望隧道。Agent 会从 Worker 自动拉取期望配置，并在本地生成 secrets、证书与 sing-box 托管配置：

```bash
cargo run -p tunnelatlasd -- \
  --config agent/config.example.yaml \
  --identity /tmp/tunnelatlas-identity.json check

cargo run -p tunnelatlasd -- \
  --config agent/config.example.yaml \
  --identity /tmp/tunnelatlas-identity.json enroll

cargo run -p tunnelatlasd -- \
  --config agent/config.example.yaml \
  --identity /tmp/tunnelatlas-identity.json report-once
```

注册成功后应从配置文件删除一次性 `enrollmentToken`。服务模式使用 `run` 子命令；参考 `deploy/tunnelatlas.service`。不要同时运行发行版自带的 `sing-box.service`，否则两个 supervisor 会争用端口。

## 升级与发布顺序

从本地 authoring 模型升级到 Worker 托管模型时：
1. 先部署加法 Worker（包含 migration 0007）。
2. 在控制台为各节点手动创建期望隧道定义。
3. 升级 Agent：Agent 自动拉取期望配置，收敛成功后清除旧本地配置中的 `protocols` 与 `publicHost`。升级期望列表为空的 Agent 会停止本地旧隧道。
## 验证

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd worker
pnpm check
pnpm test
```
