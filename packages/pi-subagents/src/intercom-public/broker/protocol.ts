import type {
  Attachment,
  BrokerMessage,
  ClientMessage,
  DeliveryFailure,
  DeliveryFailureCandidate,
  DeliveredMessage,
  IntercomRegistration,
  ManualIntercomTarget,
  OutboundMessage,
  ResolvedTargetIdentity,
  SessionInfo,
  SessionReadiness,
  SessionSubagentMetadata,
} from "../types.ts";

interface JsonObject {
  [key: string]: unknown;
}

export class IntercomProtocolError extends Error {
  constructor(scope: "client" | "broker", code: string) {
    super(`intercom_protocol/${scope}/${code}`);
    this.name = "IntercomProtocolError";
  }
}

function protocolError(scope: "client" | "broker", code: string): IntercomProtocolError {
  return new IntercomProtocolError(scope, code);
}

function hasOwn(record: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function asObject(value: unknown, scope: "client" | "broker", code: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError(scope, code);
  }
  return value as JsonObject;
}

function assertNoUnknownKeys(
  record: JsonObject,
  allowedKeys: readonly string[],
  scope: "client" | "broker",
  context: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw protocolError(scope, `${context}.unknown_key.${key}`);
    }
  }
}

function asNonEmptyString(value: unknown, scope: "client" | "broker", code: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw protocolError(scope, code);
  }
  return value;
}

function asOptionalNonEmptyString(
  record: JsonObject,
  key: string,
  scope: "client" | "broker",
  code: string,
): string | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) {
    return undefined;
  }
  return asNonEmptyString(record[key], scope, code);
}

function asBoolean(value: unknown, scope: "client" | "broker", code: string): boolean {
  if (typeof value !== "boolean") {
    throw protocolError(scope, code);
  }
  return value;
}

function asFiniteNumber(value: unknown, scope: "client" | "broker", code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(scope, code);
  }
  return value;
}

function asNonNegativeNumber(value: unknown, scope: "client" | "broker", code: string): number {
  const parsed = asFiniteNumber(value, scope, code);
  if (parsed < 0) {
    throw protocolError(scope, code);
  }
  return parsed;
}

function decodeSessionReadiness(value: unknown, scope: "client" | "broker", context: string): SessionReadiness {
  const record = asObject(value, scope, `${context}.not_object`);
  assertNoUnknownKeys(record, ["state", "reason", "updatedAt"], scope, context);

  const state = record.state;
  if (state !== "initializing" && state !== "ready" && state !== "stopping") {
    throw protocolError(scope, `${context}.state`);
  }

  return {
    state,
    ...(hasOwn(record, "reason") && record.reason !== undefined
      ? { reason: asNonEmptyString(record.reason, scope, `${context}.reason`) }
      : {}),
    updatedAt: asFiniteNumber(record.updatedAt, scope, `${context}.updatedAt`),
  };
}

function decodeSessionSubagentMetadata(value: unknown, scope: "client" | "broker", context: string): SessionSubagentMetadata {
  const record = asObject(value, scope, `${context}.not_object`);
  assertNoUnknownKeys(record, ["ownerPiSessionId", "runId", "agent", "index"], scope, context);

  const index = asFiniteNumber(record.index, scope, `${context}.index`);
  if (!Number.isInteger(index) || index < 0) {
    throw protocolError(scope, `${context}.index`);
  }

  return {
    ownerPiSessionId: asNonEmptyString(record.ownerPiSessionId, scope, `${context}.ownerPiSessionId`),
    runId: asNonEmptyString(record.runId, scope, `${context}.runId`),
    agent: asNonEmptyString(record.agent, scope, `${context}.agent`),
    index,
  };
}

function decodeAttachment(value: unknown, scope: "client" | "broker", context: string): Attachment {
  const record = asObject(value, scope, `${context}.not_object`);
  assertNoUnknownKeys(record, ["type", "name", "content", "language"], scope, context);

  const type = record.type;
  if (type !== "file" && type !== "snippet" && type !== "context") {
    throw protocolError(scope, `${context}.type`);
  }

  if (typeof record.content !== "string") {
    throw protocolError(scope, `${context}.content`);
  }

  return {
    type,
    name: asNonEmptyString(record.name, scope, `${context}.name`),
    content: record.content,
    ...(hasOwn(record, "language") && record.language !== undefined
      ? { language: asNonEmptyString(record.language, scope, `${context}.language`) }
      : {}),
  };
}

