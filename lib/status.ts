import { isStaleExtensionContextError, usageAdapters } from "@narumitw/pi-usage/dist/index.ts";
import { loadDashConfig } from "./config.ts";
import { codexFastModeNow, fastStatusSpans } from "./fast.ts";
import { cancelQueries, queryAll } from "./query.ts";
import type { Adapter, Bucket, Metric, QueryResult, StatusOverride, StatusSpan, UsageReport } from "./types.ts";

const STATUS_KEY = "usage";
const STATUS_REFRESH_MS = 5 * 60_000;
const STATUS_MAX_FAILURES = 3;

let statusTimer: ReturnType<typeof setInterval> | undefined;
let statusContext: unknown;
let statusLast: StatusSpan[] = [];
let statusFailures = 0;
// 会话结束、模型切换和新查询都会作废旧结果，不能让迟到回调污染当前状态。
let statusRevision = 0;

/** 剩余比例着色档位，阈值与面板 barColor 一致 */
export function tierColor(remainingPct: number): "success" | "warning" | "error" {
	if (remainingPct >= 50) return "success";
	if (remainingPct >= 20) return "warning";
	return "error";
}

/** 剩余百分比（0-100 取整）。percent 型与 count 型桶都带 remaining+limit，一个公式通吃 */
export function remainingPercent(bucket: Bucket): number | undefined {
	if (bucket.remaining === undefined || bucket.limit === undefined || !(bucket.limit > 0))
		return undefined;
	return Math.round(Math.min(Math.max((bucket.remaining / bucket.limit) * 100, 0), 100));
}

export function formatCurrencyAmount(value: number, currency: string): string {
	if (currency === "USD") return `$${value.toFixed(2)}`;
	if (currency === "CNY") return `¥${value.toFixed(2)}`;
	return `${value.toFixed(2)} ${currency}`;
}

/** 余额挑选：有美元用美元，没美元用人民币，都无取首个；deepseek 多字段只认 *-total */
export function pickBalance(metrics: Metric[]): { value: number; currency: string } | undefined {
	let chosen: { value: number; currency: string } | undefined;
	let bestRank = Infinity;
	for (const metric of metrics) {
		if (metric.unit !== "currency" || typeof metric.value !== "number" || !Number.isFinite(metric.value))
			continue;
		// total 优先，其次 USD / CNY / 其他；同优先级保留首项。
		const rank = (metric.id?.endsWith("-total") ? 0 : 3) +
			(metric.currency === "USD" ? 0 : metric.currency === "CNY" ? 1 : 2);
		if (rank < bestRank) {
			bestRank = rank;
			chosen = { value: metric.value, currency: metric.currency ?? "" };
		}
	}
	return chosen;
}

/** 由单个 provider 报告生成状态行片段；override 为合并后的展示覆盖，缺省走引擎默认。无可展示数据返回空数组 */
export function buildStatusSpans(report: UsageReport, override?: StatusOverride): StatusSpan[] {
	const windows = override?.windows?.length ? override.windows : DEFAULT_STATUS_WINDOWS;
	const maxSpans = override?.maxSpans !== undefined && override.maxSpans > 0 ? override.maxSpans : DEFAULT_STATUS_MAX_SPANS;
	const groups: StatusSpan[][] = [];
	for (const minutes of windows) {
		if (groups.length >= maxSpans) break;
		const bucket = findWindowBucket(report, minutes);
		if (!bucket) continue;
		const pct = remainingPercent(bucket);
		if (pct === undefined) continue;
		const tag = override?.tags?.[String(minutes)] ?? autoWindowTag(minutes);
		groups.push([{ text: `${pct}%`, color: tierColor(pct) }, { text: `·${tag}` }]);
	}
	if (groups.length > 0) {
		return groups.flatMap((group, index) => (index > 0 ? [{ text: " " }, ...group] : group));
	}
	if (override?.balanceFallback === false) return [];
	const balance = pickBalance(report.metrics);
	if (balance) return [{ text: formatCurrencyAmount(balance.value, balance.currency), color: "success" }];
	return [];
}

function renderSpans(spans: StatusSpan[], colorize: (color: string, s: string) => string): string {
	return spans.map(span => (span.color ? colorize(span.color, span.text) : span.text)).join("");
}

/** 无 UI（RPC/headless）或主题不可用时降级为纯文本 */
function statusColorizer(ctx: unknown): (color: string, s: string) => string {
	try {
		// ui/theme 也可能是抛错的 getter；保护方法调用不足以覆盖失效 ctx。
		const theme = (ctx as { ui?: { theme?: { fg?: (c: never, s: string) => string } } }).ui?.theme;
		// fg 内部依赖 this.tokenAnsi，必须绑定后调用。
		const fg = theme?.fg?.bind(theme);
		return fg ? (c, s) => { try { return fg(c as never, s); } catch { return s; } } : (_c, s) => s;
	} catch {
		return (_c, s) => s;
	}
}

function safeSetStatus(ctx: unknown, text: string | undefined): void {
	try {
		(ctx as { ui?: { setStatus?: (key: string, text: string | undefined) => void } }).ui?.setStatus?.(
			STATUS_KEY,
			text,
		);
	} catch {
		/* setStatus 不可用视为无状态行环境 */
	}
}

export function clearStatus(ctx: unknown): void {
	statusRevision += 1;
	statusLast = [];
	statusFailures = 0;
	safeSetStatus(ctx, undefined);
}

