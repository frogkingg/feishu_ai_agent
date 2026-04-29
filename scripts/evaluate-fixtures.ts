import { runFixtureEvaluationCli } from "./evaluate-effectiveness";

export * from "./evaluate-effectiveness";

if (require.main === module) {
  runFixtureEvaluationCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
