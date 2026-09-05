/**
 * 消息队列：两条独立通道。
 * - steering：中途插入指令，在内层循环每一轮开始前被取走，注入当前消息
 * - followUp：后续指令，在外层循环切换到下一轮任务时被取走
 */

export class MessageQueue {
  private steering: string[] = [];
  private followUps: string[] = [];

  enqueueSteering(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length > 0) this.steering.push(trimmed);
  }

  enqueueFollowUp(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length > 0) this.followUps.push(trimmed);
  }

  /** 一次性取走全部中途插入指令 */
  drainSteering(): string[] {
    const out = this.steering;
    this.steering = [];
    return out;
  }

  /** 一次性取走全部后续指令 */
  drainFollowUps(): string[] {
    const out = this.followUps;
    this.followUps = [];
    return out;
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
