import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppConfig, loadConfig } from "../config";
import { Repositories } from "../services/store/repositories";
import { createId } from "../utils/id";

const execFileAsync = promisify(execFile);

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(authorization["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
  /(token["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
  /(secret["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
  /(access_token["']?\s*[:=]\s*["']?)[^"',\s]+/gi
];

export interface LarkCliRunOptions {
  repos: Repositories;
  config?: AppConfig;
  timeoutMs?: number;
  dryRun?: boolean;
  expectJson?: boolean;
  toolName?: string;
  mockMode?: boolean;
}

export interface LarkCliResult {
  id: string;
  tool: string;
  args: string[];
  dryRun: boolean;
  status: "planned" | "success" | "failed";
  stdout: string;
  stderr: string;
  error: string | null;
  parsed: unknown;
}

function redactText(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, (_match, prefix?: string) => `${prefix ?? ""}[REDACTED]`), value);
}

function redactArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const previous = args[index - 1]?.toLowerCase();
    if (previous && ["--token", "--secret", "--authorization", "--app-secret", "--access-token"].includes(previous)) {
      return "[REDACTED]";
    }
    return redactText(arg);
  });
}

function parseStdout(stdout: string, expectJson: boolean): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    if (expectJson) {
      return {
        raw: trimmed,
        parse_error: "stdout was not valid JSON"
      };
    }
    return trimmed;
  }
}

export async function runLarkCli(args: string[], options: LarkCliRunOptions): Promise<LarkCliResult> {
  const config = options.config ?? loadConfig();
  const dryRun = options.dryRun ?? config.feishuDryRun;
  const tool = options.toolName ?? "lark";
  const redactedArgs = redactArgs(args);
  const runId = createId("cli");

  if (dryRun) {
    const stdout = JSON.stringify({
      dry_run: dryRun,
      mock_mode: Boolean(options.mockMode),
      tool,
      args: redactedArgs
    });
    const parsed = parseStdout(stdout, true);
    options.repos.createCliRun({
      id: runId,
      tool,
      args_json: JSON.stringify(redactedArgs),
      dry_run: dryRun ? 1 : 0,
      status: "planned",
      stdout,
      stderr: null,
      error: null
    });

    return {
      id: runId,
      tool,
      args: redactedArgs,
      dryRun,
      status: "planned",
      stdout,
      stderr: "",
      error: null,
      parsed
    };
  }

  try {
    const output = await execFileAsync(config.larkCliBin, args, {
      timeout: options.timeoutMs ?? 30000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env
    });
    const stdout = redactText(output.stdout);
    const stderr = redactText(output.stderr);
    const parsed = parseStdout(stdout, Boolean(options.expectJson));
    options.repos.createCliRun({
      id: runId,
      tool,
      args_json: JSON.stringify(redactedArgs),
      dry_run: 0,
      status: "success",
      stdout,
      stderr,
      error: null
    });

    return {
      id: runId,
      tool,
      args: redactedArgs,
      dryRun: false,
      status: "success",
      stdout,
      stderr,
      error: null,
      parsed
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: string };
    const stdout = redactText(err.stdout ?? "");
    const stderr = redactText(err.stderr ?? "");
    const message = redactText(err.message);
    options.repos.createCliRun({
      id: runId,
      tool,
      args_json: JSON.stringify(redactedArgs),
      dry_run: 0,
      status: "failed",
      stdout,
      stderr,
      error: message
    });

    return {
      id: runId,
      tool,
      args: redactedArgs,
      dryRun: false,
      status: "failed",
      stdout,
      stderr,
      error: message,
      parsed: null
    };
  }
}
