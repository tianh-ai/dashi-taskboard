#!/usr/bin/env node
// Dashi Taskboard 常驻 Worker：
//   注册 → 心跳 → 轮询 @Agent/@本Agent 派发 → 原子领取（租约）→ 执行 → 回写 → 提交审批
// 认证：Basic(独立用户名:服务密钥) + 头 x-taskboard-client（与 /mcp/workbuddy 契约一致）。
// 用法：node scripts/task-worker.mjs --config ~/.Applications/dashi-taskboard/.data/worker.json
//       或全部通过 DASHI_WORKER_* 环境变量提供。

import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const WORKER_DEFAULTS = {
  pollIntervalMs: 10_000,
  heartbeatIntervalMs: 60_000,
  leaseSeconds: 900,
  eventLimit: 50,
  execTimeoutMs: 600_000,
};

export class WorkerError extends Error {
  constructor(message, code = "WORKER_ERROR") {
    super(message);
    this.code = code;
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkerError(`Missing required worker config '${field}'`, "INVALID_CONFIG");
  }
  return value.trim();
}

export function resolveWorkerConfig(raw, env = process.env) {
  const source = { ...raw };
  for (const [key, envKey] of [
    ["baseUrl", "DASHI_WORKER_URL"],
    ["username", "DASHI_WORKER_USERNAME"],
    ["secret", "DASHI_WORKER_SECRET"],
    ["name", "DASHI_WORKER_NAME"],
    ["device", "DASHI_WORKER_DEVICE"],
    ["exec", "DASHI_WORKER_EXEC"],
    ["statePath", "DASHI_WORKER_STATE"],
  ]) {
    if (source[key] === undefined && env[envKey] !== undefined) source[key] = env[envKey];
  }
  const config = {
    baseUrl: requiredString(source.baseUrl, "baseUrl").replace(/\/+$/, ""),
    username: requiredString(source.username, "username"),
    secret: requiredString(source.secret, "secret"),
    name: requiredString(source.name, "name"),
    device: typeof source.device === "string" && source.device.trim() ? source.device.trim() : "Worker",
    clientTag: typeof source.clientTag === "string" && source.clientTag.trim() ? source.clientTag.trim() : "task-worker",
    projects: Array.isArray(source.projects) && source.projects.length > 0 ? source.projects : null,
    capabilities: Array.isArray(source.capabilities) ? source.capabilities : [],
    concurrency: Number.isInteger(source.concurrency) ? source.concurrency : 1,
    pollIntervalMs: Number(source.pollIntervalMs ?? WORKER_DEFAULTS.pollIntervalMs),
    heartbeatIntervalMs: Number(Number(source.heartbeatIntervalMs ?? WORKER_DEFAULTS.heartbeatIntervalMs)),
    leaseSeconds: Number(source.leaseSeconds ?? WORKER_DEFAULTS.leaseSeconds),
    eventLimit: Number(source.eventLimit ?? WORKER_DEFAULTS.eventLimit),
    execTimeoutMs: Number(source.execTimeoutMs ?? WORKER_DEFAULTS.execTimeoutMs),
    statePath: typeof source.statePath === "string" && source.statePath ? source.statePath : null,
  };
  if (typeof source.exec === "string" && source.exec.trim()) {
    try {
      const argv = JSON.parse(source.exec);
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) {
        throw new Error("exec must be a JSON array of non-empty strings");
      }
      config.exec = argv;
    } catch (error) {
      throw new WorkerError(
        `Invalid exec config: ${error instanceof Error ? error.message : String(error)}`,
        "INVALID_CONFIG",
      );
    }
  }
  for (const field of ["pollIntervalMs", "heartbeatIntervalMs", "leaseSeconds", "eventLimit", "execTimeoutMs"]) {
    if (!Number.isFinite(config[field]) || config[field] <= 0) {
      throw new WorkerError(`Worker config '${field}' must be a positive number`, "INVALID_CONFIG");
    }
  }
  return config;
}

export function createMcpClient({ baseUrl, username, secret, clientTag, fetch: fetchImpl = globalThis.fetch }) {
  const authorization = `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
  async function call(toolName, args = {}) {
    let response;
    try {
      // 相对路径拼接，保留 baseUrl 的路径前缀（公网入口带 /wecom/app/... 前缀）。
      response = await fetchImpl(new URL("mcp/workbuddy", `${baseUrl.replace(/\/+$/, "")}/`), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization,
          "x-taskboard-client": clientTag,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
      });
    } catch (error) {
      throw new WorkerError(
        `Cannot reach taskboard at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        "SERVICE_UNAVAILABLE",
      );
    }
    const text = await response.text();
    let message = null;
    try {
      message = text ? JSON.parse(text) : null;
    } catch {
      if (text.startsWith("event:")) {
        const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
        message = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
      }
    }
    if (!response.ok) {
      throw new WorkerError(
        message?.error?.message ?? `MCP ${toolName} failed with HTTP ${response.status}`,
        message?.error?.code ?? `HTTP_${response.status}`,
      );
    }
    const payload = message?.result?.content?.[0]?.text;
    let parsed = null;
    try {
      parsed = payload ? JSON.parse(payload) : null;
    } catch {
      throw new WorkerError(`MCP ${toolName} returned an unreadable payload`, "INVALID_RESPONSE");
    }
    if (parsed?.error) {
      throw new WorkerError(parsed.error.message ?? "tool error", parsed.error.code ?? "TOOL_ERROR");
    }
    return parsed;
  }
  return { call };
}

