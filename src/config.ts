/**
 * 環境変数から実行設定を読む。@mentra/sdk には依存しない。
 *
 * API キー名の揺れに対応:
 *   公式 example の .env は MENTRAOS_API_KEY、docs quickstart は process.env.API_KEY、
 *   ユーザーの検証済みコードは MENTRA_API_KEY を使っていた。3 つとも受け付ける。
 *   ⚠️ 実機/クローンしたテンプレートの src/index.ts でどの名前が apiKey に渡るか要確認。
 */

import type { AuthMode, InferenceMode } from "./vision/visionBackend.js";

export interface AppConfig {
  readonly packageName: string;
  readonly apiKey: string;
  readonly port: number;
  readonly visionBackendUrl: string;
  readonly defaultMode: InferenceMode;
  readonly defaultAuthMode: AuthMode;
  readonly defaultExamCode: string;
  readonly autoLoopDelayMs: number;
  /** TTS の voice_id (任意。日本語に最適化した ElevenLabs voice を使いたい場合)。 */
  readonly ttsVoiceId?: string;
  /** TTS の文字起こし言語 (例 "ja-JP")。onTranscriptionForLanguage に渡す。 */
  readonly transcribeLanguage: string;
}

type Env = Record<string, string | undefined>;

function pick(env: Env, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return undefined;
}

function parseMode(v: string | undefined): InferenceMode {
  return v === "haiku" || v === "sonnet" || v === "opus" ? v : "opus";
}

function parseAuth(v: string | undefined): AuthMode {
  return v === "max_sub" ? "max_sub" : "api_key";
}

export function loadConfig(env: Env = process.env): AppConfig {
  const packageName = pick(env, "PACKAGE_NAME");
  const apiKey = pick(env, "MENTRAOS_API_KEY", "MENTRA_API_KEY", "API_KEY");
  const missing: string[] = [];
  if (!packageName) missing.push("PACKAGE_NAME");
  if (!apiKey) missing.push("MENTRAOS_API_KEY (or MENTRA_API_KEY)");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env: ${missing.join(", ")}. Copy .env.example to .env and fill it in ` +
        `(values come from console.mentraglass.com).`,
    );
  }

  const autoLoopRaw = pick(env, "AUTO_LOOP_DELAY_MS");
  const autoLoop = autoLoopRaw ? Number.parseInt(autoLoopRaw, 10) : 0;

  return {
    packageName: packageName!,
    apiKey: apiKey!,
    port: Number.parseInt(pick(env, "PORT") ?? "3000", 10),
    visionBackendUrl: pick(env, "VISION_BACKEND_URL") ?? "http://localhost:8080",
    defaultMode: parseMode(pick(env, "DEFAULT_INFERENCE_MODE")),
    defaultAuthMode: parseAuth(pick(env, "DEFAULT_AUTH_MODE")),
    defaultExamCode: pick(env, "DEFAULT_EXAM_CODE") ?? "SAA",
    autoLoopDelayMs: Number.isFinite(autoLoop) && autoLoop > 0 ? autoLoop : 0,
    ttsVoiceId: pick(env, "TTS_VOICE_ID"),
    transcribeLanguage: pick(env, "TRANSCRIBE_LANGUAGE") ?? "ja-JP",
  };
}
