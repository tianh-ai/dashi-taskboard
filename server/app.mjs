import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_PROJECT_ID,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
} from "../shared/domain.mjs";
import { normalizeWorkflowSnapshot } from "../shared/workflow-control-flow.mjs";
import { AiChatService } from "./ai-chat.mjs";
import { createCloudConfigStore } from "./cloud-config.mjs";
import {
  CloudProxyError,
  createCloudProxy,
  isLocalCompanionRoute,
} from "./cloud-proxy.mjs";
import { ApiError, TaskboardDatabase } from "./database.mjs";
import {
  createDeviceProjectSync,
  resolveDeviceProjectSyncConfig,
} from "./device-project-sync.mjs";
import { createWeComAuth, resolveWeComConfig } from "./wecom-auth.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const JSON_BODY_LIMIT = 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_TURN_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_ATTACHMENT_LIMIT = 10;
const AI_CHAT_SKILL_MARKER = "\uFFFC";
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TRUSTED_EMBED_ORIGINS = new Set(["app://-"]);
const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

async function dataHealthReport(database, attachmentsDirectory) {
  const snapshot = database.getDataHealthSnapshot();
  let missingFiles = 0;
  let sizeMismatches = 0;
  for (const attachment of snapshot.attachments) {
    try {
      const file = await stat(path.join(attachmentsDirectory, attachment.id));
      if (file.size !== attachment.size) sizeMismatches += 1;
    } catch (error) {
      if (error.code === "ENOENT") missingFiles += 1;
      else throw error;
    }
  }
  const integrityOk = snapshot.integrityResults.length === 1
    && snapshot.integrityResults[0] === "ok";
  const foreignKeysOk = snapshot.foreignKeyViolations.length === 0;
  const attachmentsOk = missingFiles === 0 && sizeMismatches === 0;
  const validityLevel = integrityOk && foreignKeysOk && attachmentsOk ? 3 : 1;
  const ratings = {
    validity: {
      code: `V${validityLevel}`,
      level: validityLevel,
      evidence: "SQLite integrity, foreign keys, and attachment bytes were checked live",
    },
    reliability: {
      code: "R1",
      level: 1,
      limitation: "backups are external to this process; current receipt freshness and restore evidence are unverified",
    },
    synchronization: {
      code: "S2",
      level: 2,
      limitation: "durable outbox exists, but consumer acknowledgements are not stored centrally",
    },
    environmentFit: {
      code: "F2",
      level: 2,
      limitation: "Tencent, WorkBuddy, NAS backup, and multi-device paths lack one current combined acceptance receipt",
    },
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ratingStandard: {
      scale: "0-4",
      productionThreshold: 3,
      rule: "every axis must meet the threshold; levels are never averaged",
      axes: {
        V: "data validity",
        R: "reliability and recovery",
        S: "synchronization assurance",
        F: "environment fit",
      },
    },
    database: { engine: "sqlite", tableCount: snapshot.tableCount },
    checks: {
      integrity: {
        ok: integrityOk,
        result: snapshot.integrityResults.join(", "),
      },
      foreignKeys: {
        ok: foreignKeysOk,
        violations: snapshot.foreignKeyViolations.length,
      },
      attachments: {
        ok: attachmentsOk,
        metadataRows: snapshot.attachments.length,
        missingFiles,
        sizeMismatches,
      },
      outbox: { destinations: snapshot.outbox },
      activeWork: {
        leases: snapshot.activeLeases,
        aiRuns: snapshot.activeAiRuns,
      },
    },
    ratings,
    productionReady: Object.values(ratings).every((rating) => rating.level >= 3),
  };
}

function workBuddyToolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function toFetchRequest(request, normalizedPath = request.url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  if (request.taskboardActor?.type === "user") {
    headers.set("x-taskboard-client", "cloud-companion");
    headers.set("x-taskboard-acting-user-id", request.taskboardActor.id);
    headers.set("x-taskboard-acting-user-name", encodeURIComponent(request.taskboardActor.name));
    if (request.taskboardActor.avatarUrl) {
      headers.set("x-taskboard-acting-user-avatar", request.taskboardActor.avatarUrl);
    }
  }
  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return new Request(`http://127.0.0.1${normalizedPath}`, init);
}

async function sendFetchResponse(response, upstream) {
  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  for (const [name, value] of upstream.headers) {
    if (
      name === "connection"
      || name === "content-encoding"
      || name === "content-length"
      || name === "set-cookie"
      || name === "transfer-encoding"
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(upstream.body);
    body.once("error", reject);
    response.once("finish", resolve);
    body.pipe(response);
  });
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTrustedNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(host) === 6) {
    return host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host);
  }
  return false;
}

function assertTrustedNetworkRequest(request, trustedOrigin = null) {
  let host;
  try {
    host = new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }
  const trustedPublicHost = trustedOrigin ? new URL(trustedOrigin).hostname : null;
  if (!isTrustedNetworkHost(host) && host !== trustedPublicHost) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }

  const origin = request.headers.origin;
  if (!origin) return;
  if (TRUSTED_EMBED_ORIGINS.has(origin)) return;
  let originHost;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
  if (!isTrustedNetworkHost(originHost) && origin !== trustedOrigin) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
}

function requestHasProxyHeaders(request) {
  // 同机反向代理（nginx）会把公网流量的 remoteAddress 变成 127.0.0.1，
  // 但一定带上代理头；真正的本机直连请求不会带。与 actorFromLocalTaskctl
  // 的防伪造检查保持一致，防止公网流量冒充本机来源。
  return request.headers["x-forwarded-for"] !== undefined
    || request.headers["x-real-ip"] !== undefined
    || request.headers.forwarded !== undefined;
}

function assertLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (
    address !== "127.0.0.1"
    && address !== "::1"
    && address !== "::ffff:127.0.0.1"
  ) {
    throw new ApiError(403, "LOCAL_ONLY", "This endpoint is only available on this device");
  }
  if (requestHasProxyHeaders(request)) {
    throw new ApiError(403, "LOCAL_ONLY", "This endpoint is only available on this device");
  }
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function assertAllowedQuery(searchParams, allowed, routeLabel) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function assertNoQuery(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(), routeLabel);
}

function decodeRouteSegment(value, name) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${name} contains invalid encoding`);
  }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", `${name} is invalid`);
  }
  return decoded;
}

function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.toLowerCase().split("%", 1)[0];
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address === "::ffff:127.0.0.1"
    || address.startsWith("::ffff:127.");
}

function assertAiLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress) || requestHasProxyHeaders(request)) {
    throw new ApiError(403, "LOCAL_AI_LOOPBACK_REQUIRED", "Local AI routes are only available from this device");
  }
}

function stringField(value, name, { required = false, nullable = false, maxLength }) {
  if (value === undefined) {
    if (required) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' is required`);
    }
    return undefined;
  }
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a string${nullable ? " or null" : ""}`);
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function pathField(value, name) {
  const normalized = stringField(value, name, { nullable: true, maxLength: 4096 });
  if (normalized === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot contain null bytes`);
  }
  return normalized;
}

function parseDueDate(value, name = "dueDate") {
  const date = stringField(value, name, { nullable: true, maxLength: 10 });
  if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must use YYYY-MM-DD`);
  }
  return date;
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", { required: true, maxLength: 512 }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", { required: true, maxLength: 4096 });
    if (worktreePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'developmentContext.path' cannot contain null bytes");
    }
    return {
      type: "worktree",
      path: worktreePath,
      branch: stringField(value.branch ?? null, "developmentContext.branch", { nullable: true, maxLength: 512 }),
    };
  }
  throw new ApiError(400, "INVALID_FIELD", "'developmentContext.type' must be branch or worktree");
}

function parseRecurrence(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["interval", "unit"]));
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 365) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.interval' must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(value.unit)) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.unit' must be day, week, month, or year");
  }
  return { interval: value.interval, unit: value.unit };
}

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a positive integer");
  }
  return value;
}

function parseWorkflowVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a non-negative integer");
  }
  return value;
}

function parseWorkflowWorkspace(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "tabs", "activeWorkflowId", "snapshots"]));
  if (value.version !== 1) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.version' must be 1");
  }
  if (!Array.isArray(value.tabs) || value.tabs.length === 0 || value.tabs.length > 100) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' must contain 1 to 100 workflows");
  }
  const tabs = value.tabs.map((tab, index) => {
    assertPlainObject(tab);
    assertAllowedKeys(tab, new Set(["id", "name"]));
    return {
      id: stringField(tab.id, `workspace.tabs[${index}].id`, { required: true, maxLength: 128 }),
      name: stringField(tab.name, `workspace.tabs[${index}].name`, { required: true, maxLength: 120 }),
    };
  });
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' ids must be unique");
  }
  const activeWorkflowId = stringField(value.activeWorkflowId, "workspace.activeWorkflowId", {
    required: true,
    maxLength: 128,
  });
  if (!tabs.some((tab) => tab.id === activeWorkflowId)) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.activeWorkflowId' must reference a workflow tab");
  }
  assertPlainObject(value.snapshots);
  const snapshots = {};
  for (const tab of tabs) {
    const snapshot = value.snapshots[tab.id];
    assertPlainObject(snapshot);
    assertAllowedKeys(snapshot, new Set(["nodes", "edges", "flow", "selectedNodeId"]));
    if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length > 10_000) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.nodes' must be an array`);
    }
    if (snapshot.flow === undefined && (!Array.isArray(snapshot.edges) || snapshot.edges.length > 20_000)) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.edges' must be an array`);
    }
    if (snapshot.flow !== undefined && snapshot.edges !== undefined) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}' cannot contain both 'flow' and 'edges'`);
    }
    const selectedNodeId = stringField(
      snapshot.selectedNodeId ?? null,
      `workspace.snapshots.${tab.id}.selectedNodeId`,
      { nullable: true, maxLength: 256 },
    );
    try {
      snapshots[tab.id] = normalizeWorkflowSnapshot({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        flow: snapshot.flow,
        selectedNodeId,
      });
    } catch (error) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        `'workspace.snapshots.${tab.id}' is not a valid workflow: ${error.message}`,
      );
    }
  }
  return { version: 1, tabs, activeWorkflowId, snapshots };
}

function parseWorkflowWorkspaceSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "workspace"]));
  return {
    version: parseWorkflowVersion(body.version),
    workspace: parseWorkflowWorkspace(body.workspace),
  };
}

function parseSortOrder(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
    throw new ApiError(400, "INVALID_FIELD", "'sortOrder' must be a finite number between -1000000000000 and 1000000000000");
  }
  return value;
}

function parseLabels(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'labels' must be an array with at most 20 entries");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") {
      throw new ApiError(400, "INVALID_FIELD", "Every label must be a string");
    }
    const normalized = label.trim();
    if (normalized.length === 0 || normalized.length > 64) {
      throw new ApiError(400, "INVALID_FIELD", "Labels must contain 1 to 64 characters");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError(400, "INVALID_FIELD", "Labels must be unique");
  }
  return labels;
}

