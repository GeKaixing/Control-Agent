/**
 * qrcode-terminal 无官方类型（纯 JS 包），本地最小声明。
 * 只声明 bot 用到的 generate。
 */
declare module "qrcode-terminal" {
  export interface QrcodeTerminalOptions {
    small?: boolean;
  }
  export function generate(text: string, opts?: QrcodeTerminalOptions): void;
}