function runExec(argv, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout.slice(0, 100_000), stderr: stderr.slice(0, 20_000) });
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      stderr += String(error);
      finish(-1, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export function createTaskWorker(config, deps = {}) {
  const log = deps.log ?? ((message) => console.log(`${new Date().toISOString()} ${message}`));
  const mcp = deps.mcp ?? createMcpClient(config);
  const delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const execRunner = deps.execRunner ?? runExec;

  async function register() {
    const args = {
      name: config.name,
      device: config.device,
      capabilities: config.capabilities,
      concurrency: config.concurrency,
    };
    if (config.projects) args.projects = config.projects;
    const result = await mcp.call("dashi_agent_register", args);
    log(`registered as ${result.agent.id} (${result.agent.name}·${result.agent.device}) online=${result.agent.online}`);
    return result.agent;
  }

  async function heartbeat() {
    const result = await mcp.call("dashi_agent_heartbeat", {});
    return result.agent;
  }

  async function executeTask(dispatch, task) {
    if (config.exec) {
      const execution = await execRunner(config.exec, {
        DASHI_TASK_ID: task.id,
        DASHI_TASK_TITLE: task.title ?? "",
        DASHI_TASK_BODY: dispatch.body ?? "",
        DASHI_PROJECT_ID: dispatch.projectId,
        DASHI_MESSAGE_ID: dispatch.messageId,
        DASHI_WORKER: config.username,
      }, config.execTimeoutMs);
      const output = execution.stdout.trim() || execution.stderr.trim() || "(无输出)";
      const status = execution.code === 0 ? "执行完成" : `执行退出码 ${execution.code}`;
      return { summary: `【执行结果】${status}\n\n${output}`, ok: execution.code === 0 };
    }
    const detail = await mcp.call("dashi_get_task", { taskId: task.id });
    const latest = detail.task;
    return {
      summary: [
        "【执行结果】已由常驻 Worker 处理。",
        "",
        `- 任务：${latest.title}（${latest.identifier ?? latest.id}）`,
        `- 请求：${dispatch.body}`,
        `- 状态：${latest.status}`,
        "- 剩余风险：本 Worker 为回写型执行器，复杂改动仍需管理员审批后跟进。",
      ].join("\n"),
      ok: true,
    };
  }

  async function handleDispatch(dispatch) {
    if (!dispatch.taskId) {
      // 兼容早期无 taskId 的历史派发事件：没有可领取的任务，直接跳过。
      log(`dispatch without taskId (message ${dispatch.messageId}); skipping`);
      return { status: "skipped", reason: "NO_TASK_ID" };
    }
    if (config.projects && !config.projects.includes(dispatch.projectId)) {
      return { status: "skipped", reason: `project ${dispatch.projectId} not in worker scope` };
    }
    let claim;
    try {
      claim = await mcp.call("dashi_claim_task", {
        taskId: dispatch.taskId,
        leaseSeconds: Math.max(30, Math.round(config.leaseSeconds)),
      });
    } catch (error) {
      if (error.code === "LEASE_HELD" || error.code === "TASK_NOT_CLAIMABLE") {
        // LEASE_HELD：其他 Worker 持有租约；TASK_NOT_CLAIMABLE：任务已被处理（如 in_review）。
        // 两者都说明本 Worker 无需重复执行，重放派发事件时保持幂等。
        log(`dispatch ${dispatch.taskId} not claimable (${error.code}); skipping`);
        return { status: "skipped", reason: error.code };
      }
      throw error;
    }
    const task = claim.task;
    log(`claimed ${task.id}「${task.title}」 (tookOver=${claim.tookOver}) lease→${claim.lease.expiresAt}`);

    const renewTimer = setInterval(() => {
      mcp.call("dashi_renew_task_lease", {
        taskId: task.id,
        leaseSeconds: Math.max(30, Math.round(config.leaseSeconds)),
      }).then((result) => {
        log(`renewed lease on ${task.id} → ${result.lease.expiresAt}`);
      }).catch((error) => {
        log(`lease renewal failed on ${task.id}: ${error.message}`);
      });
    }, Math.max(10_000, (config.leaseSeconds * 1000) / 3));

    try {
      const execution = await executeTask(dispatch, task);
      const comment = await mcp.call("dashi_add_comment", { taskId: task.id, body: execution.summary });
      await mcp.call("dashi_post_project_message", {
        projectId: dispatch.projectId,
        body: `${claim.tookOver ? "【接管完成】" : "【完成】"}${config.name}·${config.device} 已处理「${task.title}」，已提交审批。`,
        kind: "progress",
        taskId: task.id,
      });
      const submitted = await mcp.call("dashi_submit_for_review", {
        taskId: task.id,
        version: comment.task?.version ?? task.version,
      });
      log(`submitted ${task.id} for review (status=${submitted.task.status})`);
      return { status: "done", task: submitted.task, execution };
    } catch (error) {
      log(`execution failed on ${task.id}: ${error.message}; releasing`);
      try {
        await mcp.call("dashi_release_task", { taskId: task.id, reason: `Worker 执行失败：${error.message}` });
      } catch (releaseError) {
        log(`release after failure also failed: ${releaseError.message}`);
      }
      return { status: "failed", reason: error.message };
    } finally {
      clearInterval(renewTimer);
    }
  }

  async function pollOnce(state) {
    const result = await mcp.call("dashi_agent_events", {
      after: state.cursor,
      limit: Math.min(200, Math.max(1, Math.round(config.eventLimit))),
    });
    const outcomes = [];
    for (const event of result.events) {
      if (event.eventType === "agent.dispatch") {
        log(`dispatch event #${event.sequence} for task ${event.payload.taskId} (${event.payload.anyAgent ? "@Agent" : "定向"})`);
        outcomes.push(await handleDispatch(event.payload));
        continue;
      }
      if (event.eventType === "agent.review" && event.payload.agentId === config.username) {
        if (event.payload.decision === "changes_requested") {
          // 管理员驳回：作为新派发重新领取执行（每轮重做都由人类审批触发，不会失控循环）。
          log(`review event #${event.sequence}: task ${event.payload.taskId} returned; re-running`);
          outcomes.push(await handleDispatch({
            taskId: event.payload.taskId,
            projectId: event.payload.projectId,
            messageId: null,
            body: `审批驳回：${event.payload.note ?? "（无备注）"}。请按批注修改后重新提审。`,
            anyAgent: false,
            targets: [],
          }));
        } else {
          log(`review event #${event.sequence}: task ${event.payload.taskId} approved`);
        }
      }
    }
    if (result.nextCursor > state.cursor) {
      state.cursor = result.nextCursor;
      await deps.persistState?.(state);
    }
    return outcomes;
  }

  return { register, heartbeat, handleDispatch, pollOnce, mcp, log };
}

export async function loadState(statePath) {
  if (!statePath) return { cursor: 0 };
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (Number.isSafeInteger(parsed.cursor) && parsed.cursor >= 0) return { cursor: parsed.cursor };
  } catch {
    // 首次运行或状态文件损坏：从 0 开始重放，重复派发会被 LEASE_HELD 幂等跳过。
  }
  return { cursor: 0 };
}

