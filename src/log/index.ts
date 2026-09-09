/**
 * 日志模块统一出口：引用方只认这里，不直接 import logger.ts。
 * 详见 doc/README.md。
 */

export {
  log,
  initFileLogging,
  setLogLevel,
  logFilePath,
  errorText,
  type LogLevel,
  type LevelSetting,
} from "./logger.js";
