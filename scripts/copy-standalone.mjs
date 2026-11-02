/**
 * Cross-platform copy step for the standalone build (replaces `cp -r ...`,
 * which fails under bun's Windows shell).
 *
 *   .next/static            -> .next/standalone/.next/static
 *   public                  -> .next/standalone/public
 *
 * Destinations are replaced wholesale so stale files from previous builds
 * don't linger in the standalone bundle.
 */
import fs from "node:fs";
import path from "node:path";

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`skip: ${src} does not exist`);
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`copied ${src} -> ${dest}`);
}

copyDir(".next/static", ".next/standalone/.next/static");
copyDir("public", ".next/standalone/public");
