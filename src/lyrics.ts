import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type Track = { name: string; artist: string; album?: string; duration?: number };
export type LyricLine = { t: number; text: string };

const UA = 'infohazard-visualizer/0.1 (personal music visualizer)';
const CACHE_DIR = join(import.meta.dir, '..', 'cache', 'lyrics');

const cacheFile = (t: Track) =>
  join(CACHE_DIR, `${t.artist} - ${t.name}`.replace(/[/\\:*?"<>|]/g, '_').slice(0, 150) + '.lrc');

// "Song - Remastered 2011", "Song (feat. X)", "Song - Radio Edit" -> "Song"
export const cleanTitle = (s: string) =>
  s.replace(/\s*[-–]\s*(\d{4}\s+)?(remaster|radio|single|live|mono|stereo|edit|version|mix).*$/i, '')
    .replace(/\s*[([](feat|ft|with)\.?\s[^)\]]*[)\]]/gi, '')
    .trim();
const primaryArtist = (s: string) => s.split(/,|&| feat\.? | x /i)[0]!.trim();

async function lrclib(path: string, params: Record<string, string | undefined>) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  const res = await fetch(`https://lrclib.net/api/${path}?${qs}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  return res.json() as Promise<any>;
}

// Synced (LRC) lyrics from lrclib.net, cached on disk. Returns null when none exist.
export async function fetchSyncedLyrics(track: Track): Promise<string | null> {
  const file = Bun.file(cacheFile(track));
  if (await file.exists()) return file.text();

  let lrc: string | null = null;
  const exact = await lrclib('get', {
    track_name: track.name,
    artist_name: track.artist,
    album_name: track.album,
    duration: track.duration ? String(Math.round(track.duration)) : undefined,
  });
  if (exact?.syncedLyrics) lrc = exact.syncedLyrics;

  if (!lrc) {
    for (const name of new Set([track.name, cleanTitle(track.name)])) {
      const list = (await lrclib('search', { track_name: name, artist_name: primaryArtist(track.artist) })) ?? [];
      const synced = (list as any[]).filter((x) => x.syncedLyrics);
      if (track.duration) synced.sort((a, b) => Math.abs(a.duration - track.duration!) - Math.abs(b.duration - track.duration!));
      const best = synced[0];
      if (best && (!track.duration || Math.abs(best.duration - track.duration) < 6)) {
        lrc = best.syncedLyrics;
        break;
      }
    }
  }

  if (lrc) {
    await mkdir(CACHE_DIR, { recursive: true });
    await Bun.write(cacheFile(track), lrc);
  }
  return lrc;
}

export function parseLrc(lrc: string): LyricLine[] {
  const stamp = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(stamp)];
    if (!stamps.length) continue;
    const text = raw.replace(stamp, '').replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
    for (const s of stamps) out.push({ t: Number(s[1]) * 60 + Number(s[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}
