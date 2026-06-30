/**
 * Vision バックエンド (推論の頭脳) ポート。
 *
 * これは rokid-glass-day1 の `BackendClient.kt` が話していた契約をそのまま TypeScript 化したもの。
 * 推論の実体 (Anthropic Vision 呼び出し / dedup / auth mode / AWS-knowledge MCP grounding /
 * rate-limit fallback) は既存の Python FastAPI バックエンド (`backend/main.py`) に残し、
 * Mentra Live アプリは「新しいグラスクライアント」としてこのポート経由で叩くだけ。
 *
 * → 移植の本質: Android+HUD クライアントを Mentra+TTS クライアントに差し替え、頭脳は再利用。
 */

export type InferenceMode = "haiku" | "sonnet" | "opus";
export type AuthMode = "api_key" | "max_sub";

/** POST /vision/session の multipart リクエストに対応。 */
export interface VisionRequest {
  /** UUID v4。retry 時は同じ id を再送する (backend dedup と整合)。 */
  readonly requestId: string;
  /** 撮影画像 (JPEG bytes)。 */
  readonly imageJpeg: Uint8Array;
  /** 画像の MIME タイプ (例 "image/jpeg")。省略時は image/jpeg として送る。 */
  readonly mimeType?: string;
  /** 試験別 system prompt (examPrompts.forCode の戻り値)。 */
  readonly prompt: string;
  readonly mode: InferenceMode;
  readonly authMode: AuthMode;
  /** OCR grounding 等の補助テキスト (任意)。 */
  readonly userText?: string;
}

/** POST /vision/session の JSON レスポンスに対応。 */
export interface VisionResult {
  readonly requestId: string;
  /** 解答記号 ("A" / "A, C" / "?" / "") など。BASE prompt により記号のみが返る。 */
  readonly text: string;
  readonly elapsedMs: number;
  /** 使用モデル id (例 "claude-haiku-4-5-20251001")。haiku fallback 検知に使える。 */
  readonly model: string;
}

/** GET /usage/session のレスポンス (必要部分のみ)。 */
export interface UsageSession {
  readonly total_usd: number;
  readonly breakdown: Record<string, Record<string, number>>;
  readonly note?: string;
}

/**
 * BackendClient.kt の sealed class BackendError を TS のタグ付きユニオン (kind) で再現。
 * QuizSession はこの kind を見て「retry するか / 何を読み上げるか」を決める。
 */
export type BackendErrorKind =
  | "dns" // 名前解決失敗
  | "network_unreachable" // ネットワーク到達不可
  | "connect_fail" // 接続失敗
  | "connect_timeout" // 接続待ちタイムアウト (retry 対象)
  | "read_timeout" // 応答タイムアウト (retry 対象)
  | "http" // HTTP 非 2xx (httpCode 同梱)
  | "parse"; // JSON / フィールド欠落

export class BackendError extends Error {
  override readonly name = "BackendError";
  constructor(
    readonly kind: BackendErrorKind,
    message: string,
    /** kind === "http" のときの HTTP ステータス。 */
    readonly httpCode?: number,
  ) {
    super(message);
  }
}

/** Vision バックエンドのクライアント契約。 */
export interface VisionBackend {
  /**
   * 画像 + prompt を推論して解答記号を得る。
   * @param signal 呼び出し側のキャンセル用 (新トリガでの preempt 等)。abort 時は AbortError を throw。
   * @throws {BackendError} ネットワーク/HTTP/parse 系の分類済みエラー。
   */
  infer(req: VisionRequest, signal?: AbortSignal): Promise<VisionResult>;
  /** セッション累計の API コストを取得。 */
  getUsageSession(): Promise<UsageSession>;
  /** GET /health が 200 なら true。 */
  health(): Promise<boolean>;
}
