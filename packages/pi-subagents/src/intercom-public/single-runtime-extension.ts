import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { IntercomClient } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { SessionListOverlay } from "./ui/session-list.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";
import { loadConfig, type IntercomConfig } from "./config.ts";
import type {
  SessionInfo,
  SessionReadiness,
  SessionSubagentMetadata,
  Message,
  Attachment,
  SendTargetEnvelope,
} from "./types.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import type { SupervisorIntercomTarget } from "../shared/types.ts";

const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const INBOUND_FLUSH_DELAY_MS = 200;
const INBOUND_IDLE_RETRY_MS = 500;
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";
const MAX_DROPPED_MISROUTE_DIAGNOSTICS = 50;
const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
const SUBAGENT_ORCHESTRATOR_CWD_ENV = "PI_SUBAGENT_ORCHESTRATOR_CWD";
const SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID_ENV = "PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID";
const SUBAGENT_SUPERVISOR_PI_SESSION_ID_ENV = "PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID";
const SUBAGENT_SUPERVISOR_ALIAS_ENV = "PI_SUBAGENT_SUPERVISOR_ALIAS";
const SUBAGENT_SUPERVISOR_CWD_ENV = "PI_SUBAGENT_SUPERVISOR_CWD";
const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
const INTERCOM_PROTOCOL_V2 = 2;
const PI_SESSION_ROUTING_CAPABILITY = "piSessionId-routing";
const READY_WAIT_POLL_MS = 100;
const DEFAULT_SUBAGENT_READY_WAIT_MS = 5000;
const DEFAULT_MANUAL_SEND_READY_WAIT_MS = 2000;
const DEFAULT_MANUAL_ASK_READY_WAIT_MS = 5000;
const DEFAULT_MANUAL_REPLY_READY_WAIT_MS = 2000;

export interface IntercomRuntimeScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface SingleRuntimeRegisterOptions {
  scheduler?: IntercomRuntimeScheduler;
  onSupervisorTargetResolver?: (resolver: (() => Promise<SupervisorIntercomTarget>) | null) => void;
}

const defaultRuntimeScheduler: IntercomRuntimeScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

interface ChildOrchestratorMetadata {
  supervisorTarget: ChildOrchestratorSupervisorTarget;
  runId: string;
  agent: string;
  index: string;
  sessionName?: string;
}

interface ChildOrchestratorSupervisorTarget {
  alias: string;
  cwd: string;
  intercomSessionId?: string;
  piSessionId?: string;
}

interface ReplySenderMatcher {
  intercomSessionId?: string;
  piSessionId?: string;
  alias?: string;
}

interface InboundMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

interface DroppedMisrouteDiagnostic {
  messageId: string;
  senderId: string;
  senderName?: string;
  intendedPiSessionId: string;
  actualPiSessionId: string;
  timestamp: number;
  reason: "receiver_pi_session_mismatch";
}

interface ParsedSubagentIntercomPayload {
  to: string | SendTargetEnvelope;
  message: string;
  requestId?: string;
  ownerPiSessionId?: string;
  runId?: string;
  agent?: string;
  index?: number;
  waitForReadyMs?: number;
  source?: string;
}

interface LiveSubagentLocator {
  ownerPiSessionId: string;
  runId: string;
  agent: string;
  index: number;
}

type ContactSupervisorReason = "need_decision" | "progress_update" | "interview_request";

interface SupervisorInterviewQuestion extends Record<string, unknown> {
  id: string;
  type: "single" | "multi" | "text" | "image" | "info";
  question: string;
  options?: unknown[];
}

interface SupervisorInterviewRequest extends Record<string, unknown> {
  title?: string;
  description?: string;
  questions: SupervisorInterviewQuestion[];
}

interface SupervisorInterviewReply {
  responses: Array<{ id: string; value: unknown }>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatAttachments(attachments: Attachment[]): string {
  let text = "";
  for (const att of attachments) {
    if (att.language) {
      text += `\n\n---\n📎 ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\n📎 ${att.name}\n${att.content}`;
    }
  }
  return text;
}

function normalizeSupervisorTargetEnvelope(target: Partial<SupervisorIntercomTarget>): SupervisorIntercomTarget | null {
  const intercomSessionId = target.intercomSessionId?.trim();
  const piSessionId = target.piSessionId?.trim();
  const alias = target.alias?.trim();
  const cwd = target.cwd?.trim();
  if (!intercomSessionId || !piSessionId || !alias || !cwd) {
    return null;
  }
  return {
    intercomSessionId,
    piSessionId,
    alias,
    cwd,
  };
}

function hasEnvVar(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(process.env, key);
}

function hasStructuredSupervisorTarget(target: ChildOrchestratorSupervisorTarget): target is SupervisorIntercomTarget {
  return Boolean(target.intercomSessionId?.trim() && target.piSessionId?.trim());
}

function readChildOrchestratorMetadata(): ChildOrchestratorMetadata | null {
  const hasAnyStructuredSupervisorEnv = [
    SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID_ENV,
    SUBAGENT_SUPERVISOR_PI_SESSION_ID_ENV,
    SUBAGENT_SUPERVISOR_ALIAS_ENV,
    SUBAGENT_SUPERVISOR_CWD_ENV,
  ].some(hasEnvVar);

  const supervisorTarget = normalizeSupervisorTargetEnvelope({
    intercomSessionId: process.env[SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID_ENV],
    piSessionId: process.env[SUBAGENT_SUPERVISOR_PI_SESSION_ID_ENV],
    alias: process.env[SUBAGENT_SUPERVISOR_ALIAS_ENV],
    cwd: process.env[SUBAGENT_SUPERVISOR_CWD_ENV],
  });

  if (hasAnyStructuredSupervisorEnv && !supervisorTarget) {
    return null;
  }

  const legacyOrchestratorTarget = process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV]?.trim();
  const legacyOrchestratorCwd = process.env[SUBAGENT_ORCHESTRATOR_CWD_ENV]?.trim();
  const runId = process.env[SUBAGENT_RUN_ID_ENV]?.trim();
  const agent = process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim();
  const index = process.env[SUBAGENT_CHILD_INDEX_ENV]?.trim();
  const fallbackSupervisor = legacyOrchestratorTarget
    ? ({
      alias: legacyOrchestratorTarget,
      cwd: legacyOrchestratorCwd ?? process.cwd(),
    } satisfies ChildOrchestratorSupervisorTarget)
    : null;

  const effectiveSupervisorTarget = supervisorTarget ?? fallbackSupervisor;
  if (!effectiveSupervisorTarget || !runId || !agent || !index) {
    return null;
  }
  const sessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
  return {
    supervisorTarget: effectiveSupervisorTarget,
    runId,
    agent,
    index,
    ...(sessionName ? { sessionName } : {}),
  };
}

