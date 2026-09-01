// outbox 事务化回归：业务写入与 integration_outbox 必须同事务。
// 通过向 appendIntegrationEvent 注入故障模拟崩溃窗口，断言业务写回滚、不留半提交状态。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

const SERVICE_SECRET = "outbox-tx-secret";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-outbox-tx-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    wecom: { serviceSecret: SERVICE_SECRET },
  });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, directory };
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

async function mcp(baseUrl, name, args) {
  const response = await fetch(new URL("mcp/workbuddy", `${baseUrl}/`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Basic ${Buffer.from(`tx-agent:${SERVICE_SECRET}`).toString("base64")}`,
      "x-taskboard-client": "task-worker",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  const envelope = JSON.parse(text);
  if (envelope.error || !envelope.result?.content) {
    return { status: response.status, body: envelope };
  }
  return { status: response.status, body: JSON.parse(envelope.result.content[0].text) };
}

function injectOutboxFailure(app) {
  const original = app.database.appendIntegrationEvent.bind(app.database);
  app.database.appendIntegrationEvent = () => {
    throw new Error("injected outbox failure");
  };
  return () => {
    app.database.appendIntegrationEvent = original;
  };
}

test("claim 与 outbox 同事务：outbox 写失败时领取完全回滚", async () => {
  const { app, baseUrl, directory } = await startServer();
  const project = await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "tx-claim", name: "领取事务" },
  });
  assert.equal(project.status, 201);
  const task = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "tx-claim", title: "待领取任务" },
  });
  assert.equal(task.status, 201);
  const register = await mcp(baseUrl, "dashi_agent_register", {
    agentId: "tx-agent",
    name: "TxAgent",
    device: "注入机",
    projects: ["tx-claim"],
  });
  assert.equal(register.status, 200);

  const restore = injectOutboxFailure(app);
  const claim = await mcp(baseUrl, "dashi_claim_task", {
    taskId: task.body.task.id,
    leaseSeconds: 600,
  });
  restore();
  assert.equal(claim.status, 500, "outbox 写失败必须让整个领取失败");

  const after = await rest(baseUrl, `/api/tasks/${task.body.task.id}`);
  assert.equal(after.body.task.status, "backlog", "领取回滚后任务不得停留在 in_progress");
  const rawDb = new DatabaseSync(path.join(directory, "taskboard.sqlite"), { readOnly: true });
  const leaseCount = rawDb.prepare("SELECT COUNT(*) AS n FROM task_leases WHERE task_id = ?").get(task.body.task.id);
  assert.equal(leaseCount.n, 0, "回滚后不得残留租约");
  const progressMessages = rawDb.prepare(
    "SELECT COUNT(*) AS n FROM project_messages WHERE project_id = ? AND kind = 'progress'",
  ).get("tx-claim");
  assert.equal(progressMessages.n, 0, "回滚后不得残留进度系统消息");
  rawDb.close();
});

test("群聊派发与 outbox 同事务：outbox 写失败时消息不落库", async () => {
  const { app, baseUrl, directory } = await startServer();
  const project = await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "tx-dispatch", name: "派发事务" },
  });
  assert.equal(project.status, 201);
  const member = await rest(baseUrl, "/api/projects/tx-dispatch/members", {
    method: "POST",
    body: { userId: "EmployeeA", userName: "员工甲", role: "member" },
  });
  assert.equal(member.status, 200);

  const restore = injectOutboxFailure(app);
  const message = await rest(baseUrl, "/api/projects/tx-dispatch/messages", {
    method: "POST",
    body: { body: "@Agent 注入窗口内的请求", kind: "message", mentions: ["agent"] },
  });
  restore();
  assert.equal(message.status, 500, "outbox 写失败必须让消息提交失败");

  const rawDb = new DatabaseSync(path.join(directory, "taskboard.sqlite"), { readOnly: true });
  const messageCount = rawDb.prepare("SELECT COUNT(*) AS n FROM project_messages WHERE project_id = 'tx-dispatch'").get();
  assert.equal(messageCount.n, 0, "回滚后消息不得残留");
  const dispatchCount = rawDb.prepare(
    "SELECT COUNT(*) AS n FROM integration_outbox WHERE destination = 'agents'",
  ).get();
  assert.equal(dispatchCount.n, 0, "回滚后不得残留派发事件");
  rawDb.close();
});

test("嵌套事务：内层抛错时外层整体回滚且连接可继续使用", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dashi-nested-tx-"));
  try {
    const db = new TaskboardDatabase(path.join(directory, "nested.sqlite"));
    db.transaction(() => {
      db.appendIntegrationEvent("workbuddy", { type: "outer.event", projectId: "p1" });
      assert.throws(() => {
        db.transaction(() => {
          db.appendIntegrationEvent("workbuddy", { type: "inner.event", projectId: "p1" });
          throw new Error("inner failure");
        });
      }, /inner failure/);
      // 内层失败后外层继续写入再提交：只有外层内容可见。
      db.appendIntegrationEvent("workbuddy", { type: "outer.after-inner", projectId: "p1" });
    });
    const events = db.listIntegrationEvents("workbuddy", 0, 100);
    assert.equal(events.length, 2);
    assert.equal(events[0].payload.type, "outer.event");
    assert.equal(events[1].payload.type, "outer.after-inner");
    // 回滚后连接必须能正常开启新事务。
    assert.throws(() => {
      db.transaction(() => {
        db.appendIntegrationEvent("workbuddy", { type: "rolled-back", projectId: "p1" });
        throw new Error("outer failure");
      });
    }, /outer failure/);
    assert.equal(db.listIntegrationEvents("workbuddy", 0, 100).length, 2, "回滚不得留下半提交事件");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
