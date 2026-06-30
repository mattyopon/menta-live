/**
 * MentraTrigger — Trigger ポートの @mentra/sdk 実装。
 *
 * Rokid のテンプルタップ (KEYCODE_ENTER) に相当するのが Mentra Live の物理ボタン。
 * session.events.onButtonPress((p) => p.pressType: "short" | "long")。
 *
 * ⚠️ 機差注意: Mentra Live のハード profile はボタン 1 個・スワイプ無し
 * (capabilities/mentra-live.ts: hasButton:true, count:1)。
 * Rokid 版にあった「メニュー上下スワイプ」はこの機では使えないので、
 * 試験選択/モード切替は音声 (QuizController) と長押しに寄せている。
 */

import type { AppSession } from "@mentra/sdk";
import type { Trigger } from "../io/ports.js";

export class MentraTrigger implements Trigger {
  constructor(private readonly session: AppSession) {}

  onShortPress(handler: () => void): () => void {
    return this.session.events.onButtonPress((p) => {
      if (p.pressType === "short") handler();
    });
  }

  onLongPress(handler: () => void): () => void {
    return this.session.events.onButtonPress((p) => {
      if (p.pressType === "long") handler();
    });
  }
}
