/**
 * Hello World — 「音声入力 → 文字起こし → 音声で返答」の最小アプリ。
 *
 * 表示なし機 (Mentra Live) で音声 I/O だけが成立することを確かめる疎通用。
 * 話しかけると、確定した発話をそのまま TTS でオウム返しする。
 *
 * 実行: `npm run hello` (tsx)。事前に .env (PACKAGE_NAME / MENTRAOS_API_KEY / PORT) と
 * console.mentraglass.com 側の Public URL + MICROPHONE 権限が必要。
 */

import { AppServer, type AppSession } from "@mentra/sdk";
import { loadConfig } from "../config.js";

const cfg = loadConfig();

class HelloServer extends AppServer {
  protected override async onSession(
    session: AppSession,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    session.logger.info({ sessionId, userId }, "hello session start");

    // 出力 (TTS) — session.audio.speak は stopOtherAudio:true (default) で再生完了まで待つ。
    await session.audio.speak("こんにちは。話しかけてください。聞こえた言葉をそのまま返します。");

    // 入力 (文字起こし) — 確定発話だけ拾ってオウム返し。
    // ⚠️ console 側で MICROPHONE 権限を宣言していないと transcription は流れてこない。
    const lang = cfg.transcribeLanguage;
    const onText = (text: string, isFinal: boolean) => {
      if (!isFinal) return;
      const t = text.trim();
      if (!t) return;
      session.logger.info(`heard: ${t}`);
      // 返答は割り込み再生。完了は待たずに次の発話を受けられるようにする。
      void session.audio.speak(`あなたはこう言いました。${t}`, { stopOtherAudio: true }).catch((e) => {
        session.logger.warn("speak failed", e);
      });
    };

    if (lang && lang.toLowerCase() !== "en-us") {
      session.events.onTranscriptionForLanguage(lang, (d) => onText(d.text, d.isFinal));
    } else {
      session.events.onTranscription((d) => onText(d.text, d.isFinal));
    }
  }
}

new HelloServer({
  packageName: cfg.packageName,
  apiKey: cfg.apiKey,
  port: cfg.port,
})
  .start()
  .then(
    () => console.log(`Hello World listening on :${cfg.port}`),
    (err) => {
      console.error("failed to start", err);
      process.exit(1);
    },
  );
