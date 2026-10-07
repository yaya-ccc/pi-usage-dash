/** /usage 命令和 pi 生命周期入口；查询引擎与兼容性说明见 README.md。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isStaleExtensionContextError } from "@narumitw/pi-usage/dist/index.ts";
import { queryAll } from "../lib/query.ts";
import { renderScreen } from "../lib/render.ts";
import { clearStatus, publishFromResults, refreshStatus, startStatusTimer, stopStatusTimer } from "../lib/status.ts";

// 保留原入口的具名导出，兼容现有调用方。
export { tierColor, remainingPercent, formatCurrencyAmount, pickBalance, buildStatusSpans } from "../lib/status.ts";
export type { StatusSpan } from "../lib/types.ts";

export default function usageDash(pi: ExtensionAPI): void {
	pi.registerCommand("usage", {
		description: "查询所有已配置 provider 的用量仪表盘（refresh = 强制刷新）",
		handler: async (args, ctx) => {
			const force = /refresh|force/i.test(args);
			try {
				const { results, warnings } = await queryAll(ctx, force);
				const activeProvider = ctx.model?.provider;
				// 手动查询后立即同步 statusline（含失败路径的 stale 处理）
				publishFromResults(ctx, results, activeProvider);

				if (ctx.hasUI && ctx.ui?.custom) {
					let cachedLines: { width: number; lines: string[] } | undefined;
					await ctx.ui.custom<null>((_tui, theme, _kb, done) => {
						function render(width: number): string[] {
							if (cachedLines && cachedLines.width === width) return cachedLines.lines;
							const lines = renderScreen(results, activeProvider, width, (c, s) =>
								theme.fg(c as never, s), warnings);
							lines.push("", theme.fg("dim", "按任意键关闭"));
							cachedLines = { width, lines };
							return lines;
						}
						return {
							render,
							invalidate: () => {
								cachedLines = undefined;
							},
							handleInput: () => done(null),
						};
					});
				} else {
					// 无 UI（RPC/headless）降级：纯文本通知
					const lines = renderScreen(results, activeProvider, 72, (_c, s) => s, warnings);
					ctx.ui.notify(lines.join("\n"));
				}
			} catch (error) {
				if (isStaleExtensionContextError(error) ||
					(error instanceof Error && error.name === "AbortError")) return;
				try {
					ctx.ui.notify(`/usage 失败: ${error instanceof Error ? error.message : String(error)}`, "error");
				} catch {
					/* 错误通知也不能再次访问失效的 UI 而逃出命令边界。 */
				}
			}
		},
	});

	// statusline 生命周期：会话开始/每轮任务幂等启动定时；切模型清空重查；
	// 会话结束停表。agent_start 兼作 pi-usage 式的"每轮刷新"语义。
	pi.on("session_start", (_event, ctx) => startStatusTimer(ctx));
	pi.on("agent_start", (_event, ctx) => startStatusTimer(ctx));
	pi.on("model_select", (event, ctx) => {
		clearStatus(ctx);
		void refreshStatus(ctx, event.model?.provider);
	});
	pi.on("session_shutdown", () => stopStatusTimer());
}
