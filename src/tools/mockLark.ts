export function mockLarkUrl(kind: "task" | "calendar", id: string): string {
  return `mock://feishu/${kind}/${id}`;
}
