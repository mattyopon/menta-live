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
  /** http = 既存 FastAPI を叩く / direct = Anthropic 直叩き。 */
  readonly visionBackendKind: "http" | "direct";
  readonly visionBackendUrl: string;
  /** direct 用。 */
  readonly anthropicApiKey?: string;
  readonly anthropicModels: Partial<Record<InferenceMode, string>>;
  readonly visionMaxTokens: number;
  readonly enableAwsKnowledgeMcp: boolean;
  readonly awsKnowledgeMcpUrl: string;
  readonly defaultMode: InferenceMode;
  readonly defaultAuthMode: AuthMode;
  readonly defaultExamCode: string;
  readonly autoLoopDelayMs: number;
  /** rate-limit 格下げ時に「ハイクで回答」等を読み上げるか。 */
  readonly announceFallback: boolean;
  /** 撮影直後の即時キュー ("" で無効)。表示なし機の押下フィードバック。 */
  readonly captureCueText: string;
  /** 推論遅延時の安心キュー ("" で無効)。 */
  readonly slowCueText: string;
  /** slowCue を出すまでの待ち (ms, 0 で無効)。 */
  readonly slowCueAfterMs: number;
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

  // キューは "off"/"none" で無効化可能 (空文字でも無効)。
  const cueOff = (v: string | undefined): boolean => v === "off" || v === "none";
  const captureCueRaw = env.CAPTURE_CUE_TEXT;
  const slowCueRaw = env.SLOW_CUE_TEXT;
  const slowAfter = Number.parseInt(pick(env, "SLOW_CUE_AFTER_MS") ?? "3500", 10);

  const visionKind = pick(env, "VISION_BACKEND") === "direct" ? "direct" : "http";
  const anthropicModels: Partial<Record<InferenceMode, string>> = {};
  const opusModel = pick(env, "ANTHROPIC_OPUS_MODEL");
  const sonnetModel = pick(env, "ANTHROPIC_SONNET_MODEL");
  const haikuModel = pick(env, "ANTHROPIC_HAIKU_MODEL");
  if (opusModel) anthropicModels.opus = opusModel;
  if (sonnetModel) anthropicModels.sonnet = sonnetModel;
  if (haikuModel) anthropicModels.haiku = haikuModel;
  const visionMaxTokens = Number.parseInt(pick(env, "VISION_MAX_TOKENS") ?? "200", 10);

  return {
    packageName: packageName!,
    apiKey: apiKey!,
    port: Number.parseInt(pick(env, "PORT") ?? "3000", 10),
    visionBackendKind: visionKind,
    visionBackendUrl: pick(env, "VISION_BACKEND_URL") ?? "http://localhost:8080",
    anthropicApiKey: pick(env, "ANTHROPIC_API_KEY"),
    anthropicModels,
    visionMaxTokens: Number.isFinite(visionMaxTokens) && visionMaxTokens > 0 ? visionMaxTokens : 200,
    enableAwsKnowledgeMcp: pick(env, "ENABLE_AWS_KNOWLEDGE_MCP") === "1",
    awsKnowledgeMcpUrl: pick(env, "AWS_KNOWLEDGE_MCP_URL") ?? "https://knowledge-mcp.global.api.aws",
    defaultMode: parseMode(pick(env, "DEFAULT_INFERENCE_MODE")),
    defaultAuthMode: parseAuth(pick(env, "DEFAULT_AUTH_MODE")),
    defaultExamCode: pick(env, "DEFAULT_EXAM_CODE") ?? "SAA",
    autoLoopDelayMs: Number.isFinite(autoLoop) && autoLoop > 0 ? autoLoop : 0,
    announceFallback: pick(env, "ANNOUNCE_FALLBACK") !== "0",
    captureCueText: cueOff(captureCueRaw) ? "" : (pick(env, "CAPTURE_CUE_TEXT") ?? "はい"),
    slowCueText: cueOff(slowCueRaw) ? "" : (pick(env, "SLOW_CUE_TEXT") ?? "確認中です"),
    slowCueAfterMs: Number.isFinite(slowAfter) && slowAfter > 0 ? slowAfter : 0,
    ttsVoiceId: pick(env, "TTS_VOICE_ID"),
    transcribeLanguage: pick(env, "TRANSCRIBE_LANGUAGE") ?? "ja-JP",
  };
}
