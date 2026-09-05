/** glob → RegExp，不引入外部依赖。支持 **、*、?、{a,b}。 */

function escapeLiteral(char: string): string {
  return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** 把 {a,b,c} 展开为 (?:a|b|c)，支持一层嵌套 */
function expandBraces(pattern: string, start: number): { regex: string; end: number } {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (let i = start; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "{") {
      depth += 1;
      const nested = expandBraces(pattern, i + 1);
      current += nested.regex;
      i = nested.end;
      continue;
    }
    if (c === "}") {
      if (depth === 0) {
        parts.push(current);
        return { regex: `(?:${parts.join("|")})`, end: i };
      }
      depth -= 1;
      current += "}";
      continue;
    }
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }

  // 没有闭合的 }，原样退回
  return { regex: escapeLiteral("{"), end: start - 1 };
}

export function globToRegExp(glob: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < glob.length) {
    const c = glob[i] as string;

    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          regex += "(?:.*\\/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }

    if (c === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }

    if (c === "{") {
      const expanded = expandBraces(glob, i + 1);
      regex += expanded.regex;
      i = expanded.end + 1;
      continue;
    }

    regex += escapeLiteral(c);
    i += 1;
  }

  return new RegExp(`^${regex}$`);
}

export function matchesGlob(pattern: string, target: string): boolean {
  return globToRegExp(pattern).test(target);
}
