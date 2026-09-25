// Long-running JXA process: reads JSON-line commands on stdin, drives Safari/Spotify
// via in-process Apple Events, writes JSON-line replies on stdout. Spawning osascript per
// command costs ~100ms; keeping one process alive makes each call ~5-30ms.
ObjC.import('Foundation');
ObjC.import('AppKit');

const Safari = Application('Safari');
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
const stdout = $.NSFileHandle.fileHandleWithStandardOutput;

function send(obj) {
  stdout.writeData($(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

const win = (id) => Safari.windows.byId(id);

const commands = {
  // Screens in AppleScript window coordinates (origin top-left of the main display).
  screens: () => {
    const list = $.NSScreen.screens;
    const mainH = list.objectAtIndex(0).frame.size.height;
    const out = [];
    for (let i = 0; i < list.count; i++) {
      const v = list.objectAtIndex(i).visibleFrame;
      out.push({
        x: v.origin.x,
        y: mainH - (v.origin.y + v.size.height),
        width: v.size.width,
        height: v.size.height,
      });
    }
    return out;
  },

  // returns whether Safari was already running
  activate: () => {
    const wasRunning = Safari.running();
    Safari.activate();
    return wasRunning;
  },

  // Only called right after we launched Safari ourselves, so these are its default windows.
  closeStartPages: () => {
    delay(0.5);
    let n = 0;
    for (const w of Safari.windows()) {
      try {
        if (w.visible() && w.currentTab.url() === 'favorites://') {
          w.close();
          n++;
        }
      } catch (e) {}
    }
    return n;
  },

  // New windows always appear in front for a moment, so the pool creates them once up front.
  create: ({ bounds }) => {
    // find the new window by diffing ids: "front window" can be someone else's new window
    // if another process is creating windows at the same time
    const before = new Set(Safari.windows.id());
    Safari.Document().make();
    const id = Safari.windows.id().find((x) => !before.has(x));
    if (id === undefined) throw new Error('new window not found');
    const w = win(id);
    w.visible = false;
    if (bounds) w.bounds = bounds;
    return id;
  },

  setUrl: ({ id, url }) => {
    win(id).currentTab.url = url;
    return true;
  },

  // Showing a hidden window also brings it to the front, so a reveal is a single Apple Event.
  reveal: ({ id }) => {
    win(id).visible = true;
    return true;
  },

  setBounds: ({ id, bounds }) => {
    win(id).bounds = bounds;
    return true;
  },

  index: ({ id }) => win(id).index(),

  hide: ({ ids }) => {
    for (const id of ids) {
      try {
        win(id).visible = false;
      } catch (e) {}
    }
    return true;
  },

  close: ({ ids }) => {
    for (const id of ids) {
      try {
        win(id).close();
      } catch (e) {}
    }
    return true;
  },

  js: ({ id, code }) => Safari.doJavaScript(code, { in: win(id).currentTab }),

  spotify: () => {
    const sp = Application('Spotify');
    if (!sp.running()) return { running: false };
    const state = sp.playerState();
    const position = sp.playerPosition();
    const t = sp.currentTrack;
    return {
      running: true,
      state,
      position,
      id: t.id(),
      name: t.name(),
      artist: t.artist(),
      album: t.album(),
      duration: t.duration() / 1000,
    };
  },
};

let buf = '';
while (true) {
  const data = stdin.availableData;
  if (data.length === 0) break;
  buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
      const fn = commands[msg.cmd];
      if (!fn) throw new Error('unknown command ' + msg.cmd);
      send({ id: msg.id, ok: true, result: fn(msg.args || {}) });
    } catch (e) {
      send({ id: msg ? msg.id : null, ok: false, error: String(e) });
    }
  }
}
