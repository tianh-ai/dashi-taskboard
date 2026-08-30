import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-agents-test-"));
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

async function mcp(baseUrl, username, clientTag, method, params) {
  const credentials = Buffer.from(`${username}:${SERVICE_SECRET}`).toString("base64");
  const response = await fetch(`${baseUrl}/mcp/workbuddy`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Basic ${credentials}`,
      "x-taskboard-client": clientTag,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  if (response.status !== 200) {
    const parsed = text ? JSON.parse(text) : {};
    const error = new Error(parsed?.error?.message ?? `MCP ${method} failed with HTTP ${response.status}`);
    error.code = parsed?.error?.code;
    error.status = response.status;
    throw error;
  }
  if (text.startsWith("event:")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
    return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
  }
  return text ? JSON.parse(text) : null;
}

async function callTool(baseUrl, username, clientTag, name, args) {
  const message = await mcp(baseUrl, username, clientTag, "tools/call", { name, arguments: args });
  const payload = message?.result?.content?.[0]?.text;
  assert.ok(payload, `tool ${name} returned no payload: ${JSON.stringify(message)}`);
  const parsed = JSON.parse(payload);
  if (parsed?.error) {
    const error = new Error(parsed.error.message ?? "tool error");
    error.code = parsed.error.code;
    error.status = parsed.error.status ?? 409;
    throw error;
  }
  return parsed;
}

test("agent register, heartbeat, and listing reflect online state", async () => {
  const { baseUrl } = await startServer();

  const claude = await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_agent_register", {
    name: "Claude",
    device: "MacBook",
    capabilities: ["code", "docs"],
    concurrency: 2,
  });
  assert.equal(claude.agent.id, "claude-macbook");
  assert.equal(claude.agent.online, true);
  assert.deepEqual(claude.agent.capabilities, ["code", "docs"]);

  const codex = await callTool(baseUrl, "codex-mini", "codex-cli", "dashi_agent_register", {
    name: "Codex",
    device: "Mini",
    capabilities: ["code"],
  });
  assert.equal(codex.agent.id, "codex-mini");

  const beat = await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_agent_heartbeat", {});
  assert.equal(beat.agent.online, true);

  const list = await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_list_agents", {});
  assert.deepEqual(list.agents.map((agent) => agent.id).sort(), ["claude-macbook", "codex-mini"]);

  const unknown = await callTool(baseUrl, "ghost-worker", "any-client", "dashi_agent_heartbeat", {}).catch((error) => error);
  assert.equal(unknown.code, "AGENT_NOT_FOUND");
});

test("concurrent claims allow exactly one winner and reject the loser with LEASE_HELD", async () => {
  const { baseUrl } = await startServer();

  await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_agent_register", {
    name: "Claude", device: "MacBook", concurrency: 2,
  });
  await callTool(baseUrl, "codex-mini", "codex-cli", "dashi_agent_register", {
    name: "Codex", device: "Mini", concurrency: 2,
  });

  const project = await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "agent-acceptance", name: "Agent 验收" },
  });
  assert.equal(project.status, 201);

  const task = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "agent-acceptance", title: "并发领取验收", status: "todo" },
  });
  assert.equal(task.status, 201);
  const taskId = task.body.task.id;

  const [claudeResult, codexResult] = await Promise.allSettled([
    callTool(baseUrl, "claude-macbook", "claude-code", "dashi_claim_task", { taskId, leaseSeconds: 600 }),
    callTool(baseUrl, "codex-mini", "codex-cli", "dashi_claim_task", { taskId, leaseSeconds: 600 }),
  ]);

  const winners = [claudeResult, codexResult].filter((result) => result.status === "fulfilled");
  const losers = [claudeResult, codexResult].filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1, "exactly one agent must win the claim");
  assert.equal(losers.length, 1, "exactly one agent must lose the claim");
  assert.equal(losers[0].reason.code, "LEASE_HELD");

  const winner = winners[0].value;
  assert.equal(winner.task.status, "in_progress");
  assert.equal(winner.task.assignee.type, "agent");
  assert.match(winner.task.assignee.name, /^(Claude|Codex)·(MacBook|Mini)$/);
  assert.equal(winner.tookOver, false);

  const messages = await rest(baseUrl, "/api/projects/agent-acceptance/messages");
  const progress = messages.body.messages.filter((message) => message.kind === "progress");
  assert.ok(progress.some((message) => message.body.includes("【领取】")), "claim must be visible in project chat");

  const renew = await callTool(
    baseUrl,
    winner.task.assignee.id === "claude-macbook" ? "claude-macbook" : "codex-mini",
    winner.task.assignee.id === "claude-macbook" ? "claude-code" : "codex-cli",
    "dashi_renew_task_lease",
    { taskId, leaseSeconds: 600 },
  );
  assert.ok(renew.lease.expiresAt > winner.lease.expiresAt || renew.lease.renewedAt >= winner.lease.renewedAt);
});

test("expired leases can be taken over by another agent and releases return tasks to the pool", async () => {
  const { baseUrl, directory } = await startServer();

  await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_agent_register", {
    name: "Claude", device: "MacBook",
  });
  await callTool(baseUrl, "codex-mini", "codex-cli", "dashi_agent_register", {
    name: "Codex", device: "Mini",
  });

  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "takeover-check", name: "接管验收" },
  });
  const task = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "takeover-check", title: "掉线接管验收", status: "todo" },
  });
  const taskId = task.body.task.id;

  const claim = await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_claim_task", {
    taskId,
    leaseSeconds: 600,
  });
  assert.equal(claim.task.assignee.id, "claude-macbook");

  // Simulate lease expiry behind the server's back, as if the heartbeat stopped.
  const database = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  database.prepare("UPDATE task_leases SET expires_at = ? WHERE task_id = ?")
    .run("2000-01-01T00:00:00.000Z", taskId);
  database.close();

  const takeover = await callTool(baseUrl, "codex-mini", "codex-cli", "dashi_claim_task", {
    taskId,
    leaseSeconds: 600,
  });
  assert.equal(takeover.tookOver, true);
  assert.equal(takeover.previousAgentId, "claude-macbook");
  assert.equal(takeover.task.assignee.id, "codex-mini");

  const messages = await rest(baseUrl, "/api/projects/takeover-check/messages");
  assert.ok(
    messages.body.messages.some((message) => message.body.includes("【接管】") && message.body.includes("Codex·Mini")),
    "takeover must be recorded in project chat",
  );

  const staleRelease = await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_release_task", {
    taskId,
    reason: "已掉线",
  }).catch((error) => error);
  assert.equal(staleRelease.code, "LEASE_NOT_HELD");

  const release = await callTool(baseUrl, "codex-mini", "codex-cli", "dashi_release_task", {
    taskId,
    reason: "验收完成",
  });
  assert.equal(release.task.status, "todo");
});

test("mentions dispatch to targeted agents and any-agent fanout with per-agent filtering", async () => {
  const { baseUrl } = await startServer();

  await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_agent_register", {
    name: "Claude", device: "MacBook",
  });
  await callTool(baseUrl, "codex-mini", "codex-cli", "dashi_agent_register", {
    name: "Codex", device: "Mini",
  });

  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "dispatch-check", name: "调度验收" },
  });

  const targetedPost = await rest(baseUrl, "/api/projects/dispatch-check/messages", {
    method: "POST",
    body: { body: "@Claude 请整理采购比价表", mentions: ["Claude"] },
  });
  assert.equal(targetedPost.status, 201, `targeted post failed: ${JSON.stringify(targetedPost.body)}`);
  assert.deepEqual(targetedPost.body.message.mentions, ["Claude"]);
  const anyAgentPost = await rest(baseUrl, "/api/projects/dispatch-check/messages", {
    method: "POST",
    body: { body: "@Agent 谁在线谁处理这条", mentions: ["agent"] },
  });
  assert.equal(anyAgentPost.status, 201, `any-agent post failed: ${JSON.stringify(anyAgentPost.body)}`);

  const claudeEvents = await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_agent_events", {});
  const codexEvents = await callTool(baseUrl, "codex-mini", "codex-cli", "dashi_agent_events", {});
  if (process.env.DEBUG_DISPATCH) {
    console.error("CLAUDE", JSON.stringify(claudeEvents));
    console.error("CODEX", JSON.stringify(codexEvents));
  }

  const dispatches = (result) => result.events.filter((event) => event.eventType === "agent.dispatch");
  assert.equal(dispatches(claudeEvents).length, 2, "Claude sees the targeted dispatch and the any-agent dispatch");
  assert.equal(dispatches(codexEvents).length, 1, "Codex sees only the any-agent dispatch");
  assert.equal(dispatches(codexEvents)[0].payload.anyAgent, true);

  const targeted = dispatches(claudeEvents).find((event) => !event.payload.anyAgent);
  assert.deepEqual(targeted.payload.targets, [{ id: "claude-macbook", name: "Claude", device: "MacBook" }]);
});

test("agent chat replies carry registry identity and stay out of user impersonation", async () => {
  const { baseUrl } = await startServer();

  await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_agent_register", {
    name: "Claude", device: "MacBook",
  });

  await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "identity-check", name: "身份验收" },
  });

  const posted = await callTool(baseUrl, "claude-macbook", "claude-code", "dashi_post_project_message", {
    projectId: "identity-check",
    body: "已开始处理，预计 10 分钟",
    kind: "progress",
  });
  assert.equal(posted.message.author.type, "agent");
  assert.equal(posted.message.author.id, "agent:claude-macbook");
  assert.equal(posted.message.author.name, "Claude·MacBook");
});
