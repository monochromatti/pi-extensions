import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import { getBrokerSocketPath } from "./paths.ts";
import { decodeBrokerFrame } from "./protocol.ts";
import type {
  Attachment,
  BrokerMessage,
  DeliveryFailure,
  IntercomMessageOrigin,
  MachineIntercomTarget,
  ManualIntercomTarget,
  OutboundMessage,
  SessionInfo,
  SessionReadiness,
  SessionSubagentMetadata,
} from "../types.ts";

interface BaseSendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
}


interface SendResult {
  id: string;
  delivered: boolean;
  failure?: DeliveryFailure;
}

type SendTargetInput = string | ManualIntercomTarget;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isManualIntercomTarget(value: unknown): value is ManualIntercomTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as { kind?: unknown };
  return record.kind === "intercom-session"
    || record.kind === "pi-session"
    || record.kind === "identity-snapshot"
    || record.kind === "scoped-alias"
    || record.kind === "global-alias";
}

function isMachineIntercomTarget(value: ManualIntercomTarget): value is MachineIntercomTarget {
  return value.kind === "intercom-session"
    || value.kind === "pi-session"
    || value.kind === "identity-snapshot";
}

function normalizeSendTarget(target: SendTargetInput, namespace: string | null): ManualIntercomTarget {
  if (typeof target === "string") {
    const normalized = target.trim();
    if (!normalized) {
      throw new Error("Invalid send target");
    }
    const globalPrefix = "global:";
    if (normalized.toLowerCase().startsWith(globalPrefix)) {
      const alias = normalized.slice(globalPrefix.length).trim();
      if (!alias) {
        throw new Error("Invalid send target");
      }
      return { kind: "global-alias", alias };
    }

    if (namespace) {
      return { kind: "scoped-alias", alias: normalized, namespace };
    }

    return { kind: "global-alias", alias: normalized };
  }

  if (!isManualIntercomTarget(target)) {
    throw new Error("Invalid send target");
  }

  return target;
}

