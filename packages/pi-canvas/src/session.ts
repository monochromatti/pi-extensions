import { randomBytes } from "node:crypto";
import type { CanvasCheckpointEvent, CanvasEventWaiter } from "./events.ts";
import { createRenderRuntime, type CanvasRenderRuntime } from "./render.ts";

export type CanvasSessionState = {
	token: string;
	signals: Record<string, unknown>;
	eventQueue: CanvasCheckpointEvent[];
	waiters: CanvasEventWaiter[];
	server: {
		url?: string;
		port?: number;
	};
	render: CanvasRenderRuntime;
};

export function createCanvasSession(input?: { token?: string }): CanvasSessionState {
	return {
		token: input?.token ?? randomBytes(16).toString("hex"),
		signals: {},
		eventQueue: [],
		waiters: [],
		server: {},
		render: createRenderRuntime(),
	};
}
