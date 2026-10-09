/** Codex Fast 模式运行时：/fast 命令、请求 service_tier 改写、消息成本校正与状态栏标注。
 *
 * 纯逻辑复用 @narumitw/pi-usage 导出的函数，偏好持久化与其共用 pi-usage.json 的
 * codexFastMode 键（将来若改用官方扩展可无缝接管）。相比上游 registerCodexFastMode
 * 的差异：额外支持 pi-codex-accounts 克隆的 openai-codex-<label> provider——这些
 * 账号的请求在线上本就以 openai-codex 名义发出（见其 asCodexContext 重标），
 * 因此把模型/消息视图映射回内置 id 后，官方端点校验与改写逻辑照常成立。 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	codexFastAvailability,
	codexFastIsEffective,
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

/** 状态栏 fast 标注：fast 对活跃模型生效时置于窗口序列之前（风格同"codex fast"前缀）。 */
export function fastStatusSpans(model: FastModel, enabled: boolean): StatusSpan[] {
	return codexFastIsEffective(effectiveFastModel(model), enabled)
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
			const availability = codexFastAvailability(effectiveFastModel(ctx.model as FastModel), codexFastModeNow());
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
		const rewritten = rewriteCodexFastPayload(event.payload, effectiveFastModel(model), codexFastModeNow());
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
		const corrected = correctCodexFastMessageCost(mapped as FastMessage, effectiveFastModel(request.model), request.fastRequested);
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
