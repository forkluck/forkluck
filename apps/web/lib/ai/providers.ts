import "server-only"

// Shared transport configuration; each AI task owns its model and limits.
export const QWEN_BASE_URL =
  process.env.QWEN_BASE_URL?.trim() ||
  "https://dashscope-us.aliyuncs.com/compatible-mode/v1"
