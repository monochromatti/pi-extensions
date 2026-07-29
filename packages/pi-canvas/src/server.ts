import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanvasCsp } from "./assets.ts";
import { appendComment, buildSelectionComment } from "./comments.ts";
import {
	pushAttentionEvent,
	pushCheckpointEvent,
	type AttentionPolicy,
	type CanvasCheckpointEvent,
} from "./events.ts";
import { getQueuedPatches, subscribeToPatches, type CanvasPatch } from "./render.ts";
import type { CanvasSessionState } from "./session.ts";
import { mergeQuietSignals } from "./signals.ts";

const extensionDir = path.dirname(fileURLToPath(new URL("../index.ts", import.meta.url)));
const staticDir = path.join(extensionDir, "static");
const shellPath = path.join(staticDir, "index.html");
const STATIC_ASSETS: Record<string, { filePath: string; contentType: string }> = {
	"/styles.css": {
		filePath: path.join(staticDir, "styles.css"),
		contentType: "text/css; charset=utf-8",
	},
	"/fonts.css": {
		filePath: path.join(staticDir, "fonts.css"),
		contentType: "text/css; charset=utf-8",
	},
	"/client.js": {
		filePath: path.join(staticDir, "client.js"),
		contentType: "application/javascript; charset=utf-8",
	},
	"/components.js": {
		filePath: path.join(staticDir, "components.js"),
		contentType: "application/javascript; charset=utf-8",
	},
};

export type CanvasServerRuntime = {
	host: "127.0.0.1";
	port: number;
	baseUrl: string;
	url: string;
	stop: () => Promise<void>;
};

export type CheckpointCallback = (summary: string, event: CanvasCheckpointEvent) => void | Promise<void>;

export type CanvasServerOptions = {
	attentionPolicy?: AttentionPolicy;
	onCheckpoint?: CheckpointCallback;
	formatCheckpointSummary?: (event: CanvasCheckpointEvent) => string;
};

