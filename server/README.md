# KBOT 托管额度与统一代理网关 (`server/`)

用于在服务端统一保管你的 `DEEPSEEK_API_KEY` 与 `DASHSCOPE_API_KEY`，向 C 端客户端提供：

- **免登录首次体验额度**：客户端首次打开携带本机 `deviceId` 调用 `POST /v1/kbot/bootstrap`，一次性领取初始体验点数（默认 `20` 点），同一设备重复请求不会重复发放。
- **点数扣减与透传代理**：
  - 对话（DeepSeek Anthropic Messages 协议）：`/v1/llm/anthropic/*`（每次 `1` 点）
  - 语音朗读（千问 `qwen3-tts-flash`）与声音复刻：`/v1/dashscope/api/v1/*`（TTS 每次 `1` 点、复刻 `2` 点）
  - 实时全双工语音（千问 `qwen3.5-omni-flash-realtime` WebSocket）：`WSS /v1/dashscope/api-ws/v1/realtime`（每次会话 `2` 点）
- **账号合并与充值兑换码**：
  - 体验额度用完时返回 `HTTP 402`，引导用户登录绑定（保留原设备余额）/ 兑换充值码 / 切换自带 API Key。
  - 管理员可通过 `POST /v1/kbot/admin/codes` 批量生成充值兑换码，或 `POST /v1/kbot/admin/grant` 直接给账号加点。

## 启动方式

可以直接在根目录创建 `.env.gateway.local`（已被 `.gitignore` 忽略）或导出环境变量：

```bash
export DEEPSEEK_API_KEY="你的 DeepSeek Key"
export DASHSCOPE_API_KEY="你的阿里云百炼 Key"
export KBOT_GATEWAY_ADMIN_TOKEN="设置一个强随机管理员密钥"
export KBOT_TRIAL_CREDITS=20
export PORT=8787
export HOST=0.0.0.0

npm run gateway
```

客户端打包默认已指向 **`https://schathub.xyz/kbot/api`**（与更新源 `https://schathub.xyz/kbot/releases` 同域名），如需覆盖可在打包前传环境变量：

```bash
export VITE_KBOT_CLOUD_URL="https://schathub.xyz/kbot/api"
npm run desktop:build
```

## `schathub.xyz` Nginx 反向代理参考

网关已内置兼容 `/kbot/api` 路径前缀（加或不加末尾 `/` 均可）：

```nginx
location /kbot/api/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

> 本地开发预览时也可以在 KBOT「设置 → 智能核心 → 高级连接设置 → 托管网关地址」临时填入 `http://127.0.0.1:8787` 测试完整体验额度与扣点流程。