function parseStatus(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskStatus(result)) {
    throw new ApiError(400, "INVALID_FIELD", `'status' must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return result;
}

function parsePriority(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskPriority(result)) {
    throw new ApiError(400, "INVALID_FIELD", "'priority' must be none, urgent, high, medium, or low");
  }
  return result;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function workbuddyProjectMappingId(workbuddyProjectId) {
  let slug = slugify(workbuddyProjectId).slice(0, 60);
  if (!slug) {
    slug = [...workbuddyProjectId].reduce((hash, ch) => (hash * 31 + ch.codePointAt(0)) >>> 0, 7).toString(36);
  }
  return `wb-${slug}`.replace(/-+$/g, "") || "wb-project";
}

function validateProjectId(value, { required = true } = {}) {
  const id = stringField(value, "id", { required, maxLength: 64 });
  if (id !== undefined && !PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(400, "INVALID_FIELD", "'id' must be a lowercase slug containing letters, numbers, or hyphens");
  }
  return id;
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (!id) {
    throw new ApiError(400, "INVALID_FIELD", "Project name must contain at least one letter or number when 'id' is omitted");
  }
  const workspacePath = stringField(body.workspacePath ?? null, "workspacePath", { nullable: true, maxLength: 4096 });
  if (workspacePath === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot be empty");
  }
  if (workspacePath?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
  }
  return { id, name, workspacePath };
}

function parseThreadId(value) {
  if (value === undefined) return undefined;
  return stringField(value, "threadId", { required: true, maxLength: 256 });
}

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function actorFromRequest(request) {
  if (request.taskboardActor) return request.taskboardActor;
  if (request.headers["x-taskboard-client"] === "taskctl") {
    return CODEX_AGENT_ACTOR;
  }

  const rawId = requestHeader(request, "x-taskboard-user-id");
  const rawName = requestHeader(request, "x-taskboard-user-name");
  const rawAvatarUrl = requestHeader(request, "x-taskboard-user-avatar");
  if (rawId === undefined && rawName === undefined && rawAvatarUrl === undefined) {
    return { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
  }
  if (rawId === undefined || rawName === undefined) {
    throw new ApiError(400, "INVALID_ACTOR", "User identity requires both an ID and name");
  }

  const id = stringField(rawId, "X-Taskboard-User-Id", { required: true, maxLength: 96 });
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) {
    throw new ApiError(400, "INVALID_ACTOR", "User ID contains unsupported characters");
  }
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    throw new ApiError(400, "INVALID_ACTOR", "User name is not valid URL-encoded text");
  }
  const name = stringField(decodedName, "X-Taskboard-User-Name", { required: true, maxLength: 120 });

  let avatarUrl = null;
  if (rawAvatarUrl !== undefined) {
    const value = stringField(rawAvatarUrl, "X-Taskboard-User-Avatar", { required: true, maxLength: 2048 });
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL must use HTTP or HTTPS");
    }
    avatarUrl = parsed.toString();
  }
  return { type: "user", id, name, avatarUrl };
}

function assertAdmin(request) {
  const actor = actorFromRequest(request);
  if (actor.type !== "user" || request.taskboardRole !== "admin") {
    throw new ApiError(403, "ADMIN_REQUIRED", "此操作需要项目管理员权限");
  }
}

function projectMembershipForRequest(request, database, projectId) {
  const actor = actorFromRequest(request);
  if (actor.type !== "user") return null;
  return database.getProjectMembership(projectId, actor.id);
}

function assertProjectAdmin(request, database, projectId) {
  const actor = actorFromRequest(request);
  const isGlobalHumanAdmin = actor.type === "user" && request.taskboardRole === "admin";
  const membership = projectMembershipForRequest(request, database, projectId);
  if (!isGlobalHumanAdmin && membership?.role !== "admin") {
    throw new ApiError(403, "PROJECT_ADMIN_REQUIRED", "此操作需要真实用户的项目管理员权限");
  }
}

function assertAgentActor(request) {
  if (request.taskboardActor?.type !== "agent") {
    throw new ApiError(403, "AGENT_AUTH_REQUIRED", "Agent credentials (Basic + x-taskboard-client) are required");
  }
}

function isWorkBuddyBridge(request) {
  return request.taskboardActor?.type === "agent"
    && request.taskboardActor.id.endsWith(":workbuddy-bridge");
}

function assertWorkBuddyBridge(request) {
  if (!isWorkBuddyBridge(request)) {
    throw new ApiError(403, "WORKBUDDY_BRIDGE_REQUIRED", "WorkBuddy bridge credentials are required");
  }
}

function canAccessProject(request, database, projectId) {
  const actor = actorFromRequest(request);
  if (actor.type === "agent") {
    if (isWorkBuddyBridge(request)) return true;
    // 绑定式凭据的空 projects 表示不授权任何项目；不再将空集合解释为全局通行证。
    if (actor.agentBinding) return actor.agentBinding.projects.includes(projectId);
    // 旧共享密钥仅作兼容过渡，范围依旧注册表。
    const username = agentUsernameFromActor(actor);
    const projects = username ? database.getAgent(username)?.projects : null;
    return !projects || projects.length === 0 || projects.includes(projectId);
  }
  if (actor.type === "user" && request.taskboardRole === "admin") return true;
  return actor.type === "user" && Boolean(database.getProjectMembership(projectId, actor.id));
}

function assertProjectAccess(request, database, projectId) {
  if (!canAccessProject(request, database, projectId)) {
    throw new ApiError(403, "PROJECT_ACCESS_DENIED", "你不是此项目的成员");
  }
}

function assertAgentProjectScope(database, actor, projectId) {
  const username = agentUsernameFromActor(actor);
  if (!username || username === "workbuddy-agent") return;
  if (actor.agentBinding) {
    if (!actor.agentBinding.projects.includes(projectId)) {
      throw new ApiError(403, "PROJECT_ACCESS_DENIED", "此项目不在该 Agent 的服务端授权范围内");
    }
    return;
  }
  const agent = database.getAgent(username);
  if (agent?.projects?.length > 0 && !agent.projects.includes(projectId)) {
    throw new ApiError(403, "PROJECT_ACCESS_DENIED", "此任务不在该 Agent 的授权项目范围内");
  }
}

function parseProjectMember(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["userId", "userName", "userAvatarUrl", "role"]));
  const role = body.role;
  if (!["member", "manager", "admin"].includes(role)) {
    throw new ApiError(400, "INVALID_FIELD", "'role' must be member, manager, or admin");
  }
  return {
    userId: stringField(body.userId, "userId", { required: true, maxLength: 96 }),
    userName: stringField(body.userName, "userName", { required: true, maxLength: 120 }),
    userAvatarUrl: stringField(body.userAvatarUrl ?? null, "userAvatarUrl", { nullable: true, maxLength: 2048 }),
    role,
  };
}

function parseProjectMessage(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "kind", "mentions", "taskId", "replyToMessageId"]));
  const kind = body.kind ?? "message";
  if (!["message", "progress", "decision"].includes(kind)) {
    throw new ApiError(400, "INVALID_FIELD", "'kind' must be message, progress, or decision");
  }
  if (body.mentions !== undefined && !Array.isArray(body.mentions)) {
    throw new ApiError(400, "INVALID_FIELD", "'mentions' must be an array");
  }
  const mentions = [...new Set((body.mentions ?? []).map((value) => (
    stringField(value, "mentions[]", { required: true, maxLength: 96 })
  )))].slice(0, 20);
  return {
    body: stringField(body.body, "body", { required: true, maxLength: 100_000 }),
    kind,
    mentions,
    taskId: stringField(body.taskId ?? null, "taskId", { nullable: true, maxLength: 128 }),
    replyToMessageId: stringField(
      body.replyToMessageId ?? null,
      "replyToMessageId",
      { nullable: true, maxLength: 128 },
    ),
  };
}

const AGENT_DEFAULT_LEASE_SECONDS = 15 * 60;
const AGENT_MAX_LEASE_SECONDS = 24 * 60 * 60;

function agentUsernameFromActor(actor) {
  if (actor?.type !== "agent") return null;
  if (typeof actor.username === "string" && actor.username) return actor.username;
  // Legacy/basic fallback: "basic:<username>:<client>"
  const match = /^basic:([^:]+):/.exec(actor.id ?? "");
  if (match) return decodeURIComponent(match[1]);
  return null;
}

function agentActorFromRegistry(agent) {
  if (!agent) return null;
  return {
    type: "agent",
    id: `agent:${agent.id}`,
    name: agent.device ? `${agent.name}·${agent.device}` : agent.name,
    avatarUrl: null,
  };
}

function resolveAgentAuthor(database, actor) {
  if (actor?.type !== "agent") return actor;
  const username = agentUsernameFromActor(actor);
  if (!username || username === "workbuddy-agent") return actor;
  return agentActorFromRegistry(database.getAgent(username)) ?? actor;
}

function dispatchAgentMentions(database, events, projectId, message) {
  if (
    message.author.type !== "user"
    || !message.mentions
    || message.mentions.length === 0
  ) return null;
  // 密钥认证者（Basic 无 client 头会得到 type:"user"、id:"basic:<name>" 的演员）
  // 绝不算人类：否则任一 Agent 省略 client 头即可 @自己 触发自激励派发循环。
  // 真实人类只来自 WeCom 会话 / loopback local-user / companion 代发。
  if (typeof message.author.id === "string" && message.author.id.startsWith("basic:")) return null;
  const targets = [];
  let anyAgent = false;
  for (const mention of message.mentions) {
    if (["agent", "agents", "codex-agent"].includes(String(mention).toLowerCase())) {
      anyAgent = true;
      continue;
    }
    const mentionedAgents = database.findAgentsByMention(mention, projectId);
    for (const agent of mentionedAgents) {
      if (!targets.some((target) => target.id === agent.id)) {
        targets.push({ id: agent.id, name: agent.name, device: agent.device });
      }
    }
  }
  if (!anyAgent && targets.length === 0) return null;
  const request = message.taskId
    ? { task: database.getTask(message.taskId), created: false, dispatchSequence: null }
    : database.ensureAgentRequestTask(projectId, message);
  if (!request.task) return null;
  if (request.dispatchSequence !== null) return null;
  const dispatch = {
    type: "agent.dispatch",
    projectId,
    messageId: message.id,
    taskId: request.task.id,
    body: message.body,
    anyAgent,
    targets,
    at: message.createdAt,
  };
  if (request.created) events.emit("task.created", { task: request.task });
  const sequence = database.appendIntegrationEvent("agents", dispatch);
  if (!message.taskId) database.recordAgentRequestDispatch(message.id, sequence);
  events.emit("project.agent.requested", { projectId, message, dispatch });
  return dispatch;
}

// 看板评论里的 @提及 从正文文本解析（评论没有结构化 mentions 字段）。
function commentMentionTokens(body) {
  const tokens = new Set();
  for (const match of String(body).matchAll(/@([A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_.\-\u4e00-\u9fa5]{0,95})/g)) {
    tokens.add(match[1]);
    if (tokens.size >= 20) break;
  }
  return [...tokens];
}

// 人类用户在任务评论中 @Agent/@具体agent → 进入 agent 派发通道（与群聊 @ 同语义）。
// 仅限 user 作者：agent 自己的评论绝不触发派发，避免自激励循环。
function dispatchCommentMentions(database, events, task, comment) {
  if (!task || comment.authorType !== "user") return null;
  const mentions = commentMentionTokens(comment.body);
  if (mentions.length === 0) return null;
  return dispatchAgentMentions(database, events, task.projectId, {
    id: comment.id,
    taskId: comment.taskId,
    body: comment.body,
    mentions,
    author: {
      type: comment.authorType,
      id: comment.authorId,
      name: comment.authorName,
      avatarUrl: comment.authorAvatarUrl,
    },
    createdAt: comment.createdAt,
  });
}

function agentSystemMessage(database, events, projectId, body, taskId = null) {
  const message = database.createProjectMessage(projectId, {
    body,
    kind: "progress",
    taskId,
    actor: { type: "agent", id: "agent:dispatcher", name: "调度系统", avatarUrl: null },
  });
  events.emit("project.message.created", { projectId, message });
  return message;
}

function boundedLeaseSeconds(value) {
  const seconds = Number(value ?? AGENT_DEFAULT_LEASE_SECONDS);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > AGENT_MAX_LEASE_SECONDS) {
    throw new ApiError(400, "INVALID_FIELD", "'leaseSeconds' must be an integer between 30 and 86400");
  }
  return seconds;
}

function parseAssigneeTarget(value) {
  if (value === undefined) return undefined;
  if (value !== "current-user" && value !== "codex-agent") {
    throw new ApiError(400, "INVALID_FIELD", "'assigneeTarget' must be current-user or codex-agent");
  }
  return value;
}

function resolveAssignee(target, actor) {
  if (target === undefined) return actor;
  if (target === "codex-agent") return CODEX_AGENT_ACTOR;
  if (actor.type !== "user") {
    throw new ApiError(400, "INVALID_FIELD", "'current-user' requires a user request identity");
  }
  return actor;
}

function parseWorkflowId(value) {
  const workflowId = stringField(value, "workflowId", { nullable: true, maxLength: 128 });
  if (workflowId === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workflowId' cannot be empty");
  }
  return workflowId;
}

function parseTaskCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId", "title", "description", "status", "priority", "labels", "sortOrder", "threadId",
    "assigneeTarget", "workflowId", "developmentContext", "dueDate", "recurrence",
  ]));
  const projectId = validateProjectId(body.projectId ?? DEFAULT_PROJECT_ID);
  const task = {
    projectId,
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "backlog"),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    workflowId: parseWorkflowId(body.workflowId ?? null),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (task.recurrence && !task.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  return task;
}

function parseTaskPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "title", "description", "status", "priority", "labels", "threadId",
    "assigneeTarget", "workflowId", "developmentContext", "dueDate", "recurrence",
  ]));
  const version = parseVersion(body.version);
  const threadId = parseThreadId(body.threadId);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  const changes = {};
  if (body.title !== undefined) changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  if (body.description !== undefined) changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.workflowId !== undefined) changes.workflowId = parseWorkflowId(body.workflowId);
  if (body.developmentContext !== undefined) changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  if (changes.recurrence && body.dueDate === null) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
  return { version, changes, threadId, assigneeTarget };
}

function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "sortOrder", "threadId"]));
  return {
    version: parseVersion(body.version),
    status: parseStatus(body.status),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
  };
}

function parseArchive(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId"]));
  return { version: parseVersion(body.version), threadId: parseThreadId(body.threadId) };
}

function parseIssueRelationType(value) {
  if (!["parent", "blocks", "blocked_by", "related"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'relation type' must be parent, blocks, blocked_by, or related",
    );
  }
  return value;
}

function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
  };
}

function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
  };
}

function parseAttachmentHeaders(request) {
  const encodedFilename = request.headers["x-taskboard-filename"];
  if (typeof encodedFilename !== "string") {
    throw new ApiError(400, "INVALID_FILENAME", "X-Taskboard-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename contains invalid encoding");
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }

  const rawContentType = request.headers["content-type"];
  const contentType = typeof rawContentType === "string"
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (contentType.length === 0 || contentType.length > 200 || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Attachment Content-Type is invalid");
  }
  return { filename, contentType };
}

async function readBody(request, limit, tooLargeMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "Request body cannot exceed 1 MiB",
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const body = await readBody(request, limit, tooLargeMessage);
  const length = body.length;
  if (length === 0) {
    throw new ApiError(400, "INVALID_JSON", "Request body cannot be empty");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

async function assertEmptyRequestBody(request, routeLabel) {
  const body = await readBody(request, JSON_BODY_LIMIT, "Request body cannot exceed 1 MiB");
  if (body.length > 0) {
    throw new ApiError(400, "INVALID_BODY", `${routeLabel} does not accept a request body`);
  }
}

function parseTaskFilters(searchParams) {
  const allowed = new Set(["projectId", "status", "archived"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }

  const projectIdValue = searchParams.get("projectId");
  const statusValue = searchParams.get("status");
  const archived = searchParams.get("archived") ?? "false";
  if (statusValue !== null && !isTaskStatus(statusValue)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Invalid task status");
  }
  if (!new Set(["true", "false", "all"]).has(archived)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'archived' must be true, false, or all");
  }
  const projectId = projectIdValue === null ? undefined : validateProjectId(projectIdValue);
  return { projectId, status: statusValue ?? undefined, archived };
}

function parseProjectFilters(searchParams) {
  const allowed = new Set(["hidden"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
  const hidden = searchParams.get("hidden") ?? "false";
  if (!new Set(["true", "false", "all"]).has(hidden)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'hidden' must be true, false, or all");
  }
  return { hidden };
}

function parseAiSandbox(value) {
  if (value === undefined) return undefined;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_SANDBOX",
      "'sandbox' must be read-only, workspace-write, or danger-full-access",
    );
  }
  return value;
}

function parseAiSetting(value, name, maxLength) {
  const setting = stringField(value, name, { maxLength });
  if (setting === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  return setting;
}

function parseAiThreadCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId",
    "issueId",
    "title",
    "model",
    "reasoningEffort",
    "sandbox",
  ]));
  return {
    projectId: validateProjectId(body.projectId),
    issueId: parseAiSetting(body.issueId, "issueId", 128),
    title: parseAiSetting(body.title, "title", 160),
    model: parseAiSetting(body.model, "model", 128),
    reasoningEffort: parseAiSetting(body.reasoningEffort, "reasoningEffort", 64),
    sandbox: parseAiSandbox(body.sandbox),
  };
}

function parseAiThreadPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title", "model", "reasoningEffort", "sandbox"]));
  const input = {};
  if (body.title !== undefined) input.title = parseAiSetting(body.title, "title", 160);
  if (body.model !== undefined) input.model = parseAiSetting(body.model, "model", 128);
  if (body.reasoningEffort !== undefined) {
    input.reasoningEffort = parseAiSetting(body.reasoningEffort, "reasoningEffort", 64);
  }
  if (body.sandbox !== undefined) input.sandbox = parseAiSandbox(body.sandbox);
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one thread setting");
  }
  return input;
}

function parseAiSkillIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must be an array with at most 20 entries");
  }
  const skillIds = value.map((skillId, index) => (
    stringField(skillId, `skillIds[${index}]`, { required: true, maxLength: 256 })
  ));
  return skillIds;
}

function parseAiAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AI_CHAT_ATTACHMENT_LIMIT) {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT",
      `'attachments' must be an array with at most ${AI_CHAT_ATTACHMENT_LIMIT} files`,
    );
  }
  return value.map((attachment, index) => {
    assertPlainObject(attachment);
    assertAllowedKeys(attachment, new Set(["filename", "contentType", "dataBase64"]));
    const filename = stringField(attachment.filename, `attachments[${index}].filename`, {
      required: true,
      maxLength: 240,
    });
    if (/[\u0000-\u001f\u007f/\\]/.test(filename)) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].filename' is invalid`,
      );
    }
    const contentType = stringField(
      attachment.contentType,
      `attachments[${index}].contentType`,
      { required: true, maxLength: 256 },
    ).toLowerCase();
    const dataBase64 = stringField(
      attachment.dataBase64,
      `attachments[${index}].dataBase64`,
      { required: true, maxLength: AI_CHAT_TURN_BODY_LIMIT },
    );
    if (
      dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    const data = Buffer.from(dataBase64, "base64");
    if (data.length === 0 || data.toString("base64") !== dataBase64) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    return { filename, contentType, data, size: data.length };
  });
}

