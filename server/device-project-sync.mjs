import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sourceList(value) {
  if (!value) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("CODEX_TASKBOARD_DEVICE_SOURCES must be a JSON array");
  return parsed.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("Each device source must be an object");
    }
    const id = String(source.id ?? "").trim();
    const name = String(source.name ?? "").trim();
    const statePath = String(source.statePath ?? "").trim();
    const threadDbPath = String(
      source.threadDbPath ?? path.join(path.dirname(statePath), "state_5.sqlite"),
    ).trim();
    const sshHost = source.sshHost === undefined ? null : String(source.sshHost).trim();
    const hostname = String(source.hostname ?? sshHost ?? "").trim() || null;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) {
      throw new Error("Device source id must be a lowercase slug");
    }
    if (!name || !path.isAbsolute(statePath) || !path.isAbsolute(threadDbPath)) {
      throw new Error(`Device source '${id}' requires a name, absolute statePath, and absolute threadDbPath`);
    }
    return { id, name, hostname, statePath, threadDbPath, sshHost, local: source.local === true };
  });
}

export function resolveDeviceProjectSyncConfig(overrides = {}) {
  return {
    sources: sourceList(overrides.sources ?? process.env.CODEX_TASKBOARD_DEVICE_SOURCES),
    intervalMs: positiveInteger(
      overrides.intervalMs ?? process.env.CODEX_TASKBOARD_DEVICE_SYNC_INTERVAL_MS,
      5 * 60 * 1000,
    ),
  };
}

async function readSource(source) {
  if (!source.sshHost) return readFile(source.statePath, "utf8");
  const result = await execFileAsync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", source.sshHost, "cat", source.statePath],
    { timeout: 8_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return result.stdout;
}

function snapshotFromState(text) {
  const state = JSON.parse(text);
  const projectState = state?.["local-projects"];
  const projects = projectState && typeof projectState === "object" && !Array.isArray(projectState)
    ? Object.entries(projectState).flatMap(([id, project]) => {
    if (!project || typeof project !== "object" || Array.isArray(project)) return [];
    const workspacePath = Array.isArray(project.rootPaths)
      ? project.rootPaths.find((value) => typeof value === "string" && value.trim())
      : null;
    if (!workspacePath || !path.isAbsolute(workspacePath)) return [];
    const name = typeof project.name === "string" && project.name.trim()
      ? project.name.trim()
      : path.posix.basename(workspacePath.replaceAll("\\", "/"));
    return [{ id, name, workspacePath }];
      })
    : [];
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const assignments = state?.["thread-project-assignments"];
  const threadById = new Map();
  if (assignments && typeof assignments === "object" && !Array.isArray(assignments)) {
    for (const [threadId, assignment] of Object.entries(assignments)) {
      if (!/^[0-9a-f-]{36}$/i.test(threadId) || !assignment || typeof assignment !== "object") continue;
      const projectId = typeof assignment.projectId === "string" ? assignment.projectId.trim() : "";
      const workspacePath = [assignment.cwd, assignment.path]
        .find((value) => typeof value === "string" && path.isAbsolute(value)) ?? null;
      if (projectId && workspacePath && !projectById.has(projectId)) {
        projectById.set(projectId, {
          id: projectId,
          name: path.posix.basename(workspacePath.replaceAll("\\", "/")),
          workspacePath,
        });
      }
      threadById.set(threadId, { id: threadId, projectId: projectId || null, workspacePath });
    }
  }
  const projectless = Array.isArray(state?.["projectless-thread-ids"])
    ? state["projectless-thread-ids"]
    : [];
  for (const threadId of projectless) {
    if (/^[0-9a-f-]{36}$/i.test(threadId) && !threadById.has(threadId)) {
      threadById.set(threadId, { id: threadId, projectId: null, workspacePath: null });
    }
  }
  const pinned = new Set(Array.isArray(state?.["pinned-thread-ids"])
    ? state["pinned-thread-ids"].filter((id) => typeof id === "string")
    : []);
  return {
    projects: [...projectById.values()],
    threadRefs: [...threadById.values()].map((thread) => ({ ...thread, pinned: pinned.has(thread.id) })),
  };
}

const THREAD_COLUMNS = [
  "id", "title", "cwd", "created_at", "updated_at", "archived", "source", "thread_source",
];

function threadQuery(threadIds) {
  if (threadIds.length === 0) return null;
  const quotedIds = threadIds.map((id) => `'${id.replaceAll("'", "''")}'`).join(",");
  return `SELECT ${THREAD_COLUMNS.join(",")} FROM threads WHERE id IN (${quotedIds})`;
}

async function readThreads(source, threadRefs) {
  const query = threadQuery(threadRefs.map((thread) => thread.id));
  if (!query) return [];
  let rows;
  if (!source.sshHost) {
    const database = new DatabaseSync(source.threadDbPath, { readOnly: true });
    try {
      rows = database.prepare(query).all();
    } finally {
      database.close();
    }
  } else {
    const result = await execFileAsync(
      "ssh",
      [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", source.sshHost,
        "sqlite3", "-json", JSON.stringify(source.threadDbPath), JSON.stringify(query),
      ],
      { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
    );
    rows = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  }
  const refById = new Map(threadRefs.map((thread) => [thread.id, thread]));
  return rows.flatMap((row) => {
    const ref = refById.get(row.id);
    if (!ref) return [];
    return [{
      id: row.id,
      projectId: ref.projectId,
      workspacePath: ref.workspacePath ?? row.cwd ?? null,
      title: row.title,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      archived: Number(row.archived) === 1,
      pinned: ref.pinned,
      source: row.thread_source || row.source || "user",
    }];
  });
}

export function createDeviceProjectSync({ database, config, onChange = () => {} }) {
  let timer = null;
  let pending = null;

  async function refreshAll() {
    if (pending) return pending;
    pending = Promise.all(config.sources.map(async (source) => {
      try {
        const snapshot = snapshotFromState(await readSource(source));
        const threads = await readThreads(source, snapshot.threadRefs);
        const projects = snapshot.projects;
        database.syncDeviceProjects(source, projects);
        database.syncDeviceThreads(source, threads);
        return {
          deviceId: source.id,
          status: "online",
          projectCount: projects.length,
          taskCount: threads.length,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        database.recordDeviceSyncFailure(source, message);
        return { deviceId: source.id, status: "error", projectCount: 0, taskCount: 0, error: message };
      }
    })).then((results) => {
      onChange(results);
      return results;
    }).finally(() => {
      pending = null;
    });
    return pending;
  }

  function start() {
    if (timer || config.sources.length === 0) return;
    timer = setInterval(() => void refreshAll(), config.intervalMs);
    timer.unref();
  }

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refreshAll, start, close };
}
