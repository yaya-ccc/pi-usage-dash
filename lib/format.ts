import type { Bucket } from "./types.ts";

export function fmtCount(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return `${Math.round(n * 100) / 100}`;
}

export function fmtDuration(ms: number): string {
	if (ms <= 0) return "now";
	const m = Math.floor(ms / 60_000);
	if (m < 1) return `${Math.floor(ms / 1000)}s`;
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
	return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ""}`;
}

export function fmtReset(ts: number | undefined): string {
	if (!ts || !Number.isFinite(ts)) return "";
	const ms = ts > 1e12 ? ts : ts * 1000; // 兼容秒/毫秒两种时间戳
	const delta = ms - Date.now();
	return delta <= 0 ? "已重置" : `↻ ${fmtDuration(delta)}`;
}

export function fmtMetricValue(value: unknown, unit: string | undefined): string {
	if (typeof value === "number") {
		if (unit === "usd") return `$${value.toFixed(2)}`;
		if (unit === "cny") return `¥${value.toFixed(2)}`;
		if (unit === "percent") return `${fmtCount(value)}%`;
		return fmtCount(value) + (unit ? ` ${unit}` : "");
	}
	return String(value ?? "—");
}

export function bucketFraction(b: Bucket): number | undefined {
	if (b.unit === "percent") {
		if (b.used !== undefined) return Math.min(Math.max(b.used / 100, 0), 1);
		if (b.remaining !== undefined) return Math.min(Math.max(1 - b.remaining / 100, 0), 1);
	}
	if (b.used !== undefined && b.limit !== undefined && b.limit > 0)
		return Math.min(Math.max(b.used / b.limit, 0), 1);
	return undefined;
}

export function barColor(usedFrac: number): string {
	const remaining = 1 - usedFrac;
	if (remaining >= 0.5) return "success";
	if (remaining >= 0.2) return "warning";
	return "error";
}

export function makeBar(usedFrac: number, width: number): { text: string; color: string } {
	const filled = Math.round(usedFrac * width);
	const empty = width - filled;
	const text = `${"█".repeat(Math.max(filled, 0))}${"░".repeat(Math.max(empty, 0))}`;
	return { text, color: barColor(usedFrac) };
}

export function pad(s: string, w: number): string {
	const width = displayWidth(s);
	if (width >= w) return s.slice(0, Math.max(0, w - 1)) + "…";
	return s + " ".repeat(w - width);
}

/** 近似显示宽度：CJK / 全角字符计 2，其余计 1（避免引入运行时依赖） */
export function displayWidth(s: string): number {
	let width = 0;
	for (const ch of s) {
		const code = ch.codePointAt(0) ?? 0;
		width +=
			(ch >= "\u0300" && ch <= "\u036f") || // 组合附标不算宽
			(code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)))
				? 2
				: 1;
	}
	return width;
}

export function padEndWidth(s: string, w: number): string {
	const width = displayWidth(s);
	return width >= w ? s : s + " ".repeat(w - width);
}

