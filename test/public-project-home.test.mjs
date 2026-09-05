import assert from "node:assert/strict";
import { test } from "node:test";

import { listDeviceWorkspaces } from "../web/src/api.ts";

test("public project loading treats local-only workspace data as unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      code: "LOCAL_ONLY",
      message: "This endpoint is only available on this device",
    },
  }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

  try {
    assert.deepEqual(await listDeviceWorkspaces(), {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});
