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
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

function usage() {
  process.stderr.write(
    "Usage: node scripts/restore-local-data.mjs --backup <backup-dir> [--destination <empty-dir>] [--verify-only]\n",
  );
}

function parseArguments(argv) {
  const options = { verifyOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verify-only") {
      options.verifyOnly = true;
    } else if (argument === "--backup" || argument === "--destination") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      options[argument === "--backup" ? "backup" : "destination"] = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.backup) throw new Error("--backup is required");
  if (!options.verifyOnly && !options.destination) {
    throw new Error("--destination is required unless --verify-only is used");
  }
  return options;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function safeAttachmentId(value) {
  const id = String(value);
  if (!/^[a-zA-Z0-9._-]{1,255}$/.test(id)) {
    throw new Error(`Attachment '${id}' has an unsafe storage id`);
  }
  return id;
}

async function assertFile(filename, expectedSize, expectedHash, label) {
  const metadata = await lstat(filename).catch(() => null);
  if (!metadata?.isFile()) throw new Error(`${label} is missing or is not a regular file`);
  if (metadata.size !== Number(expectedSize)) {
    throw new Error(`${label} size mismatch: manifest=${expectedSize}, file=${metadata.size}`);
  }
  const actualHash = await sha256File(filename);
  if (actualHash !== expectedHash) throw new Error(`${label} SHA-256 mismatch`);
}

const options = (() => {
  try {
    return parseArguments(process.argv.slice(2));
  } catch (error) {
    usage();
    throw error;
  }
})();

const manifestPath = path.join(options.backup, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.formatVersion !== 1) {
  throw new Error(`Unsupported backup formatVersion: ${manifest.formatVersion}`);
}
if (manifest.database?.path !== "taskboard.sqlite") {
  throw new Error("Backup manifest database path must be taskboard.sqlite");
}
if (manifest.attachmentsDirectory !== "attachments") {
  throw new Error("Backup manifest attachmentsDirectory must be attachments");
}

const databasePath = path.join(options.backup, manifest.database.path);
const attachmentsPath = path.join(options.backup, manifest.attachmentsDirectory);
await assertFile(
  databasePath,
  manifest.database.size,
  manifest.database.sha256,
  "Backup database",
);

const attachmentEntries = await readdir(attachmentsPath, { withFileTypes: true });
const expectedAttachments = new Map();
for (const attachment of manifest.attachments ?? []) {
  const id = safeAttachmentId(attachment.id);
  if (expectedAttachments.has(id)) throw new Error(`Duplicate attachment '${id}' in manifest`);
  expectedAttachments.set(id, attachment);
  await assertFile(
    path.join(attachmentsPath, id),
    attachment.size,
    attachment.sha256,
    `Attachment '${id}'`,
  );
}
const unexpectedAttachments = attachmentEntries
  .filter((entry) => !entry.isFile() || !expectedAttachments.has(entry.name))
  .map((entry) => entry.name);
if (unexpectedAttachments.length > 0) {
  throw new Error(`Unexpected backup attachment entries: ${unexpectedAttachments.join(", ")}`);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
let tableCounts;
try {
  const integrity = database.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity}`);
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(`SQLite foreign key check failed: ${foreignKeys.length} violation(s)`);
  }
  tableCounts = Object.fromEntries(Object.keys(manifest.tableCounts ?? {}).map((table) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) throw new Error(`Unsafe table name '${table}'`);
    return [table, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)];
  }));
} finally {
  database.close();
}
if (JSON.stringify(tableCounts) !== JSON.stringify(manifest.tableCounts ?? {})) {
  throw new Error("Backup table counts do not match manifest");
}

let receiptPath = null;
if (!options.verifyOnly) {
  const destinationMetadata = await lstat(options.destination).catch(() => null);
  if (destinationMetadata && !destinationMetadata.isDirectory()) {
    throw new Error("Restore destination exists and is not a directory");
  }
  if (destinationMetadata && (await readdir(options.destination)).length > 0) {
    throw new Error("Restore destination must be empty");
  }
  await mkdir(options.destination, { recursive: true, mode: 0o700 });
  await chmod(options.destination, 0o700);
  const restoredDatabasePath = path.join(options.destination, "taskboard.sqlite");
  const restoredAttachmentsPath = path.join(options.destination, "attachments");
  await mkdir(restoredAttachmentsPath, { mode: 0o700 });
  await copyFile(databasePath, restoredDatabasePath);
  await chmod(restoredDatabasePath, 0o600);
  await assertFile(
    restoredDatabasePath,
    manifest.database.size,
    manifest.database.sha256,
    "Restored database",
  );
  for (const id of expectedAttachments.keys()) {
    const restoredAttachmentPath = path.join(restoredAttachmentsPath, id);
    await copyFile(path.join(attachmentsPath, id), restoredAttachmentPath);
    await chmod(restoredAttachmentPath, 0o600);
    const attachment = expectedAttachments.get(id);
    await assertFile(
      restoredAttachmentPath,
      attachment.size,
      attachment.sha256,
      `Restored attachment '${id}'`,
    );
  }
  receiptPath = path.join(options.destination, "restore-receipt.json");
  const receipt = {
    formatVersion: 1,
    restoredAt: new Date().toISOString(),
    sourceBackup: options.backup,
    databaseSha256: manifest.database.sha256,
    attachmentCount: expectedAttachments.size,
    tableCounts,
    integrity: "ok",
    foreignKeys: "ok",
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

process.stdout.write(`${JSON.stringify({
  backupPath: options.backup,
  destinationPath: options.destination ?? null,
  receiptPath,
  verified: true,
  restored: !options.verifyOnly,
  attachments: expectedAttachments.size,
  tableCounts,
  integrity: "ok",
  foreignKeys: "ok",
})}\n`);
