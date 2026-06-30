/**
 * グラス無しでコアを駆動するための偽 I/O 実装 (Simulated 開発用)。
 *
 * - FakeVoiceIO: speak をコンソール出力、emit() で文字起こしを注入
 * - FakeCamera: ディスク上の JPEG を読んで返す (実 backend を実画像で叩ける)
 * - FakeTrigger: pressShort/pressLong で物理ボタンを模擬
 *
 * これにより src/core (QuizSession/QuizController/examMatcher) を @mentra/sdk 無しで
 * end-to-end に検証できる。@mentra/sdk には一切依存しない。
 */

import { readFile } from "node:fs/promises";
import type { Camera, CapturedPhoto, Trigger, Utterance, VoiceIO } from "../io/ports.js";

export class FakeVoiceIO implements VoiceIO {
  private readonly handlers = new Set<(u: Utterance) => void>();

  speak(text: string): Promise<void> {
    process.stdout.write(`🔊  ${text}\n`);
    return Promise.resolve();
  }

  stop(): void {
    process.stdout.write("⏹  (stop)\n");
  }

  onUtterance(handler: (u: Utterance) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** ASR の確定発話を注入する (テスト/CLI 用)。 */
  emit(text: string): void {
    for (const h of [...this.handlers]) h({ text, isFinal: true });
  }
}

function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

export class FakeCamera implements Camera {
  /** 現在の撮影対象ファイルパスを返す getter (null なら撮影失敗を模擬)。 */
  constructor(private readonly getPath: () => string | null) {}

  async capturePhoto(): Promise<CapturedPhoto> {
    const path = this.getPath();
    if (!path) {
      throw new Error("no sim photo set — use `photo <path>` first");
    }
    const buf = await readFile(path);
    return { bytes: new Uint8Array(buf), mimeType: guessMime(path) };
  }
}

export class FakeTrigger implements Trigger {
  private readonly shortHandlers = new Set<() => void>();
  private readonly longHandlers = new Set<() => void>();

  onShortPress(handler: () => void): () => void {
    this.shortHandlers.add(handler);
    return () => this.shortHandlers.delete(handler);
  }

  onLongPress(handler: () => void): () => void {
    this.longHandlers.add(handler);
    return () => this.longHandlers.delete(handler);
  }

  pressShort(): void {
    for (const h of [...this.shortHandlers]) h();
  }

  pressLong(): void {
    for (const h of [...this.longHandlers]) h();
  }
}
