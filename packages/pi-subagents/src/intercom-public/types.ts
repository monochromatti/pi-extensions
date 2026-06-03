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

export interface OutboundMessage {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface ResolvedTargetIdentity {
  intercomSessionId: string;
  piSessionId: string;
  alias?: string;
}

export interface DeliveredMessage extends OutboundMessage {
  to: ResolvedTargetIdentity;
}

export type Message = OutboundMessage | DeliveredMessage;

export interface DeliveryFailureCandidate {
  intercomSessionId: string;
  piSessionId: string;
  alias: string;
  namespace: string;
  cwd: string;
  pid: number;
  startedAt: number;
  leaseExpiresAt?: number;
}

export type DeliveryFailure =
  | { code: "forged-sender" }
  | { code: "unregistered-sender" }
  | { code: "unsafe-machine-alias-target" }
  | { code: "target-not-found" }
  | { code: "expired-target" }
  | { code: "ambiguous-alias"; label: string; candidates: DeliveryFailureCandidate[] }
  | { code: "duplicate-pi-session"; piSessionId: string; candidates: DeliveryFailureCandidate[] };

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type IdentitySnapshotReconnectPolicy = "same-intercom-session" | "same-pi-session-if-unique";

export interface IntercomSessionTarget {
  kind: "intercom-session";
  intercomSessionId: string;
}

export interface PiSessionTarget {
  kind: "pi-session";
  piSessionId: string;
}

export interface IdentitySnapshotTarget {
  kind: "identity-snapshot";
  intercomSessionId: string;
  piSessionId: string;
  alias?: string;
  reconnect: IdentitySnapshotReconnectPolicy;
}

export interface ScopedAliasTarget {
  kind: "scoped-alias";
  alias: string;
  namespace: string;
}

export interface GlobalAliasTarget {
  kind: "global-alias";
  alias: string;
}

export type IntercomTarget =
  | IntercomSessionTarget
  | PiSessionTarget
  | IdentitySnapshotTarget
  | ScopedAliasTarget
  | GlobalAliasTarget;

export type MachineIntercomTarget = IntercomSessionTarget | PiSessionTarget | IdentitySnapshotTarget;
export type ManualIntercomTarget = IntercomTarget;

export type SendTargetEnvelope = IntercomTarget;

export type IntercomMessageOrigin = "manual" | "machine";

export type ClientMessage =
  | { type: "register"; session: IntercomRegistration }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: ManualIntercomTarget; message: OutboundMessage; origin: IntercomMessageOrigin }
  | { type: "heartbeat" }
  | {
    type: "presence";
    status?: string;
    model?: string;
    readiness?: SessionReadiness;
    subagent?: SessionSubagentMetadata;
  };

export type BrokerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: DeliveredMessage }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; failure: DeliveryFailure };
