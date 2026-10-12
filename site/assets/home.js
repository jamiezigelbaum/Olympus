// olympusplugin.ai home. Each sheet ([data-scene]) plays its beats once when it
// reaches the middle of the screen: every [data-do] element gets the class "on" at its
// data-at time (ms). The CSS holds the final states, so when motion is off
// (reduced motion, or ?still for screenshots) the page already reads complete.
(function () {
  "use strict";
  var root = document.documentElement;
  var motion = root.classList.contains("motion");

  function beat(el) {
    var kind = el.getAttribute("data-do");
    if (kind === "status") { el.textContent = el.getAttribute("data-to"); return; }
    el.classList.add("on");
    if (kind === "strike-collapse") {
      // Let the bar finish its stroke and be read, then fold the struck words away.
      setTimeout(function () {
        el.style.width = el.scrollWidth + "px";
        void el.offsetWidth;
        el.classList.add("gone");
      }, 650);
    }
  }

  function play(scene) {
    if (scene.dataset.played) return;
    scene.dataset.played = "1";
    scene.querySelectorAll("[data-do]").forEach(function (el) {
      var at = parseInt(el.getAttribute("data-at") || "0", 10);
      setTimeout(function () { beat(el); }, at);
    });
  }

  var scenes = document.querySelectorAll("[data-scene]");
  if (!motion) {
    document.querySelectorAll('[data-do="status"]').forEach(beat);
  } else {
    // A sheet plays when its middle reaches the middle of the screen, not on its
    // first edge (Jamie, 2026-10-12: they started too soon). Tall sheets count
    // only their first 70% of a screen. The first sheet plays on arrival, any
    // sheet already scrolled past plays at once, and at the very bottom every
    // sheet in view plays.
    var pending = Array.prototype.slice.call(scenes);
    var ticking = false;
    var check = function () {
      ticking = false;
      var vh = window.innerHeight;
      var atBottom = window.scrollY + vh >= document.documentElement.scrollHeight - 2;
      pending = pending.filter(function (scene) {
        var r = scene.getBoundingClientRect();
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
