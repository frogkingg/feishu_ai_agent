export function compactText(text: string, maxLength = 600): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, maxLength - 3)}...`;
}

export function extractHeaderValue(text: string, label: string): string | null {
  const pattern = new RegExp(`^${label}[:：]\\s*(.+)$`, "m");
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

export function splitCsvNames(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function keywordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const aSet = new Set(a.map((item) => item.toLowerCase()));
  const bSet = new Set(b.map((item) => item.toLowerCase()));
  const intersection = [...aSet].filter((item) => bSet.has(item)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}
