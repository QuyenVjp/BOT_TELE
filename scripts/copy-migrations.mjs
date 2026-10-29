/**
 * Copy SQL migration files next to the compiled migrate.js so a production
 * start from `dist/` can still locate them via import.meta.url.
 *
 * tsc only emits .ts → .js; plain .sql files would otherwise vanish from dist
 * and `npm run migrate` (or a boot-time migration) would apply nothing.
 */
import { cpSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src", "infrastructure", "db", "migrations");
const destDir = join(here, "..", "dist", "infrastructure", "db", "migrations");

if (!existsSync(srcDir)) {
  process.stderr.write(`copy-migrations: source missing: ${srcDir}\n`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
const files = readdirSync(srcDir).filter((f) => f.endsWith(".sql"));
const sourceFiles = new Set(files);
for (const filename of readdirSync(destDir)) {
  if (filename.endsWith(".sql") && !sourceFiles.has(filename)) {
    unlinkSync(join(destDir, filename));
  }
}
for (const f of files) {
  cpSync(join(srcDir, f), join(destDir, f));
}
process.stdout.write(`copy-migrations: synchronized ${files.length} file(s) → ${destDir}\n`);
