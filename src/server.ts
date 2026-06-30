/**
 * AWS Quiz Glass — Mentra Live (表示なし) 版エントリポイント。
 *
 * rokid-glass-day1 の「カメラで試験画面を撮影 → Anthropic Vision → 解答記号を HUD 表示」を、
 * 「撮影 → 同じ FastAPI バックエンド → 解答記号を TTS 読み上げ」に移植したもの。
 *
 * 構成 (依存方向):
 *   AppServer.onSession
 *     ├─ MentraVoiceIO / MentraCamera / MentraTrigger  (SDK アダプタ)
 *     ├─ QuizSession                                    (状態機械 = AppViewModel 移植)
 *     ├─ QuizController                                 (音声/ボタン → QuizSession)
 *     └─ HttpVisionBackend → 既存 FastAPI /vision/session (頭脳は再利用)
 */

import { AppServer, type AppSession } from "@mentra/sdk";
import { loadConfig } from "./config.js";
import { QuizController } from "./core/quizController.js";
import { QuizSession } from "./core/quizSession.js";
import { MentraCamera } from "./mentra/mentraCamera.js";
import { MentraTrigger } from "./mentra/mentraTrigger.js";
import { MentraVoiceIO } from "./mentra/mentraVoiceIO.js";
import { createVisionBackend } from "./vision/createVisionBackend.js";

const cfg = loadConfig();
const backend = createVisionBackend({
  kind: cfg.visionBackendKind,
  visionBackendUrl: cfg.visionBackendUrl,
  anthropicApiKey: cfg.anthropicApiKey,
  models: cfg.anthropicModels,
  maxTokens: cfg.visionMaxTokens,
  enableAwsKnowledgeMcp: cfg.enableAwsKnowledgeMcp,
  awsKnowledgeMcpUrl: cfg.awsKnowledgeMcpUrl,
});

/** session.capabilities を「診断」用の読み上げ文へ。 */
function capabilitiesSummary(session: AppSession): string {
  const c = session.capabilities;
  if (!c) return "デバイス情報はまだ取得できていません。少し待って、もう一度診断と言ってください。";
  const yn = (b: boolean) => (b ? "あり" : "なし");
  return (
    `機種は ${c.modelName}。ディスプレイ ${yn(c.hasDisplay)}、カメラ ${yn(c.hasCamera)}、` +
    `マイク ${yn(c.hasMicrophone)}、スピーカー ${yn(c.hasSpeaker)}、ボタン ${yn(c.hasButton)}。`
  );
}

/** 外部トリガで許可するアクション。 */
const EXTERNAL_ACTIONS = ["capture", "toggleMode", "repeat", "cost", "diagnostics"] as const;
type ExternalAction = (typeof EXTERNAL_ACTIONS)[number];

class AwsQuizServer extends AppServer {
  /** sessionId → controller。onStop で確実に dispose するため保持する。 */
  private readonly controllers = new Map<string, QuizController>();
  /** userId → controller。外部 HTTP トリガ (Rokid Ring 等) の宛先解決用。 */
  private readonly byUser = new Map<string, QuizController>();

  /**
   * 外部入力 (Ring → スマホ自動化 → POST /ext/trigger) からコマンドを発火。
   * 該当ユーザーのアクティブセッションが無ければ "no-session"。
   */
  triggerExternal(userId: string, action: ExternalAction): "ok" | "no-session" {
    const controller = this.byUser.get(userId);
    if (!controller) return "no-session";
    void controller.external(action);
    return "ok";
  }

