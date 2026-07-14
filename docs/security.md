# 安全模型

- 所有非 localhost 通信必须使用 HTTPS。
- Agent 每台设备使用独立 Ed25519 密钥；D1 只存公钥。
- 身份文件在 Unix 上以 `0600` 创建，并通过临时文件原子替换。
- 一次性注册码默认 10 分钟过期，数据库不保存明文。
- 签名覆盖方法、路径、时间、序列号和请求体摘要。
- 单调 sequence 同时用于防重放和阻止乱序报告覆盖新状态。
- 管理与发现使用不同 bearer token，通过 Worker Secret 配置。
- Agent 只从 sing-box 配置提取 tag、type、方向和 endpoint，不上报用户、密码、UUID、密钥或完整配置。
- 候选和托管 sing-box 配置以 `0600` 写入；源配置应由管理员同样限制权限。
- API 对请求体大小、隧道数量、字符串长度和状态枚举设限。

当前限制：`tunnelatlasd` 仍以 root 运行以支持 TUN 等 sing-box 能力；身份文件尚未接入 TPM/系统 keyring；管理员 token 暂无 RBAC；Agent 撤销 API尚未实现；D1 中的 endpoint 和 metadata 是明文。生产公开部署前必须补齐权限降级、撤销、审计、速率限制和密钥轮换。
