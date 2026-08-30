#!/usr/bin/env node
// Dashi Taskboard 常驻 Worker：
//   注册 → 心跳 → 轮询 @Agent/@本Agent 派发 → 原子领取（租约）→ 执行 → 回写 → 提交审批
// 认证：Basic(独立用户名:服务密钥) + 头 x-taskboard-client（与 /mcp/workbuddy 契约一致）。
// 用法：node scripts/task-worker.mjs --config ~/.Applications/dashi-taskboard/.data/worker.json
//       或全部通过 DASHI_WORKER_* 环境变量提供。

import { readFile, writeFile, rename } from "node:fs/promises";
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

// 派发处理中不可恢复的服务端错误码：跳过该事件并推进游标（毒事件不得卡死轮询）。
// AGENT_NOT_FOUND 不在此列：那是服务端 agent 记录丢失，重注册即可自愈，必须重试而非丢弃。
// 其余错误（网络、租约容量等）同样视为可恢复：游标停在该事件之前，下一轮只重试它。
const UNRECOVERABLE_EVENT_ERRORS = new Set([
  "TASK_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "INVALID_FIELD",
]);

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

// workspaceMap：projectId → 本机绝对工作区。支持对象或 JSON 字符串（env 注入）。
function parseWorkspaceMap(value) {
  if (!value) return null;
  let map = value;
  if (typeof value === "string") {
    try {
      map = JSON.parse(value);
    } catch {
      throw new WorkerError("Invalid workspaceMap config: must be a JSON object", "INVALID_CONFIG");
    }
  }
  if (typeof map !== "object" || Array.isArray(map) || Object.values(map).some((v) => typeof v !== "string")) {
    throw new WorkerError("Invalid workspaceMap config: must map projectId → absolute path", "INVALID_CONFIG");
  }
  return map;
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
    ["workspaceMap", "DASHI_WORKER_WORKSPACE_MAP"],
    ["defaultWorkspace", "DASHI_WORKER_DEFAULT_WORKSPACE"],
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
    workspaceMap: parseWorkspaceMap(source.workspaceMap),
    defaultWorkspace: typeof source.defaultWorkspace === "string" && source.defaultWorkspace.trim()
      ? source.defaultWorkspace.trim()
      : null,
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

function runExec(argv, env, timeoutMs, input = "", cwd = undefined, runnerControl = null) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (runnerControl) runnerControl.kill = () => child.kill("SIGKILL");
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
    child.stdin.on("error", () => {});
    child.stdin.end(input);
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

  async function executeTask(dispatch, task, runnerControl = null) {
    if (config.exec) {
      const workspace = config.workspaceMap?.[dispatch.projectId] ?? config.defaultWorkspace ?? undefined;
      if (workspace === undefined) {
        // 工作区守卫：未映射的项目绝不能落到 Worker 进程的当前目录
        // （那可能是 dashi-taskboard 仓库本身）。
        return {
          summary: `【执行失败】项目 ${dispatch.projectId} 未配置工作区映射（workspaceMap），已拒绝执行。`,
          ok: false,
          refused: true,
        };
      }
      const prompt = [
        "你是 Dashi Taskboard 的执行 Agent。请在给定工作区完成下列任务，以可验证结果为目标。",
        "不要自行把任务标记为完成或审批；常驻 Worker 会负责回写和提交人工审核。",
        `项目：${dispatch.projectId}`,
        `任务：${task.title ?? task.id}`,
        `任务 ID：${task.id}`,
        `员工请求：${dispatch.body ?? "（无）"}`,
        task.description ? `任务说明：\n${task.description}` : "",
        "完成后请简洁报告：实际改动、验证结果、剩余风险。",
      ].filter(Boolean).join("\n\n");
      const execution = await execRunner(config.exec, {
        DASHI_TASK_ID: task.id,
        DASHI_TASK_TITLE: task.title ?? "",
        DASHI_TASK_BODY: dispatch.body ?? "",
        DASHI_PROJECT_ID: dispatch.projectId,
        DASHI_MESSAGE_ID: dispatch.messageId,
        DASHI_WORKER: config.username,
      }, config.execTimeoutMs, prompt, workspace, runnerControl);
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
        return {
          status: error.code === "LEASE_HELD" ? "deferred" : "skipped",
          reason: error.code,
        };
      }
      throw error;
    }
    const task = claim.task;
    log(`claimed ${task.id}「${task.title}」 (tookOver=${claim.tookOver}) lease→${claim.lease.expiresAt}`);

    // 租约丢失感知：LEASE_NOT_HELD 意味着租约已被接管/清理，
    // 必须立即终止本地 Runner 子进程并禁止一切回写（避免与接管者矛盾/双写）。
    let leaseLost = false;
    const runnerControl = { kill: () => {} };
    const renewTimer = setInterval(() => {
      mcp.call("dashi_renew_task_lease", {
        taskId: task.id,
        leaseSeconds: Math.max(30, Math.round(config.leaseSeconds)),
      }).then((result) => {
        log(`renewed lease on ${task.id} → ${result.lease.expiresAt}`);
      }).catch((error) => {
        if (error.code === "LEASE_NOT_HELD") {
          if (!leaseLost) runnerControl.kill();
          leaseLost = true;
          log(`lease on ${task.id} lost (taken over); runner killed, writeback skipped`);
        } else {
          log(`lease renewal failed on ${task.id}: ${error.message}`);
        }
      });
    }, Math.max(10_000, (config.leaseSeconds * 1000) / 3));

    try {
      const execution = await executeTask(dispatch, task, runnerControl);
      if (leaseLost) {
        return { status: "aborted", reason: "LEASE_LOST", execution };
      }
      if (!execution.ok) {
        // Runner 失败/拒绝执行：失败摘要写入任务与群聊，释放任务回队列，
        // 绝不把失败成果提交 in_review。
        await mcp.call("dashi_add_comment", { taskId: task.id, body: execution.summary });
        await mcp.call("dashi_post_project_message", {
          projectId: dispatch.projectId,
          body: `【执行失败】${config.name}·${config.device} 未能完成「${task.title}」，任务已退回队列。\n\n${execution.summary}`,
          kind: "progress",
          taskId: task.id,
        });
        try {
          await mcp.call("dashi_release_task", { taskId: task.id, reason: `Runner 执行失败：${execution.summary.slice(0, 200)}` });
        } catch (releaseError) {
          log(`release after runner failure failed: ${releaseError.message}`);
        }
        if (execution.refused) {
          // 工作区未映射是配置错误，重试无意义：不滞留 pending。
          return { status: "refused", reason: "NO_WORKSPACE_MAPPING", execution };
        }
        return { status: "failed", reason: "RUNNER_FAILED", execution };
      }
      const comment = await mcp.call("dashi_add_comment", { taskId: task.id, body: execution.summary });
      await mcp.call("dashi_post_project_message", {
        projectId: dispatch.projectId,
        body: `${claim.tookOver ? "【接管完成】" : "【完成】"}${config.name}·${config.device} 已处理「${task.title}」，已提交审批。`,
        kind: "progress",
        taskId: task.id,
      });
      // 提审前取最新 version 重试一次：执行期间管理员的编辑不应使成果作废。
      const submitWithLatestVersion = async () => {
        const latest = await mcp.call("dashi_get_task", { taskId: task.id });
        return mcp.call("dashi_submit_for_review", { taskId: task.id, version: latest.task.version });
      };
      let submitted;
      try {
        submitted = await submitWithLatestVersion();
      } catch (error) {
        if (error.code !== "VERSION_CONFLICT") throw error;
        submitted = await submitWithLatestVersion();
      }
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
    if (!Array.isArray(state.pending)) state.pending = [];
    let after = state.cursor;
    let result = await mcp.call("dashi_agent_events", {
      after,
      limit: Math.min(200, Math.max(1, Math.round(config.eventLimit))),
    });
    // 服务端事件库重建后 sequence 从更小值重新开始：检测游标回退，
    // 归零重放并重注册（重放幂等：已处理任务会 TASK_NOT_CLAIMABLE 跳过）。
    if (result.nextCursor < state.cursor) {
      log(`event cursor moved backwards (${state.cursor} → ${result.nextCursor}); server event log reset; replaying from 0`);
      state.cursor = 0;
      await deps.persistState?.(state);
      try {
        await register();
      } catch (error) {
        log(`re-register after cursor reset failed: ${error.message}`);
      }
      result = await mcp.call("dashi_agent_events", {
        after: 0,
        limit: Math.min(200, Math.max(1, Math.round(config.eventLimit))),
      });
    }
    const outcomes = [];
    let blocked = false;
    for (const event of result.events) {
      let outcome = null;
      try {
        if (event.eventType === "agent.dispatch") {
          if (!state.pending.some((item) => item.sequence === event.sequence)) {
            state.pending.push({ sequence: event.sequence, dispatch: event.payload });
            await deps.persistState?.(state);
          }
        } else if (event.eventType === "agent.review" && event.payload.agentId === config.username) {
          if (event.payload.decision === "changes_requested") {
            // 管理员驳回：作为新派发重新领取执行（每轮重做都由人类审批触发，不会失控循环）。
            log(`review event #${event.sequence}: task ${event.payload.taskId} returned; re-running`);
            outcome = await handleDispatch({
              taskId: event.payload.taskId,
              projectId: event.payload.projectId,
              messageId: null,
              body: `审批驳回：${event.payload.note ?? "（无备注）"}。请按批注修改后重新提审。`,
              anyAgent: false,
              targets: [],
            });
          } else {
            log(`review event #${event.sequence}: task ${event.payload.taskId} approved`);
          }
        }
      } catch (error) {
        if (error.code === "AGENT_NOT_FOUND") {
          // 服务端 agent 记录丢失：重注册后下一轮重试本事件（游标停在事件前，派发不丢）。
          log(`agent record missing on server; re-registering`);
          try {
            await register();
          } catch (registerError) {
            log(`re-register failed: ${registerError.message}`);
          }
          blocked = true;
          break;
        }
        if (UNRECOVERABLE_EVENT_ERRORS.has(error.code)) {
          // 毒事件：跳过并推进游标，绝不卡死后续派发。
          log(`event #${event.sequence} unrecoverable (${error.code}); skipping`);
          outcome = { status: "skipped", reason: error.code };
        } else {
          // 可恢复错误（网络/租约容量等）：游标停在本事件之前，下一轮只重试它。
          log(`event #${event.sequence} failed (${error.code ?? error.message}); will retry next poll`);
          blocked = true;
          break;
        }
      }
      if (outcome) outcomes.push(outcome);
      // 派发先持久化到 pending，再推进事件游标。即使进程此刻崩溃，任务也不会丢。
      if (event.sequence > state.cursor) {
        state.cursor = event.sequence;
        await deps.persistState?.(state);
      }
    }
    if (!blocked && result.nextCursor > state.cursor) {
      state.cursor = result.nextCursor;
      await deps.persistState?.(state);
    }
    const remaining = [];
    for (const item of state.pending) {
      let outcome;
      try {
        log(`pending dispatch #${item.sequence} for task ${item.dispatch.taskId} (${item.dispatch.anyAgent ? "@Agent" : "定向"})`);
        outcome = await handleDispatch(item.dispatch);
      } catch (error) {
        if (error.code === "AGENT_NOT_FOUND") {
          try { await register(); } catch {}
        }
        if (UNRECOVERABLE_EVENT_ERRORS.has(error.code)) {
          // 毒派发（任务/项目已删除、负载非法）：丢弃，不得无限重试。
          log(`pending dispatch #${item.sequence} unrecoverable (${error.code}); dropping`);
          outcomes.push({ status: "skipped", reason: error.code });
          continue;
        }
        log(`pending dispatch #${item.sequence} failed (${error.code ?? error.message}); retaining`);
        remaining.push(item);
        continue;
      }
      outcomes.push(outcome);
      if (outcome.status === "deferred" || outcome.status === "failed" || outcome.status === "aborted") {
        remaining.push(item);
      }
    }
    state.pending = remaining;
    await deps.persistState?.(state);
    return outcomes;
  }

  return { register, heartbeat, handleDispatch, pollOnce, mcp, log };
}

