/**
 * MentraVoiceIO — VoiceIO ポートの @mentra/sdk 実装。
 *
 * 出力: session.audio.speak(text, { stopOtherAudio, volume, voice_id })  (TTS, ElevenLabs)
 * 入力: session.events.onTranscription / onTranscriptionForLanguage (文字起こし)
 *
 * @mentra/sdk 2.1.29 で検証。v3 では session.speaker / session.transcription に移動する点に注意。
 */

import type { AppSession, TranscriptionData } from "@mentra/sdk";
import type { Logger, SpeakOptions, Utterance, VoiceIO } from "../io/ports.js";

export interface MentraVoiceIOOptions {
  /** TTS の voice_id (任意)。日本語に最適な ElevenLabs voice を使いたい場合に指定。 */
  readonly voiceId?: string;
  /** 文字起こし言語 (例 "ja-JP")。"en-US" 以外なら onTranscriptionForLanguage を使う。 */
  readonly transcribeLanguage?: string;
  readonly logger?: Logger;
}

/** TTS の track id (2 = tts)。stopAudio(2) で TTS だけ止められる。 */
const TTS_TRACK_ID = 2;

export class MentraVoiceIO implements VoiceIO {
  constructor(
    private readonly session: AppSession,
    private readonly opts: MentraVoiceIOOptions = {},
  ) {}

  async speak(text: string, o?: SpeakOptions): Promise<void> {
    const t = text.trim();
    if (!t) return; // speak('') は SDK が throw するので呼ばない
    const speakOpts: Parameters<AppSession["audio"]["speak"]>[1] = {
      // interrupt=true → stopOtherAudio=true (default)。この時 promise は再生完了で resolve。
      stopOtherAudio: o?.interrupt ?? true,
      trackId: TTS_TRACK_ID,
    };
    if (o?.volume !== undefined) speakOpts.volume = o.volume;
    if (this.opts.voiceId) speakOpts.voice_id = this.opts.voiceId;

    const res = await this.session.audio.speak(t, speakOpts);
    if (!res.success) {
      throw new Error(res.error ?? "speak failed");
    }
  }

  stop(): void {
    try {
      this.session.audio.stopAudio(TTS_TRACK_ID);
    } catch (e) {
      this.opts.logger?.warn?.("stopAudio failed", e);
    }
  }

  onUtterance(handler: (u: Utterance) => void): () => void {
    const cb = (data: TranscriptionData) => {
      handler({
        text: data.text,
        isFinal: data.isFinal,
        language: data.transcribeLanguage ?? data.detectedLanguage,
      });
    };
    const lang = this.opts.transcribeLanguage;
    if (lang && lang.toLowerCase() !== "en-us") {
      // ja-JP など。⚠️ onTranscriptionForLanguage が mic を自動 enable するかは
      // docs.mentraglass.com で要確認 (research フラグ)。subscribe は handler 0→1 で発火する。
      return this.session.events.onTranscriptionForLanguage(lang, cb);
    }
    return this.session.events.onTranscription(cb);
  }
}