  protected override async onSession(
    session: AppSession,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    session.logger.info({ sessionId, userId }, "AWS quiz session start");

    // 表示なし機ガード: hasDisplay は CONNECTION_ACK まで null。
    // 本アプリは layout を一切呼ばないので実害は無いが、確認ログを残す。
    if (session.capabilities && !session.capabilities.hasDisplay) {
      session.logger.info("display-less glasses confirmed — audio-only mode");
    }

    const voice = new MentraVoiceIO(session, {
      voiceId: cfg.ttsVoiceId,
      transcribeLanguage: cfg.transcribeLanguage,
      logger: session.logger,
    });
    const camera = new MentraCamera(session, { logger: session.logger });
    const trigger = new MentraTrigger(session);

    const quiz = new QuizSession({
      camera,
      voice,
      backend,
      config: {
        examCode: cfg.defaultExamCode,
        mode: cfg.defaultMode,
        authMode: cfg.defaultAuthMode,
        autoLoopDelayMs: cfg.autoLoopDelayMs,
        captureCueText: cfg.captureCueText,
        slowCueText: cfg.slowCueText,
        slowCueAfterMs: cfg.slowCueAfterMs,
        announceFallback: cfg.announceFallback,
      },
      logger: session.logger,
    });

    const controller = new QuizController({
      session: quiz,
      voice,
      trigger,
      backend,
      getDiagnostics: () => capabilitiesSummary(session),
      logger: session.logger,
    });
    controller.start();
    this.controllers.set(sessionId, controller);
    this.byUser.set(userId, controller);

    // backend 疎通を軽く確認してから挨拶 (落ちていれば warn だけ出す)
    const healthy = await backend.health().catch(() => false);
    if (!healthy) {
      session.logger.warn(`vision backend not reachable at ${cfg.visionBackendUrl}`);
    }

    await controller.welcome();
  }

  protected override async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    this.logger.info(`session stop ${sessionId}: ${reason}`);
    const controller = this.controllers.get(sessionId);
    if (controller) {
      controller.dispose();
      this.controllers.delete(sessionId);
      // byUser がこのセッションを指していたら外す (新しいセッションが上書き済なら残す)。
      if (this.byUser.get(userId) === controller) this.byUser.delete(userId);
    }
  }
}

/** express の Request/Response の必要部分だけを構造的に型付け (@types/express を足さないため)。 */
interface MinimalReq {
  header(name: string): string | undefined;
  query: Record<string, unknown>;
}
interface MinimalRes {
  status(code: number): MinimalRes;
  json(body: unknown): void;
}

/**
 * Rokid Ring 等の外部入力を受ける HTTP トリガを登録する (RING_TRIGGER_TOKEN 設定時のみ)。
 *   POST /ext/trigger?user=<userId>&action=capture   (header: x-trigger-token: <token>)
 * MentraOS の入力転送に依存せず、スマホ自動化 (Tasker/MacroDroid) から叩いて撮影を発火する。
 */
function registerRingTrigger(server: AwsQuizServer, token: string): void {
  const app = server.getExpressApp();
  app.post("/ext/trigger", (req: MinimalReq, res: MinimalRes) => {
    const provided = req.header("x-trigger-token");
    if (!provided || provided !== token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const user = typeof req.query.user === "string" ? req.query.user : "";
    const action = typeof req.query.action === "string" ? req.query.action : "capture";
    if (!EXTERNAL_ACTIONS.includes(action as ExternalAction)) {
      res.status(400).json({ error: `bad action (allowed: ${EXTERNAL_ACTIONS.join(", ")})` });
      return;
    }
    if (!user) {
      res.status(400).json({ error: "missing user" });
      return;
    }
    const result = server.triggerExternal(user, action as ExternalAction);
    if (result === "no-session") {
      res.status(404).json({ error: "no active session for user" });
      return;
    }
    res.json({ ok: true, action });
  });
}

const server = new AwsQuizServer({
  packageName: cfg.packageName,
  apiKey: cfg.apiKey,
  port: cfg.port,
});

if (cfg.ringTriggerToken) {
  registerRingTrigger(server, cfg.ringTriggerToken);
  console.log("ring HTTP trigger enabled: POST /ext/trigger (token required)");
}

server.start().then(
  () => console.log(`AWS Quiz Glass listening on :${cfg.port} (backend=${cfg.visionBackendUrl})`),
  (err) => {
    console.error("failed to start", err);
    process.exit(1);
  },
);
