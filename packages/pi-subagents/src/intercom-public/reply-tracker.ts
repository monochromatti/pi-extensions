import type { DeliveredMessage, IdentitySnapshotReconnectPolicy, IdentitySnapshotTarget, SessionInfo } from "./types.ts";

export interface IntercomContext {
  from: SessionInfo;
  message: DeliveredMessage;
  receivedAt: number;
  replyTarget: IdentitySnapshotTarget;
}

function contextLabel(context: IntercomContext): string {
  return `${context.message.id} from ${context.from.alias ?? context.from.id} (${context.from.id})`;
}

function buildReplyTarget(
  from: SessionInfo,
  reconnect: IdentitySnapshotReconnectPolicy,
): IdentitySnapshotTarget {
  return {
    kind: "identity-snapshot",
    intercomSessionId: from.id,
    piSessionId: from.piSessionId,
    reconnect,
    ...(from.alias ? { alias: from.alias } : {}),
  };
}

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly hostDeliveredAsks = new Set<string>();
  private readonly pendingTurnContexts: IntercomContext[] = [];
  private currentTurnContext: IntercomContext | null = null;

  constructor(private readonly askTimeoutMs = 10 * 60 * 1000) {}

  recordIncomingMessage(
    from: SessionInfo,
    message: DeliveredMessage,
    receivedAt = Date.now(),
    reconnect: IdentitySnapshotReconnectPolicy = "same-pi-session-if-unique",
  ): IntercomContext {
    const context = { from, message, receivedAt, replyTarget: buildReplyTarget(from, reconnect) };
    if (message.expectsReply) {
      this.pendingAsks.set(message.id, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    this.pendingTurnContexts.push(context);
    // Runtime queues turn context only after host send accepted. Suppressed asks
    // remain visible through `pending`/explicit replyTo, but never become an
    // implicit bare-reply target.
    if (this.pendingAsks.has(context.message.id)) {
      this.hostDeliveredAsks.add(context.message.id);
    }
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    this.currentTurnContext = this.pendingTurnContexts.shift() ?? null;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.hostDeliveredAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContext = null;
  }

  resolveReplyTarget(options: { replyTo?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    if (options.replyTo) {
      const match = this.pendingAsks.get(options.replyTo);
      if (match) return match;
      if (this.currentTurnContext?.message.id === options.replyTo) return this.currentTurnContext;
      throw new Error(`No pending ask with replyTo ${options.replyTo}`);
    }

    if (this.currentTurnContext) {
      return this.currentTurnContext;
    }

    const pending = Array.from(this.pendingAsks.values());
    if (pending.length === 1) {
      const only = pending[0]!;
      if (this.hostDeliveredAsks.has(only.message.id)) {
        return only;
      }
      throw new Error(`Cannot reply implicitly: pending ask ${contextLabel(only)} was not delivered to this host chat. Specify replyTo explicitly.`);
    }

    if (pending.length === 0) {
      throw new Error("Cannot reply: no active incoming ask. Completed subagent results arrive through subagent(), not Intercom. Use subagent status or its result artifact.");
    }

    throw new Error(`Multiple pending asks — specify replyTo. Candidates: ${pending.map(contextLabel).join(", ")}`);
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    this.hostDeliveredAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.pendingAsks.delete(messageId);
        this.hostDeliveredAsks.delete(messageId);
      }
    }
  }
}
