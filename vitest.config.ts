import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      LLM_PROVIDER: "mock",
      LLM_BASE_URL: "",
      LLM_API_KEY: "",
      LLM_MODEL: "",
      FEISHU_CARD_SEND_DRY_RUN: ""
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000
  }
});
