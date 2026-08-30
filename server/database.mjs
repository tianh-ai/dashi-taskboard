import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function taskFromRow(row) {
  const developmentContext = row.worktree_path
    ? { type: "worktree", path: row.worktree_path, branch: row.worktree_branch }
    : row.git_branch
      ? { type: "branch", branch: row.git_branch }
      : null;
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    workflowId: row.workflow_id,
    developmentContext,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskReviewFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    decision: row.decision,
    note: row.note,
    reviewer: {
      type: row.reviewer_type,
      id: row.reviewer_id,
      name: row.reviewer_name,
      avatarUrl: row.reviewer_avatar_url,
    },
    createdAt: row.created_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
  };
}

function commentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    issueCount: Number(row.issue_count ?? 0),
    hiddenAt: row.hidden_at ?? null,
    version: Number(row.version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectMemberFromRow(row) {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    userName: row.user_name,
    userAvatarUrl: row.user_avatar_url,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectMessageFromRow(row) {
  return {
    sequence: Number(row.sequence),
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    replyToMessageId: row.reply_to_message_id,
    kind: row.kind,
    body: row.body,
    mentions: JSON.parse(row.mentions),
    author: {
      type: row.author_type,
      id: row.author_id,
      name: row.author_name,
      avatarUrl: row.author_avatar_url,
    },
    createdAt: row.created_at,
  };
}

function workflowWorkspaceFromRow(row) {
  return {
    projectId: row.project_id,
    workspace: JSON.parse(row.workspace),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function aiChatRunFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function aiChatThreadFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    origin: {
      projectId: row.origin_project_id,
      projectName: row.origin_project_name,
      workspacePath: row.origin_workspace_path,
      ...(row.origin_issue_id ? { issueId: row.origin_issue_id } : {}),
      ...(row.origin_issue_identifier ? { issueIdentifier: row.origin_issue_identifier } : {}),
    },
    codexThreadId: row.codex_thread_id,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sandbox: row.sandbox,
    currentRun: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aiChatEventFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    role: row.role,
    content: row.content,
    data: row.data === null ? null : JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

function projectPrefix(projectId) {
  const prefix = projectId.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return (prefix || "TASK").slice(0, 12);
}

export class TaskboardDatabase {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.interruptAbandonedAiChatRuns();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        hidden_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        workflow_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        user_avatar_url TEXT,
        role TEXT NOT NULL CHECK (role IN ('member', 'manager', 'admin')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS project_members_user
        ON project_members(user_id, project_id);

      CREATE TABLE IF NOT EXISTS project_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        reply_to_message_id TEXT REFERENCES project_messages(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'progress', 'decision')),
        body TEXT NOT NULL,
        mentions TEXT NOT NULL DEFAULT '[]',
        author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS project_messages_project_sequence
        ON project_messages(project_id, sequence);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        device TEXT NOT NULL DEFAULT '',
        capabilities TEXT NOT NULL DEFAULT '[]',
        projects TEXT NOT NULL DEFAULT '[]',
        concurrency INTEGER NOT NULL DEFAULT 1 CHECK (concurrency >= 1 AND concurrency <= 16),
        last_heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_requests (
        message_id TEXT PRIMARY KEY REFERENCES project_messages(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        dispatch_sequence INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        claimed_at TEXT NOT NULL,
        renewed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_leases_agent
        ON task_leases(agent_id, expires_at);

      CREATE TABLE IF NOT EXISTS integration_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        destination TEXT NOT NULL,
        event_type TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS integration_outbox_destination_sequence
        ON integration_outbox(destination, sequence);

      CREATE TABLE IF NOT EXISTS task_reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
        note TEXT,
        reviewer_type TEXT NOT NULL CHECK (reviewer_type IN ('user', 'agent')),
        reviewer_id TEXT NOT NULL,
        reviewer_name TEXT NOT NULL,
        reviewer_avatar_url TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_reviews_task_created
        ON task_reviews(task_id, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS workflow_workspaces (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        workspace TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
        ON ai_chat_runs(thread_id, started_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
        ON ai_chat_runs(thread_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ai_chat_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
        ON ai_chat_events(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS wecom_oauth_states (
        state TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS wecom_oauth_states_expiry
        ON wecom_oauth_states(expires_at);

      CREATE TABLE IF NOT EXISTS wecom_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        avatar_url TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS wecom_sessions_expiry
        ON wecom_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hostname TEXT,
        status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'error')),
        thread_count INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_device_mappings (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        codex_project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (device_id, codex_project_id),
        UNIQUE (project_id, device_id)
      );

      CREATE INDEX IF NOT EXISTS project_device_mappings_project
        ON project_device_mappings(project_id, device_id);

      CREATE TABLE IF NOT EXISTS codex_thread_mappings (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        codex_thread_id TEXT NOT NULL,
        codex_project_id TEXT,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (device_id, codex_thread_id)
      );

      CREATE INDEX IF NOT EXISTS codex_thread_mappings_task
        ON codex_thread_mappings(task_id, device_id);

      CREATE INDEX IF NOT EXISTS codex_thread_mappings_thread
        ON codex_thread_mappings(codex_thread_id);

    `);

    const deviceColumns = this.database.prepare("PRAGMA table_info(devices)").all();
    if (!deviceColumns.some((column) => column.name === "thread_count")) {
      this.database.exec("ALTER TABLE devices ADD COLUMN thread_count INTEGER NOT NULL DEFAULT 0");
    }
    const agentColumns = this.database.prepare("PRAGMA table_info(agents)").all();
    if (!agentColumns.some((column) => column.name === "projects")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN projects TEXT NOT NULL DEFAULT '[]'");
    }

    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }
    if (!projectColumns.some((column) => column.name === "hidden_at")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN hidden_at TEXT");
    }
    if (!projectColumns.some((column) => column.name === "version")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    }

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    if (hasLinkedThreadId) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, linked_thread_id)
      `);
      this.database.exec("ALTER TABLE tasks DROP COLUMN linked_thread_id");
    }
    if (!taskColumns.some((column) => column.name === "git_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "due_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_interval")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_unit")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_unit TEXT");
    }
    this.#migrateTaskStatuses();
    const migratedTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!migratedTaskColumns.some((column) => column.name === "creator_type")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'local-user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_name TEXT NOT NULL DEFAULT '本地用户'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_avatar_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_avatar_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "workflow_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN workflow_id TEXT");
    }
    this.database.exec(`
      UPDATE tasks
      SET creator_type = 'agent', creator_id = 'codex-agent', creator_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND version = 1 AND creator_id = 'local-user'
    `);
    const identityTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const assigneeMigrations = [
      ["assignee_type", "TEXT CHECK (assignee_type IN ('user', 'agent'))", "creator_type"],
      ["assignee_id", "TEXT", "creator_id"],
      ["assignee_name", "TEXT", "creator_name"],
      ["assignee_avatar_url", "TEXT", "creator_avatar_url"],
    ].filter(([column]) => !identityTaskColumns.some((current) => current.name === column));
    if (assigneeMigrations.length > 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [column, definition, source] of assigneeMigrations) {
          this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
          this.database.exec(`UPDATE tasks SET ${column} = ${source}`);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';
    `);

    const commentColumns = this.database.prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    this.database.exec(`
      UPDATE comments
      SET author_type = 'agent', author_id = 'codex-agent', author_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND author_id = 'local'
    `);
    this.database.exec(`
      UPDATE comments
      SET author_id = 'local-user'
      WHERE author_id = 'local'
    `);

    const hasTaskThreads = this.database.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
    `).get();
    if (hasTaskThreads) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, (
          SELECT task_threads.thread_id
          FROM task_threads
          WHERE task_threads.task_id = tasks.id
          ORDER BY
            CASE WHEN EXISTS (
              SELECT 1
              FROM comments
              WHERE comments.task_id = tasks.id
                AND comments.thread_id = task_threads.thread_id
            ) THEN 1 ELSE 0 END,
            task_threads.created_at DESC,
            task_threads.thread_id DESC
          LIMIT 1
        ))
        WHERE thread_id IS NULL
      `);
      this.database.exec("DROP TABLE task_threads");
    }

    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");

    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', 'Local', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
  }

  close() {
    this.database.close();
  }

  createWeComOAuthState(state, agentId, expiresAt) {
    const timestamp = now();
    this.database.prepare("DELETE FROM wecom_oauth_states WHERE expires_at <= ?").run(timestamp);
    this.database.prepare(`
      INSERT INTO wecom_oauth_states (state, agent_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(state, agentId, expiresAt, timestamp);
  }

  consumeWeComOAuthState(state, agentId) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT state, agent_id, expires_at
        FROM wecom_oauth_states
        WHERE state = ?
      `).get(state);
      this.database.prepare("DELETE FROM wecom_oauth_states WHERE state = ?").run(state);
      this.database.prepare("DELETE FROM wecom_oauth_states WHERE expires_at <= ?").run(timestamp);
      this.database.exec("COMMIT");
      return Boolean(row && row.agent_id === agentId && row.expires_at > timestamp);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createWeComSession(input) {
    const timestamp = now();
    this.database.prepare("DELETE FROM wecom_sessions WHERE expires_at <= ?").run(timestamp);
    this.database.prepare(`
      INSERT INTO wecom_sessions (
        id, agent_id, user_id, user_name, avatar_url,
        expires_at, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.agentId,
      input.userId,
      input.userName,
      input.avatarUrl,
      input.expiresAt,
      timestamp,
      timestamp,
    );
  }

  getWeComSession(id, agentId) {
    const timestamp = now();
    const row = this.database.prepare(`
      SELECT id, agent_id, user_id, user_name, avatar_url, expires_at
      FROM wecom_sessions
      WHERE id = ? AND agent_id = ? AND expires_at > ?
    `).get(id, agentId, timestamp);
    if (!row) return null;
    this.database.prepare(`
      UPDATE wecom_sessions SET last_seen_at = ? WHERE id = ?
    `).run(timestamp, id);
    return {
      id: row.id,
      agentId: row.agent_id,
      userId: row.user_id,
      userName: row.user_name,
      avatarUrl: row.avatar_url,
      expiresAt: row.expires_at,
    };
  }

  deleteWeComSession(id) {
    this.database.prepare("DELETE FROM wecom_sessions WHERE id = ?").run(id);
  }

  listDevices() {
    return this.database.prepare(`
      SELECT
        devices.id,
        devices.name,
        devices.hostname,
        devices.status,
        devices.thread_count,
        devices.last_seen_at,
        devices.last_error,
        devices.created_at,
        devices.updated_at,
        COUNT(project_device_mappings.codex_project_id) AS project_count
      FROM devices
      LEFT JOIN project_device_mappings ON project_device_mappings.device_id = devices.id
      GROUP BY devices.id
      ORDER BY devices.name, devices.id
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      status: row.status,
      projectCount: Number(row.project_count),
      taskCount: Number(row.thread_count),
      lastSeenAt: row.last_seen_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  syncDeviceProjects(device, projects) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO devices (
          id, name, hostname, status, last_seen_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, 'online', ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          hostname = excluded.hostname,
          status = 'online',
          last_seen_at = excluded.last_seen_at,
          last_error = NULL,
          updated_at = excluded.updated_at
      `).run(device.id, device.name, device.hostname, timestamp, timestamp, timestamp);

      const seenCodexProjectIds = [];
      for (const project of projects) {
        seenCodexProjectIds.push(project.id);
        const existingMapping = this.database.prepare(`
          SELECT
            mapping.project_id,
            (
              SELECT COUNT(*)
              FROM project_device_mappings AS sibling
              WHERE sibling.project_id = mapping.project_id
            ) AS mapping_count
          FROM project_device_mappings AS mapping
          WHERE mapping.device_id = ? AND mapping.codex_project_id = ?
        `).get(device.id, project.id);
        let projectId = existingMapping?.project_id;
        if (!projectId) {
          projectId = this.database.prepare(`
            SELECT projects.id
            FROM projects
            JOIN project_device_mappings ON project_device_mappings.project_id = projects.id
            WHERE projects.name = ?
            ORDER BY projects.created_at, projects.id
            LIMIT 1
          `).get(project.name)?.id;
        }
        if (!projectId) {
          const safeDeviceId = device.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "device";
          const safeCodexId = project.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || randomUUID();
          const baseId = `${safeDeviceId}-${safeCodexId}`.slice(0, 64).replace(/-+$/g, "");
          projectId = baseId;
          if (this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
            const suffix = randomUUID().slice(0, 8);
            projectId = `${baseId.slice(0, 55).replace(/-+$/g, "")}-${suffix}`;
          }
          this.database.prepare(`
            INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
            VALUES (?, ?, NULL, 1, ?, ?)
          `).run(projectId, project.name, timestamp, timestamp);
        }
        this.database.prepare(`
          INSERT INTO project_device_mappings (
            project_id, device_id, codex_project_id, project_name, workspace_path, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id, codex_project_id) DO UPDATE SET
            project_id = excluded.project_id,
            project_name = excluded.project_name,
            workspace_path = excluded.workspace_path,
            last_seen_at = excluded.last_seen_at
        `).run(projectId, device.id, project.id, project.name, project.workspacePath, timestamp);
        if (Number(existingMapping?.mapping_count) === 1) {
          this.database.prepare(`
            UPDATE projects
            SET name = ?, updated_at = ?
            WHERE id = ? AND name <> ?
          `).run(project.name, timestamp, projectId, project.name);
        }
        if (device.local === true) {
          this.database.prepare(`
            UPDATE projects
            SET workspace_path = ?, updated_at = ?
            WHERE id = ?
          `).run(project.workspacePath, timestamp, projectId);
        }
      }

      if (seenCodexProjectIds.length === 0) {
        this.database.prepare("DELETE FROM project_device_mappings WHERE device_id = ?").run(device.id);
      } else {
        const placeholders = seenCodexProjectIds.map(() => "?").join(", ");
        this.database.prepare(`
          DELETE FROM project_device_mappings
          WHERE device_id = ? AND codex_project_id NOT IN (${placeholders})
        `).run(device.id, ...seenCodexProjectIds);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  syncDeviceThreads(device, threads) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE devices
        SET thread_count = ?, updated_at = ?
        WHERE id = ?
      `).run(threads.length, timestamp, device.id);

      for (const thread of threads) {
        const projectId = thread.projectId
          ? this.database.prepare(`
              SELECT project_id
              FROM project_device_mappings
              WHERE device_id = ? AND codex_project_id = ?
            `).get(device.id, thread.projectId)?.project_id ?? "local"
          : "local";
        let taskId = this.database.prepare(`
          SELECT task_id
          FROM codex_thread_mappings
          WHERE device_id = ? AND codex_thread_id = ?
        `).get(device.id, thread.id)?.task_id;
        if (!taskId) {
          taskId = this.database.prepare(`
            SELECT task_id
            FROM codex_thread_mappings
            WHERE codex_thread_id = ?
            ORDER BY last_seen_at DESC, device_id
            LIMIT 1
          `).get(thread.id)?.task_id;
        }
        if (!taskId) {
          taskId = this.database.prepare(`
            SELECT id
            FROM tasks
            WHERE thread_id = ?
            ORDER BY created_at, id
            LIMIT 1
          `).get(thread.id)?.id;
        }

        const titleLine = String(thread.title ?? "").split(/\r?\n/, 1)[0].trim();
        const title = (titleLine || `Codex 任务 ${thread.id.slice(0, 8)}`).slice(0, 240);
        const status = thread.archived ? "done" : thread.pinned ? "in_progress" : "backlog";
        const sourceLabel = String(thread.source ?? "user").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
        const deviceLabel = `device:${device.id}`;
        const labels = ["codex", deviceLabel, ...(sourceLabel ? [`source:${sourceLabel}`] : [])];
        const createdAt = Number.isFinite(thread.createdAt)
          ? new Date(thread.createdAt * 1000).toISOString()
          : timestamp;
        const sourceUpdatedAt = Number.isFinite(thread.updatedAt)
          ? new Date(thread.updatedAt * 1000).toISOString()
          : timestamp;
        const description = [
          `从 ${device.name} 的 Codex 任务索引自动同步。`,
          "",
          `- Codex Thread：${thread.id}`,
          `- 设备：${device.name}`,
          `- 工作目录：${thread.workspacePath ?? "未分类"}`,
          `- 来源：${thread.source ?? "user"}`,
          `- Codex 更新时间：${sourceUpdatedAt}`,
        ].join("\n");

        if (!taskId) {
          const project = this.database.prepare(`
            SELECT id, next_task_number FROM projects WHERE id = ?
          `).get(projectId);
          if (!project) continue;
          taskId = randomUUID();
          let number = Number(project.next_task_number);
          let identifier = `${projectPrefix(project.id)}-${number}`;
          while (this.database.prepare("SELECT 1 FROM tasks WHERE identifier = ?").get(identifier)) {
            number += 1;
            identifier = `${projectPrefix(project.id)}-${number}`;
          }
          const sortOrder = Number(this.database.prepare(`
            SELECT COALESCE(MAX(sort_order), 0) AS maximum
            FROM tasks
            WHERE project_id = ? AND status = ? AND archived_at IS NULL
          `).get(projectId, status).maximum) + 1000;
          this.database.prepare(`
            UPDATE projects SET next_task_number = ?, updated_at = ? WHERE id = ?
          `).run(number + 1, timestamp, projectId);
          this.database.prepare(`
            INSERT INTO tasks (
              id, identifier, project_id, title, description, status, priority, labels,
              sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
              assignee_type, assignee_id, assignee_name, assignee_avatar_url,
              workflow_id, git_branch, worktree_path, worktree_branch,
              due_date, recurrence_interval, recurrence_unit,
              archived_at, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, 'agent', ?, ?, NULL,
              'agent', 'codex-agent', 'Codex Agent', NULL,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)
          `).run(
            taskId,
            identifier,
            projectId,
            title,
            description,
            status,
            JSON.stringify(labels),
            sortOrder,
            thread.id,
            `codex-device:${device.id}`,
            `Codex (${device.name})`,
            createdAt,
            sourceUpdatedAt,
          );
        } else {
          const existing = this.database.prepare(`
            SELECT project_id, labels, creator_id, version
            FROM tasks WHERE id = ?
          `).get(taskId);
          if (!existing) continue;
          const mergedLabels = [...new Set([...JSON.parse(existing.labels), ...labels])];
          if (existing.creator_id.startsWith("codex-device:") && Number(existing.version) === 1) {
            this.database.prepare(`
              UPDATE tasks
              SET project_id = ?, title = ?, description = ?, status = ?, labels = ?,
                  thread_id = ?, updated_at = ?
              WHERE id = ?
            `).run(
              projectId,
              title,
              description,
              status,
              JSON.stringify(mergedLabels),
              thread.id,
              sourceUpdatedAt,
              taskId,
            );
          } else if (mergedLabels.length !== JSON.parse(existing.labels).length) {
            this.database.prepare("UPDATE tasks SET labels = ? WHERE id = ?")
              .run(JSON.stringify(mergedLabels), taskId);
          }
        }

        this.database.prepare(`
          INSERT INTO codex_thread_mappings (
            task_id, device_id, codex_thread_id, codex_project_id, last_seen_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(device_id, codex_thread_id) DO UPDATE SET
            task_id = excluded.task_id,
            codex_project_id = excluded.codex_project_id,
            last_seen_at = excluded.last_seen_at
        `).run(taskId, device.id, thread.id, thread.projectId, timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordDeviceSyncFailure(device, message) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO devices (
        id, name, hostname, status, last_seen_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, 'error', NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        hostname = excluded.hostname,
        status = 'error',
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(device.id, device.name, device.hostname, message.slice(0, 500), timestamp, timestamp);
  }

  #projectDevices(projectId) {
    return this.database.prepare(`
      SELECT
        project_device_mappings.device_id,
        devices.name AS device_name,
        devices.hostname,
        devices.status,
        project_device_mappings.codex_project_id,
        project_device_mappings.workspace_path,
        project_device_mappings.last_seen_at
      FROM project_device_mappings
      JOIN devices ON devices.id = project_device_mappings.device_id
      WHERE project_device_mappings.project_id = ?
      ORDER BY devices.name, devices.id
    `).all(projectId).map((row) => ({
      deviceId: row.device_id,
      deviceName: row.device_name,
      hostname: row.hostname,
      status: row.status,
      codexProjectId: row.codex_project_id,
      workspacePath: row.workspace_path,
      lastSeenAt: row.last_seen_at,
    }));
  }

  #migrateTaskStatuses() {
    const tasksSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    if (
      tasksSql.includes("'in_review'")
      && tasksSql.includes("'blocked'")
      && tasksSql.includes("'canceled'")
    ) {
      return;
    }

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_status_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          sort_order REAL NOT NULL,
          thread_id TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_status_migration (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_status_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Task status migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  listProjects(hidden = "false") {
    const hiddenWhere = hidden === "true"
      ? "WHERE projects.hidden_at IS NOT NULL"
      : hidden === "all"
        ? ""
        : "WHERE projects.hidden_at IS NULL";
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.hidden_at,
        projects.version,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      ${hiddenWhere}
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.hidden_at,
        projects.version,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).all().map((row) => ({
      ...projectFromRow(row),
      devices: this.#projectDevices(row.id),
    }));
  }

  createProject(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(input.id, input.name, input.workspacePath, timestamp, timestamp);
      if (input.actor?.type === "user") {
        this.database.prepare(`
          INSERT INTO project_members (
            project_id, user_id, user_name, user_avatar_url, role, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'admin', ?, ?)
        `).run(
          input.id,
          input.actor.id,
          input.actor.name,
          input.actor.avatarUrl,
          timestamp,
          timestamp,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  listProjectMembers(projectId) {
    if (!this.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return this.database.prepare(`
      SELECT * FROM project_members
      WHERE project_id = ?
      ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
        user_name, user_id
    `).all(projectId).map(projectMemberFromRow);
  }

  getProjectMembership(projectId, userId) {
    const row = this.database.prepare(`
      SELECT * FROM project_members WHERE project_id = ? AND user_id = ?
    `).get(projectId, userId);
    return row ? projectMemberFromRow(row) : null;
  }

  upsertProjectMember(projectId, input) {
    if (!this.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_members (
        project_id, user_id, user_name, user_avatar_url, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET
        user_name = excluded.user_name,
        user_avatar_url = excluded.user_avatar_url,
        role = excluded.role,
        updated_at = excluded.updated_at
    `).run(
      projectId,
      input.userId,
      input.userName,
      input.userAvatarUrl,
      input.role,
      timestamp,
      timestamp,
    );
    return this.getProjectMembership(projectId, input.userId);
  }

  removeProjectMember(projectId, userId) {
    const current = this.getProjectMembership(projectId, userId);
    if (!current) {
      throw new ApiError(404, "PROJECT_MEMBER_NOT_FOUND", `Project member '${userId}' does not exist`);
    }
    this.database.prepare(`
      DELETE FROM project_members WHERE project_id = ? AND user_id = ?
    `).run(projectId, userId);
    return current;
  }

  listProjectMessages(projectId, after = 0, limit = 100) {
    if (!this.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return this.database.prepare(`
      SELECT * FROM project_messages
      WHERE project_id = ? AND sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(projectId, after, limit).map(projectMessageFromRow);
  }

  createProjectMessage(projectId, input) {
    if (!this.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    if (input.taskId) {
      const task = this.getTask(input.taskId);
      if (!task || task.projectId !== projectId) {
        throw new ApiError(400, "INVALID_TASK", "Linked task must belong to the same project");
      }
    }
    if (input.replyToMessageId) {
      const reply = this.database.prepare(`
        SELECT project_id FROM project_messages WHERE id = ?
      `).get(input.replyToMessageId);
      if (!reply || reply.project_id !== projectId) {
        throw new ApiError(400, "INVALID_REPLY", "Reply target must belong to the same project");
      }
    }
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO project_messages (
        id, project_id, task_id, reply_to_message_id, kind, body, mentions,
        author_type, author_id, author_name, author_avatar_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      input.taskId ?? null,
      input.replyToMessageId ?? null,
      input.kind ?? "message",
      input.body,
      JSON.stringify(input.mentions ?? []),
      input.actor.type,
      input.actor.id,
      input.actor.name,
      input.actor.avatarUrl,
      timestamp,
    );
    return projectMessageFromRow(
      this.database.prepare("SELECT * FROM project_messages WHERE id = ?").get(id),
    );
  }

  appendIntegrationEvent(destination, event) {
    const result = this.database.prepare(`
      INSERT INTO integration_outbox (
        destination, event_type, project_id, task_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      destination,
      event.type,
      event.projectId ?? null,
      event.taskId ?? null,
      JSON.stringify(event),
      event.at ?? now(),
    );
    return Number(result.lastInsertRowid);
  }

  listIntegrationEvents(destination, after = 0, limit = 100) {
    return this.database.prepare(`
      SELECT sequence, event_type, project_id, task_id, payload, created_at
      FROM integration_outbox
      WHERE destination = ? AND sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(destination, after, limit).map((row) => ({
      sequence: Number(row.sequence),
      eventType: row.event_type,
      projectId: row.project_id,
      taskId: row.task_id,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
    }));
  }

  ensureAgentRequestTask(projectId, message) {
    const existing = this.database.prepare(`
      SELECT task_id, dispatch_sequence FROM agent_requests WHERE message_id = ?
    `).get(message.id);
    if (existing) {
      return {
        task: this.getTask(existing.task_id),
        created: false,
        dispatchSequence: existing.dispatch_sequence === null
          ? null
          : Number(existing.dispatch_sequence),
      };
    }

    const threadId = `agent-request:${message.id}`;
    let taskId = this.findTaskIdByThreadId(threadId);
    let created = false;
    if (!taskId) {
      const title = message.body
        .replace(/@([\p{L}\p{N}_·\-.]{1,60})/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200) || "项目群聊 Agent 请求";
      const task = this.createTask({
        projectId,
        title,
        description: `来源：项目群聊\n消息ID：${message.id}\n发起人：${message.author.name}（${message.author.id}）\n\n${message.body}`,
        status: "todo",
        priority: "medium",
        labels: ["agent-request"],
        threadId,
        workflowId: null,
        developmentContext: null,
        dueDate: null,
        recurrence: null,
        actor: message.author,
        assignee: { type: "agent", id: "agent:dispatcher", name: "调度系统", avatarUrl: null },
      });
      taskId = task.id;
      created = true;
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_requests (message_id, task_id, dispatch_sequence, created_at)
      VALUES (?, ?, NULL, ?)
    `).run(message.id, taskId, now());
    return { task: this.getTask(taskId), created, dispatchSequence: null };
  }

  recordAgentRequestDispatch(messageId, sequence) {
    this.database.prepare(`
      UPDATE agent_requests SET dispatch_sequence = ?
      WHERE message_id = ? AND dispatch_sequence IS NULL
    `).run(sequence, messageId);
  }

  static AGENT_ONLINE_WINDOW_MS = 5 * 60 * 1000;

  agentFromRow(row, { at = Date.now() } = {}) {
    if (!row) return null;
    const heartbeatAt = Date.parse(row.last_heartbeat_at ?? "") || 0;
    const leaseRows = this.database.prepare(`
      SELECT task_id, expires_at FROM task_leases WHERE agent_id = ? AND expires_at > ?
    `).all(row.id, new Date(at).toISOString());
    return {
      id: row.id,
      name: row.name,
      device: row.device,
      capabilities: JSON.parse(row.capabilities),
      projects: JSON.parse(row.projects ?? "[]"),
      concurrency: row.concurrency,
      lastHeartbeatAt: row.last_heartbeat_at,
      online: at - heartbeatAt < TaskboardDatabase.AGENT_ONLINE_WINDOW_MS,
      activeLeases: leaseRows.map((lease) => ({
        taskId: lease.task_id,
        expiresAt: lease.expires_at,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertAgent(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO agents (id, name, device, capabilities, projects, concurrency, last_heartbeat_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        device = excluded.device,
        capabilities = excluded.capabilities,
        projects = excluded.projects,
        concurrency = excluded.concurrency,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.name,
      input.device ?? "",
      JSON.stringify([...new Set(input.capabilities ?? [])]),
      JSON.stringify([...new Set(input.projects ?? [])]),
      input.concurrency ?? 1,
      timestamp,
      timestamp,
      timestamp,
    );
    return this.getAgent(input.id);
  }

  heartbeatAgent(id, { at = now() } = {}) {
    const result = this.database.prepare(`
      UPDATE agents SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?
    `).run(at, at, id);
    if (result.changes === 0) return null;
    return this.getAgent(id);
  }

  getAgent(id) {
    return this.agentFromRow(
      this.database.prepare("SELECT * FROM agents WHERE id = ?").get(id),
    );
  }

  findAgentByName(name) {
    return this.findAgentsByMention(name)[0] ?? null;
  }

  findAgentsByMention(name) {
    const lowered = String(name ?? "").trim().toLowerCase();
    if (!lowered) return [];
    const rows = this.database.prepare("SELECT * FROM agents").all();
    const exactId = rows.find((candidate) => candidate.id.toLowerCase() === lowered);
    if (exactId) return [this.agentFromRow(exactId)];
    const exactDisplay = rows.find((candidate) => (
      `${candidate.name}·${candidate.device}`.toLowerCase() === lowered
    ));
    if (exactDisplay) return [this.agentFromRow(exactDisplay)];
    return rows
      .filter((candidate) => candidate.name.toLowerCase() === lowered)
      .map((candidate) => this.agentFromRow(candidate));
  }

  listAgents() {
    return this.database.prepare("SELECT * FROM agents ORDER BY created_at")
      .all()
      .map((row) => this.agentFromRow(row));
  }

  getTaskLease(taskId) {
    const row = this.database.prepare("SELECT * FROM task_leases WHERE task_id = ?").get(taskId);
    return row ? {
      taskId: row.task_id,
      agentId: row.agent_id,
      claimedAt: row.claimed_at,
      renewedAt: row.renewed_at,
      expiresAt: row.expires_at,
    } : null;
  }

  claimTask(taskId, agentId, leaseSeconds) {
    const task = this.getTask(taskId);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    }
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new ApiError(404, "AGENT_NOT_FOUND", `Agent '${agentId}' is not registered`);
    }
    const timestamp = now();
    const expiresAt = new Date(Date.parse(timestamp) + leaseSeconds * 1000).toISOString();
    const previousLease = this.getTaskLease(taskId);
    if (previousLease?.agentId === agentId && previousLease.expiresAt > timestamp) {
      return {
        task,
        lease: previousLease,
        tookOver: false,
        previousAgentId: agentId,
        replayed: true,
      };
    }
    if (agent.activeLeases.length >= agent.concurrency) {
      throw new ApiError(409, "AGENT_AT_CAPACITY", `Agent '${agentId}' reached its concurrency limit`);
    }
    const result = this.database.prepare(`
      UPDATE tasks SET
        status = 'in_progress',
        assignee_type = 'agent',
        assignee_id = ?,
        assignee_name = ?,
        assignee_avatar_url = NULL,
        version = version + 1,
        updated_at = ?
      WHERE id = ?
        AND archived_at IS NULL
        AND status IN ('todo', 'backlog', 'blocked', 'in_progress')
        AND NOT EXISTS (
          SELECT 1 FROM task_leases l
          WHERE l.task_id = tasks.id AND l.agent_id != ? AND l.expires_at > ?
        )
    `).run(agentId, `${agent.name}·${agent.device || agent.id}`, timestamp, taskId, agentId, timestamp);
    if (result.changes === 0) {
      const activeLease = previousLease && previousLease.expiresAt > timestamp ? previousLease : null;
      if (activeLease && activeLease.agentId !== agentId) {
        throw new ApiError(409, "LEASE_HELD", `Task is leased by agent '${activeLease.agentId}' until ${activeLease.expiresAt}`);
      }
      throw new ApiError(409, "TASK_NOT_CLAIMABLE", `Task status '${task.status}' cannot be claimed`);
    }
    this.database.prepare(`
      INSERT INTO task_leases (task_id, agent_id, claimed_at, renewed_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (task_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        renewed_at = excluded.renewed_at,
        expires_at = excluded.expires_at
    `).run(taskId, agentId, timestamp, timestamp, expiresAt);
    return {
      task: this.getTask(taskId),
      lease: this.getTaskLease(taskId),
      tookOver: Boolean(
        previousLease
        && previousLease.agentId !== agentId
        && previousLease.expiresAt <= timestamp,
      ),
      previousAgentId: previousLease?.agentId ?? null,
      replayed: false,
    };
  }

  renewTaskLease(taskId, agentId, leaseSeconds) {
    const lease = this.getTaskLease(taskId);
    const timestamp = now();
    if (!lease || lease.agentId !== agentId || lease.expiresAt <= timestamp) {
      throw new ApiError(409, "LEASE_NOT_HELD", `Task '${taskId}' is not leased by agent '${agentId}'`);
    }
    const task = this.getTask(taskId);
    if (!task || task.assignee?.id !== agentId) {
      throw new ApiError(409, "LEASE_NOT_HELD", `Task '${taskId}' is no longer assigned to agent '${agentId}'`);
    }
    const expiresAt = new Date(Date.parse(timestamp) + leaseSeconds * 1000).toISOString();
    this.database.prepare(`
      UPDATE task_leases SET renewed_at = ?, expires_at = ? WHERE task_id = ? AND agent_id = ?
    `).run(timestamp, expiresAt, taskId, agentId);
    return this.getTaskLease(taskId);
  }

  releaseTask(taskId, agentId, { returnToStatus = "todo" } = {}) {
    const lease = this.getTaskLease(taskId);
    if (!lease || lease.agentId !== agentId) {
      throw new ApiError(409, "LEASE_NOT_HELD", `Task '${taskId}' is not leased by agent '${agentId}'`);
    }
    const task = this.getTask(taskId);
    const timestamp = now();
    this.database.prepare("DELETE FROM task_leases WHERE task_id = ? AND agent_id = ?").run(taskId, agentId);
    if (task && task.status === "in_progress" && returnToStatus) {
      this.database.prepare(`
        UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?
      `).run(returnToStatus, timestamp, taskId);
    }
    return this.getTask(taskId);
  }

  clearTaskLease(taskId, agentId) {
    const result = this.database.prepare(`
      DELETE FROM task_leases WHERE task_id = ? AND agent_id = ?
    `).run(taskId, agentId);
    return result.changes > 0;
  }

  submitClaimedTaskForReview(taskId, agentId, version) {
    const task = this.#requireTask(taskId);
    this.#requireVersion(task, version);
    if (task.archivedAt !== null || task.status !== "in_progress") {
      throw new ApiError(409, "TASK_NOT_CLAIMABLE", "Only an active claimed task can be submitted for review");
    }
    const timestamp = now();
    const lease = this.getTaskLease(task.id);
    if (!lease || lease.agentId !== agentId || lease.expiresAt <= timestamp) {
      throw new ApiError(409, "LEASE_NOT_HELD", `Task '${task.id}' is not actively leased by agent '${agentId}'`);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = 'in_review', version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, task.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(task.id, version);
      this.database.prepare(`
        DELETE FROM task_leases WHERE task_id = ? AND agent_id = ?
      `).run(task.id, agentId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(task.id);
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.hidden_at,
        projects.version,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.hidden_at,
        projects.version,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? {
      ...projectFromRow(row),
      devices: this.#projectDevices(row.id),
    } : null;
  }

  hideProject(id, version) {
    const current = this.getProject(id);
    if (!current) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    if (current.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Project was changed by another client", {
        expectedVersion: version,
        actualVersion: current.version,
      });
    }
    if (current.hiddenAt !== null) {
      throw new ApiError(409, "PROJECT_HIDDEN", "Project is already hidden");
    }
    const timestamp = now();
    this.database.prepare(`
      UPDATE projects
      SET hidden_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(timestamp, timestamp, current.id, version);
    return this.getProject(current.id);
  }

  restoreProject(id, version) {
    const current = this.getProject(id);
    if (!current) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    if (current.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Project was changed by another client", {
        expectedVersion: version,
        actualVersion: current.version,
      });
    }
    if (current.hiddenAt === null) {
      throw new ApiError(409, "PROJECT_NOT_HIDDEN", "Only hidden projects can be restored");
    }
    const timestamp = now();
    this.database.prepare(`
      UPDATE projects
      SET hidden_at = NULL, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(timestamp, current.id, version);
    return this.getProject(current.id);
  }

  getWorkflowWorkspace(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT project_id, workspace, version, updated_at
      FROM workflow_workspaces
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? workflowWorkspaceFromRow(row)
      : { projectId, workspace: null, version: 0, updatedAt: null };
  }

  saveWorkflowWorkspace(projectId, expectedVersion, workspace) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = this.database.prepare(`
        SELECT version FROM workflow_workspaces WHERE project_id = ?
      `).get(projectId);
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "Workflow was changed by another client", {
          expectedVersion,
          actualVersion,
        });
      }
      if (current) {
        this.database.prepare(`
          UPDATE workflow_workspaces
          SET workspace = ?, version = version + 1, updated_at = ?
          WHERE project_id = ? AND version = ?
        `).run(JSON.stringify(workspace), timestamp, projectId, expectedVersion);
      } else {
        this.database.prepare(`
          INSERT INTO workflow_workspaces (project_id, workspace, version, updated_at)
          VALUES (?, ?, 1, ?)
        `).run(projectId, JSON.stringify(workspace), timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkflowWorkspace(projectId);
  }

  listAiChatThreads() {
    return this.database.prepare(`
      SELECT * FROM ai_chat_threads
      ORDER BY updated_at DESC, id
    `).all().map((row) => this.#aiChatThreadWithCurrentRun(row));
  }

  getAiChatThread(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  createAiChatThread(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_threads (
        id, title, status,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, model, reasoning_effort, sandbox,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.status ?? "idle",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.model,
      input.reasoningEffort,
      input.sandbox,
      timestamp,
      input.updatedAt ?? timestamp,
    );
    return this.getAiChatThread(id);
  }

  updateAiChatThread(id, changes) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      model: "model",
      reasoningEffort: "reasoning_effort",
      sandbox: "sandbox",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;
    assignments.push("updated_at = ?");
    values.push(changes.updatedAt ?? now(), id);
    this.database.prepare(`
      UPDATE ai_chat_threads SET ${assignments.join(", ")} WHERE id = ?
    `).run(...values);
    return this.getAiChatThread(id);
  }

  deleteAiChatThread(id) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM ai_chat_threads WHERE id = ?").run(id);
    return current;
  }

  listAiChatRuns(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ?
      ORDER BY started_at, id
    `).all(threadId).map(aiChatRunFromRow);
  }

  getAiChatRun(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(id);
    return row ? aiChatRunFromRow(row) : null;
  }

  createAiChatRun(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO ai_chat_runs (
          id, thread_id, status, exit_code, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
        timestamp,
        input.finishedAt ?? null,
      );
      if ((input.status ?? "running") === "running") {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'running', updated_at = ?
          WHERE id = ?
        `).run(timestamp, input.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  updateAiChatRun(id, changes) {
    const current = this.getAiChatRun(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const columns = {
      status: "status",
      exitCode: "exit_code",
      error: "error",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      values.push(id);
      this.database.prepare(`
        UPDATE ai_chat_runs SET ${assignments.join(", ")} WHERE id = ?
      `).run(...values);
      const status = changes.status ?? current.status;
      if (status !== "running") {
        const threadStatus = status === "failed" ? "failed" : "idle";
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `).run(threadStatus, changes.finishedAt ?? now(), current.threadId, current.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  insertAiChatEvent(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_events (
        id, thread_id, run_id, type, role, content, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.runId ?? null,
      input.type,
      input.role,
      input.content,
      input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      timestamp,
    );
    const row = this.database.prepare("SELECT * FROM ai_chat_events WHERE id = ?").get(id);
    return aiChatEventFromRow(row);
  }

  listAiChatEvents(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_events
      WHERE thread_id = ?
      ORDER BY created_at, rowid
    `).all(threadId).map(aiChatEventFromRow);
  }

  interruptAbandonedAiChatRuns() {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE ai_chat_runs
        SET
          status = 'interrupted',
          error = COALESCE(error, 'Taskboard service restarted'),
          finished_at = COALESCE(finished_at, ?)
        WHERE status = 'running'
      `).run(timestamp);
      if (result.changes > 0) {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'idle', updated_at = ?
          WHERE status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE ai_chat_runs.thread_id = ai_chat_threads.id
                AND ai_chat_runs.status = 'running'
            )
        `).run(timestamp);
      }
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }
    if (filters.archived === "false") {
      where.push("archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("archived_at IS NOT NULL");
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'in_review' THEN 4
          WHEN 'blocked' THEN 5
          WHEN 'done' THEN 6
          WHEN 'canceled' THEN 7
        END,
        sort_order,
        created_at,
        id
    `;
    return this.database.prepare(sql).all(...values).map((row) => this.#taskWithRelations(row));
  }

  getTask(id) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(id, id);
    return row ? this.#taskWithRelations(row) : null;
  }

  findTaskIdByThreadId(threadId) {
    const row = this.database.prepare("SELECT id FROM tasks WHERE thread_id = ? ORDER BY created_at LIMIT 1").get(threadId);
    return row ? row.id : null;
  }

  createTask(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare(`
        SELECT id, next_task_number FROM projects WHERE id = ?
      `).get(input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }

      const number = project.next_task_number;
      const identifier = `${projectPrefix(project.id)}-${number}`;
      const id = randomUUID();
      const timestamp = now();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.database.prepare(`
          SELECT COALESCE(MAX(sort_order), 0) AS maximum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL
        `).get(input.projectId, input.status);
        sortOrder = row.maximum + 1000;
      }

      this.database.prepare(`
        UPDATE projects SET next_task_number = next_task_number + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, input.projectId);
      this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `).run(
        id,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        sortOrder,
        input.threadId ?? null,
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.workflowId,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.dueDate,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id, version, changes, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      workflowId: "workflow_id",
      dueDate: "due_date",
    };
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(changes)) {
      if (key === "developmentContext") {
        assignments.push("git_branch = ?", "worktree_path = ?", "worktree_branch = ?");
        values.push(
          value?.type === "branch" ? value.branch : null,
          value?.type === "worktree" ? value.path : null,
          value?.type === "worktree" ? value.branch : null,
        );
        continue;
      }
      if (key === "recurrence") {
        assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
        values.push(value?.interval ?? null, value?.unit ?? null);
        continue;
      }
      if (key === "assignee") {
        assignments.push(
          "assignee_type = ?",
          "assignee_id = ?",
          "assignee_name = ?",
          "assignee_avatar_url = ?",
        );
        values.push(value.type, value.id, value.name, value.avatarUrl);
        continue;
      }
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (threadId !== undefined) {
      assignments.push("thread_id = ?");
      values.push(threadId);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    const timestamp = now();
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  moveTask(id, version, status, sortOrder, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
    }
    if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ?, sort_order = ?, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(status, sortOrder, threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  reviewTask(id, version, decision, note, reviewer) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be reviewed");
    }
    if (current.status !== "in_review") {
      throw new ApiError(409, "TASK_NOT_IN_REVIEW", "Only tasks in review can be approved or returned");
    }
    const status = decision === "approved" ? "done" : "in_progress";
    const timestamp = now();
    const reviewId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO task_reviews (
          id, task_id, decision, note, reviewer_type, reviewer_id,
          reviewer_name, reviewer_avatar_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reviewId,
        current.id,
        decision,
        note,
        reviewer.type,
        reviewer.id,
        reviewer.name,
        reviewer.avatarUrl,
        timestamp,
      );
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(status, timestamp, current.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, version);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  archiveTask(id, version, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = ?, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  restoreTask(id, version, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt === null) {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = NULL, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  addTaskRelation(id, version, type, relatedId, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        this.#assertNoParentCycle(task.id, relatedTask.id);
        const existing = this.database.prepare(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `).get(task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          this.database.prepare(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `).run(task.id);
        }
      } else {
        const existing = this.database.prepare(`
          SELECT 1
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).get(relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      this.database.prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, now());
      this.#touchTask(task.id, version, threadId);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeTaskRelation(id, version, type, relatedId, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const removed = this.database.prepare(`
        DELETE FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).run(relationType, sourceTaskId, targetTaskId);
      if (removed.changes !== 1) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      this.#touchTask(task.id, version, threadId);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const task = this.#requireTask(taskId);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO comments (
        id, task_id, body, thread_id, author_type, author_id, author_name, author_avatar_url,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      task.id,
      input.body,
      input.threadId ?? null,
      input.actor.type,
      input.actor.id,
      input.actor.name,
      input.actor.avatarUrl,
      timestamp,
      timestamp,
    );
    return this.getComment(id);
  }

  getComment(id) {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      UPDATE comments
      SET body = ?, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(body, threadId ?? null, now(), id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return this.getComment(id);
  }

  deleteComment(id, version) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      DELETE FROM comments WHERE id = ? AND version = ?
    `).run(id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return current;
  }

  listAttachments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    const task = this.#requireTask(taskId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(input.id, task.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId) {
    const comment = this.database.prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId);
  }

  createCommentAttachment(commentId, input) {
    const comment = this.#requireComment(commentId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, comment.taskId, comment.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    const attachment = this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment;
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #aiChatThreadWithCurrentRun(row) {
    const thread = aiChatThreadFromRow(row);
    const currentRun = this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    return thread;
  }

  #attachmentsForComment(commentId) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #taskWithRelations(row) {
    const task = taskFromRow(row);
    const parent = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).get(task.id);
    const subIssues = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blockedBy = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blocks = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const related = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    const latestReview = this.database.prepare(`
      SELECT * FROM task_reviews
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(task.id);
    task.latestReview = latestReview ? taskReviewFromRow(latestReview) : null;
    return task;
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  #assertNoParentCycle(childId, parentId) {
    const cycle = this.database.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 FROM ancestors WHERE id = ?
    `).get(parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  #touchTask(id, version, threadId) {
    const result = this.database.prepare(`
      UPDATE tasks
      SET thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(threadId ?? null, now(), id, version);
    if (result.changes !== 1) {
      this.#throwMissingOrConflict(id, version);
    }
  }

  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  #requireComment(id) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    return comment;
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  #throwMissingOrConflict(id, expectedVersion) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }
}
