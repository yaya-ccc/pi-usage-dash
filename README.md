# pi-usage-dash

[Pi](https://github.com/earendil-works/pi-coding-agent) 的用量仪表盘扩展：`/usage` 一次查询所有已配置 provider 的账户用量，状态栏常驻剩余配额。

## 特性

- **聚合查询**：基于 [`@narumitw/pi-usage`](https://www.npmjs.com/package/@narumitw/pi-usage) 引擎（固定 `0.61.2`）拉取全部已登录 provider 的额度与用量；内置源 60s 内走缓存，单源 15s 超时不拖垮整体
- **omp 风格仪表盘**：`/usage` 全屏面板按 provider 分栏，进度条 + 剩余比例 + 重置时间，余额型显示剩余金额
- **状态栏剩余配额**：跟随活跃 provider 显示 `77%·5h 96%·7d`（≥50% 绿 / ≥20% 黄 / 其余红，余额型显示单币种余额）。窗口引擎按桶的 `windowMinutes` 免配置识别（300→5h、10080→7d，存量 `five-hour`/`weekly` 桶 ID 兜底），codex 的 `codex:primary/secondary`、zai 系窗口等均自动点亮；每 5 分钟 + 每轮任务自动刷新，连续 3 次失败自动清空
- **额外用量源**：`usage-dash.json` 声明 pi-usage 内置列表之外的 provider，复用内置 adapter 的查询逻辑，凭据与端点各取所需
- **状态栏展示覆盖**：`usage-dash.json` 的 `status` 段可按 provider 覆盖窗口序列、段数上限、窗口标签与余额兑底；新 provider 多数情况零配置

## 安装

```bash
pi install git:github.com/yaya-ccc/pi-usage-dash@v0.2.1
```

> 若同时以 pi 包形式安装了 `@narumitw/pi-usage` 本体，请禁用其扩展入口避免 `/usage` 命令冲突（本扩展只将它用作查询引擎库）：
>
> ```json
> { "source": "npm:@narumitw/pi-usage@0.61.2", "extensions": ["-dist/index.ts"] }
> ```

状态栏经 `ctx.ui.setStatus("usage", …)` 发布，由 starline 等主题的 `extensionStatuses` 拾取（需配 `colorMode: "original"` 保留着色）。

## 前置要求

- Node.js（pi 自带运行时即可）
- 至少一个已 `/login` 的 provider

## 用法

```
/usage           查询全部（内置源 60s 内走缓存；额外源实时查询）
/usage refresh   强制刷新全部
/fast            切换 Codex Fast 模式（priority 计费，约快 1.5×，额度消耗更多）
```

### Codex Fast 模式

- `/fast` 对活跃的 OpenAI Codex 模型切换 Fast（`service_tier: priority`），偏好持久化在 `~/.pi/agent/pi-usage.json` 的 `codexFastMode`（与 @narumitw/pi-usage 兼容）。
- 生效时状态栏显示 `fast 83%·5h 44%·7d`（标注与用量间保留空格）；fast 响应的 token 成本按 2（gpt-5.5 为 2.5）倍校正。
- 支持模型：gpt-5.5 / gpt-5.6-luna / 5.6-sol / 5.6-terra / 6-sol，且 baseUrl 为官方 chatgpt.com。另外本地补充 gpt-6.1-sol（服务端已验证接受 priority 档，库 allowlist 未收录），成本按 2 倍估算。
- 相比上游额外支持 pi-codex-accounts 克隆的 `openai-codex-<label>` 账号（其请求在线上本就以 openai-codex 名义发出）。

## 配置文件

**`<agent-dir>/usage-dash.json`**（默认 `~/.pi/agent/usage-dash.json`，可用 `PI_CODING_AGENT_DIR` 覆盖）v0.2 起为对象 schema，含 `sources`（额外用量源）与 `status`（状态栏覆盖）两段：

```json
{
	"sources": [
		{
			"id": "zcode",
			"displayName": "ZCode · 智谱",
			"reuseAdapter": "zai-coding-cn",
			"baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4"
		}
	],
	"status": {
		"default": { "windows": [300, 10080], "maxSpans": 2 },
		"providers": {
			"kimi-coding": { "windows": [300, 10080, 43200], "tags": { "43200": "mo" } }
		}
	}
}
```

> v0.1.x 的顶层数组 schema 已废弃：把原数组包进 `{"sources": …}` 即完成迁移。

### 额外用量源（sources）

pi-usage 内置列表之外的 provider（自定义 provider 扩展注册的，如 [pi-zcode](https://github.com/yaya-ccc/pi-zcode) 的 `zcode`）通过 `sources` 声明：

| 字段 | 说明 |
|---|---|
| `id` | provider id。凭据按此 id 从 pi 凭据仓读取，provider 需已注册并登录；面板 / 缓存 / 状态栏的去重键 |
| `displayName` | 可选，面板标题与排序名，缺省用 `id` |
| `reuseAdapter` | 借用哪个 pi-usage 内置 adapter 的查询函数（端点路径 + Bearer 组装 + 响应归一化全部复用，一行不重写）。必须是 `usageAdapters()` 里存在的 id |
| `baseUrl` | 可选。配额端点的 API 根。**省略时回退 provider 自身配置的 baseUrl**（直连官方源的 provider 可省）；provider 配了代理的**必须显式写**，否则查询会打到代理上报错 |

语义：**查询逻辑 = 内置 adapter 的（借来），凭据 = pi 凭据仓的（按 id 取），端点 = 你钉的**。一条 = 一个 provider id = 一份凭据；同一 API 想看多个账号，注册多个 provider id、各写一条。

行为约定：

- 配置文件缺失 = 仅内置源、状态栏走引擎默认；未注册 / 未登录的条目静默跳过（不显示面板）
- schema 非法、`reuseAdapter` 不存在、两级 baseUrl 都解析不到 → 该条跳过 + `/usage` 面板顶部黄字警告（第几条、什么错），不影响其余查询
- 新 provider 的用量 API 与所有内置 adapter 都不同构时，配置表达不了：给本包加真适配器实现，或向上游 pi-usage 提 PR（成了之后 `reuseAdapter` 指过去即可）

### 状态栏覆盖（status）

窗口引擎免配置：桶带 `windowMinutes`（pi-usage 归一化后的窗口桶普遍携带）即自动识别，标签自动生成（<1 天按小时 `5h`，≥1 天按天 `1d`/`7d`/`30d`）；无窗口桶时回退货币余额（DeepSeek 等）。`status` 段只做例外覆盖，未配置的 provider 全走引擎默认（优先 5h + 7d，最多两段）：

| 字段 | 说明 |
|---|---|
| `default` | 全局默认覆盖，作用于所有 provider |
| `providers` | 按 provider id 索引的覆盖，同名字段优先于 `default` |

单个覆盖对象的可选字段：

| 字段 | 说明 |
|---|---|
| `windows` | 窗口分钟数序列（如 `[300, 10080, 43200]`），按序展示；桶优先按 `windowMinutes` 匹配，`five-hour`/`weekly` 桶 ID 兜底 |
| `maxSpans` | 状态栏最多展示几段窗口（默认 2） |
| `tags` | 「分钟数字符串 → 标签」映射，覆盖自动生成的标签（如 `{"43200": "mo"}`） |
| `balanceFallback` | 无窗口时是否回退货币余额（默认 `true`，置 `false` 则清空） |

非法字段降级为 `/usage` 面板黄字警告并忽略，不影响其余配置。

## 开发

```bash
git clone git@github.com:yaya-ccc/pi-usage-dash.git
cd pi-usage-dash
npm ci
npm run check          # TypeScript 检查 + 回归测试
npm pack --dry-run     # 检查发布文件
```

入口在 `extensions/usage-dash.ts`，内部模块放 `lib/`（避免被 pi 当作独立扩展扫描），安装时需完整保留两个目录，无需编译。

| 文件 | 职责 |
|---|---|
| `extensions/usage-dash.ts` | 命令注册、交互面板和生命周期事件 |
| `lib/types.ts` | 报告、查询结果和状态栏的共享类型 |
| `lib/config.ts` | 配置文件读取校验（额外源 + 状态栏覆盖）及 baseUrl 解析 |
| `lib/query.ts` | 内置源和额外源查询、缓存、并发及凭据校验 |
| `lib/format.ts` | 数值、时长、进度条及文本宽度格式化 |
| `lib/status.ts` | 状态栏内容、定时刷新及失败降级 |
| `lib/render.ts` | 仪表盘面板与整屏文本 |
| `tests/` | 模拟 pi / 查询引擎的回归测试及原版输出快照 |

测试使用 Node 内置测试运行器和 VM 模块，不增加运行时依赖，不读取真实账号、不请求用量 API；运行时的 VM Modules 实验性提示属正常现象。覆盖缓存边界、强制刷新、并发、排序、端点回退、配置警告、错误脱敏、状态栏降级，以及会话替换 / 重载时的查询取消、失效 ctx 和迟到结果。

### 查询引擎升级检查

`@narumitw/pi-usage` 固定为 `0.61.2`。升级前核对 `@narumitw/pi-usage/dist/index.ts` 中以下导出及其调用参数，再跑回归测试并用实际账号验证：`usageAdapters`、`providerIsConfigured`、`resolveUsageAuth`、`queryProviderUsage`、`redactUsageError`、`abortError`、`isStaleExtensionContextError`。

## v0.2.1 Codex Fast 与状态栏间距修复

- 修复 Fast 标记与配额数字黏连，保持各片段独立着色。
- 关闭 Fast 或无配额数据时不留多余空格。
- 新增纯文本与空数据回归测试，发布包含此前的 `/fast` 功能与标签账号支持。

## v0.2.0 状态栏通用窗口引擎

- 状态栏不再按桶 ID 白名单（`five-hour`/`weekly`）选桶，改为按 `windowMinutes` 免配置识别窗口，存量 ID 兜底：openai-codex（`codex:primary/secondary`）、zai 系（zcode 等额外源）等原先查得到却显示不出的窗口自动点亮。
- 窗口标签自动生成（`5h`/`1d`/`7d`/`30d`），`status.tags` 可按分钟数覆盖。
- `usage-dash.json` 升级为对象 schema `{sources, status}`，新增 `status.default` / `status.providers.<id>` 两层覆盖：窗口序列 `windows`、段数上限 `maxSpans`、标签 `tags`、余额兑底开关 `balanceFallback`。**不再接受 v0.1.x 顶层数组**（迁移：数组包进 `{"sources": …}`）。

## v0.1.3 修复

- 修复会话替换或 `/reload` 后，后台刷新在失败降级路径访问旧 `ctx.ui` 导致 Pi 崩溃。
- 会话结束时中止所有未完成查询（含 `/usage`），取消后不再校验旧上下文或写入缓存。
- 定时器跟随最新事件上下文；忽略过期刷新结果，并重置跨会话的状态历史。
- 主题 getter 和错误通知失败安全降级；保留既有配额展示、缓存和连续失败清空行为。

## License

[MIT](./LICENSE)