function formatChildOrchestratorMessage(kind: "ask" | "update" | "interview", metadata: ChildOrchestratorMetadata, message: string): string {
  const heading = kind === "ask"
    ? "Subagent needs a supervisor decision."
    : kind === "interview"
      ? "Subagent requests a structured supervisor interview."
      : "Subagent progress update.";
  return [
    heading,
    `Run: ${metadata.runId}`,
    `Agent: ${metadata.agent}`,
    `Child index: ${metadata.index}`,
    `Supervisor alias: ${metadata.supervisorTarget.alias}`,
    metadata.sessionName ? `Child intercom target: ${metadata.sessionName}` : undefined,
    "",
    message,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatSupervisorTargetLabel(target: ChildOrchestratorSupervisorTarget): string {
  if (hasStructuredSupervisorTarget(target)) {
    return `${target.alias} (intercomSessionId=${target.intercomSessionId}, piSessionId=${target.piSessionId})`;
  }
  return `${target.alias} (legacy alias routing)`;
}

function formatSupervisorTargetUnavailableReason(target: ChildOrchestratorSupervisorTarget, reason: string): string {
  const structured = hasStructuredSupervisorTarget(target)
    ? `intercomSessionId=${target.intercomSessionId}, piSessionId=${target.piSessionId}, alias=${target.alias}`
    : `alias=${target.alias}`;
  return `Supervisor intercom target is unavailable. Broker could not resolve target envelope: ${structured}. Reason: ${reason}`;
}

function validateSupervisorInterviewRequest(input: unknown): { ok: true; interview: SupervisorInterviewRequest } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "interview must be an object with a questions array" };
  }

  const raw = input as Record<string, unknown>;
  if (raw.title !== undefined && typeof raw.title !== "string") {
    return { ok: false, error: "interview.title must be a string when provided" };
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return { ok: false, error: "interview.description must be a string when provided" };
  }
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    return { ok: false, error: "interview.questions must be a non-empty array" };
  }

  const validTypes = new Set(["single", "multi", "text", "image", "info"]);
  const ids = new Set<string>();
  const questions: SupervisorInterviewQuestion[] = [];

  for (let index = 0; index < raw.questions.length; index++) {
    const questionInput = raw.questions[index];
    if (!questionInput || typeof questionInput !== "object" || Array.isArray(questionInput)) {
      return { ok: false, error: `interview.questions[${index}] must be an object` };
    }
    const question = questionInput as Record<string, unknown>;
    if (typeof question.id !== "string" || question.id.trim() === "") {
      return { ok: false, error: `interview.questions[${index}].id must be a non-empty string` };
    }
    const id = question.id.trim();
    if (ids.has(id)) {
      return { ok: false, error: `interview question id must be unique: ${id}` };
    }
    ids.add(id);

    if (typeof question.type !== "string" || !validTypes.has(question.type)) {
      return { ok: false, error: `interview.questions[${index}].type must be one of: single, multi, text, image, info` };
    }
    if (typeof question.question !== "string" || question.question.trim() === "") {
      return { ok: false, error: `interview.questions[${index}].question must be a non-empty string` };
    }
    if (question.context !== undefined && typeof question.context !== "string") {
      return { ok: false, error: `interview.questions[${index}].context must be a string when provided` };
    }
    let options: unknown[] | undefined;
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) {
        return { ok: false, error: `interview.questions[${index}].options must be an array when provided` };
      }
      options = [];
      for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
        const option = question.options[optionIndex];
        if (typeof option === "string") {
          const label = option.trim();
          if (!label) {
            return { ok: false, error: `interview.questions[${index}].options[${optionIndex}] must not be empty` };
          }
          options.push(label);
        } else if (!option || typeof option !== "object" || Array.isArray(option) || typeof (option as { label?: unknown }).label !== "string" || (option as { label: string }).label.trim() === "") {
          return { ok: false, error: `interview.questions[${index}].options[${optionIndex}] must be a non-empty string or an object with a non-empty label` };
        } else {
          options.push({ ...option, label: (option as { label: string }).label.trim() });
        }
      }
    }
    if ((question.type === "single" || question.type === "multi") && (!options || options.length === 0)) {
      return { ok: false, error: `interview.questions[${index}].options must be a non-empty array for ${question.type} questions` };
    }
    if (question.type !== "single" && question.type !== "multi" && options) {
      return { ok: false, error: `interview.questions[${index}].options is only valid for single and multi questions` };
    }

    questions.push({
      ...question,
      id,
      type: question.type as SupervisorInterviewQuestion["type"],
      question: question.question.trim(),
      ...(options ? { options } : {}),
    });
  }

  return {
    ok: true,
    interview: {
      ...raw,
      ...(typeof raw.title === "string" ? { title: raw.title.trim() } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}),
      questions,
    },
  };
}

function interviewOptionLabel(option: unknown): string {
  return typeof option === "string" ? option : (option as { label: string }).label;
}

function interviewExampleValue(question: SupervisorInterviewQuestion): unknown {
  if (question.type === "multi") {
    return question.options?.slice(0, 2).map(interviewOptionLabel) ?? [];
  }
  if (question.type === "single") {
    return question.options?.[0] !== undefined ? interviewOptionLabel(question.options[0]) : "option label";
  }
  if (question.type === "image") {
    return "image/file reference or description";
  }
  return "answer text";
}

function formatSupervisorInterviewRequest(interview: SupervisorInterviewRequest, message?: string): string {
  const lines: string[] = [];
  const title = interview.title?.trim();
  if (title) lines.push(`Interview: ${title}`);
  const description = interview.description?.trim();
  if (description) lines.push(description);
  const note = message?.trim();
  if (note) lines.push(`Child note: ${note}`);
  if (lines.length > 0) lines.push("");

  lines.push("Questions:");
  interview.questions.forEach((question, index) => {
    lines.push(`${index + 1}. [${question.id}] (${question.type}) ${question.question}`);
    if (typeof question.context === "string" && question.context.trim()) {
      lines.push(`   Context: ${question.context.trim()}`);
    }
    if (question.options?.length) {
      lines.push("   Options:");
      for (const option of question.options) {
        lines.push(`   - ${interviewOptionLabel(option)}`);
      }
    }
  });

  const responseExample = {
    responses: interview.questions
      .filter((question) => question.type !== "info")
      .map((question) => ({
        id: question.id,
        value: interviewExampleValue(question),
      })),
  };

  lines.push(
    "",
    "Supervisor reply instructions:",
    "Reply with plain JSON or a fenced ```json block using this stable shape. Use the question ids exactly. Info questions are context-only and do not need responses. For single questions, value is one option label. For multi questions, value is an array of option labels. For text/image questions, value is a string unless the question asks otherwise.",
    "",
    "```json",
    JSON.stringify(responseExample, null, 2),
    "```",
  );

  return lines.join("\n");
}

function validateSupervisorInterviewReply(value: unknown, interview: SupervisorInterviewRequest): SupervisorInterviewReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reply JSON must be an object with a responses array");
  }

  const responsesInput = (value as Record<string, unknown>).responses;
  if (!Array.isArray(responsesInput)) {
    throw new Error("reply JSON must include a responses array");
  }

  const questionById = new Map(interview.questions
    .filter((question) => question.type !== "info")
    .map((question) => [question.id, question]));
  const seenIds = new Set<string>();
  const responses: SupervisorInterviewReply["responses"] = [];

  for (let index = 0; index < responsesInput.length; index++) {
    const response = responsesInput[index];
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error(`responses[${index}] must be an object`);
    }

    const raw = response as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.trim() === "") {
      throw new Error(`responses[${index}].id must be a non-empty string`);
    }
    const id = raw.id.trim();
    const question = questionById.get(id);
    if (!question) {
      throw new Error(`responses[${index}].id must match a non-info interview question id`);
    }
    if (seenIds.has(id)) {
      throw new Error(`responses[${index}].id is duplicated: ${id}`);
    }
    seenIds.add(id);
    if (!Object.hasOwn(raw, "value")) {
      throw new Error(`responses[${index}].value is required`);
    }

    const value = raw.value;
    if (question.type === "single") {
      if (typeof value !== "string") throw new Error(`responses[${index}].value must be a string for single questions`);
      const optionLabels = new Set(question.options?.map(interviewOptionLabel));
      if (!optionLabels.has(value.trim())) throw new Error(`responses[${index}].value must match one of the question options`);
      responses.push({ id, value: value.trim() });
      continue;
    }

    if (question.type === "multi") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`responses[${index}].value must be an array of strings for multi questions`);
      }
      const optionLabels = new Set(question.options?.map(interviewOptionLabel));
      const selected = value.map((item) => item.trim());
      const invalid = selected.find((item) => !optionLabels.has(item));
      if (invalid) throw new Error(`responses[${index}].value contains an option that is not in the question options: ${invalid}`);
      responses.push({ id, value: selected });
      continue;
    }

    if (typeof value !== "string") {
      throw new Error(`responses[${index}].value must be a string for ${question.type} questions`);
    }
    responses.push({ id, value });
  }

  return { responses };
}

function parseStructuredSupervisorReply(text: string, interview: SupervisorInterviewRequest): { value?: SupervisorInterviewReply; error?: string } | undefined {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fencedMatch?.[1] ?? text).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    return undefined;
  }
  try {
    return { value: validateSupervisorInterviewReply(JSON.parse(candidate), interview) };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}
function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  return new Set(
    sessions
      .map(s => s.name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
      .filter((name, index, names) => names.indexOf(name) !== index)
  );
}
function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
function normalizeRelayTarget(target: unknown): SendTargetEnvelope | null {
  if (typeof target !== "object" || target === null) {
    return null;
  }
  const candidate = target as {
    intercomSessionId?: unknown;
    piSessionId?: unknown;
    alias?: unknown;
    namespace?: unknown;
  };
  const intercomSessionId = typeof candidate.intercomSessionId === "string" ? candidate.intercomSessionId.trim() : "";
  const piSessionId = typeof candidate.piSessionId === "string" ? candidate.piSessionId.trim() : "";
  const alias = typeof candidate.alias === "string" ? candidate.alias.trim() : "";
  const namespace = typeof candidate.namespace === "string" ? candidate.namespace.trim() : "";
  if (!intercomSessionId && !piSessionId && !alias) {
    return null;
  }
  return {
    ...(intercomSessionId ? { intercomSessionId } : {}),
    ...(piSessionId ? { piSessionId } : {}),
    ...(alias ? { alias } : {}),
    ...(namespace ? { namespace } : {}),
  };
}