export async function startCanvasServer(session: CanvasSessionState, options?: CanvasServerOptions): Promise<CanvasServerRuntime> {
	const shellHtml = await readFile(shellPath, "utf8");
	const csp = buildCanvasCsp();
	const host = "127.0.0.1" as const;

	const sseStreams = new Set<ServerResponse>();
	const server = createServer((req, res) => {
		void handleRequest(req, res, session, shellHtml, csp, sseStreams, options).catch((error) => {
			res.statusCode = 500;
			res.setHeader("content-type", "application/json; charset=utf-8");
			res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
		});
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, host, () => {
		server.off("error", listening.reject);
		listening.resolve();
	});
	await listening.promise;

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Canvas server failed to bind to TCP address");
	}

	const port = address.port;
	const baseUrl = `http://${host}:${port}`;
	const url = `${baseUrl}/?token=${encodeURIComponent(session.token)}`;

	session.server.port = port;
	session.server.url = url;

	return {
		host,
		port,
		baseUrl,
		url,
		stop: async () => {
			for (const waiter of [...session.waiters]) {
				waiter.resolve({ timeout: true });
			}
			session.render.subscribers.clear();
			const closed = Promise.withResolvers<void>();
			server.close((error) => {
				if (error) {
					closed.reject(error);
					return;
				}
				closed.resolve();
			});
			// After close(): end live SSE responses explicitly (Bun's
			// closeAllConnections doesn't reach them and would hang the close
			// callback), then drop remaining keep-alive connections. Calling
			// closeAllConnections before close() breaks under Bun with
			// ERR_SERVER_NOT_RUNNING.
			for (const stream of [...sseStreams]) {
				stream.destroy();
			}
			server.closeAllConnections?.();
			await closed.promise;
			session.server.port = undefined;
			session.server.url = undefined;
		},
	};
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	session: CanvasSessionState,
	shellHtml: string,
	csp: string,
	sseStreams: Set<ServerResponse>,
	options?: CanvasServerOptions,
): Promise<void> {
	const method = req.method ?? "GET";
	const parsed = new URL(req.url ?? "/", "http://127.0.0.1");

	if (method === "GET" && parsed.pathname === "/") {
		if (!isAuthorized(req, parsed, session.token)) {
			respondUnauthorized(res);
			return;
		}

		res.statusCode = 200;
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("content-security-policy", csp);
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("set-cookie", `canvas_token=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Strict`);
		res.end(shellHtml);
		return;
	}

	if (method === "GET" && STATIC_ASSETS[parsed.pathname]) {
		if (!isAuthorized(req, parsed, session.token)) {
			respondUnauthorized(res);
			return;
		}

		const asset = STATIC_ASSETS[parsed.pathname];
		const content = await readFile(asset.filePath);
		res.statusCode = 200;
		res.setHeader("content-type", asset.contentType);
		res.setHeader("cache-control", "no-store");
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("content-security-policy", csp);
		res.setHeader("referrer-policy", "no-referrer");
		res.end(content);
		return;
	}

	if (method === "GET" && parsed.pathname === "/patches") {
		if (!isAuthorized(req, parsed, session.token)) {
			respondUnauthorized(res);
			return;
		}

		const afterId = Number.parseInt(parsed.searchParams.get("after") ?? "0", 10);
		respondJson(res, csp, {
			ok: true,
			patches: getQueuedPatches(session, { afterId: Number.isFinite(afterId) ? afterId : 0 }),
		});
		return;
	}

	if (method === "GET" && parsed.pathname === "/stream") {
		if (!isAuthorized(req, parsed, session.token)) {
			respondUnauthorized(res);
			return;
		}

		const afterId = Number.parseInt(parsed.searchParams.get("after") ?? "0", 10);
		startPatchStream(req, res, session, csp, Number.isFinite(afterId) ? afterId : 0, sseStreams);
		return;
	}

	if (method === "POST" && parsed.pathname === "/sync") {
		if (!isAllowedMutationOrigin(req)) {
			respondForbiddenOrigin(res);
			return;
		}

		if (!isAuthorized(req, parsed, session.token)) {
			respondUnauthorized(res);
			return;
		}

		const body = await readJsonBody(req);
		mergeQuietSignals(session, extractSignals(body));

		respondJson(res, csp, { ok: true });
		return;
	}

	if (method === "POST" && parsed.pathname === "/comment") {
		if (!isAllowedMutationOrigin(req)) {
			respondForbiddenOrigin(res);
			return;
		}

		if (!isAuthorized(req, parsed, session.token)) {
			respondUnauthorized(res);
			return;
		}

		const body = await readJsonBody(req);
		const comment = buildSelectionComment(session, body);
		if (!comment) {
			respondJson(res, csp, { ok: false, error: "invalid_comment" }, 400);
			return;
		}

		const comments = appendComment(session, comment);
		let event;
		let delivered = true;
		try {
			event = await pushAttentionEvent(
				session,
				{
					name: "comment",
					payload: comment,
					signals: { ...session.signals },
					source: "selection-comment",
				},
				options?.attentionPolicy,
			);
		} catch {
			// Log comment even when host delivery fails; agent can recover from signals.
			delivered = false;
		}

		respondJson(res, csp, { ok: true, comment, comments, delivered, ...(event ? { event } : {}) });
		return;
	}

	const checkpointName = readEventName(parsed.pathname, "/event/checkpoint/");
	if (method === "POST" && checkpointName) {
		if (!isAllowedMutationOrigin(req)) {
			respondForbiddenOrigin(res);
			return;
		}

		if (!isAuthorized(req, parsed, session.token)) {
			respondUnauthorized(res);
			return;
		}

		const body = await readJsonBody(req);
		mergeQuietSignals(session, extractSignals(body));
		const { event, consumedByWaiter } = pushCheckpointEvent(session, {
			name: checkpointName,
			payload: extractPayload(body),
			signals: { ...session.signals },
		});

		// A pending wait_for_event already delivered this event to the agent;
		// posting a transcript message too would double-deliver it.
		if (!consumedByWaiter && options?.onCheckpoint) {
			const summary = options.formatCheckpointSummary?.(event) ?? `Canvas checkpoint: ${event.name}`;
			await options.onCheckpoint(summary, event);
		}

		respondJson(res, csp, { ok: true, event });
		return;
	}

	const attentionName = readEventName(parsed.pathname, "/event/attention/");
	if (method === "POST" && attentionName) {
		if (!isAllowedMutationOrigin(req)) {
			respondForbiddenOrigin(res);
			return;
		}

		if (!isAuthorized(req, parsed, session.token)) {
			respondUnauthorized(res);
			return;
		}

		const body = await readJsonBody(req);
		mergeQuietSignals(session, extractSignals(body));
		const event = await pushAttentionEvent(
			session,
			{
				name: attentionName,
				payload: extractPayload(body),
				signals: { ...session.signals },
				source: "control",
			},
			options?.attentionPolicy,
		);

		respondJson(res, csp, { ok: true, event });
		return;
	}

	res.statusCode = 404;
	res.setHeader("content-type", "text/plain; charset=utf-8");
	res.end("not found");
}

