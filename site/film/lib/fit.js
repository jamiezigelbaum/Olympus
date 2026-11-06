// Draw this scene at the size it is shown: the home page sizes its frame and keeps this zoom in step on resize
// (assets/home.js). A 1920x1080 page scaled down afterwards costs a phone the full film size to paint. External rather
// than inline so the site's Content-Security-Policy allows it.
try { if (window.frameElement) document.documentElement.style.zoom = window.frameElement.clientWidth / 1920; } catch (e) {}
