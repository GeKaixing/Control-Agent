/**
 * 展示层数字格式化：token 计数的 k / M 简化。
 *
 * 上下文用量、状态条累计用量都用它，避免同一串数字在多个组件里各写一份
 * （曾经状态条直接打裸数字 `259600`，弹层里却是 `259.6k`）。
 */

/** 1234 → "1.2k"；1234567 → "1.2M"；小于 1000 原样返回。 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
