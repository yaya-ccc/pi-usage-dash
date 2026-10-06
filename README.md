# @yaya-ccc/pi-usage-dash

Pi 扩展：`/usage` 一次查询所有已配置 provider 的账户用量，omp 风格仪表盘渲染 + 状态栏剩余配额。

- 查询引擎：[`@narumitw/pi-usage`](https://www.npmjs.com/package/@narumitw/pi-usage)（package.json 固定版本，升级前需核对下方导出清单）
- 状态栏：通过 `ctx.ui.setStatus("usage", …)` 发布，由 starline 等主题的 `extensionStatuses` 拾取（需配 `colorMode: "original"` 保留着色）

## 安装

```bash
pi install git:github.com/yaya-ccc/pi-usage-dash@v0.1.0
```

> 注意：若你同时以 pi 包形式安装了 `@narumitw/pi-usage` 本体，请像下面这样禁用它的扩展入口，避免 `/usage` 命令冲突（本扩展只用它做查询引擎库）：
>
> ```json
> { "source": "npm:@narumitw/pi-usage@0.61.2", "extensions": ["-dist/index.ts"] }
> ```

## 用法

```
/usage           查询全部（内置源 60s 内走缓存；额外源实时查询）
/usage refresh   强制刷新全部
```

状态栏跟随活跃 provider 显示剩余配额：用量型 `42%·5h 87%·7d`（剩余比例，≥50% 绿 / ≥20% 黄 / 其余红）；余额型显示单币种余额。每 5 分钟 + 每轮任务自动刷新。

## 额外用量源配置

pi-usage 内置列表之外的 provider（自定义 provider 扩展注册的，如 [pi-zcode](https://github.com/yaya-ccc/pi-zcode) 的 `zcode`）通过配置文件声明：

**`<agent-dir>/usage-dash.json`**（默认 `~/.pi/agent/usage-dash.json`，可用 `PI_CODING_AGENT_DIR` 覆盖）

```json
[
	{
		"id": "zcode",
		"displayName": "ZCode · 智谱",
		"reuseAdapter": "zai-coding-cn",
		"baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4"
	}
]
```

| 字段 | 说明 |
|---|---|
| `id` | provider id。凭据按此 id 从 pi 凭据仓读取，provider 需已注册并登录；面板 / 缓存 / 状态栏的去重键 |
| `displayName` | 可选，面板标题与排序名，缺省用 `id` |
| `reuseAdapter` | 借用哪个 pi-usage 内置 adapter 的查询函数（端点路径 + Bearer 组装 + 响应归一化全部复用，一行不重写）。必须是 `usageAdapters()` 里存在的 id |
| `baseUrl` | 可选。配额端点的 API 根。**省略时回退 provider 自身配置的 baseUrl**（直连官方源的 provider 可省）；provider 配了代理的**必须显式写**，否则查询会打到代理上报错 |

语义：**查询逻辑 = 内置 adapter 的（借来），凭据 = pi 凭据仓的（按 id 取），端点 = 你钉的**。一条 = 一个 provider id = 一份凭据；同一 API 想看多个账号，注册多个 provider id、各写一条。

行为约定：

- 配置文件缺失 = 仅内置源；未注册 / 未登录的条目静默跳过（不显示面板）
- schema 非法、`reuseAdapter` 不存在、两级 baseUrl 都解析不到 → 该条跳过 + `/usage` 面板顶部黄字警告（第几条、什么错），不影响其余查询
- 新 provider 的用量 API 与所有内置 adapter 都不同构时，配置表达不了：给本包加真适配器实现，或向上游 pi-usage 提 PR（成了之后 `reuseAdapter` 指过去即可）

## 开发与验证

保留原有命令、配置字段、状态栏格式和扩展入口。内部模块放在 `lib/`，避免被 pi 当作独立扩展扫描；安装时需要完整保留 `extensions/` 和 `lib/`。

| 文件 | 职责 |
|---|---|
| `extensions/usage-dash.ts` | 命令注册、交互面板和生命周期事件 |
| `lib/types.ts` | 报告、查询结果和状态栏的共享类型 |
| `lib/config.ts` | 额外源配置读取、校验及 baseUrl 解析 |
| `lib/query.ts` | 内置源和额外源查询、缓存、并发及凭据校验 |
| `lib/format.ts` | 数值、时长、进度条及文本宽度格式化 |
| `lib/status.ts` | 状态栏内容、定时刷新及失败降级 |
| `lib/render.ts` | 仪表盘面板与整屏文本 |
| `tests/` | 使用模拟 pi / 查询引擎的回归测试及原版输出快照 |

```bash
npm ci
npm run check          # TypeScript 检查 + 回归测试
npm pack --dry-run     # 检查发布文件
```

测试使用 Node 内置测试运行器、VM 模块及现有 TypeScript 开发依赖，不增加运行时依赖。运行时出现 VM Modules 实验性提示属正常现象。测试不读取真实账号、不请求用量 API。

回归覆盖：60 秒缓存边界、强制刷新、4 路并发、结果排序、额外源端点回退、配置警告、凭据变化、错误脱敏、状态栏刷新与失败降级、主题异常、交互面板缓存和原版文本输出。原入口的 `StatusSpan` 类型及五个具名函数导出保持可用。

兼容性说明：本次仅重构，保留原版额外源每次实时查询的行为；`refresh` / `force` 的参数匹配方式、15 秒查询超时、5 分钟状态栏刷新和连续 3 次失败清空规则均不变。

### 查询引擎升级检查

`@narumitw/pi-usage` 仍固定为 `0.61.2`。升级前核对 `@narumitw/pi-usage/dist/index.ts` 中以下导出及其调用参数，再执行回归测试并用实际账号验证：

- `usageAdapters`、`providerIsConfigured`、`resolveUsageAuth`
- `queryProviderUsage`、`redactUsageError`、`abortError`

## License

MIT
