import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { usageAdapters, providerIsConfigured, resolveUsageAuth, queryProviderUsage, redactUsageError, abortError, isStaleExtensionContextError } from "@narumitw/pi-usage/dist/index.ts";
import { resolveExtras, type ExtraEntry } from "./config.ts";
import type { Adapter, QueryResult, UsageReport } from "./types.ts";

const TTL_MS = 60_000;
const QUERY_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const cache = new Map<string, { at: number; report: UsageReport }>();
const activeControllers = new Set<AbortController>();

/** 会话结束时同时取消后台刷新和 /usage，取消后不能再检查旧 ctx。 */
export function cancelQueries(): void {
	for (const controller of activeControllers) controller.abort(abortError());
	activeControllers.clear();
}

/** 额外源凭据里保存的账号名（登录时写入 auth.json，面板首行显示） */
async function extraAccountName(id: string): Promise<string | undefined> {
	try {
		const credential = (await readStoredCredential(id)) as { accountName?: unknown } | undefined;
		return typeof credential?.accountName === "string" && credential.accountName.trim()
			? credential.accountName.trim()
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * 查询额外源用量：借用 reuseAdapter 的查询函数（同端点路径、同 Bearer、
 * 同归一化），baseUrl 钉在解析结果上。未登录返回 undefined（不显示面板）；
 * guard 与主路径同语义：key 被换即中止。
 */
async function queryExtra(entry: ExtraEntry, ctx: unknown, signal: AbortSignal): Promise<QueryResult | undefined> {
	signal.throwIfAborted();
	const registry = (
		ctx as {
			modelRegistry?: { getProviderAuth?: (id: string) => Promise<{ auth?: { apiKey?: string } } | undefined> };
		}
	).modelRegistry;
	let key: string | undefined;
	try {
		key = (await registry?.getProviderAuth?.(entry.source.id))?.auth?.apiKey;
	} catch (error) {
		if (isStaleExtensionContextError(error)) throw error;
		key = undefined;
	}
	signal.throwIfAborted();
	if (!key) return undefined;

	const guard = async (): Promise<void> => {
		signal.throwIfAborted();
		let current: string | undefined;
		try {
			current = (await registry?.getProviderAuth?.(entry.source.id))?.auth?.apiKey;
		} catch (error) {
			if (isStaleExtensionContextError(error)) throw error;
			current = undefined;
		}
		signal.throwIfAborted();
		if (current !== key) throw abortError();
	};

	const auth = {
		apiKey: key,
		headers: { Authorization: `Bearer ${key}` },
		model: { baseUrl: entry.baseUrl },
		secrets: [key],
	};

	try {
		const report = (await queryProviderUsage(
			entry.reuse as never,
			auth as never,
			signal,
			QUERY_TIMEOUT_MS,
			guard as never,
			undefined,
		)) as UsageReport;
		signal.throwIfAborted();
		const accountName = await extraAccountName(entry.source.id);
		signal.throwIfAborted();
		if (accountName && !report.accountLabel) report.accountLabel = accountName;
		cache.set(entry.adapter.id, { at: Date.now(), report });
		return { adapter: entry.adapter, report };
	} catch (error) {
		if (isStaleExtensionContextError(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		return { adapter: entry.adapter, error: redactUsageError(message, [key] as never) };
	}
}

async function queryBuiltin(ctx: unknown, adapter: Adapter, force: boolean, signal: AbortSignal): Promise<QueryResult> {
	signal.throwIfAborted();
	const cached = cache.get(adapter.id);
	if (!force && cached && Date.now() - cached.at < TTL_MS) {
		return { adapter, report: cached.report, fromCache: true };
	}
	let auth: Awaited<ReturnType<typeof resolveUsageAuth>> | undefined;
	try {
		auth = await resolveUsageAuth(ctx as never, adapter as never, undefined, undefined, undefined);
		signal.throwIfAborted();
		if (!auth) {
			return { adapter, error: "未找到官方源凭证（自定义/代理源不支持）" };
		}
		const fingerprint = (auth as { fingerprint?: string }).fingerprint;
		const c = ctx as {
			sessionManager?: { getSessionId?: () => string };
			model?: { provider?: string; id?: string } | undefined;
		};
		const expectedSessionId = c.sessionManager?.getSessionId?.();
		const modelIdentity = (m: typeof c.model) =>
			m ? `${m.provider}/${m.id}` : undefined;
		const expectedModel = modelIdentity(c.model);
		// 与 pi-usage 内部同语义的请求边界守卫：
		// 查询期间会话/模型未切换、凭证指纹未变，否则中止
		const guard = async (): Promise<void> => {
			signal.throwIfAborted();
			if (c.sessionManager?.getSessionId?.() !== expectedSessionId) throw abortError();
			if (modelIdentity(c.model) !== expectedModel) throw abortError();
			const revalidated = await resolveUsageAuth(ctx as never, adapter as never, undefined, undefined, undefined);
			signal.throwIfAborted();
			if ((revalidated as { fingerprint?: string } | undefined)?.fingerprint !== fingerprint)
				throw abortError();
		};
		const report = (await queryProviderUsage(
			adapter as never,
			auth,
			signal,
			QUERY_TIMEOUT_MS,
			guard as never,
			undefined,
		)) as UsageReport;
		await guard().catch((error) => {
			// 普通二次校验失败仍保留已取得结果；取消或失效上下文不能继续写缓存。
			if (signal.aborted || isStaleExtensionContextError(error)) throw error;
		});
		signal.throwIfAborted();
		cache.set(adapter.id, { at: Date.now(), report });
		return { adapter, report };
	} catch (error) {
		if (isStaleExtensionContextError(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		const secrets = (auth as { secrets?: unknown[] } | undefined)?.secrets;
		return {
			adapter,
			error: redactUsageError(message, (secrets ?? []) as never),
		};
	}
}

async function queryAllWithSignal(
	ctx: unknown,
	force: boolean,
	onlyProvider: string | undefined,
	signal: AbortSignal,
): Promise<{ results: QueryResult[]; warnings: string[] }> {
	signal.throwIfAborted();
	const builtins = usageAdapters() as Adapter[];
	// 额外源：解析配置（校验 reuseAdapter / baseUrl），未注册的静默不显示面板
	const { entries: extras, warnings } = await resolveExtras(ctx, builtins, signal);
	signal.throwIfAborted();
	const extraById = new Map(extras.map((e) => [e.adapter.id, e]));
	const adapters = [...builtins, ...extras.map((e) => e.adapter)];

	const configured: Adapter[] = [];
	for (const adapter of adapters) {
		// statusline 路径只关心活跃 provider，跳过其余（避免定时器打满全部 API）
		if (onlyProvider && adapter.id !== onlyProvider) continue;
		if (extraById.has(adapter.id)) {
			configured.push(adapter); // 额外源的 configured 已在 resolveExtras 判过
			continue;
		}
		try {
			if (providerIsConfigured(ctx as never, adapter.id)) configured.push(adapter);
		} catch {
			/* provider 配置检测失败按未配置处理 */
		}
	}

	const results: QueryResult[] = [];
	// 同步领取索引后再 await，多个 worker 不会重复领取，也无需移动数组元素。
	let nextIndex = 0;

	async function worker(): Promise<void> {
		for (;;) {
			signal.throwIfAborted();
			const adapter = configured[nextIndex++];
			if (!adapter) return;

			const extra = extraById.get(adapter.id);
			if (extra) {
				const entry = await queryExtra(extra, ctx, signal);
				if (entry) results.push(entry);
				continue;
			}

			results.push(await queryBuiltin(ctx, adapter, force, signal));
		}
	}

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, configured.length) }, worker));
	signal.throwIfAborted();

	// 稳定排序：成功的在前，按名称排序
	results.sort((a, b) => {
		const rank = (r: QueryResult) => (r.report ? 0 : 1);
		if (rank(a) !== rank(b)) return rank(a) - rank(b);
		return a.adapter.displayName.localeCompare(b.adapter.displayName);
	});
	return { results, warnings };
}

export async function queryAll(
	ctx: unknown,
	force: boolean,
	onlyProvider?: string,
): Promise<{ results: QueryResult[]; warnings: string[] }> {
	const controller = new AbortController();
	activeControllers.add(controller);
	try {
		return await queryAllWithSignal(ctx, force, onlyProvider, controller.signal);
	} catch (error) {
		// Promise.all 提前失败时，其他 worker 仍可能等待 IO，必须一并取消。
		controller.abort(abortError());
		throw error;
	} finally {
		activeControllers.delete(controller);
	}
}
