/**
 * DirectAnthropicVisionBackend — VisionBackend を Anthropic Vision 直叩きで実装する代替アダプタ。
 *
 * rokid-glass-day1 の `backend/inference.py` (AnthropicClient) + `main.py` の dedup / usage tally /
 * rate-limit fallback を TypeScript に移植したもの。FastAPI を立てずに MentraOS アプリ単一プロセスで
 * 完結させたいとき用 (VISION_BACKEND=direct)。HttpVisionBackend と差し替え可能。
 *
 * - 画像は base64 image ブロック + 任意の user_text ブロック (inference.py と同形)
 * - MCP connector (AWS Knowledge) は opus 経路に attach 可 (betas: mcp-client-2025-11-20)
 * - opus/sonnet が 429 なら haiku に fallback (同 auth)
 * - request_id 単位の 60s dedup + in-flight 合流 (二重課金防止、main.py 相当)
 *
 * 注: max_sub (OAuth 流用) はこの直叩きアダプタでは未対応 (API key のみ)。max_sub が要るなら
 *     FastAPI backend (HttpVisionBackend) を使うこと。
 *
 * @anthropic-ai/sdk 2.x… 実際は 0.107.0 で型検証。モデル id / 価格は env で上書き可。
 */

import Anthropic, { APIUserAbortError, RateLimitError } from "@anthropic-ai/sdk";
import { modelTier } from "../core/speech.js";
import type { Logger } from "../io/ports.js";
import {
  BackendError,
  type InferenceMode,
  type UsageSession,
  type VisionBackend,
  type VisionRequest,
  type VisionResult,
} from "./visionBackend.js";

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const SUPPORTED_MEDIA: ReadonlySet<string> = new Set<MediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** MCP connector beta header (inference.py verbatim)。 */
const MCP_CONNECTOR_BETA = "mcp-client-2025-11-20";

/** tier ごとの公開料金 ($ / 1M tokens, input/output)。概算。実請求は Anthropic Console 参照。 */
const PRICING_PER_MTOKEN: Readonly<Record<string, readonly [number, number]>> = {
  opus: [5, 25],
  sonnet: [3, 15],
  haiku: [1, 5],
};

/** 推論時に「ツール由来」とみなすブロック種別 (この後ろの text だけを最終回答として抽出)。 */
const TOOL_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "mcp_tool_use",
  "mcp_tool_result",
  "server_tool_use",
  "tool_use",
  "web_search_tool_result",
]);

export interface DirectAnthropicVisionBackendOptions {
  readonly apiKey: string;
  /** mode → model id。default: opus=claude-opus-4-8, sonnet=claude-sonnet-4-6, haiku=claude-haiku-4-5。 */
  readonly models?: Partial<Record<InferenceMode, string>>;
  /** 解答は記号のみなので少なめで十分。default 200。MCP 経路では内部で 2048 に引き上げる。 */
  readonly maxTokens?: number;
  /** AWS Knowledge MCP を opus 経路に attach するか。 */
  readonly enableAwsKnowledgeMcp?: boolean;
  /** MCP サーバ URL。 */
  readonly awsKnowledgeMcpUrl?: string;
  /** dedup TTL (ms)。default 60000。 */
  readonly dedupTtlMs?: number;
  readonly logger?: Logger;
}

interface UsageSlot {
  input: number;
  output: number;
  calls: number;
}

function isAbortError(e: unknown): boolean {
  // 呼び出し側 signal で abort されると @anthropic-ai/sdk は APIUserAbortError を投げる
  // (name は "AbortError" ではない & APIError サブクラス)。これを拾い損ねると
  // toBackendError 経由で HTTP 502 として読み上げてしまうので明示的に判定する。
  if (e instanceof APIUserAbortError) return true;
  return e instanceof Error && e.name === "AbortError";
}

