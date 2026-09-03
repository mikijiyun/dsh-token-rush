# dsh-token-rush

> 一个挂在 DeepSeek Harness（DSH）Web GUI 会话页左上角的 token 告急小窗。
> 实时告诉你：这一局烧了多少 token、大概多少钱、账户还剩多少。高峰时段，它会自动变成橙红色——因为那是官方 2 倍价的时间。

[中文](README.md) | [English](README.en.md)

---

## 为什么需要它

作为一个贫穷的 API 使用者，你是否也有像我一样的 token 焦虑？

每次让 AI 干活，都忍不住切到后台看一眼这轮烧了多少 token；等账单出来才发现，明明聊得很爽，钱包却已经瘦了两斤。更惨的是：白天 9 点到 12 点、下午 14 点到 18 点（北京时间），DeepSeek 的高峰时段单价是平时的 **2 倍**——你以为是闲聊，实际上是双倍扣费。

**dsh-token-rush** 把答案钉在会话页左上角：一个永远跟着你走的小窗口，实时显示当前会话累计消耗的 token、按官方单价估算的金额、以及账户余额；每到高峰时段，窗口整体变橙红色，等于在你耳边喊了一句：

> "现在用 AI，是两倍价格，悠着点。"

![会话仪表窗口实物图（空闲时段 · 随主题色）](docs/window.png)

*上图：会话进行中的实际效果 —— 左上角悬浮窗，实时显示总 Token（进/出）、估算消耗与账户余额；当前为空闲时段，窗口颜色跟随 DSH 主题；高峰时段整体变橙红色。*

## 功能

| 能力 | 说明 |
| --- | --- |
| 🎯 左上角悬浮窗 | 帧级 overlay 层的小窗口（约 216px 宽），不遮挡主要信息；默认位置 (12, 56) |
| 📊 实时统计 | 当前会话累计总 token（输入/输出/缓存分桶），来自 DSH `tokenUsage` 投影（订阅推送，非轮询） |
| 💰 消耗金额 | token × DeepSeek 官方单价表（按模型、按高峰/非高峰价）估算，界面标注 ≈ |
| 🧾 账户余额 | host 侧代理 DeepSeek `GET /user/balance`，60s 缓存；复用「设置 → 模型」里的 API Key，Key 不出服务端 |
| 🚦 高峰变色 | 每次启动 DSH 服务时自动检查当前时间；高峰时段（默认北京时间周一至周五 09:00–12:00、14:00–18:00）窗口整体变橙红色，否则跟随当前 DSH 主题（亮/暗自动匹配） |
| 👻 透明度渐变 | 未开启对话时 0% 透明度且不拦截鼠标；开始对话后 0.8s 平滑渐变为半透明 |
| 🖱️ 随意拖动 | 按住窗口任意处拖动，位置自动记忆（localStorage）；双击复位默认位置 |

## 安装

### 从本目录安装（开发 / 本地使用）

```powershell
dsh plugin --profile web add link:E:\万物暂存\AI缓存工作区\dsh-token-rush
```

重启 `dsh web` 进程（仅刷新页面不生效），左侧上方即出现悬浮窗。验证挂载：

```powershell
dsh --profile web --dump-config | Select-String token-rush   # 应看到 - id: token-rush
```

### 卸载

```powershell
dsh plugin --profile web remove dsh-token-rush
```

重启 `dsh web` 后窗口消失。

## 配置（环境变量，读取于 `dsh web` 启动环境）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DSH_HUD_PEAK_WINDOWS` | 高峰时间段，如 `"9-12,14-18"`、`"8-10 20-23"`（半开区间 [start, end)） | `9-12,14-18` |
| `DSH_HUD_PEAK_TZ` | 高峰判断时区（IANA 名称） | `Asia/Shanghai` |
| `DEEPSEEK_BASE_URL` | DeepSeek API 地址覆盖（同官方 llm-deepseek 约定） | `https://api.deepseek.com` |

余额查询复用「设置 → 模型」中 DeepSeek 提供商的 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）/`baseURL` 配置；未配置 Key 时余额行显示「未配置 Key」。

## 数据口径

| 项目 | 来源 | 说明 |
| --- | --- | --- |
| 总 Token | DSH 会话 `tokenUsage` 投影（`uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`） | host 按会话日志维护的 provider 上报总值，实时推送 |
| 消耗金额（估算 ≈） | Token × 官方单价表 | 价格按模型匹配（deepseek-v4-flash / pro / …，未知模型回退 flash 价），高峰价 = 非高峰 ×2；价格表见 `lib/index.js` 的 `PRICES` |
| 账户余额 | DeepSeek `/user/balance` | host 缓存 60s，浏览器每分钟拉取一次 |
| 高峰判定 | 服务启动时检查 + 每分钟复查 | 每次 DSH 启动记录一次判定日志；浏览器与 host 同一窗口定义（默认北京时间） |

## 已知限制

- 消耗金额为**估算值**：token 总量来自 provider 上报；价格按当前模型全量计（会话中途切换模型时以最后一条消息的模型为准）。实际扣费以 DeepSeek 账单为准。
- 余额查询仅覆盖 DeepSeek 官方 API（含自定义 `baseURL` 端点）；使用其他 LLM 供应商时余额行显示「余额不可用」。
- 高峰时段判定默认使用北京时间（与官方计费口径一致），可按需用 `DSH_HUD_PEAK_TZ` 修改。

## 开发

纯手写 JS，**无构建步骤**：

```text
dsh-token-rush/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 插件行：- insert - id: token-rush
├── lib/
│   ├── index.js          # host 半区：启动时段检查 + /api/token-rush/* 路由
│   └── client.js         # 浏览器半区：悬浮窗 UI（window.__ModuleLoader__ 工厂格式）
├── dev/host-smoke.mjs    # host 半区冒烟测试
└── README.md / README.en.md
```

```powershell
node --check lib\index.js      # host 半区语法校验
node --check lib\client.js     # 浏览器半区语法校验
node dev\host-smoke.mjs        # 冒烟测试（高峰判定/计价/路由/同源拦截/余额代理）
```

> 版本控制遵循语义化版本 [SemVer](https://semver.org/lang/zh-CN/)：`主版本号.次版本号.修订号` 分别对应重大架构变更、向后兼容的功能新增、Bug 修复。

## License

[MIT](LICENSE)
