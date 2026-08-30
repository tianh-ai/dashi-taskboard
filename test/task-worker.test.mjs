import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import {
  createMcpClient,
  createTaskWorker,
  resolveWorkerConfig,
} from "../scripts/task-worker.mjs";

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-worker-test-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    wecom: { serviceSecret: SERVICE_SECRET },
  });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return { baseUrl: `http://127.0.0.1:${address.port}`, directory };
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
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function makeWorker(baseUrl, username, overrides = {}) {
  const config = resolveWorkerConfig({
    baseUrl,
    username,
    secret: SERVICE_SECRET,
    name: overrides.name ?? "Worker",
    device: overrides.device ?? "Mini",
    leaseSeconds: 600,
    ...overrides,
  });
  const logs = [];
  const worker = createTaskWorker(config, { log: (message) => logs.push(message) });
  return { config, worker, logs };
}

test("the resident worker completes the full chain: dispatch, claim, execute, writeback, review", async () => {
  const { baseUrl } = await startServer();
  const { worker } = makeWorker(baseUrl, "worker-mini", { name: "Resident", device: "Mini" });

  const agent = await worker.register();
  assert.equal(agent.id, "worker-mini");
  assert.equal(agent.online, true);

  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "worker-chain", name: "Worker 链路" },
  });
  const posted = await rest(baseUrl, "/api/projects/worker-chain/messages", {
    method: "POST",
    body: { body: "@Agent 请核对今日备份", mentions: ["agent"] },
  });
  assert.equal(posted.status, 201);

  const state = { cursor: 0 };
  const outcomes = await worker.pollOnce(state);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "done");
  assert.equal(state.cursor > 0, true);

  const taskDetail = await worker.mcp.call("dashi_get_task", { taskId: outcomes[0].task.id });
  assert.equal(taskDetail.task.status, "in_review");
  assert.equal(taskDetail.task.assignee.id, "worker-mini");
  assert.match(taskDetail.task.assignee.name, /^Resident·Mini$/);

  const messages = await rest(baseUrl, "/api/projects/worker-chain/messages");
  const bodies = messages.body.messages.map((message) => message.body).join("\n");
  assert.match(bodies, /【领取】Resident·Mini/);
  assert.match(bodies, /【完成】Resident·Mini 已处理/);
});

test("competing workers let exactly one claim win and the loser skips with LEASE_HELD", async () => {
  const { baseUrl } = await startServer();
  const winner = makeWorker(baseUrl, "worker-a", { name: "Alpha", device: "Mini" });
  const loser = makeWorker(baseUrl, "worker-b", { name: "Beta", device: "MacBook" });
  await winner.worker.register();
  await loser.worker.register();

  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "worker-race", name: "Worker 竞争" },
  });
  await rest(baseUrl, "/api/projects/worker-race/messages", {
    method: "POST",
    body: { body: "@Agent 竞争领取测试", mentions: ["agent"] },
  });

  const first = await winner.worker.pollOnce({ cursor: 0 });
  const second = await loser.worker.pollOnce({ cursor: 0 });
  assert.equal(first[0].status, "done");
  assert.equal(second[0].status, "skipped");
  // 落败者要么撞上 LEASE_HELD（赢者仍在执行），要么撞上 TASK_NOT_CLAIMABLE
  // （赢者已完成提审）——两者都证明唯一领取语义成立。
  assert.ok(
    second[0].reason === "LEASE_HELD" || second[0].reason === "TASK_NOT_CLAIMABLE",
    `unexpected skip reason: ${second[0].reason}`,
  );

  const taskDetail = await winner.worker.mcp.call("dashi_get_task", { taskId: first[0].task.id });
  assert.equal(taskDetail.task.assignee.id, "worker-a");
});

