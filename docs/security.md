# 安全模型

- 所有非 localhost 通信必须使用 HTTPS。
- Agent 每台设备使用独立 Ed25519 密钥；D1 只存公钥。
- 身份文件在 Unix 上以 `0600` 创建，并通过临时文件原子替换。
- 一次性注册码默认 10 分钟过期，数据库不保存明文。
- 签名覆盖方法、路径、时间、序列号和请求体摘要。
- 单调 sequence 同时用于防重放和阻止乱序报告覆盖新状态。
- 管理与发现使用不同 bearer token，通过 Worker Secret 配置。
- Agent 从已应用声明构造 inbound 上报，并按白名单发送建立客户端连接所需的 method、password、username、UUID、flow 和 token。Reality 私钥、TLS 私钥路径和完整配置不会上报。
- Worker 使用 Secret `CREDENTIALS_KEY` 通过 AES-256-GCM 加密认证对象后写入 D1，并将 Node ID 与 inbound ID 作为附加认证数据，防止密文被换绑到其他记录。
- `READ_TOKEN` 和 `ADMIN_TOKEN` 都能读取解密后的认证参数，应按敏感凭据保护；管理控制台当前不会显示认证参数。
- `secrets.json`、候选配置、托管配置、私钥和导入证书均以 `0600` 原子写入；协议 YAML 不保存生成的凭据。
- API 对请求体大小、隧道数量、字符串长度和状态枚举设限。

节点重置会清除服务端公钥、序列和隧道，使旧 Agent 身份立即失效。当前限制：`tunnelatlasd` 仍以 root 运行以支持 TUN 等 sing-box 能力；身份文件尚未接入 TPM/系统 keyring；管理员 token 暂无 RBAC；D1 中的 endpoint 和 metadata 是明文；`CREDENTIALS_KEY` 尚无在线轮换流程，直接更换会使旧密文不可读，直到对应 Agent 再次上报。生产公开部署前必须补齐权限降级、审计、速率限制和密钥轮换。