export class IntercomClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private _sessionId: string | null = null;
  private pendingSends = new Map<string, { resolve: (r: SendResult) => void; reject: (e: Error) => void }>();
  private pendingLists = new Map<string, { resolve: (sessions: SessionInfo[]) => void; reject: (e: Error) => void }>();
  private connectedNamespace: string | null = null;
  private disconnecting = false;
  private disconnectError: Error | null = null;

  private failPending(error: Error): void {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error);
    }
    this.pendingLists.clear();
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  isConnected(): boolean {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }

  private requireActiveSocket(): net.Socket {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }

    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }

    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new Error("Client disconnected");
    }

    return socket;
  }

  connect(session: Omit<SessionInfo, "id">): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }

    return new Promise((resolve, reject) => {
      const socket = net.connect(getBrokerSocketPath());
      this.socket = socket;
      this.disconnectError = null;
      this.connectedNamespace = session.namespace;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 10000);
      
      let connectionEstablished = false;
      
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve();
      };
      
      const onError = (err: Error) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this.connectedNamespace = null;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };

      const onSocketError = (err: Error) => {
        if (connectionEstablished) {
          this.disconnectError = err;
          this.emit("error", err);
        }
      };

      const onReaderError = (error: Error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };

      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };

      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      
      try {
        writeMessage(socket, { type: "register", session });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error));
      }
    });
  }

  private handleBrokerMessage(msg: unknown): void {
    const brokerMessage: BrokerMessage = decodeBrokerFrame(msg);

    if (this._sessionId === null && brokerMessage.type !== "registered") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }

    switch (brokerMessage.type) {
      case "registered": {
        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }

        this._sessionId = brokerMessage.sessionId;
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }

      case "sessions": {
        const pending = this.pendingLists.get(brokerMessage.requestId);
        if (!pending) {
          // Late list responses can still arrive after the caller has already timed out.
          return;
        }

        this.pendingLists.delete(brokerMessage.requestId);
        pending.resolve(brokerMessage.sessions);
        break;
      }

      case "message": {
        this.emit("message", brokerMessage.from, brokerMessage.message);
        break;
      }

      case "delivered": {
        const pending = this.pendingSends.get(brokerMessage.messageId);
        if (!pending) {
          // Late send responses are harmless once the caller has already timed out.
          return;
        }

        this.pendingSends.delete(brokerMessage.messageId);
        pending.resolve({ id: brokerMessage.messageId, delivered: true });
        break;
      }

      case "delivery_failed": {
        const pending = this.pendingSends.get(brokerMessage.messageId);
        if (!pending) {
          // Late send responses are harmless once the caller has already timed out.
          return;
        }

        this.pendingSends.delete(brokerMessage.messageId);
        pending.resolve({ id: brokerMessage.messageId, delivered: false, failure: brokerMessage.failure });
        break;
      }

      case "session_joined": {
        this.emit("session_joined", brokerMessage.session);
        break;
      }

      case "session_left": {
        this.emit("session_left", brokerMessage.sessionId);
        break;
      }

      case "presence_update": {
        this.emit("presence_update", brokerMessage.session);
        break;
      }

      case "error": {
        this.emit("error", new Error(brokerMessage.error));
        break;
      }
    }
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new Error("Client disconnected"));

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2000);

      socket.once("close", onClose);
      socket.once("error", onError);

      try {
        writeMessage(socket, { type: "unregister" });
        socket.end();
      } catch {
        // Disconnect should still finish even if the unregister write fails.
        socket.destroy();
      }
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const wrappedResolve = (sessions: SessionInfo[]) => {
        clearTimeout(timeout);
        resolve(sessions);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, 5000);
      this.pendingLists.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "list", requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error));
      }
    });
  }

  sendManual(to: string | ManualIntercomTarget, options: BaseSendOptions): Promise<SendResult> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }

    const messageId = options.messageId ?? randomUUID();

    let normalizedTarget: ManualIntercomTarget;
    try {
      normalizedTarget = normalizeSendTarget(to, this.connectedNamespace);
    } catch (error) {
      return Promise.reject(toError(error));
    }

    const message: OutboundMessage = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      content: {
        text: options.text,
        attachments: options.attachments,
      },
    };

    return this.sendWithOrigin(socket, normalizedTarget, "manual", message);
  }

  sendMachine(to: MachineIntercomTarget, options: BaseSendOptions): Promise<SendResult> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }

    if (!isMachineIntercomTarget(to)) {
      return Promise.resolve({
        id: options.messageId ?? randomUUID(),
        delivered: false,
        failure: { code: "unsafe-machine-alias-target" },
      });
    }

    const message: OutboundMessage = {
      id: options.messageId ?? randomUUID(),
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      content: {
        text: options.text,
        attachments: options.attachments,
      },
    };

    return this.sendWithOrigin(socket, to, "machine", message);
  }

  private sendWithOrigin(
    socket: net.Socket,
    to: ManualIntercomTarget,
    origin: IntercomMessageOrigin,
    message: OutboundMessage,
  ): Promise<SendResult> {
    const messageId = message.id;
    return new Promise((resolve, reject) => {
      const wrappedResolve = (result: SendResult) => {
        clearTimeout(timeout);
        resolve(result);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Send timeout"));
        }
      }, 10000);
      this.pendingSends.set(messageId, { resolve: wrappedResolve, reject: wrappedReject });

      try {
        writeMessage(socket, {
          type: "send",
          to,
          message,
          origin,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error));
      }
    });
  }

  heartbeat(): void {
    if (this.disconnecting) {
      return;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }
    writeMessage(socket, { type: "heartbeat" });
  }

  updatePresence(updates: {
    status?: string;
    model?: string;
    readiness?: SessionReadiness;
    subagent?: SessionSubagentMetadata;
  }): void {
    if (this.disconnecting) {
      return;
    }

    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }

    writeMessage(socket, { type: "presence", ...updates });
  }
}
