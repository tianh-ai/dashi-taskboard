import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

async function startPublicWeComServer(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "dashi-taskctl-auth-"));
  const app = createTaskboardServer({
    dataDirectory,
    wecom: {
      enabled: true,
      corpId: "ww-test",
      agentId: "1000003",
      secret: "test-secret",
      publicUrl: "https://workbuddy.lnhsjs.com/wecom/app/1000003/taskboard",
      devMode: false,
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

test("public WeCom mode accepts a direct loopback taskctl request", async (t) => {
  const baseUrl = await startPublicWeComServer(t);
  const response = await fetch(`${baseUrl}/api/projects`, {
    headers: { "x-taskboard-client": "taskctl" },
  });

  assert.equal(response.status, 200);
});

test("public WeCom mode rejects a forwarded taskctl request", async (t) => {
  const baseUrl = await startPublicWeComServer(t);
  const response = await fetch(`${baseUrl}/api/projects`, {
    headers: {
      "x-taskboard-client": "taskctl",
      "x-forwarded-for": "198.51.100.10",
    },
  });

  assert.equal(response.status, 401);
});
