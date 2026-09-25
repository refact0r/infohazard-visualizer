// Injected into each results page via Safari's `do JavaScript`. Defines window.__ih with:
//   prep({mode, query})              -> 'ok' | 'wait'   (runs while the window is still hidden)
//   arm({ms, frac, strength, off})   -> zoom when the window becomes visible (or now, if it is)
(() => {
  if (window.__ih) return 'ok';
  const ih = (window.__ih = { target: null, armed: null });

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shown = (el) =>
    !el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true });

  // Every on-page occurrence of the query as a whole word, scored so big/bold/heading text near
  // the top wins (dictionary headwords, result titles).
  function wordTargets(q) {
    // lyrics use straight apostrophes, pages often curly ones: match either
    const pat = esc(q).replace(/'/g, "['\u2018\u2019]");
    const re = new RegExp('(^|[^\\p{L}\\p{N}])(' + pat + ')(?=$|[^\\p{L}\\p{N}])', 'iu');
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode()) && out.length < 300) {
      const m = re.exec(n.nodeValue);
      if (!m) continue;
      const el = n.parentElement;
      if (!el || el.closest('script,style,noscript,textarea,[aria-hidden="true"],[role="navigation"]')) continue;
      const start = m.index + m[1].length;
      const range = document.createRange();
      range.setStart(n, start);
      range.setEnd(n, start + m[2].length);
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || !shown(el)) continue;
      const docY = r.top + scrollY;
      if (docY < 90) continue; // search header
      // matches far down are usually "related searches" at the bottom: never scroll that far
      if (docY > innerHeight * 2) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 14;
      let score = fs * fs;
      if ((parseInt(cs.fontWeight) || 400) >= 500) score *= 1.2;
      if (el.closest('h1,h2,h3,[role="heading"]')) score *= 1.3;
      if ((el.textContent || '').trim().length <= q.length + 2) score *= 1.4;
      // lower matches only win when nothing near the top matches
      if (docY > innerHeight * 1.5) score *= 0.3;
      out.push({ range, score, kind: 'word' });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function gridImages() {
    return [...document.images]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((o) => o.r.width >= 80 && o.r.height >= 60 && o.r.top + scrollY > 60 && shown(o.el))
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
  }

  ih.prep = (o) => {
    if (document.readyState === 'loading') return 'wait';
    if (o.mode === 'images') {
      // a random one of the top results, preferring thumbnails that have already loaded
      const top = gridImages().slice(0, 6);
      const loaded = top.filter((x) => x.el.complete && x.el.naturalWidth > 1);
      const pool = loaded.length ? loaded : top;
      if (!pool.length) return 'wait';
      ih.target = { el: pool[Math.floor(Math.random() * pool.length)].el, kind: 'image' };
    } else {
      // a page barely taller than the window is no results page (e.g. a "bots use DuckDuckGo too"
      // check): its only heading is a footer promo, so show it as it is instead of zooming there
      if (document.documentElement.scrollHeight < innerHeight * 1.5) {
        if (document.readyState !== 'complete') return 'wait';
        ih.target = null;
        return 'ok';
      }
      const c = wordTargets(o.query);
      if (c.length) {
        // a little variety between near-equal candidates
        const top = c.filter((x) => x.score >= c[0].score * 0.85).slice(0, 2);
        ih.target = top[Math.floor(Math.random() * top.length)];
      } else {
        // no match: the biggest heading near the top (on DuckDuckGo the first <h3> anywhere is a
        // browser ad far down the page, which made the zoom scroll away to it)
        const near = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
          .filter((h) => {
            const y = h.getBoundingClientRect().top + scrollY;
            return y > 90 && y < innerHeight * 1.5 && shown(h) && (h.textContent || '').trim();
          })
          .sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize));
        ih.target = near[0] ? { el: near[0], kind: 'title' } : null;
      }
    }
    if (ih.target) {
      const r = rectOf(ih.target);
      if (r.top > innerHeight * 0.65 || r.top < 0) {
        scrollTo(0, Math.max(0, r.top + scrollY - innerHeight * (0.25 + Math.random() * 0.25)));
      }
    }
    return 'ok';
  };

  const rectOf = (t) => (t.range ? t.range.getBoundingClientRect() : t.el.getBoundingClientRect());

  // Zoom as soon as the window is revealed, so a reveal is one Apple Event (make the window
  // visible) instead of two (show + do JavaScript) - Safari gets slow at those under load.
  ih.arm = (o) => {
    if (document.visibilityState === 'visible') ih.go(o);
    else ih.armed = o;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !ih.armed) return;
    const o = ih.armed;
    ih.armed = null;
    ih.go(o);
  });

  ih.go = (o) => {
    if (o.off || !ih.target) return;
    // Animate <body>, not <html>: with will-change it gets its own compositing layer, so Safari
    // can run the animation in the compositor instead of committing every frame on its main thread.
    const el = document.body;
    el.getAnimations().forEach((a) => a.cancel());
    el.style.willChange = 'transform';
    el.style.transformOrigin = '0 0';
    const vw = innerWidth;
    const vh = innerHeight;
    const r = rectOf(ih.target);
    if (r.width < 1) return;

    const isImage = ih.target.kind === 'image';
    const strength = o.strength ?? 1;
    let s;
    if (isImage) {
      // the picked image fills most of the window: ~80% at the default strength, 95% at 1
      const fill = 0.55 + 0.4 * strength;
      s = clamp(Math.min((vw * fill) / r.width, (vh * fill) / r.height), 1, 5);
    } else {
      s = (vw * (o.frac || 0.45)) / Math.max(r.width, 40);
      s = clamp(Math.min(s, (vh * 0.8) / r.height), 1.6, 7);
      // strength 1 = the word fills its share of the window; lower pulls the zoom back toward 1x
      s = 1 + (s - 1) * strength;
    }

    // everything in viewport coordinates; body's box origin is where the scale is anchored
    const b = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // body point p (viewport coords) lands at b + s*(p - b) + t: put the target center at the
    // viewport center, but never pull the body's top/left edge into view (t <= -b)
    const tx = Math.min(vw / 2 - b.left - s * (cx - b.left), -b.left);
    const ty = Math.min(vh / 2 - b.top - s * (cy - b.top), -b.top);
    el.animate(
      [{ transform: 'translate(0px, 0px) scale(1)' }, { transform: `translate(${tx}px, ${ty}px) scale(${s})` }],
      { duration: o.ms, easing: 'cubic-bezier(.2,.75,.2,1)', fill: 'forwards' },
    );
  };
  return 'ok';
})();