function parseAiTurn(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "message",
    "skillIds",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  const message = stringField(body.message ?? "", "message", { maxLength: 100_000 });
  const skillIds = parseAiSkillIds(body.skillIds) ?? [];
  if (message.split(AI_CHAT_SKILL_MARKER).length - 1 !== skillIds.length) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must match the Skill markers in 'message'");
  }
  const attachments = parseAiAttachments(body.attachments);
  if (message === "" && attachments.length === 0) {
    throw new ApiError(
      400,
      "INVALID_MESSAGE",
      "A message or at least one attachment is required",
    );
  }
  return {
    message,
    skillIds,
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments,
  };
}

class EventHub {
  constructor(onEmit = null) {
    this.clients = new Set();
    this.onEmit = onEmit;
    this.deferred = null;
    this.keepAlive = setInterval(() => {
      for (const client of this.clients) client.response.write(": keep-alive\n\n");
    }, 20_000);
    this.keepAlive.unref();
  }

  connect(request, response, filter = () => true) {
    response.writeHead(200, {
      connection: "keep-alive",
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.add({ response, filter });
    request.once("close", () => {
      for (const client of this.clients) {
        if (client.response === response) this.clients.delete(client);
      }
    });
  }

  emit(type, value) {
    const event = {
      type,
      projectId: value.projectId ?? value.project?.id ?? value.task?.projectId,
      taskId: value.task?.id ?? value.comment?.taskId ?? value.attachment?.taskId,
      ...value,
      at: new Date().toISOString(),
    };
    // outbox 追加必须留在事务内（与业务写同原子性）；SSE 广播在事务内只入队：
    // 回滚时丢弃，避免客户端看到未提交的幻影事件；提交后才真正广播。
    this.onEmit?.(event);
    if (this.deferred) {
      this.deferred.push({ event, type });
      return;
    }
    this.#broadcast(event, type);
  }

  // 事务边界内的 SSE 事件缓冲：COMMIT 后广播，ROLLBACK 后丢弃。
  withTransaction(database, fn) {
    this.deferred = [];
    let result;
    try {
      result = database.transaction(fn);
    } catch (error) {
      this.deferred = null;
      throw error;
    }
    const pending = this.deferred;
    this.deferred = null;
    for (const { event, type } of pending) this.#broadcast(event, type);
    return result;
  }

  #broadcast(event, type) {
    const message = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (client.filter(event)) client.response.write(message);
    }
  }

  close() {
    clearInterval(this.keepAlive);
    for (const client of this.clients) client.response.end();
    this.clients.clear();
  }
}

async function serveStatic(request, response, pathname, staticDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "INVALID_PATH", "URL path contains invalid encoding");
  }
  if (decodedPath.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", "URL path is invalid");
  }

  const root = path.resolve(staticDirectory);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filename = path.resolve(root, relativePath);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, "INVALID_PATH", "URL path is outside the static directory");
  }

  let fileStats;
  try {
    fileStats = await stat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fileStats?.isFile() && !path.extname(relativePath)) {
    filename = path.join(root, "index.html");
    try {
      fileStats = await stat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fileStats?.isFile()) return false;

  const body = await readFile(filename);
  const headers = {
    "cache-control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": body.length,
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
  };
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

function codexProjectRoot(state, projectId) {
  if (!projectId || !state || typeof state !== "object") return null;
  const project = state["local-projects"]?.[projectId];
  const root = Array.isArray(project?.rootPaths) ? project.rootPaths[0] : null;
  return typeof root === "string" && root.trim() ? root : null;
}

async function readCodexProjectWorkspaces(codexStatePath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const projects = state["local-projects"];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
    return Object.fromEntries(Object.keys(projects).flatMap((projectId) => {
      const root = codexProjectRoot(state, projectId);
      return root ? [[projectId, root]] : [];
    }));
  } catch {
    return {};
  }
}

function latestThreadCwd(value, threadId) {
  const matches = [];
  const stack = [value];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.conversationId === threadId && typeof candidate.cwd === "string" && candidate.cwd.trim()) {
      matches.push(candidate);
    }
    stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
  }
  matches.sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  return matches[0]?.cwd ?? null;
}