export async function loadState(statePath) {
  if (!statePath) return { cursor: 0, pending: [] };
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (Number.isSafeInteger(parsed.cursor) && parsed.cursor >= 0) {
      return { cursor: parsed.cursor, pending: Array.isArray(parsed.pending) ? parsed.pending : [] };
    }
  } catch {
    // 首次运行或状态文件损坏：从 0 开始重放，重复派发会被 LEASE_HELD 幂等跳过。
  }
  return { cursor: 0, pending: [] };
}

export async function runWorker(config, { signal, worker } = {}) {
  const instance = worker ?? createTaskWorker(config);
  const state = await loadState(config.statePath);
  const persistState = config.statePath
    ? async (next) => {
      // 原子写：断电/崩溃时的半写状态文件会把游标悄悄归零，必须 temp+rename。
      const tempPath = `${config.statePath}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(tempPath, config.statePath);
    }
    : undefined;
  if (persistState) await persistState(state);

  const ensureRegistered = async (error) => {
    // 服务端 agent 记录丢失（DB 重建/清理）自愈：重新注册，事件轮询下轮恢复。
    if (error?.code !== "AGENT_NOT_FOUND") return;
    instance.log("agent record missing on server; re-registering");
    try {
      await instance.register();
    } catch (registerError) {
      instance.log(`re-register failed: ${registerError.message}`);
    }
  };
  await instance.register();
  const heartbeatTimer = setInterval(() => {
    instance.heartbeat().catch(async (error) => {
      instance.log(`heartbeat failed: ${error.message}`);
      await ensureRegistered(error);
    });
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
        await ensureRegistered(error);
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