function formatRelayTarget(target: string | SendTargetEnvelope): string {
  if (typeof target === "string") return target;
  const parts = [
    target.intercomSessionId ? `intercomSessionId=${target.intercomSessionId}` : undefined,
    target.piSessionId ? `piSessionId=${target.piSessionId}` : undefined,
    target.alias ? `alias=${target.alias}` : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? parts.join(", ") : "unknown-target";
}

function parseSubagentIntercomPayload(payload: unknown): ParsedSubagentIntercomPayload | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const target = normalizeRelayTarget(record.target)
    ?? (typeof record.to === "string" && record.to.trim() ? record.to.trim() : null);
  if (!target || typeof record.message !== "string") {
    return null;
  }
  const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
  const ownerPiSessionId = typeof record.ownerPiSessionId === "string" && record.ownerPiSessionId.trim()
    ? record.ownerPiSessionId.trim()
    : undefined;
  const runId = typeof record.runId === "string" && record.runId.trim() ? record.runId.trim() : undefined;
  const agent = typeof record.agent === "string" && record.agent.trim() ? record.agent.trim() : undefined;
  const index = typeof record.index === "number" && Number.isInteger(record.index) ? record.index : undefined;
  const waitForReadyMs = typeof record.waitForReadyMs === "number" && Number.isFinite(record.waitForReadyMs) && record.waitForReadyMs >= 0
    ? record.waitForReadyMs
    : undefined;
  const source = typeof record.source === "string" && record.source.trim() ? record.source.trim() : undefined;

  return {
    to: target,
    message: record.message,
    ...(requestId ? { requestId } : {}),
    ...(ownerPiSessionId ? { ownerPiSessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(agent ? { agent } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(waitForReadyMs !== undefined ? { waitForReadyMs } : {}),
    ...(source ? { source } : {}),
  };
}
function resolveIntercomPresenceName(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}
function buildPresenceIdentity(pi: ExtensionAPI, sessionId: string): { name: string } {
  return {
    name: resolveIntercomPresenceName(pi.getSessionName(), sessionId),
  };
}

function toSubagentLocator(payload: ParsedSubagentIntercomPayload): LiveSubagentLocator | null {
  if (!payload.ownerPiSessionId || !payload.runId || !payload.agent || payload.index === undefined) {
    return null;
  }
  return {
    ownerPiSessionId: payload.ownerPiSessionId,
    runId: payload.runId,
    agent: payload.agent,
    index: payload.index,
  };
}

function resolveSubagentRegistrationMetadata(metadata: ChildOrchestratorMetadata | null): SessionSubagentMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const ownerPiSessionId = metadata.supervisorTarget.piSessionId?.trim();
  if (!ownerPiSessionId) {
    return undefined;
  }
  const runId = metadata.runId.trim();
  const agent = metadata.agent.trim();
  const parsedIndex = Number.parseInt(metadata.index, 10);
  if (!runId || !agent || !Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return undefined;
  }
  return {
    ownerPiSessionId,
    runId,
    agent,
    index: parsedIndex,
  };
}

function isSessionReadyForRelay(session: SessionInfo): boolean {
  const readiness = session.readiness;
  if (!readiness) {
    return true;
  }
  return readiness.state === "ready";
}
function formatSessionLabel(session: SessionInfo, duplicates: Set<string>): string {
  if (!session.name) {
    return session.id;
  }
  return duplicates.has(session.name.toLowerCase())
    ? `${session.name} (${shortSessionId(session.id)})`
    : session.name;
}
function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `• ${name} (${shortSessionId(session.id)}) — ${session.cwd} (${session.model})${suffix}`;
}

function sessionDetails(session: SessionInfo) {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    model: session.model,
    status: session.status,
    protocolVersion: session.protocolVersion,
    capabilities: session.capabilities,
    piSessionId: session.piSessionId,
  };
}

