export function personalDisplayName(): string {
  return process.env.FEISHU_PERSONAL_DISPLAY_NAME?.trim() || "个人";
}

export function personalWorkspaceName(): string {
  const displayName = personalDisplayName();
  return displayName === "个人" ? "个人工作台" : `${displayName}工作台`;
}