function decodeResolvedTargetIdentity(
  value: unknown,
  scope: "client" | "broker",
  context: string,
): ResolvedTargetIdentity {
  const record = asObject(value, scope, `${context}.not_object`);
  assertNoUnknownKeys(record, ["intercomSessionId", "piSessionId", "alias"], scope, context);

  return {
    intercomSessionId: asNonEmptyString(record.intercomSessionId, scope, `${context}.intercomSessionId`),
    piSessionId: asNonEmptyString(record.piSessionId, scope, `${context}.piSessionId`),
    ...(hasOwn(record, "alias") && record.alias !== undefined
      ? { alias: asNonEmptyString(record.alias, scope, `${context}.alias`) }
      : {}),
  };
}

function decodeMessageContent(record: JsonObject, scope: "client" | "broker", context: string): OutboundMessage["content"] {
  const contentRecord = asObject(record.content, scope, `${context}.content.not_object`);
  assertNoUnknownKeys(contentRecord, ["text", "attachments"], scope, `${context}.content`);
  if (typeof contentRecord.text !== "string") {
    throw protocolError(scope, `${context}.content.text`);
  }

  const attachmentsValue = contentRecord.attachments;
  if (attachmentsValue !== undefined && !Array.isArray(attachmentsValue)) {
    throw protocolError(scope, `${context}.content.attachments`);
  }

  return {
    text: contentRecord.text,
    ...(attachmentsValue
      ? {
        attachments: attachmentsValue.map((attachment, index) =>
          decodeAttachment(attachment, scope, `${context}.content.attachments[${index}]`),
        ),
      }
      : {}),
  };
}

function decodeDeliveryFailureCandidate(
  value: unknown,
  scope: "client" | "broker",
  context: string,
): DeliveryFailureCandidate {
  const record = asObject(value, scope, `${context}.not_object`);
  assertNoUnknownKeys(
    record,
    ["intercomSessionId", "piSessionId", "alias", "namespace", "cwd", "pid", "startedAt", "leaseExpiresAt"],
    scope,
    context,
  );

  return {
    intercomSessionId: asNonEmptyString(record.intercomSessionId, scope, `${context}.intercomSessionId`),
    piSessionId: asNonEmptyString(record.piSessionId, scope, `${context}.piSessionId`),
    alias: asNonEmptyString(record.alias, scope, `${context}.alias`),
    namespace: asNonEmptyString(record.namespace, scope, `${context}.namespace`),
    cwd: asNonEmptyString(record.cwd, scope, `${context}.cwd`),
    pid: asFiniteNumber(record.pid, scope, `${context}.pid`),
    startedAt: asFiniteNumber(record.startedAt, scope, `${context}.startedAt`),
    ...(hasOwn(record, "leaseExpiresAt") && record.leaseExpiresAt !== undefined
      ? { leaseExpiresAt: asFiniteNumber(record.leaseExpiresAt, scope, `${context}.leaseExpiresAt`) }
      : {}),
  };
}

function decodeDeliveryFailure(value: unknown, scope: "client" | "broker", context: string): DeliveryFailure {
  const record = asObject(value, scope, `${context}.not_object`);
  const code = asNonEmptyString(record.code, scope, `${context}.code`) as DeliveryFailure["code"];

  switch (code) {
    case "forged-sender":
    case "unregistered-sender":
    case "unsafe-machine-alias-target":
    case "target-not-found":
    case "expired-target": {
      assertNoUnknownKeys(record, ["code"], scope, context);
      return { code };
    }
    case "ambiguous-alias": {
      assertNoUnknownKeys(record, ["code", "label", "candidates"], scope, context);
      if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
        throw protocolError(scope, `${context}.candidates`);
      }
      return {
        code,
        label: asNonEmptyString(record.label, scope, `${context}.label`),
        candidates: record.candidates.map((candidate, index) => decodeDeliveryFailureCandidate(candidate, scope, `${context}.candidates[${index}]`)),
      };
    }
    case "duplicate-pi-session": {
      assertNoUnknownKeys(record, ["code", "piSessionId", "candidates"], scope, context);
      if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
        throw protocolError(scope, `${context}.candidates`);
      }
      return {
        code,
        piSessionId: asNonEmptyString(record.piSessionId, scope, `${context}.piSessionId`),
        candidates: record.candidates.map((candidate, index) => decodeDeliveryFailureCandidate(candidate, scope, `${context}.candidates[${index}]`)),
      };
    }
    default:
      throw protocolError(scope, `${context}.code.${String(code)}`);
  }
}

