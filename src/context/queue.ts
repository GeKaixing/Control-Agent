/**
 * 消息队列：两条独立通道。
 * - steering：中途插入指令，在内层循环每一轮开始前被取走，注入当前消息
 * - followUp：后续指令，在外层循环切换到下一轮任务时被取走（可携带图片附件）
 */

/** 一条待消费的用户指令：正文 + 可选图片（多模态附件） */
export interface PendingFollowUp {
  text: string;
  images?: { dataUrl: string }[];
}

export class MessageQueue {
  private steering: string[] = [];
  private followUps: PendingFollowUp[] = [];

  enqueueSteering(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length > 0) this.steering.push(trimmed);
  }

  enqueueFollowUp(text: string, images?: { dataUrl: string }[]): void {
    const trimmed = text.trim();
    const hasImages = images !== undefined && images.length > 0;
    if (trimmed.length === 0 && !hasImages) return;
    this.followUps.push(hasImages ? { text: trimmed, images } : { text: trimmed });
  }

  /** 一次性取走全部中途插入指令 */
  drainSteering(): string[] {
    const out = this.steering;
    this.steering = [];
    return out;
  }

  /** 一次性取走全部后续指令 */
  drainFollowUps(): PendingFollowUp[] {
    const out = this.followUps;
    this.followUps = [];
    return out;
  }

  /** 清空两个通道（切会话时防残留 followUps 泄漏到新会话）。返回丢弃条数，便于日志。 */
  clear(): number {
    const n = this.steering.length + this.followUps.length;
    this.steering = [];
    this.followUps = [];
    return n;
  }

  hasSteering(): boolean {
    return this.steering.length > 0;
  }

  hasFollowUps(): boolean {
    return this.followUps.length > 0;
  }

  get pendingSteering(): number {
    return this.steering.length;
  }

  get pendingFollowUps(): number {
    return this.followUps.length;
  }
}
