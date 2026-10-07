import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, StatusConfig, StatusOverride } from "./types.ts";

/** usage-dash.json 的单条配置（额外用量源声明） */
export interface ExtraSource {
	id: string;
	displayName?: string;
	reuseAdapter: string;
	baseUrl?: string;
}
/** 解析完成的额外源：配置 + 展示用 adapter + 复用的内置 adapter + 定死的 baseUrl */
export interface ExtraEntry {
	source: ExtraSource;
	adapter: Adapter;
	reuse: Adapter;
	baseUrl: string;
}

/** 顶层对象 schema 的解析结果：额外源 + 状态栏覆盖配置 + 警告 */
export interface DashConfig {
	sources: ExtraSource[];
	status: StatusConfig;
	warnings: string[];
}

/** agent 目录：与 pi 的 PI_CODING_AGENT_DIR 约定一致，默认 ~/.pi/agent */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** 校验单个 StatusOverride 字段：非法字段降级为警告并忽略，不拖垮整段配置 */
function parseStatusOverride(value: unknown, label: string, warnings: string[]): StatusOverride | undefined {
	if (typeof value !== "object" || value === null) {
		warnings.push(`${label}：应为对象，已忽略`);
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const override: StatusOverride = {};
	if (record.windows !== undefined) {
		const windows = Array.isArray(record.windows) && record.windows.every(w => typeof w === "number" && Number.isSafeInteger(w) && w > 0)
			? (record.windows as number[])
				: undefined;
		if (windows) override.windows = windows;
		else warnings.push(`${label}.windows：应为正整数数组（分钟数），已忽略`);
	}
	if (record.maxSpans !== undefined) {
		if (typeof record.maxSpans === "number" && Number.isSafeInteger(record.maxSpans) && record.maxSpans > 0)
			override.maxSpans = record.maxSpans;
		else warnings.push(`${label}.maxSpans：应为正整数，已忽略`);
	}
	if (record.tags !== undefined) {
		const tags: Record<string, string> = {};
		const entries = Object.entries(record.tags as Record<string, unknown>);
		if (typeof record.tags === "object" && record.tags !== null && entries.every(([k, v]) => /^\d+$/.test(k) && typeof v === "string" && v.trim())) {
			for (const [k, v] of entries) tags[k] = (v as string).trim();
			override.tags = tags;
		} else {
			warnings.push(`${label}.tags：应为「分钟数字符串 → 标签」的非空字符串映射，已忽略`);
		}
	}
	if (record.balanceFallback !== undefined) {
		if (typeof record.balanceFallback === "boolean") override.balanceFallback = record.balanceFallback;
		else warnings.push(`${label}.balanceFallback：应为布尔值，已忽略`);
	}
	return override;
}

/** 校验 status 配置段：default 与 providers 各自独立降级 */
function parseStatusConfig(value: unknown, warnings: string[]): StatusConfig {
	const status: StatusConfig = {};
	if (value === undefined) return status;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		warnings.push("status：应为对象 {default, providers}，已忽略");
		return status;
	}
	const record = value as Record<string, unknown>;
	const def = parseStatusOverride(record.default, "status.default", warnings);
	if (def && Object.keys(def).length > 0) status.default = def;
	if (record.providers !== undefined) {
		if (typeof record.providers === "object" && record.providers !== null && !Array.isArray(record.providers)) {
			const providers: Record<string, StatusOverride> = {};
			for (const [id, entry] of Object.entries(record.providers as Record<string, unknown>)) {
				if (!id.trim()) continue;
				const override = parseStatusOverride(entry, `status.providers."${id}"`, warnings);
				if (override && Object.keys(override).length > 0) providers[id] = override;
			}
			if (Object.keys(providers).length > 0) status.providers = providers;
		} else {
			warnings.push("status.providers：应为按 provider id 索引的对象，已忽略");
		}
	}
	return status;
}

/** 读取并校验 usage-dash.json（对象 schema：{sources, status}）；文件缺失视为空配置（不警告），其余错误降级为警告 */
export function loadDashConfig(): DashConfig {
	const warnings: string[] = [];
	const empty: DashConfig = { sources: [], status: {}, warnings };
	let raw: string;
	try {
		raw = readFileSync(join(agentDir(), "usage-dash.json"), "utf8");
	} catch {
		return empty; // 未配置：仅内置源、状态栏走引擎默认
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ...empty, warnings: [`usage-dash.json 不是合法 JSON：${(error as Error).message}`] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		// v0.1.x 顶层数组 schema 已废弃，不兼容（迁移：数组包进 {"sources": …}）
		return { ...empty, warnings: ["usage-dash.json 顶层应为对象 {sources: […], status: {…}}（v0.2 起不再接受顶层数组）"] };
	}
	const record = parsed as Record<string, unknown>;
	const sources: ExtraSource[] = [];
	if (record.sources !== undefined) {
		if (!Array.isArray(record.sources)) {
			warnings.push("sources：应为数组 [{id, reuseAdapter, …}]，已忽略");
		} else {
			record.sources.forEach(parseSourceEntry(sources, warnings));
		}
	}
	return { sources, status: parseStatusConfig(record.status, warnings), warnings };
}

