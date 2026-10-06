import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types.ts";

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

/** agent 目录：与 pi 的 PI_CODING_AGENT_DIR 约定一致，默认 ~/.pi/agent */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** 读取并校验额外源配置；文件缺失视为无额外源（不警告），其余错误降级为警告 */
export function loadExtraSources(): { sources: ExtraSource[]; warnings: string[] } {
	const warnings: string[] = [];
	let raw: string;
	try {
		raw = readFileSync(join(agentDir(), "usage-dash.json"), "utf8");
	} catch {
		return { sources: [], warnings }; // 未配置：仅内置源
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { sources: [], warnings: [`usage-dash.json 不是合法 JSON：${(error as Error).message}`] };
	}
	if (!Array.isArray(parsed)) {
		return { sources: [], warnings: ["usage-dash.json 顶层应为数组 [{id, reuseAdapter, …}]"] };
	}
	const sources: ExtraSource[] = [];
	parsed.forEach((item, index) => {
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
	});
	return { sources, warnings };
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
): Promise<{ entries: ExtraEntry[]; warnings: string[] }> {
	const { sources, warnings } = loadExtraSources();
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