export async function runWorker(config, { signal, worker } = {}) {
  const instance = worker ?? createTaskWorker(config);
  const state = await loadState(config.statePath);
  const persistState = config.statePath
    ? async (next) => {
      await writeFile(config.statePath, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    }
    : undefined;
  const bound = {
    ...instance,
    pollOnce: (current) => instance.pollOnce(current),
  };
  if (persistState) await persistState(state);

  await instance.register();
  const heartbeatTimer = setInterval(() => {
    instance.heartbeat().catch((error) => instance.log(`heartbeat failed: ${error.message}`));
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
  };
  signal?.addEventListener("abort", stop);

  try {
    while (!stopped) {
      try {
        await instance.pollOnce(state);
        if (persistState) await persistState(state);
      } catch (error) {
        instance.log(`poll failed: ${error.message}`);
      }
      if (stopped) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, config.pollIntervalMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  } finally {
    stop();
  }
  return state;
}

async function main() {
  const args = process.argv.slice(2);
  let configPath = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--config" && args[index + 1]) configPath = args[index + 1];
  }
  let raw = {};
  if (configPath) {
    try {
      raw = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      console.error(`无法读取 Worker 配置 ${configPath}: ${error.message}`);
      process.exit(2);
    }
  }
  const config = resolveWorkerConfig(raw);
  if (!config.statePath && configPath) {
    config.statePath = path.join(path.dirname(configPath), `${path.basename(configPath, ".json")}-state.json`);
  }
  const controller = new AbortController();
  for (const signalName of ["SIGINT", "SIGTERM"]) {
    process.on(signalName, () => controller.abort());
  }
  await runWorker(config, { signal: controller.signal });
}

if (process.argv[1]) {
  // 判断是否作为脚本直接运行：argv 可能经符号链接（如 /Users → /Volumes）且
  // macOS 对中文路径做 NFD 规范化，直接字符串比较不可靠，统一取真实路径比较。
  let invokedScript = null;
  try {
    invokedScript = realpathSync(process.argv[1]).normalize("NFC");
  } catch {
    invokedScript = null;
  }
  const thisScript = fileURLToPath(import.meta.url).normalize("NFC");
  if (invokedScript === thisScript) {
    main().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  }
}
