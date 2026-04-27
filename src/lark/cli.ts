import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const LARK_BIN = process.env.LARK_CLI_BIN || "lark-cli";

export async function runLarkCli(args: string[], as: "user" | "bot" = "bot") {
  const { stdout, stderr } = await execFileAsync(LARK_BIN, [...args, "--as", as], {
    timeout: 30_000,
    env: process.env,
  });

  if (stderr.trim()) {
    console.warn("lark-cli stderr:", stderr.trim());
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

export async function ensureLarkCliReady() {
  await execFileAsync(LARK_BIN, ["config", "show"], {
    timeout: 10_000,
    env: process.env,
  });
}
