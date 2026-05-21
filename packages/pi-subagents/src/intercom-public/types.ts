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

export interface SessionInfo {
  id: string;
  piSessionId?: string;
  protocolVersion?: number;
  capabilities?: string[];
  namespace?: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  readiness?: SessionReadiness;
  subagent?: SessionSubagentMetadata;
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
}

export type ClientMessage =
  | { type: "register"; session: Omit<SessionInfo, "id"> }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string | SendTargetEnvelope; message: Message }
  | {
    type: "presence";
    name?: string;
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
