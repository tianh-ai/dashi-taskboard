// 权限矩阵回归测试（TODO 四）：治理操作（审批/直接 done/成员管理）必须
// 仅由真实人类 project admin 或全局管理员执行；Agent、Bridge、member、
// manager 一律 403。Agent 只能领取/读取其注册 projects 范围内的任务。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const SERVICE_SECRET = "test-service-secret";
const COMPANION_SECRET = "test-companion-secret";
const ADMIN_ID = "TianJiYuan";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-perm-matrix-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    wecom: {
      serviceSecret: SERVICE_SECRET,
      companionSecret: COMPANION_SECRET,
      adminUserIds: ADMIN_ID,
    },
  });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

function basic(username, secret) {
  return `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
}

function actingHeaders(userId, name = userId) {
  return {
    authorization: basic("mini-companion", COMPANION_SECRET),
    "x-taskboard-client": "cloud-companion",
    "x-taskboard-acting-user-id": userId,
    "x-taskboard-acting-user-name": encodeURIComponent(name),
  };
}

async function mcp(baseUrl, username, secret, clientTag, name, args) {
  const response = await fetch(new URL("mcp/workbuddy", `${baseUrl}/`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: basic(username, secret),
      "x-taskboard-client": clientTag,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const message = JSON.parse(await response.text());
  if (message?.error) {
    const error = new Error(message.error.message ?? "mcp error");
    error.code = message.error.code ?? message.error.data?.code;
    throw error;
  }
  const parsed = JSON.parse(message.result.content[0].text);
  if (parsed?.error) {
    const error = new Error(parsed.error.message ?? "tool error");
    error.code = parsed.error.code;
    throw error;
  }
  return parsed;
}

async function rest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: response.status === 204 ? undefined : await response.json().catch(() => undefined) };
}

async function setupProject(baseUrl) {
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "matrix", name: "权限矩阵" } });
  for (const [userId, role] of [
    ["member-user", "member"],
    ["manager-user", "manager"],
    ["proj-admin", "admin"],
  ]) {
    const added = await rest(baseUrl, "/api/projects/matrix/members", {
      method: "POST",
      body: { userId, userName: userId, role },
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));
  }
}

/** 走完整 Agent 链路把任务推进到 in_review，返回任务 id。 */
async function stageTaskInReview(baseUrl) {
  await mcp(baseUrl, "worker-x", SERVICE_SECRET, "task-worker", "dashi_agent_register", { name: "Worker", device: "Test" });
  const created = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "matrix", title: "矩阵验证任务", status: "todo" },
  });
  const taskId = created.body.task.id;
  await mcp(baseUrl, "worker-x", SERVICE_SECRET, "task-worker", "dashi_claim_task", { taskId, leaseSeconds: 600 });
  const task = await mcp(baseUrl, "worker-x", SERVICE_SECRET, "task-worker", "dashi_get_task", { taskId });
  await mcp(baseUrl, "worker-x", SERVICE_SECRET, "task-worker", "dashi_submit_for_review", { taskId, version: task.task.version });
  return taskId;
}

function reviewRequest(baseUrl, taskId, version, headers) {
  return rest(baseUrl, `/api/tasks/${taskId}/review`, {
    method: "POST",
    headers,
    body: { version, decision: "approve" },
  });
}

test("审批权限矩阵：Agent/Bridge/member/manager 403，project admin 200", async () => {
  const baseUrl = await startServer();
  await setupProject(baseUrl);
  const taskId = await stageTaskInReview(baseUrl);

  for (const [label, headers] of [
    ["Agent", { authorization: basic("worker-x", SERVICE_SECRET), "x-taskboard-client": "task-worker" }],
    ["Bridge", { authorization: basic("workbuddy-agent", SERVICE_SECRET), "x-taskboard-client": "workbuddy-bridge" }],
    ["member", actingHeaders("member-user")],
    ["manager", actingHeaders("manager-user")],
    ["非成员用户", actingHeaders("outsider-user")],
  ]) {
    const current = await rest(baseUrl, `/api/tasks/${taskId}`);
    const attempt = await reviewRequest(baseUrl, taskId, current.body.task.version, headers);
    assert.equal(attempt.status, 403, `${label} 审批必须 403，实际 ${attempt.status}`);
    assert.ok(
      ["PROJECT_ADMIN_REQUIRED", "PROJECT_ACCESS_DENIED"].includes(attempt.body.error.code),
      `意外的错误码 ${attempt.body.error.code}`,
    );
  }

  const current = await rest(baseUrl, `/api/tasks/${taskId}`);
  const approved = await reviewRequest(baseUrl, taskId, current.body.task.version, actingHeaders("proj-admin", "项目负责人"));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.task.status, "done");
});

test("直接标记 done 同样受 project admin 门禁", async () => {
  const baseUrl = await startServer();
  await setupProject(baseUrl);
  await mcp(baseUrl, "worker-y", SERVICE_SECRET, "task-worker", "dashi_agent_register", { name: "Worker", device: "Test" });
  const created = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "matrix", title: "done 门禁任务", status: "todo" },
  });
  const taskId = created.body.task.id;

  for (const [label, headers] of [
    ["Agent", { authorization: basic("worker-y", SERVICE_SECRET), "x-taskboard-client": "task-worker" }],
    ["member", actingHeaders("member-user")],
    ["manager", actingHeaders("manager-user")],
  ]) {
    const current = await rest(baseUrl, `/api/tasks/${taskId}`);
    const attempt = await rest(baseUrl, `/api/tasks/${taskId}/move`, {
      method: "POST",
      headers,
      body: { version: current.body.task.version, status: "done" },
    });
    assert.equal(attempt.status, 403, `${label} 直接 done 必须 403`);
  }

  const current = await rest(baseUrl, `/api/tasks/${taskId}`);
  const done = await rest(baseUrl, `/api/tasks/${taskId}/move`, {
    method: "POST",
    headers: actingHeaders("proj-admin"),
    body: { version: current.body.task.version, status: "done" },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.task.status, "done");
});

test("成员管理仅 project admin 可用：member/manager/Agent 403", async () => {
  const baseUrl = await startServer();
  await setupProject(baseUrl);
  const payload = { userId: "new-user", userName: "新成员", role: "member" };
  for (const [label, headers] of [
    ["Agent", { authorization: basic("worker-z", SERVICE_SECRET), "x-taskboard-client": "task-worker" }],
    ["member", actingHeaders("member-user")],
    ["manager", actingHeaders("manager-user")],
  ]) {
    const attempt = await rest(baseUrl, "/api/projects/matrix/members", { method: "POST", headers, body: payload });
    assert.equal(attempt.status, 403, `${label} 管理成员必须 403`);
  }
  const ok = await rest(baseUrl, "/api/projects/matrix/members", {
    method: "POST",
    headers: actingHeaders("proj-admin"),
    body: payload,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.member.role, "member");
});

test("Bridge 代非成员发言必须 403；代成员发言成功且可触发派发", async () => {
  const baseUrl = await startServer();
  await setupProject(baseUrl);
  await assert.rejects(
    mcp(baseUrl, "workbuddy-agent", SERVICE_SECRET, "workbuddy-bridge", "dashi_post_project_message", {
      projectId: "matrix",
      body: "冒名消息",
      mentions: [],
      authorUserId: "outsider-user",
      authorName: "外人",
    }),
    (error) => error.code === "PROJECT_ACCESS_DENIED",
    "非成员冒名发言必须 403",
  );
  const posted = await mcp(baseUrl, "workbuddy-agent", SERVICE_SECRET, "workbuddy-bridge", "dashi_post_project_message", {
    projectId: "matrix",
    body: "成员正常发言",
    mentions: [],
    authorUserId: "member-user",
    authorName: "成员",
  });
  assert.equal(posted.message.author.id, "member-user");
});

test("Agent 越权读取/领取未授权项目任务返回 403；授权范围内正常", async () => {
  const baseUrl = await startServer();
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "scope-a", name: "授权项目" } });
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "scope-b", name: "越权项目" } });
  // scoped-worker 只授权 scope-a
  await mcp(baseUrl, "scoped-worker", SERVICE_SECRET, "task-worker", "dashi_agent_register", {
    name: "Scoped", device: "Test", projects: ["scope-a"],
  });
  const created = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "scope-b", title: "越权任务", status: "todo" },
  });
  const taskId = created.body.task.id;
  await assert.rejects(
    mcp(baseUrl, "scoped-worker", SERVICE_SECRET, "task-worker", "dashi_get_task", { taskId }),
    (error) => error.code === "PROJECT_ACCESS_DENIED",
    "越权读取必须 403",
  );
  await assert.rejects(
    mcp(baseUrl, "scoped-worker", SERVICE_SECRET, "task-worker", "dashi_claim_task", { taskId, leaseSeconds: 600 }),
    (error) => error.code === "PROJECT_ACCESS_DENIED",
    "越权领取必须 403",
  );
  // 未领取的任务状态不变
  const untouched = await rest(baseUrl, `/api/tasks/${taskId}`);
  assert.equal(untouched.body.task.status, "todo");

  // 授权范围内正常领取
  const allowed = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "scope-a", title: "授权任务", status: "todo" },
  });
  const claim = await mcp(baseUrl, "scoped-worker", SERVICE_SECRET, "task-worker", "dashi_claim_task", {
    taskId: allowed.body.task.id, leaseSeconds: 600,
  });
  assert.equal(claim.task.assignee.id, "scoped-worker");
});

test("projects 为空的 Agent 仍服务所有项目（常驻 Worker 默认语义不变）", async () => {
  const baseUrl = await startServer();
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "open-scope", name: "全项目" } });
  await mcp(baseUrl, "open-worker", SERVICE_SECRET, "task-worker", "dashi_agent_register", { name: "Open", device: "Test" });
  const created = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "open-scope", title: "全范围任务", status: "todo" },
  });
  const claim = await mcp(baseUrl, "open-worker", SERVICE_SECRET, "task-worker", "dashi_claim_task", {
    taskId: created.body.task.id, leaseSeconds: 600,
  });
  assert.equal(claim.task.assignee.id, "open-worker");
});
