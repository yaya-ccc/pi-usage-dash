/** Codex Fast 模式运行时：/fast 命令、请求 service_tier 改写、消息成本校正与状态栏标注。
 *
 * 纯逻辑复用 @narumitw/pi-usage 导出的函数，偏好持久化与其共用 pi-usage.json 的
 * codexFastMode 键（将来若改用官方扩展可无缝接管）。相比上游 registerCodexFastMode
 * 的差异：额外支持 pi-codex-accounts 克隆的 openai-codex-<label> provider——这些
 * 账号的请求在线上本就以 openai-codex 名义发出（见其 asCodexContext 重标），
 * 因此把模型/消息视图映射回内置 id 后，官方端点校验与改写逻辑照常成立。 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { calculateCost } from "@earendil-works/pi-ai";
import {
	CODEX_FAST_MODEL_IDS,
	codexFastAvailability,
	correctCodexFastMessageCost,
	createUsageSettingsRuntime,
	errorMessage,
	isStaleExtensionContextError,
	rewriteCodexFastPayload,
} from "@narumitw/pi-usage/dist/index.ts";

/** 设置运行时类型：包内类型重导出不可解析（无 .d.ts），从工厂函数推导等价。 */
type UsageSettingsRuntime = ReturnType<typeof createUsageSettingsRuntime>;
import type { StatusSpan } from "./types.ts";

type FastModel = Parameters<typeof codexFastAvailability>[0];
type FastMessage = Parameters<typeof correctCodexFastMessageCost>[0];

const FAST_USAGE_WARNING = "Fast is about 1.5× faster and uses more of your plan allowance.";
const LABELED_CODEX_PREFIX = "openai-codex-";
/** 库 allowlist（至 0.64.1）未收录、但服务端已实测接受 priority 档的补充型号
 * （2026-10-09 用主号凭证对 gpt-6.1-sol 验证 200）。库内型号仍交给库判定，避免语义漂移。 */
const EXTRA_FAST_MODEL_IDS: ReadonlySet<string> = new Set(["gpt-6.1-sol"]);

type PendingFastRequest = { fastRequested: boolean; model: FastModel };

/** 设置运行时由扩展工厂初始化；statusline 路径在工厂之后执行，只读不写。 */
let settingsRuntime: UsageSettingsRuntime | undefined;

/** 当前 fast 偏好；运行时未初始化（不应发生）按关闭处理，避免状态栏误标。 */
export function codexFastModeNow(): boolean {
	try {
		return settingsRuntime?.get().settings.codexFastMode ?? false;
	} catch {
		return false;
	}
}

/** 标签账号视图映射：openai-codex-<label> → openai-codex，
 * 使库内"内置 provider + 官方 baseUrl"校验对克隆账号同样成立。 */
function effectiveFastModel(model: FastModel): FastModel {
	if (!model || typeof model.provider !== "string" || !model.provider.startsWith(LABELED_CODEX_PREFIX)) return model;
	return { ...model, provider: "openai-codex" } as FastModel;
}

function isLabeledCodex(value: { provider?: unknown } | undefined): boolean {
	return typeof value?.provider === "string" && value.provider.startsWith(LABELED_CODEX_PREFIX);
}

/** 官方 Codex Responses 端点判定（与库 isOfficialCodexModel 同语义：api + baseUrl 源）。 */
function isOfficialCodexEndpoint(view: FastModel): boolean {
	if (!view || typeof view.baseUrl !== "string") return false;
	const api = (view as { api?: unknown }).api;
	if (api !== undefined && api !== "openai-codex-responses") return false;
	try {
		return new URL(view.baseUrl).origin === "https://chatgpt.com";
	} catch {
		return false;
	}
}

/** 可用性判定：库内型号交给库，补充型号走本地官方端点 + 扩展 allowlist 检查。 */
function availabilityFast(model: FastModel, enabled: boolean):
	| { kind: "available"; enabled: boolean }
	| { kind: "not-codex" }
	| { kind: "unavailable"; reason: string } {
	const view = effectiveFastModel(model);
	if (!view || view.provider !== "openai-codex") return { kind: "not-codex" } as const;
	// 库返回类型因包内类型重导出不可解析而被拓宽为 kind: string，按实际运行时形状断言回字面量联合
	if (CODEX_FAST_MODEL_IDS.has(view.id)) {
		return codexFastAvailability(view, enabled) as
			| { kind: "available"; enabled: boolean }
			| { kind: "not-codex" }
			| { kind: "unavailable"; reason: string };
	}
	if (!EXTRA_FAST_MODEL_IDS.has(view.id)) {
		return { kind: "unavailable", reason: `${view.id} does not advertise Codex Fast support.` } as const;
	}
	if (!isOfficialCodexEndpoint(view)) {
		return { kind: "unavailable", reason: "Fast mode requires the official OpenAI Codex Responses endpoint." } as const;
	}
	return { kind: "available", enabled } as const;
}

