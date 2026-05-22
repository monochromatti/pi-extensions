import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type IntercomRuntimeScheduler } from "./single-runtime-extension.ts";
import { registerIntercomSupervisorTargetResolver } from "./supervisor-target-resolver.ts";
import type { SupervisorIntercomTarget } from "../shared/types.ts";
import {
  IntercomRuntime,
  runtimeMissingResult,
} from "./runtime/intercom-runtime.ts";
import { IntercomRuntimeRegistry } from "./runtime/runtime-registry.ts";

// Tool prompt/content lives in single-runtime-extension.ts, including
// contact_supervisor reasons need_decision/progress_update and "routine completion handoffs" guidance.

const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";

interface RegisterOptions {
  schedulerFactory?: () => IntercomRuntimeScheduler;
}

export function createIntercomExtension(options: RegisterOptions = {}) {
  return function registerIntercomExtension(pi: ExtensionAPI): void {
    let runtimeRegistry: IntercomRuntimeRegistry;
    const createRuntime = (piSessionId: string) => new IntercomRuntime(pi, piSessionId, {
      scheduler: options.schedulerFactory?.(),
      hostDeliveryPolicy: {
        canDeliverMessageToHost: (runtimePiSessionId) => runtimeRegistry.canDeliverMessageToHost(runtimePiSessionId),
      },
    });
    runtimeRegistry = new IntercomRuntimeRegistry(createRuntime);

    registerIntercomSupervisorTargetResolver(pi, {
      async getSupervisorTarget(piSessionId: string): Promise<SupervisorIntercomTarget> {
        const runtime = runtimeRegistry.get(piSessionId);
        if (!runtime) {
          throw new Error(`Intercom runtime unavailable for session ${piSessionId}`);
        }
        return runtime.getSupervisorTarget();
      },
    });

    const prototypeRuntime = createRuntime("prototype-session");

    for (const { name, renderer } of prototypeRuntime.getRenderers()) {
      pi.registerMessageRenderer(name, renderer as never);
    }

    for (const tool of prototypeRuntime.getToolDefinitions()) {
      pi.registerTool({
        ...tool,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const runtime = runtimeRegistry.getForContext(ctx);
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

    pi.on("session_start", async (event, ctx) => {
      await runtimeRegistry.startSession(event, ctx);
    });

    pi.on("session_shutdown", async (event, ctx) => {
      await runtimeRegistry.shutdownSession(event, ctx);
    });

    const lifecycleEvents = [
      "turn_start",
      "turn_end",
      "agent_start",
      "tool_execution_start",
      "tool_execution_end",
      "agent_end",
      "model_select",
    ];

    for (const eventName of lifecycleEvents) {
      pi.on(eventName as never, async (event, ctx) => {
        await runtimeRegistry.forwardSessionLifecycle(eventName, event, ctx);
      });
    }

    pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
      const runtime = runtimeRegistry.getForRelayPayload(payload);
      if (!runtime) {
        return;
      }
      runtime.emitEvent(SUBAGENT_CONTROL_INTERCOM_EVENT, payload);
    });

    pi.events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
      const runtime = runtimeRegistry.getForRelayPayload(payload);
      if (!runtime) {
        return;
      }
      runtime.emitEvent(SUBAGENT_RESULT_INTERCOM_EVENT, payload);
    });
  };
}

export type { IntercomRuntimeScheduler };

export default createIntercomExtension();
