export interface SessionReadiness {
  state: "initializing" | "ready" | "stopping";
  reason?: string;
  updatedAt: number;
}

export interface SessionSubagentMetadata {
  ownerPiSessionId: string;
  runId: string;
  agent: string;
  index: number;
}

export const INTERCOM_LEASE_TTL_MS = 30_000;
export const INTERCOM_HEARTBEAT_INTERVAL_MS = 10_000;

export interface IntercomRegistration {
  piSessionId: string;
  alias: string;
  namespace: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  status?: string;
  readiness?: SessionReadiness;
  subagent?: SessionSubagentMetadata;
}

export interface SessionInfo extends IntercomRegistration {
  id: string;
}

export function buildIntercomRegistration(input: {
  piSessionId: string;
  alias: string;
  namespace: string;
  cwd: string;
  model: string;
  pid?: number;
  startedAt: number;
  lastActivity?: number;
  status?: string;
  readiness?: SessionReadiness;
  subagent?: SessionSubagentMetadata;
}): IntercomRegistration {
  return {
    piSessionId: input.piSessionId,
    alias: input.alias,
    namespace: input.namespace,
    cwd: input.cwd,
    model: input.model,
    pid: input.pid ?? process.pid,
    startedAt: input.startedAt,
    lastActivity: input.lastActivity ?? Date.now(),
    leaseTtlMs: INTERCOM_LEASE_TTL_MS,
    heartbeatIntervalMs: INTERCOM_HEARTBEAT_INTERVAL_MS,
    ...(input.status ? { status: input.status } : {}),
    ...(input.readiness ? { readiness: input.readiness } : {}),
    ...(input.subagent ? { subagent: input.subagent } : {}),
  };
}

export interface Message {
  id: string;
  timestamp: number;
  to?: {
    intercomSessionId?: string;
    piSessionId?: string;
    alias?: string;
  };
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export interface SendTargetEnvelope {
  intercomSessionId?: string;
  piSessionId?: string;
  alias?: string;
  namespace?: string;
  global?: boolean;
}

export type IntercomMessageOrigin = "manual" | "machine";

export type ClientMessage =
  | { type: "register"; session: IntercomRegistration }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string | SendTargetEnvelope; message: Message; origin?: IntercomMessageOrigin }
  | { type: "heartbeat" }
  | {
    type: "presence";
    alias?: string;
    status?: string;
    model?: string;
    readiness?: SessionReadiness;
    subagent?: SessionSubagentMetadata;
  };

export type BrokerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string };
