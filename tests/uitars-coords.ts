/**
 * UI-TARS 坐标换算单测（src/tools/uitars-coords.ts）。
 *
 * 期望值全部手工按官方 action_parser.py 语义推得，固化 AGENTS.md 记录的三个坑：
 * 银行家舍入（roundHalfEven ≠ Math.round）、像素预算常量、原始分辨率入参。
 */

import { test, assert } from "./registry.js";
import {
  MAX_PIXELS,
  ceilByFactor,
  floorByFactor,
  parseUitarsBox,
  roundByFactor,
  roundHalfEven,
  smartResize,
  uitarsToScreenshotCoords,
} from "../src/tools/uitars-coords.js";

test("roundHalfEven：银行家舍入，.5 边界舍到偶数（Math.round 做不到）", () => {
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(3.5), 4);
  assert.equal(roundHalfEven(1.4), 1);
  assert.equal(roundHalfEven(1.6), 2);
  assert.equal(roundHalfEven(-0.5), 0);
  assert.equal(roundHalfEven(-2.5), -2);
  // Math.round(14.5) = 15，Python round(14.5) = 14——这是两个语言的关键分歧点
  assert.equal(roundHalfEven(14.5), 14);
  assert.equal(roundHalfEven(15.5), 16);
});

test("roundByFactor / ceilByFactor / floorByFactor：与官方辅助函数一致", () => {
  assert.equal(roundByFactor(450, 28), 448); // round(16.07)*28
  assert.equal(roundByFactor(434, 28), 448); // 434 = 15.5*28，银行家舍入 → 16
  assert.equal(roundByFactor(406, 28), 392); // 406 = 14.5*28，银行家舍入 → 14（Math.round 会错给 420）
  assert.equal(ceilByFactor(449, 28), 476); // ceil(16.04)*28
  assert.equal(floorByFactor(447, 28), 420); // floor(15.96)*28
});

test("smartResize：常规尺寸只做 factor 对齐，不动像素预算", () => {
  // round(3000/28)=107 → 2996；round(2000/28)=71 → 1988；乘积在预算内不再调整
  assert.deepEqual(smartResize(3000, 2000), { height: 2996, width: 1988 });
  // 整数倍原样通过
  assert.deepEqual(smartResize(448, 448), { height: 448, width: 448 });
});

test("smartResize：.5 边界走银行家舍入（对拍坑 2）", () => {
  // 406 = 14.5*28：Python round → 14*28 = 392；JS Math.round 会错给 420
  assert.deepEqual(smartResize(406, 448), { height: 392, width: 448 });
});

test("smartResize：小于 min_pixels 时按 beta 放大到 ceil_by_factor", () => {
  // 20×20：h_bar=w_bar=28 → 784 < 78400；beta=sqrt(78400/400)=14 → ceil(280/28)*28=280
  assert.deepEqual(smartResize(20, 20), { height: 280, width: 280 });
});

test("smartResize：超过 max_pixels 时按 beta 缩小到 floor_by_factor（预算内即止）", () => {
  const { height, width } = smartResize(10000, 10000);
  assert.equal(height % 28, 0);
  assert.equal(width % 28, 0);
  assert.ok(height * width <= MAX_PIXELS, `缩放后应落在预算内：${height}x${width}`);
  assert.ok(height < 10000 && width < 10000, "确实缩小了");
});

test("smartResize：宽高比超过 200 抛错（与官方 ValueError 对齐）", () => {
  assert.throws(() => smartResize(1, 1000), /aspect ratio/);
});

test("parseUitarsBox：两数点 / 四数框 / 浮点负值 / 非法输入", () => {
  assert.deepEqual(parseUitarsBox("(994,756)"), [994, 756]);
  assert.deepEqual(parseUitarsBox("(100, 50, 300, 250)"), [100, 50, 300, 250]);
  assert.deepEqual(parseUitarsBox("(1.5,-2)"), [1.5, -2]);
  assert.equal(parseUitarsBox("abc"), null);
  assert.equal(parseUitarsBox("(1,2,3)"), null);
  assert.equal(parseUitarsBox(""), null);
  assert.equal(parseUitarsBox("(a,b)"), null);
});

