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
 *   "A"      → 「答えは、A」
 *   "A, C"   → 「答えは、A、C」(カンマを読点にして自然な間を作る)
 */
export function answerToSpeech(text: string): string {
  const t = text.trim();
  if (t === "") return "応答がありませんでした。もう一度お試しください。";
  if (t === "?") {
    return "解答できませんでした。問題が画面に写っているか確認して、もう一度撮影してください。";
  }
  // "A, C" → "A、C": ASCII カンマを日本語読点へ寄せて TTS の間合いを整える
  const spoken = t.replace(/\s*,\s*/g, "、");
  return `答えは、${spoken}`;
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
