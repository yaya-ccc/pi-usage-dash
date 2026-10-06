export interface Bucket {
	id?: string;
	label: string;
	unit?: string;
	used?: number;
	limit?: number;
	remaining?: number;
	resetsAt?: number;
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

