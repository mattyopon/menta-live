/**
 * QuizController — 音声コマンド & 物理ボタンを QuizSession に束ねる。
 *
 * 表示なし機の UX 中枢。MenuActivity (試験選択/モード切替/コスト) と MainActivity の
 * トリガ配線を、音声 + ボタン 1 個に再構成する。SDK 非依存 (VoiceIO / Trigger ポート依存)。
 *
 * 重要: マイクは周囲の発話を全部拾う。recognizeCommand が null を返す発話には
 * 一切反応しない (= 勝手に喋らない)。反応するのは明示コマンドとボタンだけ。
 */

import { examListSpeech, recognizeCommand } from "../exams/examMatcher.js";
import { DISPLAY } from "../exams/examPrompts.js";
import type { Logger, Trigger, VoiceIO } from "../io/ports.js";
import type { VisionBackend } from "../vision/visionBackend.js";
import { QuizSession } from "./quizSession.js";
import { costToSpeech, examSelectedSpeech } from "./speech.js";

const HELP_SPEECH =
  "使い方です。問題に向けてボタンを短く押すと撮影して解答します。" +
  "試験を変えるには試験コードか名前を言ってください。" +
  "ボタン長押しで、高精度と節約モードを切り替えます。" +
  "もう一度、コスト、一覧、診断、と言うこともできます。";

export interface QuizControllerDeps {
  readonly session: QuizSession;
  readonly voice: VoiceIO;
  readonly trigger: Trigger;
  readonly backend: VisionBackend;
  /** 「診断」で読み上げるデバイス能力サマリ (任意)。表示なし機の実機確認用。 */
  readonly getDiagnostics?: () => string;
  readonly logger?: Logger;
}

export class QuizController {
  private readonly session: QuizSession;
  private readonly voice: VoiceIO;
  private readonly trigger: Trigger;
  private readonly backend: VisionBackend;
  private readonly getDiagnostics?: () => string;
  private readonly log: Logger;
  private readonly cleanups: Array<() => void> = [];

  constructor(deps: QuizControllerDeps) {
    this.session = deps.session;
    this.voice = deps.voice;
    this.trigger = deps.trigger;
    this.backend = deps.backend;
    this.getDiagnostics = deps.getDiagnostics;
    this.log = deps.logger ?? console;
  }

  /** ハンドラを配線する。dispose で全解除。 */
  start(): void {
    this.cleanups.push(this.trigger.onShortPress(() => this.session.onTrigger()));
    this.cleanups.push(this.trigger.onLongPress(() => void this.onToggleProfile()));
    this.cleanups.push(
      this.voice.onUtterance((u) => {
        if (!u.isFinal) return; // 確定発話のみ
        void this.onUtterance(u.text);
      }),
    );
  }

  /** セッション開始時の案内。現在の試験とモードを読み上げる。 */
  async welcome(): Promise<void> {
    const cfg = this.session.getConfig();
    const examName = (DISPLAY[cfg.examCode] ?? cfg.examCode).split("·")[0]?.trim();
    const profile = cfg.authMode === "api_key" ? "高精度" : "節約";
    await this.safeSpeak(
      `AWSクイズアシスタントです。現在の試験は ${examName}、モードは ${profile} です。` +
        "問題に向けてボタンを押すと解答します。困ったら、ヘルプ、と言ってください。",
    );
  }

  private async onUtterance(text: string): Promise<void> {
    const cmd = recognizeCommand(text);
    if (!cmd) return; // 未認識は無反応
    this.log.info(`command: ${cmd.kind} <- ${JSON.stringify(text)}`);
    switch (cmd.kind) {
      case "selectExam":
        this.session.setExam(cmd.code);
        await this.safeSpeak(examSelectedSpeech(cmd.display));
        return;
      case "capture":
        this.session.onTrigger();
        return;
      case "repeat": {
        const ok = await this.session.repeatLast();
        if (!ok) await this.safeSpeak("まだ解答がありません。");
        return;
      }
      case "cost":
        await this.onCost();
        return;
      case "toggleMode":
        await this.onToggleProfile();
        return;
      case "setMode":
        this.session.setProfile(cmd.profile);
        await this.safeSpeak(cmd.profile === "high" ? "高精度モードにしました。" : "節約モードにしました。");
        return;
      case "listExams":
        await this.safeSpeak(examListSpeech());
        return;
      case "diagnostics":
        await this.onDiagnostics();
        return;
      case "help":
        await this.safeSpeak(HELP_SPEECH);
        return;
      case "stop":
        await this.safeSpeak("待機します。");
        return;
      default:
        return;
    }
  }

  private async onToggleProfile(): Promise<void> {
    const profile = this.session.toggleProfile();
    await this.safeSpeak(profile === "high" ? "高精度モードにしました。" : "節約モードにしました。");
  }

  /**
   * 「診断」: TTS セルフテスト + デバイス能力サマリ。
   * 実機到着後に「スピーカーが鳴るか」「マイク/カメラ/ボタンが認識されているか」を確認する用。
   */
  private async onDiagnostics(): Promise<void> {
    await this.safeSpeak(
      "音声テストです。1、2、3。これが聞こえていれば、スピーカーは動作しています。",
    );
    if (this.getDiagnostics) {
      await this.safeSpeak(this.getDiagnostics());
    }
  }

  private async onCost(): Promise<void> {
    try {
      const usage = await this.backend.getUsageSession();
      await this.safeSpeak(costToSpeech(usage.total_usd));
    } catch (e) {
      this.log.warn("usage fetch failed", e);
      await this.safeSpeak("コストの取得に失敗しました。");
    }
  }

  private async safeSpeak(text: string): Promise<void> {
    try {
      await this.voice.speak(text, { interrupt: true });
    } catch (e) {
      this.log.warn("speak failed", e);
    }
  }

  dispose(): void {
    for (const c of this.cleanups.splice(0)) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
    this.session.dispose();
  }
}
