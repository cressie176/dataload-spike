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

// Generated seed.
const seedPath = join(ROOT, "seed.sql");
if (!existsSync(seedPath)) {
  console.error("seed.sql not found — run `npm run generate:seed` first.");
  process.exit(1);
}
hash.update(readFileSync(seedPath));

const digest = hash.digest("hex").slice(0, 12);
process.stdout.write(`parkdata:${digest}\n`);
