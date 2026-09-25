import { join } from 'node:path';
import { Bridge } from './bridge';
import type { Mode, WordEvent } from './timeline';

export interface Clock {
  now(): number; // song seconds
  playing: boolean;
}

export type Options = {
  display: number; // index into NSScreen.screens, 0 = main
  zoomStrength: number; // 0 = no zoom, 1 = target fills the window
};

// Google shows CAPTCHAs within ~20s at this pace; DuckDuckGo rarely does.
const SEARCH_URL: Record<Mode, string> = {
  web: 'https://duckduckgo.com/?ia=web&q=',
  images: 'https://duckduckgo.com/?ia=images&iax=images&q=',
};

type Rect = { x: number; y: number; width: number; height: number };

type Slot = {
  id: number;
  query: string;
  mode: Mode;
  state: 'idle' | 'loading' | 'ready';
  visible: boolean;
  loadFor: Ev | null; // the event this page was loaded for
  loadSeq: number;
  loadStart: number;
  nextPrepAt: number;
  prepping: boolean;
  armedFor: Ev | null; // the page will start zooming by itself when revealed for this event
  bounds: Rect; // where the window is, or will appear when revealed
  lastUsed: number;
};

type Ev = WordEvent & { slot?: Slot; fired?: boolean };

const PAGE_LIB = await Bun.file(join(import.meta.dir, 'page.js')).text();

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const ignore = () => {}; // Apple Events fail harmlessly, e.g. for a window the user closed

const POOL_SIZE = 28; // Safari windows created up front (~100-150 MB each)
const MAX_PILE = 10; // windows visible at once
const LOOKAHEAD = 5; // seconds of lyrics to preload
const SEARCH_GAP_MS = 250; // bursts of searches overload Safari and trip rate limits
const MAX_LOADING = 5; // pages loading at once
const FIRST_PREP_MS = 900; // results are usually rendered by then
const PREP_RETRY_MS = 400;
const LOAD_TIMEOUT_MS = 8000;
const MAX_COVER = 0.3; // a new window may cover at most this much of the previous one

// Safari handles every Apple Event on its main thread, and each one gets slow (~100-200ms) when
// many pages are loading. So the design minimises events on the critical path: windows are
// loaded, positioned and "armed" ahead of time while hidden, and a reveal is one event on its
// own bridge - the page notices it became visible and starts its own zoom.
export class Director {
  readonly fg = new Bridge('fg'); // reveals only
  readonly bg = new Bridge('bg'); // navigation, page setup, positioning, hiding
  private slots: Slot[] = [];
  private pile: Slot[] = []; // visible windows, bottom -> top
  private events: Ev[] = [];
  private cursor = 0; // first unfired event
  private screen!: Rect;
  private timer?: ReturnType<typeof setInterval>;
  private lastSearch = 0;

  constructor(
    private clock: Clock,
    private opts: Options,
  ) {}

  async init(onProgress?: (n: number) => void) {
    const screens = await this.bg.call<Rect[]>('screens');
    this.screen = screens[this.opts.display] ?? screens[0]!;
    const wasRunning = await this.bg.call<boolean>('activate');
    // launching Safari opens an empty Start Page window that would sit behind the pile
    if (!wasRunning) await this.bg.call('closeStartPages');
    for (let i = 0; i < POOL_SIZE; i++) {
      const bounds = this.randomBounds();
      const id = await this.bg.call<number>('create', { bounds });
      this.slots.push({
        bounds,
        id,
        query: '',
        mode: 'web',
        state: 'idle',
        visible: false,
        loadFor: null,
        loadSeq: 0,
        loadStart: 0,
        nextPrepAt: 0,
        prepping: false,
        armedFor: null,
        lastUsed: -Infinity,
      });
      onProgress?.(i + 1);
    }
    // the first Apple Event from a fresh osascript process is slow; get it out of the way
    await this.fg.call('index', { id: this.slots[0]!.id });
  }

  start() {
    this.timer = setInterval(() => this.tick(), 8);
  }

  setTimeline(events: WordEvent[]) {
    this.events = events.map((e) => ({ ...e }));
    this.resync(this.clock.now());
  }

