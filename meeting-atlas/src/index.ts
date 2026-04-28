import { loadConfig } from "./config";
import { buildServer } from "./server";
import { createDatabase } from "./services/store/db";
import { createRepositories } from "./services/store/repositories";
import { MockLlmClient } from "./services/llm/mockLlmClient";

async function main() {
  const config = loadConfig();
  const db = createDatabase(config.sqlitePath);
  const repos = createRepositories(db);
  const server = buildServer({
    config,
    repos,
    llm: new MockLlmClient()
  });

  await server.listen({
    host: "127.0.0.1",
    port: config.port
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
