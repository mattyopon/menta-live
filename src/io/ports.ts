/**
 * 移植先 (Mentra Live) のハードウェア I/O を抽象化するポート群。
 *
 * QuizSession (コアロジック) はこれらのインターフェースにのみ依存し、@mentra/sdk を
 * 直接 import しない。これにより:
 *   - コアを SDK 非依存でユニットテストできる (src/sim の偽実装で駆動)
 *   - Mentra アダプタ層 (src/mentra) を差し替えれば他機種にも write-once 対応できる
 *
 * Rokid 版では TriggerSource / CameraCapture / HudOverlay が個別に存在したが、
 * 表示なし機では HUD を VoiceIO (TTS) に置換する。
 */

/** 文字起こしイベント 1 件 (Mentra の TranscriptionData の必要部分のみ抽象化)。 */
export interface Utterance {
  readonly text: string;
  /** 発話終端 (確定) なら true。中間結果は false。 */
  readonly isFinal: boolean;
  /** 認識言語 (例 "ja-JP")。取得できなければ undefined。 */
  readonly language?: string;
}

export interface SpeakOptions {
  /** 進行中の他音声を止めて割り込む。default true。 */
  readonly interrupt?: boolean;
  /** 音量 0.0–1.0。 */
  readonly volume?: number;
}

/**
 * 音声入出力ポート。Mentra Live の出力は TTS、入力はマイク文字起こし。
 * `session.audio.speak` (出力) と `session.events.onTranscription` (入力) をラップする。
 */
export interface VoiceIO {
  /**
   * TTS でテキストを読み上げる。
   * interrupt=true (default) の実装では再生が終わるまで resolve しない
   * (Mentra の stopOtherAudio:true 挙動)。空文字を渡してはならない。
   */
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  /** 進行中の TTS を停止する (fire-and-forget)。 */
  stop(): void;
  /**
   * 文字起こしを購読する。返り値を呼ぶと購読解除。
   * 中間/確定どちらも届くので、ハンドラ側で `u.isFinal` を見て確定だけ拾う。
   */
  onUtterance(handler: (u: Utterance) => void): () => void;
}

/** カメラで撮った 1 枚の写真。 */
export interface CapturedPhoto {
  readonly bytes: Uint8Array;
  /** 例 "image/jpeg"。backend の SUPPORTED_IMAGE_MEDIA_TYPES と整合させる。 */
  readonly mimeType: string;
}

/** カメラ撮影ポート。`session.camera.requestPhoto` をラップする。 */
export interface Camera {
  /** 単発撮影。失敗時は reject。 */
  capturePhoto(): Promise<CapturedPhoto>;
}

/**
 * 物理トリガ (ボタン) ポート。Rokid の TriggerSource (テンプルタップ=KEYCODE_ENTER) に相当。
 * Mentra Live はボタン 1 個 (short/long)。`session.events.onButtonPress` をラップする。
 */
export interface Trigger {
  /** 短押し → 撮影。返り値で解除。 */
  onShortPress(handler: () => void): () => void;
  /** 長押し → モード切替など (任意)。返り値で解除。 */
  onLongPress(handler: () => void): () => void;
}

/** 最小ロガー (console と互換)。 */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
