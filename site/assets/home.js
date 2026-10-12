// olympusplugin.ai home: the long launch film, scene by scene down the page. Each .stage holds one of the film's own
// scenes (/film/scene.html) in a frame, scaled to fit. A scene plays once, at the film's own timing, when its middle
// reaches the middle of the screen (Jamie, 2026-10-12: earlier felt too soon). With reduced motion, or ?still for
// screenshots, every scene shows its last frame instead.
(function () {
  "use strict";
  var motion = document.documentElement.classList.contains("motion");
  var scenes = Array.prototype.slice.call(document.querySelectorAll("[data-scene]"));

  // Frame each scene. The first loads at once; the rest load as they come near.
  var frames = new Map();
  scenes.forEach(function (scene, i) {
    var stage = scene.querySelector(".stage");
    if (!stage) return;
    var f = document.createElement("iframe");
    f.title = "";
    f.tabIndex = -1;
    f.setAttribute("aria-hidden", "true");
    f.setAttribute("scrolling", "no");
    if (i > 0) f.loading = "lazy";
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

  function play(scene) {
    var f = frames.get(scene);
    var send = function () { f.contentWindow.postMessage({ olympusScene: "play" }, location.origin); };
    // A loaded scene queues "play" until its timeline is built. A frame still on about:blank has no OLY yet: wait for it.
    if (f.contentWindow && f.contentWindow.OLY) send();
    else f.addEventListener("load", send, { once: true });
  }

  if (motion) {
    // A scene plays when its middle reaches the middle of the screen. Tall stages count only their first 70% of a
    // screen. The first plays on arrival, any already scrolled past plays at once, and at the very bottom every scene
    // in view plays.
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
          play(scene);
          return false;
        }
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