function decodeOutboundMessage(value: unknown, scope: "client" | "broker", context: string): OutboundMessage {
  const record = asObject(value, scope, `${context}.not_object`);
  assertNoUnknownKeys(record, ["id", "timestamp", "replyTo", "expectsReply", "content"], scope, context);

  return {
    id: asNonEmptyString(record.id, scope, `${context}.id`),
    timestamp: asFiniteNumber(record.timestamp, scope, `${context}.timestamp`),
    ...(hasOwn(record, "replyTo") && record.replyTo !== undefined
      ? { replyTo: asNonEmptyString(record.replyTo, scope, `${context}.replyTo`) }
      : {}),
    ...(hasOwn(record, "expectsReply") && record.expectsReply !== undefined
      ? { expectsReply: asBoolean(record.expectsReply, scope, `${context}.expectsReply`) }
      : {}),
    content: decodeMessageContent(record, scope, context),
  };
}

function decodeDeliveredMessage(value: unknown, scope: "client" | "broker", context: string): DeliveredMessage {
  const record = asObject(value, scope, `${context}.not_object`);
  assertNoUnknownKeys(record, ["id", "timestamp", "to", "replyTo", "expectsReply", "content"], scope, context);

  return {
    id: asNonEmptyString(record.id, scope, `${context}.id`),
    timestamp: asFiniteNumber(record.timestamp, scope, `${context}.timestamp`),
    to: decodeResolvedTargetIdentity(record.to, scope, `${context}.to`),
    ...(hasOwn(record, "replyTo") && record.replyTo !== undefined
      ? { replyTo: asNonEmptyString(record.replyTo, scope, `${context}.replyTo`) }
      : {}),
    ...(hasOwn(record, "expectsReply") && record.expectsReply !== undefined
      ? { expectsReply: asBoolean(record.expectsReply, scope, `${context}.expectsReply`) }
      : {}),
    content: decodeMessageContent(record, scope, context),
  };
}

function decodeIntercomTarget(value: unknown, scope: "client" | "broker", context: string): ManualIntercomTarget {
  const record = asObject(value, scope, `${context}.not_object`);
  const kind = asNonEmptyString(record.kind, scope, `${context}.kind`) as ManualIntercomTarget["kind"];

  switch (kind) {
    case "intercom-session": {
      assertNoUnknownKeys(record, ["kind", "intercomSessionId"], scope, context);
      return {
        kind,
        intercomSessionId: asNonEmptyString(record.intercomSessionId, scope, `${context}.intercomSessionId`),
      };
    }
    case "pi-session": {
      assertNoUnknownKeys(record, ["kind", "piSessionId"], scope, context);
      return {
        kind,
        piSessionId: asNonEmptyString(record.piSessionId, scope, `${context}.piSessionId`),
      };
    }
    case "identity-snapshot": {
      assertNoUnknownKeys(record, ["kind", "intercomSessionId", "piSessionId", "alias", "reconnect"], scope, context);
      const reconnect = asNonEmptyString(record.reconnect, scope, `${context}.reconnect`);
      if (reconnect !== "same-intercom-session" && reconnect !== "same-pi-session-if-unique") {
        throw protocolError(scope, `${context}.reconnect`);
      }
      return {
        kind,
        intercomSessionId: asNonEmptyString(record.intercomSessionId, scope, `${context}.intercomSessionId`),
        piSessionId: asNonEmptyString(record.piSessionId, scope, `${context}.piSessionId`),
        ...(hasOwn(record, "alias") && record.alias !== undefined
          ? { alias: asNonEmptyString(record.alias, scope, `${context}.alias`) }
          : {}),
        reconnect,
      };
    }
    case "scoped-alias": {
      assertNoUnknownKeys(record, ["kind", "alias", "namespace"], scope, context);
      return {
        kind,
        alias: asNonEmptyString(record.alias, scope, `${context}.alias`),
        namespace: asNonEmptyString(record.namespace, scope, `${context}.namespace`),
      };
    }
    case "global-alias": {
      assertNoUnknownKeys(record, ["kind", "alias"], scope, context);
      return {
        kind,
        alias: asNonEmptyString(record.alias, scope, `${context}.alias`),
      };
    }
    default:
      throw protocolError(scope, `${context}.kind.${String(kind)}`);
  }
}

