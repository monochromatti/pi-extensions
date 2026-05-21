import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerSingleRuntimeIntercomExtension, { type IntercomRuntimeScheduler } from "./single-runtime-extension.ts";
import {
  registerIntercomSupervisorTargetResolver,
} from "./supervisor-target-resolver.ts";
import type { SupervisorIntercomTarget } from "../shared/types.ts";

// Tool prompt/content lives in single-runtime-extension.ts, including
// contact_supervisor reasons need_decision/progress_update and "routine completion handoffs" guidance.

const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";

type AnyTool = {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
  renderCall?: (...args: unknown[]) => unknown;
  renderResult?: (...args: unknown[]) => unknown;
};

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type EventBusHandler = (payload: unknown) => unknown;

type AnyMessageRenderer = (message: unknown, options: unknown, theme: unknown) => unknown;

interface RegisterOptions {
  schedulerFactory?: () => IntercomRuntimeScheduler;
}

interface RuntimeHostDeliveryPolicy {
  canDeliverMessageToHost: (piSessionId: string) => boolean;
}

class RuntimeTransport {
  private readonly lifecycleHandlers = new Map<string, LifecycleHandler[]>();

  registerHandler(eventName: string, handler: LifecycleHandler): void {
    const existing = this.lifecycleHandlers.get(eventName) ?? [];
    existing.push(handler);
    this.lifecycleHandlers.set(eventName, existing);
  }

  async emit(eventName: string, event: unknown, ctx: ExtensionContext): Promise<void> {
    for (const handler of this.lifecycleHandlers.get(eventName) ?? []) {
      await handler(event, ctx);
    }
  }
}

class RuntimeInbox {
  private readonly tools = new Map<string, AnyTool>();
  private readonly renderers = new Map<string, AnyMessageRenderer>();

  registerTool(tool: AnyTool): void {
    this.tools.set(tool.name, tool);
  }

  registerRenderer(name: string, renderer: AnyMessageRenderer): void {
    this.renderers.set(name, renderer);
  }

  getTool(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  getToolDefinitions(): AnyTool[] {
    return Array.from(this.tools.values());
  }

  getRenderers(): Array<{ name: string; renderer: AnyMessageRenderer }> {
    return Array.from(this.renderers.entries()).map(([name, renderer]) => ({ name, renderer }));
  }
}

class RuntimeRouter {
  private readonly eventHandlers = new Map<string, Set<EventBusHandler>>();

  constructor(private readonly emitToHost: (name: string, payload: unknown) => void) {}

  on(name: string, handler: EventBusHandler): () => void {
    const set = this.eventHandlers.get(name) ?? new Set<EventBusHandler>();
    set.add(handler);
    this.eventHandlers.set(name, set);
    return () => set.delete(handler);
  }

  emitToRuntime(name: string, payload: unknown): void {
    for (const handler of this.eventHandlers.get(name) ?? []) {
      handler(payload);
    }
  }

  emitToHostRuntime(name: string, payload: unknown): void {
    this.emitToHost(name, payload);
  }
}

class IntercomRuntime {
  readonly piSessionId: string;
  private readonly transport = new RuntimeTransport();
  private readonly inbox = new RuntimeInbox();
  private readonly router: RuntimeRouter;
  private readonly canDeliverMessageToHost: RuntimeHostDeliveryPolicy["canDeliverMessageToHost"];
  private resolveSupervisorTarget: (() => Promise<SupervisorIntercomTarget>) | null = null;

  constructor(
    private readonly hostPi: ExtensionAPI,
    piSessionId: string,
    options: {
      scheduler?: IntercomRuntimeScheduler;
      hostDeliveryPolicy?: RuntimeHostDeliveryPolicy;
    } = {},
  ) {
    this.piSessionId = piSessionId;
    this.canDeliverMessageToHost = options.hostDeliveryPolicy?.canDeliverMessageToHost ?? (() => true);
    this.router = new RuntimeRouter((name, payload) => this.hostPi.events.emit(name, payload));

    registerSingleRuntimeIntercomExtension({
      registerTool: (tool) => {
        this.inbox.registerTool(tool as unknown as AnyTool);
      },
      on: (event, handler) => {
        this.transport.registerHandler(event, handler as LifecycleHandler);
      },
      registerMessageRenderer: (name, renderer) => {
        this.inbox.registerRenderer(name, renderer as unknown as AnyMessageRenderer);
      },
      events: {
        on: (name, handler) => this.router.on(name, handler as EventBusHandler),
        emit: (name, payload) => {
          this.router.emitToHostRuntime(name, payload);
        },
      },
      sendMessage: (message, sendOptions) => {
        if (!this.canDeliverMessageToHost(this.piSessionId)) {
          return undefined;
        }
        return this.hostPi.sendMessage(message, sendOptions);
      },
      appendEntry: (...args) => this.hostPi.appendEntry(...args),
      getSessionName: () => this.hostPi.getSessionName(),
    } as unknown as ExtensionAPI, {
      scheduler: options.scheduler,
      onSupervisorTargetResolver: (resolver) => {
        this.resolveSupervisorTarget = resolver;
      },
    });
  }

  async getSupervisorTarget(): Promise<SupervisorIntercomTarget> {
    if (!this.resolveSupervisorTarget) {
      throw new Error("Intercom runtime cannot resolve supervisor target");
    }
    return this.resolveSupervisorTarget();
  }

  getTool(name: string): AnyTool | undefined {
    return this.inbox.getTool(name);
  }

  getToolDefinitions(): AnyTool[] {
    return this.inbox.getToolDefinitions();
  }

  getRenderers(): Array<{ name: string; renderer: AnyMessageRenderer }> {
    return this.inbox.getRenderers();
  }

