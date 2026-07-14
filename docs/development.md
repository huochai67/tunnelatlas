# 本地开发

## Worker

```bash
cd worker
pnpm install
pnpm db:migrate:local
pnpm dev -- --var ADMIN_TOKEN:dev-admin \
  --var READ_TOKEN:dev-read \
  --var ENROLLMENT_PEPPER:dev-pepper
```

启动后访问 `http://127.0.0.1:8787/` 打开管理控制台，输入 `dev-admin` 获得管理能力，或输入 `dev-read` 进入只读模式。

创建站点和注册码：

```bash
curl -X POST http://127.0.0.1:8787/v1/admin/sites \
  -H 'Authorization: Bearer dev-admin' \
  -H 'Content-Type: application/json' \
  --data '{"id":"site-home","name":"Home"}'

curl -X POST http://127.0.0.1:8787/v1/admin/sites/site-home/enrollment-tokens \
  -H 'Authorization: Bearer dev-admin'
```

生产部署前创建 D1 数据库，替换 `worker/wrangler.jsonc` 中的 `database_id`，并用 `wrangler secret put` 分别配置 `ADMIN_TOKEN`、`READ_TOKEN` 和 `ENROLLMENT_PEPPER`。

## Agent

安装 sing-box，复制 `agent/config.example.yaml` 和 `agent/sing-box.example.json` 到配置中指定的位置，填入注册码后运行：

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

`check` 同时执行 `sing-box check -c`。注册成功后应从配置文件删除一次性 `enrollmentToken`。服务模式使用 `run` 子命令；参考 `deploy/tunnelatlas.service`。不要同时运行发行版自带的 `sing-box.service`，否则两个 supervisor 会争用端口和 TUN 设备。

## 验证

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd worker
pnpm check
pnpm test
```
