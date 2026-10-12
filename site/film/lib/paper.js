// The film's shared grammar: one dossier on one desk (BRIEF.md, Mechanism). Every scene builds with these, so the
// marker, the stamps, the type and the BLOCK button behave the same everywhere. Pure functions of the timeline:
// no callbacks, no clocks; positions are measured once after the fonts load (OLY.ready) and baked into tweens.
//
// Scene layers (frame coordinates, 1920x1080):  #root > .pan (scene-to-scene moves) > .cam (drift, breath)
//   > .shake (stamp jolts) > .sheet-wrap (shadow) > .sheet (paper)  ·  strike bars, nib and stamps live in .shake.
(function () {
  if (window.OLY) return;
  const AT = 0.284;          // expo.out is 86% in at 0.284 of its duration: entrances land on the beat
  const FR = 1 / ((window.OLY_TL && window.OLY_TL.fps) || 30);  // one frame at the timeline's rate (the short masters at 24)
  const SHEET = { x: 250, y: 96, w: 1420, h: 888 };
  const O = 1450;            // the page flap's box reaches this far past the sheet (the turned page's back, reflected)

  const css = `
  .pan,.cam,.shake{position:absolute;inset:0}
  .sheet-wrap{position:absolute;left:${SHEET.x}px;top:${SHEET.y}px;width:${SHEET.w}px;height:${SHEET.h}px;
    filter:drop-shadow(0 2px 0 rgba(120,80,50,.08)) drop-shadow(0 34px 38px rgba(150,90,50,.30)) drop-shadow(0 10px 14px rgba(150,90,50,.18))}
  .sheet{position:absolute;inset:0;background:var(--paper);border-radius:6px;overflow:hidden;
    clip-path:polygon(0 0,min(calc(var(--d,9999)*1px),${SHEET.w}px) 0,min(calc(var(--d,9999)*1px),${SHEET.w}px) max(0px,calc((var(--d,9999) - ${SHEET.w})*1px)),max(0px,calc((var(--d,9999) - ${SHEET.h})*1px)) min(calc(var(--d,9999)*1px),${SHEET.h}px),0 min(calc(var(--d,9999)*1px),${SHEET.h}px))}
  .hd{position:absolute;left:96px;right:96px;top:64px;display:flex;justify-content:space-between;padding-bottom:22px;
    border-bottom:1.5px solid var(--rule);font-family:"Martian Mono";font-size:19px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
  .w{display:inline-block;clip-path:inset(-0.25em -0.4em -0.3em -0.4em)}
  .wi{display:inline-block}
  .drop .w{clip-path:none}
  .bar{position:absolute;left:0;top:0;width:0;background:var(--bar);
    -webkit-mask-image:url(assets/tex/marker.png);mask-image:url(assets/tex/marker.png);-webkit-mask-size:auto 100%;mask-size:auto 100%;
    -webkit-mask-repeat:repeat-x;mask-repeat:repeat-x}
  .nib{position:absolute;left:0;top:0;background:var(--bar);border-radius:6px 32% 32% 6px / 6px 50% 50% 6px;opacity:0;
    -webkit-mask-image:url(assets/tex/marker.png);mask-image:url(assets/tex/marker.png);-webkit-mask-size:auto 100%;mask-size:auto 100%}
  .stamp{position:absolute;font-family:"Nunito";font-weight:900;color:var(--red);border:7px solid var(--red);border-radius:28px;
    padding:8px 34px 12px;letter-spacing:.06em;white-space:nowrap;opacity:0;mix-blend-mode:multiply;
    -webkit-mask-image:url(assets/tex/stamp.png);mask-image:url(assets/tex/stamp.png);-webkit-mask-size:640px 320px;mask-size:640px 320px}
  .hd .nc{text-transform:none}
  .stamp.solid{mix-blend-mode:normal}
  .rx{position:absolute;left:0;top:0;pointer-events:none}
  .rx1 path{fill:var(--bar)}
  .rx2{background:var(--type);border-radius:2px;
    -webkit-mask-image:url(assets/tex/stamp.png);mask-image:url(assets/tex/stamp.png);-webkit-mask-size:220px 110px;mask-size:220px 110px}
  .rx3{background:var(--type);border-radius:1.5px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
  .cur{position:absolute;left:0;top:0;width:1px;height:1px;pointer-events:none}
  .cur svg{position:absolute;left:0;top:0;overflow:visible}
  .flap-wrap{position:absolute;left:${SHEET.x - O}px;top:${SHEET.y - O}px;width:${SHEET.w + 2 * O}px;height:${SHEET.h + 2 * O}px;
    filter:drop-shadow(-10px -6px 14px rgba(110,70,40,.28));pointer-events:none}
  .flap{position:absolute;inset:0;
    background:linear-gradient(135deg,#efe3d0 0px,#efe3d0 calc((var(--d,9999) + ${2 * O}) * 0.7071px - 420px),#fbf5ea calc((var(--d,9999) + ${2 * O}) * 0.7071px - 140px),#e3d3bc calc((var(--d,9999) + ${2 * O}) * 0.7071px - 8px),#cdb89c calc((var(--d,9999) + ${2 * O}) * 0.7071px));
    clip-path:polygon(
      calc((min(var(--d,9999),${SHEET.w}) + ${O}) * 1px) calc((max(0,var(--d,9999) - ${SHEET.w}) + ${O}) * 1px),
      calc((min(var(--d,9999),${SHEET.w}) + ${O}) * 1px) calc((var(--d,9999) - ${SHEET.w} + ${O}) * 1px),
      calc((var(--d,9999) - ${SHEET.h} + ${O}) * 1px) calc((var(--d,9999) - ${SHEET.w} + ${O}) * 1px),
      calc((var(--d,9999) - ${SHEET.h} + ${O}) * 1px) calc((min(var(--d,9999),${SHEET.h}) + ${O}) * 1px),
      calc((max(0,var(--d,9999) - ${SHEET.h}) + ${O}) * 1px) calc((min(var(--d,9999),${SHEET.h}) + ${O}) * 1px))}
  .btn3{position:absolute;font-family:"Arimo";font-weight:700;letter-spacing:.01em}
  .btn3 .face,.btn3 .lit{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:.42em;white-space:nowrap}
  .btn3.idle .face{color:#5b4535;background:linear-gradient(#fdf6e8,#ecdfc8)}
  .btn3.clay .face{color:#f8eadc;background:linear-gradient(#bd8670,#9c6551)}
  .btn3 .lit{color:#fff5ef;background:radial-gradient(ellipse 70% 80% at 50% 38%,#ff8a5c 0%,#f5492b 48%,#d22b19 100%);
    box-shadow:inset 0 .06em .05em rgba(255,226,206,.75),inset 0 -.14em .22em rgba(130,18,8,.45);text-shadow:0 0 .35em rgba(255,240,230,.7);opacity:0}
  .btn3 .core{position:absolute;inset:0;border-radius:.42em;background:radial-gradient(ellipse 55% 60% at 50% 45%,rgba(255,96,50,.95) 0%,rgba(245,73,43,.55) 45%,rgba(245,73,43,0) 75%);opacity:0}
  .btn3 .bloom{position:absolute;inset:0;border-radius:.42em;box-shadow:0 0 .9em .25em rgba(255,92,52,.55),0 0 2.6em 1em rgba(255,130,70,.32);opacity:0}
  .btn3 .rays{position:absolute;left:50%;top:50%;width:900px;height:900px;margin:-450px 0 0 -450px;opacity:0;mix-blend-mode:screen;filter:blur(2px)}
  `;
  const st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);

  const $ = (sel, root = document) => root.querySelector(sel);
  const make = (tag, cls, parent, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  };

  // Position of el's border box in the coordinates of `root` (an ancestor), ignoring transforms (layout positions).
  function box(el, root) {
    let x = 0, y = 0, n = el;
    while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }

  // Damped spring as a GSAP ease (zeta 0.7-0.85 reads premium; brief: 0.8). First reaches 1 at `land` of its duration.
  function spring(z = 0.8, w = 8.6) {
    const wd = w * Math.sqrt(1 - z * z), k = z / Math.sqrt(1 - z * z);
    const f = (t) => (t >= 1 ? 1 : 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + k * Math.sin(wd * t)));
    f.land = (Math.PI - Math.atan(1 / k)) / wd;
    return f;
  }

  // Wrap every word of el (text nodes, recursing into <em> etc.) in a mask: <span.w><span.wi>word</span></span>.
  // Elements with class "atom" are one word. Returns the .wi elements in reading order.
  function split(root) {
    const out = [];
    const wrap = (inner) => { const w = make("span", "w"); const i = make("span", "wi", w); i.appendChild(inner); out.push(i); return w; };
    const walk = (node) => {
      [...node.childNodes].forEach((n) => {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach((p) => {
            if (!p) return;
            frag.appendChild(/^\s+$/.test(p) ? document.createTextNode(p) : wrap(document.createTextNode(p)));
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1) {
          if (n.classList.contains("atom")) { const ph = document.createTextNode(""); n.replaceWith(ph); ph.replaceWith(wrap(n)); }
          else walk(n);
        }
      });
    };
    walk(root);
    return out;
  }

  // Masked rise: each word rises whole from behind its baseline; the LAST word is 86% in on `land`.
  // A word that would have to start before 0 starts mid-rise (expo.out's tail is exponential).
  function rise(tl, els, land, { dur = 0.6, stagger = 0.07, from = 135 } = {}) {
    const n = els.length;
    els.forEach((el, i) => {
      const s = land - AT * dur - (n - 1 - i) * stagger;
      if (s >= 0) tl.fromTo(el, { yPercent: from }, { yPercent: 0, duration: dur, ease: "expo.out" }, s);
      else tl.fromTo(el, { yPercent: from * Math.pow(2, (10 * s) / dur) }, { yPercent: 0, duration: dur + s, ease: "expo.out" }, 0);
    });
  }
  // Dropped into the line (questions): each word falls 12 px into place, 0.07 s apart. No caret, no typewriter.
  function drop(tl, els, land, { dur = 0.45, stagger = 0.07, dy = -12 } = {}) {
    const n = els.length;
    els.forEach((el, i) => {
      const s = Math.max(0, land - AT * dur - (n - 1 - i) * stagger);
      tl.fromTo(el, { y: dy, opacity: 0 }, { y: 0, duration: dur, ease: "expo.out" }, s);
      tl.to(el, { opacity: 1, duration: 0.12, ease: "power1.out" }, s);
    });
  }
  // Cut on: there, in 4 frames, landing on `land`.
  function cut(tl, els, land, { dur = 0.133 } = {}) {
    tl.fromTo(els, { opacity: 0 }, { opacity: 1, duration: dur, ease: "power2.out" }, Math.max(0, land - dur * 0.75));
  }

  // ---- The marker: a plum felt-tip nib (a character, not a wipe) that lays strike bars. ----
  // M = marker(shake, h): M.fly(...) / M.strike(...) / M.hop(...) / M.exit(...) chain from the nib's last position.
  function marker(layer, { h = 60, start = [2120, -160] } = {}) {
    const nib = make("div", "nib", layer);
    const M = { nib, layer, h, x: start[0], y: start[1], on: false };
    const NW = 1.6, size = (hh) => ({ width: Math.round(hh * NW), height: hh });
    gsap.set(nib, { x: M.x, y: M.y - h / 2, ...size(h), transformOrigin: "0% 50%" });

    // Fly so the nib's left-middle touches (x, y) at time T (contact), on an arc; stretch along travel, squash on contact.
    M.fly = (tl, x, y, T, { dur = 0.3, lift = 70, hh = M.h } = {}) => {
      dur = Math.min(dur, T - (M.t || 0));  // never start a flight before the last stroke has finished
      const t0 = T - dur, x0 = M.x, y0 = M.y;
      if (!M.on) { tl.set(nib, { opacity: 1 }, t0); M.on = true; }
      if (hh !== M.h) { tl.to(nib, { ...size(hh), duration: dur, ease: "power2.inOut" }, t0); M.h = hh; }
      const ang = (Math.atan2(y - y0, x - x0) * 180) / Math.PI;
      const up = Math.min(y0, y) - lift;
      tl.to(nib, { x, duration: dur, ease: "power2.inOut" }, t0);
      tl.to(nib, { y: up - hh / 2, duration: dur * 0.45, ease: "power2.out" }, t0);
      tl.to(nib, { y: y - hh / 2, duration: dur * 0.55, ease: "power2.in" }, t0 + dur * 0.45);
      tl.to(nib, { rotation: Math.max(-70, Math.min(70, ang * 0.6)), scaleX: 1.45, scaleY: 0.8, duration: dur * 0.5, ease: "power2.out" }, t0);
      tl.to(nib, { rotation: 0, duration: dur * 0.3, ease: "power2.in" }, T - dur * 0.3);
      tl.to(nib, { scaleX: 1.0, scaleY: 1.0, duration: dur * 0.25, ease: "power2.in" }, T - dur * 0.25);
      // contact: two-frame squash, then recover
      tl.set(nib, { scaleX: 1.28, scaleY: 0.8 }, T);
      tl.to(nib, { scaleX: 1, scaleY: 1, duration: 0.14, ease: "power2.out" }, T + 2 * FR);
      M.x = x; M.y = y;
    };
    // Lay a bar over rect {x,y,w,h} (layer coords): contact at T on the left edge, stroke left to right with overshoot.
    // `into`: put the bar inside a container that moves on its own later (positions stay in the nib's layer coords).
    M.strike = (tl, r, T, { pad = 10, top = 0, hh, dur, lift, fly = 0.3, ov = 0.045, into } = {}) => {
      const bh = hh || r.h, bx = r.x - pad, by = r.y + top, bw = r.w + pad * 2;
      M.fly(tl, bx, by + bh / 2, T, { dur: fly, lift, hh: bh });
      const bar = make("div", "bar", into || layer);
      const o = into ? box(into, layer) : { x: 0, y: 0 };
      gsap.set(bar, { x: bx - o.x, y: by - o.y, height: bh, width: 0,
        borderRadius: `3px ${(bh * 0.28).toFixed(1)}px ${(bh * 0.28).toFixed(1)}px 3px / 3px ${(bh * 0.5).toFixed(1)}px ${(bh * 0.5).toFixed(1)}px 3px` });
      const sd = dur || Math.min(0.34, 0.11 + bw / 2600);
      tl.to(bar, { width: bw * (1 + ov), duration: sd, ease: "power3.out" }, T + FR);
      tl.to(bar, { width: bw, duration: 0.12, ease: "power2.inOut" }, T + FR + sd);
      // the nib rides the bar's leading edge, lifts off at the overshoot; the bar settles back under it
      const nx = bx + Math.max(0, bw * (1 + ov) - bh * NW);
      tl.to(nib, { x: nx, duration: sd, ease: "power3.out" }, T + FR);
      M.x = nx; M.y = by + bh / 2; M.t = T + FR + sd;
      return bar;
    };
    // Wait somewhere out of the way (absolute layer coords), arriving at t + dur.
    M.wait = (tl, t, x, y, { dur = 0.3, rot = -14 } = {}) => {
      tl.to(nib, { x, duration: dur, ease: "power2.inOut" }, t);
      tl.to(nib, { y: y - M.h / 2, rotation: rot, duration: dur, ease: "power2.inOut" }, t);
      M.x = x; M.y = y; M.t = t + dur;
    };
    // Hover: lift off the paper and wait (a small rise and tilt), from the nib's last stop.
    M.hover = (tl, t, { dx = 30, dy = -70, dur = 0.22 } = {}) => {
      tl.to(nib, { x: M.x + dx, y: M.y + dy - M.h / 2, rotation: -12, duration: dur, ease: "power2.out" }, t);
      M.x += dx; M.y += dy; M.t = t + dur;
    };
    // Press something at (x, y) at T (the nib as a finger): squash harder, then bounce off.
    M.press = (tl, x, y, T, opts = {}) => { M.fly(tl, x, y, T, opts); tl.set(nib, { scaleX: 1.4, scaleY: 0.66 }, T); };
    // Leave frame (up and right), then hide.
    M.exit = (tl, T, { dur = 0.35, to = [2140, -220] } = {}) => {
      tl.to(nib, { x: to[0], duration: dur, ease: "power2.in" }, T);
      tl.to(nib, { y: to[1], duration: dur, ease: "power3.in" }, T);
      tl.to(nib, { rotation: -35, scaleX: 1.4, scaleY: 0.82, duration: dur * 0.6, ease: "power2.in" }, T);
      tl.set(nib, { opacity: 0 }, T + dur);
      M.x = to[0]; M.y = to[1]; M.on = false;
    };
    return M;
  }

  // Collapse an inline-block word box to zero width over [t0, T] (lands at speed on T) and the bar over it.
  function collapse(tl, wrap, bar, t0, T, ease = "power3.in") {
    const w = wrap.offsetWidth;
    gsap.set(wrap, { width: w });
    tl.to(wrap, { width: 0, duration: T - t0, ease }, t0);
    if (bar) tl.to(bar, { width: 0, duration: T - t0, ease }, t0);
    return w;
  }

  // ---- Stamps: hover (140%) -> slam on T (2-frame squash, ink spread) -> settled (texture, rotation). ----
  function stamp(tl, el, T, { from = 1.4, rot = -7, fall = 0.12, jolt = [], amp = 4, squash = 0.07, ink = 0.92 } = {}) {
    gsap.set(el, { rotation: rot, transformOrigin: "50% 50%" });
    tl.fromTo(el, { scale: from, opacity: 0 }, { scale: from * 0.98, opacity: 0.32, duration: FR, ease: "none" }, T - fall - FR);
    tl.to(el, { scale: 1, opacity: ink, duration: fall, ease: "power3.in" }, T - fall);
    tl.set(el, { scaleX: 1 + squash, scaleY: 1 - squash * 1.2 }, T);
    tl.to(el, { scaleX: 1, scaleY: 1, duration: 0.16, ease: "power2.out" }, T + 2 * FR);
    // ink spread: the edges bleed a hair on contact, then dry
    tl.fromTo(el, { filter: "blur(0.9px)" }, { filter: "blur(0px)", duration: 0.25, ease: "power2.out", immediateRender: false }, T);
    jolt.forEach((j) => {
      tl.set(j, { y: amp }, T);
      tl.to(j, { y: 0, duration: 0.22, ease: "power2.out" }, T + FR);
    });
  }

  // ---- A page of the dossier: .page (moves as one) > .sheet-wrap (shadow) > .sheet (paper), + an optional flap. ----
  function page(parent, { id, flap = false, header } = {}) {
    const pg = make("div", "page", parent);
    pg.style.cssText = "position:absolute;inset:0";
    if (id) pg.id = id;
    const wrap = make("div", "sheet-wrap", pg);
    const sheet = make("div", "sheet", wrap);
    if (header) make("div", "hd", sheet, `<span>${header[0]}</span><span>${header[1]}</span>`);
    const fw = flap ? make("div", "flap-wrap", pg) : null;
    if (fw) fw.setAttribute("data-layout-allow-overflow", "");  // the turned page's box reaches past the sheet on purpose
    const fl = fw ? make("div", "flap", fw) : null;
    if (fl) gsap.set(fl, { "--d": SHEET.w + SHEET.h + 2 });
    return { page: pg, wrap, sheet, flap: fl };
  }
  // ---- The page turn: the bottom-right corner curls up and the fold sweeps to the top-left corner; the page's back
  // (the flap, reflected across the fold) leaves the frame top-left, uncovering the next page underneath. ----
  function peel(tl, P, t0, { dur = 0.6 } = {}) {
    const d0 = SHEET.w + SHEET.h;
    tl.fromTo([P.sheet, P.flap], { "--d": d0 + 2 }, { "--d": 0, duration: dur * 0.9, ease: "power2.in", immediateRender: false }, t0);
    tl.to(P.page, { x: -260, y: -160, duration: dur * 0.35, ease: "power2.in" }, t0 + dur * 0.65);
  }

  // ---- The mountain plate develops like a Polaroid: flat plum, then the shadows, then the light. ----
  function develop(tl, img, veil, t0, dur) {
    tl.fromTo(veil, { opacity: 1 }, { opacity: 0, duration: dur * 0.55, ease: "power1.in" }, t0);
    tl.fromTo(img, { filter: "contrast(0.35) brightness(0.55) saturate(0.4)" },
      { filter: "contrast(1) brightness(1) saturate(1)", duration: dur, ease: "power2.inOut" }, t0);
  }

  // ---- The BLOCK button (Her shot 15): idle cream -> pressed (down 4 px, lip shrinks) -> lit (red core, flood,
  // bloom, light streaks) -> pulsing softly. Owner exception to the glow ban (BRIEF.md). ----
  function rays() {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "-450 -450 900 900");
    s.setAttribute("class", "rays");
    const defs = document.createElementNS(ns, "defs");
    defs.innerHTML = '<radialGradient id="oly-ray" cx="0" cy="0" r="450" gradientUnits="userSpaceOnUse"><stop offset="0.1" stop-color="#fff3e6" stop-opacity=".95"/><stop offset="0.55" stop-color="#ffd9bf" stop-opacity=".35"/><stop offset="1" stop-color="#ffd9bf" stop-opacity="0"/></radialGradient>';
    s.appendChild(defs);
    // streaks fan down-right as in shot 15, a few faint ones elsewhere
    [[28, 7, 1], [44, 4, 0.8], [58, 9, 0.9], [74, 3, 0.6], [16, 3, 0.55], [196, 5, 0.35], [232, 3, 0.3], [-30, 3, 0.35]].forEach(([a, wd, o]) => {
      const p = document.createElementNS(ns, "polygon");
      const r = (a * Math.PI) / 180, L = 440, n = (wd * Math.PI) / 180;
      p.setAttribute("points", `${Math.cos(r - n) * 40},${Math.sin(r - n) * 40} ${Math.cos(r) * L},${Math.sin(r) * L} ${Math.cos(r + n) * 40},${Math.sin(r + n) * 40}`);
      p.setAttribute("fill", "url(#oly-ray)");
      p.setAttribute("opacity", o);
      s.appendChild(p);
    });
    return s;
  }
  function button(parent, label, { kind = "idle", x, y, w, h, fs }) {
    const b = make("div", `btn3 ${kind}`, parent);
    Object.assign(b.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, fontSize: `${fs}px` });
    const r = kind === "idle" ? rays() : null;
    if (r) b.appendChild(r);
    const bloom = kind === "idle" ? make("div", "bloom", b) : null;
    const face = make("div", "face", b, label);
    const core = kind === "idle" ? make("div", "core", b) : null;
    const lit = kind === "idle" ? make("div", "lit", b, label) : null;
    if (lit) lit.setAttribute("data-layout-allow-overlap", "");  // the lit face sits exactly over the idle one
    const LIP = kind === "clay" ? "#7c4a39" : "#cdb99c", DROP = kind === "clay" ? "rgba(90,40,20,.45)" : "rgba(120,80,40,.35)";
    const sh = (lip, drop) => `inset 0 0.06em 0.04em rgba(255,255,255,${kind === "clay" ? 0.5 : 1}),inset 0 -0.08em 0.12em rgba(70,30,15,.2),0 ${lip}em 0 ${LIP},0 ${drop}em ${drop * 1.6}em -0.1em ${DROP}`;
    gsap.set(face, { boxShadow: sh(0.12, 0.3) });
    return { b, face, core, lit, bloom, rays: r, sh };
  }
  // Extrude out of the paper over [T - dur, T].
  function extrude(tl, B, T, { dur = 0.32 } = {}) {
    tl.fromTo(B.b, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: dur, ease: "power2.out" }, T - dur);
    tl.fromTo(B.face, { boxShadow: B.sh(0, 0) }, { boxShadow: B.sh(0.12, 0.3), duration: dur, ease: "back.out(1.6)" }, T - dur);
  }
  function press(tl, B, T, { pulseTo } = {}) {
    // pressed: down 4 px, lip shrinks (shot 15: the cream button sinks, a red core lights, then it floods)
    tl.to(B.b, { y: 7, duration: 2 * FR, ease: "power2.in" }, T - 2 * FR);
    tl.to(B.face, { boxShadow: B.sh(0.035, 0.12), duration: 2 * FR, ease: "power2.in" }, T - 2 * FR);
    tl.fromTo(B.core, { opacity: 0, scale: 0.35 }, { opacity: 1, scale: 1, duration: 2 * FR, ease: "power2.out" }, T);
    // the flood spreads out from the core (a wipe, not a crossfade: no ghosted dark-on-white label)
    tl.set(B.lit, { opacity: 1, clipPath: "circle(0% at 50% 55%)" }, T + FR);
    tl.to(B.lit, { clipPath: "circle(75% at 50% 55%)", duration: 3 * FR, ease: "power2.in" }, T + FR);
    tl.fromTo(B.bloom, { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.2, ease: "power2.out" }, T + 2 * FR);
    tl.fromTo(B.rays, { opacity: 0, scale: 0.55, rotation: -6 }, { opacity: 0.95, scale: 1.08, rotation: 0, duration: 0.18, ease: "expo.out" }, T + 3 * FR);
    tl.to(B.rays, { opacity: 0.55, scale: 1, duration: 0.5, ease: "power2.out" }, T + 3 * FR + 0.18);
    // the button comes back up a little, lit
    tl.to(B.b, { y: 3, duration: 0.25, ease: "power2.out" }, T + 4 * FR);
    if (pulseTo) {
      const p0 = T + 0.75, per = 0.5, n = Math.max(1, Math.floor((pulseTo - p0) / per));
      tl.to(B.bloom, { opacity: 0.72, duration: per, ease: "sine.inOut", yoyo: true, repeat: n - 1 }, p0);
      tl.to(B.rays, { opacity: 0.38, duration: per, ease: "sine.inOut", yoyo: true, repeat: n - 1 }, p0);
    }
  }

  // ---- Redaction, one style film-wide (timeline.json "redaction"; Jamie picks from the three-style test):
  // felt (a hand-drawn felt-tip stroke), typewriter (an inked square struck over each character), clean (a flat bar).
  // The marks live inside the host, so they ride with it and a collapsing wrapper clips them. Returns the end time.
  const RD = Object.assign({ style: "typewriter", step: 0.05, maxDur: 0.6 }, (window.OLY_TL && window.OLY_TL.redaction) || {});
  const seeded = (str, T) => {  // per-call seed: the same marks whatever order the scenes build in
    let h = Math.round(T * 1000) >>> 0;
    for (const c of str) h = (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0);
    return () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 4294967296);
  };
  // The band a redaction covers: this text's own ink, top to bottom ($ above the cap height, the descenders of
  // y and g, commas), with a margin; never less than the cap height down to a little under the baseline.
  function band(el) {
    const cs = getComputedStyle(el), c = document.createElement("canvas").getContext("2d");
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = c.measureText("NHd$"), fs = parseFloat(cs.fontSize), t = c.measureText(el.textContent || "H");
    const lh = parseFloat(cs.lineHeight) || fs * 1.2;  // an inline-block is one line tall; the text sits centred in it
    const base = (lh - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
    const cap = c.measureText("H").actualBoundingBoxAscent;
    const up = Math.max(cap, t.actualBoundingBoxAscent) + fs * 0.07, down = Math.max(fs * 0.12, t.actualBoundingBoxDescent) + fs * 0.05;
    return { top: base - up, h: up + down, fs };
  }
  const typeStep = (n) => Math.min(RD.step, RD.maxDur / Math.max(1, n));
  function redact(tl, host, T, { style = RD.style, shake } = {}) {
    host.style.position = "relative";
    if (getComputedStyle(host).display === "inline") host.style.display = "inline-block";
    const b = band(host), text = host.textContent, rnd = seeded(text, T);
    if (style === "typewriter") {
      // one span per character, in place (word wrappers from split() keep their own entrances)
      const chs = [];
      const walk = (n) => [...n.childNodes].forEach((c) => {
        if (c.nodeType === 3) {
          const frag = document.createDocumentFragment();
          [...c.textContent].forEach((ch) => { const e = make("span", "rch", frag); e.textContent = ch === " " ? "\u00a0" : ch; chs.push(e); });
          c.replaceWith(frag);
        } else if (c.nodeType === 1 && !c.classList.contains("rx")) walk(c);
      });
      walk(host);
      const step = typeStep(chs.length), avg = host.offsetWidth / Math.max(1, chs.length);
      chs.forEach((c, i) => {
        const sq = make("div", "rx rx2", host), last = i === chs.length - 1;  // the last square covers the glyph's overhang
        sq.setAttribute("data-layout-allow-occlusion", "");  // covering the text is the point
        const mx = Math.floor(rnd() * 200), my = Math.floor(rnd() * 90), dy = (rnd() - 0.5) * 3;
        // at least 60% of an average character wide (no slivers on i, l, t), centred on the character
        const w = Math.max(c.offsetWidth - 3, avg * 0.6) + (last ? b.fs * 0.06 : 0), cx = box(c, host).x + c.offsetWidth / 2;
        gsap.set(sq, { x: cx - w / 2 + (last ? b.fs * 0.03 : 0), y: b.top, width: w, height: b.h,
          rotation: (rnd() - 0.5) * 2.4, transformOrigin: "50% 60%", opacity: 0,
          maskPosition: `${mx}px ${my}px`, webkitMaskPosition: `${mx}px ${my}px` });
        const t = T + i * step;
        tl.set(sq, { opacity: 1, scale: 1.14, y: b.top + dy - 2 }, t);
        tl.to(sq, { scale: 1, y: b.top + dy, duration: 3 * FR, ease: "power2.out" }, t + FR);
        if (shake) { tl.set(shake, { y: 1.5 }, t); tl.to(shake, { y: 0, duration: 2 * FR, ease: "power1.out" }, t + FR); }
      });
      return T + chs.length * step;
    }
    const w = host.offsetWidth;
    if (style === "felt") {
      const pad = b.fs * 0.1, W = w + 2 * pad, H = b.h, n = Math.max(4, Math.round(W / 40)), top = [], bot = [];
      for (let i = 0; i <= n; i++) { top.push([(W * i) / n, (rnd() - 0.5) * H * 0.07]); bot.push([(W * i) / n, H + (rnd() - 0.5) * H * 0.07]); }
      const r = H * 0.16, cl = (x) => Math.min(W - r, Math.max(r, x));
      let d = `M ${r} ${top[0][1]}`;
      top.slice(1, -1).forEach(([x, y]) => (d += ` L ${cl(x)} ${y}`));
      d += ` L ${W - r} ${top[n][1]} Q ${W + r * 0.6} ${H * 0.45} ${W - r * 0.2} ${bot[n][1]}`;
      bot.slice(1, -1).reverse().forEach(([x, y]) => (d += ` L ${cl(x)} ${y}`));
      d += ` L ${r} ${bot[0][1]} Q ${-r * 0.6} ${H * 0.55} ${r * 0.6} ${top[0][1]} Z`;
      const svg = make("div", "rx rx1", host, `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="overflow:visible;display:block"><path d="${d}"/></svg>`);
      gsap.set(svg, { x: -pad, y: b.top, rotation: -0.8, transformOrigin: "0% 50%",
        webkitMaskImage: "url(assets/tex/marker.png)", maskImage: "url(assets/tex/marker.png)", maskSize: `auto ${H}px`, webkitMaskSize: `auto ${H}px` });
      const sd = Math.min(0.3, 0.12 + W / 3000);
      tl.fromTo(svg, { clipPath: "inset(-20% 100% -20% 0%)" }, { clipPath: "inset(-20% 0% -20% 0%)", duration: sd, ease: "power2.out", immediateRender: true }, T);
      return T + sd;
    }
    const pad = b.fs * 0.05, bar = make("div", "rx rx3", host);
    bar.setAttribute("data-layout-allow-occlusion", "");
    gsap.set(bar, { x: -pad, y: b.top, width: w + 2 * pad, height: b.h });
    tl.fromTo(bar, { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 4 * FR, ease: "power1.out", immediateRender: true }, T);
    return T + 4 * FR;
  }
  // How long redact() takes on n characters (scenes chain one redaction after another).
  const redactDur = (n, style = RD.style) => (style === "typewriter" ? n * typeStep(n) : style === "felt" ? 0.3 : 4 * FR);

  // ---- The mouse cursor from the Her film's shot 15: a big white 3D arrow with a charcoal rim and extrusion that
  // swoops in from the right and clicks. Its (0, 0) is the tip. ----
  function cursor(layer, { size = 300, rot = -73 } = {}) {
    const el = make("div", "cur", layer);
    el.setAttribute("data-layout-allow-overlap", "");  // it hovers over the buttons by design
    const k = size / 127, a = (rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const P = [[0, 0], [0, 112], [27, 87], [45, 127], [66, 118], [48, 79], [84, 75]];
    const pts = (dx = 0, dy = 0) => P.map(([x, y]) => `${(k * (x * ca - y * sa) + dx).toFixed(1)},${(k * (x * sa + y * ca) + dy).toFixed(1)}`).join(" ");
    const ext = Array.from({ length: 8 }, (_, i) => `<polygon points="${pts((i + 1) * 1.15, (i + 1) * 1.7)}" fill="#3a3330" stroke="#3a3330" stroke-width="10" stroke-linejoin="round"/>`).join("");
    el.innerHTML = `<svg width="1" height="1">
      <defs><filter id="oly-cur-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
        <linearGradient id="oly-cur-face" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#f4f2ef"/><stop offset="1" stop-color="#dcd7d1"/></linearGradient></defs>
      <g class="csh"><polygon points="${pts()}" fill="rgba(70,35,15,.34)" filter="url(#oly-cur-blur)"/></g>
      ${ext}
      <polygon points="${pts()}" fill="#2c2623" stroke="#2c2623" stroke-width="12" stroke-linejoin="round"/>
      <polygon points="${pts()}" fill="url(#oly-cur-face)" stroke="rgba(255,255,255,.85)" stroke-width="2" stroke-linejoin="round"/>
    </svg>`;
    const sh = el.querySelector(".csh");
    const C = { el, x: 2200, y: 400 };
    gsap.set(el, { x: C.x, y: C.y, opacity: 0, transformOrigin: "0px 0px" });
    gsap.set(sh, { x: 26, y: 34 });
    // Swoop in from the right on a curve, settle, then click at T (the press dips it 9% about the tip).
    // From above right: x arrives first, then the tip comes down onto the target (it never crosses a neighbour).
    C.click = (tl, x, y, T, { from = [x + 520, y - 560], dur = 0.6 } = {}) => {
      const A = T - 0.16, t0 = A - dur;
      tl.set(el, { opacity: 1 }, t0);
      tl.fromTo(el, { x: from[0], rotation: 8 }, { x, rotation: 0, duration: dur, ease: "power3.out", immediateRender: false }, t0);
      tl.fromTo(el, { y: from[1] }, { y, duration: dur, ease: "power2.inOut", immediateRender: false }, t0);
      tl.to(el, { scale: 0.91, duration: 2 * FR, ease: "power2.in" }, T - 2 * FR);
      tl.to(sh, { x: 12, y: 16, duration: 2 * FR, ease: "power2.in" }, T - 2 * FR);
      tl.to(el, { scale: 1, duration: 0.2, ease: "power2.out" }, T + FR);
      tl.to(sh, { x: 26, y: 34, duration: 0.2, ease: "power2.out" }, T + FR);
      tl.to(el, { x: x + 10, y: y + 5, duration: 0.9, ease: "sine.inOut" }, T + 0.25);  // the hand rests, not frozen
      C.x = x + 10; C.y = y + 5;
    };
    C.leave = (tl, t, { to = [2200, C.y + 300], dur = 0.45 } = {}) => {
      tl.to(el, { x: to[0], duration: dur, ease: "power2.in" }, t);
      tl.to(el, { y: to[1], rotation: 6, duration: dur, ease: "power1.in" }, t);
      tl.set(el, { opacity: 0 }, t + dur);
    };
    return C;
  }

  // Nothing is dead still: the camera drifts and breathes over a scene's window.
  function drift(tl, cam, dur, { dx = -14, dy = 0, s0 = 1.0, s1 = 1.014, breath = 1 } = {}) {
    tl.fromTo(cam, { x: 0, scale: s0, transformOrigin: "50% 50%" }, { x: dx, scale: s1, duration: dur, ease: "none" }, 0);
    if (breath) {
      const per = 1.6, n = Math.max(1, Math.floor(dur / per));
      tl.fromTo(cam, { y: -breath }, { y: breath + dy, duration: per, ease: "sine.inOut", yoyo: true, repeat: n - 1 }, 0);
    }
  }

  // Build after the vendored fonts have loaded (positions are measured), then register.
  const FONTS = ['300 100px "Newsreader"', 'italic 300 100px "Newsreader"', '400 40px "Newsreader"', '400 20px "Martian Mono"',
    '600 20px "Martian Mono"', '900 40px "Nunito"', '700 40px "Arimo"'];
  function ready(fn) {
    Promise.all(FONTS.map((f) => document.fonts.load(f))).then(() => document.fonts.ready).then(fn);
  }

  window.OLY = { AT, FR, SHEET, RD, $, make, box, spring, split, rise, drop, cut, marker, collapse, stamp, page, peel, develop, button, extrude, press, redact, redactDur, cursor, drift, ready };
})();
