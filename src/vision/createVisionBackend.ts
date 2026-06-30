/**
 * createVisionBackend — VISION_BACKEND の選択に応じて VisionBackend 実装を組み立てる。
 *   http   : 既存 FastAPI /vision/session を叩く (default, 移植の本流)
 *   direct : Anthropic Vision を直叩き (FastAPI 不要の単一プロセス構成)
 */

import type { Logger } from "../io/ports.js";
import { DirectAnthropicVisionBackend } from "./directAnthropicVisionBackend.js";
import { HttpVisionBackend } from "./httpVisionBackend.js";
import type { InferenceMode, VisionBackend } from "./visionBackend.js";

export interface VisionBackendConfig {
  readonly kind: "http" | "direct";
  /** http: backend base URL。 */
  readonly visionBackendUrl: string;
  /** direct: Anthropic API key。 */
  readonly anthropicApiKey?: string;
  readonly models?: Partial<Record<InferenceMode, string>>;
  readonly maxTokens?: number;
  readonly enableAwsKnowledgeMcp?: boolean;
  readonly awsKnowledgeMcpUrl?: string;
  readonly logger?: Logger;
}

export function createVisionBackend(cfg: VisionBackendConfig): VisionBackend {
  if (cfg.kind === "direct") {
    if (!cfg.anthropicApiKey) {
      throw new Error(
        "VISION_BACKEND=direct requires ANTHROPIC_API_KEY in .env (or switch to VISION_BACKEND=http).",
      );
    }
    return new DirectAnthropicVisionBackend({
      apiKey: cfg.anthropicApiKey,
      models: cfg.models,
      maxTokens: cfg.maxTokens,
      enableAwsKnowledgeMcp: cfg.enableAwsKnowledgeMcp,
      awsKnowledgeMcpUrl: cfg.awsKnowledgeMcpUrl,
      logger: cfg.logger,
    });
  }
  return new HttpVisionBackend({ baseUrl: cfg.visionBackendUrl });
}
