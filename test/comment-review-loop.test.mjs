// 看板 ⇄ Agent 闭环回归测试：
// 1) 人类在任务评论 @Agent → 进入 agent 派发通道（与群聊 @ 同语义）
// 2) 无 @ 评论 / agent 自己的评论 → 不派发（防自激励循环）
// 3) 人类审批结果 → agent.review 事件仅回传指派 agent；驳回 → 常驻 Worker 自动重做
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createTaskWorker, resolveWorkerConfig } from "../scripts/task-worker.mjs";

const SERVICE_SECRET = "test-service-secret";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-comment-loop-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    wecom: { serviceSecret: SERVICE_SECRET },
  });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

async function rest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body !== undefined && typeof options.body !== "string"
        ? { "content-type": "application/json" }
        : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined
      ? undefined
      : (typeof options.body === "string" ? options.body : JSON.stringify(options.body)),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function mcp(baseUrl, username, name, args) {
  const response = await fetch(new URL("mcp/workbuddy", `${baseUrl}/`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Basic ${Buffer.from(`${username}:${SERVICE_SECRET}`).toString("base64")}`,
      "x-taskboard-client": "task-worker",
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

test("评论 @Agent 派发 → 驳回自动重做 → 批准授权闭环", async () => {
  const baseUrl = await startServer();
  await rest(baseUrl, "/api/projects", { method: "POST", body: { id: "comment-loop", name: "评论闭环" } });
  const created = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "comment-loop", title: "核对子任务拆分", status: "todo" },
  });
  const taskId = created.body.task.id;

  // 1. 人类评论 @Agent（loopback 默认 local-user，type=user）→ 必须派发
  const comment = await rest(baseUrl, `/api/tasks/${taskId}/comments`, {
    method: "POST",
    body: { body: "@Agent 请按子任务清单逐项核对并反馈缺失项" },
  });
  assert.equal(comment.status, 201);

  await mcp(baseUrl, "worker-x", "dashi_agent_register", { name: "Worker", device: "Test" });
  await mcp(baseUrl, "worker-y", "dashi_agent_register", { name: "Other", device: "Test" });

  const eventsForX = await mcp(baseUrl, "worker-x", "dashi_agent_events", { after: 0 });
  const dispatch = eventsForX.events.find((event) => event.eventType === "agent.dispatch");
  assert.ok(dispatch, "评论 @Agent 必须产生派发事件");
  assert.equal(dispatch.payload.taskId, taskId);
  assert.equal(dispatch.payload.anyAgent, true);
  assert.equal(dispatch.payload.body, "@Agent 请按子任务清单逐项核对并反馈缺失项");

  // 2. 无 @ 评论 → 不新增派发
  await rest(baseUrl, `/api/tasks/${taskId}/comments`, {
    method: "POST",
    body: { body: "普通进展备注，不需要 Agent 介入" },
  });
  const afterPlain = await mcp(baseUrl, "worker-x", "dashi_agent_events", { after: 0 });
  assert.equal(
    afterPlain.events.filter((event) => event.eventType === "agent.dispatch").length,
    1,
    "无 @ 评论不得派发",
  );

  // 3. agent 自己的评论带 @Agent → 不派发（防自激励循环）
  await mcp(baseUrl, "worker-x", "dashi_add_comment", {
    taskId,
    body: "@Agent 自检备注：等待人类指令",
  });
  const afterAgent = await mcp(baseUrl, "worker-x", "dashi_agent_events", { after: 0 });
  assert.equal(
    afterAgent.events.filter((event) => event.eventType === "agent.dispatch").length,
    1,
    "agent 评论不得触发派发",
  );

  // 4. Worker 领取执行 → in_review
  const workerConfig = resolveWorkerConfig({
    baseUrl,
    username: "worker-x",
    secret: SERVICE_SECRET,
    name: "CommentLoop",
    device: "验收机",
    leaseSeconds: 600,
  });
  const worker = createTaskWorker(workerConfig, { log: () => {} });
  await worker.register();
  const state = { cursor: 0 };
  const first = await worker.pollOnce(state);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, "done");
  assert.equal(first[0].task.status, "in_review");

  // 5. 管理员驳回（带批注）→ agent.review 仅指派 agent 可见，任务回 in_progress
  let current = await rest(baseUrl, `/api/tasks/${taskId}`);
  const returned = await rest(baseUrl, `/api/tasks/${taskId}/review`, {
    method: "POST",
    body: { version: current.body.task.version, decision: "request_changes", note: "补充供应商资质附件" },
  });
  assert.equal(returned.status, 200);
  assert.equal(returned.body.task.status, "in_progress");

  const reviewEventsX = await mcp(baseUrl, "worker-x", "dashi_agent_events", { after: 0 });
  const reviewForX = reviewEventsX.events.filter((event) => event.eventType === "agent.review");
  assert.equal(reviewForX.length, 1, "指派 agent 必须收到 agent.review");
  assert.equal(reviewForX[0].payload.decision, "changes_requested");
  assert.equal(reviewForX[0].payload.note, "补充供应商资质附件");
  assert.equal(reviewForX[0].payload.agentId, "worker-x");

  const reviewEventsY = await mcp(baseUrl, "worker-y", "dashi_agent_events", { after: 0 });
  assert.equal(
    reviewEventsY.events.filter((event) => event.eventType === "agent.review").length,
    0,
    "非指派 agent 不得看到他人任务的审批结果",
  );

  // 6. Worker 收到驳回 → 自动重做 → 重新提审
  const second = await worker.pollOnce(state);
  assert.equal(second.length, 1);
  assert.equal(second[0].status, "done");
  assert.equal(second[0].task.status, "in_review", "驳回后必须重做并再次提审");

  // 7. 管理员批准 → done，授权结果回传
  current = await rest(baseUrl, `/api/tasks/${taskId}`);
  const approved = await rest(baseUrl, `/api/tasks/${taskId}/review`, {
    method: "POST",
    body: { version: current.body.task.version, decision: "approve" },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.task.status, "done");

  const finalEvents = await mcp(baseUrl, "worker-x", "dashi_agent_events", { after: 0 });
  const decisions = finalEvents.events
    .filter((event) => event.eventType === "agent.review")
    .map((event) => event.payload.decision);
  assert.deepEqual(decisions, ["changes_requested", "approved"]);
});
