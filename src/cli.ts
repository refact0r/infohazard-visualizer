import { parseArgs } from 'node:util';
import { Bridge } from './bridge';
import { Director, type Clock } from './director';
import { fetchSyncedLyrics, parseLrc, type Track } from './lyrics';
import { buildTimeline } from './timeline';

const HELP = `infohazard-visualizer: real Safari windows searching every lyric, in sync with Spotify

usage: bun start [options]

options:
  --zoom-strength N  0 = no zoom, 1 = target fills the window  (default 0.65)
  --display N        which display to use, 0 = main            (default 0)
`;

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    'zoom-strength': { type: 'string', default: '0.65' },
    display: { type: 'string', default: '0' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (flags.help) {
  console.log(HELP);
  process.exit(0);
}

class SpotifyClock implements Clock {
  playing = false;
  private pos = 0;
  private wall = 0;
  now() {
    return this.playing ? this.pos + (performance.now() - this.wall) / 1000 : this.pos;
  }
  set(pos: number, playing: boolean, wall: number) {
    this.pos = pos;
    this.wall = wall;
    this.playing = playing;
  }
}

const clock = new SpotifyClock();
const director = new Director(clock, {
  display: Number(flags.display),
  zoomStrength: Number(flags['zoom-strength']),
});
const spotify = new Bridge('spotify');

let closing = false;
process.on('SIGINT', async () => {
  if (closing) process.exit(1);
  closing = true;
  console.log('\nclosing windows...');
  await director.shutdown();
  spotify.close();
  process.exit(0);
});

process.stdout.write('creating Safari windows ');
await director.init(() => process.stdout.write('.'));
console.log(' ready\n');
director.start();

let trackId: string | null = null;
let answered = false;
setTimeout(() => {
  if (!answered) console.log('waiting for Spotify... if macOS asks to let "osascript" control Spotify, click Allow');
}, 3000);

async function poll() {
  const t0 = performance.now();
  const sp = await spotify.call<any>('spotify');
  const t1 = performance.now();
  answered = true;
  if (!sp.running) {
    clock.set(clock.now(), false, t1);
    if (trackId !== 'none') console.log('Spotify is not running');
    trackId = 'none';
    return;
  }
  const playing = sp.state === 'playing';
  if (sp.id !== trackId) {
    clock.set(sp.position, playing, (t0 + t1) / 2);
    trackId = sp.id;
    loadTrack({ name: sp.name, artist: sp.artist, album: sp.album, duration: sp.duration }, sp.id);
    return;
  }
  // When the Mac is busy the reply can take a while, and we can't tell when inside that window
  // Spotify read its position. Trusting a slow reply looked like a seek and cleared the screen.
  if (t1 - t0 > 250) {
    if (playing !== clock.playing) clock.set(clock.now(), playing, t1);
    return;
  }
  const predicted = clock.now();
  clock.set(sp.position, playing, (t0 + t1) / 2);
  if (playing && Math.abs(clock.now() - predicted) > 1.2) {
    console.log(`-- seek to ${clock.now().toFixed(1)}s`);
    director.resync(clock.now());
  }
}

async function loadTrack(track: Track, id: string) {
  director.setTimeline([]);
  console.log(`\n== ${track.artist} - ${track.name}`);
  const lrc = await fetchSyncedLyrics(track).catch(() => null);
  if (trackId !== id) return; // skipped to another track meanwhile
  if (!lrc) {
    console.log('   no synced lyrics on lrclib.net for this track');
    return;
  }
  const events = buildTimeline(parseLrc(lrc), track.duration);
  console.log(`   ${events.length} words\n`);
  director.setTimeline(events);
}

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await poll();
  } catch (e) {
    console.warn(String(e));
  } finally {
    busy = false;
  }
}, 500);
