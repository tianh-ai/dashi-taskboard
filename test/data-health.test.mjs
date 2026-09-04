import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dashi-data-health-"));
  const app = createTaskboardServer({ dataDirectory: directory, ...options });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

function basic(username, secret) {
  return `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
}

test("admin data health reports live SQLite integrity and explicit V/R/S/F assurance levels", async () => {
  const { baseUrl } = await startServer();
  const response = await fetch(`${baseUrl}/api/system/data-health`);
  assert.equal(response.status, 200);
  const health = await response.json();

  assert.equal(health.schemaVersion, 1);
  assert.equal(health.ratingStandard.productionThreshold, 3);
  assert.equal(health.ratingStandard.axes.F, "environment fit");
  assert.equal(health.database.engine, "sqlite");
  assert.equal(health.checks.integrity.ok, true);
  assert.equal(health.checks.integrity.result, "ok");
  assert.equal(health.checks.foreignKeys.ok, true);
  assert.equal(health.checks.foreignKeys.violations, 0);
  assert.equal(health.checks.attachments.missingFiles, 0);
  assert.equal(health.checks.attachments.sizeMismatches, 0);
  assert.equal(health.ratings.validity.code, "V3");
  assert.equal(health.ratings.reliability.code, "R1");
  assert.equal(health.ratings.synchronization.code, "S2");
  assert.equal(health.ratings.environmentFit.code, "F2");
  assert.equal(health.ratings.freshness, undefined, "F is environment fit, not freshness");
  assert.equal(health.productionReady, false, "all four ratings must reach level 3");
});

test("data health is restricted to a real human administrator", async () => {
  const companionSecret = "companion-secret";
  const { baseUrl } = await startServer({
    wecom: { enabled: true, agentId: "1000003", companionSecret },
  });
  const response = await fetch(`${baseUrl}/api/system/data-health`, {
    headers: {
      authorization: basic("mini-companion", companionSecret),
      "x-taskboard-client": "cloud-companion",
      "x-taskboard-acting-user-id": "ordinary-member",
      "x-taskboard-acting-user-name": encodeURIComponent("普通成员"),
    },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "ADMIN_REQUIRED");
});
