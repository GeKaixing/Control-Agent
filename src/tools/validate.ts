/**
 * 极简 JSON Schema 校验器：够用即可，避免为几个工具引入 zod 依赖。
 */

import type { JsonSchema, JsonSchemaProperty } from "../providers/types.js";

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, expected: JsonSchemaProperty["type"]): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

function checkProperty(
  key: string,
  schema: JsonSchemaProperty,
  value: unknown,
): string | null {
  if (!matchesType(value, schema.type)) {
    return `参数 ${key} 类型错误：期望 ${schema.type}，实际 ${typeOf(value)}`;
  }
  if (schema.enum !== undefined && typeof value === "string" && !schema.enum.includes(value)) {
    return `参数 ${key} 取值非法：${value}（可选：${schema.enum.join(" | ")}）`;
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      if (!matchesType(value[i], schema.items.type)) {
        return `参数 ${key}[${i}] 类型错误：期望 ${schema.items.type}`;
      }
    }
  }
  return null;
}

export function validateParams(schema: JsonSchema, args: unknown): ValidationResult {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, error: "工具参数必须是一个对象" };
  }
  const input = args as Record<string, unknown>;
  const value: Record<string, unknown> = {};

  for (const key of schema.required ?? []) {
    if (!(key in input) || input[key] === undefined) {
      return { ok: false, error: `缺少必填参数：${key}` };
    }
  }

  for (const [key, raw] of Object.entries(input)) {
    const propSchema = schema.properties[key];
    if (propSchema === undefined) {
      if (schema.additionalProperties === false) {
        return { ok: false, error: `出现未声明的参数：${key}` };
      }
      continue;
    }
    if (raw === undefined) continue;
    const err = checkProperty(key, propSchema, raw);
    if (err !== null) return { ok: false, error: err };
    value[key] = raw;
  }

  return { ok: true, value };
}

/** 生成给模型看的参数说明（append 到工具描述里，提高调用准确率） */
export function describeSchema(schema: JsonSchema): string {
  const parts = Object.entries(schema.properties).map(([key, p]) => {
    const req = (schema.required ?? []).includes(key) ? "必填" : "可选";
    const enumHint = p.enum !== undefined ? `(${p.enum.join("|")})` : "";
    return `${key}:${p.type}(${req})${enumHint}`;
  });
  return parts.join(", ");
}
