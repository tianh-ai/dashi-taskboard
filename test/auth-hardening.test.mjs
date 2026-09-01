// 对抗性回归测试：守护 2026-08-30 红队审计修复的四个身份伪造链路。
// 任何一条被改回旧行为都意味着 critical 治理旁路重新打开。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const SERVICE_SECRET = "test-service-secret";
const COMPANION_SECRET = "test-companion-secret";
const BRIDGE_SECRET = "test-bridge-secret";
const ADMIN_ID = "TianJiYuan";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(wecom) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-auth-hardening-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    wecom: { serviceSecret: SERVICE_SECRET, ...wecom },
  });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

function basic(username, secret) {
  return `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
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
      ...(options.body !== undefined && typeof options.body !== "string" ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined
      ? undefined
      : (typeof options.body === "string" ? options.body : JSON.stringify(options.body)),
  });
  return { status: response.status, body: response.status === 204 ? undefined : await response.json().catch(() => undefined) };
}

/** 走完整 Agent 链路把一个任务推进到 in_review，返回任务 id。 */
async function stageTaskInReview(baseUrl) {
  await mcp(baseUrl, "worker-x", SERVICE_SECRET, "task-worker", "dashi_agent_register", { name: "Worker", device: "Test" });
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "hardening", name: "加固" } });
  await rest(baseUrl, "/api/projects/hardening/members", {
    method: "POST",
    body: { userId: ADMIN_ID, userName: "管理员", role: "manager" },
  });
  const created = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "hardening", title: "加固验证任务", status: "todo" },
  });
  const taskId = created.body.task.id;
  await mcp(baseUrl, "worker-x", SERVICE_SECRET, "task-worker", "dashi_claim_task", { taskId, leaseSeconds: 600 });
  const task = await mcp(baseUrl, "worker-x", SERVICE_SECRET, "task-worker", "dashi_get_task", { taskId });
  await mcp(baseUrl, "worker-x", SERVICE_SECRET, "task-worker", "dashi_submit_for_review", { taskId, version: task.task.version });
  return taskId;
}

test("共享 serviceSecret 的 Agent 用 cloud-companion 头冒充管理员：必须失败", async () => {
  const baseUrl = await startServer({ companionSecret: COMPANION_SECRET, adminUserIds: ADMIN_ID });
  const taskId = await stageTaskInReview(baseUrl);
  const before = await rest(baseUrl, `/api/tasks/${taskId}`);

  const attack = await rest(baseUrl, `/api/tasks/${taskId}/review`, {
    method: "POST",
    headers: {
      authorization: basic("any-agent", SERVICE_SECRET),
      "x-taskboard-client": "cloud-companion",
      "x-taskboard-acting-user-id": ADMIN_ID,
      "x-taskboard-acting-user-name": encodeURIComponent("田纪元"),
    },
    body: { version: before.body.task.version, decision: "approve" },
  });
  assert.equal(attack.status, 403, "serviceSecret + acting 头不得获得管理员身份");
  const untouched = await rest(baseUrl, `/api/tasks/${taskId}`);
  assert.equal(untouched.body.task.status, "in_review");

  // 真正的 companion 密钥 + acting 头仍然可用（companion 架构不被破坏）
  const legitimate = await rest(baseUrl, `/api/tasks/${taskId}/review`, {
    method: "POST",
    headers: {
      authorization: basic("mini-companion", COMPANION_SECRET),
      "x-taskboard-client": "cloud-companion",
      "x-taskboard-acting-user-id": ADMIN_ID,
      "x-taskboard-acting-user-name": encodeURIComponent("田纪元"),
    },
    body: { version: untouched.body.task.version, decision: "approve" },
  });
  assert.equal(legitimate.status, 200, JSON.stringify(legitimate.body));
  assert.equal(legitimate.body.task.status, "done");
});

test("未配置 companionSecret 时 acting 头完全不被信任", async () => {
  const baseUrl = await startServer();
  const taskId = await stageTaskInReview(baseUrl);
  const before = await rest(baseUrl, `/api/tasks/${taskId}`);
  const attack = await rest(baseUrl, `/api/tasks/${taskId}/review`, {
    method: "POST",
    headers: {
      authorization: basic("any-agent", SERVICE_SECRET),
      "x-taskboard-client": "cloud-companion",
      "x-taskboard-acting-user-id": ADMIN_ID,
      "x-taskboard-acting-user-name": encodeURIComponent("田纪元"),
    },
    body: { version: before.body.task.version, decision: "approve" },
  });
  assert.equal(attack.status, 403);
});

test("带代理头的请求不得访问 loopback 专属路由（同机 nginx 公网穿透防护）", async () => {
  const baseUrl = await startServer();
  for (const proxyHeaders of [
    { "x-forwarded-for": "203.0.113.9" },
    { "x-real-ip": "203.0.113.9" },
    { forwarded: "for=203.0.113.9" },
  ]) {
    const response = await rest(baseUrl, "/api/local/cloud-session", {
      method: "PUT",
      headers: proxyHeaders,
      body: { remoteUrl: "https://attacker.example/x", actorName: "a", sharedKey: "k" },
    });
    assert.equal(response.status, 403, `代理头 ${JSON.stringify(proxyHeaders)} 必须被 loopback 断言拒绝`);
  }
  const aiProbe = await fetch(`${baseUrl}/api/local/ai`, {
    headers: { "x-real-ip": "203.0.113.9" },
  });
  assert.equal(aiProbe.status, 403);
  // 本机直连（无代理头）不受影响
  const direct = await rest(baseUrl, "/api/local/cloud-session");
  assert.notEqual(direct.status, 403);
});

test("bridge 冒名仅授予 workbuddy-agent 专用身份：任意用户名 + workbuddy-bridge 头必须降级", async () => {
  const baseUrl = await startServer();
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "bridge-check", name: "桥接" } });
  await rest(baseUrl, "/api/projects/bridge-check/members", {
    method: "POST",
    body: { userId: ADMIN_ID, userName: "管理员", role: "manager" },
  });
  const post = (username, secret) => mcp(baseUrl, username, secret, "workbuddy-bridge", "dashi_post_project_message", {
    projectId: "bridge-check",
    body: "冒名测试",
    mentions: [],
    authorUserId: ADMIN_ID,
    authorName: "管理员",
  });
  await assert.rejects(
    post("spoof-agent", SERVICE_SECRET),
    (error) => error.code === "WORKBUDDY_BRIDGE_REQUIRED" || error.code === "AGENT_AUTH_REQUIRED",
    "任意用户名不得获得 bridge 冒名权",
  );
  // 旧部署回退路径：用户名精确为 workbuddy-agent（未配置 bridgeSecret）仍然可用
  const legacy = await post("workbuddy-agent", SERVICE_SECRET);
  assert.equal(legacy.message.author.id, ADMIN_ID);
});

test("配置 bridgeSecret 后，serviceSecret 的 workbuddy-agent 也不再是 bridge", async () => {
  const baseUrl = await startServer({ bridgeSecret: BRIDGE_SECRET });
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "bridge-secret", name: "桥接密钥" } });
  await rest(baseUrl, "/api/projects/bridge-secret/members", {
    method: "POST",
    body: { userId: ADMIN_ID, userName: "管理员", role: "manager" },
  });
  const post = (secret) => mcp(baseUrl, "workbuddy-agent", secret, "workbuddy-bridge", "dashi_post_project_message", {
    projectId: "bridge-secret",
    body: "冒名测试",
    mentions: [],
    authorUserId: ADMIN_ID,
    authorName: "管理员",
  });
  await assert.rejects(
    post(SERVICE_SECRET),
    (error) => error.code === "WORKBUDDY_BRIDGE_REQUIRED" || error.code === "AGENT_AUTH_REQUIRED",
    "共享密钥不得再授予 bridge 冒名权",
  );
  const legit = await post(BRIDGE_SECRET);
  assert.equal(legit.message.author.id, ADMIN_ID);
});

test("任何用户名都不能注册别人的 agentId（含 workbuddy-agent 自身）", async () => {
  const baseUrl = await startServer();
  await mcp(baseUrl, "claude-real", SERVICE_SECRET, "claude-code", "dashi_agent_register", {
    name: "Claude", device: "MacBook",
  });
  await assert.rejects(
    mcp(baseUrl, "workbuddy-agent", SERVICE_SECRET, "any", "dashi_agent_register", {
      agentId: "claude-real",
      name: "被冒名",
      device: "伪造设备",
    }),
    (error) => error.code === "AGENT_ID_MISMATCH",
  );
});

test("额外设备密钥可用且可独立撤销，但不授予任何特权身份", async () => {
  const baseUrl = await startServer({ serviceExtraSecrets: "device-a-secret,device-b-secret" });
  const registered = await mcp(baseUrl, "codex-mini", "device-a-secret", "task-worker", "dashi_agent_register", {
    name: "Codex", device: "Mini",
  });
  assert.equal(registered.agent.id, "codex-mini");

  // 设备密钥与共享密钥同域：只能是 agent，不得获得 companion/bridge 特权。
  const taskId = await stageTaskInReview(baseUrl);
  const before = await rest(baseUrl, `/api/tasks/${taskId}`);
  const attack = await rest(baseUrl, `/api/tasks/${taskId}/review`, {
    method: "POST",
    headers: {
      authorization: basic("codex-mini", "device-a-secret"),
      "x-taskboard-client": "cloud-companion",
      "x-taskboard-acting-user-id": ADMIN_ID,
      "x-taskboard-acting-user-name": encodeURIComponent("田纪元"),
    },
    body: { version: before.body.task.version, decision: "approve" },
  });
  assert.equal(attack.status, 403, "设备密钥 + acting 头不得获得管理员身份");

  // 撤销 device-a（重启时从列表移除）：同一密钥立即失效。
  const revoked = await startServer({ serviceExtraSecrets: "device-b-secret" });
  await assert.rejects(
    mcp(revoked, "codex-mini", "device-a-secret", "task-worker", "dashi_agent_heartbeat", {}),
    (error) => error.code === "AGENT_AUTH_REQUIRED" || error.code === "UNAUTHORIZED",
    "被撤销的设备密钥不得再通过认证",
  );
  const survivor = await mcp(revoked, "claude-macbook", "device-b-secret", "task-worker", "dashi_agent_register", {
    name: "Claude", device: "MacBook",
  });
  assert.equal(survivor.agent.id, "claude-macbook");
});

test("绑定式 Agent 凭据锁定身份、设备、能力和项目范围", async () => {
  const baseUrl = await startServer({
    agentCredentials: [{
      agentId: "codex-mini",
      secret: "bound-mini-secret",
      device: "Mini",
      projects: ["scope-a"],
      capabilities: ["taskboard"],
    }],
  });
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "scope-a", name: "授权项目" } });
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "scope-b", name: "未授权项目" } });

  await assert.rejects(
    mcp(baseUrl, "claude-macbook", "bound-mini-secret", "task-worker", "dashi_agent_register", {
      name: "伪造 Agent",
    }),
    (error) => error.code === "AGENT_AUTH_REQUIRED" || error.code === "UNAUTHORIZED",
    "绑定密钥不得使用其他 agentId",
  );
  await assert.rejects(
    mcp(baseUrl, "codex-mini", "bound-mini-secret", "task-worker", "dashi_agent_register", {
      name: "Codex", projects: ["scope-a", "scope-b"],
    }),
    (error) => error.code === "AGENT_SCOPE_MISMATCH",
    "Agent 不得在注册时扩大服务端授权",
  );
  const registered = await mcp(
    baseUrl,
    "codex-mini",
    "bound-mini-secret",
    "task-worker",
    "dashi_agent_register",
    { name: "Codex" },
  );
  assert.equal(registered.agent.device, "Mini");
  assert.deepEqual(registered.agent.projects, ["scope-a"]);
  assert.deepEqual(registered.agent.capabilities, ["taskboard"]);

  const forbiddenTask = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "scope-b", title: "越权任务", status: "todo" },
  });
  for (const [tool, args] of [
    ["dashi_get_task", { taskId: forbiddenTask.body.task.id }],
    ["dashi_add_comment", { taskId: forbiddenTask.body.task.id, body: "越权评论" }],
    ["dashi_list_project_messages", { projectId: "scope-b" }],
    ["dashi_post_project_message", { projectId: "scope-b", body: "越权群聊" }],
    ["dashi_claim_task", { taskId: forbiddenTask.body.task.id, leaseSeconds: 600 }],
    ["dashi_renew_task_lease", { taskId: forbiddenTask.body.task.id, leaseSeconds: 600 }],
    ["dashi_release_task", { taskId: forbiddenTask.body.task.id }],
    ["dashi_submit_for_review", { taskId: forbiddenTask.body.task.id, version: forbiddenTask.body.task.version }],
  ]) {
    await assert.rejects(
      mcp(baseUrl, "codex-mini", "bound-mini-secret", "task-worker", tool, args),
      (error) => error.code === "PROJECT_ACCESS_DENIED",
      `${tool} 必须执行服务端项目范围`,
    );
  }

  const restAttempt = await rest(baseUrl, `/api/tasks/${forbiddenTask.body.task.id}`, {
    headers: {
      authorization: basic("codex-mini", "bound-mini-secret"),
      "x-taskboard-client": "task-worker",
    },
  });
  assert.equal(restAttempt.status, 403, "REST 读取也必须执行同一项目范围");
});

test("绑定式 Agent 凭据配置拒绝重复身份、重复密钥和跨密钥域复用", async () => {
  assert.throws(() => createTaskboardServer({
    wecom: {
      agentCredentials: [
        { agentId: "same", secret: "a", projects: [] },
        { agentId: "same", secret: "b", projects: [] },
      ],
    },
  }), /duplicate agentId/);
  assert.throws(() => createTaskboardServer({
    wecom: {
      agentCredentials: [
        { agentId: "agent-a", secret: "same-secret", projects: [] },
        { agentId: "agent-b", secret: "same-secret", projects: [] },
      ],
    },
  }), /duplicate secrets/);
  assert.throws(() => createTaskboardServer({
    wecom: {
      serviceSecret: "same-secret",
      agentCredentials: [{ agentId: "agent-a", secret: "same-secret", projects: [] }],
    },
  }), /must not reuse another credential domain/);
});

test("同步通道不能把已审批完成的任务打回 todo/in_progress", async () => {
  const baseUrl = await startServer();
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "done-guard", name: "完成守护" } });
  const created = await mcp(baseUrl, "workbuddy-agent", SERVICE_SECRET, "workbuddy-bridge", "dashi_upsert_task", {
    projectId: "done-guard",
    workbuddyTaskId: "wb-1",
    title: "已完成任务",
    status: "todo",
  });
  const taskId = created.task.id;
  // 人类管理员（loopback 直连）走 REST move 到 done
  const current = await rest(baseUrl, `/api/tasks/${taskId}`);
  const done = await rest(baseUrl, `/api/tasks/${taskId}/move`, {
    method: "POST",
    body: { version: current.body.task.version, status: "done" },
  });
  assert.equal(done.status, 200);

  const regressed = await mcp(baseUrl, "workbuddy-agent", SERVICE_SECRET, "workbuddy-bridge", "dashi_upsert_task", {
    projectId: "done-guard",
    workbuddyTaskId: "wb-1",
    title: "已完成任务",
    status: "todo",
  });
  assert.equal(regressed.task.status, "done", "done 不得被同步通道打回 todo");
  // done → in_review（重开审批）仍然允许
  const reopened = await mcp(baseUrl, "workbuddy-agent", SERVICE_SECRET, "workbuddy-bridge", "dashi_upsert_task", {
    projectId: "done-guard",
    workbuddyTaskId: "wb-1",
    title: "已完成任务",
    status: "done",
  });
  assert.equal(reopened.task.status, "in_review", "done 映射 in_review 语义保持");
});
