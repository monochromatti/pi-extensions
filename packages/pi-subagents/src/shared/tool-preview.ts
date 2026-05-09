export function extractToolArgsPreview(args: Record<string, unknown>): string {
	const truncatePreview = (value: string, maxLength: number): string =>
		value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;

	const stringifyPreviewValue = (value: unknown): string | undefined => {
		if (typeof value === "string" && value.trim().length > 0) return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		return undefined;
	};

	const previewArray = (value: unknown): string | undefined => {
		if (!Array.isArray(value) || value.length === 0) return undefined;
		const first = stringifyPreviewValue(value[0]);
		if (!first) return undefined;
		const suffix = value.length > 1 ? ` (+${value.length - 1} more)` : "";
		return `${first}${suffix}`;
	};

	if (args.tool && typeof args.tool === "string") {
		const server = args.server && typeof args.server === "string" ? `${args.server}/` : "";
		const toolArgs = args.args && typeof args.args === "string" ? ` ${args.args.slice(0, 40)}` : "";
		return `${server}${args.tool}${toolArgs}`;
	}

	const queriesPreview = previewArray(args.queries);
	if (queriesPreview) return truncatePreview(queriesPreview, 60);
	if (typeof args.query === "string" && args.query.trim().length > 0) return truncatePreview(args.query, 60);
	if (typeof args.workflow === "string" && args.workflow.trim().length > 0) return `workflow=${truncatePreview(args.workflow, 48)}`;

	if (typeof args.url === "string" && args.url.trim().length > 0) return truncatePreview(args.url, 60);
	const urlsPreview = previewArray(args.urls);
	if (urlsPreview) return truncatePreview(urlsPreview, 60);
	if (typeof args.prompt === "string" && args.prompt.trim().length > 0) return truncatePreview(args.prompt, 60);

	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task", "describe", "search"];
	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return truncatePreview(value, 60);
		}
	}

	for (const [key, value] of Object.entries(args)) {
		const arrayPreview = previewArray(value);
		if (arrayPreview) return `${key}=${truncatePreview(arrayPreview, 50)}`;
		if (typeof value === "string" && value.length > 0) {
			const preview = truncatePreview(value, 50);
			return `${key}=${preview}`;
		}
	}
	return "";
}
