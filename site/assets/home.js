// olympusplugin.ai home. Each sheet ([data-scene]) plays its beats once when it
// scrolls into view: every [data-do] element gets the class "on" at its
// data-at time (ms). The CSS holds the final states, so when motion is off
// (reduced motion, no IntersectionObserver) the page already reads complete.
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
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { play(entry.target); io.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -18% 0px", threshold: 0.2 });
    scenes.forEach(function (scene) { io.observe(scene); });
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
