#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const dataDir = path.resolve(
  process.env.CODEX_TASKBOARD_DATA_DIR
    ?? path.join(process.cwd(), ".data"),
);
const backupDir = path.resolve(
  process.env.CODEX_TASKBOARD_BACKUP_DIR
    ?? path.join(dataDir, "backups"),
);
const retainCount = Number.parseInt(
  process.env.CODEX_TASKBOARD_BACKUP_RETAIN_COUNT ?? "14",
  10,
);

if (!Number.isSafeInteger(retainCount) || retainCount < 1 || retainCount > 365) {
  throw new Error("CODEX_TASKBOARD_BACKUP_RETAIN_COUNT must be an integer from 1 to 365");
}

const sourcePath = path.join(dataDir, "taskboard.sqlite");
const sourceAttachmentsPath = path.join(dataDir, "attachments");
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const filename = `taskboard-${timestamp}.backup`;
const finalPath = path.join(backupDir, filename);
const temporaryPath = `${finalPath}.partial`;
const snapshotPath = path.join(temporaryPath, "taskboard.sqlite");
const snapshotAttachmentsPath = path.join(temporaryPath, "attachments");
const manifestPath = path.join(temporaryPath, "manifest.json");

await mkdir(backupDir, { recursive: true, mode: 0o700 });
await chmod(backupDir, 0o700);
await mkdir(temporaryPath, { mode: 0o700 });

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

let attachmentCount = 0;
try {
  const backup = spawnSync(
    "/usr/bin/sqlite3",
    [sourcePath, `.backup '${snapshotPath.replaceAll("'", "''")}'`],
    { encoding: "utf8" },
  );
  if (backup.error || backup.status !== 0) {
    throw backup.error ?? new Error(backup.stderr.trim() || "SQLite backup failed");
  }

  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  let attachmentRows;
  let tableCounts;
  try {
    const integrity = snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check;
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity}`);
    const foreignKeys = snapshot.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) {
      throw new Error(`SQLite foreign key check failed: ${foreignKeys.length} violation(s)`);
    }
    attachmentRows = snapshot.prepare("SELECT id, size FROM attachments ORDER BY id").all();
    const existingTables = new Set(snapshot.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table'
    `).all().map((row) => row.name));
    tableCounts = Object.fromEntries([
      "projects",
      "tasks",
      "comments",
      "attachments",
      "project_device_mappings",
      "project_messages",
      "codex_thread_mappings",
      "wecom_sessions",
    ].filter((table) => existingTables.has(table))
      .map((table) => [table, Number(snapshot.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
  } finally {
    snapshot.close();
  }

  await Promise.all([
    unlink(`${snapshotPath}-shm`).catch(() => {}),
    unlink(`${snapshotPath}-wal`).catch(() => {}),
  ]);
  await chmod(snapshotPath, 0o600);
  const snapshotMetadata = await lstat(snapshotPath);
  const databaseManifest = {
    path: "taskboard.sqlite",
    size: snapshotMetadata.size,
    sha256: await sha256File(snapshotPath),
  };
  await mkdir(snapshotAttachmentsPath, { mode: 0o700 });

  const attachments = [];
  for (const row of attachmentRows) {
    const id = String(row.id);
    if (!/^[a-zA-Z0-9._-]{1,255}$/.test(id)) {
      throw new Error(`Attachment '${id}' has an unsafe storage id`);
    }
    const sourceAttachment = path.join(sourceAttachmentsPath, id);
    const destinationAttachment = path.join(snapshotAttachmentsPath, id);
    const metadata = await lstat(sourceAttachment).catch(() => null);
    if (!metadata?.isFile()) {
      throw new Error(`Attachment '${id}' is missing or is not a regular file`);
    }
    if (metadata.size !== Number(row.size)) {
      throw new Error(`Attachment '${id}' size mismatch: SQLite=${row.size}, file=${metadata.size}`);
    }
    await copyFile(sourceAttachment, destinationAttachment);
    await chmod(destinationAttachment, 0o600);
    const body = await readFile(destinationAttachment);
    if (body.byteLength !== Number(row.size)) {
      throw new Error(`Attachment '${id}' backup size verification failed`);
    }
    attachments.push({ id, size: body.byteLength, sha256: sha256(body) });
  }
  attachmentCount = attachments.length;

  const manifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    database: databaseManifest,
    attachmentsDirectory: "attachments",
    tableCounts,
    attachments,
    integrity: "ok",
    foreignKeys: "ok",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, finalPath);
} catch (error) {
  await rm(temporaryPath, { recursive: true, force: true });
  throw error;
}

const backups = (await readdir(backupDir, { withFileTypes: true }))
  .filter((entry) => /^taskboard-\d{4}-\d{2}-\d{2}T.*\.(?:backup|sqlite)$/.test(entry.name))
  .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
  .sort((left, right) => left.name.localeCompare(right.name))
  .reverse();

for (const expired of backups.slice(retainCount)) {
  const expiredPath = path.join(backupDir, expired.name);
  if (expired.directory) {
    await rm(expiredPath, { recursive: true });
  } else {
    await unlink(expiredPath);
  }
}

process.stdout.write(`${JSON.stringify({
  sourcePath,
  backupPath: finalPath,
  retained: Math.min(backups.length, retainCount),
  attachments: attachmentCount,
  integrity: "ok",
})}\n`);
