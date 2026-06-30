/**
 * HttpVisionBackend — 既存 FastAPI バックエンド (`/vision/session`) を叩く VisionBackend 実装。
 *
 * rokid-glass-day1 の `BackendClient.kt` (OkHttp + multipart + 細分化エラー型) の TypeScript 移植。
 * Node 20+ の global fetch / FormData / Blob / AbortSignal を使うので追加依存ゼロ。
 *
 * タイムアウト方針 (BackendClient.kt の OkHttp 設定に対応):
 *   - connect: 10s, write: 15s, read: 30s
 *   fetch は connect/read を分離できないため、全体タイムアウト = readTimeoutMs (default 30s) を
 *   AbortController で実装し、timeout 由来の abort は read_timeout として扱う (retry 対象)。
 *   呼び出し側 signal による abort は素の AbortError として伝播 (= キャンセル、retry しない)。
 */

import {
  BackendError,
  type UsageSession,
  type VisionBackend,
  type VisionRequest,
  type VisionResult,
} from "./visionBackend.js";

export interface HttpVisionBackendOptions {
  /** 例 "http://localhost:8080" / "http://100.x.y.z:8080" (末尾スラッシュ無し)。 */
  readonly baseUrl: string;
  /** 全体タイムアウト (ms)。default 30000。 */
  readonly readTimeoutMs?: number;
}

/** Node の fetch が投げる system error から errno code を取り出す。 */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** fetch のネットワーク例外を BackendError(kind) に分類する (BackendClient.kt の onFailure 相当)。 */
function mapNetworkError(err: unknown): BackendError {
  const code = errorCode(err);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new BackendError("dns", "DNS resolution failed");
    case "ENETUNREACH":
    case "EHOSTUNREACH":
      return new BackendError("network_unreachable", "network unreachable");
    case "ECONNREFUSED":
      return new BackendError("connect_fail", "connect refused");
    case "UND_ERR_CONNECT_TIMEOUT":
      return new BackendError("connect_timeout", "connect timeout");
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
      return new BackendError("read_timeout", "read timeout");
    case "ECONNRESET":
    case "EPIPE":
      return new BackendError("connect_fail", "connection aborted");
    default: {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unreachable/i.test(msg)) {
        return new BackendError("network_unreachable", msg);
      }
      return new BackendError("connect_fail", msg);
    }
  }
}

/** caller signal + timeout signal を 1 本に合成する (Node 20.3+ の AbortSignal.any)。 */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(signals);
  // 古い Node 向け fallback: 最初に abort したものを伝播
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

export class HttpVisionBackend implements VisionBackend {
  private readonly baseUrl: string;
  private readonly readTimeoutMs: number;

  constructor(opts: HttpVisionBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.readTimeoutMs = opts.readTimeoutMs ?? 30_000;
  }

  async infer(req: VisionRequest, signal?: AbortSignal): Promise<VisionResult> {
    const form = new FormData();
    form.append("request_id", req.requestId);
    form.append("prompt", req.prompt);
    form.append("mode", req.mode);
    form.append("auth_mode", req.authMode);
    if (req.userText) form.append("user_text", req.userText);
    // image フィールドは BackendClient.kt と同じく filename "frame.jpg" / image/jpeg。
    const blob = new Blob([req.imageJpeg], { type: req.mimeType ?? "image/jpeg" });
    form.append("image", blob, "frame.jpg");

    const raw = await this.postForm(`${this.baseUrl}/vision/session`, form, signal);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new BackendError("parse", "bad JSON");
    }
    if (!json || typeof json !== "object") {
      throw new BackendError("parse", "response not an object");
    }
    const obj = json as Record<string, unknown>;
    if (typeof obj.request_id !== "string" || typeof obj.text !== "string") {
      throw new BackendError("parse", "missing request_id/text");
    }
    return {
      requestId: obj.request_id,
      text: obj.text,
      elapsedMs: typeof obj.elapsed_ms === "number" ? obj.elapsed_ms : -1,
      model: typeof obj.model === "string" ? obj.model : "",
    };
  }

  async getUsageSession(): Promise<UsageSession> {
    const res = await this.get(`${this.baseUrl}/usage/session`);
    const json = JSON.parse(res) as UsageSession;
    return json;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.get(`${this.baseUrl}/health`);
      const json = JSON.parse(res) as { status?: string };
      return json.status === "ok";
    } catch {
      return false;
    }
  }

  /** multipart POST 本体。タイムアウト + caller signal を合成し、エラーを分類して投げ直す。 */
  private async postForm(url: string, form: FormData, signal?: AbortSignal): Promise<string> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new BackendError("read_timeout", "read timeout")), this.readTimeoutMs);
    const composed = combineSignals(signal ? [signal, timeout.signal] : [timeout.signal]);
    try {
      const res = await fetch(url, { method: "POST", body: form, signal: composed });
      const body = await res.text();
      if (!res.ok) {
        throw new BackendError("http", `HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
      }
      return body;
    } catch (err) {
      throw this.classify(err, signal, timeout);
    } finally {
      clearTimeout(timer);
    }
  }

  private async get(url: string): Promise<string> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new BackendError("read_timeout", "read timeout")), this.readTimeoutMs);
    try {
      const res = await fetch(url, { signal: timeout.signal });
      const body = await res.text();
      if (!res.ok) {
        throw new BackendError("http", `HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
      }
      return body;
    } catch (err) {
      throw this.classify(err, undefined, timeout);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 例外を分類:
   *   - 既に BackendError ならそのまま
   *   - timeout 由来の abort → その BackendError (read_timeout)
   *   - caller signal 由来の abort → 素の AbortError (キャンセル、retry しない)
   *   - それ以外 → ネットワークエラー分類
   */
  private classify(err: unknown, callerSignal: AbortSignal | undefined, timeout: AbortController): Error {
    if (err instanceof BackendError) return err;
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) {
      if (timeout.signal.aborted) {
        const reason = timeout.signal.reason;
        return reason instanceof BackendError ? reason : new BackendError("read_timeout", "read timeout");
      }
      if (callerSignal?.aborted) {
        // 呼び出し側キャンセル: 素の AbortError を伝播 (QuizSession は静かに離脱)
        const e = new Error("aborted by caller");
        e.name = "AbortError";
        return e;
      }
      return new BackendError("read_timeout", "aborted");
    }
    return mapNetworkError(err);
  }
}
