/**
 * Cron 模块：时间解析 —— 零依赖实现标准 5 字段 cron 表达式。
 *
 * 为什么自己写而不用 croner 之类的库：本仓库运行时零 npm 依赖是硬约定
 * （只有 tsx + Node 内置模块），而 5 字段解析 + nextRun 计算不过百来行。
 *
 * 支持语法（每个字段一致）：
 *   - `*`         全部取值
 *   - `5`         单个值
 *   - `a-b`       闭区间
 *   - `a/b`、`*`+`/b` 步进（`5/15` 等价 `5-max/15`，Vixie cron 语义）
 *     （写法即「星号斜杠 b」：注释里不能出现连续的 `*` 和 `/`，会提前闭合本注释）
 *   - `a,b,c`     列表，各项可再带范围/步进
 * 字段顺序：分 时 日 月 周（0=周日，7 也算周日）。不支持秒级与月份/星期英文名。
 *
 * dom/dow 取或语义：两个字段都被显式约束（非 `*`）时，命中任意一个即算匹配——
 * 这是 POSIX cron 的标准行为，不要「修复」成取与。
 */

/** 解析结果：布尔查找表 + 是否被显式约束（非 `*`）。下标即取值（周日的 7 归一到 0） */
export interface CronFieldValues {
  values: boolean[];
  restricted: boolean;
}

export interface CronFields {
  minutes: CronFieldValues; // 0-59
  hours: CronFieldValues; // 0-23
  doms: CronFieldValues; // 1-31（下标 0 恒为 false）
  months: CronFieldValues; // 1-12（下标 0 恒为 false）
  dows: CronFieldValues; // 0-6（0=周日；输入的 7 归一到 0）
  domRestricted: boolean;
  dowRestricted: boolean;
}

/**
 * 解析单个字段。非法输入抛 Error（中文描述），由 parseCron 统一捕获转 null——
 * 本模块的调用方（store / REPL / CLI）都只关心「合法与否」，不关心具体哪段错。
 */
function parseField(
  spec: string,
  min: number,
  max: number,
  normalize: (v: number) => number = (v) => v,
): CronFieldValues {
  const values = new Array<boolean>(max + 1).fill(false);
  if (spec.length === 0) throw new Error("字段为空");

  for (const part of spec.split(",")) {
    if (part.length === 0) throw new Error(`字段 ${spec} 里有空段`);
    const slash = part.indexOf("/");
    const rangePart = slash === -1 ? part : part.slice(0, slash);
    const stepPart = slash === -1 ? undefined : part.slice(slash + 1);
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`步进非法：${stepPart}`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const dash = rangePart.indexOf("-");
      lo = Number(rangePart.slice(0, dash));
      hi = Number(rangePart.slice(dash + 1));
    } else {
      lo = Number(rangePart);
      // Vixie 语义：`5/15` 的 5 是起点而不是单值，等价 `5-max/15`
      hi = stepPart !== undefined ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`取值非法：${part}`);
    if (lo < min || hi > max || lo > hi) throw new Error(`取值越界：${part}（允许 ${min}-${max}）`);

    for (let v = lo; v <= hi; v += step) values[normalize(v)] = true;
  }
  return { values, restricted: spec !== "*" };
}

/** 解析完整 5 字段表达式；非法返回 null（调用方据此拒绝，不抛错） */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  try {
    const minutes = parseField(parts[0]!, 0, 59);
    const hours = parseField(parts[1]!, 0, 23);
    const doms = parseField(parts[2]!, 1, 31);
    // cron 月份 1-12，JS getMonth() 0-11：归一化错开一位（下标 0 = 一月）
    const months = parseField(parts[3]!, 1, 12, (v) => v - 1);
    const dows = parseField(parts[4]!, 0, 7, (v) => (v === 7 ? 0 : v));
    return {
      minutes,
      hours,
      doms,
      months,
      dows,
      domRestricted: doms.restricted,
      dowRestricted: dows.restricted,
    };
  } catch {
    return null;
  }
}

/**
 * 计算 expr 在 from 之后（严格大于 from）的下一次触发时刻。
 * 算法：先对齐到 from 所在分钟的下一分钟，然后按天跳跃——月份不匹配直接跳月，
 * 日不匹配跳天，日匹配才在当天扫时/分。最坏情况约 5 年的天数循环（~1800 次），
 * 每次都是 O(1) 查表，远快于逐分钟扫描。
 * 无可触发时刻（如 2 月 30 日）返回 null。
 */
export function nextCronRun(expr: string, from: Date): Date | null {
  const f = parseCron(expr);
  if (f === null) return null;

  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // 严格「之后」：当前分钟不参与匹配

  const dayMatches = (date: Date): boolean => {
    if (!f.months.values[date.getMonth()]) return false;
    const domHit = f.doms.values[date.getDate()];
    const dowHit = f.dows.values[date.getDay()];
    if (f.domRestricted && f.dowRestricted) return domHit || dowHit;
    return domHit && dowHit; // 未约束的那侧查找表全 true，取与即取被约束的那侧
  };

  let firstDay = true; // 起始天从当前时刻往后扫，之后的天从 00:00 扫
  for (let i = 0; i < 366 * 5 + 2; i++) {
    if (!dayMatches(d)) {
      if (!f.months.values[d.getMonth()]) {
        // 整月都不匹配：直接跳到下个月 1 号 00:00（setMonth 带日期参数防月末溢出）
        d.setMonth(d.getMonth() + 1, 1);
      } else {
        d.setDate(d.getDate() + 1);
      }
      d.setHours(0, 0, 0, 0);
      firstDay = false;
      continue;
    }
    const startHour = firstDay ? d.getHours() : 0;
    for (let h = startHour; h <= 23; h++) {
      if (!f.hours.values[h]) continue;
      const startMinute = firstDay && h === d.getHours() ? d.getMinutes() : 0;
      for (let m = startMinute; m <= 59; m++) {
        if (!f.minutes.values[m]) continue;
        const out = new Date(d.getTime());
        out.setHours(h, m, 0, 0);
        return out;
      }
    }
    // 当天时间都扫完没命中：跳明天 00:00
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    firstDay = false;
  }
  return null;
}
