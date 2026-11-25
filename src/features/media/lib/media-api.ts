import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { isLinux } from "@/lib/platform";
import { flushAppStateSave } from "@/features/app/stores/app-store";

export interface LocalMedia {
  url: string;
  close: () => Promise<void>;
}

/** A selected file is granted exactly; Linux audio/video uses seekable HTTP. */
export async function openLocalMedia(path: string, kind: string): Promise<LocalMedia> {
  if (isTauri()) await flushAppStateSave();
  if (isTauri() && isLinux && (kind === "video" || kind === "audio")) {
    const stream = await invoke<{ url: string; token: string }>("media_open", { path });
    return { url: stream.url, close: () => invoke("media_close", { token: stream.token }) };
  }
  await invoke("asset_allow_file", { path });
  return { url: convertFileSrc(path), close: () => Promise.resolve() };
}