function isAuthorized(req: IncomingMessage, parsed: URL, token: string): boolean {
	const queryToken = parsed.searchParams.get("token");
	if (queryToken === token) return true;

	const headerToken = req.headers["x-canvas-token"];
	if (typeof headerToken === "string" && headerToken === token) return true;
	if (Array.isArray(headerToken) && headerToken.includes(token)) return true;

	const cookieToken = readCookie(req.headers.cookie, "canvas_token");
	if (cookieToken === token) return true;

	return false;
}

function respondUnauthorized(res: ServerResponse): void {
	res.statusCode = 401;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
}

function respondForbiddenOrigin(res: ServerResponse): void {
	res.statusCode = 403;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify({ ok: false, error: "forbidden_origin" }));
}

function respondJson(res: ServerResponse, csp: string, payload: unknown, status = 200): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("content-security-policy", csp);
	res.setHeader("referrer-policy", "no-referrer");
	res.end(JSON.stringify(payload));
}

const STREAM_HEARTBEAT_MS = 15_000;

function startPatchStream(
	req: IncomingMessage,
	res: ServerResponse,
	session: CanvasSessionState,
	csp: string,
	afterId: number,
	sseStreams: Set<ServerResponse>,
): void {
	res.statusCode = 200;
	res.setHeader("content-type", "text/event-stream");
	res.setHeader("cache-control", "no-store");
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("content-security-policy", csp);
	res.setHeader("referrer-policy", "no-referrer");
	res.flushHeaders?.();

	let lastSentId = afterId;
	const sendPatch = (patch: CanvasPatch) => {
		if (patch.id <= lastSentId) return;
		lastSentId = patch.id;
		res.write(`event: patch\nid: ${patch.id}\ndata: ${JSON.stringify(patch)}\n\n`);
	};

	// Node runs this synchronously, so no patch can slip between the backlog
	// replay and the live subscription; the id guard in sendPatch keeps the
	// stream idempotent regardless.
	const unsubscribe = subscribeToPatches(session, sendPatch);
	for (const patch of getQueuedPatches(session, { afterId })) {
		sendPatch(patch);
	}

	const heartbeat = setInterval(() => {
		res.write(":ping\n\n");
	}, STREAM_HEARTBEAT_MS);
	heartbeat.unref?.();

	sseStreams.add(res);
	const cleanup = () => {
		sseStreams.delete(res);
		clearInterval(heartbeat);
		unsubscribe();
	};
	res.once("close", cleanup);
	req.once("close", cleanup);
}

function isAllowedMutationOrigin(req: IncomingMessage): boolean {
	const originHeader = req.headers.origin;
	if (!originHeader) return true;

	const originValue = Array.isArray(originHeader) ? originHeader[0] : originHeader;
	if (!originValue) return true;

	const hostHeader = req.headers.host;
	if (!hostHeader) return false;

	try {
		const origin = new URL(originValue);
		const requestUrl = new URL(`http://${hostHeader}`);
		if (!isLoopbackHost(origin.hostname) || !isLoopbackHost(requestUrl.hostname)) return false;
		return origin.host === requestUrl.host;
	} catch {
		return false;
	}
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "localhost";
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB cap on canvas POST payloads

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) {
			req.destroy();
			throw new Error("payload_too_large");
		}
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractSignals(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== "object") return {};
	const envelope = body as { signals?: unknown };
	if (envelope.signals && typeof envelope.signals === "object" && !Array.isArray(envelope.signals)) {
		return { ...(envelope.signals as Record<string, unknown>) };
	}
	if (!Array.isArray(body)) {
		return { ...(body as Record<string, unknown>) };
	}
	return {};
}

function extractPayload(body: unknown): unknown {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	return (body as { payload?: unknown }).payload;
}

function readEventName(pathname: string, prefix: string): string | undefined {
	if (!pathname.startsWith(prefix)) return undefined;
	const rawName = pathname.slice(prefix.length);
	if (!rawName) return undefined;
	try {
		return decodeURIComponent(rawName);
	} catch {
		return rawName;
	}
}

function readCookie(cookieHeader: string | string[] | undefined, name: string): string | undefined {
	if (!cookieHeader) return undefined;
	const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
	for (const entry of raw.split(";")) {
		const [rawKey, ...rest] = entry.trim().split("=");
		if (rawKey !== name) continue;
		const rawValue = rest.join("=");
		try {
			return decodeURIComponent(rawValue);
		} catch {
			return rawValue;
		}
	}
	return undefined;
}
