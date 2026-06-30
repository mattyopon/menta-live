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
import { HttpVisionBackend } from "./vision/httpVisionBackend.js";

const cfg = loadConfig();
const backend = new HttpVisionBackend({ baseUrl: cfg.visionBackendUrl });

class AwsQuizServer extends AppServer {
  /** sessionId → controller。onStop で確実に dispose するため保持する。 */
  private readonly controllers = new Map<string, QuizController>();

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
      },
      logger: session.logger,
    });

    const controller = new QuizController({ session: quiz, voice, trigger, backend, logger: session.logger });
    controller.start();
    this.controllers.set(sessionId, controller);

    // backend 疎通を軽く確認してから挨拶 (落ちていれば warn だけ出す)
    const healthy = await backend.health().catch(() => false);
    if (!healthy) {
      session.logger.warn(`vision backend not reachable at ${cfg.visionBackendUrl}`);
    }

    await controller.welcome();
  }

  protected override async onStop(sessionId: string, _userId: string, reason: string): Promise<void> {
    this.logger.info(`session stop ${sessionId}: ${reason}`);
    const controller = this.controllers.get(sessionId);
    if (controller) {
      controller.dispose();
      this.controllers.delete(sessionId);
    }
  }
}

const server = new AwsQuizServer({
  packageName: cfg.packageName,
  apiKey: cfg.apiKey,
  port: cfg.port,
});

server.start().then(
  () => console.log(`AWS Quiz Glass listening on :${cfg.port} (backend=${cfg.visionBackendUrl})`),
  (err) => {
    console.error("failed to start", err);
    process.exit(1);
  },
);