function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
function firstTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.replace(/\*\*/g, "") ?? "";
}
export default function piIntercomExtension(pi: ExtensionAPI, options: SingleRuntimeRegisterOptions = {}) {
  const runtimeScheduler = options.scheduler ?? defaultRuntimeScheduler;
  let client: IntercomClient | null = null;
  const config: IntercomConfig = loadConfig();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: unknown | null = null;
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let startupConnectTimer: unknown | null = null;
  let reconnectAttempt = 0;
  let shuttingDown = false;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  const activeTools = new Map<string, string>();
  const replyTracker = new ReplyTracker();
  const pendingIdleMessages: InboundMessageEntry[] = [];
  const droppedMisrouteDiagnostics: DroppedMisrouteDiagnostic[] = [];
  let inboundFlushTimer: unknown | null = null;
  let replyWaiter: {
    from: ReplySenderMatcher;
    replyTo: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  } | null = null;
  const childOrchestratorMetadata = readChildOrchestratorMetadata();
  const subagentRegistrationMetadata = resolveSubagentRegistrationMetadata(childOrchestratorMetadata);
  function waitForReply(from: string | ReplySenderMatcher, replyTo: string, signal?: AbortSignal): Promise<Message> {
    if (replyWaiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    const matcher: ReplySenderMatcher = typeof from === "string"
      ? { intercomSessionId: from, alias: from }
      : from;
    const fromLabel = matcher.alias || matcher.intercomSessionId || matcher.piSessionId || "supervisor";
    return new Promise((resolve, reject) => {
      const timeout = runtimeScheduler.setTimeout(() => {
        rejectReplyWaiter(new Error(`No reply from "${fromLabel}" within 10 minutes`));
      }, 10 * 60 * 1000);
      const cleanup = () => {
        runtimeScheduler.clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (replyWaiter?.replyTo === replyTo) {
          replyWaiter = null;
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = {
        from: matcher,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }
  function rejectReplyWaiter(error: Error): void {
    replyWaiter?.reject(error);
  }
  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    runtimeScheduler.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function clearStartupConnectTimer(): void {
    if (!startupConnectTimer) {
      return;
    }
    runtimeScheduler.clearTimeout(startupConnectTimer);
    startupConnectTimer = null;
  }
  function clearInboundFlushTimer(): void {
    if (!inboundFlushTimer) {
      return;
    }
    runtimeScheduler.clearTimeout(inboundFlushTimer);
    inboundFlushTimer = null;
  }
  function getLiveContext(ctx: ExtensionContext | null = runtimeContext, generation = runtimeGeneration): ExtensionContext | null {
    if (disposed || shuttingDown || generation !== runtimeGeneration || !ctx) {
      return null;
    }
    try {
      if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) {
        return null;
      }
      void ctx.hasUI;
      return ctx;
    } catch {
      // A context that throws while reading session/UI state is no longer usable.
      return null;
    }
  }
  function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext?.hasUI) {
      return;
    }
    try {
      liveContext.ui.notify(message, level);
    } catch {
      // The UI can disappear during session shutdown/reload while async overlay work is settling.
    }
  }
  function getReconnectDelayMs(): number {
    const backoffMs = [1000, 2000, 5000, 10000, 30000];
    return backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]!;
  }
  function currentStatus(): string {
    const activeToolName = activeTools.values().next().value;
    const lifecycleStatus = activeToolName ? `tool:${activeToolName}` : agentRunning ? "thinking" : "idle";
    return config.status ? `${lifecycleStatus} · ${config.status}` : lifecycleStatus;
  }
  function buildRegistration(): Omit<SessionInfo, "id"> {
    const liveContext = getLiveContext();
    if (!liveContext || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }

    const identity = buildPresenceIdentity(pi, currentSessionId);
    const readiness: SessionReadiness = {
      state: "initializing",
      updatedAt: Date.now(),
    };
    return {
      piSessionId: currentSessionId,
      protocolVersion: INTERCOM_PROTOCOL_V2,
      capabilities: [PI_SESSION_ROUTING_CAPABILITY],
      name: identity.name,
      cwd: liveContext.cwd ?? process.cwd(),
      model: currentModel,
      pid: process.pid,
      startedAt: sessionStartedAt,
      lastActivity: Date.now(),
      status: currentStatus(),
      readiness,
      ...(subagentRegistrationMetadata ? { subagent: subagentRegistrationMetadata } : {}),
    };
  }
  function syncPresenceIdentity(sessionId: string): void {
    if (!client || !getLiveContext()) {
      return;
    }
    client.updatePresence({ ...buildPresenceIdentity(pi, sessionId), status: currentStatus() });
  }
  function syncPresenceStatus(): void {
    if (!client || !currentSessionId || !getLiveContext()) {
      return;
    }
    client.updatePresence({ status: currentStatus() });
  }
  function syncReadiness(state: SessionReadiness["state"], reason?: string): void {
    if (!client || !getLiveContext()) {
      return;
    }
    client.updatePresence({
      readiness: {
        state,
        ...(reason ? { reason } : {}),
        updatedAt: Date.now(),
      },
    });
  }
  function currentSessionTargetMatches(to: string | { intercomSessionId?: string; piSessionId?: string; alias?: string }, activeClient?: IntercomClient): boolean {
    const targets = new Set<string>();
    const addTarget = (target: string | undefined | null) => {
      const trimmed = target?.trim();
      if (trimmed) targets.add(trimmed.toLowerCase());
    };
    addTarget(currentSessionId);
    addTarget(activeClient?.sessionId);
    addTarget(pi.getSessionName());
    if (currentSessionId) addTarget(buildPresenceIdentity(pi, currentSessionId).name);
    if (typeof to === "string") {
      return targets.has(to.trim().toLowerCase());
    }
    return [to.intercomSessionId, to.piSessionId, to.alias]
      .some((candidate) => typeof candidate === "string" && targets.has(candidate.trim().toLowerCase()));
  }
  function sendIncomingMessage(entry: InboundMessageEntry, delivery: "trigger" | "followUp", generation = runtimeGeneration): void {
    if (runtimeStarted && !getLiveContext(runtimeContext, generation)) {
      return;
    }
    if (delivery !== "followUp") {
      replyTracker.queueTurnContext({ from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = entry.replyCommand ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
    pi.sendMessage(
      {
        customType: "intercom_message",
        content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
        display: true,
        details: entry,
      },
      delivery === "trigger"
        ? { triggerTurn: true }
        : { deliverAs: "followUp" }
    );
  }
  function scheduleInboundFlush(delayMs = INBOUND_FLUSH_DELAY_MS): void {
    if (!getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    clearInboundFlushTimer();
    inboundFlushTimer = runtimeScheduler.setTimeout(() => {
      inboundFlushTimer = null;
      flushIdleMessages(scheduledGeneration);
    }, delayMs);
  }
  function flushIdleMessages(generation = runtimeGeneration): void {
    if (pendingIdleMessages.length === 0) {
      return;
    }
    const ctx = getLiveContext(runtimeContext, generation);
    if (!ctx) {
      return;
    }

    let isIdle: boolean;
    try {
      isIdle = ctx.isIdle();
    } catch {
      // Stale contexts are cleaned up by shutdown/reload; do not deliver queued messages through them.
      return;
    }
    if (!isIdle) {
      scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
      return;
    }

    const entries = pendingIdleMessages.splice(0, pendingIdleMessages.length);
    entries.forEach((entry, index) => {
      sendIncomingMessage(entry, index === 0 ? "trigger" : "followUp");
    });
  }
  function queueIdleMessage(entry: InboundMessageEntry): void {
    pendingIdleMessages.push(entry);
    scheduleInboundFlush();
  }
  function recordDroppedMisroutedMessage(from: SessionInfo, message: Message, actualPiSessionId: string): void {
    const intendedPiSessionId = message.to?.piSessionId;
    if (!intendedPiSessionId) {
      return;
    }

    const diagnostic: DroppedMisrouteDiagnostic = {
      messageId: message.id,
      senderId: from.id,
      ...(from.name ? { senderName: from.name } : {}),
      intendedPiSessionId,
      actualPiSessionId,
      timestamp: message.timestamp,
      reason: "receiver_pi_session_mismatch",
    };

    droppedMisrouteDiagnostics.push(diagnostic);
    if (droppedMisrouteDiagnostics.length > MAX_DROPPED_MISROUTE_DIAGNOSTICS) {
      droppedMisrouteDiagnostics.splice(0, droppedMisrouteDiagnostics.length - MAX_DROPPED_MISROUTE_DIAGNOSTICS);
    }

    pi.appendEntry("intercom_misroute_dropped", diagnostic);
  }

  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message): void {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      return;
    }

    const runtimePiSessionId = currentSessionId ?? ctx.sessionManager.getSessionId();
    if (message.to?.piSessionId && message.to.piSessionId !== runtimePiSessionId) {
      recordDroppedMisroutedMessage(from, message, runtimePiSessionId);
      return;
    }
    if (replyWaiter) {
      const fromMatches = (replyWaiter.from.intercomSessionId && from.id === replyWaiter.from.intercomSessionId)
        || (replyWaiter.from.piSessionId && from.piSessionId === replyWaiter.from.piSessionId)
        || (replyWaiter.from.alias && from.name?.toLowerCase() === replyWaiter.from.alias.toLowerCase());
      const replyMatches = message.replyTo === replyWaiter.replyTo;
      if (fromMatches && replyMatches) {
        replyWaiter.resolve(message);
        return;
      }
    }
    const attachmentText = message.content.attachments?.length
      ? formatAttachments(message.content.attachments)
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && message.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    replyTracker.recordIncomingMessage(from, message);
    const entry = { from, message, replyCommand, bodyText };
    void (async () => {
      const activeContext = getLiveContext(liveContext, messageGeneration);
      if (!activeContext) {
        return;
      }
      if (!activeContext.isIdle()) {
        if (!activeContext.hasUI) {
          const activeClient = client;
          if (!message.replyTo && activeClient?.isConnected()) {
            try {
              const result = await activeClient.send(from.id, {
                text: "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.",
                replyTo: message.id,
              });
              if (result.delivered && getLiveContext(liveContext, messageGeneration)) {
                replyTracker.markReplied(message.id);
              }
            } catch {
              // Best-effort reply; keep the busy non-interactive session running either way.
            }
          }
          return;
        }
        queueIdleMessage(entry);
        return;
      }
      if (getLiveContext(liveContext, messageGeneration)) {
        sendIncomingMessage(entry, "trigger", messageGeneration);
      }
    })();
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.on("message", (from, message) => {
      const liveContext = getLiveContext();
      if (client !== nextClient || !liveContext) {
        return;
      }
      handleIncomingMessage(liveContext, from, message);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      if (!shuttingDown && !disposed) {
        clearReconnectTimer();
        scheduleReconnect();
      }
    });
    nextClient.on("error", () => {
      // Keep broker/socket noise out of the TUI. Reconnect logic runs from the disconnect path.
    });
  }
  function scheduleReconnect(): void {
    if (disposed || shuttingDown || reconnectTimer || reconnectPromise || !getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    reconnectTimer = runtimeScheduler.setTimeout(() => {
      reconnectTimer = null;
      if (scheduledGeneration !== runtimeGeneration || !getLiveContext()) {
        return;
      }
      reconnectAttempt += 1;
      void ensureConnected("background").catch(() => {
        // ensureConnected("background") already queued the next retry.
      });
    }, getReconnectDelayMs());
  }
  async function ensureConnected(reason: "startup" | "background" | "tool" | "overlay"): Promise<IntercomClient> {
    if (!config.enabled) {
      throw new Error("Intercom disabled");
    }
    if (disposed || shuttingDown) {
      throw new Error("Intercom shutting down");
    }
    if (client && client.isConnected()) {
      return client;
    }
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise && reconnectPromiseGeneration === generationAtStart) {
      return reconnectPromise;
    }
    const nextReconnectPromise = (async () => {
      const nextClient = new IntercomClient();
      client = nextClient;
      attachClientHandlers(nextClient);
      try {
        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        await nextClient.connect(buildRegistration());
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        reconnectAttempt = 0;
        syncReadiness("ready");
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
        }
        if (reason === "background" && getLiveContext(contextAtStart, generationAtStart)) {
          scheduleReconnect();
        }
        throw toError(error);
      } finally {
        if (reconnectPromise === nextReconnectPromise) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    return nextReconnectPromise;
  }
  async function findSessionByNameOrId(activeClient: IntercomClient, nameOrId: string): Promise<SessionInfo | null> {
    const sessions = await activeClient.listSessions();
    const byId = sessions.find((s) => s.id === nameOrId);
    if (byId) {
      return byId;
    }
    const lowerName = nameOrId.toLowerCase();
    const byName = sessions.filter((s) => s.name?.toLowerCase() === lowerName);
    if (byName.length > 1) {
      throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
    }
    return byName[0] ?? null;
  }

  function findLiveSubagentSession(
    sessions: SessionInfo[],
    locator: LiveSubagentLocator,
  ): SessionInfo | null {
    const matches = sessions.filter((session) => {
      const subagent = session.subagent;
      if (!subagent) {
        return false;
      }
      return subagent.ownerPiSessionId === locator.ownerPiSessionId
        && subagent.runId === locator.runId
        && subagent.agent === locator.agent
        && subagent.index === locator.index;
    });

    if (matches.length === 1) {
      return matches[0] ?? null;
    }

    if (matches.length > 1) {
      const ready = matches.filter(isSessionReadyForRelay);
      if (ready.length === 1) {
        return ready[0] ?? null;
      }
      const sorted = (ready.length > 0 ? ready : matches).slice().sort((left, right) => (right.lastActivity ?? 0) - (left.lastActivity ?? 0));
      return sorted[0] ?? null;
    }

    return null;
  }

  async function waitForLiveSubagentSession(
    activeClient: IntercomClient,
    locator: LiveSubagentLocator,
    waitForReadyMs: number,
  ): Promise<SessionInfo | null> {
    const deadline = Date.now() + waitForReadyMs;
    while (true) {
      const sessions = await activeClient.listSessions();
      const candidate = findLiveSubagentSession(sessions, locator);
      if (candidate && isSessionReadyForRelay(candidate)) {
        return candidate;
      }
      if (Date.now() >= deadline) {
        return null;
      }
      await new Promise<void>((resolve) => {
        runtimeScheduler.setTimeout(resolve, READY_WAIT_POLL_MS);
      });
    }
  }
  function buildSessionTargetEnvelope(session: SessionInfo): SendTargetEnvelope {
    return {
      intercomSessionId: session.id,
      ...(session.piSessionId ? { piSessionId: session.piSessionId } : {}),
      ...(session.name ? { alias: session.name } : {}),
    };
  }
  function isRetryableDeliveryReason(reason: string | undefined): boolean {
    if (!reason) return false;
    const normalized = reason.toLowerCase();
    return normalized.includes("session not found")
      || normalized.includes("may not exist")
      || normalized.includes("has disconnected");
  }
  function targetsEquivalent(left: string | SendTargetEnvelope, right: string | SendTargetEnvelope): boolean {
    if (typeof left === "string" && typeof right === "string") {
      return left.trim().toLowerCase() === right.trim().toLowerCase();
    }
    if (typeof left === "string") {
      const normalized = left.trim().toLowerCase();
      return normalized === right.intercomSessionId?.trim().toLowerCase()
        || normalized === right.piSessionId?.trim().toLowerCase()
        || normalized === right.alias?.trim().toLowerCase();
    }
    if (typeof right === "string") {
      return targetsEquivalent(right, left);
    }
    return left.intercomSessionId?.trim().toLowerCase() === right.intercomSessionId?.trim().toLowerCase()
      && left.piSessionId?.trim().toLowerCase() === right.piSessionId?.trim().toLowerCase()
      && left.alias?.trim().toLowerCase() === right.alias?.trim().toLowerCase();
  }
  async function resolveTargetForManualRelay(
    activeClient: IntercomClient,
    to: string,
    waitForReadyMs: number,
  ): Promise<{ target: string | SendTargetEnvelope; session: SessionInfo | null }> {
    const deadline = Date.now() + Math.max(0, waitForReadyMs);
    while (true) {
      const session = await findSessionByNameOrId(activeClient, to);
      if (!session) {
        if (Date.now() >= deadline) return { target: to, session: null };
      } else if (isSessionReadyForRelay(session)) {
        return { target: buildSessionTargetEnvelope(session), session };
      } else if (Date.now() >= deadline) {
        return { target: buildSessionTargetEnvelope(session), session };
      }

      await new Promise<void>((resolve) => {
        runtimeScheduler.setTimeout(resolve, READY_WAIT_POLL_MS);
      });
    }
  }
  function replyMatcherForResolvedTarget(
    fallbackAlias: string,
    resolvedSession: SessionInfo | null,
  ): ReplySenderMatcher {
    if (!resolvedSession) {
      return { alias: fallbackAlias, intercomSessionId: fallbackAlias };
    }
    return {
      intercomSessionId: resolvedSession.id,
      ...(resolvedSession.piSessionId ? { piSessionId: resolvedSession.piSessionId } : {}),
      ...(resolvedSession.name ? { alias: resolvedSession.name } : { alias: fallbackAlias }),
    };
  }
  function pickMostRecentReadySession(candidates: SessionInfo[]): SessionInfo | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0] ?? null;
    const ready = candidates.filter(isSessionReadyForRelay);
    if (ready.length === 1) return ready[0] ?? null;
    const pool = ready.length > 0 ? ready : candidates;
    return pool.slice().sort((left, right) => (right.lastActivity ?? 0) - (left.lastActivity ?? 0))[0] ?? null;
  }
  function resolveReplySessionCandidate(sessions: SessionInfo[], originalSender: SessionInfo): SessionInfo | null {
    const byIntercomId = sessions.find((session) => session.id === originalSender.id);
    if (byIntercomId) return byIntercomId;
    if (originalSender.piSessionId) {
      const byPiSession = sessions.filter((session) => session.piSessionId === originalSender.piSessionId);
      const selected = pickMostRecentReadySession(byPiSession);
      if (selected) return selected;
    }
    if (originalSender.name) {
      const byAlias = sessions.filter((session) => session.name?.toLowerCase() === originalSender.name?.toLowerCase());
      const selected = pickMostRecentReadySession(byAlias);
      if (selected) return selected;
    }
    return null;
  }
  async function resolveTargetForReplyRelay(
    activeClient: IntercomClient,
    originalSender: SessionInfo,
    waitForReadyMs: number,
  ): Promise<{ target: string | SendTargetEnvelope; session: SessionInfo | null }> {
    const deadline = Date.now() + Math.max(0, waitForReadyMs);
    const fallbackTarget: SendTargetEnvelope = {
      intercomSessionId: originalSender.id,
      ...(originalSender.piSessionId ? { piSessionId: originalSender.piSessionId } : {}),
      ...(originalSender.name ? { alias: originalSender.name } : {}),
    };
    while (true) {
      const sessions = await activeClient.listSessions();
      const candidate = resolveReplySessionCandidate(sessions, originalSender);
      if (!candidate) {
        if (Date.now() >= deadline) return { target: fallbackTarget, session: null };
      } else if (isSessionReadyForRelay(candidate)) {
        return { target: buildSessionTargetEnvelope(candidate), session: candidate };
      } else if (Date.now() >= deadline) {
        return { target: buildSessionTargetEnvelope(candidate), session: candidate };
      }
      await new Promise<void>((resolve) => {
        runtimeScheduler.setTimeout(resolve, READY_WAIT_POLL_MS);
      });
    }
  }
  function normalizeCwdForCompare(cwd: string): string {
    const trimmed = cwd.trim().replaceAll("\\", "/");
    return trimmed.endsWith("/") && trimmed.length > 1 ? trimmed.slice(0, -1) : trimmed;
  }
  async function getSupervisorTarget(): Promise<SupervisorIntercomTarget> {
    const liveContext = getLiveContext();
    if (!liveContext || !currentSessionId) {
      throw new Error("Intercom runtime is not initialized for this session");
    }

    const activeClient = await ensureConnected("tool");
    const intercomSessionId = activeClient.sessionId?.trim();
    if (!intercomSessionId) {
      throw new Error("Intercom client has no registered session id");
    }

    const sessions = await activeClient.listSessions();
    const ownSession = sessions.find((session) => session.id === intercomSessionId);
    if (!ownSession) {
      throw new Error(`Registered intercom session ${intercomSessionId} not found in broker session list`);
    }

    const protocolVersion = ownSession.protocolVersion ?? 1;
    if (protocolVersion < INTERCOM_PROTOCOL_V2) {
      throw new Error(`Intercom protocol version ${protocolVersion} does not support supervisor routing. Need protocolVersion>=${INTERCOM_PROTOCOL_V2}`);
    }

    const capabilities = ownSession.capabilities ?? [];
    if (!capabilities.includes(PI_SESSION_ROUTING_CAPABILITY)) {
      throw new Error(`Intercom session missing required capability: ${PI_SESSION_ROUTING_CAPABILITY}`);
    }

    const piSessionId = ownSession.piSessionId?.trim();
    if (!piSessionId) {
      throw new Error("Intercom session missing piSessionId");
    }

    const requestedPiSessionId = liveContext.sessionManager.getSessionId();
    if (requestedPiSessionId !== currentSessionId) {
      throw new Error(`Unsafe supervisor routing: runtime session drift detected (current=${currentSessionId}, requested=${requestedPiSessionId})`);
    }
    if (piSessionId !== requestedPiSessionId) {
      throw new Error(`Unsafe supervisor routing: broker self piSessionId mismatch (broker=${piSessionId}, runtime=${requestedPiSessionId})`);
    }

    const alias = ownSession.name?.trim() || buildPresenceIdentity(pi, currentSessionId).name;
    const cwd = ownSession.cwd?.trim() || liveContext.cwd || process.cwd();

    return {
      intercomSessionId,
      piSessionId,
      alias,
      cwd,
    };
  }
  options.onSupervisorTargetResolver?.(() => getSupervisorTarget());
  function deliverLocalSubagentRelayMessage(sender: "subagent-control" | "subagent-result", status: string, messageText: string): void {
    const now = Date.now();
    sendIncomingMessage({
      from: {
        id: sender,
        piSessionId: currentSessionId ?? sender,
        protocolVersion: INTERCOM_PROTOCOL_V2,
        capabilities: [PI_SESSION_ROUTING_CAPABILITY],
        name: sender,
        cwd: runtimeContext?.cwd ?? process.cwd(),
        model: sender,
        pid: process.pid,
        startedAt: now,
        lastActivity: now,
        status,
      },
      message: {
        id: randomUUID(),
        timestamp: now,
        content: { text: messageText },
      },
      bodyText: messageText,
    }, "trigger");
  }
  function recordSubagentDeliveryError(entryType: string, to: string | SendTargetEnvelope, message: string, error: unknown): void {
    pi.appendEntry(entryType, {
      to: formatRelayTarget(to),
      target: typeof to === "string" ? { alias: to } : to,
      message,
      error: getErrorMessage(error),
      timestamp: Date.now(),
    });
  }
  function emitResultDelivery(requestId: string | undefined, delivered: boolean, error?: unknown): void {
    if (!requestId) return;
    pi.events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
      requestId,
      delivered,
      ...(error ? { error: getErrorMessage(error) } : {}),
    });
  }
  function relaySubagentIntercomPayload(payload: unknown, options: {
    sender: "subagent-control" | "subagent-result";
    status: string;
    errorEntryType: string;
    acknowledge?: boolean;
  }): void {
    const parsed = parseSubagentIntercomPayload(payload);
    if (!parsed) return;

    const relayGeneration = runtimeGeneration;
    void (async () => {
      const relayStillLive = () => !runtimeStarted || Boolean(getLiveContext(runtimeContext, relayGeneration));
      if (!relayStillLive()) {
        return;
      }
      if (currentSessionTargetMatches(parsed.to)) {
        deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
        return;
      }

      let activeClient: IntercomClient;
      try {
        activeClient = await ensureConnected("background");
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
        return;
      }

      if (!relayStillLive()) {
        return;
      }
      try {
        let sendTarget: string | SendTargetEnvelope = parsed.to;
        const locator = toSubagentLocator(parsed);
        const strictMachineRelay = parsed.source === "async-resume";
        const targetNeedsLookup = typeof parsed.to === "string"
          || (!parsed.to.intercomSessionId && !parsed.to.piSessionId);

        if (strictMachineRelay && !locator) {
          throw new Error("Async resume relay missing strict subagent locator metadata.");
        }

        if (locator && (targetNeedsLookup || strictMachineRelay)) {
          const waitForReadyMs = parsed.waitForReadyMs ?? DEFAULT_SUBAGENT_READY_WAIT_MS;
          const liveSession = await waitForLiveSubagentSession(activeClient, locator, waitForReadyMs);
          if (!liveSession?.id || !isSessionReadyForRelay(liveSession)) {
            throw new Error(`Live subagent target not ready after ${waitForReadyMs}ms (run=${locator.runId}, agent=${locator.agent}, index=${locator.index}).`);
          }
          sendTarget = {
            intercomSessionId: liveSession.id,
            ...(liveSession.piSessionId ? { piSessionId: liveSession.piSessionId } : {}),
          };
        }

        const result = await activeClient.send(sendTarget, { text: parsed.message });
        if (!relayStillLive()) return;
        if (!result.delivered) {
          const error = new Error(result.reason ?? "Session may not exist or has disconnected.");
          recordSubagentDeliveryError(options.errorEntryType, sendTarget, parsed.message, error);
          if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
          return;
        }
        if (options.acknowledge) emitResultDelivery(parsed.requestId, true);
      } catch (error) {
        if (!relayStillLive()) return;
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        if (options.acknowledge) emitResultDelivery(parsed.requestId, false, error);
      }
    })();
  }
  pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-control",
      status: "needs_attention",
      errorEntryType: "intercom_control_error",
    });
  });
  pi.events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-result",
      status: "result",
      errorEntryType: "intercom_result_error",
      acknowledge: true,
    });
  });
  pi.on("session_start", (_event, ctx) => {
    if (!config.enabled) {
      return;
    }
    shuttingDown = false;
    disposed = false;
    runtimeStarted = true;
    runtimeGeneration += 1;
    reconnectAttempt = 0;
    clearReconnectTimer();
    clearStartupConnectTimer();
    runtimeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    currentModel = ctx.model?.id ?? "unknown";
    sessionStartedAt = Date.now();
    agentRunning = false;
    activeTools.clear();
    const startupGeneration = runtimeGeneration;
    startupConnectTimer = runtimeScheduler.setTimeout(() => {
      startupConnectTimer = null;
      if (!getLiveContext(ctx, startupGeneration)) {
        return;
      }
      void ensureConnected("startup").catch(() => {
        if (!getLiveContext(ctx, startupGeneration)) {
          return;
        }
        client = null;
        scheduleReconnect();
      });
    }, 0);
  });
  
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    disposed = true;
    runtimeGeneration += 1;
    clearStartupConnectTimer();
    clearReconnectTimer();
    rejectReplyWaiter(new Error("Session shutting down"));
    replyTracker.reset();
    pendingIdleMessages.length = 0;
    droppedMisrouteDiagnostics.length = 0;
    clearInboundFlushTimer();
    agentRunning = false;
    activeTools.clear();
    if (client) {
      syncReadiness("stopping", "session_shutdown");
      await client.disconnect();
      client = null;
    }
    runtimeContext = null;
    currentSessionId = null;
    sessionStartedAt = null;
  });
  pi.on("turn_end", () => {
    if (!getLiveContext()) {
      return;
    }
    replyTracker.endTurn();
    scheduleInboundFlush(0);
  });
  pi.on("agent_start", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = true;
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("tool_execution_start", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.set(event.toolCallId, event.toolName);
    syncPresenceStatus();
  });
  pi.on("tool_execution_end", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.delete(event.toolCallId);
    syncPresenceStatus();
  });
  pi.on("agent_end", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = false;
    activeTools.clear();
    syncPresenceStatus();
    scheduleInboundFlush(0);
  });
  pi.on("turn_start", (_event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentSessionId = ctx.sessionManager.getSessionId();
    syncPresenceIdentity(ctx.sessionManager.getSessionId());
    replyTracker.beginTurn();
  });
  pi.on("model_select", (event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentModel = event.model.id;
    if (client) {
      client.updatePresence({
        ...buildPresenceIdentity(pi, ctx.sessionManager.getSessionId()),
        model: event.model.id,
        status: currentStatus(),
      });
    }
  });

  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText);
  });

  if (childOrchestratorMetadata) {
    pi.registerTool({
      name: "contact_supervisor",
      label: "Contact Supervisor",
      description: "Subagent-only tool for contacting the supervisor agent that delegated this task. Use need_decision when blocked, uncertain, needing approval, or facing a product/API/scope decision before continuing; this waits for the supervisor's reply. Use interview_request when multiple structured questions need supervisor answers; this also waits for a reply. Use progress_update only for meaningful progress or unexpected discoveries that change the plan; this does not wait for a reply. Do not use for routine completion handoffs.",
      promptSnippet: "Subagent-only: contact the supervisor for decisions, structured interviews, or meaningful plan-changing updates. Do not use for routine completion handoffs.",
      promptGuidelines: [
        "Use contact_supervisor with reason='need_decision' when a subagent is blocked, uncertain, needs approval, or faces a product/API/scope decision before continuing.",
        "Use contact_supervisor with reason='interview_request' when the child needs multiple structured answers from the supervisor in one blocking exchange.",
        "Use contact_supervisor with reason='progress_update' only for meaningful progress or unexpected discoveries that change the plan.",
        "Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
      ],
      parameters: Type.Object({
        reason: Type.String({
          enum: ["need_decision", "progress_update", "interview_request"],
          description: "Contact reason: 'need_decision' waits for a reply; 'interview_request' sends structured questions and waits for a reply; 'progress_update' sends a non-blocking update",
        }),
        message: Type.Optional(Type.String({
          description: "Decision request, optional interview note, or meaningful progress update for the supervisor",
        })),
        interview: Type.Optional(Type.Object({
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          questions: Type.Array(Type.Object({
            id: Type.String(),
            type: Type.String({ description: "Question type: single, multi, text, image, or info" }),
            question: Type.String(),
            options: Type.Optional(Type.Array(Type.Any())),
            context: Type.Optional(Type.String()),
          })),
        }, { description: "Structured interview request for reason='interview_request'" })),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const reason = params.reason as ContactSupervisorReason;
        if (reason !== "need_decision" && reason !== "progress_update" && reason !== "interview_request") {
          return {
            content: [{ type: "text", text: "Invalid reason. Use 'need_decision', 'interview_request', or 'progress_update'." }],
            isError: true,
            details: { error: true },
          };
        }
        if ((reason === "need_decision" || reason === "progress_update") && typeof params.message !== "string") {
          return {
            content: [{ type: "text", text: `Missing 'message' parameter for reason '${reason}'.` }],
            isError: true,
            details: { error: true },
          };
        }
        const interviewValidation = reason === "interview_request"
          ? validateSupervisorInterviewRequest(params.interview)
          : undefined;
        if (interviewValidation?.ok === false) {
          return {
            content: [{ type: "text", text: `Invalid interview request: ${interviewValidation.error}` }],
            isError: true,
            details: { error: true },
          };
        }
        const supervisorInterview = interviewValidation?.ok === true ? interviewValidation.interview : undefined;

        let connectedClient: IntercomClient;
        try {
          connectedClient = await ensureConnected("tool");
        } catch (error) {
          return {
            content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
            isError: true,
            details: { error: true },
          };
        }

        syncPresenceIdentity(ctx.sessionManager.getSessionId());

        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
            isError: true,
            details: { error: true },
          };
        }

        const metadata = childOrchestratorMetadata;
        const supervisorTarget = metadata.supervisorTarget;
        const sendTo = hasStructuredSupervisorTarget(supervisorTarget)
          ? {
            intercomSessionId: supervisorTarget.intercomSessionId,
            piSessionId: supervisorTarget.piSessionId,
            alias: supervisorTarget.alias,
          }
          : { alias: supervisorTarget.alias };
        const supervisorTargetLabel = formatSupervisorTargetLabel(supervisorTarget);
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
            isError: true,
            details: { error: true },
          };
        }
        if (currentSessionTargetMatches(sendTo, connectedClient)) {
          return {
            content: [{ type: "text", text: "Cannot message the current session" }],
            isError: true,
            details: { error: true },
          };
        }

        if (reason === "progress_update") {
          const message = params.message as string;
          try {
            const result = await connectedClient.send(sendTo, {
              text: formatChildOrchestratorMessage("update", metadata, message),
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: formatSupervisorTargetUnavailableReason(supervisorTarget, errorText) }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            pi.appendEntry("intercom_sent", {
              to: supervisorTarget.alias,
              target: sendTo,
              message: { text: message, reason },
              messageId: result.id,
              timestamp: Date.now(),
              subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
            });
            return {
              content: [{ type: "text", text: `Progress update sent to supervisor ${supervisorTargetLabel}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send progress update: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        if (replyWaiter) {
          return {
            content: [{ type: "text", text: "Already waiting for a reply" }],
            isError: true,
            details: { error: true },
          };
        }

        let replyPromise: Promise<Message> | null = null;
        try {
          const questionId = randomUUID();
          const replySenderMatcher = hasStructuredSupervisorTarget(supervisorTarget)
            ? {
              intercomSessionId: supervisorTarget.intercomSessionId,
              piSessionId: supervisorTarget.piSessionId,
              alias: supervisorTarget.alias,
            }
            : {
              alias: supervisorTarget.alias,
            };
          replyPromise = waitForReply(replySenderMatcher, questionId, signal);
          replyPromise.catch(() => undefined);
          if (signal?.aborted) {
            rejectReplyWaiter(new Error("Cancelled"));
            try {
              await replyPromise;
            } catch {
              // The waiter was intentionally rejected above; the tool result reports cancellation.
            }
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
              details: { error: true },
            };
          }
          const requestText = reason === "interview_request"
            ? formatChildOrchestratorMessage("interview", metadata, formatSupervisorInterviewRequest(supervisorInterview!, typeof params.message === "string" ? params.message : undefined))
            : formatChildOrchestratorMessage("ask", metadata, params.message as string);
          const sendResult = await connectedClient.send(sendTo, {
            messageId: questionId,
            text: requestText,
            expectsReply: true,
          });
          if (!sendResult.delivered) {
            const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
            rejectReplyWaiter(new Error(formatSupervisorTargetUnavailableReason(supervisorTarget, errorText)));
            if (replyPromise) {
              try {
                await replyPromise;
              } catch {
                // The waiter was already rejected above. Keep the delivery failure as the only error here.
              }
            }
            return {
              content: [{ type: "text", text: formatSupervisorTargetUnavailableReason(supervisorTarget, errorText) }],
              isError: true,
              details: { error: true },
            };
          }
          pi.appendEntry("intercom_sent", {
            to: supervisorTarget.alias,
            target: sendTo,
            message: {
              text: reason === "interview_request" ? requestText : params.message,
              reason,
              ...(reason === "interview_request" ? { interview: supervisorInterview } : {}),
            },
            messageId: sendResult.id,
            timestamp: Date.now(),
            subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
          });
          const replyMessage = await replyPromise;
          const replyText = replyMessage.content.text;
          const replyAttachments = replyMessage.content.attachments?.length
            ? formatAttachments(replyMessage.content.attachments)
            : "";
          const structuredReply = reason === "interview_request" ? parseStructuredSupervisorReply(replyText, supervisorInterview!) : undefined;
          pi.appendEntry("intercom_received", {
            from: supervisorTarget.alias,
            target: sendTo,
            message: { text: replyText, attachments: replyMessage.content.attachments },
            messageId: replyMessage.id,
            timestamp: replyMessage.timestamp,
            subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
          });
          return {
            content: [{ type: "text", text: `**Reply from supervisor:**\n${replyText}${replyAttachments}` }],
            isError: false,
            ...(structuredReply
              ? { details: structuredReply.value !== undefined ? { structuredReply: structuredReply.value } : { structuredReplyParseError: structuredReply.error } }
              : {}),
          };
        } catch (error) {
          rejectReplyWaiter(toError(error));
          if (replyPromise) {
            try {
              await replyPromise;
            } catch {
              // The waiter is cleanup-only on this path. The real failure is the one from the outer catch.
            }
          }
          return {
            content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
            isError: true,
            details: { error: true },
          };
        }
      },
      renderCall(args, theme) {
        const reason = typeof args.reason === "string" ? args.reason : "contact";
        const messagePreview = previewText(args.message, 96);
        const interview = args.interview && typeof args.interview === "object" ? args.interview as { title?: unknown } : undefined;
        let text = theme.fg("toolTitle", theme.bold("contact_supervisor "));
        text += theme.fg(reason === "need_decision" ? "warning" : reason === "progress_update" ? "muted" : "accent", reason);
        if (typeof interview?.title === "string" && interview.title.trim()) {
          text += " " + theme.fg("accent", interview.title.trim());
        }
        if (messagePreview) {
          text += "\n  " + theme.fg("dim", messagePreview);
        }
        return new Text(text, 0, 0);
      },
      renderResult(result, { isPartial }, theme, context) {
        if (isPartial) {
          return new Text(theme.fg("warning", "Waiting for supervisor..."), 0, 0);
        }
        const details = result.details as { delivered?: boolean; error?: boolean; messageId?: string; reason?: string; structuredReplyParseError?: string } | undefined;
        const textContent = firstTextContent(result);
        const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
        const parseWarning = typeof details?.structuredReplyParseError === "string";
        let text = failed
          ? theme.fg("error", "✗ ")
          : parseWarning
            ? theme.fg("warning", "⚠ ")
            : theme.fg("success", "✓ ");
        text += theme.fg(failed ? "error" : "text", textContent);
        if (parseWarning) {
          text += "\n" + theme.fg("warning", `Structured reply parse issue: ${details.structuredReplyParseError}`);
        }
        return new Text(text, 0, 0);
      },
    });
  }

  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another pi session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message
  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask and wait for reply
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "send"|"ask"|"reply", waitForReadyMs: 5000, ... }) → Wait for target registration/readiness before failing
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`,
    promptSnippet:
      "Use to coordinate with other local pi sessions: list peers, send updates, ask for help, or check intercom connectivity.",

    parameters: Type.Object({
      action: Type.String({
        enum: ["list", "send", "ask", "reply", "pending", "status"],
        description: "Action: 'list', 'send', 'ask', 'reply', 'pending', or 'status'",
      }),
      to: Type.Optional(Type.String({
        description: "Target session name or ID (for 'send', 'ask', or disambiguating 'reply')",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send', 'ask', or 'reply' action)",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      replyTo: Type.Optional(Type.String({
        description: "Message ID to reply to (for threading or responding to an 'ask')",
      })),
      waitForReadyMs: Type.Optional(Type.Number({
        description: "Optional target readiness wait budget in milliseconds for send/ask/reply retries (must be >= 0)",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          isError: true,
          details: { error: true },
        };
      }

      syncPresenceIdentity(ctx.sessionManager.getSessionId());

      const { action, to, message, attachments, replyTo, waitForReadyMs } = params;
      if (waitForReadyMs !== undefined && (!Number.isFinite(waitForReadyMs) || waitForReadyMs < 0)) {
        return {
          content: [{ type: "text", text: "waitForReadyMs must be a non-negative number." }],
          isError: true,
          details: { error: true },
        };
      }

      switch (action) {
        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);
            const otherSessions = sessions.filter(s => s.id !== mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                isError: true,
                details: { error: true },
              };
            }

            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true)}`;
            const otherSection = otherSessions.length === 0
              ? "**Other sessions:**\nNo other sessions connected."
              : `**Other sessions:**\n${otherSessions.map(s => formatSessionListRow(s, currentSession.cwd, false)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              isError: false,
              details: {
                currentSession: sessionDetails(currentSession),
                otherSessions: otherSessions.map(sessionDetails),
              },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "send": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }
          try {
            const readinessWaitMs = waitForReadyMs ?? DEFAULT_MANUAL_SEND_READY_WAIT_MS;
            let resolved = await resolveTargetForManualRelay(connectedClient, to, readinessWaitMs);
            if (currentSessionTargetMatches(resolved.target, connectedClient)) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            if (!replyTo && config.confirmSend && ctx.hasUI) {
              const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
              const confirmed = await ctx.ui.confirm(
                "Send Message",
                `Send to "${to}":\n\n${message}${attachmentText}`,
              );
              if (!confirmed) {
                return {
                  content: [{ type: "text", text: "Message cancelled by user" }],
                  isError: false,
                };
              }
            }
            let result = await connectedClient.send(resolved.target, {
              text: message,
              attachments,
              replyTo,
            });
            if (!result.delivered && isRetryableDeliveryReason(result.reason)) {
              const refreshed = await resolveTargetForManualRelay(connectedClient, to, readinessWaitMs);
              if (!targetsEquivalent(refreshed.target, resolved.target) || refreshed.session) {
                resolved = refreshed;
                if (currentSessionTargetMatches(resolved.target, connectedClient)) {
                  return {
                    content: [{ type: "text", text: "Cannot message the current session" }],
                    isError: true,
                    details: { error: true },
                  };
                }
                result = await connectedClient.send(resolved.target, {
                  text: message,
                  attachments,
                  replyTo,
                });
              }
            }
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            pi.appendEntry("intercom_sent", {
              to: resolved.session?.name || to,
              target: typeof resolved.target === "string" ? { alias: resolved.target } : resolved.target,
              message: { text: message, attachments, replyTo },
              messageId: result.id,
              timestamp: Date.now(),
            });
            if (replyTo) {
              replyTracker.markReplied(replyTo);
            }
            return {
              content: [{ type: "text", text: `Message sent to ${resolved.session?.name || to}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "ask": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          if (replyWaiter) {
            return {
              content: [{ type: "text", text: "Already waiting for a reply" }],
              isError: true,
              details: { error: true },
            };
          }

          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
              details: { error: true },
            };
          }
          let replyPromise: Promise<Message> | null = null;

          try {
            const readinessWaitMs = waitForReadyMs ?? DEFAULT_MANUAL_ASK_READY_WAIT_MS;
            let resolved = await resolveTargetForManualRelay(connectedClient, to, readinessWaitMs);
            if (_signal?.aborted) {
              return {
                content: [{ type: "text", text: "Cancelled" }],
                isError: true,
                details: { error: true },
              };
            }
            if (currentSessionTargetMatches(resolved.target, connectedClient)) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            const questionId = randomUUID();
            replyPromise = waitForReply(replyMatcherForResolvedTarget(to, resolved.session), questionId, _signal);
            let sendResult = await connectedClient.send(resolved.target, {
              messageId: questionId,
              text: message,
              attachments,
              replyTo,
              expectsReply: true,
            });

            if (!sendResult.delivered && isRetryableDeliveryReason(sendResult.reason)) {
              const refreshed = await resolveTargetForManualRelay(connectedClient, to, readinessWaitMs);
              if (!targetsEquivalent(refreshed.target, resolved.target) || refreshed.session) {
                rejectReplyWaiter(new Error("Refreshing intercom target after delivery failure."));
                if (replyPromise) {
                  try {
                    await replyPromise;
                  } catch {
                    // Waiter cleanup only.
                  }
                }
                resolved = refreshed;
                if (currentSessionTargetMatches(resolved.target, connectedClient)) {
                  return {
                    content: [{ type: "text", text: "Cannot message the current session" }],
                    isError: true,
                    details: { error: true },
                  };
                }
                replyPromise = waitForReply(replyMatcherForResolvedTarget(to, resolved.session), questionId, _signal);
                sendResult = await connectedClient.send(resolved.target, {
                  messageId: questionId,
                  text: message,
                  attachments,
                  replyTo,
                  expectsReply: true,
                });
              }
            }

            if (!sendResult.delivered) {
              const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
              rejectReplyWaiter(new Error(`Message to "${to}" was not delivered: ${errorText}`));
              if (replyPromise) {
                try {
                  await replyPromise;
                } catch {
                  // The waiter was already rejected above. Keep the delivery failure as the only error here.
                }
              }
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: { error: true },
              };
            }
            pi.appendEntry("intercom_sent", {
              to: resolved.session?.name || to,
              target: typeof resolved.target === "string" ? { alias: resolved.target } : resolved.target,
              message: { text: message, attachments, replyTo },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            const replyMessage = await replyPromise;
            const replyText = replyMessage.content.text;
            const replyAttachments = replyMessage.content.attachments?.length
              ? formatAttachments(replyMessage.content.attachments)
              : "";
            pi.appendEntry("intercom_received", {
              from: to,
              message: { text: replyText, attachments: replyMessage.content.attachments },
              messageId: replyMessage.id,
              timestamp: replyMessage.timestamp,
            });
            return {
              content: [{ type: "text", text: `**Reply from ${to}:**\n${replyText}${replyAttachments}` }],
              isError: false,
            };
          } catch (error) {
            rejectReplyWaiter(toError(error));
            if (replyPromise) {
              try {
                await replyPromise;
              } catch {
                // The waiter is cleanup-only on this path. The real failure is the one from the outer catch.
              }
            }
            return {
              content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "reply": {
          if (!message) {
            return {
              content: [{ type: "text", text: "Missing 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          try {
            const target = replyTracker.resolveReplyTarget({ to });
            const readinessWaitMs = waitForReadyMs ?? DEFAULT_MANUAL_REPLY_READY_WAIT_MS;
            let resolved = await resolveTargetForReplyRelay(connectedClient, target.from, readinessWaitMs);
            if (currentSessionTargetMatches(resolved.target, connectedClient)) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            let result = await connectedClient.send(resolved.target, {
              text: message,
              replyTo: target.message.id,
            });
            if (!result.delivered && isRetryableDeliveryReason(result.reason)) {
              const refreshed = await resolveTargetForReplyRelay(connectedClient, target.from, readinessWaitMs);
              if (!targetsEquivalent(refreshed.target, resolved.target) || refreshed.session) {
                resolved = refreshed;
                if (currentSessionTargetMatches(resolved.target, connectedClient)) {
                  return {
                    content: [{ type: "text", text: "Cannot message the current session" }],
                    isError: true,
                    details: { error: true },
                  };
                }
                result = await connectedClient.send(resolved.target, {
                  text: message,
                  replyTo: target.message.id,
                });
              }
            }
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Reply to "${resolved.session?.name || target.from.name || target.from.id}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            replyTracker.markReplied(target.message.id);
            pi.appendEntry("intercom_sent", {
              to: resolved.session?.name || target.from.name || target.from.id,
              target: typeof resolved.target === "string" ? { alias: resolved.target } : resolved.target,
              message: { text: message, replyTo: target.message.id },
              messageId: result.id,
              timestamp: Date.now(),
            });
            return {
              content: [{ type: "text", text: `Reply sent to ${resolved.session?.name || target.from.name || target.from.id}` }],
              isError: false,
              details: { messageId: result.id, delivered: true, replyTo: target.message.id },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to reply: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "pending": {
          const pendingAsks = replyTracker.listPending();
          if (pendingAsks.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound asks." }],
              isError: false,
            };
          }

          const now = Date.now();
          const lines = pendingAsks.map(({ from, message, receivedAt }) => {
            const preview = message.content.text.replace(/\s+/g, " ").slice(0, 80);
            const elapsedSeconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
            return `- ${from.name || from.id} · ${message.id} · ${elapsedSeconds}s ago · ${preview}`;
          });
          return {
            content: [{ type: "text", text: `**Pending asks:**\n${lines.join("\n")}` }],
            isError: false,
          };
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find((session) => session.id === mySessionId);
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nActive sessions: ${sessions.length}\nDropped misroutes: ${droppedMisrouteDiagnostics.length}`,
              }],
              isError: false,
              details: {
                session: currentSession ? sessionDetails(currentSession) : null,
                activeSessions: sessions.length,
                droppedMisroutes: droppedMisrouteDiagnostics.length,
              },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            isError: true,
            details: { error: true },
          };
      }
    },
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "intercom";
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messagePreview = previewText(args.message, 96);
      const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
      let text = theme.fg("toolTitle", theme.bold("intercom "));
      text += theme.fg(action === "ask" ? "warning" : action === "reply" ? "success" : "accent", action);
      if (target) {
        text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      }
      if (attachmentCount > 0) {
        text += " " + theme.fg("dim", `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`);
      }
      if (messagePreview) {
        text += "\n  " + theme.fg("dim", messagePreview);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Intercom working..."), 0, 0);
      }
      const details = result.details as { delivered?: boolean; error?: boolean; messageId?: string; reason?: string } | undefined;
      const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
      let text = failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      text += theme.fg(failed ? "error" : "text", firstTextContent(result));
      if (details?.messageId && !context.expanded) {
        text += theme.fg("dim", ` (${details.messageId.slice(0, 8)})`);
      }
      if (details?.reason && context.expanded) {
        text += "\n" + theme.fg("dim", `Reason: ${details.reason}`);
      }
      return new Text(text, 0, 0);
    },
  });

  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {
    const overlayGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, overlayGeneration);
    if (!liveContext?.hasUI) return;

    let overlayClient: IntercomClient;
    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let currentSession: SessionInfo;
    let sessions: SessionInfo[];
    let duplicates: Set<string>;
    try {
      const mySessionId = overlayClient.sessionId;
      const allSessions = await overlayClient.listSessions();
      if (!getLiveContext(ctx, overlayGeneration)) return;
      const foundCurrentSession = allSessions.find(s => s.id === mySessionId);
      if (!foundCurrentSession) {
        notifyIfLive(ctx, "Current session is missing from intercom session list", "error", overlayGeneration);
        return;
      }
      currentSession = foundCurrentSession;
      duplicates = duplicateSessionNames(allSessions);
      sessions = allSessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }

    const selectedSession = await ctx.ui.custom<SessionInfo | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(theme, keybindings, currentSession, sessions, done),
      { overlay: true }
    ).catch(() => undefined);

    if (!selectedSession || !getLiveContext(ctx, overlayGeneration)) return;

    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    const targetLabel = formatSessionLabel(selectedSession, duplicates);

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, overlayClient, done),
      { overlay: true }
    ).catch(() => undefined);

    if (result?.sent && result.messageId && result.text && getLiveContext(ctx, overlayGeneration)) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      notifyIfLive(ctx, `Message sent to ${targetLabel}`, "info", overlayGeneration);
    }
  }

  void openIntercomOverlay;
}
