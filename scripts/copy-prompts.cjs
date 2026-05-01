const { cpSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const sourceDir = join(process.cwd(), "src/prompts");
const targetRoot = join(process.cwd(), "dist/src");
const targetDir = join(targetRoot, "prompts");

if (!existsSync(sourceDir)) {
  throw new Error(`Prompt source directory not found: ${sourceDir}`);
}

mkdirSync(targetRoot, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
