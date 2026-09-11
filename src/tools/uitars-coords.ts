/**
 * UI-TARS 坐标算法基准（AGENTS.md「坐标算法基准」一节的正式落地）。
 *
 * UI-TARS 系模型输出的坐标在 **smart_resize 坐标系**（推理端缩放后的图），
 * 而不是截图原始像素。接入这类模型时，模型给的点必须经本模块换算回
 * 截图坐标系，才能交给 `computer` 的 click/drag——harness 对普通模型
 * 「不做任何坐标换算」的约定不变，本模块只在 UI-TARS 通道启用。
 *
 * 按官方源码逐条复刻（对拍基准）：
 *   bytedance/UI-TARS  codes/ui_tars/action_parser.py
 *   https://github.com/bytedance/UI-TARS
 *
 * 三个已知的坑（AGENTS.md 记录，单测逐一固化）：
 *   1. 像素预算须与推理端一致——min/max_pixels/factor 三常量必须与服务端
 *      相同，否则归一化分母就错了；
 *   2. Python round 是银行家舍入（round-half-even），JS Math.round 是
 *      half-up——round_by_factor 里必须用本文件的 roundHalfEven；
 *   3. 原版 parse_action_to_structure_output 的 `origin_resized_*` 参数
 *      名字带 resized，实际要传**原始分辨率**（官方源码即如此使用）。
 *
 * 换算管线（与官方两段式一致）：
 *   模型输出 (x, y)（smart_resize 空间绝对坐标）
 *     → 归一化：x / resizedWidth，y / resizedHeight
 *     → 还原：  x * imageWidth， y * imageHeight（round 到 3 位小数）
 * 四数框 (x1,y1,x2,y2) 先取中心，两数点复制成框再取中心——与原版一致。
 */

/** 推理端图像分块因子（qwen-vl 系硬编码 28） */
export const IMAGE_FACTOR = 28;
/** 像素预算下限：100 * 28 * 28（action_parser.py 的 MIN_PIXELS） */
export const MIN_PIXELS = 100 * 28 * 28;
/** 像素预算上限：16384 * 28 * 28（action_parser.py 的 MAX_PIXELS） */
export const MAX_PIXELS = 16384 * 28 * 28;
/** 官方允许的最大宽高比 */
export const MAX_RATIO = 200;

export interface SmartResizeOptions {
  factor?: number;
  minPixels?: number;
  maxPixels?: number;
}

/**
 * Python `round()` 语义：round-half-even（银行家舍入）。
 * JS Math.round 对 .5 恒向上，直接用会在 x.5 边界上与推理端差一个 factor。
 */
export function roundHalfEven(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // 恰好 .5：舍入到偶数（floor 与 floor+1 必有一偶）
  return floor % 2 === 0 ? floor : floor + 1;
}

/** round_by_factor：最接近 number 且被 factor 整除（Python round 语义） */
export function roundByFactor(n: number, factor: number): number {
  return roundHalfEven(n / factor) * factor;
}

/** ceil_by_factor：不小于 number 的最小 factor 倍数 */
export function ceilByFactor(n: number, factor: number): number {
  return Math.ceil(n / factor) * factor;
}

/** floor_by_factor：不大于 number 的最大 factor 倍数 */
export function floorByFactor(n: number, factor: number): number {
  return Math.floor(n / factor) * factor;
}

/**
 * smart_resize：把 (height, width) 调整为「都能被 factor 整除、总像素落在
 * [min_pixels, max_pixels] 内、尽量保持宽高比」的尺寸。与官方实现逐行对应。
 *
 * 注意：传入的必须是**原始截图尺寸**——原版参数名叫 origin_resized_*，
 * 但官方调用处传的就是原始分辨率（坑 3）。
 */
export function smartResize(
  height: number,
  width: number,
  opts: SmartResizeOptions = {},
): { height: number; width: number } {
  const factor = opts.factor ?? IMAGE_FACTOR;
  const minPixels = opts.minPixels ?? MIN_PIXELS;
  const maxPixels = opts.maxPixels ?? MAX_PIXELS;

  if (Math.max(height, width) / Math.min(height, width) > MAX_RATIO) {
    throw new Error(
      `absolute aspect ratio must be smaller than ${MAX_RATIO}, got ${Math.max(height, width) / Math.min(height, width)}`,
    );
  }

  let hBar = Math.max(factor, roundByFactor(height, factor));
  let wBar = Math.max(factor, roundByFactor(width, factor));

  if (hBar * wBar > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    hBar = floorByFactor(height / beta, factor);
    wBar = floorByFactor(width / beta, factor);
  } else if (hBar * wBar < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    hBar = ceilByFactor(height * beta, factor);
    wBar = ceilByFactor(width * beta, factor);
  }
  return { height: hBar, width: wBar };
}

/**
 * 解析模型输出的坐标串："(x1,y1,x2,y2)" 四数框或 "(x,y)" 两数点。
 * 宽容空格；数字允许负值与浮点（与原版 float() 一致）。解析失败返回 null。
 */
export function parseUitarsBox(box: string): number[] | null {
  const inner = box.trim().replace(/^\(/, "").replace(/\)$/, "");
  if (inner.length === 0) return null;
  const parts = inner.split(",").map((p) => p.trim());
  if (parts.length !== 2 && parts.length !== 4) return null;
  const numbers: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    numbers.push(n);
  }
  return numbers;
}

/**
 * 坐标换算全管线：UI-TARS 模型输出（smart_resize 空间）→ 截图像素坐标。
 *
 * @param box        模型输出的 "(x,y)" 或 "(x1,y1,x2,y2)"
 * @param imageWidth  截图宽度（**原始**分辨率，像素）
 * @param imageHeight 截图高度（**原始**分辨率，像素）
 * @param opts        smart_resize 像素预算——必须与推理端一致（坑 1）
 * @returns 中心点在截图坐标系的位置（round 到 3 位小数，与原版 round(x, 3) 一致）
 */
export function uitarsToScreenshotCoords(
  box: string,
  imageWidth: number,
  imageHeight: number,
  opts: SmartResizeOptions = {},
): { x: number; y: number } {
  const numbers = parseUitarsBox(box);
  if (numbers === null) {
    throw new Error(`无法解析 UI-TARS 坐标：${box}`);
  }
  // 两数点复制成四数框（原版：len(float_numbers) == 2 时首尾各复制一次）
  if (numbers.length === 2) {
    numbers.push(numbers[0]!, numbers[1]!);
  }
  const [x1, y1, x2, y2] = numbers as [number, number, number, number];

  // 推理端的 smart_resize 分母：用原始分辨率算（坑 2、3——必须 roundHalfEven + 原始尺寸）
  const resized = smartResize(imageHeight, imageWidth, opts);

  // 归一化（qwen25vl 路径：偶数位 / resizedWidth，奇数位 / resizedHeight）
  const nx1 = x1 / resized.width;
  const nx2 = x2 / resized.width;
  const ny1 = y1 / resized.height;
  const ny2 = y2 / resized.height;

  // 还原到截图像素（原版 round(..., 3)）
  const round3 = (n: number): number => roundHalfEven(n * 1000) / 1000;
  return {
    x: round3(((nx1 + nx2) / 2) * imageWidth),
    y: round3(((ny1 + ny2) / 2) * imageHeight),
  };
}
