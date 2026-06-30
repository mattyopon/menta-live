/**
 * QuizSession — 出題アシストの状態機械。rokid-glass-day1 `AppViewModel.kt` の音声版移植。
 *
 * Rokid 版との対応:
 *   Phase.Idle/Capturing/Uploading/Showing/ShowingError
 *     → idle / capturing / uploading / speaking / speakingError
 *   HudOverlay.show(text)      → voice.speak(text)
 *   CameraCapture.capture...   → camera.capturePhoto()
 *   BackendClient.postVision   → backend.infer()
 *   currentRequestId 軸での stale guard / 単発リトライ / AUTO_LOOP は設計書通り維持。
 *
 * SDK 非依存: Camera / VoiceIO / VisionBackend ポートにのみ依存し、@mentra/sdk は import しない。
 */

import { forCode } from "../exams/examPrompts.js";
import type { Camera, Logger, VoiceIO } from "../io/ports.js";
import {
  BackendError,
  type AuthMode,
  type InferenceMode,
  type VisionBackend,
  type VisionResult,
} from "../vision/visionBackend.js";
import {
  CAMERA_FAIL_SPEECH,
  GENERIC_ERROR_SPEECH,
  backendErrorToSpeech,
  composeAnswerSpeech,
} from "./speech.js";

export type Phase = "idle" | "capturing" | "uploading" | "speaking" | "speakingError";