test("an expired lease lets another worker take over the same dispatch", async () => {
  const { baseUrl, directory } = await startServer();
  const first = makeWorker(baseUrl, "worker-stale", { name: "Stale", device: "Mini" });
  const rescue = makeWorker(baseUrl, "worker-rescue", { name: "Rescue", device: "NAS" });
  await first.worker.register();
  await rescue.worker.register();

  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "worker-takeover", name: "Worker 接管" },
  });
  const posted = await rest(baseUrl, "/api/projects/worker-takeover/messages", {
    method: "POST",
    body: { body: "@Agent 掉线接管测试", mentions: ["agent"] },
  });
  assert.equal(posted.status, 201);

  // 第一个 Worker 只领取不执行，模拟拿到任务后掉线。
  const events = await first.worker.mcp.call("dashi_agent_events", { after: 0 });
  const dispatch = events.events.find((event) => event.eventType === "agent.dispatch");
  const claim = await first.worker.mcp.call("dashi_claim_task", {
    taskId: dispatch.payload.taskId,
    leaseSeconds: 600,
  });
  assert.equal(claim.task.assignee.id, "worker-stale");

  const database = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  database.prepare("UPDATE task_leases SET expires_at = ? WHERE task_id = ?")
    .run("2000-01-01T00:00:00.000Z", dispatch.payload.taskId);
  database.close();

  const outcomes = await rescue.worker.pollOnce({ cursor: 0 });
  assert.equal(outcomes[0].status, "done");
  const taskDetail = await rescue.worker.mcp.call("dashi_get_task", { taskId: dispatch.payload.taskId });
  assert.equal(taskDetail.task.assignee.id, "worker-rescue");
  assert.equal(taskDetail.task.status, "in_review");

  const messages = await rest(baseUrl, "/api/projects/worker-takeover/messages");
  const bodies = messages.body.messages.map((message) => message.body).join("\n");
  assert.match(bodies, /【接管】Rescue·NAS 接管任务/);
  assert.match(bodies, /【接管完成】Rescue·NAS/);
});

test("the exec runner passes task context through env vars and records its output", async () => {
  const { baseUrl } = await startServer();
  const execArgv = [process.execPath, "-e", "console.log(`handled ${process.env.DASHI_TASK_TITLE} in ${process.env.DASHI_PROJECT_ID}`)"];
  const { worker } = makeWorker(baseUrl, "worker-exec", { exec: JSON.stringify(execArgv), name: "Exec", device: "Mini" });
  await worker.register();

  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "worker-exec", name: "Worker 执行" },
  });
  await rest(baseUrl, "/api/projects/worker-exec/messages", {
    method: "POST",
    body: { body: "@Agent 用外部命令处理", mentions: ["agent"] },
  });

  const outcomes = await worker.pollOnce({ cursor: 0 });
  assert.equal(outcomes[0].status, "done");
  assert.match(outcomes[0].execution.summary, /handled .*? in worker-exec/);

  const events = await worker.mcp.call("dashi_agent_events", { after: 0 });
  const dispatch = events.events.find((event) => event.eventType === "agent.dispatch");
  const taskDetail = await worker.mcp.call("dashi_get_task", { taskId: dispatch.payload.taskId });
  assert.equal(taskDetail.task.status, "in_review");
});

test("worker config resolution enforces credentials and validates the exec contract", async () => {
  const base = {
    baseUrl: "https://workbuddy.example.test/wecom/app/1000003/taskboard/",
    username: "worker-mini",
    secret: "k",
    name: "Worker",
  };
  const config = resolveWorkerConfig(base);
  assert.equal(config.baseUrl, "https://workbuddy.example.test/wecom/app/1000003/taskboard");
  assert.equal(config.clientTag, "task-worker");

  assert.throws(() => resolveWorkerConfig({ ...base, baseUrl: "" }), /baseUrl/);
  assert.throws(() => resolveWorkerConfig({ ...base, exec: "not-json" }), /exec/);
  assert.throws(() => resolveWorkerConfig({ ...base, exec: JSON.stringify("echo hi") }), /exec/);
  assert.throws(() => resolveWorkerConfig({ ...base, leaseSeconds: 0 }), /leaseSeconds/);

  const fromEnv = resolveWorkerConfig({}, {
    DASHI_WORKER_URL: base.baseUrl,
    DASHI_WORKER_USERNAME: "worker-mini",
    DASHI_WORKER_SECRET: "k",
    DASHI_WORKER_NAME: "Worker",
  });
  assert.equal(fromEnv.username, "worker-mini");
});

