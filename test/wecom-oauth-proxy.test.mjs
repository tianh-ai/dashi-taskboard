import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

test("WeCom OAuth API requests use the configured trusted proxy", async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "dashi-wecom-proxy-"));
  const requests = [];
  const app = createTaskboardServer({
    dataDirectory,
    wecom: {
      enabled: true,
      corpId: "ww-test",
      agentId: "1000003",
      secret: "test-secret",
      publicUrl: "https://workbuddy.lnhsjs.com/wecom/app/1000003/taskboard",
      proxyUrl: "http://127.0.0.1:11090",
      devMode: false,
    },
    wecomFetch: async (url, options) => {
      requests.push({ url: String(url), dispatcher: options.dispatcher });
      if (String(url).includes("/gettoken")) {
        return Response.json({ errcode: 0, access_token: "access-token" });
      }
      if (String(url).includes("/getuserinfo")) {
        return Response.json({ errcode: 0, UserId: "TianJiYuan" });
      }
      return Response.json({ errcode: 0, name: "田济源" });
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const entry = await fetch(`${origin}/wecom/app/1000003/taskboard`, { redirect: "manual" });
  const authorizationUrl = new URL(entry.headers.get("location"));
  const state = authorizationUrl.searchParams.get("state");
  const callback = await fetch(
    `${origin}/wecom/app/1000003/taskboard/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );

  assert.equal(callback.status, 302);
  assert.equal(requests.length, 3);
  assert.equal(requests.every((request) => request.dispatcher), true);
});
