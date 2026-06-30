/**
 * 解答記号・エラー・コストを「読み上げ用の日本語」に整形する純関数群。
 *
 * Rokid 版は HUD に絵文字付き文字列を出していたが、表示なし機では TTS で読むため
 * 絵文字を排し、自然に聞こえる短文へ写像する (AppViewModel.setError のメッセージ +
 * 設計書 §5.1 エラーマトリクスに対応)。
 */

import { BackendError } from "../vision/visionBackend.js";

/** カメラ取得失敗時の読み上げ。 */
export const CAMERA_FAIL_SPEECH = "カメラの取得に失敗しました。もう一度試してください。";

/** 想定外の通信エラー時の読み上げ。 */
export const GENERIC_ERROR_SPEECH = "通信エラーが発生しました。";

/**
 * backend が返した解答記号 (result.text) を読み上げ文へ。
 *   ""   → 応答なし
 *   "?"  → 解けなかった (BASE prompt の規約: 問題が無い/解けない時は '?')
 *   "A"        → 「答えは、A」
 *   "A, C"     → 「答えは2つ。AとC」(選択数を先に言って聞き取りやすくする)
 *   "A, C, D"  → 「答えは3つ。A、C、D」
 */
export function answerToSpeech(text: string): string {
  const t = text.trim();
  if (t === "") return "応答がありませんでした。もう一度お試しください。";
  if (t === "?") {
    return "解答できませんでした。問題が画面に写っているか確認して、もう一度撮影してください。";
  }
  // ASCII/日本語どちらの区切りでも分割。複数選択は数を先に言う。
  const symbols = t.split(/\s*[,、]\s*/).filter((s) => s.length > 0);
  if (symbols.length <= 1) return `答えは、${t}`;
  // 2 つは「AとC」、3 つ以上は「A、C、D」で読む。
  const joined = symbols.length === 2 ? symbols.join("と") : symbols.join("、");
  return `答えは${symbols.length}つ。${joined}`;
}

/** モデル id を tier に正規化。 */
export function modelTier(model: string): "haiku" | "sonnet" | "opus" | "unknown" {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  return "unknown";
}

const TIER_RANK: Readonly<Record<string, number>> = { haiku: 1, sonnet: 2, opus: 3 };
const TIER_SPOKEN: Readonly<Record<string, string>> = {
  haiku: "ハイク",
  sonnet: "ソネット",
  opus: "オーパス",
};

/**
 * 要求モデルより低位のモデルで回答された (= rate-limit fallback) ときの注記。
 * 例: opus を要求したのに haiku で回答 → 「ハイクで回答」(精度が落ちた合図)。無ければ null。
 */
export function fallbackNote(requestedMode: string, resolvedModel: string): string | null {
  const reqRank = TIER_RANK[requestedMode];
  const resTier = modelTier(resolvedModel);
  const resRank = TIER_RANK[resTier];
  if (reqRank === undefined || resRank === undefined) return null;
  if (resRank < reqRank) return `${TIER_SPOKEN[resTier]}で回答`;
  return null;
}

/**
 * 解答 + (任意で) fallback 注記をまとめた読み上げ文。
 * announceFallback=true かつ実際に格下げされた場合のみ注記を付す。
 */
export function composeAnswerSpeech(
  text: string,
  requestedMode: string,
  resolvedModel: string,
  announceFallback: boolean,
): string {
  const base = answerToSpeech(text);
  if (!announceFallback) return base;
  const t = text.trim();
  if (t === "" || t === "?") return base; // 解答が無いときは注記しない
  const note = fallbackNote(requestedMode, resolvedModel);
  return note ? `${base}。${note}` : base;
}

/** BackendError を読み上げ文へ (設計書 §5.1 のエラーマトリクスに対応)。 */
export function backendErrorToSpeech(err: BackendError): string {
  switch (err.kind) {
    case "dns":
      return "バックエンドが見つかりません。接続先の設定を確認してください。";
    case "network_unreachable":
      return "ネットワークに到達できません。接続を確認してください。";
    case "connect_fail":
      return "バックエンドに接続できませんでした。";
    case "connect_timeout":
      return "接続がタイムアウトしました。";
    case "read_timeout":
      return "応答がタイムアウトしました。";
    case "http":
      return httpErrorToSpeech(err.httpCode);
    case "parse":
      return "応答の解析に失敗しました。";
    default:
      return GENERIC_ERROR_SPEECH;
  }
}

function httpErrorToSpeech(code: number | undefined): string {
  switch (code) {
    case 413:
      return "画像サイズが大きすぎます。";
    case 429:
      return "ただいま混み合っています。少し待ってからお試しください。";
    case 415:
      return "画像形式に対応していません。";
    case 503:
      return "選択中のモードがバックエンドで有効になっていません。";
    default:
      if (code !== undefined && code >= 500) return "バックエンドでエラーが発生しました。";
      if (code !== undefined && code >= 400) return "リクエストエラーが発生しました。";
      return "不明なエラーが発生しました。";
  }
}

/** モデル id を短く読み上げ用に (例 "claude-haiku-4-5-20251001" → "haiku 4.5")。任意の suffix 用。 */
export function shortModelName(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-/g, " ");
}

/** GET /usage/session の総額を読み上げ文へ。 */
export function costToSpeech(totalUsd: number): string {
  const rounded = Math.round(totalUsd * 1000) / 1000;
  return `今セッションのAPIコストは、およそ ${rounded} ドルです。`;
}

/** 試験選択を確定したときの読み上げ。 */
export function examSelectedSpeech(display: string): string {
  // 表示名 "SAA · Solutions Architect Assoc." の記号部は読みづらいので中黒以降を落とす
  const head = display.split("·")[0]?.trim() ?? display;
  return `${head} を選びました。問題に向けてボタンを押してください。`;
}
