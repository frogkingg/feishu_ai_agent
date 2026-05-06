import { loadConfig } from "./config";
import { buildServer } from "./server";
import { createLlmClient } from "./services/llm/createLlmClient";
import { createDatabase } from "./services/store/db";
import { createRepositories } from "./services/store/repositories";

async function main() {
  const config = loadConfig();
  const db = createDatabase(config.sqlitePath);
  const repos = createRepositories(db);
  const server = buildServer({
    config,
    repos,
    llm: createLlmClient(config)
  });

  await server.listen({
    host: config.host,
    port: config.port
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
