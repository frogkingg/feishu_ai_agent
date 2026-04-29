import { AppConfig } from "../../config";
import { LlmClient } from "./llmClient";
import { MockLlmClient } from "./mockLlmClient";
import { OpenAiCompatibleLlmClient } from "./openAiCompatibleLlmClient";

export function createLlmClient(config: AppConfig): LlmClient {
  if (config.llmProvider === "mock") {
    return new MockLlmClient();
  }

  if (config.llmProvider === "openai-compatible") {
    return new OpenAiCompatibleLlmClient(config);
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${String(config.llmProvider)}`);
}
