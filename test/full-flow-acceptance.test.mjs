// 全流程验收测试服务：真实数据从接入 → 同步 → 执行回写 → 人类审批验收 → 落库一致性。
// 作为 dashi-taskboard 多 Agent 协作链路的端到端审计依据：任一阶段断言失败即视为链路断裂。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createTaskWorker, resolveWorkerConfig } from "../scripts/task-worker.mjs";

const SERVICE_SECRET = "test-service-secret";
const EMPLOYEE_ID = "LiYunE";
const EMPLOYEE_NAME = "李云";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-full-flow-"));
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

async function mcp(baseUrl, username, clientTag, name, args) {
  const response = await fetch(new URL("mcp/workbuddy", `${baseUrl}/`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Basic ${Buffer.from(`${username}:${SERVICE_SECRET}`).toString("base64")}`,
      "x-taskboard-client": clientTag,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  const message = JSON.parse(text);
  const parsed = JSON.parse(message.result.content[0].text);
  if (parsed?.error) {
    const error = new Error(parsed.error.message ?? "tool error");
    error.code = parsed.error.code;
    error.status = response.status;
    throw error;
  }
  return parsed;
}

/** 订阅 SSE 并把每条事件解析成 { event, data } 推入队列。 */
function subscribe(baseUrl) {
  const events = [];
  let reader;
  let decoder;
  const ready = (async () => {
    const response = await fetch(`${baseUrl}/api/events`);
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    decoder = new TextDecoder();
    let buffer = "";
    // 后台持续读取：事件一到达就入队，测试按需等待。
    (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
            const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
            if (eventLine && dataLine) {
              events.push({ event: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(6)) });
            }
          }
        }
      } catch {
        // 流被测试关闭时正常退出。
      }
    })();
    // 等初始连接帧（retry 帧）到达。
    await reader.read();
  })();
  return {
    ready,
    events,
    async waitFor(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`SSE 事件等待超时：${JSON.stringify(events.map((item) => item.event))}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async close() {
      await reader?.cancel();
    },
  };
}

test("真实数据全流程：员工接入 → 实时同步 → Worker 执行回写 → 人类审批 → 落库一致", async () => {
  const { baseUrl, directory } = await startServer();
  const stream = subscribe(baseUrl);
  await stream.ready;

  // ---------- 阶段 1：接入（员工三通道：群聊冒名、REST 建单、Agent 注册） ----------
  const project = await rest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "full-flow", name: "全流程验收" },
  });
  assert.equal(project.status, 201);
  // 员工必须先是项目成员，bridge 才能以其名义发言（生产同样受此约束）。
  const member = await rest(baseUrl, "/api/projects/full-flow/members", {
    method: "POST",
    body: { userId: EMPLOYEE_ID, userName: EMPLOYEE_NAME, role: "member" },
  });
  assert.equal(member.status, 200);

  // 1a. 员工在群聊 @Agent（WorkBuddy bridge 以 authorUserId 代发）
  const chatMessage = await mcp(baseUrl, "workbuddy-agent", "workbuddy-bridge", "dashi_post_project_message", {
    projectId: "full-flow",
    body: "@Agent 请核对今日采购比价表并归档",
    kind: "message",
    mentions: ["agent"],
    authorUserId: EMPLOYEE_ID,
    authorName: EMPLOYEE_NAME,
  });
  assert.equal(chatMessage.message.author.id, EMPLOYEE_ID);
  assert.equal(chatMessage.message.author.type, "user");

  // 派发必须立刻落 integration_outbox 并自动建任务
  const workerConfig = resolveWorkerConfig({
    baseUrl,
    username: "worker-full",
    secret: SERVICE_SECRET,
    name: "FullFlow",
    device: "验收机",
    leaseSeconds: 600,
  });
  const logs = [];
  const worker = createTaskWorker(workerConfig, { log: (message) => logs.push(message) });
  const agent = await worker.register();
  assert.equal(agent.id, "worker-full");
  await worker.heartbeat();

  const agentEvents = await mcp(baseUrl, "worker-full", "task-worker", "dashi_agent_events", { after: 0 });
  const dispatch = agentEvents.events.find((event) => event.eventType === "agent.dispatch");
  assert.ok(dispatch, "群聊 @Agent 必须产生派发事件");
  assert.equal(dispatch.payload.projectId, "full-flow");
  assert.equal(dispatch.payload.anyAgent, true);
  const chatTaskId = dispatch.payload.taskId;
  assert.ok(chatTaskId);

  // 1b. 员工经看板 REST 直接建议题 + 附件（真实二进制内容往返）
  const boardTask = await rest(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "full-flow", title: "归档今日比价表", status: "todo" },
  });
  assert.equal(boardTask.status, 201);
  const boardTaskId = boardTask.body.task.id;
  const attachmentBody = "供应商,报价\nA,100\nB,88\n";
  const uploaded = await rest(baseUrl, `/api/tasks/${boardTaskId}/attachments`, {
    method: "POST",
    headers: { "content-type": "text/csv; charset=utf-8", "x-taskboard-filename": encodeURIComponent("比价表.csv") },
    body: attachmentBody,
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.attachment.filename, "比价表.csv");
  const downloaded = await fetch(`${baseUrl}/api/attachments/${uploaded.body.attachment.id}/content`);
  assert.equal(await downloaded.text(), attachmentBody);

  // 1c. Agent 接入面语义一致：REST 读项目/任务同样放行
  const agentHeaders = {
    authorization: `Basic ${Buffer.from(`worker-full:${SERVICE_SECRET}`).toString("base64")}`,
    "x-taskboard-client": "task-worker",
  };
  const agentProjectList = await rest(baseUrl, "/api/projects", { headers: agentHeaders });
  assert.equal(agentProjectList.status, 200);
  const agentTaskRead = await rest(baseUrl, `/api/tasks/${boardTaskId}`, { headers: agentHeaders });
  assert.equal(agentTaskRead.status, 200);

  // ---------- 阶段 2：同步（SSE 实时 + cursor 增量 + REST/MCP 一致） ----------
  await stream.waitFor(({ event }) => event === "task.created" && event !== undefined);
  assert.ok(
    stream.events.some(({ event, data }) => event === "task.created" && data.task?.id === chatTaskId),
    "@Agent 派发自动建任务必须广播 task.created",
  );
  assert.ok(
    stream.events.some(({ event, data }) => event === "project.message.created" && data.message?.id === chatMessage.message.id),
    "员工群聊消息必须广播 project.message.created",
  );

  const beforeSeq = chatMessage.message.sequence;
  const incremental = await mcp(baseUrl, "workbuddy-agent", "workbuddy-bridge", "dashi_list_project_messages", {
    projectId: "full-flow",
    after: beforeSeq,
    limit: 50,
  });
  assert.equal(
    incremental.messages.some((message) => message.id === chatMessage.message.id),
    false,
    "cursor 增量不应重复返回已读消息",
  );

  const viaRest = await rest(baseUrl, `/api/tasks/${chatTaskId}`);
  const viaMcp = await mcp(baseUrl, "workbuddy-agent", "workbuddy-bridge", "dashi_get_task", { taskId: chatTaskId });
  assert.equal(viaRest.body.task.status, viaMcp.task.status);
  assert.equal(viaRest.body.task.version, viaMcp.task.version);

  // ---------- 阶段 3：Worker 执行回写（领取→执行→评论→群聊完成→提审） ----------
  const outcomes = await worker.pollOnce({ cursor: 0 });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "done", `Worker 应完成派发：${JSON.stringify(outcomes)}`);
  assert.equal(outcomes[0].task.status, "in_review");

  await stream.waitFor(({ event, data }) => event === "task.claimed" && data.task?.id === chatTaskId);
  await stream.waitFor(({ event, data }) => event === "comment.created" && data.task?.id === chatTaskId);
  await stream.waitFor(({ event, data }) => event === "task.moved" && data.task?.id === chatTaskId && data.task?.status === "in_review");

  const chatAfterWork = await mcp(baseUrl, "workbuddy-agent", "workbuddy-bridge", "dashi_list_project_messages", {
    projectId: "full-flow",
    limit: 50,
  });
  const chatBodies = chatAfterWork.messages.map((message) => `${message.author.name}:${message.body}`).join("\n");
  assert.match(chatBodies, /【领取】FullFlow·验收机/);
  assert.match(chatBodies, /【完成】FullFlow·验收机 已处理/);

  // ---------- 阶段 4：验收（治理不变量 + 人类审批） ----------
  // 4a. Agent 绝不能把任务推到 done，也不能代替管理员审批
  const agentMoveDone = await rest(baseUrl, `/api/tasks/${chatTaskId}/move`, {
    method: "POST",
    headers: agentHeaders,
    body: { version: viaMcp.task.version, status: "done" },
  }).catch((error) => error);
  if (agentMoveDone.status !== undefined) {
    assert.equal(agentMoveDone.status, 403, "agent move-to-done 必须被拒绝");
  }
  const agentReview = await rest(baseUrl, `/api/tasks/${chatTaskId}/review`, {
    method: "POST",
    headers: agentHeaders,
    body: { version: viaMcp.task.version, decision: "approve" },
  });
  assert.equal(agentReview.status, 403, "agent 审批必须被拒绝");

  // 4b. 人类项目管理员审批通过 → done
  const beforeReview = await rest(baseUrl, `/api/tasks/${chatTaskId}`);
  const approved = await rest(baseUrl, `/api/tasks/${chatTaskId}/review`, {
    method: "POST",
    body: { version: beforeReview.body.task.version, decision: "approve", note: "比价表已核对，验收通过" },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.task.status, "done");
  assert.equal(approved.body.task.latestReview.decision, "approved");

  await stream.waitFor(({ event }) => event === "task.reviewed");

  // 版本链单调递增：创建 < 提审 < 审批
  const finalTask = (await rest(baseUrl, `/api/tasks/${chatTaskId}`)).body.task;
  assert.ok(finalTask.version > beforeReview.body.task.version, "审批必须递增任务版本");

  // ---------- 阶段 5：落库一致性（直读 SQLite 终态） ----------
  const db = new DatabaseSync(path.join(directory, "taskboard.sqlite"), { readOnly: true });
  const leaseRows = db.prepare("SELECT * FROM task_leases WHERE task_id = ?").all(chatTaskId);
  assert.equal(leaseRows.length, 0, "提审后租约必须清理");
  const dispatchRows = db.prepare(
    "SELECT sequence, destination, event_type FROM integration_outbox WHERE destination = 'agents' ORDER BY sequence",
  ).all();
  assert.ok(dispatchRows.length >= 1);
  assert.ok(
    dispatchRows.every((row) => row.event_type === "agent.dispatch" || row.event_type === "agent.review"),
    "agents 通道只允许派发与审批回传事件",
  );
  const comment = db.prepare(
    "SELECT author_type, author_id FROM comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(chatTaskId);
  assert.equal(comment.author_type, "agent");
  assert.equal(comment.author_id, "agent:worker-full");
  const review = db.prepare("SELECT decision, note FROM task_reviews WHERE task_id = ?").all(chatTaskId);
  assert.equal(review.at(-1).decision, "approved");
  db.close();

  await stream.close();
});