/** 请求改写：库内型号交给库，补充型号本地写 service_tier（开启 priority，关闭 default）。 */
function rewriteFastPayload(payload: unknown, model: FastModel | undefined, enabled: boolean): Record<string, unknown> | undefined {
	const view = effectiveFastModel(model);
	if (view && CODEX_FAST_MODEL_IDS.has(view.id)) {
		return rewriteCodexFastPayload(payload, view, enabled) as Record<string, unknown> | undefined;
	}
	if (!view || !EXTRA_FAST_MODEL_IDS.has(view.id) || !isOfficialCodexEndpoint(view) || !isRecord(payload)) return undefined;
	return { ...payload, service_tier: enabled ? "priority" : "default" };
}

/** 状态栏 fast 标注：fast 对活跃模型生效时置于窗口序列之前（风格同"codex fast"前缀）。 */
export function fastStatusSpans(model: FastModel, enabled: boolean): StatusSpan[] {
	const availability = availabilityFast(model, enabled);
	return availability.kind === "available" && availability.enabled
		? [{ text: "fast", color: "warning" }]
		: [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activeRequestKey(ctx: ExtensionContext): string | undefined {
	const model = (ctx as { model?: { provider?: string; id?: string } }).model;
	return model?.provider && model.id ? `${ctx.sessionManager.getSessionId()}:${model.provider}/${model.id}` : undefined;
}

function messageRequestKey(ctx: ExtensionContext, message: Record<string, unknown>): string | undefined {
	if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
	return `${ctx.sessionManager.getSessionId()}:${message.provider}/${message.model}`;
}

/** 补充型号的成本校正（与库 correctCodexFastMessageCost 同语义）：
 * 用量重算基准成本后按倍率（非 gpt-5.5 一律 2，同 6-sol 档）乘各成本项，
 * 无实质变化返回 undefined 避免无谓改写。JSON 克隆避开沙箱里缺失的 structuredClone。 */
function correctSupplementFastCost(message: FastMessage, model: FastModel, fastRequested: boolean): FastMessage | undefined {
	if (!fastRequested || !isRecord(message) || message.role !== "assistant") return undefined;
	if (message.provider !== "openai-codex" || message.model !== model.id || !EXTRA_FAST_MODEL_IDS.has(model.id)) return undefined;
	const usage = message.usage;
	if (!isRecord(usage) || !isRecord(usage.cost)) return undefined;
	if (!["input", "output", "cacheRead", "cacheWrite"].every(k => typeof usage[k] === "number" && Number.isFinite(usage[k]))) return undefined;
	const corrected = JSON.parse(JSON.stringify(usage)) as Record<string, unknown>;
	calculateCost(model as never, corrected as never);
	const cost = corrected.cost as Record<string, unknown>;
	const multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		if (typeof cost[key] === "number") cost[key] = (cost[key] as number) * multiplier;
	}
	const original = usage.cost as Record<string, unknown>;
	const unchanged = ["input", "output", "cacheRead", "cacheWrite", "total"].every(
		k => original[k] === cost[k],
	);
	return unchanged ? undefined : ({ ...message, usage: corrected } as FastMessage);
}

/**
 * 注册 fast 模式：命令、请求改写、成本校正与生命周期。
 * refreshStatus 由调用方注入（避免与 status.ts 形成模块环），toggle 后同步状态栏。
 */
export function registerFastMode(
	pi: ExtensionAPI,
	refreshStatus: (ctx: ExtensionContext) => void,
): void {
	settingsRuntime ??= createUsageSettingsRuntime();
	let sessionController = new AbortController();
	let generation = 0;
	const pendingFastRequests = new Map<string, PendingFastRequest>();

	const toggle = async (
		ctx: ExtensionCommandContext,
		enabled: boolean,
	): Promise<boolean> => {
		const ownerGeneration = generation;
		const sessionId = ctx.sessionManager.getSessionId();
		try {
			await settingsRuntime?.update({ codexFastMode: enabled }, sessionController.signal);
		} catch (error) {
			if ((error instanceof Error && error.name === "AbortError") || isStaleExtensionContextError(error)) return false;
			ctx.ui.notify(`Could not save pi-usage.json: ${errorMessage(error)}`, "error");
			return false;
		}
		if (sessionController.signal.aborted || ownerGeneration !== generation || ctx.sessionManager.getSessionId() !== sessionId) {
			return false;
		}
		refreshStatus(ctx);
		ctx.ui.notify(
			enabled
				? `Codex Fast mode enabled. ${FAST_USAGE_WARNING}`
				: "Codex Fast mode disabled; standard routing will be used.",
			"info",
		);
		return true;
	};
	pi.registerCommand("fast", {
		description: "切换 Codex Fast 模式（priority 计费，额度消耗更多）",
		handler: async (args, ctx) => {
			if (args.trim()) {
				if (!ctx.hasUI) throw new Error("/fast does not accept arguments.");
				ctx.ui.notify("/fast does not accept arguments.", "warning");
				return;
			}
			if (!ctx.hasUI) throw new Error("/fast requires TUI or RPC mode.");
			const availability = availabilityFast(ctx.model as FastModel, codexFastModeNow());
			if (availability.kind === "not-codex") {
				ctx.ui.notify("/fast is available only for the active OpenAI Codex model.", "warning");
				return;
			}
			if (availability.kind === "unavailable") {
				ctx.ui.notify(availability.reason ?? "Fast mode is unavailable for the active model.", "warning");
				return;
			}
			if (settingsRuntime?.get().kind === "invalid") {
				ctx.ui.notify("pi-usage.json is invalid; repair it and run /reload before changing Fast mode.", "error");
				return;
			}
			await toggle(ctx, !availability.enabled);
		},
	});

	// 会话启动时重读偏好：pi-usage.json 可能被其他会话/进程修改
	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		generation += 1;
		sessionController.abort();
		sessionController = new AbortController();
		const ownerGeneration = generation;
		try {
			// reload 的返回类型因包内类型重导出不可解析而退化为 never，被断言回结构等价形状
			const state = (await settingsRuntime?.reload(sessionController.signal)) as
				| { kind?: string; issue?: string }
				| undefined;
			if (sessionController.signal.aborted || ownerGeneration !== generation || ctx.sessionManager.getSessionId() !== sessionId) return;
			if (ctx.hasUI && state?.kind === "invalid") {
				ctx.ui.notify(`Invalid pi-usage.json; using defaults without overwriting it. ${state?.issue ?? ""}`, "warning");
			}
		} catch (error) {
			if (sessionController.signal.aborted || ownerGeneration !== generation) return;
			if (ctx.hasUI) ctx.ui.notify(`Could not load pi-usage.json; using defaults. ${errorMessage(error)}`, "warning");
		}
	});

	// 发送前把 service_tier: priority 写进请求体；记住该请求是否 fast 以校正成本
	pi.on("before_provider_request", (event, ctx) => {
		const model = (ctx as { model?: FastModel }).model;
		const rewritten = rewriteFastPayload(event.payload, model, codexFastModeNow());
		const key = activeRequestKey(ctx);
		if (key && model) {
			pendingFastRequests.set(key, {
				fastRequested: isRecord(rewritten) && (rewritten as { service_tier?: unknown }).service_tier === "priority",
				model,
			});
		}
		return rewritten;
	});

	// fast 响应的 token 用量未含倍率，按 2（gpt-5.5 为 2.5）校正成本展示
	pi.on("message_end", (event, ctx) => {
		const message: unknown = event.message;
		if (!isRecord(message) || message.role !== "assistant") return undefined;
		const key = messageRequestKey(ctx, message);
		if (!key) return undefined;
		const request = pendingFastRequests.get(key);
		pendingFastRequests.delete(key);
		if (!request) return undefined;
		// 标签账号的消息 provider 是克隆 id，与模型一起映射回内置 id 使一致性校验通过，返回前还原
		const mapped =
			isLabeledCodex(request.model) && message.provider === request.model.provider
				? { ...message, provider: "openai-codex" }
				: message;
		const view = effectiveFastModel(request.model);
		// 库内型号交给库；补充型号本地校正：用量重算后按 2（gpt-5.5 为 2.5）倍率乘成本，无变化不改写
		const corrected = CODEX_FAST_MODEL_IDS.has(view.id)
			? correctCodexFastMessageCost(mapped as FastMessage, view, request.fastRequested)
			: correctSupplementFastCost(mapped as FastMessage, view, request.fastRequested);
		if (!corrected) return undefined;
		const restored =
			isLabeledCodex(request.model) && isRecord(corrected)
				? { ...(corrected as Record<string, unknown>), provider: request.model.provider }
				: corrected;
		return { message: restored as never };
	});

	pi.on("session_shutdown", async () => {
		generation += 1;
		sessionController.abort();
		pendingFastRequests.clear();
		await settingsRuntime?.flush();
	});
}
