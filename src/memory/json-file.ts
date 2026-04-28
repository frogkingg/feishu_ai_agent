import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number) {
  Atomics.wait(WAIT_BUFFER, 0, 0, ms);
}

function removeStaleLock(lockPath: string) {
  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      unlinkSync(lockPath);
    }
  } catch {
    // Another process may have removed it between the failed open and stat.
  }
}

export function withFileLock<T>(lockPath: string, action: () => T): T {
  const startedAt = Date.now();
  let lockFd: number | undefined;

  while (lockFd === undefined) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      lockFd = openSync(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      removeStaleLock(lockPath);
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`等待状态文件锁超时: ${lockPath}`);
      }
      sleepSync(50);
    }
  }

  try {
    return action();
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock may already be gone if the filesystem cleaned it up.
    }
  }
}

export function readJsonFile<T>(filePath: string, empty: () => T, label: string): T {
  if (!existsSync(filePath)) {
    return empty();
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    throw new Error(`无法读取 ${label}，已停止写入以避免覆盖现有状态: ${(error as Error).message}`);
  }
}

export function writeJsonFileAtomic(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup.
    }
    throw error;
  }
}
