import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomRuntime } from "./intercom-runtime.ts";

export class IntercomRuntimeRegistry {
  private readonly runtimes = new Map<string, IntercomRuntime>();

  constructor(private readonly createRuntime: (piSessionId: string) => IntercomRuntime) {}

  get(piSessionId: string): IntercomRuntime | undefined {
    return this.runtimes.get(piSessionId);
  }

  getForContext(ctx: ExtensionContext): IntercomRuntime | undefined {
    const piSessionId = ctx.sessionManager.getSessionId();
    return this.runtimes.get(piSessionId);
  }

  canDeliverMessageToHost(runtimePiSessionId: string): boolean {
    // ExtensionAPI.sendMessage() has no session target. Lifecycle activity cannot
    // prove which chat owns that shared host call, so fail closed when multiple
    // session runtimes exist. Normal /new, /resume, /fork, and shutdown flows emit
    // session_shutdown before the next session_start, leaving one runtime; more
    // than one runtime means an overlapping/abnormal host state we cannot address
    // safely through ExtensionAPI.
    return this.runtimes.size === 1 && this.runtimes.has(runtimePiSessionId);
  }

  async startSession(event: unknown, ctx: ExtensionContext): Promise<void> {
    const piSessionId = ctx.sessionManager.getSessionId();

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
  }

  async forwardSessionLifecycle(eventName: string, event: unknown, ctx: ExtensionContext): Promise<void> {
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
