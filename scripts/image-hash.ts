/**
 * Computes the content hash that tags the baked image, over the two build inputs
 * that determine the dataset: the migration SQL files and the generated seed.
 * A dev who changes schema or seed gets a new hash → builds locally under that
 * tag → the harness (reading HARNESS_IMAGE) picks it up with no code change.
 *
 * Prints `parkdata:<12-char-hash>` on stdout.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const hash = createHash("sha256");

// Migration files, in stable name order.
const migrationsDir = join(ROOT, "migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const f of migrationFiles) {
  hash.update(f);
  hash.update(readFileSync(join(migrationsDir, f)));
}

// Generated seed chunks (one per park + _finalize.sql), in stable name order.
const chunkDir = join(ROOT, "chunks");
if (!existsSync(chunkDir)) {
  console.error("chunks/ not found — run `npm run generate:seed` first.");
  process.exit(1);
}
const chunkFiles = readdirSync(chunkDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const f of chunkFiles) {
  hash.update(f);
  hash.update(readFileSync(join(chunkDir, f)));
}

const digest = hash.digest("hex").slice(0, 12);
process.stdout.write(`parkdata:${digest}\n`);
