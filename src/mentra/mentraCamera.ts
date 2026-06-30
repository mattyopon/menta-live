/**
 * MentraCamera — Camera ポートの @mentra/sdk 実装。
 *
 * session.camera.requestPhoto(options?) → PhotoData { buffer: Buffer, mimeType, ... }
 * (旧名 takePhoto は存在しない。@mentra/sdk 2.1.29 で検証)
 *
 * Rokid 版は 1568×1176 (Haiku native cap) で撮っていたが、Mentra Live は 1080p 機。
 * size="large" (1920×1080) を既定にする。試験画面の細かい文字を読むため大きめ。
 * backend 側で Anthropic の上限に合わせて resize されるので過大送信にはならない。
 */

import type { AppSession } from "@mentra/sdk";
import type { Camera, CapturedPhoto, Logger } from "../io/ports.js";

export type PhotoSize = "small" | "medium" | "large" | "full";
export type PhotoCompress = "none" | "medium" | "heavy";

export interface MentraCameraOptions {
  /** small=640×480 / medium=1280×720 / large=1920×1080 / full=native。default "large"。 */
  readonly size?: PhotoSize;
  /** アップロード圧縮。default "none"。 */
  readonly compress?: PhotoCompress;
  readonly logger?: Logger;
}

export class MentraCamera implements Camera {
  constructor(
    private readonly session: AppSession,
    private readonly opts: MentraCameraOptions = {},
  ) {}

  async capturePhoto(): Promise<CapturedPhoto> {
    const photo = await this.session.camera.requestPhoto({
      size: this.opts.size ?? "large",
      compress: this.opts.compress ?? "none",
    });
    this.opts.logger?.info?.(
      `photo captured: ${photo.size} bytes, ${photo.mimeType}, ${photo.filename}`,
    );
    // PhotoData.buffer は Node Buffer (= Uint8Array サブクラス)。そのまま渡してゼロコピー。
    return {
      bytes: photo.buffer,
      mimeType: photo.mimeType || "image/jpeg",
    };
  }
}
