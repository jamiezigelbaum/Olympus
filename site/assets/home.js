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
  var running = false, last = 0;
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
    var busy = false;
    state.forEach(function (st, scene) {
      var sc = frames.get(scene).contentWindow && frames.get(scene).contentWindow.olympusScene;
      if (!sc) { busy = true; return; }
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
    });
    if (busy) requestAnimationFrame(tick);
    else running = false;
  }

  if (motion) {
    // Arrive: the stage's top has come a little way into the screen. Play: the stage's middle (tall stages count only
    // their first 70% of a screen) has reached the middle of the screen. The first scene does both on load; a scene
    // already scrolled past does both at once; at the very bottom every scene in view does both.
    var pending = scenes.filter(function (s) { return frames.has(s); });
    var ticking = false;
    var check = function () {
      ticking = false;
      var vh = window.innerHeight;
      var atBottom = window.scrollY + vh >= document.documentElement.scrollHeight - 2;
      pending = pending.filter(function (scene) {
        var r = scene.querySelector(".stage").getBoundingClientRect();
        var mid = r.top + Math.min(r.height, vh * 0.7) / 2;
        if (scene === scenes[0] || mid <= vh / 2 || r.bottom < 0 || (atBottom && r.top < vh)) {
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