function decodeIntercomRegistration(
  value: unknown,
  scope: "client" | "broker",
  context: string,
  options?: { allowId?: boolean },
): IntercomRegistration {
  const record = asObject(value, scope, `${context}.not_object`);
  assertNoUnknownKeys(
    record,
    [
      ...(options?.allowId ? ["id"] : []),
      "piSessionId",
      "alias",
      "namespace",
      "cwd",
      "model",
      "pid",
      "startedAt",
      "lastActivity",
      "leaseTtlMs",
      "heartbeatIntervalMs",
      "status",
      "readiness",
      "subagent",
    ],
    scope,
    context,
  );

  return {
    piSessionId: asNonEmptyString(record.piSessionId, scope, `${context}.piSessionId`),
    alias: asNonEmptyString(record.alias, scope, `${context}.alias`),
    namespace: asNonEmptyString(record.namespace, scope, `${context}.namespace`),
    cwd: asNonEmptyString(record.cwd, scope, `${context}.cwd`),
    model: asNonEmptyString(record.model, scope, `${context}.model`),
    pid: asFiniteNumber(record.pid, scope, `${context}.pid`),
    startedAt: asFiniteNumber(record.startedAt, scope, `${context}.startedAt`),
    lastActivity: asFiniteNumber(record.lastActivity, scope, `${context}.lastActivity`),
    leaseTtlMs: asNonNegativeNumber(record.leaseTtlMs, scope, `${context}.leaseTtlMs`),
    heartbeatIntervalMs: asNonNegativeNumber(record.heartbeatIntervalMs, scope, `${context}.heartbeatIntervalMs`),
    ...(hasOwn(record, "status") && record.status !== undefined
      ? { status: asNonEmptyString(record.status, scope, `${context}.status`) }
      : {}),
    ...(hasOwn(record, "readiness") && record.readiness !== undefined
      ? { readiness: decodeSessionReadiness(record.readiness, scope, `${context}.readiness`) }
      : {}),
    ...(hasOwn(record, "subagent") && record.subagent !== undefined
      ? { subagent: decodeSessionSubagentMetadata(record.subagent, scope, `${context}.subagent`) }
      : {}),
  };
}

function decodeSessionInfo(value: unknown, scope: "client" | "broker", context: string): SessionInfo {
  const registration = decodeIntercomRegistration(value, scope, context, { allowId: true });
  const record = value as JsonObject;
  return {
    ...registration,
    id: asNonEmptyString(record.id, scope, `${context}.id`),
  };
}

