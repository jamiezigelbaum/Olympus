// olympusplugin.ai home: the long launch film, scene by scene down the page. Each .stage holds one of the film's own
// scenes (/film/scene.html) in a frame, scaled to fit. A scene plays once, at the film's own timing, when its middle
// reaches the middle of the screen (Jamie, 2026-10-12: earlier felt too soon). With reduced motion, or ?still for
// screenshots, every scene shows its last frame instead.
(function () {
  "use strict";
  var motion = document.documentElement.classList.contains("motion");
  var scenes = Array.prototype.slice.call(document.querySelectorAll("[data-scene]"));

  // Frame each scene, all at once: a scene still loading when it reaches the middle would start late.
  var frames = new Map();
  scenes.forEach(function (scene) {
    var stage = scene.querySelector(".stage");
    if (!stage) return;
    var f = document.createElement("iframe");
    f.title = "";
    f.tabIndex = -1;
    f.setAttribute("aria-hidden", "true");
    f.setAttribute("scrolling", "no");
    f.src = "/film/scene.html?s=" + encodeURIComponent(stage.getAttribute("data-film-scene")) + (motion ? "" : "&still");
    stage.appendChild(f);
    frames.set(scene, f);
  });

  // The frame is 1920 wide, cropped to 1540 (see home.css): scale it to the stage's width.
  function fit() {
    frames.forEach(function (f) { f.style.setProperty("--k", f.parentNode.clientWidth / 1540); });
  }
  fit();
  if ("ResizeObserver" in window) new ResizeObserver(fit).observe(document.querySelector(".reel"));
  else window.addEventListener("resize", fit);

  // One clock for every scene. A card arrives (rises into its stage) once the stage scrolls into view, and holds its
  // first frame; once it reaches the middle of the screen its time runs to its end. Every animation frame moves each scene's time toward its
  // target at real speed and seeks its timeline there, so no scene depends on its frame's own timers (one stalled
  // halfway, 2026-10-12), and a scene asked to play before it has loaded starts the moment it is ready.
  var state = new Map();   // scene -> { arrived, played, t, e }
  var running = false, last = 0, retries = 0;
  var ENTER = 0.6;         // seconds for the stand-in entry (film/scene.html)

  function want(scene, step) {
    var st = state.get(scene);
    if (!st) state.set(scene, st = { arrived: false, played: false, t: null, e: 0 });
    if (step === "arrive") st.arrived = true;
    if (step === "play") st.arrived = st.played = true;
    if (!running) { running = true; last = 0; requestAnimationFrame(tick); }
  }

  function tick(now) {
    var dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    var busy = false, loading = false;
    state.forEach(function (st, scene) {
      var sc = frames.get(scene).contentWindow && frames.get(scene).contentWindow.olympusScene;
      if (!sc) { loading = true; return; }
      if (sc.enter && st.arrived && st.e < ENTER) {
        st.e = Math.min(st.e + dt, ENTER);
        sc.enter.progress(st.e / ENTER);
      }
      if (st.t == null) st.t = sc.start;
      if (st.played && !st.released) { st.released = true; sc.release(); }
      var target = st.played ? sc.end : sc.start;
      if (st.t < target) {
        st.t = Math.min(st.t + dt, target);
        sc.tl.seek(st.t, false);
      }
      if (st.t < target || (sc.enter && st.arrived && st.e < ENTER)) busy = true;
      cursors(frames.get(scene));
    });
    if (busy) requestAnimationFrame(tick);
    else {
      running = false;
      // A scene still loading is checked a few times a second, not every frame, and given up on after 30 seconds
      // (a frame that failed to load would otherwise keep the page busy forever).
      if (loading && retries++ < 120) setTimeout(function () {
        if (!running) { running = true; last = 0; requestAnimationFrame(tick); }
      }, 250);
    }
  }

  // The film's mouse cursor (the hero's BLOCK click) is drawn over the whole window rather than inside its card:
  // it swoops in from the window's edge and leaves off it (Jamie, 2026-10-12). The scene still moves its own cursor
  // (hidden); each frame this copies where it is, and stretches its way in and out along the same line and ease to
  // reach the edge.
  var layer = null, drawn = new Map();
  function cursors(f) {
    var w = f.contentWindow, list = w && w.OLY_CURSORS;
    if (!list || !list.length) return;
    var g = w.gsap, k = f.getBoundingClientRect().width / 1920, vw = window.innerWidth, vh = window.innerHeight;
    list.forEach(function (C) {
      var d = drawn.get(C);
      if (!d) {
        if (!layer) {
          layer = document.createElement("div");
          layer.className = "cursor-layer";
          layer.setAttribute("aria-hidden", "true");
          document.body.appendChild(layer);
        }
        d = document.createElement("div");
        d.innerHTML = C.el.innerHTML;
        layer.appendChild(d);
        drawn.set(C, d);
        C.el.style.visibility = "hidden";
      }
      var op = +g.getProperty(C.el, "opacity");
      if (op < 0.01) { d.style.opacity = "0"; return; }
      var tip = C.el.getBoundingClientRect(), fr = f.getBoundingClientRect();
      var px = fr.left + tip.left * k, py = fr.top + tip.top * k;
      var x = +g.getProperty(C.el, "x"), y = +g.getProperty(C.el, "y"), m = 360 * k;
      // inside a leg: how far along it is (per axis, so each keeps its own ease), stretched to the window's edge
      var now = w.olympusScene.tl.time();
      C.legs.forEach(function (L) {
        if (now < L.t || now > L.t + L.dur) return;
        var dx = L.out ? L.to[0] - L.from[0] : L.from[0] - L.to[0], dy = L.out ? L.to[1] - L.from[1] : L.from[1] - L.to[1];
        var ex = dx ? (x - L.from[0]) / (L.to[0] - L.from[0]) : 1, ey = dy ? (y - L.from[1]) / (L.to[1] - L.from[1]) : 1;
        // the leg's still end, in the window: where the tip lands (in) or sets off from (out)
        var ax = px + (L.out ? -(x - L.from[0]) : L.to[0] - x) * k, ay = py + (L.out ? -(y - L.from[1]) : L.to[1] - y) * k;
        var lx = dx > 0 ? (vw + m - ax) / (dx * k) : dx < 0 ? (ax + m) / (-dx * k) : Infinity;
        var ly = dy > 0 ? (vh + m - ay) / (dy * k) : dy < 0 ? (ay + m) / (-dy * k) : Infinity;
        var lam = Math.max(1, Math.min(lx, ly));
        var fx = L.out ? ex : 1 - ex, fy = L.out ? ey : 1 - ey;   // share of the leg still to come (in) or done (out)
        px += (lam - 1) * dx * fx * k;
        py += (lam - 1) * dy * fy * k;
      });
      d.style.opacity = String(op);
      d.style.transform = "translate(" + px.toFixed(1) + "px," + py.toFixed(1) + "px) rotate(" + g.getProperty(C.el, "rotation") +
        "deg) scale(" + (g.getProperty(C.el, "scale") * k).toFixed(4) + ")";
      var sh = d.querySelector(".csh");
      if (sh) sh.setAttribute("transform", "translate(" + g.getProperty(C.sh, "x") + " " + g.getProperty(C.sh, "y") + ")");
    });
  }

  if (motion) {
    // Arrive: the stage's top has come a little way into the screen. Play: the stage's middle (tall stages count only
    // their first 70% of a screen) is just past the middle of the screen, or the whole stage is on screen and close
    // to it (a reader who stops with the card in full view shouldn't have to nudge it the last few lines). The first
    // scene does both on load; a scene already scrolled past does both at once; at the very bottom every scene in
    // view does both.
    var pending = scenes.filter(function (s) { return frames.has(s); });
    var ticking = false;
    var check = function () {
      ticking = false;
      var vh = window.innerHeight;
      var atBottom = window.scrollY + vh >= document.documentElement.scrollHeight - 2;
      pending = pending.filter(function (scene) {
        var r = scene.querySelector(".stage").getBoundingClientRect();
        var mid = r.top + Math.min(r.height, vh * 0.7) / 2;
        if (scene === scenes[0] || mid <= vh * 0.55 || (r.top >= 0 && r.bottom <= vh && mid <= vh * 0.62) ||
            r.bottom < 0 || (atBottom && r.top < vh)) {
          want(scene, "play");
          return false;
        }
        if (r.top < vh * 0.9) want(scene, "arrive");
        return true;
      });
      if (!pending.length) {
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
      }
    };
    var onScroll = function () {
      if (!ticking) { ticking = true; requestAnimationFrame(check); }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    check();
  }

  // Films open in a dialog; nothing loads until someone asks to watch.
  var player = document.querySelector(".player");
  if (!player || typeof player.showModal !== "function") return;
  var video = player.querySelector("video");
  document.querySelectorAll("[data-film]").forEach(function (button) {
    button.addEventListener("click", function () {
      var name = button.getAttribute("data-film");
      video.poster = "/media/" + name + "-poster.jpg";
      video.src = "/media/" + name + ".mp4";
      player.showModal();
      video.play().catch(function () {});
    });
  });
  player.addEventListener("close", function () {
    video.pause();
    video.removeAttribute("src");
    video.load();
  });
  player.addEventListener("click", function (event) {
    if (event.target === player) player.close();
  });
})();
