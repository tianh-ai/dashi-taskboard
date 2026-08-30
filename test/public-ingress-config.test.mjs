import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the Mini service uses the authenticated public WeCom origin", () => {
  const servicePlist = readFileSync(
    path.join(projectRoot, "deploy/macos/com.tianmac.dashi-taskboard.plist"),
    "utf8",
  );

  assert.match(
    servicePlist,
    /<key>CODEX_TASKBOARD_WECOM_DEV_MODE<\/key>\s*<string>false<\/string>/,
  );
  assert.match(
    servicePlist,
    /<key>CODEX_TASKBOARD_WECOM_PUBLIC_URL<\/key>\s*<string>https:\/\/workbuddy\.lnhsjs\.com\/wecom\/app\/1000003\/taskboard<\/string>/,
  );
});

test("the public tunnel exposes only the Mini taskboard on Tencent loopback", () => {
  const tunnelPlist = readFileSync(
    path.join(
      projectRoot,
      "deploy/macos/com.tianmac.dashi-taskboard-public-tunnel.plist",
    ),
    "utf8",
  );

  assert.match(tunnelPlist, /<string>com\.tianmac\.dashi-taskboard-public-tunnel<\/string>/);
  assert.match(tunnelPlist, /<string>BatchMode=yes<\/string>/);
  assert.match(tunnelPlist, /<string>ExitOnForwardFailure=yes<\/string>/);
  assert.match(tunnelPlist, /<string>StrictHostKeyChecking=yes<\/string>/);
  assert.match(tunnelPlist, /<string>GatewayPorts=no<\/string>/);
  assert.match(tunnelPlist, /<string>-R<\/string>/);
  assert.match(
    tunnelPlist,
    /<string>127\.0\.0\.1:47823:127\.0\.0\.1:47823<\/string>/,
  );
  assert.match(tunnelPlist, /<string>tencent<\/string>/);
});
