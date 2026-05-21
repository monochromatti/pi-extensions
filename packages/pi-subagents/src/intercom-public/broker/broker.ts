import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import { getBrokerSocketDir, getBrokerSocketPath } from "./paths.ts";
import type {
  SessionInfo,
  SessionReadiness,
  SessionSubagentMetadata,
  Message,
  Attachment,
  BrokerMessage,
  SendTargetEnvelope,
} from "../types.ts";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const attachment = value as Record<string, unknown>;

  if (
    attachment.type !== "file"
    && attachment.type !== "snippet"
    && attachment.type !== "context"
  ) {
    return false;
  }

  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }

  return attachment.language === undefined || typeof attachment.language === "string";
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }

  if (message.to !== undefined) {
    if (typeof message.to !== "object" || message.to === null) {
      return false;
    }

    const to = message.to as Record<string, unknown>;
    if (to.intercomSessionId !== undefined && typeof to.intercomSessionId !== "string") {
      return false;
    }
    if (to.piSessionId !== undefined && typeof to.piSessionId !== "string") {
      return false;
    }
    if (to.alias !== undefined && typeof to.alias !== "string") {
      return false;
    }
  }

  if (message.replyTo !== undefined && typeof message.replyTo !== "string") {
    return false;
  }

  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") {
    return false;
  }

  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }

  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") {
    return false;
  }

  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

function isSendTargetEnvelope(value: unknown): value is SendTargetEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const target = value as Record<string, unknown>;
  if (target.intercomSessionId !== undefined && typeof target.intercomSessionId !== "string") {
    return false;
  }
  if (target.piSessionId !== undefined && typeof target.piSessionId !== "string") {
    return false;
  }
  if (target.alias !== undefined && typeof target.alias !== "string") {
    return false;
  }
  if (target.namespace !== undefined && typeof target.namespace !== "string") {
    return false;
  }

  return true;
}

function isSessionReadiness(value: unknown): value is SessionReadiness {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const readiness = value as Record<string, unknown>;
  if (
    readiness.state !== "initializing"
    && readiness.state !== "ready"
    && readiness.state !== "stopping"
  ) {
    return false;
  }
  if (readiness.reason !== undefined && typeof readiness.reason !== "string") {
    return false;
  }
  return typeof readiness.updatedAt === "number";
}

function isSessionSubagentMetadata(value: unknown): value is SessionSubagentMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const subagent = value as Record<string, unknown>;
  return typeof subagent.ownerPiSessionId === "string"
    && typeof subagent.runId === "string"
    && typeof subagent.agent === "string"
    && typeof subagent.index === "number"
    && Number.isInteger(subagent.index)
    && subagent.index >= 0;
}