/** content (loose 形) から最後のツールブロック以降の text のみ連結。inference.py の抽出ロジック。 */
function extractAnswer(content: ReadonlyArray<{ type: string; text?: string }>): string {
  let lastToolIdx = -1;
  content.forEach((b, i) => {
    if (TOOL_BLOCK_TYPES.has(b.type)) lastToolIdx = i;
  });
  const texts: string[] = [];
  content.forEach((b, i) => {
    if (i > lastToolIdx && b.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
    }
  });
  return texts.join("");
}

export class DirectAnthropicVisionBackend implements VisionBackend {
  private readonly client: Anthropic;
  private readonly models: Record<InferenceMode, string>;
  private readonly maxTokens: number;
  private readonly mcpEnabled: boolean;
  private readonly mcpUrl: string;
  private readonly dedupTtlMs: number;
  private readonly log: Logger;

  /** request_id → 完了結果 (TTL 付き)。 */
  private readonly completed = new Map<string, { result: VisionResult; expiresAt: number }>();
  /** request_id → 進行中 Promise (合流用)。 */
  private readonly inflight = new Map<string, Promise<VisionResult>>();
  /** model id → usage tally。 */
  private readonly usage = new Map<string, UsageSlot>();

  constructor(opts: DirectAnthropicVisionBackendOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.models = {
      opus: opts.models?.opus ?? "claude-opus-4-8",
      sonnet: opts.models?.sonnet ?? "claude-sonnet-4-6",
      haiku: opts.models?.haiku ?? "claude-haiku-4-5",
    };
    this.maxTokens = opts.maxTokens ?? 200;
    this.mcpEnabled = opts.enableAwsKnowledgeMcp ?? false;
    this.mcpUrl = opts.awsKnowledgeMcpUrl ?? "https://knowledge-mcp.global.api.aws";
    this.dedupTtlMs = opts.dedupTtlMs ?? 60_000;
    this.log = opts.logger ?? console;
  }

  async infer(req: VisionRequest, signal?: AbortSignal): Promise<VisionResult> {
    this.purgeExpired();
    const cached = this.completed.get(req.requestId);
    if (cached) {
      this.log.info?.(`dedup hit (cache) request_id=${req.requestId}`);
      return cached.result;
    }
    const existing = this.inflight.get(req.requestId);
    if (existing) {
      this.log.info?.(`dedup hit (inflight) request_id=${req.requestId}`);
      return existing;
    }
    if (req.authMode === "max_sub") {
      this.log.warn?.("DirectAnthropicVisionBackend ignores auth_mode=max_sub (API key only)");
    }
    const promise = this.doInfer(req, signal);
    this.inflight.set(req.requestId, promise);
    try {
      const result = await promise;
      this.completed.set(req.requestId, { result, expiresAt: Date.now() + this.dedupTtlMs });
      return result;
    } finally {
      this.inflight.delete(req.requestId);
    }
  }

  private async doInfer(req: VisionRequest, signal?: AbortSignal): Promise<VisionResult> {
    const mediaType = (req.mimeType ?? "image/jpeg").toLowerCase();
    if (!SUPPORTED_MEDIA.has(mediaType)) {
      throw new BackendError("http", `unsupported media_type ${mediaType}`, 415);
    }
    const data = Buffer.from(req.imageJpeg).toString("base64");
    const content: Anthropic.ContentBlockParam[] = [
      { type: "image", source: { type: "base64", media_type: mediaType as MediaType, data } },
    ];
    if (req.userText) content.push({ type: "text", text: req.userText });

    const started = Date.now();
    try {
      return await this.callModel(req, content, req.mode, mediaType, started, signal);
    } catch (e) {
      if (isAbortError(e)) {
        const err = new Error("aborted by caller");
        err.name = "AbortError";
        throw err;
      }
      // opus/sonnet が rate limit なら haiku へ fallback (同 prompt / 画像)。
      if (e instanceof RateLimitError && (req.mode === "opus" || req.mode === "sonnet")) {
        this.log.warn?.(`rate_limit on ${req.mode} request_id=${req.requestId} — falling back to haiku`);
        try {
          return await this.callModel(req, content, "haiku", mediaType, started, signal);
        } catch (e2) {
          if (isAbortError(e2)) {
            const err = new Error("aborted by caller");
            err.name = "AbortError";
            throw err;
          }
          if (e2 instanceof RateLimitError) {
            throw new BackendError("http", "rate_limit (haiku fallback too)", 429);
          }
          throw this.toBackendError(e2);
        }
      }
      throw this.toBackendError(e);
    }
  }

