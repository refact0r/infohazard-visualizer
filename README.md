# infohazard-visualizer

recreates the effect from ninajirachi's [infohazard music video](https://youtu.be/p2ZdeIKJA8c?si=I0AfjNRULj120PN6&t=56), live, for any song on spotify. every lyric pops up a real safari window with a real search for that word. the page zooms in on the word or on one of the top images.

## setup

you only need to do this once.

1. in safari, go to settings, advanced, and turn on "show features for web developers". then in the new
   developer tab, turn on "allow javascript from apple events".
2. install [bun](https://bun.sh).
3. the first time you run it, macos asks whether `osascript` can control safari and spotify. click allow both times.
4. optional: set safari's search engine to duckduckgo (settings, search). safari only shows the plain search word in the address bar, like in the video, for its default engine.

## run

```sh
bun start
```

then just play music in spotify. skipping, seeking and pausing get picked up within about half a second.
ctrl-c closes all the windows it opened.

| flag | default | |
| --- | --- | --- |
| `--zoom-strength n` | 0.65 | 0 means no zoom, 1 means the zoomed thing fills the window |
| `--display n` | 0 | which display to use, 0 is the main one |

pool size, pile size, how far ahead it preloads and how fast it searches are constants at the top of
`src/director.ts`.

if you want a clip to share, record your screen with macos's built-in recorder (⌘⇧5) while it runs.

## how it works

```
spotify ──(applescript: track, position)──┐
lrclib.net ──(synced lyrics)──> word timeline ──> director ──(jxa bridges)──> safari window pool
                                                                             └─ page.js injected into each page
```

- **lyrics** come from [lrclib.net](https://lrclib.net), which is free and needs no key. they get cached in
  `cache/lyrics/`. lrc files only time whole lines, so each line's words are spread out by syllable count
  (`src/timeline.ts`).
- **web or images**: small words like "when", "was" and "the" usually get a normal results page, and the zoom
  lands on the dictionary card, an answer box or a result title. other words get an image search most of the time,
  and the zoom picks a random image from the top results. every word gets its own fresh search, repeats included.
- **the window pool** (`src/director.ts`): a brand new safari window always flashes on screen, so 28 hidden windows
  get made once at startup and reused. each upcoming word is searched in a hidden window up to 5 seconds early,
  and the window gets positioned, its zoom target found and its zoom "armed" while it's still hidden. each window
  tries not to cover much of the one right before it.
- **a reveal is one apple event.** safari handles apple events on its main thread, and they get slow (anywhere from
  100ms to over a second) when it's busy. so revealing a word just makes its hidden window visible, and the page
  starts its own zoom when it notices it became visible (`visibilitychange` in `src/page.js`).
- **the zoom** animates a `transform` on `<body>` with `will-change`. doing it on `<html>` instead made safari's
  main thread choke once a few windows were zooming at the same time.
- `src/bridge.jxa.js` is a long-running jxa (javascript for automation) process that talks json lines over stdin and
  stdout. starting a new `osascript` for every command would cost about 100ms each.
