import { z } from "zod";

export function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON: ${(error as Error).message}`);
  }
}

export function parseWithSchema<T>(value: unknown, schema: z.Schema<T>, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} failed schema validation: ${result.error.message}`);
  }

  return result.data;
}