function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) {
    return false;
  }

  if (session.name !== undefined && typeof session.name !== "string") {
    return false;
  }

  if (session.namespace !== undefined && typeof session.namespace !== "string") {
    return false;
  }

  if (session.piSessionId !== undefined && typeof session.piSessionId !== "string") {
    return false;
  }
  if (session.protocolVersion !== undefined && typeof session.protocolVersion !== "number") {
    return false;
  }
  if (session.capabilities !== undefined && (!Array.isArray(session.capabilities) || !session.capabilities.every(capability => typeof capability === "string"))) {
    return false;
  }
  if (session.readiness !== undefined && !isSessionReadiness(session.readiness)) {
    return false;
  }
  if (session.subagent !== undefined && !isSessionSubagentMetadata(session.subagent)) {
    return false;
  }

  return session.status === undefined || typeof session.status === "string";
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true });
    mkdirSync(getBrokerSocketDir(SOCKET_PATH), { recursive: true });
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(SOCKET_PATH, () => {
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Intercom broker started (pid: ${process.pid})`);
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg, sessionId, (id) => {
        sessionId = id;
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.broadcast({ type: "session_left", sessionId }, sessionId);

        this.scheduleShutdownCheck();
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
  }

  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (currentId) {
          throw new Error("Received duplicate register message");
        }
        
        const id = randomUUID();
        setId(id);
        const info: SessionInfo = {
          ...clientMessage.session,
          id,
          piSessionId: clientMessage.session.piSessionId ?? `legacy:${id}`,
          protocolVersion: clientMessage.session.protocolVersion ?? 1,
          capabilities: clientMessage.session.capabilities ?? [],
        };
        this.sessions.set(id, { socket, info });
        
        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, { type: "registered", sessionId: id });
        this.broadcast({ type: "session_joined", session: info }, id);
        break;
      }

      case "unregister": {
        this.sessions.delete(currentId);
        this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
        setId(null);
        this.scheduleShutdownCheck();
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }

        const sessions = Array.from(this.sessions.values()).map(s => s.info);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "send": {
        const message = clientMessage.message;
        const messageId = isMessage(message) ? message.id : "unknown";

        if (!isMessage(message) || (typeof clientMessage.to !== "string" && !isSendTargetEnvelope(clientMessage.to))) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId,
            reason: "Invalid message format",
          });
          break;
        }

        const fromSession = this.sessions.get(currentId);
        if (!fromSession) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: "Sender session not found",
          });
          break;
        }

        const resolvedTarget = this.resolveSendTarget(clientMessage.to);
        if (resolvedTarget.error) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: resolvedTarget.error,
          });
          break;
        }

        if (!resolvedTarget.session) {
          writeMessage(socket, {
            type: "delivery_failed",
            messageId: message.id,
            reason: "Session not found",
          });
          break;
        }

        const { to: _ignoredTargetMetadata, ...messageWithoutClientReceiver } = message;
        const deliveredMessage: Message = resolvedTarget.receiver
          ? {
            ...messageWithoutClientReceiver,
            to: resolvedTarget.receiver,
          }
          : messageWithoutClientReceiver;
        writeMessage(resolvedTarget.session.socket, {
          type: "message",
          from: fromSession.info,
          message: deliveredMessage,
        });
        writeMessage(socket, { type: "delivered", messageId: message.id });
        break;
      }

      case "presence": {
        const session = this.sessions.get(currentId);
        if (session) {
          if (clientMessage.name !== undefined) {
            if (typeof clientMessage.name !== "string") {
              throw new Error("Invalid presence name");
            }
            session.info.name = clientMessage.name;
          }
          if (clientMessage.status !== undefined) {
            if (typeof clientMessage.status !== "string") {
              throw new Error("Invalid presence status");
            }
            session.info.status = clientMessage.status;
          }
          if (clientMessage.model !== undefined) {
            if (typeof clientMessage.model !== "string") {
              throw new Error("Invalid presence model");
            }
            session.info.model = clientMessage.model;
          }
          if (clientMessage.readiness !== undefined) {
            if (!isSessionReadiness(clientMessage.readiness)) {
              throw new Error("Invalid presence readiness");
            }
            session.info.readiness = clientMessage.readiness;
          }
          if (clientMessage.subagent !== undefined) {
            if (!isSessionSubagentMetadata(clientMessage.subagent)) {
              throw new Error("Invalid presence subagent metadata");
            }
            session.info.subagent = clientMessage.subagent;
          }
          session.info.lastActivity = Date.now();
          this.broadcast({ type: "presence_update", session: session.info }, currentId);
        }
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private resolveSendTarget(target: string | SendTargetEnvelope): {
    session: ConnectedSession | null;
    receiver?: Message["to"];
    error?: string;
  } {
    if (typeof target === "string") {
      const byId = this.sessions.get(target);
      if (byId) {
        return { session: byId };
      }
      const byAlias = this.findByAlias(target);
      if (byAlias.length > 1) {
        return {
          session: null,
          error: this.formatAmbiguousTargetError(target, byAlias),
        };
      }
      const resolved = byAlias[0] ?? null;
      return {
        session: resolved,
      };
    }

    if (target.intercomSessionId) {
      const byId = this.sessions.get(target.intercomSessionId);
      if (byId) {
        return { session: byId, receiver: { intercomSessionId: byId.info.id, piSessionId: byId.info.piSessionId, alias: byId.info.name } };
      }
    }

    if (target.piSessionId) {
      const byPiSessionId = this.findByPiSessionId(target.piSessionId);
      if (byPiSessionId.length > 1) {
        return {
          session: null,
          receiver: { intercomSessionId: target.intercomSessionId, piSessionId: target.piSessionId, alias: target.alias },
          error: this.formatAmbiguousTargetError(`piSessionId:${target.piSessionId}`, byPiSessionId),
        };
      }
      if (byPiSessionId.length === 1) {
        const resolved = byPiSessionId[0]!;
        return { session: resolved, receiver: { intercomSessionId: resolved.info.id, piSessionId: resolved.info.piSessionId, alias: resolved.info.name } };
      }
    }

    if (target.alias) {
      const scoped = this.findByAlias(target.alias, target.namespace);
      if (scoped.length > 1) {
        return {
          session: null,
          receiver: { intercomSessionId: target.intercomSessionId, piSessionId: target.piSessionId, alias: target.alias },
          error: this.formatAmbiguousTargetError(`alias:${target.alias}${target.namespace ? `@${target.namespace}` : ""}`, scoped),
        };
      }
      if (scoped.length === 1) {
        const resolved = scoped[0]!;
        return { session: resolved, receiver: { intercomSessionId: resolved.info.id, piSessionId: resolved.info.piSessionId, alias: resolved.info.name } };
      }

      if (target.namespace) {
        return {
          session: null,
          receiver: { intercomSessionId: target.intercomSessionId, piSessionId: target.piSessionId, alias: target.alias },
        };
      }
    }

    return {
      session: null,
      receiver: {
        intercomSessionId: target.intercomSessionId,
        piSessionId: target.piSessionId,
        alias: target.alias,
      },
    };
  }

  private findByAlias(alias: string, namespace?: string): ConnectedSession[] {
    const lowerAlias = alias.toLowerCase();
    const values = Array.from(this.sessions.values()).filter((session) => {
      if (session.info.name?.toLowerCase() !== lowerAlias) {
        return false;
      }
      if (namespace === undefined) {
        return true;
      }
      return session.info.namespace === namespace;
    });
    values.sort((a, b) => a.info.id.localeCompare(b.info.id));
    return values;
  }

  private findByPiSessionId(piSessionId: string): ConnectedSession[] {
    const values = Array.from(this.sessions.values()).filter((session) => session.info.piSessionId === piSessionId);
    values.sort((a, b) => a.info.id.localeCompare(b.info.id));
    return values;
  }

  private formatAmbiguousTargetError(label: string, candidates: ConnectedSession[]): string {
    const details = candidates
      .map((candidate) => `${candidate.info.id}(name=${candidate.info.name ?? "-"},cwd=${candidate.info.cwd})`)
      .join(", ");
    return `Ambiguous target "${label}". Candidates: ${details}`;
  }

  private broadcast(msg: BrokerMessage, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");
    
    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
    this.server.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