  async emitLifecycle(eventName: string, event: unknown, ctx: ExtensionContext): Promise<void> {
    await this.transport.emit(eventName, event, ctx);
  }

  emitEvent(name: string, payload: unknown): void {
    this.router.emitToRuntime(name, payload);
  }
}

function runtimeMissingResult(sessionId: string) {
  return {
    content: [{ type: "text", text: `Intercom runtime unavailable for session ${sessionId}` }],
    isError: true,
    details: { error: true },
  };
}

export function createIntercomExtension(options: RegisterOptions = {}) {
  return function registerIntercomExtension(pi: ExtensionAPI): void {
    const runtimes = new Map<string, IntercomRuntime>();
    let activeHostSessionId: string | null = null;

    registerIntercomSupervisorTargetResolver(pi, {
      async getSupervisorTarget(piSessionId: string): Promise<SupervisorIntercomTarget> {
        const runtime = runtimes.get(piSessionId);
        if (!runtime) {
          throw new Error(`Intercom runtime unavailable for session ${piSessionId}`);
        }
        return runtime.getSupervisorTarget();
      },
    });

    const canDeliverMessageToHost = (runtimePiSessionId: string): boolean => {
      if (!runtimes.has(runtimePiSessionId)) {
        return false;
      }
      if (!activeHostSessionId) {
        return runtimes.size <= 1;
      }
      return activeHostSessionId === runtimePiSessionId;
    };

    const createRuntime = (piSessionId: string) => new IntercomRuntime(pi, piSessionId, {
      scheduler: options.schedulerFactory?.(),
      hostDeliveryPolicy: {
        canDeliverMessageToHost,
      },
    });
    const prototypeRuntime = createRuntime("prototype-session");

    const resolveRuntimeForContext = (ctx: ExtensionContext): IntercomRuntime | undefined => {
      const piSessionId = ctx.sessionManager.getSessionId();
      return runtimes.get(piSessionId);
    };

    for (const { name, renderer } of prototypeRuntime.getRenderers()) {
      pi.registerMessageRenderer(name, renderer as never);
    }

    for (const tool of prototypeRuntime.getToolDefinitions()) {
      const { execute, ...rest } = tool;
      pi.registerTool({
        ...rest,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const runtime = resolveRuntimeForContext(ctx);
          if (!runtime) {
            return runtimeMissingResult(ctx.sessionManager.getSessionId());
          }
          const runtimeTool = runtime.getTool(tool.name);
          if (!runtimeTool) {
            return {
              content: [{ type: "text", text: `Tool ${tool.name} is unavailable for this session` }],
              isError: true,
              details: { error: true },
            };
          }
          return runtimeTool.execute(toolCallId, params as Record<string, unknown>, signal, onUpdate, ctx);
        },
      } as never);
    }

    const markHostSessionActive = (ctx: ExtensionContext): void => {
      activeHostSessionId = ctx.sessionManager.getSessionId();
    };

    pi.on("session_start", async (event, ctx) => {
      const piSessionId = ctx.sessionManager.getSessionId();
      markHostSessionActive(ctx);
      const existing = runtimes.get(piSessionId);
      if (existing) {
        await existing.emitLifecycle("session_shutdown", { type: "session_shutdown" }, ctx);
      }
      const runtime = createRuntime(piSessionId);
      runtimes.set(piSessionId, runtime);
      await runtime.emitLifecycle("session_start", event, ctx);
    });

    pi.on("session_shutdown", async (event, ctx) => {
      const piSessionId = ctx.sessionManager.getSessionId();
      const runtime = runtimes.get(piSessionId);
      if (!runtime) {
        return;
      }
      await runtime.emitLifecycle("session_shutdown", event, ctx);
      if (runtimes.get(piSessionId) === runtime) {
        runtimes.delete(piSessionId);
      }
      if (activeHostSessionId === piSessionId) {
        activeHostSessionId = null;
      }
    });

    const forwardSessionEvent = (name: string) => {
      pi.on(name as never, async (event, ctx) => {
        markHostSessionActive(ctx);
        const runtime = resolveRuntimeForContext(ctx);
        if (!runtime) {
          return;
        }
        await runtime.emitLifecycle(name, event, ctx);
      });
    };

    forwardSessionEvent("turn_start");
    forwardSessionEvent("turn_end");
    forwardSessionEvent("agent_start");
    forwardSessionEvent("tool_execution_start");
    forwardSessionEvent("tool_execution_end");
    forwardSessionEvent("agent_end");
    forwardSessionEvent("model_select");

    const relayOwnerSessionId = (payload: unknown): string | undefined => {
      if (!payload || typeof payload !== "object") {
        return undefined;
      }
      const ownerPiSessionId = (payload as { ownerPiSessionId?: unknown }).ownerPiSessionId;
      if (typeof ownerPiSessionId !== "string" || ownerPiSessionId.trim() === "") {
        return undefined;
      }
      return ownerPiSessionId;
    };

    const selectRuntimeForRelayEvent = (payload: unknown): IntercomRuntime | undefined => {
      const ownerPiSessionId = relayOwnerSessionId(payload);
      if (ownerPiSessionId === undefined) return undefined;
      return runtimes.get(ownerPiSessionId);
    };

    pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
      const runtime = selectRuntimeForRelayEvent(payload);
      if (!runtime) {
        return;
      }
      runtime.emitEvent(SUBAGENT_CONTROL_INTERCOM_EVENT, payload);
    });

    pi.events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
      const runtime = selectRuntimeForRelayEvent(payload);
      if (!runtime) {
        return;
      }
      runtime.emitEvent(SUBAGENT_RESULT_INTERCOM_EVENT, payload);
    });
  };
}

export type { IntercomRuntimeScheduler };

export default createIntercomExtension();