test("uitarsToScreenshotCoords：两数点归一化后还原为截图像素", () => {
  // 2000×1500 截图：smartResize → {1512, 1988}；模型点 (994,756)：
  // x = 994/1988*2000 = 1000；y = 756/1512*1500 = 750
  assert.deepEqual(uitarsToScreenshotCoords("(994,756)", 2000, 1500), { x: 1000, y: 750 });
});

test("uitarsToScreenshotCoords：四数框取中心还原，round 保留 3 位小数", () => {
  // x = (100+300)/2/1988*2000 = 201.207…；y = (50+250)/2/1512*1500 = 148.809…→ 148.81
  assert.deepEqual(uitarsToScreenshotCoords("(100,50,300,250)", 2000, 1500), {
    x: 201.207,
    y: 148.81,
  });
});

test("uitarsToScreenshotCoords：两数点自动复制成框（原版 len==2 分支）", () => {
  assert.deepEqual(uitarsToScreenshotCoords("(994,756)", 2000, 1500), { x: 1000, y: 750 });
});

test("uitarsToScreenshotCoords：非法坐标串抛错而不是静默给错点", () => {
  assert.throws(() => uitarsToScreenshotCoords("(a,b)", 2000, 1500), /无法解析/);
});

test("uitarsToScreenshotCoords：像素预算可覆写，与推理端配置对齐（对拍坑 1）", () => {
  // 覆写 max_pixels 后走缩小路径：2000×1500 初始 round 后 1512*1988=3,005,856
  // 限 max=1,000,000 → beta=sqrt(3,000,000/1,000,000)=1.732…
  // resized: floor(1500/beta/28)*28 与 floor(2000/beta/28)*28，归一化分母随之变化
  const small = smartResize(1500, 2000, { maxPixels: 1_000_000 });
  const out = uitarsToScreenshotCoords("(994,756)", 2000, 1500, { maxPixels: 1_000_000 });
  const expectX = roundHalfEven(((994 / small.width) * 2000) * 1000) / 1000;
  const expectY = roundHalfEven(((756 / small.height) * 1500) * 1000) / 1000;
  assert.equal(out.x, expectX);
  assert.equal(out.y, expectY);
  assert.ok(small.width < 1988, "覆写预算后分母应缩小");
});

// ---- resolveUitarsOverride：computer 工具的 uitarsBox 参数接线 ----

import { resolveUitarsOverride } from "../src/tools/computer.js";

test("resolveUitarsOverride：未传 uitars 参数时返回 null（走原 x/y 通道）", () => {
  assert.equal(resolveUitarsOverride({ action: "click", x: 10, y: 20 }, 2000, 1500), null);
});

test("resolveUitarsOverride：四数框换算成截图像素中心并 round 到整数", () => {
  // 1000×1000 截图：smartResize → 1008×1008；框 (500,500,600,600) 中心
  // x = 550/1008*1000 = 545.63… → 546
  assert.deepEqual(resolveUitarsOverride({ uitarsBox: "(500,500,600,600)" }, 1000, 1000), {
    x: 546,
    y: 546,
  });
});

test("resolveUitarsOverride：两数点等价于单点框", () => {
  // x = 100/1008*1000 = 99.206… → 99；y = 200/1008*1000 = 198.41… → 198
  assert.deepEqual(resolveUitarsOverride({ uitarsBox: "(100,200)" }, 1000, 1000), {
    x: 99,
    y: 198,
  });
});

test("resolveUitarsOverride：uitarsBox2 换算 drag 终点", () => {
  // (0,0,1008,1008) 中心 = 归一化 0.5 → (500,500)；起点框中心 148.81 → 149
  assert.deepEqual(
    resolveUitarsOverride({ uitarsBox: "(100,100,200,200)", uitarsBox2: "(0,0,1008,1008)" }, 1000, 1000),
    { x: 149, y: 149, x2: 500, y2: 500 },
  );
});

test("resolveUitarsOverride：没有截图尺寸时报错提示先 screenshot", () => {
  const out = resolveUitarsOverride({ uitarsBox: "(100,100,200,200)" }, 0, 0);
  assert.equal(typeof out, "string");
  assert.match(out as string, /先成功执行一次 screenshot/);
});

test("resolveUitarsOverride：非法坐标串透传错误文案", () => {
  const out = resolveUitarsOverride({ uitarsBox: "(1,2,3)" }, 2000, 1500);
  assert.equal(typeof out, "string");
  assert.match(out as string, /无法解析/);
});