  private async callModel(
    req: VisionRequest,
    content: Anthropic.ContentBlockParam[],
    mode: InferenceMode,
    _mediaType: string,
    started: number,
    signal?: AbortSignal,
  ): Promise<VisionResult> {
    const model = this.models[mode];
    const useMcp = this.mcpEnabled && mode === "opus";

    let responseContent: ReadonlyArray<{ type: string; text?: string }>;
    let usageIn = 0;
    let usageOut = 0;

    if (useMcp) {
      // MCP round-trip の出力余裕を確保 (inference.py: max_tokens<2048 なら 2048 に)。
      const maxTokens = Math.max(this.maxTokens, 2048);
      const res = await this.client.beta.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: req.prompt,
          messages: [{ role: "user", content: content as Anthropic.Beta.BetaContentBlockParam[] }],
          betas: [MCP_CONNECTOR_BETA as Anthropic.Beta.AnthropicBeta],
          mcp_servers: [{ type: "url", url: this.mcpUrl, name: "aws-knowledge" }],
          tools: [{ type: "mcp_toolset", mcp_server_name: "aws-knowledge" }],
        },
        { signal },
      );
      responseContent = res.content as ReadonlyArray<{ type: string; text?: string }>;
      usageIn = res.usage.input_tokens ?? 0;
      usageOut = res.usage.output_tokens ?? 0;
    } else {
      const res = await this.client.messages.create(
        {
          model,
          max_tokens: this.maxTokens,
          system: req.prompt,
          messages: [{ role: "user", content }],
        },
        { signal },
      );
      responseContent = res.content as ReadonlyArray<{ type: string; text?: string }>;
      usageIn = res.usage.input_tokens ?? 0;
      usageOut = res.usage.output_tokens ?? 0;
    }

    this.tally(model, usageIn, usageOut);
    return {
      requestId: req.requestId,
      text: extractAnswer(responseContent),
      elapsedMs: Date.now() - started,
      model,
    };
  }

  private toBackendError(e: unknown): BackendError {
    if (e instanceof BackendError) return e;
    if (e instanceof Anthropic.APIError) {
      const status = typeof e.status === "number" ? e.status : 502;
      return new BackendError("http", e.message, status);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return new BackendError("connect_fail", msg);
  }

  private tally(model: string, input: number, output: number): void {
    const slot = this.usage.get(model) ?? { input: 0, output: 0, calls: 0 };
    slot.input += input;
    slot.output += output;
    slot.calls += 1;
    this.usage.set(model, slot);
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.completed) {
      if (v.expiresAt <= now) this.completed.delete(k);
    }
  }

  async getUsageSession(): Promise<UsageSession> {
    const breakdown: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const [model, slot] of this.usage) {
      const [inPer, outPer] = PRICING_PER_MTOKEN[modelTier(model)] ?? [0, 0];
      const cost = (slot.input * inPer) / 1_000_000 + (slot.output * outPer) / 1_000_000;
      total += cost;
      breakdown[model] = {
        input_tokens: slot.input,
        output_tokens: slot.output,
        calls: slot.calls,
        cost_usd: Math.round(cost * 10_000) / 10_000,
      };
    }
    return {
      total_usd: Math.round(total * 10_000) / 10_000,
      breakdown,
      note: "session-only (in-process). Real billing: Anthropic Console.",
    };
  }

  health(): Promise<boolean> {
    // 直叩きアダプタはローカル。実際の到達性は最初の infer で判明する。
    return Promise.resolve(true);
  }
}
