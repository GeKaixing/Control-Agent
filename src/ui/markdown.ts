/**
 * 极简 Markdown → 终端 ANSI 渲染。
 *
 * 为什么自己写：模型输出是 Markdown 源码，直接泼到终端上就会看到 `**粗体**`、
 * `# 标题`、围栏反引号这类标记字符。项目不引第三方依赖，所以这里只做「终端够用」
 * 的一个子集：标题、列表、引用、分隔线、围栏代码块，以及行内的粗体/斜体/行内码/链接。
 *
 * 两个使用姿势：
 * - `createMarkdownStream()`：交互模式流式渲染。按行吞入 delta，只有攒够一整行
 *   才吐出，这样 `**bo|ld**` 这种跨 delta 的标记不会被切成两半渲染错。
 * - `renderMarkdown()`：一次性的整段渲染，print 模式收尾时用。
 *
 * `enabled: false` 时两个入口都是纯透传（原样返回输入），调用方可以无脑用。
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const STRIKE = "\x1b[9m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

/** 默认的行宽，分隔线按它铺满；终端宽度拿不到时用它兜底 */
const DEFAULT_WIDTH = 80;

export interface MarkdownOptions {
  /** false 时原样透传，不打任何转义序列（管道场景必须关，否则污染下游） */
  enabled?: boolean;
  /** 分隔线宽度，默认取终端列宽 */
  width?: number;
}

export interface MarkdownStream {
  /** 吞入一段增量，返回「已经完整、可以写出去」的渲染结果 */
  push(delta: string): string;
  /** 收尾：把最后没换行的一段也渲染出来 */
  end(): string;
}

/**
 * 行块解析时跨行保留的唯一状态：是否身处围栏代码块中，以及开启它的围栏串
 * （`` ``` `` 或 `~~~`，关栏必须是同字符且长度不少于开栏）。
 */
interface BlockState {
  fence: string;
}

/** 行内标记：先切出行内码，再在普通片段上做强调/链接替换 */
function renderInline(text: string): string {
  return text
    .split(/(`[^`]*`)/g)
    .map((part) => {
      if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
        return `${CYAN}${part.slice(1, -1)}${RESET}`;
      }
      return renderEmphasis(part);
    })
    .join("");
}

function renderEmphasis(segment: string): string {
  return segment
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) =>
      `${CYAN}${text}${RESET}${DIM} (${url})${RESET}`)
    .replace(/\*\*([^*]+)\*\*/g, (_m, text: string) => `${BOLD}${text}${RESET}`)
    .replace(/~~([^~]+)~~/g, (_m, text: string) => `${STRIKE}${text}${RESET}`)
    // 斜体只认 *x*：_x_ 会把 snake_case 之类的标识符误判成强调
    .replace(/\*([^*\n]+)\*/g, (_m, text: string) => `${ITALIC}${text}${RESET}`);
}

/** 渲染一整行（不含行尾换行），同一行内的块级状态就地更新 */
function renderLine(line: string, state: BlockState, width: number): string {
  const fence = /^(\s*)(`{3,}|~{3,})\s*(\S*)/.exec(line);

  if (state.fence !== "") {
    // 代码块里一律原样输出，不做任何行内解析
    if (fence !== null && fence[2][0] === state.fence[0] && fence[2].length >= state.fence.length) {
      state.fence = "";
    }
    return `${DIM}${line}${RESET}`;
  }

  if (fence !== null) {
    // 开栏行原样暗色输出（语言名已经在行里了，不重复标注）
    state.fence = fence[2];
    return `${DIM}${line}${RESET}`;
  }

  // 分隔线：--- / *** / ___
  if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
    return `${DIM}${"─".repeat(Math.max(1, width))}${RESET}`;
  }

  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading !== null) {
    const style = heading[1].length <= 2 ? `${BOLD}${MAGENTA}` : BOLD;
    return `${style}${renderInline(heading[2])}${RESET}`;
  }

  const quote = /^(\s*)>\s?(.*)$/.exec(line);
  if (quote !== null) {
    return `${quote[1]}${DIM}│${RESET} ${renderInline(quote[2])}`;
  }

  const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (item !== null) {
    return `${item[1]}${DIM}${item[2]}${RESET} ${renderInline(item[3])}`;
  }

  return renderInline(line);
}

function terminalWidth(fallback: number): number {
  const columns = process.stdout?.columns;
  return typeof columns === "number" && columns > 0 ? columns : fallback;
}

/** 创建流式渲染器；`enabled: false` 时 push 原样返回、end 返回空串 */
export function createMarkdownStream(options: MarkdownOptions = {}): MarkdownStream {
  const enabled = options.enabled ?? true;
  const width = options.width ?? terminalWidth(DEFAULT_WIDTH);
  const state: BlockState = { fence: "" };
  let buffer = "";

  return {
    push(delta: string): string {
      if (!enabled) return delta;
      buffer += delta;

      let out = "";
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        out += `${renderLine(line, state, width)}\n`;
        index = buffer.indexOf("\n");
      }
      return out;
    },

    end(): string {
      if (!enabled) return "";
      const rest = buffer;
      buffer = "";
      return rest.length > 0 ? renderLine(rest, state, width) : "";
    },
  };
}

/** 一次性渲染整段 Markdown；`enabled: false` 时原样返回 */
export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
  const stream = createMarkdownStream(options);
  return stream.push(text) + stream.end();
}