test("the mcp client surfaces tool errors with their server-side codes", async () => {
  const { baseUrl } = await startServer();
  const client = createMcpClient({
    baseUrl,
    username: "worker-ghost",
    secret: SERVICE_SECRET,
    clientTag: "task-worker",
  });
  await assert.rejects(
    client.call("dashi_agent_heartbeat", {}),
    (error) => error.code === "AGENT_NOT_FOUND",
  );
});

test("a poison dispatch (task deleted) is skipped and never blocks later dispatches", async () => {
  const { baseUrl, directory } = await startServer();
  const { worker } = makeWorker(baseUrl, "worker-poison");
  await worker.register();

  // 直接注入一条指向不存在任务的毒派发（正常流程不会产生，模拟派发后任务被删）。
  const database = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  database.prepare(`
    INSERT INTO integration_outbox (destination, event_type, project_id, task_id, payload, created_at)
    VALUES ('agents', 'agent.dispatch', NULL, 'ghost-task', ?, '2026-08-30T00:00:00.000Z')
  `).run(JSON.stringify({
    type: "agent.dispatch",
    projectId: "worker-poison-proj",
    taskId: "ghost-task",
    body: "毒事件",
    anyAgent: true,
    targets: [],
  }));
  database.close();

  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "worker-poison-proj", name: "毒事件恢复" },
  });
  await rest(baseUrl, "/api/projects/worker-poison-proj/messages", {
    method: "POST",
    body: { body: "@Agent 毒事件之后的正常派发", mentions: ["agent"] },
  });

  const state = { cursor: 0 };
  const outcomes = await worker.pollOnce(state);
  assert.equal(outcomes.length, 2, JSON.stringify(outcomes));
  assert.equal(outcomes[0].status, "skipped");
  assert.equal(outcomes[0].reason, "TASK_NOT_FOUND");
  assert.equal(outcomes[1].status, "done", "毒事件之后的有效派发必须被处理");
  // 游标必须越过毒事件：再轮询不得重复处理任何事件。
  const again = await worker.pollOnce(state);
  assert.equal(again.length, 0);
});

test("dashi_agent_events rejects unregistered agents instead of silently eating events", async () => {
  const { baseUrl } = await startServer();
  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "ghost-events", name: "幽灵事件" },
  });
  await rest(baseUrl, "/api/projects/ghost-events/messages", {
    method: "POST",
    body: { body: "@Agent 未注册视角测试", mentions: ["agent"] },
  });
  const { worker } = makeWorker(baseUrl, "worker-registered");
  await worker.register();
  const ghost = createMcpClient({
    baseUrl,
    username: "worker-ghost2",
    secret: SERVICE_SECRET,
    clientTag: "task-worker",
  });
  // 未注册 agent 必须显式 404（触发 worker 重注册自愈），而不是空列表 + 游标前进。
  await assert.rejects(
    ghost.call("dashi_agent_events", { after: 0 }),
    (error) => error.code === "AGENT_NOT_FOUND",
  );
  const seen = await worker.mcp.call("dashi_agent_events", { after: 0 });
  assert.ok(seen.events.some((event) => event.eventType === "agent.dispatch"));
});

test("a server event-log reset (cursor moving backwards) triggers replay from zero", async () => {
  const { baseUrl } = await startServer();
  const { worker, logs } = makeWorker(baseUrl, "worker-reset");
  await worker.register();

  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "worker-reset", name: "游标回退" },
  });
  await rest(baseUrl, "/api/projects/worker-reset/messages", {
    method: "POST",
    body: { body: "@Agent 游标回退重放测试", mentions: ["agent"] },
  });

  // 模拟服务端重建后 worker 本地游标远超服务端最新 sequence。
  const state = { cursor: 999_999 };
  const outcomes = await worker.pollOnce(state);
  assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes[0].status, "done", "游标回退必须归零重放并处理派发");
  assert.ok(logs.some((message) => message.includes("moved backwards")));
  assert.ok(state.cursor > 0 && state.cursor < 999_999, "游标必须回到服务端实际范围");
});

