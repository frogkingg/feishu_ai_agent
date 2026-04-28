export interface GenerateJsonInput {
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
}

export interface LlmClient {
  generateJson<T>(input: GenerateJsonInput): Promise<T>;
}
