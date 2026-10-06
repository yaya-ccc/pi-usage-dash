import { usageAdapters } from "@narumitw/pi-usage/dist/index.ts";
import { loadExtraSources } from "./config.ts";
import { bucketFraction, pad, fmtReset, fmtMetricValue, makeBar, padEndWidth, displayWidth } from "./format.ts";
import type { Adapter, QueryResult } from "./types.ts";

interface Panel {
	title: string;
	rows: Array<{ text: string; color?: string; bar?: { frac: number } }>;
}

function buildPanels(results: QueryResult[], activeProvider: string | undefined): Panel[] {
	return results.map(({ adapter, report, error }) => {
		const title =
			adapter.id === activeProvider ? `${adapter.displayName} ●` : adapter.displayName;
		const rows: Panel["rows"] = [];

		if (error) {
			rows.push({ text: `✗ ${error}`, color: "error" });
			return { title, rows };
		}
		if (!report) return { title, rows };

		if (report.accountLabel) rows.push({ text: report.accountLabel, color: "muted" });

		for (const bucket of report.buckets) {
			const frac = bucketFraction(bucket);
			const label = pad(bucket.label, 12);
			if (frac !== undefined) {
				const pct = Math.round(frac * 100);
				const reset = fmtReset(bucket.resetsAt);
				rows.push({
					// 固定留一空格：label 截断（如 Weekly wind…）时百分比不会粘在省略号上
					text: `${label} ${pct}%${reset ? `  ${reset}` : ""}`,
					bar: { frac },
				});
			} else {
				// 余额型：只有 remaining / used
				const value =
					bucket.remaining !== undefined
						? `${fmtMetricValue(bucket.remaining, bucket.unit)} 剩余`
						: bucket.used !== undefined
							? `${fmtMetricValue(bucket.used, bucket.unit)} 已用`
							: "不可用";
				rows.push({ text: `${label}${value}` });
			}
		}
		for (const metric of report.metrics) {
			rows.push({ text: `${pad(metric.label, 12)}${fmtMetricValue(metric.value, metric.unit)}` });
		}
		if (report.buckets.length === 0 && report.metrics.length === 0) {
			rows.push({ text: "（无数值配额数据）", color: "muted" });
		}
		for (const note of report.notes ?? []) {
			rows.push({ text: `· ${note}`, color: "muted" });
		}
		return { title, rows };
	});
}

/** 生成面板文本行；传入不着色的 colorize 即可用于纯文本通知。 */
export function renderScreen(
	results: QueryResult[],
	activeProvider: string | undefined,
	width: number,
	colorize: (color: string, s: string) => string,
	warnings: string[] = [],
): string[] {
	const panels = buildPanels(results, activeProvider);
	const inner = Math.max(30, Math.min(width - 2, 72));
	const out: string[] = [];

	const cached = results.filter((r) => r.fromCache).length;
	const live = results.length - cached;
	out.push(
		colorize(
			"accent",
			`Usage · ${results.length} 个 provider（${live} 实时 / ${cached} 缓存）`,
		),
	);
	out.push("");

	// 配置非法条目的警告：面板顶部黄字，其余查询不受影响
	for (const warning of warnings) {
		out.push(colorize("warning", `⚠ ${warning}`));
	}
	if (warnings.length > 0) out.push("");

	if (panels.length === 0) {
		out.push(colorize("warning", "没有已配置且受支持的 provider。"));
	}

	for (const panel of panels) {
		// 顶边宽度按显示宽度（CJK 计 2 列）补齐，否则含中文的标题会让 ╮ 超出右边框
		out.push(
			colorize(
				"accent",
				`╭─ ${panel.title} ` +
					"─".repeat(Math.max(1, inner - displayWidth(panel.title) - 1)) +
					"╮",
			),
		);
		// 边框字符统一用 accent 着色：否则无色行/带条行的 │ 会落到终端默认色（白），
		// 在同一列的粉色边框上形成“白边”断层
		const A = (s: string) => colorize("accent", s);
		for (const row of panel.rows) {
			if (row.bar) {
				const barWidth = Math.max(8, Math.min(20, inner - 26));
				const bar = makeBar(row.bar.frac, barWidth);
				// 在文本行内嵌彩色条：仅边框着 accent，文本与补位空格保持各自颜色
				const head = padEndWidth(row.text, Math.max(0, inner - barWidth));
				out.push(`${A("│ ")}${head}${colorize(bar.color, bar.text)}${A(" │")}`);
				continue;
			}
			const plain = row.text;
			const padTo = Math.max(0, inner + 1 - displayWidth(plain));
			const body = `${plain}${" ".repeat(padTo)}`;
			out.push(`${A("│ ")}${row.color ? colorize(row.color, body) : body}${A("│")}`);
		}
		out.push(colorize("accent", "╰" + "─".repeat(inner + 2) + "╯"));
	}

	// 活跃 provider 不在支持列表时的提示（额外源在配置文件里声明）
	const knownAdapters = [
		...(usageAdapters() as Adapter[]),
		...loadExtraSources().sources.map((s) => ({
			id: s.id,
			displayName: s.displayName?.trim() || s.id,
		})),
	];
	if (activeProvider && !knownAdapters.some((a) => a.id === activeProvider)) {
		out.push("");
		out.push(
			colorize(
				"muted",
				`当前活跃 provider "${activeProvider}" 不在受支持列表（自定义源无法查询官方配额）`,
			),
		);
	}
	return out;
}

