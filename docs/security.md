# 安全模型

- 所有非 localhost 通信必须使用 HTTPS。
- Agent 每台设备使用独立 Ed25519 密钥；D1 只存公钥。
- 身份文件在 Unix 上以 `0600` 创建，并通过临时文件原子替换。
- 一次性注册码默认 10 分钟过期，数据库不保存明文。
- 签名覆盖方法、路径、时间、序列号和请求体摘要。
- 单调 sequence 同时用于防重放和阻止乱序报告覆盖新状态。
- 管理与发现使用不同 bearer token，通过 Worker Secret 配置。

## 期望状态与凭据安全边界

1. **协议身份由 Worker 生成并加密存储**：
   - 创建/轮换隧道时 Worker 生成密码、UUID、Reality 密钥对，密文写入 `tunnel_configs.credentials_ciphertext`。AAD 为 `creds:${nodeId}:${tunnelId}`，防止换绑。
   - `desiredConfig` 只把该节点自己的 inbound 密钥发给该 Agent，外加它作为入口所需的 hop **客户端**参数（SS 密码、UUID、Reality 公钥与 ShortId）。Reality/TLS 私钥不会发给其他节点。
   - Hysteria2/TUIC 自签名证书仍由 Agent 本地签发，证书私钥不出节点、不进 D1。
2. **上报白名单与凭据隔离**：
   - Agent 仍可上报建立客户端连接所需的公共认证参数，供混合版本订阅回落。Reality 私钥、TLS 私钥及完整 sing-box 配置严禁上报。
   - 观测行继续用 `CREDENTIALS_KEY` 加密，AAD 为 `${nodeId}:${id}`，与托管凭据上下文错开。
   - `READ_TOKEN` 和 `ADMIN_TOKEN` 都能读取解密后的客户端认证参数，应按敏感凭据保护；管理控制台不展示密钥。
3. **错误隔离与防泄露**：
   - 当 sing-box 校验失败、启动失败或本地文件操作失败时，详细错误（包括 stderr、文件路径或包含凭据的配置内容）仅打印在本地日志中。
   - 向 Worker 上报的 `configApplyError` 严格限定为枚举错误码（`invalid_desired_config`、`sing_box_validation_failed`、`sing_box_start_failed`、`local_apply_failed`），杜绝本地错误堆栈或敏感信息泄露至 D1。
4. **事务收敛与原子回滚**：
   - 配置应用前，Agent 独占获取 `control.lock`，快照备份托管 JSON、`secrets.json`、证书目录、YAML 与运行状态。
   - 只有在 sing-box 校验、格式化、启动以及 500 ms 探查均成功后才持久化新凭据。任何环节失败立即恢复全套快照并重启先前工作的配置。

## Cloudflare 前端安全

- Cloudflare 前端的 Flexible SSL 模式下，Cloudflare 到源站的 WebSocket 连接不加密（源站看到的是明文 WS）。建议源站防火墙只允许 Cloudflare IP 段（https://www.cloudflare.com/ips/）访问该端口，并知晓直连源站仍是绕过前端的路径；不要把 Flexible 模式当作传输加密替代品，它只解决边缘证书与 CDN 接入。源站隧道认证（VMess UUID）不变，WAF 规则继续生效。
