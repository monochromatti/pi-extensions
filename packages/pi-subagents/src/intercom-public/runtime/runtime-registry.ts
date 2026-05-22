import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomRuntime } from "./intercom-runtime.ts";

export class IntercomRuntimeRegistry {
  private readonly runtimes = new Map<string, IntercomRuntime>();
  private activeHostSessionId: string | null = null;

  constructor(private readonly createRuntime: (piSessionId: string) => IntercomRuntime) {}

  get(piSessionId: string): IntercomRuntime | undefined {
    return this.runtimes.get(piSessionId);
  }

  getForContext(ctx: ExtensionContext): IntercomRuntime | undefined {
    const piSessionId = ctx.sessionManager.getSessionId();
    return this.runtimes.get(piSessionId);
  }

  canDeliverMessageToHost(runtimePiSessionId: string): boolean {
    if (!this.runtimes.has(runtimePiSessionId)) {
      return false;
    }
    if (!this.activeHostSessionId) {
      return this.runtimes.size <= 1;
    }
    return this.activeHostSessionId === runtimePiSessionId;
  }

  async startSession(event: unknown, ctx: ExtensionContext): Promise<void> {
    const piSessionId = ctx.sessionManager.getSessionId();
    this.activeHostSessionId = piSessionId;

    const existing = this.runtimes.get(piSessionId);
    if (existing) {
      await existing.emitLifecycle("session_shutdown", { type: "session_shutdown" }, ctx);
    }

    const runtime = this.createRuntime(piSessionId);
    this.runtimes.set(piSessionId, runtime);
    await runtime.emitLifecycle("session_start", event, ctx);
  }

  async shutdownSession(event: unknown, ctx: ExtensionContext): Promise<void> {
    const piSessionId = ctx.sessionManager.getSessionId();
    const runtime = this.runtimes.get(piSessionId);
    if (!runtime) {
      return;
    }

    await runtime.emitLifecycle("session_shutdown", event, ctx);
    if (this.runtimes.get(piSessionId) === runtime) {
      this.runtimes.delete(piSessionId);
    }
    if (this.activeHostSessionId === piSessionId) {
      this.activeHostSessionId = null;
    }
  }

  async forwardSessionLifecycle(eventName: string, event: unknown, ctx: ExtensionContext): Promise<void> {
    this.activeHostSessionId = ctx.sessionManager.getSessionId();
    const runtime = this.getForContext(ctx);
    if (!runtime) {
      return;
    }
    await runtime.emitLifecycle(eventName, event, ctx);
  }

  getForRelayPayload(payload: unknown): IntercomRuntime | undefined {
    const ownerPiSessionId = this.relayOwnerSessionId(payload);
    if (ownerPiSessionId === undefined) return undefined;
    return this.runtimes.get(ownerPiSessionId);
  }

  private relayOwnerSessionId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const ownerPiSessionId = (payload as { ownerPiSessionId?: unknown }).ownerPiSessionId;
    if (typeof ownerPiSessionId !== "string" || ownerPiSessionId.trim() === "") {
      return undefined;
    }
    return ownerPiSessionId;
  }
}