export function decodeClientFrame(frame: unknown): ClientMessage {
  const record = asObject(frame, "client", "frame.not_object");
  const type = asNonEmptyString(record.type, "client", "frame.type");

  switch (type) {
    case "register": {
      assertNoUnknownKeys(record, ["type", "session"], "client", "register");
      return {
        type: "register",
        session: decodeIntercomRegistration(record.session, "client", "register.session"),
      };
    }
    case "unregister": {
      assertNoUnknownKeys(record, ["type"], "client", "unregister");
      return { type: "unregister" };
    }
    case "list": {
      assertNoUnknownKeys(record, ["type", "requestId"], "client", "list");
      return {
        type: "list",
        requestId: asNonEmptyString(record.requestId, "client", "list.requestId"),
      };
    }
    case "send": {
      if (hasOwn(record, "from")) {
        throw protocolError("client", "send.forged_from");
      }
      assertNoUnknownKeys(record, ["type", "to", "message", "origin"], "client", "send");

      const origin = record.origin;
      if (origin !== "manual" && origin !== "machine") {
        throw protocolError("client", "send.origin");
      }

      const to = decodeIntercomTarget(record.to, "client", "send.to");

      if (origin === "machine" && (to.kind === "scoped-alias" || to.kind === "global-alias")) {
        throw protocolError("client", "send.machine_alias_target");
      }

      return {
        type: "send",
        origin,
        to,
        message: decodeOutboundMessage(record.message, "client", "send.message"),
      };
    }
    case "heartbeat": {
      assertNoUnknownKeys(record, ["type"], "client", "heartbeat");
      return { type: "heartbeat" };
    }
    case "presence": {
      assertNoUnknownKeys(record, ["type", "status", "model", "readiness", "subagent"], "client", "presence");

      return {
        type: "presence",
        ...(hasOwn(record, "status") && record.status !== undefined
          ? { status: asNonEmptyString(record.status, "client", "presence.status") }
          : {}),
        ...(hasOwn(record, "model") && record.model !== undefined
          ? { model: asNonEmptyString(record.model, "client", "presence.model") }
          : {}),
        ...(hasOwn(record, "readiness") && record.readiness !== undefined
          ? { readiness: decodeSessionReadiness(record.readiness, "client", "presence.readiness") }
          : {}),
        ...(hasOwn(record, "subagent") && record.subagent !== undefined
          ? { subagent: decodeSessionSubagentMetadata(record.subagent, "client", "presence.subagent") }
          : {}),
      };
    }
    default:
      throw protocolError("client", `frame.type.${type}`);
  }
}

export function decodeBrokerFrame(frame: unknown): BrokerMessage {
  const record = asObject(frame, "broker", "frame.not_object");
  const type = asNonEmptyString(record.type, "broker", "frame.type");

  switch (type) {
    case "registered": {
      assertNoUnknownKeys(record, ["type", "sessionId"], "broker", "registered");
      return {
        type: "registered",
        sessionId: asNonEmptyString(record.sessionId, "broker", "registered.sessionId"),
      };
    }
    case "sessions": {
      assertNoUnknownKeys(record, ["type", "requestId", "sessions"], "broker", "sessions");
      if (!Array.isArray(record.sessions)) {
        throw protocolError("broker", "sessions.sessions");
      }
      return {
        type: "sessions",
        requestId: asNonEmptyString(record.requestId, "broker", "sessions.requestId"),
        sessions: record.sessions.map((session, index) => decodeSessionInfo(session, "broker", `sessions.sessions[${index}]`)),
      };
    }
    case "message": {
      assertNoUnknownKeys(record, ["type", "from", "message"], "broker", "message");
      return {
        type: "message",
        from: decodeSessionInfo(record.from, "broker", "message.from"),
        message: decodeDeliveredMessage(record.message, "broker", "message.message"),
      };
    }
    case "presence_update": {
      assertNoUnknownKeys(record, ["type", "session"], "broker", "presence_update");
      return {
        type: "presence_update",
        session: decodeSessionInfo(record.session, "broker", "presence_update.session"),
      };
    }
    case "session_joined": {
      assertNoUnknownKeys(record, ["type", "session"], "broker", "session_joined");
      return {
        type: "session_joined",
        session: decodeSessionInfo(record.session, "broker", "session_joined.session"),
      };
    }
    case "session_left": {
      assertNoUnknownKeys(record, ["type", "sessionId"], "broker", "session_left");
      return {
        type: "session_left",
        sessionId: asNonEmptyString(record.sessionId, "broker", "session_left.sessionId"),
      };
    }
    case "error": {
      assertNoUnknownKeys(record, ["type", "error"], "broker", "error");
      return {
        type: "error",
        error: asNonEmptyString(record.error, "broker", "error.error"),
      };
    }
    case "delivered": {
      assertNoUnknownKeys(record, ["type", "messageId"], "broker", "delivered");
      return {
        type: "delivered",
        messageId: asNonEmptyString(record.messageId, "broker", "delivered.messageId"),
      };
    }
    case "delivery_failed": {
      assertNoUnknownKeys(record, ["type", "messageId", "failure"], "broker", "delivery_failed");
      return {
        type: "delivery_failed",
        messageId: asNonEmptyString(record.messageId, "broker", "delivery_failed.messageId"),
        failure: decodeDeliveryFailure(record.failure, "broker", "delivery_failed.failure"),
      };
    }
    default:
      throw protocolError("broker", `frame.type.${type}`);
  }
}