async function resolveProjectWorkspace(project, codexProjectId, codexThreadId, codexStatePath, codexProcessesPath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const assignment = state["thread-project-assignments"]?.[codexThreadId];
    const root = codexProjectRoot(state, project.id)
      ?? codexProjectRoot(state, codexProjectId)
      ?? codexProjectRoot(state, assignment?.projectId)
      ?? (typeof assignment?.cwd === "string" ? assignment.cwd : null);
    if (root) return root;
  } catch {}
  if (project.workspacePath) return project.workspacePath;
  if (!codexThreadId) return null;
  try {
    const processes = JSON.parse(await readFile(codexProcessesPath, "utf8"));
    return latestThreadCwd(processes, codexThreadId);
  } catch {
    return null;
  }
}

function parseWorktrees(output) {
  const contexts = [];
  for (const block of output.trim().split(/\n\s*\n/)) {
    if (!block) continue;
    let worktreePath = "";
    let branch = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
    }
    if (worktreePath) contexts.push({ type: "worktree", path: worktreePath, branch });
  }
  return contexts;
}

async function scanDevelopmentContexts(workspacePath) {
  if (!workspacePath) return { workspacePath: null, contexts: [] };
  try {
    const rootResult = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], {
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    const root = rootResult.stdout.trim();
    const [branchesResult, worktreesResult] = await Promise.all([
      execFileAsync("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], {
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const branches = branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
    return {
      workspacePath: root,
      contexts: [
        ...branches.map((branch) => ({ type: "branch", branch })),
        ...parseWorktrees(worktreesResult.stdout),
      ],
    };
  } catch {
    return { workspacePath, contexts: [] };
  }
}

async function discoverSkills(codexExecutable, workspacePath) {
  const entries = await new Promise((resolve, reject) => {
    const child = spawn(codexExecutable, ["app-server", "--stdio"], {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      finish(new Error("Timed out while reading Codex skills"));
    }, 10_000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server rejected initialization"));
          return;
        }
        send({ method: "initialized" });
        send({
          id: 2,
          method: "skills/list",
          params: { cwds: [workspacePath], forceReload: false },
        });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) {
        finish(new Error("Codex app-server could not list skills"));
        return;
      }
      finish(null, Array.isArray(message.result?.data) ? message.result.data : []);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before listing skills (${signal || code})`));
      }
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codex-taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });

  const unique = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const skill of entry.skills) {
      if (
        !skill
        || typeof skill !== "object"
        || skill.enabled === false
        || typeof skill.name !== "string"
        || !skill.name.trim()
      ) {
        continue;
      }
      const id = skill.name.trim();
      if (unique.has(id)) continue;
      const displayName = typeof skill.interface?.displayName === "string"
        ? skill.interface.displayName.trim()
        : "";
      unique.set(id, {
        id,
        label: displayName || id,
        description: typeof skill.description === "string" ? skill.description.trim() : "",
        path: typeof skill.path === "string" ? skill.path.trim() : "",
        scope: ["user", "repo", "system", "admin"].includes(skill.scope)
          ? skill.scope
          : "user",
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverMcpServers(codexExecutable) {
  const result = await execFileAsync(codexExecutable, ["mcp", "list", "--json"], {
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const entries = JSON.parse(result.stdout);
  if (!Array.isArray(entries)) throw new Error("Codex returned an invalid MCP server list");
  return entries
    .filter((entry) => (
      entry
      && typeof entry === "object"
      && typeof entry.name === "string"
      && entry.name.trim()
      && entry.enabled !== false
    ))
    .map((entry) => ({
      id: entry.name.trim(),
      label: entry.name.trim(),
      transport: typeof entry.transport?.type === "string"
        ? entry.transport.type
        : "unknown",
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverWorkflowCapabilities(resolved, workspacePath) {
  const [skills, mcpServers] = await Promise.all([
    discoverSkills(resolved.codexExecutable, workspacePath),
    discoverMcpServers(resolved.codexExecutable),
  ]);
  return { skills, mcpServers };
}

export function resolveServerOptions(options = {}) {
  const configuredDataDirectory = options.dataDirectory ?? process.env.CODEX_TASKBOARD_DATA_DIR;
  const dataDirectory = configuredDataDirectory
    ? path.resolve(configuredDataDirectory)
    : path.join(PROJECT_ROOT, ".data");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    dataDirectory,
    databasePath: options.databasePath ?? path.join(dataDirectory, "taskboard.sqlite"),
    attachmentsDirectory: options.attachmentsDirectory ?? path.join(dataDirectory, "attachments"),
    cloudConfigPath: options.cloudConfigPath ?? path.join(dataDirectory, "cloud-companion.json"),
    staticDirectory: options.staticDirectory ?? path.join(PROJECT_ROOT, "dist", "web"),
    skillPath: options.skillPath ?? path.join(PROJECT_ROOT, "skills", "manage-taskboard", "SKILL.md"),
    codexExecutable: options.codexExecutable ?? process.env.CODEX_EXECUTABLE ?? "codex",
    codexStatePath: options.codexStatePath
      ?? path.join(codexHome, ".codex-global-state.json"),
    codexProcessesPath: options.codexProcessesPath
      ?? path.join(codexHome, "process_manager", "chat_processes.json"),
    // 权威云实例应设为 "true"：机器能力路由（在任意 workspacePath 执行
    // git/codex 扫描）只允许本机直连，公网经 nginx 的流量会被拒绝。
    machineCapabilitiesLoopbackOnly: options.machineCapabilitiesLoopbackOnly
      ?? ["1", "true", "yes"].includes(String(process.env.CODEX_TASKBOARD_MACHINE_CAPABILITIES_LOOPBACK ?? "").trim().toLowerCase()),
  };
}

export function resolvePort(value = process.env.CODEX_TASKBOARD_PORT ?? "47823") {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEX_TASKBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function resolveHost(value = process.env.CODEX_TASKBOARD_HOST ?? "0.0.0.0") {
  const host = String(value).trim();
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("CODEX_TASKBOARD_HOST must be 127.0.0.1 or 0.0.0.0");
  }
  return host;
}

export function createTaskboardServer(options = {}) {
  const resolved = resolveServerOptions(options);
  const database = new TaskboardDatabase(resolved.databasePath);
  const wecomAuth = createWeComAuth({
    database,
    config: resolveWeComConfig(options.wecom),
    fetch: options.wecomFetch ?? globalThis.fetch,
  });
  const events = new EventHub((event) => database.appendIntegrationEvent("workbuddy", event));
  const deviceProjectSync = createDeviceProjectSync({
    database,
    config: resolveDeviceProjectSyncConfig(options.deviceProjectSync),
    onChange: (devices) => events.emit("device.projects.synced", { devices }),
  });
  const cloudConfig = options.cloudConfigStore ?? createCloudConfigStore({
    configPath: resolved.cloudConfigPath,
  });
  const cloudProxy = createCloudProxy({
    configStore: cloudConfig,
    fetch: options.remoteFetch ?? globalThis.fetch,
    resolveDevelopmentContext: async (projectId, context) => {
      if (!context.branch) return null;
      const config = await cloudConfig.read();
      const workspacePath = config.projectMappings[projectId];
      if (!workspacePath) return null;
      const result = await scanDevelopmentContexts(workspacePath);
      return result.contexts.find((candidate) => (
        candidate.type === "worktree" && candidate.branch === context.branch
      )) ?? null;
    },
  });
  const aiChat = new AiChatService({
    database,
    codexExecutable: resolved.codexExecutable,
    codexStatePath: resolved.codexStatePath,
    manageTaskboardSkillPath: resolved.skillPath,
  });
  const aiEventResponses = new Set();

  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    try {
      assertTrustedNetworkRequest(request, wecomAuth.trustedOrigin);
      const url = new URL(request.url, "http://127.0.0.1");
      const wecomRoute = await wecomAuth.handle(request, response, url);
      if (wecomRoute.handled) return;
      const pathname = wecomRoute.pathname;
      request.taskboardActor = wecomAuth.actorFromRequest(request);
      request.taskboardRole = wecomAuth.roleFromRequest(request, request.taskboardActor);
      const isLocalAiRoute = pathname === "/api/local/ai" || pathname.startsWith("/api/local/ai/");
      if (isLocalAiRoute) {
        assertAiLoopbackRequest(request);
      } else if (pathname.startsWith("/api/local/")) {
        assertLoopbackRequest(request);
      }
      const isMachineCapabilityRoute = pathname === "/api/meta"
        || pathname === "/api/device-workspaces"
        || pathname === "/api/workflow-capabilities"
        || /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname);
      const capabilityCloudConfig = isMachineCapabilityRoute
        ? await cloudConfig.read()
        : null;
      if (
        capabilityCloudConfig?.remoteUrl
        || (isMachineCapabilityRoute
          && pathname !== "/api/meta"
          && resolved.machineCapabilitiesLoopbackOnly)
      ) {
        assertLoopbackRequest(request);
      }

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, { status: "ok" });
      }

      if (pathname === "/api/session") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/session");
        const actor = request.taskboardActor ?? {
          type: "user",
          id: "local-user",
          name: "本地用户",
          avatarUrl: null,
        };
        return sendJson(response, 200, {
          mode: request.taskboardActor?.id?.startsWith("basic:") ? "service"
            : request.taskboardActor ? "wecom" : "local",
          agentId: request.taskboardActor?.id?.startsWith("basic:")
            ? null
            : request.taskboardActor ? wecomAuth.config.agentId : null,
          role: request.taskboardRole,
          user: actor,
        });
      }

      if (pathname === "/api/system/data-health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET data health");
        assertAdmin(request);
        return sendJson(
          response,
          200,
          await dataHealthReport(database, resolved.attachmentsDirectory),
        );
      }

      if (pathname === "/api/integrations/workbuddy/changes") {
        assertWorkBuddyBridge(request);
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set(["after", "limit"]), "GET WorkBuddy changes");
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          throw new ApiError(400, "INVALID_QUERY", "'after' and 'limit' must be bounded integers");
        }
        const changes = database.listIntegrationEvents("workbuddy", after, limit);
        return sendJson(response, 200, {
          changes,
          nextCursor: changes.at(-1)?.sequence ?? after,
        });
      }

      if (pathname === "/mcp/workbuddy") {
        assertAgentActor(request);
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /mcp/workbuddy");
        const message = await readJson(request);
        assertPlainObject(message);
        const id = message.id ?? null;
        if (message.method === "notifications/initialized") return sendEmpty(response, 202);
        if (message.method === "initialize") {
          return sendJson(response, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "dashi-taskboard-workbuddy", version: "0.1.0" },
            },
          });
        }
        if (message.method === "tools/list") {
          return sendJson(response, 200, {
            jsonrpc: "2.0",
            id,
            result: { tools: [
              {
                name: "dashi_project_changes",
                description: "读取 Dashi 项目的增量任务、评论和审批事件，并返回下一游标。",
                inputSchema: {
                  type: "object",
                  properties: {
                    after: { type: "integer", minimum: 0, default: 0 },
                    limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
                  },
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_get_task",
                description: "按 Dashi task ID 读取任务、关系和最近审批记录。",
                inputSchema: {
                  type: "object",
                  properties: { taskId: { type: "string" } },
                  required: ["taskId"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_add_comment",
                description: "把 WorkBuddy 员工或 Agent 的进度摘要写入 Dashi 任务评论。",
                inputSchema: {
                  type: "object",
                  properties: { taskId: { type: "string" }, body: { type: "string", maxLength: 100000 } },
                  required: ["taskId", "body"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_list_project_messages",
                description: "读取项目共享群聊中的员工消息、Agent 回复和执行进度。",
                inputSchema: {
                  type: "object",
                  properties: {
                    projectId: { type: "string", maxLength: 64 },
                    after: { type: "integer", minimum: 0, default: 0 },
                    limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
                  },
                  required: ["projectId"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_post_project_message",
                description: "把 WorkBuddy 或 Agent 的回复和进度写回项目共享群聊。",
                inputSchema: {
                  type: "object",
                  properties: {
                    projectId: { type: "string", maxLength: 64 },
                    body: { type: "string", maxLength: 100000 },
                    kind: { type: "string", enum: ["message", "progress", "decision"] },
                    taskId: { type: "string", maxLength: 128 },
                    replyToMessageId: { type: "string", maxLength: 128 },
                    mentions: { type: "array", items: { type: "string", maxLength: 96 }, maxItems: 20 },
                    authorUserId: { type: "string", maxLength: 96 },
                    authorName: { type: "string", maxLength: 120 },
                  },
                  required: ["projectId", "body"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_submit_for_review",
                description: "将任务提交到审核中；不能直接标记完成。",
                inputSchema: {
                  type: "object",
                  properties: { taskId: { type: "string" }, version: { type: "integer", minimum: 1 } },
                  required: ["taskId", "version"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_upsert_project",
                description: "把 WorkBuddy 项目登记到 Dashi（幂等：已存在则直接返回）。返回 Dashi 项目 ID，供后续 upsert_task 使用。",
                inputSchema: {
                  type: "object",
                  properties: {
                    workbuddyProjectId: { type: "string", maxLength: 190 },
                    name: { type: "string", maxLength: 160 },
                    ownerUserId: { type: "string", maxLength: 190 },
                    ownerName: { type: "string", maxLength: 190 },
                  },
                  required: ["workbuddyProjectId", "name"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_upsert_task",
                description: "把 WorkBuddy 项目的任务同步到 Dashi（幂等：按 workbuddyTaskId 去重，已存在则更新标题/描述/状态）。WorkBuddy 侧 done 映射为 in_review 待管理员审批。",
                inputSchema: {
                  type: "object",
                  properties: {
                    projectId: { type: "string", maxLength: 64 },
                    workbuddyTaskId: { type: "string", maxLength: 190 },
                    title: { type: "string", maxLength: 200 },
                    description: { type: "string", maxLength: 100000 },
                    status: { type: "string", enum: ["todo", "in_progress", "in_review", "done"] },
                    assigneeName: { type: "string", maxLength: 190 },
                  },
                  required: ["projectId", "workbuddyTaskId", "title"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_agent_register",
                description: "Agent 接入注册（任意终端的 Claude/Codex/DeepSeek 等 Worker 调用）。注册后以「名称·设备」身份出现在项目群聊。agentId 默认取认证用户名。",
                inputSchema: {
                  type: "object",
                  properties: {
                    agentId: { type: "string", maxLength: 96 },
                    name: { type: "string", maxLength: 120 },
                    device: { type: "string", maxLength: 120 },
                    capabilities: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 16 },
                    projects: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 64 },
                    concurrency: { type: "integer", minimum: 1, maximum: 16 },
                  },
                  required: ["name"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_agent_heartbeat",
                description: "Agent 心跳：保持在线状态。超过 5 分钟无心跳将被标记离线，其任务租约到期后可被其他 Agent 接管。",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
              {
                name: "dashi_list_agents",
                description: "列出所有已注册 Agent：身份、设备、能力、在线状态、当前持有租约。",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
              {
                name: "dashi_agent_events",
                description: "Agent 拉取派发事件（增量）：群聊中 @本Agent 或 @Agent(任意) 的工作请求。用返回的 nextCursor 轮询。",
                inputSchema: {
                  type: "object",
                  properties: {
                    after: { type: "integer", minimum: 0, default: 0 },
                    limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
                  },
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_claim_task",
                description: "原子领取任务并获得租约：并发时只有一个 Agent 成功；任务被其他有效租约持有返回 409。领取成功会向项目群聊写进度消息。",
                inputSchema: {
                  type: "object",
                  properties: {
                    taskId: { type: "string", maxLength: 128 },
                    leaseSeconds: { type: "integer", minimum: 30, maximum: 86400 },
                  },
                  required: ["taskId"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_renew_task_lease",
                description: "续租当前持有的任务租约，长任务需要周期性调用。",
                inputSchema: {
                  type: "object",
                  properties: {
                    taskId: { type: "string", maxLength: 128 },
                    leaseSeconds: { type: "integer", minimum: 30, maximum: 86400 },
                  },
                  required: ["taskId"],
                  additionalProperties: false,
                },
              },
              {
                name: "dashi_release_task",
                description: "释放任务租约（放弃/交接时调用），任务回到可领取状态并记录到群聊。",
                inputSchema: {
                  type: "object",
                  properties: {
                    taskId: { type: "string", maxLength: 128 },
                    reason: { type: "string", maxLength: 500 },
                  },
                  required: ["taskId"],
                  additionalProperties: false,
                },
              },
            ] },
          });
        }
        if (message.method === "tools/call") {
          const toolName = message.params?.name;
          const args = message.params?.arguments ?? {};
          let result;
          if (toolName === "dashi_project_changes") {
            assertWorkBuddyBridge(request);
            const after = Number(args.after ?? 0);
            const limit = Number(args.limit ?? 100);
            if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
              throw new ApiError(400, "INVALID_FIELD", "Invalid WorkBuddy change cursor or limit");
            }
            const changes = database.listIntegrationEvents("workbuddy", after, limit);
            result = { changes, nextCursor: changes.at(-1)?.sequence ?? after };
          } else if (toolName === "dashi_get_task") {
            const taskId = stringField(args.taskId, "taskId", { required: true, maxLength: 128 });
            const task = database.getTask(taskId);
            if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
            assertAgentProjectScope(database, actorFromRequest(request), task.projectId);
            result = { task };
          } else if (toolName === "dashi_add_comment") {
            const taskId = stringField(args.taskId, "taskId", { required: true, maxLength: 128 });
            const body = stringField(args.body, "body", { required: true, maxLength: 100_000 });
            const task = database.getTask(taskId);
            if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
            assertAgentProjectScope(database, actorFromRequest(request), task.projectId);
            const comment = events.withTransaction(database, () => {
              const created = database.createComment(taskId, {
                body,
                actor: resolveAgentAuthor(database, actorFromRequest(request)),
              });
              events.emit("comment.created", { comment: created, task });
              dispatchCommentMentions(database, events, task, created);
              return created;
            });
            result = { comment, task };
          } else if (toolName === "dashi_list_project_messages") {
            const projectId = stringField(args.projectId, "projectId", { required: true, maxLength: 64 });
            validateProjectId(projectId);
            assertAgentProjectScope(database, actorFromRequest(request), projectId);
            const after = Number(args.after ?? 0);
            const limit = Number(args.limit ?? 100);
            if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
              throw new ApiError(400, "INVALID_FIELD", "Invalid project message cursor or limit");
            }
            const messages = database.listProjectMessages(projectId, after, limit);
            result = { messages, nextCursor: messages.at(-1)?.sequence ?? after };
          } else if (toolName === "dashi_post_project_message") {
            const projectId = stringField(args.projectId, "projectId", { required: true, maxLength: 64 });
            validateProjectId(projectId);
            assertAgentProjectScope(database, actorFromRequest(request), projectId);
            const input = parseProjectMessage({
              body: args.body,
              kind: args.kind,
              mentions: args.mentions,
              taskId: args.taskId,
              replyToMessageId: args.replyToMessageId,
            });
            const authorUserId = isWorkBuddyBridge(request)
              ? stringField(args.authorUserId, "authorUserId", { required: false, maxLength: 96 })
              : undefined;
            const authorName = stringField(
              args.authorName,
              "authorName",
              { required: false, maxLength: 120 },
            );
            if ((authorUserId === undefined) !== (authorName === undefined)) {
              throw new ApiError(400, "INVALID_FIELD", "authorUserId and authorName must be provided together");
            }
            if (!isWorkBuddyBridge(request) && args.authorUserId !== undefined) {
              throw new ApiError(403, "WORKBUDDY_BRIDGE_REQUIRED", "Only the WorkBuddy bridge may post on behalf of users");
            }
            if (authorUserId && !database.getProjectMembership(projectId, authorUserId)) {
              throw new ApiError(403, "PROJECT_ACCESS_DENIED", "WorkBuddy 发言人不是此项目成员");
            }
            const projectMessage = events.withTransaction(database, () => {
              const message = database.createProjectMessage(projectId, {
                ...input,
                actor: authorUserId
                  ? { type: "user", id: authorUserId, name: authorName, avatarUrl: null }
                  : resolveAgentAuthor(database, actorFromRequest(request)),
              });
              events.emit("project.message.created", { projectId, message });
              dispatchAgentMentions(database, events, projectId, message);
              return message;
            });
            result = { message: projectMessage };
          } else if (toolName === "dashi_submit_for_review") {
            const taskId = stringField(args.taskId, "taskId", { required: true, maxLength: 128 });
            const username = agentUsernameFromActor(actorFromRequest(request));
            if (!username || username === "workbuddy-agent") {
              throw new ApiError(403, "AGENT_AUTH_REQUIRED", "Only the Agent holding the active lease may submit for review");
            }
            const reviewTarget = database.getTask(taskId);
            if (!reviewTarget) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
            assertAgentProjectScope(database, actorFromRequest(request), reviewTarget.projectId);
            const task = events.withTransaction(database, () => {
              const submitted = database.submitClaimedTaskForReview(taskId, username, parseVersion(args.version));
              events.emit("task.moved", { task: submitted });
              return submitted;
            });
            result = { task };
          } else if (toolName === "dashi_upsert_project") {
            assertWorkBuddyBridge(request);
            const workbuddyProjectId = stringField(args.workbuddyProjectId, "workbuddyProjectId", { required: true, maxLength: 190 });
            const name = stringField(args.name, "name", { required: true, maxLength: 160 });
            const ownerUserId = stringField(args.ownerUserId, "ownerUserId", { required: false, maxLength: 190 }) ?? null;
            const ownerName = stringField(args.ownerName, "ownerName", { required: false, maxLength: 190 }) ?? null;
            const projectId = workbuddyProjectMappingId(workbuddyProjectId);
            const { project, created } = events.withTransaction(database, () => {
              let project = database.getProject(projectId);
              let created = false;
              if (!project) {
                project = database.createProject({ id: projectId, name, workspacePath: null, actor: actorFromRequest(request) });
                created = true;
              }
              if (ownerUserId) {
                database.upsertProjectMember(projectId, {
                  userId: ownerUserId.slice(0, 96),
                  userName: (ownerName ?? ownerUserId).slice(0, 120),
                  userAvatarUrl: null,
                  role: "manager",
                });
                project = database.getProject(projectId);
              }
              events.emit("project.member.updated", { projectId, project });
              return { project, created };
            });
            result = { project, created };
          } else if (toolName === "dashi_upsert_task") {
            assertWorkBuddyBridge(request);
            const projectId = stringField(args.projectId, "projectId", { required: true, maxLength: 64 });
            validateProjectId(projectId);
            const workbuddyTaskId = stringField(args.workbuddyTaskId, "workbuddyTaskId", { required: true, maxLength: 190 });
            const title = stringField(args.title, "title", { required: true, maxLength: 200 });
            const description = stringField(args.description, "description", { required: false, maxLength: 100_000 }) ?? null;
            const rawStatus = stringField(args.status, "status", { required: false, maxLength: 32 });
            const assigneeName = stringField(args.assigneeName, "assigneeName", { required: false, maxLength: 190 }) ?? null;
            if (rawStatus !== undefined && !isTaskStatus(rawStatus)) {
              throw new ApiError(400, "INVALID_FIELD", "status must be one of todo/in_progress/in_review/done");
            }
            // WorkBuddy completion requires administrator review in Dashi.
            const status = rawStatus === "done" ? "in_review" : rawStatus;
            const threadId = `workbuddy:${workbuddyTaskId}`;
            const actor = actorFromRequest(request);
            const existingId = database.findTaskIdByThreadId(threadId);
            let task;
            if (existingId) {
              const current = database.getTask(existingId);
              const changes = {};
              if (title !== current.title) changes.title = title;
              if (description !== null && description !== current.description) changes.description = description;
              // 已审批完成的任务不允许被同步通道打回 todo/in_progress；
              // done 只能退到 in_review（重开审批），重开决策属于人类管理员。
              const reopenedForReview = current.status === "done" && (status === "todo" || status === "in_progress");
              if (status !== undefined && status !== current.status && !reopenedForReview) changes.status = status;
              if (Object.keys(changes).length > 0) {
                task = events.withTransaction(database, () => {
                  const task = database.updateTask(existingId, current.version, changes, undefined);
                  events.emit("task.updated", { task });
                  return task;
                });
              } else {
                task = current;
              }
              result = { task, created: false };
            } else {
              task = events.withTransaction(database, () => {
                const task = database.createTask({
                  projectId,
                  title,
                  description: description ?? "",
                  status: status ?? "todo",
                  priority: "medium",
                  labels: ["workbuddy"],
                  threadId,
                  workflowId: null,
                  developmentContext: null,
                  dueDate: null,
                  recurrence: null,
                  actor,
                  assignee: assigneeName
                    ? { type: "user", id: `workbuddy:${assigneeName}`, name: assigneeName, avatarUrl: null }
                    : actor,
                });
                events.emit("task.created", { task });
                return task;
              });
              result = { task, created: true };
            }
          } else if (toolName === "dashi_agent_register") {
            const actor = actorFromRequest(request);
            const username = agentUsernameFromActor(actor);
            const explicitId = stringField(args.agentId, "agentId", { required: false, maxLength: 96 });
            if (!explicitId && !username) {
              throw new ApiError(403, "AGENT_AUTH_REQUIRED", "Agent tools require agent (Basic + x-taskboard-client) authentication");
            }
            if (explicitId && username && explicitId !== username) {
              // 不存在任何用户名例外：否则任一持密钥者都可用 workbuddy-agent
              // 覆写其他 Agent 的注册信息，伪造其「名称·设备」群聊身份。
              throw new ApiError(403, "AGENT_ID_MISMATCH", `Authenticated as '${username}'; cannot register as '${explicitId}'`);
            }
            const capabilities = Array.isArray(args.capabilities)
              ? args.capabilities.map((item, index) => stringField(item, `capabilities[${index}]`, { required: true, maxLength: 40 }))
              : [];
            const projects = Array.isArray(args.projects)
              ? args.projects.map((item, index) => validateProjectId(
                stringField(item, `projects[${index}]`, { required: true, maxLength: 64 }),
              ))
              : [];
            const binding = actor?.agentBinding;
            if (binding) {
              if (args.device !== undefined && String(args.device).trim() !== binding.device) {
                throw new ApiError(403, "AGENT_SCOPE_MISMATCH", "Agent device is controlled by the server credential binding");
              }
              if (args.projects !== undefined && (
                projects.length !== binding.projects.length
                || projects.some((projectId) => !binding.projects.includes(projectId))
              )) {
                throw new ApiError(403, "AGENT_SCOPE_MISMATCH", "Agent projects are controlled by the server credential binding");
              }
              if (args.capabilities !== undefined && (
                capabilities.length !== binding.capabilities.length
                || capabilities.some((capability) => !binding.capabilities.includes(capability))
              )) {
                throw new ApiError(403, "AGENT_SCOPE_MISMATCH", "Agent capabilities are controlled by the server credential binding");
              }
            }
            const concurrency = Number(args.concurrency ?? 1);
            if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
              throw new ApiError(400, "INVALID_FIELD", "'concurrency' must be an integer between 1 and 16");
            }
            const agent = events.withTransaction(database, () => {
              const agent = database.upsertAgent({
                id: explicitId ?? username,
                name: stringField(args.name, "name", { required: true, maxLength: 120 }),
                device: binding?.device ?? (stringField(args.device ?? "", "device", { required: false, maxLength: 120 }) ?? ""),
                capabilities: binding?.capabilities ?? capabilities,
                projects: binding?.projects ?? projects,
                concurrency,
              });
              events.emit("agent.registered", { agent });
              return agent;
            });
            result = { agent };
          } else if (toolName === "dashi_agent_heartbeat") {
            const username = agentUsernameFromActor(actorFromRequest(request));
            if (!username) throw new ApiError(403, "AGENT_AUTH_REQUIRED", "Agent tools require agent authentication");
            const agent = database.heartbeatAgent(username);
            if (!agent) throw new ApiError(404, "AGENT_NOT_FOUND", `Agent '${username}' is not registered; call dashi_agent_register first`);
            result = { agent };
          } else if (toolName === "dashi_list_agents") {
            result = { agents: database.listAgents() };
          } else if (toolName === "dashi_agent_events") {
            const after = Number(args.after ?? 0);
            const limit = Number(args.limit ?? 100);
            if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
              throw new ApiError(400, "INVALID_FIELD", "Invalid agent event cursor or limit");
            }
            const username = agentUsernameFromActor(actorFromRequest(request));
            const registeredAgent = username ? database.getAgent(username) : null;
            const eventProjects = actorFromRequest(request)?.agentBinding?.projects
              ?? registeredAgent?.projects;
            // 未注册 agent 不得静默返回空列表并推进游标：那会永久吞掉派发。
            // 明确 404 让 worker 触发重注册自愈。
            if (username && username !== "workbuddy-agent" && !registeredAgent) {
              throw new ApiError(404, "AGENT_NOT_FOUND", `Agent '${username}' is not registered; call dashi_agent_register first`);
            }
            const allEvents = database.listIntegrationEvents("agents", after, limit);
            const eventsForAgent = username && username !== "workbuddy-agent"
              ? allEvents.filter((event) => (
                (
                  (!actorFromRequest(request)?.agentBinding && eventProjects?.length === 0)
                  || eventProjects?.includes(event.projectId)
                )
                && (
                  event.eventType !== "agent.dispatch"
                  || event.payload.anyAgent
                  || event.payload.targets?.some((target) => target.id === username)
                )
                && (
                  event.eventType !== "agent.review"
                  || event.payload.agentId === username
                )
              ))
              // 旧部署回退视角（workbuddy-agent）：桥接组件不需要治理事件，
              // 管理员批注（agent.review）不得泄露给半信任的桥。
              : allEvents.filter((event) => event.eventType !== "agent.review");
            result = {
              events: eventsForAgent,
              // 无新事件时返回服务端最大 sequence（而非回显 after）：
              // 客户端据此检测事件库重建（nextCursor < 本地游标 → 归零重放）。
              nextCursor: allEvents.at(-1)?.sequence
                ?? database.maxIntegrationSequence("agents")
                ?? 0,
            };
          } else if (toolName === "dashi_claim_task") {
            const username = agentUsernameFromActor(actorFromRequest(request));
            if (!username) throw new ApiError(403, "AGENT_AUTH_REQUIRED", "Agent tools require agent authentication");
            const taskId = stringField(args.taskId, "taskId", { required: true, maxLength: 128 });
            const leaseSeconds = boundedLeaseSeconds(args.leaseSeconds);
            const claimTarget = database.getTask(taskId);
            if (!claimTarget) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
            assertAgentProjectScope(database, actorFromRequest(request), claimTarget.projectId);
            const claim = events.withTransaction(database, () => {
              const claimed = database.claimTask(taskId, username, leaseSeconds);
              if (!claimed.replayed) {
                const agent = database.getAgent(username);
                const agentLabel = agent.device ? `${agent.name}·${agent.device}` : agent.name;
                agentSystemMessage(
                  database,
                  events,
                  claimed.task.projectId,
                  claimed.tookOver
                    ? `【接管】${agentLabel} 接管任务「${claimed.task.title}」（原执行者 ${claimed.previousAgentId} 租约已超时）`
                    : `【领取】${agentLabel} 领取任务「${claimed.task.title}」，租约至 ${claimed.lease.expiresAt}`,
                  taskId,
                );
                events.emit("task.claimed", { task: claimed.task, lease: claimed.lease, agentId: username });
                database.appendIntegrationEvent("workbuddy", {
                  type: "task.claimed",
                  projectId: claimed.task.projectId,
                  taskId,
                  agent: { id: username, name: agent.name, device: agent.device },
                  tookOver: claimed.tookOver,
                });
              }
              return claimed;
            });
            result = claim;
          } else if (toolName === "dashi_renew_task_lease") {
            const username = agentUsernameFromActor(actorFromRequest(request));
            if (!username) throw new ApiError(403, "AGENT_AUTH_REQUIRED", "Agent tools require agent authentication");
            const taskId = stringField(args.taskId, "taskId", { required: true, maxLength: 128 });
            const leaseSeconds = boundedLeaseSeconds(args.leaseSeconds);
            const renewTarget = database.getTask(taskId);
            if (!renewTarget) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
            assertAgentProjectScope(database, actorFromRequest(request), renewTarget.projectId);
            const lease = events.withTransaction(database, () => {
              const lease = database.renewTaskLease(taskId, username, leaseSeconds);
              events.emit("task.lease.renewed", { taskId, lease });
              return lease;
            });
            result = { lease };
          } else if (toolName === "dashi_release_task") {
            const username = agentUsernameFromActor(actorFromRequest(request));
            if (!username) throw new ApiError(403, "AGENT_AUTH_REQUIRED", "Agent tools require agent authentication");
            const taskId = stringField(args.taskId, "taskId", { required: true, maxLength: 128 });
            const reason = stringField(args.reason ?? "", "reason", { required: false, maxLength: 500 }) ?? "";
            const releaseTarget = database.getTask(taskId);
            if (!releaseTarget) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
            assertAgentProjectScope(database, actorFromRequest(request), releaseTarget.projectId);
            const task = events.withTransaction(database, () => {
              const released = database.releaseTask(taskId, username, { returnToStatus: "todo" });
              const agent = database.getAgent(username);
              if (released) {
                const agentLabel = agent ? (agent.device ? `${agent.name}·${agent.device}` : agent.name) : username;
                agentSystemMessage(
                  database,
                  events,
                  released.projectId,
                  `【释放】${agentLabel} 释放任务「${released.title}」${reason ? `：${reason}` : ""}，任务回到可领取状态`,
                  taskId,
                );
              }
              events.emit("task.released", { task: released, agentId: username });
              return released;
            });
            result = { task };
          } else {
            return sendJson(response, 200, {
              jsonrpc: "2.0",
              id,
              result: workBuddyToolResult(`Unknown tool '${toolName}'`, true),
            });
          }
          return sendJson(response, 200, { jsonrpc: "2.0", id, result: workBuddyToolResult(result) });
        }
        return sendJson(response, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        });
      }

      if (pathname === "/api/agents") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/agents");
        return sendJson(response, 200, { agents: database.listAgents() });
      }

      const projectAgentsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/agents$/);
      if (projectAgentsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET project agents");
        let projectId;
        try {
          projectId = decodeURIComponent(projectAgentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        assertProjectAccess(request, database, projectId);
        return sendJson(response, 200, { agents: database.listProjectAgents(projectId) });
      }

      if (pathname === "/api/devices") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/devices");
        return sendJson(response, 200, { devices: database.listDevices() });
      }

      if (pathname === "/api/devices/refresh") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/devices/refresh");
        await assertEmptyRequestBody(request, "POST /api/devices/refresh");
        return sendJson(response, 200, { devices: await deviceProjectSync.refreshAll() });
      }

      if (pathname === "/api/local/cloud-session") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Cloud session routes do not accept query parameters");
        }
        if (request.method === "GET") {
          const config = await cloudConfig.read();
          return sendJson(response, 200, config.remoteUrl
            ? {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            }
            : { mode: "local", authenticated: false });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["remoteUrl", "actorName", "sharedKey"]));
          try {
            const config = await cloudConfig.configure({
              remoteUrl: body.remoteUrl,
              actorName: body.actorName,
              sharedKey: body.sharedKey,
            });
            return sendJson(response, 200, {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            });
          } catch (error) {
            throw new ApiError(400, error.code ?? "INVALID_CLOUD_CONFIG", error.message);
          }
        }
        if (request.method === "DELETE") {
          await cloudConfig.clearCloud();
          return sendJson(response, 200, { mode: "local", authenticated: false });
        }
        return methodNotAllowed(response, ["GET", "PUT", "DELETE"]);
      }

      const projectMappingRoute = pathname.match(/^\/api\/local\/project-mappings\/([^/]+)$/);
      if (projectMappingRoute) {
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project mapping routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectMappingRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["workspacePath"]));
        const workspacePath = pathField(body.workspacePath, "workspacePath");
        if (!workspacePath || !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        await cloudConfig.setProjectWorkspace(projectId, workspacePath);
        return sendJson(response, 200, { projectId, workspacePath });
      }

      if (pathname === "/api/meta") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/meta does not accept query parameters");
        }
        return sendJson(response, 200, {
          manageTaskboardSkillPath: resolved.skillPath,
          capabilities: { localAiChat: isLoopbackAddress(request.socket.remoteAddress) },
          ...(capabilityCloudConfig?.remoteUrl
            ? {
              mode: "cloud",
              realtime: { transport: "poll", intervalMs: 2000 },
              localCapabilities: { available: true },
            }
            : {}),
        });
      }

      if (pathname === "/api/local/ai/catalog") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set(["projectId"]), "GET /api/local/ai/catalog");
        const projectId = validateProjectId(url.searchParams.get("projectId") ?? undefined);
        return sendJson(response, 200, await aiChat.getCatalog(projectId));
      }

      if (pathname === "/api/local/ai/threads") {
        assertNoQuery(url.searchParams, "/api/local/ai/threads");
        if (request.method === "GET") {
          return sendJson(response, 200, { threads: await aiChat.listThreads() });
        }
        if (request.method === "POST") {
          const thread = await aiChat.createThread(parseAiThreadCreate(await readJson(request)));
          return sendJson(response, 201, { thread });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const aiThreadEventsRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/events$/);
      if (aiThreadEventsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/ai/threads/:id/events");
        const threadId = decodeRouteSegment(aiThreadEventsRoute[1], "Thread id");
        await aiChat.getThreadSnapshot(threadId);
        response.writeHead(200, {
          connection: "keep-alive",
          "cache-control": "no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        });
        aiEventResponses.add(response);
        const unsubscribe = aiChat.subscribe(threadId, (event) => {
          const type = event?.type === "ai.run" ? "ai.run" : "ai.event";
          response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        response.write(": connected\n\n");
        response.write('event: ai.event\ndata: {"type":"ai.event"}\n\n');
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
        keepAlive.unref();
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
          aiEventResponses.delete(response);
        });
        return;
      }

      const aiThreadTurnRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/turns$/);
      if (aiThreadTurnRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/turns");
        const threadId = decodeRouteSegment(aiThreadTurnRoute[1], "Thread id");
        const run = await aiChat.startTurn(
          threadId,
          parseAiTurn(await readJson(
            request,
            AI_CHAT_TURN_BODY_LIMIT,
            "AI chat turn body cannot exceed 25 MiB",
          )),
        );
        return sendJson(response, 202, { run });
      }

      const aiThreadRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)$/);
      if (aiThreadRoute) {
        assertNoQuery(url.searchParams, "/api/local/ai/threads/:id");
        const threadId = decodeRouteSegment(aiThreadRoute[1], "Thread id");
        if (request.method === "GET") {
          return sendJson(response, 200, await aiChat.getThreadSnapshot(threadId));
        }
        if (request.method === "PATCH") {
          const thread = await aiChat.updateThread(threadId, parseAiThreadPatch(await readJson(request)));
          return sendJson(response, 200, { thread });
        }
        if (request.method === "DELETE") {
          await assertEmptyRequestBody(request, "DELETE /api/local/ai/threads/:id");
          await aiChat.deleteThread(threadId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
      }

      const aiInterruptRoute = pathname.match(/^\/api\/local\/ai\/runs\/([^/]+)\/interrupt$/);
      if (aiInterruptRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/runs/:id/interrupt");
        const runId = decodeRouteSegment(aiInterruptRoute[1], "Run id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/runs/:id/interrupt");
        const run = await aiChat.interrupt(runId);
        return sendJson(response, 200, { run });
      }

      if (pathname === "/api/device-workspaces") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/device-workspaces does not accept query parameters");
        }
        return sendJson(response, 200, {
          workspaces: await readCodexProjectWorkspaces(resolved.codexStatePath),
        });
      }

      if (pathname === "/api/workflow-capabilities") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => key !== "workspacePath");
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        const workspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (workspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        if (workspacePath && !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        return sendJson(
          response,
          200,
          await discoverWorkflowCapabilities(resolved, workspacePath ?? PROJECT_ROOT),
        );
      }

      let currentCloudConfig = null;
      if (pathname.startsWith("/api/")) {
        currentCloudConfig = await cloudConfig.read();
        if (currentCloudConfig.remoteUrl) {
          assertLoopbackRequest(request);
          if (!isLocalCompanionRoute(pathname)) {
            return sendFetchResponse(
              response,
              await cloudProxy.forward(toFetchRequest(request, `${pathname}${url.search}`)),
            );
          }
        }
      }

      if (request.taskboardRole !== "admin") {
        const projectScoped = pathname.match(/^\/api\/projects\/([^/]+)(?:\/|$)/);
        if (projectScoped) {
          assertProjectAccess(request, database, decodeURIComponent(projectScoped[1]));
        }
        const taskScoped = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/|$)/);
        if (taskScoped) {
          const task = database.getTask(decodeURIComponent(taskScoped[1]));
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task does not exist");
          assertProjectAccess(request, database, task.projectId);
        }
        const commentScoped = pathname.match(/^\/api\/comments\/([^/]+)(?:\/|$)/);
        if (commentScoped) {
          const comment = database.getComment(decodeURIComponent(commentScoped[1]));
          if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", "Comment does not exist");
          const task = database.getTask(comment.taskId);
          assertProjectAccess(request, database, task.projectId);
        }
        const attachmentScoped = pathname.match(/^\/api\/attachments\/([^/]+)(?:\/|$)/);
        if (attachmentScoped) {
          const attachment = database.getAttachment(decodeURIComponent(attachmentScoped[1]));
          if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Attachment does not exist");
          const task = database.getTask(attachment.taskId);
          assertProjectAccess(request, database, task.projectId);
        }
      }

      if (pathname === "/api/projects") {
        if (request.method === "GET") {
          const { hidden } = parseProjectFilters(url.searchParams);
          const projects = database.listProjects(hidden).filter((project) => (
            canAccessProject(request, database, project.id)
          ));
          return sendJson(response, 200, { projects });
        }
        if (request.method === "POST") {
          assertAdmin(request);
          const body = parseProjectCreate(await readJson(request));
          const project = events.withTransaction(database, () => {
            const project = database.createProject({
              ...body,
              actor: actorFromRequest(request),
            });
            events.emit("project.created", { project });
            return project;
          });
          return sendJson(response, 201, { project });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectMembersRoute = pathname.match(/^\/api\/projects\/([^/]+)\/members(?:\/([^/]+))?$/);
      if (projectMembersRoute) {
        let projectId;
        let userId = null;
        try {
          projectId = decodeURIComponent(projectMembersRoute[1]);
          userId = projectMembersRoute[2] ? decodeURIComponent(projectMembersRoute[2]) : null;
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project member path contains invalid encoding");
        }
        validateProjectId(projectId);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project member routes do not accept query parameters");
        }
        if (!userId && request.method === "GET") {
          return sendJson(response, 200, { members: database.listProjectMembers(projectId) });
        }
        assertProjectAdmin(request, database, projectId);
        if (!userId && request.method === "POST") {
          const body = parseProjectMember(await readJson(request));
          const member = events.withTransaction(database, () => {
            const member = database.upsertProjectMember(projectId, body);
            events.emit("project.member.updated", { projectId, member });
            return member;
          });
          return sendJson(response, 200, { member });
        }
        if (userId && request.method === "DELETE") {
          const member = events.withTransaction(database, () => {
            const member = database.removeProjectMember(projectId, userId);
            events.emit("project.member.removed", { projectId, member });
            return member;
          });
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, userId ? ["DELETE"] : ["GET", "POST"]);
      }

      const projectMessagesRoute = pathname.match(/^\/api\/projects\/([^/]+)\/messages$/);
      if (projectMessagesRoute) {
        let projectId;
        try {
          projectId = decodeURIComponent(projectMessagesRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project message path contains invalid encoding");
        }
        validateProjectId(projectId);
        assertProjectAccess(request, database, projectId);
        if (request.method === "GET") {
          assertAllowedQuery(url.searchParams, new Set(["after", "limit"]), "GET project messages");
          const after = Number(url.searchParams.get("after") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "100");
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
            throw new ApiError(400, "INVALID_QUERY", "'after' and 'limit' must be bounded integers");
          }
          const messages = database.listProjectMessages(projectId, after, limit);
          return sendJson(response, 200, {
            messages,
            nextCursor: messages.at(-1)?.sequence ?? after,
          });
        }
        if (request.method === "POST") {
          assertNoQuery(url.searchParams, "POST project message");
          const input = parseProjectMessage(await readJson(request));
          const message = events.withTransaction(database, () => {
            const created = database.createProjectMessage(projectId, {
              ...input,
              actor: resolveAgentAuthor(database, actorFromRequest(request)),
            });
            events.emit("project.message.created", { projectId, message: created });
            dispatchAgentMentions(database, events, projectId, created);
            return created;
          });
          return sendJson(response, 201, { message });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectVisibilityRoute = pathname.match(/^\/api\/projects\/([^/]+)\/(hide|restore)$/);
      if (projectVisibilityRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project visibility routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectVisibilityRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const { version } = parseArchive(await readJson(request));
        const project = events.withTransaction(database, () => {
          const project = projectVisibilityRoute[2] === "hide"
            ? database.hideProject(projectId, version)
            : database.restoreProject(projectId, version);
          events.emit(projectVisibilityRoute[2] === "hide" ? "project.hidden" : "project.restored", { project });
          return project;
        });
        return sendJson(response, 200, { project });
      }

      const workflowWorkspaceRoute = pathname.match(/^\/api\/projects\/([^/]+)\/workflow-workspace$/);
      if (workflowWorkspaceRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Workflow workspace routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(workflowWorkspaceRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { workflow: database.getWorkflowWorkspace(projectId) });
        }
        if (request.method === "PUT") {
          const input = parseWorkflowWorkspaceSave(await readJson(request));
          const workflow = events.withTransaction(database, () => {
            const workflow = database.saveWorkflowWorkspace(projectId, input.version, input.workspace);
            events.emit("workflow.updated", {
              projectId,
              workflowVersion: workflow.version,
            });
            return workflow;
          });
          return sendJson(response, 200, { workflow });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const developmentContextsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/development-contexts$/);
      if (developmentContextsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => (
          !["codexProjectId", "codexThreadId", "workspacePath"].includes(key)
        ));
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        let projectId;
        try {
          projectId = decodeURIComponent(developmentContextsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const project = currentCloudConfig.remoteUrl
          ? {
            id: projectId,
            workspacePath: currentCloudConfig.projectMappings[projectId] ?? null,
          }
          : database.getProject(projectId);
        if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        const codexProjectId = stringField(url.searchParams.get("codexProjectId") ?? null, "codexProjectId", {
          nullable: true,
          maxLength: 128,
        });
        const codexThreadId = stringField(url.searchParams.get("codexThreadId") ?? null, "codexThreadId", {
          nullable: true,
          maxLength: 256,
        });
        const deviceWorkspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (deviceWorkspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        const workspacePath = deviceWorkspacePath ?? await resolveProjectWorkspace(
          project,
          codexProjectId,
          codexThreadId,
          resolved.codexStatePath,
          resolved.codexProcessesPath,
        );
        return sendJson(response, 200, await scanDevelopmentContexts(workspacePath));
      }

      if (pathname === "/api/tasks") {
        if (request.method === "GET") {
          const filters = parseTaskFilters(url.searchParams);
          if (filters.projectId) assertProjectAccess(request, database, filters.projectId);
          const tasks = database.listTasks(filters).filter((task) => (
            canAccessProject(request, database, task.projectId)
          ));
          return sendJson(response, 200, { tasks });
        }
        if (request.method === "POST") {
          const actor = actorFromRequest(request);
          const { assigneeTarget, ...input } = parseTaskCreate(await readJson(request));
          assertProjectAccess(request, database, input.projectId);
          if (input.status === "done") assertProjectAdmin(request, database, input.projectId);
          const task = events.withTransaction(database, () => {
            const task = database.createTask({
              ...input,
              actor,
              assignee: resolveAssignee(assigneeTarget, actor),
            });
            events.emit("task.created", { task });
            return task;
          });
          return sendJson(response, 201, { task });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/events does not accept query parameters");
        }
        events.connect(request, response, (event) => (
          request.taskboardRole === "admin"
          || Boolean(event.projectId && canAccessProject(request, database, event.projectId))
        ));
        return;
      }

      const taskRelationRoute = pathname.match(
        /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
      );
      if (taskRelationRoute) {
        let taskId;
        let type;
        let relatedTaskId;
        try {
          taskId = decodeURIComponent(taskRelationRoute[1]);
          type = decodeURIComponent(taskRelationRoute[2]);
          relatedTaskId = decodeURIComponent(taskRelationRoute[3]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Issue relation path contains invalid encoding");
        }
        if (
          taskId.length === 0
          || taskId.length > 128
          || relatedTaskId.length === 0
          || relatedTaskId.length > 128
        ) {
          throw new ApiError(400, "INVALID_PATH", "Issue relation task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Issue relation routes do not accept query parameters");
        }
        const relationType = parseIssueRelationType(type);
        if (request.method === "POST") {
          const { version, threadId } = parseArchive(await readJson(request));
          const result = events.withTransaction(database, () => {
            const result = database.addTaskRelation(
              taskId,
              version,
              relationType,
              relatedTaskId,
              threadId,
            );
            events.emit("task.relation.updated", result);
            return result;
          });
          return sendJson(response, 200, result);
        }
        if (request.method === "DELETE") {
          const { version, threadId } = parseArchive(await readJson(request));
          const result = events.withTransaction(database, () => {
            const result = database.removeTaskRelation(
              taskId,
              version,
              relationType,
              relatedTaskId,
              threadId,
            );
            events.emit("task.relation.updated", result);
            return result;
          });
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, ["POST", "DELETE"]);
      }

      const taskCommentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskCommentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { comments: database.listComments(taskId) });
        }
        if (request.method === "POST") {
          const input = parseCommentCreate(await readJson(request));
          const comment = events.withTransaction(database, () => {
            const created = database.createComment(taskId, {
              ...input,
              actor: actorFromRequest(request),
            });
            const task = database.getTask(taskId);
            events.emit("comment.created", { comment: created, task });
            dispatchCommentMentions(database, events, task, created);
            return created;
          });
          return sendJson(response, 201, { comment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const commentRoute = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentRoute) {
        let id;
        try {
          id = decodeURIComponent(commentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "PATCH") {
          const patch = parseCommentPatch(await readJson(request));
          const comment = events.withTransaction(database, () => {
            const comment = database.updateComment(id, patch.version, patch.body, patch.threadId);
            const task = database.getTask(comment.taskId);
            events.emit("comment.updated", { comment, task });
            return comment;
          });
          return sendJson(response, 200, { comment });
        }
        if (request.method === "DELETE") {
          const { version } = parseArchive(await readJson(request));
          const comment = events.withTransaction(database, () => {
            const comment = database.deleteComment(id, version);
            const task = database.getTask(comment.taskId);
            events.emit("comment.deleted", { comment, task });
            return comment;
          });
          for (const attachment of comment.attachments) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["PATCH", "DELETE"]);
      }

      const commentAttachmentsRoute = pathname.match(/^\/api\/comments\/([^/]+)\/attachments$/);
      if (commentAttachmentsRoute) {
        let commentId;
        try {
          commentId = decodeURIComponent(commentAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (commentId.length === 0 || commentId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listCommentAttachments(commentId) });
        }
        if (request.method === "POST") {
          const comment = database.getComment(commentId);
          if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = events.withTransaction(database, () => {
              const attachment = database.createCommentAttachment(commentId, { id, ...metadata, size: body.length });
              const task = database.getTask(comment.taskId);
              events.emit("attachment.created", { attachment, comment: database.getComment(commentId), task });
              return attachment;
            });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskAttachmentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
      if (taskAttachmentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listAttachments(taskId) });
        }
        if (request.method === "POST") {
          const task = database.getTask(taskId);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = events.withTransaction(database, () => {
              const attachment = database.createAttachment(taskId, { id, ...metadata, size: body.length });
              events.emit("attachment.created", { attachment, task });
              return attachment;
            });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const attachmentContentRoute = pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
      if (attachmentContentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentContentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(response, ["GET", "HEAD"]);
        }
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        const body = await readFile(path.join(resolved.attachmentsDirectory, attachment.id));
        const encodedFilename = encodeURIComponent(attachment.filename).replace(/['()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        const canOpenInline = INLINE_ATTACHMENT_TYPES.has(attachment.contentType);
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `${canOpenInline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename}`,
          "content-length": body.length,
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": canOpenInline ? attachment.contentType : "application/octet-stream",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      const attachmentRoute = pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (attachmentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        events.withTransaction(database, () => {
          database.deleteAttachment(id);
          const task = database.getTask(attachment.taskId);
          events.emit("attachment.deleted", { attachment, task });
        });
        try {
          await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        return sendEmpty(response, 204);
      }

      const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move|review))?$/);
      if (taskRoute) {
        let id;
        try {
          id = decodeURIComponent(taskRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        const action = taskRoute[2];
        if (!action && request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/tasks/:id does not accept query parameters");
          }
          const task = database.getTask(id);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          return sendJson(response, 200, { task });
        }
        if (!action && request.method === "PATCH") {
          const { version, changes, threadId, assigneeTarget } = parseTaskPatch(await readJson(request));
          const currentTask = database.getTask(id);
          if (!currentTask) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          if (changes.status === "done") assertProjectAdmin(request, database, currentTask.projectId);
          if (assigneeTarget !== undefined) {
            changes.assignee = resolveAssignee(assigneeTarget, actorFromRequest(request));
          }
          const task = events.withTransaction(database, () => {
            const task = database.updateTask(id, version, changes, threadId);
            events.emit("task.updated", { task });
            return task;
          });
          return sendJson(response, 200, { task });
        }
        if (action === "move" && request.method === "POST") {
          const move = parseMove(await readJson(request));
          const currentTask = database.getTask(id);
          if (!currentTask) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          if (move.status === "done") assertProjectAdmin(request, database, currentTask.projectId);
          const task = events.withTransaction(database, () => {
            const task = database.moveTask(id, move.version, move.status, move.sortOrder, move.threadId);
            events.emit("task.moved", { task });
            return task;
          });
          return sendJson(response, 200, { task });
        }
        if (action === "review" && request.method === "POST") {
          const reviewTarget = database.getTask(id);
          if (!reviewTarget) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          assertProjectAdmin(request, database, reviewTarget.projectId);
          const body = await readJson(request);
          const version = parseVersion(body.version);
          const decision = body.decision === "approve" ? "approved"
            : body.decision === "request_changes" ? "changes_requested"
              : null;
          if (!decision) {
            throw new ApiError(400, "INVALID_FIELD", "'decision' must be approve or request_changes");
          }
          const note = body.note === undefined || body.note === null || body.note === ""
            ? null
            : stringField(body.note, "note", { required: true, maxLength: 4000 });
          const task = events.withTransaction(database, () => {
            const reviewed = database.reviewTask(id, version, decision, note, actorFromRequest(request));
            events.emit("task.reviewed", { task: reviewed, review: reviewed.latestReview });
            // 授权闭环：审批结果回传指派 agent，让它据此判断下一步（驳回→修改重提）。
            if (reviewed.assignee?.type === "agent") {
              database.appendIntegrationEvent("agents", {
                type: "agent.review",
                projectId: reviewed.projectId,
                taskId: reviewed.id,
                decision,
                note,
                agentId: reviewed.assignee.id,
                taskTitle: reviewed.title,
                at: reviewed.updatedAt,
              });
            }
            return reviewed;
          });
          return sendJson(response, 200, { task });
        }
        if (action === "archive" && request.method === "POST") {
          const { version, threadId } = parseArchive(await readJson(request));
          const task = events.withTransaction(database, () => {
            const task = database.archiveTask(id, version, threadId);
            events.emit("task.archived", { task });
            return task;
          });
          return sendJson(response, 200, { task });
        }
        if (action === "restore" && request.method === "POST") {
          const { version, threadId } = parseArchive(await readJson(request));
          const task = events.withTransaction(database, () => {
            const task = database.restoreTask(id, version, threadId);
            events.emit("task.restored", { task });
            return task;
          });
          return sendJson(response, 200, { task });
        }
        return methodNotAllowed(response, action ? ["POST"] : ["GET", "PATCH"]);
      }

      if (pathname.startsWith("/api/")) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      if (await serveStatic(request, response, pathname, resolved.staticDirectory)) return;
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      if (error instanceof CloudProxyError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
  });

  let listening = false;
  return {
    database,
    aiChat,
    server,
    options: resolved,
    async listen({ host = "127.0.0.1", port = resolvePort() } = {}) {
      if (host !== "127.0.0.1" && host !== "0.0.0.0") {
        throw new Error("Taskboard server must bind to 127.0.0.1 or 0.0.0.0");
      }
      await deviceProjectSync.refreshAll();
      deviceProjectSync.start();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      listening = true;
      return server.address();
    },
    async close() {
      const serverClosed = listening
        ? new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          })
        : Promise.resolve();
      events.close();
      deviceProjectSync.close();
      for (const response of aiEventResponses) response.end();
      aiEventResponses.clear();
      await aiChat.close();
      await wecomAuth.close();
      await serverClosed;
      listening = false;
      database.close();
    },
  };
}