/** 解析单条额外源：字段级校验，非法条目降级为警告 */
function parseSourceEntry(sources: ExtraSource[], warnings: string[]) {
	return (item: unknown, index: number): void => {
		const nth = `配置第 ${index + 1} 条`;
		if (typeof item !== "object" || item === null) {
			warnings.push(`${nth}：不是对象，已跳过`);
			return;
		}
		const record = item as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id.trim() : "";
		const reuseAdapter = typeof record.reuseAdapter === "string" ? record.reuseAdapter.trim() : "";
		if (!id) {
			warnings.push(`${nth}：缺少非空 id，已跳过`);
			return;
		}
		if (!reuseAdapter) {
			warnings.push(`${nth}（${id}）：缺少非空 reuseAdapter，已跳过`);
			return;
		}
		if (record.displayName !== undefined && typeof record.displayName !== "string") {
			warnings.push(`${nth}（${id}）：displayName 应为字符串，已跳过`);
			return;
		}
		if (record.baseUrl !== undefined && typeof record.baseUrl !== "string") {
			warnings.push(`${nth}（${id}）：baseUrl 应为字符串，已跳过`);
			return;
		}
		sources.push({
			id,
			reuseAdapter,
			displayName: record.displayName,
			baseUrl: record.baseUrl,
		});
	};
}

/** provider 是否已注册并登录（凭据已存储）；探测失败按未配置处理 */
function extraIsConfigured(ctx: unknown, id: string): boolean {
	try {
		const status = (
			ctx as { modelRegistry?: { getProviderAuthStatus?: (id: string) => { configured?: boolean } } }
		).modelRegistry?.getProviderAuthStatus?.(id);
		return Boolean(status?.configured);
	} catch {
		return false;
	}
}

/**
 * 把配置解析成可查询的额外源：校验 reuseAdapter 存在、解析 baseUrl（显式
 * 配置 → provider 自身 baseUrl 两级回退）。未注册/未登录的条目静默跳过
 * （与内置源"未配置不显示"一致）；无法解析的条目降级为警告。
 */
export async function resolveExtras(
	ctx: unknown,
	builtins: Adapter[],
	signal?: AbortSignal,
): Promise<{ entries: ExtraEntry[]; warnings: string[] }> {
	signal?.throwIfAborted();
	const { sources, warnings } = loadDashConfig();
	const registry = (
		ctx as {
			modelRegistry?: {
				getProvider?: (id: string) => { baseUrl?: string } | undefined;
				getProviderAuth?: (id: string) => Promise<{ auth?: { apiKey?: string; baseUrl?: string } } | undefined>;
			};
		}
	).modelRegistry;
	const entries: ExtraEntry[] = [];
	const builtinById = new Map<string, Adapter>();
	for (const adapter of builtins) {
		// 与原来的 find 一致：重复 id 时保留首项。
		if (!builtinById.has(adapter.id)) builtinById.set(adapter.id, adapter);
	}
	for (const source of sources) {
		signal?.throwIfAborted();
		const reuse = builtinById.get(source.reuseAdapter);
		if (!reuse) {
			warnings.push(
				`"${source.id}"：reuseAdapter "${source.reuseAdapter}" 不在 pi-usage 内置列表，已跳过`,
			);
			continue;
		}
		if (!extraIsConfigured(ctx, source.id)) continue; // 未注册/未登录：静默
		let baseUrl = source.baseUrl?.trim() || undefined;
		if (!baseUrl) {
			// 回退 provider 自身 baseUrl：直连官方源的 provider 省略 baseUrl 即正确；
			// 配了代理的 provider 会打到代理，查询报错可发现（警告/错误面板）
			baseUrl = registry?.getProvider?.(source.id)?.baseUrl?.trim() || undefined;
		}
		if (!baseUrl) {
			try {
				baseUrl =
					(await registry?.getProviderAuth?.(source.id))?.auth?.baseUrl?.trim() || undefined;
			} catch {
				baseUrl = undefined;
			}
		}
		signal?.throwIfAborted();
		if (!baseUrl) {
			warnings.push(`"${source.id}"：未配置 baseUrl 且 provider 无自身 baseUrl，已跳过`);
			continue;
		}
		entries.push({
			source,
			adapter: { id: source.id, displayName: source.displayName?.trim() || source.id },
			reuse,
			baseUrl,
		});
	}
	return { entries, warnings };
}
