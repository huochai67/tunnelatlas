# 安全模型

- 所有非 localhost 通信必须使用 HTTPS。
- Agent 每台设备使用独立 Ed25519 密钥；D1 只存公钥。
- 身份文件在 Unix 上以 `0600` 创建，并通过临时文件原子替换。
- 一次性注册码默认 10 分钟过期，数据库不保存明文。
- 签名覆盖方法、路径、时间、序列号和请求体摘要。
- 单调 sequence 同时用于防重放和阻止乱序报告覆盖新状态。
- 管理与发现使用不同 bearer token，通过 Worker Secret 配置。

## 期望状态与凭据安全边界

1. **凭据仅存在于 Agent 节点**：
   - 协议密码、UUID、Reality 私钥与 TLS 自签名私钥全由 Agent 本地生成，持久化在本地 `0600` 的 `secrets.json` 与证书目录中。
   - Worker 期望配置（`tunnel_configs` 表与 `desiredConfig` 网络传输）绝不包含密码、UUID、Reality 私钥或证书文件，仅下发协议元数据及代数计数器 `credentialGeneration`。
2. **上报白名单与凭据隔离**：
   - Agent 仅上报建立客户端连接所需的公共认证参数（Shadowsocks 密码、Hysteria2/TUIC 密码与 UUID、VMess UUID、Reality 公钥与 ShortId）。Reality 私钥、TLS 私钥及 sing-box 完整配置严禁上报。
   - Worker 使用 Secret `CREDENTIALS_KEY` 通过 AES-256-GCM 加密认证对象后写入 D1，并将 Node ID 与 inbound ID 作为附加认证数据（AAD），防止密文被换绑。
   - `READ_TOKEN` 和 `ADMIN_TOKEN` 都能读取解密后的认证参数，应按敏感凭据保护；管理控制台当前不会显示认证参数。
3. **错误隔离与防泄露**：
   - 当 sing-box 校验失败、启动失败或本地文件操作失败时，详细错误（包括 stderr、文件路径或包含凭据的配置内容）仅打印在本地日志中。
   - 向 Worker 上报的 `configApplyError` 严格限定为枚举错误码（`invalid_desired_config`、`sing_box_validation_failed`、`sing_box_start_failed`、`local_apply_failed`），杜绝本地错误堆栈或敏感信息泄露至 D1。
4. **事务收敛与原子回滚**：
   - 配置应用前，Agent 独占获取 `control.lock`，快照备份托管 JSON、`secrets.json`、证书目录、YAML 与运行状态。
   - 只有在 sing-box 校验、格式化、启动以及 500 ms 探查均成功后才持久化新凭据。任何环节失败立即恢复全套快照并重启先前工作的配置。

## Cloudflare 前端安全

- Cloudflare 前端的 Flexible SSL 模式下，Cloudflare 到源站的 WebSocket 连接不加密（源站看到的是明文 WS）。建议源站防火墙只允许 Cloudflare IP 段（https://www.cloudflare.com/ips/）访问该端口，并知晓直连源站仍是绕过前端的路径；不要把 Flexible 模式当作传输加密替代品，它只解决边缘证书与 CDN 接入。源站隧道认证（VMess UUID）不变，WAF 规则继续生效。
