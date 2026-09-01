import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

// 2026-09-01 脑裂事故：Mini 反向隧道在腾讯云重启空窗抢占 47823，导致公网流量
// 打到旧实例。隧道已永久禁用并从仓库移除——此测试防止它被无意重新引入。
test("the Mini reverse tunnel must not be reintroduced", () => {
  assert.equal(
    existsSync(path.join(
      projectRoot,
      "deploy/macos/com.tianmac.dashi-taskboard-public-tunnel.plist",
    )),
    false,
    "反向隧道 plist 不得回到仓库（2026-09-01 脑裂根因）",
  );
});
