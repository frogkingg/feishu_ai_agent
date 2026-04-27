import { join } from "path";

export const RUNTIME_DIR = join(process.cwd(), ".runtime");
export const PROJECT_STORE_PATH = join(RUNTIME_DIR, "projects.json");
export const CONFIRMATION_STORE_PATH = join(RUNTIME_DIR, "confirmations.json");
export const CONFIRMATION_TTL_MS = 30 * 60_000;
export const PROJECT_SUMMARY_MAX_CHARS = 500;