/** 查询失败：保留上次值加 ·stale；连续 3 次或无历史值则清空 */
function handleStatusQueryFailure(ctx: unknown): void {
	statusFailures += 1;
	if (statusLast.length === 0 || statusFailures >= STATUS_MAX_FAILURES) {
		clearStatus(ctx);
		return;
	}
	const colorize = statusColorizer(ctx);
	safeSetStatus(ctx, renderSpans(statusLast, colorize) + colorize("dim", " ·stale"));
}

/** 引擎默认：优先 5h + 7d 两个窗口，最多两段（配置 status 段可按 provider 覆盖） */
const DEFAULT_STATUS_WINDOWS = [300, 10080];
const DEFAULT_STATUS_MAX_SPANS = 2;
/** 无 windowMinutes 的存量桶按窗口 ID 兜底识别（kimi / openrouter 等归一化 ID） */
const WINDOW_ID_FALLBACK = new Map<number, string[]>([
	[300, ["five-hour"]],
	[10080, ["weekly"]],
]);

/** 窗口标签自动生成：<1 天按小时（5h），≥1 天按天（1d / 7d / 30d），免配置即用 */
export function autoWindowTag(minutes: number): string {
	if (!Number.isFinite(minutes) || minutes <= 0) return String(minutes);
	if (minutes < 1440) return `${Math.max(1, Math.round(minutes / 60))}h`;
	return `${Math.max(1, Math.round(minutes / 1440))}d`;
}

/** 按窗口分钟数选桶：windowMinutes 优先，存量 ID 兜底；count 型桶只要有 remaining/limit 同样可算百分比 */
function findWindowBucket(report: UsageReport, minutes: number): Bucket | undefined {
	const byMinutes = report.buckets.find(b => b.windowMinutes === minutes && remainingPercent(b) !== undefined);
	if (byMinutes) return byMinutes;
	const ids = WINDOW_ID_FALLBACK.get(minutes);
	return ids
		? report.buckets.find(b => b.id !== undefined && ids.includes(b.id) && remainingPercent(b) !== undefined)
		: undefined;
}

/** 活跃 provider 是否属于可查询集合（pi-usage 内置 + 配置文件里的额外源 id） */
function isStatusProvider(provider: string): boolean {
	if ((usageAdapters() as Adapter[]).some(a => a.id === provider)) return true;
	// 只看 schema 合法性：reuseAdapter/baseUrl 非法的条目在 statusline 路径
	// 查询失败后走 ·stale/清空降级，无需在此重复校验
	return loadDashConfig().sources.some(s => s.id === provider);
}

/** 汇总 status 配置：default 与 providers[provider] 浅合并（后者同名字段优先） */
function resolveStatusOverride(provider: string | undefined): StatusOverride {
	const { status } = loadDashConfig();
	const merged: StatusOverride = { ...status.default };
	if (provider && status.providers?.[provider]) Object.assign(merged, status.providers[provider]);
	return merged;
}
/** 从既有查询结果发布活跃 provider 的状态（/usage 与定时/事件刷新共用） */
export function publishFromResults(ctx: unknown, results: QueryResult[], provider: string | undefined): void {
	statusRevision += 1;
	if (!provider || !isStatusProvider(provider)) {
		clearStatus(ctx);
		return;
	}
	const found = results.find(r => r.adapter.id === provider);
	if (!found || found.error || !found.report) {
		handleStatusQueryFailure(ctx);
		return;
	}
	// fast 标注跟随活跃模型而非报告本身：切模型即变，无需改查询链路
	const model = (ctx as { model?: Parameters<typeof fastStatusSpans>[0] }).model;
	const spans = [...fastStatusSpans(model, codexFastModeNow()), ...buildStatusSpans(found.report, resolveStatusOverride(provider))];
	statusFailures = 0;
	if (spans.length === 0) {
		clearStatus(ctx); // 查询成功但无窗口/余额数据（含 balanceFallback 关闭）
		return;
	}
	statusLast = spans;
	safeSetStatus(ctx, renderSpans(spans, statusColorizer(ctx)));
}

/** 定时/事件触发的刷新：只查活跃 provider（60s TTL 缓存与 /usage 天然去重） */
export async function refreshStatus(ctx: unknown, providerOverride?: string): Promise<void> {
	const revision = ++statusRevision;
	try {
		const provider =
			providerOverride ?? (ctx as { model?: { provider?: string } }).model?.provider;
		if (!provider || !isStatusProvider(provider)) {
			clearStatus(ctx);
			return;
		}
		const { results } = await queryAll(ctx, false, provider);
		if (revision !== statusRevision) return;
		publishFromResults(ctx, results, provider);
	} catch (error) {
		if (revision !== statusRevision || isStaleExtensionContextError(error) ||
			(error instanceof Error && error.name === "AbortError")) return;
		handleStatusQueryFailure(ctx);
	}
}

/** 幂等启动：立即刷一次 + 5 分钟定时兜底（空闲会话也有更新） */
export function startStatusTimer(ctx: unknown): void {
	statusContext = ctx;
	void refreshStatus(ctx);
	if (statusTimer !== undefined) return;
	statusTimer = setInterval(() => {
		if (statusContext !== undefined) void refreshStatus(statusContext);
	}, STATUS_REFRESH_MS);
	// headless/RPC 模式下不能让定时器阻止进程退出;交互模式有其他句柄,不受影响
	statusTimer.unref?.();
}

export function stopStatusTimer(): void {
	if (statusTimer !== undefined) clearInterval(statusTimer);
	statusTimer = undefined;
	statusContext = undefined;
	cancelQueries();
	statusRevision += 1;
	statusLast = [];
	statusFailures = 0;
}
