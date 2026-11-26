/** Waveform decoration is bounded independently of media playback. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SECONDS = 120;
const BARS = 40;
const cache = new Map<string, Promise<number[] | null>>();

export function decodePeaks(src: string, duration: number): Promise<number[] | null> {
  const cached = cache.get(src);
  if (cached) return cached;
  if (!Number.isFinite(duration) || duration <= 0) return Promise.resolve(null);
  const result = duration > MAX_SECONDS ? Promise.resolve(null) : decode(src);
  cache.set(src, result);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return result;
}

async function decode(src: string): Promise<number[] | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const size = Number(response.headers.get("content-length"));
    if (size > MAX_BYTES) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const parts: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_BYTES) {
          await reader.cancel();
          return null;
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    // The visual needs peaks, not a full-rate PCM copy of a recording.
    const context = new AudioContext({ sampleRate: 8000 });
    try {
      const audio = await context.decodeAudioData(bytes.buffer);
      if (audio.duration > MAX_SECONDS) return null;
      const data = audio.getChannelData(0);
      const stride = Math.max(1, Math.floor(data.length / BARS));
      const peaks = Array.from({ length: BARS }, (_, index) => {
        let max = 0;
        const to = Math.min(data.length, (index + 1) * stride);
        const step = Math.max(1, Math.floor(stride / 200));
        for (let i = index * stride; i < to; i += step) max = Math.max(max, Math.abs(data[i]));
        return max;
      });
      const top = Math.max(0.01, ...peaks);
      return peaks.map((peak) => Math.max(0.12, peak / top));
    } finally {
      await context.close();
    }
  } catch {
    return null;
  }
}