export interface QuizConfig {
  /** 現在の試験コード (examPrompts のキー)。 */
  examCode: string;
  /** 推論モデル。 */
  mode: InferenceMode;
  /** backend auth path。 */
  authMode: AuthMode;
  /** 成功後 N ms で次の撮影を自動発火 (0=手動のみ)。AUTO_LOOP_DELAY_MS 相当。 */
  autoLoopDelayMs: number;
  /**
   * 撮影直後に押下を知らせる短いキュー (空/undefined で無効)。
   * 表示なし機では「押せたか」が分からないので即時フィードバックを返す。非ブロッキングで撮影と並行。
   */
  captureCueText?: string;
  /**
   * 推論が slowCueAfterMs を超えても返らないとき一度だけ流す安心キュー (空/undefined で無効)。
   * Rokid 版 HUD の経過秒ティッカー (「⏳思考中 N.Ns」) の音声版。
   */
  slowCueText?: string;
  /** slowCue を出すまでの待ち時間 (ms)。0 で無効。 */
  slowCueAfterMs?: number;
  /**
   * 要求モデルが rate-limit で格下げされた (opus/sonnet→haiku) とき、解答末尾に
   * 「ハイクで回答」等を付すか。精度低下の合図。default true。
   */
  announceFallback?: boolean;
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * AUTO_LOOP のための setTimeout 抽象 (テストで偽タイマを差せるように)。
 * 返り値は clear 用ハンドル。
 */
export interface Clock {
  setTimeout(fn: () => void, ms: number): () => void;
}

const realClock: Clock = {
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

export interface QuizSessionDeps {
  readonly camera: Camera;
  readonly voice: VoiceIO;
  readonly backend: VisionBackend;
  readonly config: QuizConfig;
  readonly logger?: Logger;
  readonly genRequestId?: () => string;
  readonly clock?: Clock;
}

export class QuizSession {
  private readonly camera: Camera;
  private readonly voice: VoiceIO;
  private readonly backend: VisionBackend;
  private readonly cfg: QuizConfig;
  private readonly log: Logger;
  private readonly genRequestId: () => string;
  private readonly clock: Clock;

  private phase: Phase = "idle";
  private currentRequestId: string | null = null;
  private inflight: AbortController | null = null;
  private cancelAutoLoop: (() => void) | null = null;
  /** 直前に読み上げた解答 (repeat 用)。 */
  private lastAnswerSpeech: string | null = null;

  constructor(deps: QuizSessionDeps) {
    this.camera = deps.camera;
    this.voice = deps.voice;
    this.backend = deps.backend;
    this.cfg = deps.config;
    this.log = deps.logger ?? console;
    this.genRequestId = deps.genRequestId ?? (() => crypto.randomUUID());
    this.clock = deps.clock ?? realClock;
  }

  getPhase(): Phase {
    return this.phase;
  }

  getConfig(): Readonly<QuizConfig> {
    return this.cfg;
  }

  setExam(code: string): void {
    this.cfg.examCode = code;
  }

  setMode(mode: InferenceMode): void {
    this.cfg.mode = mode;
  }

  setAuthMode(authMode: AuthMode): void {
    this.cfg.authMode = authMode;
  }

  /**
   * 高精度 (api_key + opus) ⇔ 節約 (max_sub + haiku) を切替 (MenuActivity.toggleAuthMode 相当)。
   * 戻り値は切替後のプロファイル。
   */
  toggleProfile(): "high" | "save" {
    if (this.cfg.authMode === "api_key") {
      this.cfg.authMode = "max_sub";
      this.cfg.mode = "haiku";
      return "save";
    }
    this.cfg.authMode = "api_key";
    this.cfg.mode = "opus";
    return "high";
  }

  setProfile(profile: "high" | "save"): void {
    if (profile === "high") {
      this.cfg.authMode = "api_key";
      this.cfg.mode = "opus";
    } else {
      this.cfg.authMode = "max_sub";
      this.cfg.mode = "haiku";
    }
  }

  /** 直前の解答をもう一度読み上げる。無ければ false。 */
  async repeatLast(): Promise<boolean> {
    if (!this.lastAnswerSpeech) return false;
    try {
      await this.voice.speak(this.lastAnswerSpeech, { interrupt: true });
    } catch (e) {
      this.log.warn("repeat speak failed", e);
    }
    return true;
  }

  /**
   * 撮影トリガ (ボタン短押し / 音声 capture)。AppViewModel.onTrigger 相当。
   * Capturing/Uploading 中の連打は無視 (currentRequestId 維持)。
   */
  onTrigger(): void {
    if (this.phase !== "idle" && this.phase !== "speaking" && this.phase !== "speakingError") {
      this.log.info(`onTrigger ignored (phase=${this.phase})`);
      return;
    }
    // speaking 中の再トリガなら、進行中 TTS を即止めて新フローへ
    if (this.phase === "speaking" || this.phase === "speakingError") {
      this.voice.stop();
    }
    this.clearAutoLoop();

    const rid = this.genRequestId();
    this.currentRequestId = rid;
    this.setPhase("capturing");

    this.inflight?.abort();
    this.inflight = new AbortController();
    const signal = this.inflight.signal;
    void this.runFlow(rid, signal);
  }

  private async runFlow(rid: string, signal: AbortSignal): Promise<void> {
    // 押下の即時フィードバック (非ブロッキング = 撮影と並行)。表示なし機では「効いたか」が
    // 分からないので重要。interrupt=true で直前に残った音声を切る。
    if (this.cfg.captureCueText) {
      void this.voice.speak(this.cfg.captureCueText, { interrupt: true }).catch(() => {});
    }

    // 1) 撮影
    let photo;
    try {
      photo = await this.camera.capturePhoto();
    } catch (e) {
      if (isAbortError(e)) return; // 正常な teardown
      this.log.error("capture failed", e);
      return this.setError(rid, CAMERA_FAIL_SPEECH);
    }
    if (rid !== this.currentRequestId) return; // stale

    // 2) 推論
    this.setPhase("uploading");
    // 遅延時の安心キュー: slowCueAfterMs 超でまだ待っていれば一度だけ流す。
    // stopOtherAudio=false で控えめに鳴らし、解答 (interrupt=true) が来たら止まる。
    let cancelSlowCue: (() => void) | null = null;
    const slowText = this.cfg.slowCueText;
    const slowMs = this.cfg.slowCueAfterMs ?? 0;
    if (slowText && slowMs > 0) {
      cancelSlowCue = this.clock.setTimeout(() => {
        cancelSlowCue = null;
        if (rid === this.currentRequestId && this.phase === "uploading") {
          void this.voice.speak(slowText, { interrupt: false }).catch(() => {});
        }
      }, slowMs);
    }

    let result: VisionResult | null;
    try {
      result = await this.postWithSingleRetry(rid, photo.bytes, photo.mimeType, signal);
    } finally {
      cancelSlowCue?.();
    }
    if (result === null) return; // エラー読み上げ済み or キャンセル
    if (rid !== this.currentRequestId) return; // stale

    // 3) 解答読み上げ
    this.setPhase("speaking");
    const speech = composeAnswerSpeech(
      result.text,
      this.cfg.mode,
      result.model,
      this.cfg.announceFallback ?? true,
    );
    this.lastAnswerSpeech = speech;
    this.log.info(
      `answer rid=${rid} text=${JSON.stringify(result.text)} model=${result.model} elapsed=${result.elapsedMs}ms`,
    );
    try {
      await this.voice.speak(speech, { interrupt: true });
    } catch (e) {
      this.log.warn("answer speak failed", e);
    }
    this.onSpoken(rid, false);
  }

  /**
   * 単発リトライ付き POST。AppViewModel.postWithSingleRetry 相当。
   * connect/read timeout は同 request_id で 1 回だけ再送 (backend dedup と整合)。
   * その他のエラーは読み上げて null を返す。キャンセル (AbortError) は静かに null。
   */
  private async postWithSingleRetry(
    rid: string,
    imageJpeg: Uint8Array,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<VisionResult | null> {
    const prompt = forCode(this.cfg.examCode);
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      try {
        return await this.backend.infer(
          {
            requestId: rid,
            imageJpeg,
            mimeType,
            prompt,
            mode: this.cfg.mode,
            authMode: this.cfg.authMode,
          },
          signal,
        );
      } catch (e) {
        if (isAbortError(e)) return null; // 呼び出し側キャンセル → 静かに離脱
        if (e instanceof BackendError) {
          const retryable = e.kind === "connect_timeout" || e.kind === "read_timeout";
          if (retryable && attempt < 2) {
            this.log.warn(`backend ${e.kind}, retrying once rid=${rid}`);
            continue;
          }
          this.setError(rid, backendErrorToSpeech(e));
          return null;
        }
        this.log.error("backend infer failed (non-BackendError)", e);
        this.setError(rid, GENERIC_ERROR_SPEECH);
        return null;
      }
    }
    return null;
  }

  /** エラー読み上げ → speakingError → 完了で onSpoken(error=true)。 */
  private setError(rid: string, speech: string): void {
    if (rid !== this.currentRequestId) return;
    this.setPhase("speakingError");
    this.voice
      .speak(speech, { interrupt: true })
      .catch((e) => this.log.warn("error speak failed", e))
      .finally(() => this.onSpoken(rid, true));
  }

  /**
   * 読み上げ完了後の後始末。AppViewModel.onShowingTimerExpired 相当。
   * 成功時のみ AUTO_LOOP で次撮影を予約 (失敗からは loop しない: backend ダウン時の暴走防止)。
   */
  private onSpoken(rid: string, wasError: boolean): void {
    if (rid !== this.currentRequestId) return; // stale timer 防止
    this.setPhase("idle");
    this.currentRequestId = null;

    if (this.cfg.autoLoopDelayMs > 0 && !wasError) {
      this.cancelAutoLoop = this.clock.setTimeout(() => {
        this.cancelAutoLoop = null;
        if (this.phase === "idle") this.onTrigger();
      }, this.cfg.autoLoopDelayMs);
    }
  }

  private clearAutoLoop(): void {
    if (this.cancelAutoLoop) {
      this.cancelAutoLoop();
      this.cancelAutoLoop = null;
    }
  }

  private setPhase(p: Phase): void {
    this.phase = p;
  }

  /** Session 終了時に呼ぶ。進行中フローと AUTO_LOOP を止める。 */
  dispose(): void {
    this.inflight?.abort();
    this.clearAutoLoop();
    this.voice.stop();
    this.currentRequestId = null;
    this.phase = "idle";
  }
}
