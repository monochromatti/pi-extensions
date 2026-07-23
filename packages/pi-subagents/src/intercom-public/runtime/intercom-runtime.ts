import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerSingleRuntimeIntercomExtension, { type IntercomRuntimeScheduler } from "../single-runtime-extension.ts";
import type { SupervisorIntercomTarget } from "../../shared/types.ts";

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type EventBusHandler = (payload: unknown) => unknown;

export type IntercomRuntimeTool = {
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

export type IntercomMessageRenderer = (message: unknown, options: unknown, theme: unknown) => unknown;

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
  private readonly tools = new Map<string, IntercomRuntimeTool>();
  private readonly renderers = new Map<string, IntercomMessageRenderer>();

  registerTool(tool: IntercomRuntimeTool): void {
    this.tools.set(tool.name, tool);
  }

  registerRenderer(name: string, renderer: IntercomMessageRenderer): void {
    this.renderers.set(name, renderer);
  }

  getTool(name: string): IntercomRuntimeTool | undefined {
    return this.tools.get(name);
  }

  getToolDefinitions(): IntercomRuntimeTool[] {
    return Array.from(this.tools.values());
  }

  getRenderers(): Array<{ name: string; renderer: IntercomMessageRenderer }> {
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

export class IntercomRuntime {
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
        this.inbox.registerTool(tool as unknown as IntercomRuntimeTool);
      },
      on: (event, handler) => {
        this.transport.registerHandler(event, handler as LifecycleHandler);
      },
      registerMessageRenderer: (name, renderer) => {
        this.inbox.registerRenderer(name, renderer as unknown as IntercomMessageRenderer);
      },
      events: {
        on: (name, handler) => this.router.on(name, handler as EventBusHandler),
        emit: (name, payload) => {
          this.router.emitToHostRuntime(name, payload);
        },
      },
      sendMessage: (message, sendOptions) => {
        if (!this.canDeliverMessageToHost(this.piSessionId)) {
          // Private adapter contract: false means host delivery was suppressed.
          // ExtensionAPI itself returns void, so any other result means accepted.
          return false;
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

  getTool(name: string): IntercomRuntimeTool | undefined {
    return this.inbox.getTool(name);
  }

  getToolDefinitions(): IntercomRuntimeTool[] {
    return this.inbox.getToolDefinitions();
  }

  getRenderers(): Array<{ name: string; renderer: IntercomMessageRenderer }> {
    return this.inbox.getRenderers();
  }

  async emitLifecycle(eventName: string, event: unknown, ctx: ExtensionContext): Promise<void> {
    await this.transport.emit(eventName, event, ctx);
  }

  emitEvent(name: string, payload: unknown): void {
    this.router.emitToRuntime(name, payload);
  }
}

export function runtimeMissingResult(sessionId: string) {
  return {
    content: [{ type: "text", text: `Intercom runtime unavailable for session ${sessionId}` }],
    isError: true,
    details: { error: true },
  };
}