  // After a seek or a new track: skip everything before `now` and clear the screen.
  resync(now: number) {
    const idx = this.events.findIndex((e) => e.t >= now - 0.05);
    this.cursor = idx < 0 ? this.events.length : idx;
    this.events.forEach((e, i) => (e.fired = i < this.cursor));
    this.hidePile();
  }

  private tick() {
    if (!this.clock.playing) return;
    const now = this.clock.now();
    const lead = 0.02; // one Apple Event round trip
    while (this.cursor < this.events.length && this.events[this.cursor]!.t <= now + lead) {
      const ev = this.events[this.cursor++]!;
      ev.fired = true;
      if (now - ev.end <= 0.3) this.fire(ev, now);
    }
    this.preload(now);
    for (const slot of this.slots) {
      if (slot.state === 'loading' && !slot.prepping && performance.now() >= slot.nextPrepAt) this.prep(slot);
    }
  }

  // ---- preloading ---------------------------------------------------------------------

  private preload(now: number) {
    // every word gets its own fresh search, even repeats, so no two reveals show the same page
    const horizon = now + LOOKAHEAD;
    for (let i = this.cursor; i < this.events.length; i++) {
      const ev = this.events[i]!;
      if (ev.t > horizon) break;
      if (ev.slot) continue;
      if (performance.now() - this.lastSearch < SEARCH_GAP_MS) break;
      if (this.slots.filter((s) => s.state === 'loading').length >= MAX_LOADING) break;
      const slot = this.freeSlot(now);
      if (!slot) break;
      ev.slot = slot;
      this.load(slot, ev, this.events[i - 1]?.slot?.bounds);
    }
  }

  private reserved(now: number) {
    const set = new Set<Slot>();
    for (let i = this.cursor; i < this.events.length && this.events[i]!.t < now + LOOKAHEAD + 1; i++) {
      const s = this.events[i]!.slot;
      if (s) set.add(s);
    }
    return set;
  }

