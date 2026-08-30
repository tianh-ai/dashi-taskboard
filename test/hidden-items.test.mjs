import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

test("hidden synced projects and tasks stay hidden until restored", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dashi-hidden-items-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const device = {
    id: "test-macbook",
    name: "Test MacBook",
    hostname: "test.local",
    local: true,
  };
  const projects = [{
    id: "codex-project",
    name: "Synced project",
    workspacePath: "/tmp/synced-project",
  }];
  const threads = [{
    id: "019fcaa0-cb04-7ba2-8467-fe8fdfc14043",
    title: "Synced task",
    archived: false,
    pinned: false,
    source: "user",
    projectId: "codex-project",
    workspacePath: "/tmp/synced-project",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_001,
  }];

  try {
    database.syncDeviceProjects(device, projects);
    const project = database.listProjects().find((candidate) => candidate.id !== "local");
    const hiddenProject = database.hideProject(project.id, project.version);
    assert.ok(hiddenProject.hiddenAt);

    database.syncDeviceProjects(device, projects);
    assert.equal(database.listProjects().some((candidate) => candidate.id === project.id), false);
    assert.equal(database.listProjects("true")[0].id, project.id);

    database.syncDeviceThreads(device, threads);
    const task = database.listTasks({ archived: "false" })[0];
    const hiddenTask = database.archiveTask(task.id, task.version, null);
    assert.ok(hiddenTask.archivedAt);

    database.syncDeviceThreads(device, threads);
    assert.equal(database.listTasks({ archived: "false" }).length, 0);
    assert.equal(database.listTasks({ archived: "true" })[0].id, task.id);

    const restoredTask = database.restoreTask(hiddenTask.id, hiddenTask.version, null);
    assert.equal(restoredTask.archivedAt, null);
    const restoredProject = database.restoreProject(hiddenProject.id, hiddenProject.version);
    assert.equal(restoredProject.hiddenAt, null);
  } finally {
    database.close();
  }
});
