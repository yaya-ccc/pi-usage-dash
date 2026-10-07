export interface Bucket {
	id?: string;
	label: string;
	unit?: string;
	used?: number;
	limit?: number;
	remaining?: number;
	resetsAt?: number;
	/** 窗口时长（分钟）：pi-usage 归一化后的窗口桶普遍携带，状态栏据此免配置识别 5h/7d 等窗口 */
	windowMinutes?: number;
	groupLabel?: string;
}
export interface Metric {
	id?: string;
	label: string;
	value: unknown;
	unit?: string;
	currency?: string;
}
export interface UsageReport {
	providerId: string;
	providerName: string;
	accountLabel?: string;
	semantics?: { label?: string };
	buckets: Bucket[];
	metrics: Metric[];
	notes?: string[];
}
export interface Adapter {
	id: string;
	displayName: string;
}
export interface QueryResult {
	adapter: Adapter;
	report?: UsageReport;
	error?: string;
	fromCache?: boolean;
}


export interface StatusSpan {
	text: string;
	color?: "success" | "warning" | "error";
}

/** 状态栏单 provider 展示覆盖：窗口分钟数序列、段数上限、按分钟数覆盖标签、货币余额兜底开关 */
export interface StatusOverride {
	windows?: number[];
	maxSpans?: number;
	tags?: Record<string, string>;
	balanceFallback?: boolean;
}

/** usage-dash.json 的 status 配置段：default 为全局默认，providers 按 provider id 覆盖（同名字段后者优先） */
export interface StatusConfig {
	default?: StatusOverride;
	providers?: Record<string, StatusOverride>;
}