  private freeSlot(now: number): Slot | null {
    const reserved = this.reserved(now);
    const hidden = this.slots.filter((s) => !s.visible && !reserved.has(s) && s.state !== 'loading');
    if (hidden.length) return hidden.reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b));
    // pool exhausted: recycle the most buried visible window (never the top few)
    const victim = this.pile.slice(0, Math.max(0, this.pile.length - 3)).find((s) => !reserved.has(s));
    if (victim) this.hideSlots([victim]);
    return victim ?? null;
  }

  private load(slot: Slot, ev: Ev, prev?: Rect) {
    Object.assign(slot, {
      query: ev.query,
      mode: ev.mode,
      state: 'loading',
      loadFor: ev,
      loadSeq: slot.loadSeq + 1,
      loadStart: performance.now(),
      nextPrepAt: performance.now() + FIRST_PREP_MS,
      armedFor: null,
    });
    this.lastSearch = performance.now();
    this.bg.call('setUrl', { id: slot.id, url: SEARCH_URL[ev.mode] + encodeURIComponent(ev.query) }).catch(ignore);
    slot.bounds = this.boundsAfter(prev);
    this.bg.call('setBounds', { id: slot.id, bounds: slot.bounds }).catch(ignore);
  }

  private goOpts(ev: WordEvent) {
    const seconds = Math.max(0.35, Math.min(1.3, (ev.end - ev.t) * 2.2));
    const strength = this.opts.zoomStrength;
    return { ms: Math.round(seconds * 1000), frac: rand(0.3, 0.6), strength, off: strength <= 0 };
  }

  // Find the zoom target and arm the zoom, while the window is still hidden.
  private async prep(slot: Slot) {
    slot.prepping = true;
    const seq = slot.loadSeq;
    const ev = slot.loadFor;
    const prepOpts = { mode: slot.mode, query: slot.query };
    // right after setUrl the window can still show the previous page: check it's ours
    const code = `${PAGE_LIB}
(function () {
  var q = (new URLSearchParams(location.search).get('q') || '').toLowerCase();
  if (q !== ${JSON.stringify(slot.query)}) return 'wait';
  var r = __ih.prep(${JSON.stringify(prepOpts)});
  if (r !== 'ok') return r;
  __ih.arm(${JSON.stringify(ev ? this.goOpts(ev) : { ms: 600 })});
  return 'ok';
})()`;
    const res = await this.bg.call<string>('js', { id: slot.id, code }).catch(() => 'err');
    slot.prepping = false;
    if (slot.loadSeq !== seq) return;
    const timedOut = performance.now() - slot.loadStart > LOAD_TIMEOUT_MS;
    if (res === 'ok' || timedOut) {
      slot.state = 'ready';
      slot.armedFor = res === 'ok' && !slot.visible ? ev : null;
    } else slot.nextPrepAt = performance.now() + PREP_RETRY_MS;
  }

  // ---- revealing ----------------------------------------------------------------------

  private fire(ev: Ev, now: number) {
    if (ev.breakBefore) this.hidePile();
    const slot = ev.slot;
    if (!slot) {
      this.log(ev, 'MISS (no free window)');
      return;
    }
    const due = performance.now() - (now - ev.t) * 1000; // wall time the word starts
    const note = slot.state !== 'ready' ? 'still loading' : slot.armedFor ? '' : 'no zoom';
    slot.lastUsed = ev.t;
    slot.visible = true;
    slot.armedFor = null;
    this.pile = this.pile.filter((s) => s !== slot);
    this.pile.push(slot);

    this.fg
      .call('reveal', { id: slot.id })
      .then(() => this.log(ev, `${Math.round(performance.now() - due)}ms`.padStart(6) + `  ${note}`))
      .catch(ignore);

    const extra = this.pile.length - MAX_PILE;
    if (extra > 0) this.hideSlots(this.pile.slice(0, extra));
  }

  private hideSlots(slots: Slot[]) {
    if (!slots.length) return;
    for (const s of slots) s.visible = false;
    this.pile = this.pile.filter((s) => s.visible);
    this.bg.call('hide', { ids: slots.map((s) => s.id) }).catch(ignore);
  }

  hidePile() {
    this.hideSlots([...this.pile]);
  }

  // Random, but a window shouldn't land on top of the one revealed just before it: take the first
  // random candidate covering at most MAX_COVER of the previous window, else the least-covering one.
  private boundsAfter(prev?: Rect): Rect {
    let best = this.randomBounds();
    if (!prev) return best;
    let bestCover = this.coverage(prev, best);
    for (let i = 0; i < 30 && bestCover > MAX_COVER; i++) {
      const c = this.randomBounds();
      const cover = this.coverage(prev, c);
      if (cover < bestCover) [best, bestCover] = [c, cover];
    }
    return best;
  }

  // fraction of `under`'s on-screen area that `over` hides
  private coverage(under: Rect, over: Rect): number {
    const s = this.screen;
    const clip = (r: Rect) => ({
      l: Math.max(r.x, s.x),
      t: Math.max(r.y, s.y),
      r: Math.min(r.x + r.width, s.x + s.width),
      b: Math.min(r.y + r.height, s.y + s.height),
    });
    const a = clip(under);
    const b = clip(over);
    const area = Math.max(0, a.r - a.l) * Math.max(0, a.b - a.t);
    const overlap = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    return area > 0 ? overlap / area : 0;
  }

  private randomBounds(): Rect {
    const { x, y, width: W, height: H } = this.screen;
    // below ~660pt wide Safari collapses the address bar, and the search term should stay visible
    const w = Math.round(Math.min(W, Math.max(660, W * rand(0.42, 0.68))));
    const h = Math.round(Math.min(H * 0.92, w * rand(0.6, 0.85)));
    return {
      x: Math.round(x + rand(-0.05 * W, W - w * 0.8)),
      y: Math.round(y + rand(0, H - h * 0.75)),
      width: w,
      height: h,
    };
  }

  private log(ev: WordEvent, what: string) {
    console.log(`${ev.t.toFixed(2).padStart(7)}  ${ev.word.padEnd(16)} ${ev.mode.padEnd(6)} ${what}`);
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.bg.call('close', { ids: this.slots.map((s) => s.id) }).catch(ignore);
    this.fg.close();
    this.bg.close();
  }
}
