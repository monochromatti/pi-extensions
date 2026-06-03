import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import { getBrokerSocketDir, getBrokerSocketPath } from "./paths.ts";
import { decodeClientFrame } from "./protocol.ts";
import {
  type DeliveryFailure,
  type DeliveryFailureCandidate,
  type BrokerMessage,
  type DeliveredMessage,
  type MachineIntercomTarget,
  type ManualIntercomTarget,
  type ResolvedTargetIdentity,
  type SessionInfo,
} from "../types.ts";

const INTERCOM_DIR = join(homedir(), ".pi/agent/intercom");
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");

interface ConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private piSessionIndex = new Map<string, Set<string>>();
  private scopedAliasIndex = new Map<string, Set<string>>();
  private globalAliasIndex = new Map<string, Set<string>>();
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
        this.removeSession(sessionId);
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
    const clientMessage = decodeClientFrame(msg);

    if (currentId === null && clientMessage.type !== "register") {
      if (clientMessage.type === "send" && clientMessage.origin === "machine") {
        this.writeDeliveryFailed(socket, clientMessage.message.id, { code: "unregistered-sender" });
        return;
      }
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (currentId) {
          throw new Error("Received duplicate register message");
        }

        const id = randomUUID();
        setId(id);
        const now = Date.now();
        const info: SessionInfo = {
          ...clientMessage.session,
          id,
          lastActivity: now,
        };
        this.addSession(id, { socket, info });

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, { type: "registered", sessionId: id });
        this.broadcast({ type: "session_joined", session: info }, id);
        break;
      }

      case "unregister": {
        this.removeSession(currentId);
        this.broadcast({ type: "session_left", sessionId: currentId }, currentId);
        setId(null);
        this.scheduleShutdownCheck();
        break;
      }

      case "list": {
        this.expireInactiveSessions();
        const sessions = Array.from(this.sessions.values()).map((s) => s.info);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "send": {
        const message = clientMessage.message;
        const fromSession = this.sessions.get(currentId);
        if (!fromSession) {
          this.writeDeliveryFailed(socket, message.id, { code: "forged-sender" });
          break;
        }

        if (clientMessage.origin === "machine" && !this.isExactMachineTarget(clientMessage.to)) {
          this.writeDeliveryFailed(socket, message.id, { code: "unsafe-machine-alias-target" });
          break;
        }

        this.expireInactiveSessions();
        const resolvedTarget = this.resolveSendTarget(clientMessage.to);
        if (resolvedTarget.failure) {
          this.writeDeliveryFailed(socket, message.id, resolvedTarget.failure);
          break;
        }

        if (!resolvedTarget.session) {
          this.writeDeliveryFailed(socket, message.id, { code: "target-not-found" });
          break;
        }

        const deliveredMessage: DeliveredMessage = {
          ...message,
          to: resolvedTarget.receiver ?? this.toResolvedTargetIdentity(resolvedTarget.session.info),
        };
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
          if (clientMessage.status !== undefined) {
            session.info.status = clientMessage.status;
          }
          if (clientMessage.model !== undefined) {
            session.info.model = clientMessage.model;
          }
          if (clientMessage.readiness !== undefined) {
            session.info.readiness = clientMessage.readiness;
          }
          if (clientMessage.subagent !== undefined) {
            session.info.subagent = clientMessage.subagent;
          }
          session.info.lastActivity = Date.now();
          this.broadcast({ type: "presence_update", session: session.info }, currentId);
        }
        break;
      }

      case "heartbeat": {
        const session = this.sessions.get(currentId);
        if (session) {
          session.info.lastActivity = Date.now();
        }
        break;
      }
    }
  }

  private isExactMachineTarget(target: ManualIntercomTarget): target is MachineIntercomTarget {
    return target.kind === "intercom-session"
      || target.kind === "pi-session"
      || target.kind === "identity-snapshot";
  }

  private expireInactiveSessions(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      const ttl = session.info.leaseTtlMs;
      if (typeof ttl === "number" && ttl >= 0 && session.info.lastActivity + ttl <= now) {
        this.removeSession(id);
        this.broadcast({ type: "session_left", sessionId: id }, id);
      }
    }
  }

  private resolveSendTarget(target: ManualIntercomTarget): {
    session: ConnectedSession | null;
    receiver?: ResolvedTargetIdentity;
    failure?: DeliveryFailure;
  } {
    switch (target.kind) {
      case "intercom-session": {
        const byId = this.sessions.get(target.intercomSessionId);
        if (byId) {
          return { session: byId, receiver: this.toResolvedTargetIdentity(byId.info) };
        }
        return {
          session: null,
          failure: { code: "expired-target" },
        };
      }
      case "pi-session": {
        const byPiSessionId = this.findByPiSessionId(target.piSessionId);
        if (byPiSessionId.length > 1) {
          return {
            session: null,
            failure: this.duplicatePiSessionFailure(target.piSessionId, byPiSessionId),
          };
        }
        if (byPiSessionId.length === 1) {
          const resolved = byPiSessionId[0]!;
          return { session: resolved, receiver: this.toResolvedTargetIdentity(resolved.info) };
        }
        return {
          session: null,
          failure: { code: "expired-target" },
        };
      }
      case "identity-snapshot": {
        const byId = this.sessions.get(target.intercomSessionId);
        if (byId) {
          return { session: byId, receiver: this.toResolvedTargetIdentity(byId.info) };
        }

        if (target.reconnect === "same-intercom-session") {
          return {
            session: null,
            failure: { code: "expired-target" },
          };
        }

        const byPiSessionId = this.findByPiSessionId(target.piSessionId);
        if (byPiSessionId.length > 1) {
          return {
            session: null,
            failure: this.duplicatePiSessionFailure(target.piSessionId, byPiSessionId),
          };
        }
        if (byPiSessionId.length === 1) {
          const resolved = byPiSessionId[0]!;
          return { session: resolved, receiver: this.toResolvedTargetIdentity(resolved.info) };
        }

        return {
          session: null,
          failure: { code: "expired-target" },
        };
      }
      case "scoped-alias": {
        const scoped = this.findByAlias(target.alias, target.namespace);
        if (scoped.length > 1) {
          return {
            session: null,
            failure: this.ambiguousAliasFailure(`alias:${target.alias}@${target.namespace}`, scoped),
          };
        }
        if (scoped.length === 1) {
          const resolved = scoped[0]!;
          return { session: resolved, receiver: this.toResolvedTargetIdentity(resolved.info) };
        }

        return {
          session: null,
          failure: { code: "target-not-found" },
        };
      }
      case "global-alias": {
        const scoped = this.findByAlias(target.alias, undefined);
        if (scoped.length > 1) {
          return {
            session: null,
            failure: this.ambiguousAliasFailure(`alias:${target.alias}`, scoped),
          };
        }
        if (scoped.length === 1) {
          const resolved = scoped[0]!;
          return { session: resolved, receiver: this.toResolvedTargetIdentity(resolved.info) };
        }

        return {
          session: null,
          failure: { code: "target-not-found" },
        };
      }
    }
  }

  private toResolvedTargetIdentity(session: SessionInfo): ResolvedTargetIdentity {
    return {
      intercomSessionId: session.id,
      piSessionId: session.piSessionId,
      ...(session.alias ? { alias: session.alias } : {}),
    };
  }

  private addSession(id: string, session: ConnectedSession): void {
    this.sessions.set(id, session);
    this.addIndexValue(this.piSessionIndex, session.info.piSessionId, id);
    this.addIndexValue(this.scopedAliasIndex, this.scopedAliasKey(session.info.namespace, session.info.alias), id);
    this.addIndexValue(this.globalAliasIndex, session.info.alias.toLowerCase(), id);
  }

  private removeSession(id: string): ConnectedSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.sessions.delete(id);
    this.removeIndexValue(this.piSessionIndex, session.info.piSessionId, id);
    this.removeIndexValue(this.scopedAliasIndex, this.scopedAliasKey(session.info.namespace, session.info.alias), id);
    this.removeIndexValue(this.globalAliasIndex, session.info.alias.toLowerCase(), id);
    return session;
  }

  private addIndexValue(index: Map<string, Set<string>>, key: string, id: string): void {
    const values = index.get(key) ?? new Set<string>();
    values.add(id);
    index.set(key, values);
  }

  private removeIndexValue(index: Map<string, Set<string>>, key: string, id: string): void {
    const values = index.get(key);
    if (!values) return;
    values.delete(id);
    if (values.size === 0) {
      index.delete(key);
    }
  }

  private scopedAliasKey(namespace: string, alias: string): string {
    return `${namespace}\0${alias.toLowerCase()}`;
  }

  private sessionsForIds(ids: Iterable<string>): ConnectedSession[] {
    const values = Array.from(ids)
      .map((id) => this.sessions.get(id))
      .filter((session): session is ConnectedSession => Boolean(session));
    values.sort((a, b) => a.info.id.localeCompare(b.info.id));
    return values;
  }

  private findByAlias(alias: string, namespace?: string): ConnectedSession[] {
    const ids = namespace === undefined
      ? this.globalAliasIndex.get(alias.toLowerCase())
      : this.scopedAliasIndex.get(this.scopedAliasKey(namespace, alias));
    return ids ? this.sessionsForIds(ids) : [];
  }

  private findByPiSessionId(piSessionId: string): ConnectedSession[] {
    const ids = this.piSessionIndex.get(piSessionId);
    return ids ? this.sessionsForIds(ids) : [];
  }

  private ambiguousAliasFailure(label: string, candidates: ConnectedSession[]): DeliveryFailure {
    return {
      code: "ambiguous-alias",
      label,
      candidates: this.buildFailureCandidates(candidates),
    };
  }

  private duplicatePiSessionFailure(piSessionId: string, candidates: ConnectedSession[]): DeliveryFailure {
    return {
      code: "duplicate-pi-session",
      piSessionId,
      candidates: this.buildFailureCandidates(candidates),
    };
  }

  private buildFailureCandidates(candidates: ConnectedSession[]): DeliveryFailureCandidate[] {
    return candidates
      .slice()
      .sort((left, right) => left.info.id.localeCompare(right.info.id))
      .map((candidate) => ({
        intercomSessionId: candidate.info.id,
        piSessionId: candidate.info.piSessionId,
        alias: candidate.info.alias,
        namespace: candidate.info.namespace,
        cwd: candidate.info.cwd,
        pid: candidate.info.pid,
        startedAt: candidate.info.startedAt,
        ...(this.leaseExpiresAt(candidate.info) !== undefined ? { leaseExpiresAt: this.leaseExpiresAt(candidate.info) } : {}),
      }));
  }

  private writeDeliveryFailed(socket: net.Socket, messageId: string, failure: DeliveryFailure): void {
    writeMessage(socket, {
      type: "delivery_failed",
      messageId,
      failure,
    });
  }

  private leaseExpiresAt(session: SessionInfo): number | undefined {
    return typeof session.leaseTtlMs === "number" ? session.lastActivity + session.leaseTtlMs : undefined;
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
    this.piSessionIndex.clear();
    this.scopedAliasIndex.clear();
    this.globalAliasIndex.clear();
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
