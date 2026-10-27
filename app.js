/* Video Frames — seek a local <video>, draw the frame to a canvas at native size, export. Nothing is uploaded. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

  // ---------- pure helpers (tested in S3_SELFTEST) ----------
  function frameIndex(t, fps) { return Math.floor(t * fps + 1e-6); }
  // Aim at the middle of the target frame so rounding never lands on its neighbour.
  function stepTime(t, fps, dir, dur) { var i = Math.max(0, frameIndex(t, fps) + dir); return Math.min(Math.max(0, dur - 0.5 / fps), (i + 0.5) / fps); }
  function evenTimes(n, dur) { var a = []; for (var i = 0; i < n; i++) a.push((i + 0.5) * dur / n); return a; }
  function autoCols(n) { return Math.max(1, Math.min(6, Math.ceil(Math.sqrt(n)))); }
  function sheetLayout(n, cols, thumbW, aspect, header) {
    cols = Math.min(n, cols || autoCols(n));
    var pad = 8, cellW = thumbW, cellH = Math.round(thumbW / aspect), rows = Math.ceil(n / cols), top = header ? 56 : 0;
    return { cols: cols, rows: rows, pad: pad, cellW: cellW, cellH: cellH, top: top, W: pad + cols * (cellW + pad), H: top + pad + rows * (cellH + pad) };
  }
  function fmtTS(t) {
    var ms = Math.round(Math.max(0, t) * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0") + "." + String(ms % 1000).padStart(3, "0");
  }
  function stamp(t) { return fmtTS(t).replace(/:/g, "-"); }
  function baseName(n) { return (n || "video").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60) || "video"; }
  function captureFrame(src, w, h, type, q) {
    var c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(src, 0, 0, w, h);
    return new Promise(function (res, rej) { c.toBlob(function (b) { if (b) res(b); else rej(new Error("toBlob failed")); }, type, q); });
  }

  // ---------- state ----------
  var video = $("#video"), V = null, caps = [], sheetBlob = null, busy = false;
  var S = Object.assign({ fmt: "image/png", q: 92, count: 12, cols: "0", thumbW: "320", stamps: true, header: true, keep: true }, S3.store("vframes") || {});
  function save() { S3.store("vframes", S); }
  [24, 25, 30, 50, 60, 23.976, 29.97, 59.94, 120].sort(function (a, b) { return a - b; }).forEach(function (f) { $("#fps").appendChild(S3.h("option", { value: f, text: f })); });
  $$("#fmt button").forEach(function (b) {
    b.setAttribute("aria-pressed", String(b.dataset.v === S.fmt));
    b.addEventListener("click", function () { $$("#fmt button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); S.fmt = b.dataset.v; save(); $("#qualWrap").hidden = S.fmt === "image/png"; });
  });
  $("#qualWrap").hidden = S.fmt === "image/png";
  $("#quality").value = S.q; $("#quality").addEventListener("change", function () { S.q = +this.value; save(); });
  $("#count").value = S.count; $("#cols").value = S.cols; $("#thumbW").value = S.thumbW;
  $("#stamps").checked = S.stamps; $("#header").checked = S.header; $("#keepFrames").checked = S.keep;
  ["#count", "#cols", "#thumbW", "#stamps", "#header", "#keepFrames"].forEach(function (s) {
    $(s).addEventListener("change", function () {
      S.count = Math.max(2, Math.min(60, Math.round(+$("#count").value) || 12)); $("#count").value = S.count;
      S.cols = $("#cols").value; S.thumbW = $("#thumbW").value; S.stamps = $("#stamps").checked; S.header = $("#header").checked; S.keep = $("#keepFrames").checked; save();
    });
  });

  // ---------- loading ----------
  var input = S3.drop($("#drop"), function (f) { load(f[0]); }, { accept: "video/*,.mp4,.m4v,.webm,.mov,.mkv,.ogv", multiple: false });
  $("#another").addEventListener("click", function () { input.click(); });
  function once(el, ev, ms) { return new Promise(function (res) { var t = setTimeout(res, ms || 4000); el.addEventListener(ev, function () { clearTimeout(t); res(); }, { once: true }); }); }
  async function load(file, name) {
    if (V && V.url) URL.revokeObjectURL(V.url);
    var url = URL.createObjectURL(file);
    V = { url: url, name: name || file.name, size: file.size, fps: 30 };
    video.src = url;
    var ok = await Promise.race([once(video, "loadedmetadata", 15000).then(function () { return video.videoWidth > 0; }), new Promise(function (r) { video.addEventListener("error", function () { r(false); }, { once: true }); })]);
    if (!ok) { S3.toast("This browser can't play that video (codec not supported).", "error"); return false; }
    if (!isFinite(video.duration)) { // recorder-made WebM has no duration until we seek to the end
      video.currentTime = 1e9; await once(video, "durationchange", 5000); await seek(0);
    }
    $("#drop").hidden = true; $("#editor").hidden = false;
    $("#fname").textContent = V.name; $("#fname").title = V.name;
    $("#scrub").max = video.duration; $("#scrub").step = "any";
    await detectFps();
    meta(); await seek(0); update();
    return true;
  }
  async function detectFps() {
    if (!video.requestVideoFrameCallback) return setFps(30);
    var times = [];
    await new Promise(function (res) {
      var stop = setTimeout(done, 1200);
      function cb(now, m) { times.push(m.mediaTime); if (times.length < 14) video.requestVideoFrameCallback(cb); else done(); }
      function done() { clearTimeout(stop); video.pause(); res(); }
      video.requestVideoFrameCallback(cb);
      video.play().catch(done);
    });
    var d = []; for (var i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
    d.sort(function (a, b) { return a - b; });
    var fps = d.length >= 3 ? 1 / d[d.length >> 1] : 30;
    var known = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120], best = known.reduce(function (b, k) { return Math.abs(k - fps) < Math.abs(b - fps) ? k : b; });
    setFps(Math.abs(best - fps) / best < 0.04 ? best : Math.round(fps), true);
  }
  function setFps(f, detected) {
    V.fps = f;
    if (!$$("#fps option").some(function (o) { return +o.value === f; })) $("#fps").appendChild(S3.h("option", { value: f, text: f }));
    $("#fps").value = String(f);
    V.fpsDetected = !!detected;
  }
  $("#fps").addEventListener("change", function () { if (V) { V.fps = +this.value; V.fpsDetected = false; meta(); update(); } });
  function meta() {
    var box = $("#meta"); box.innerHTML = "";
    [video.videoWidth + " × " + video.videoHeight, fmtTS(video.duration).replace(/\.\d+$/, ""), V.fps + " fps" + (V.fpsDetected ? " (detected)" : ""), V.size ? S3.fmtBytes(V.size) : ""]
      .filter(Boolean).forEach(function (t) { box.appendChild(S3.h("span", { "class": "chip", text: t })); });
  }

  // ---------- playback / stepping ----------
  function seek(t) {
    return new Promise(function (res) {
      t = Math.max(0, Math.min(t, video.duration || 0));
      if (Math.abs(video.currentTime - t) < 1e-4 && !video.seeking) return res();
      var timer = setTimeout(res, 5000);
      video.addEventListener("seeked", function () { clearTimeout(timer); res(); }, { once: true });
      video.currentTime = t;
    });
  }
  function update() {
    if (!V) return;
    var t = video.currentTime;
    $("#tc").textContent = fmtTS(t) + " / " + fmtTS(video.duration).replace(/\.\d+$/, "");
    $("#frameNo").textContent = "frame " + frameIndex(t, V.fps);
    if (document.activeElement !== $("#scrub")) $("#scrub").value = t;
    $("#playBtn").innerHTML = S3.icon(video.paused ? "play" : "pause");
  }
  video.addEventListener("timeupdate", update); video.addEventListener("seeked", update);
  video.addEventListener("play", update); video.addEventListener("pause", update);
  $("#scrub").addEventListener("input", function () { video.pause(); video.currentTime = +this.value; });
  function togglePlay() { if (!V) return; if (video.paused) video.play().catch(function () {}); else video.pause(); }
  function step(dir) { if (!V) return; video.pause(); seek(stepTime(video.currentTime, V.fps, dir, video.duration)); }
  function jump(s) { if (!V) return; video.pause(); seek(video.currentTime + s); }
  $("#playBtn").addEventListener("click", togglePlay); video.addEventListener("click", togglePlay);
  $("#prevF").addEventListener("click", function () { step(-1); }); $("#nextF").addEventListener("click", function () { step(1); });
  $("#back1s").addEventListener("click", function () { jump(-1); }); $("#fwd1s").addEventListener("click", function () { jump(1); });
  document.addEventListener("keydown", function (e) {
    if (!V || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== "range" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); var d = e.key === "ArrowLeft" ? -1 : 1; if (e.shiftKey) jump(d); else step(d); }
    else if (e.key === " " && e.target.tagName !== "BUTTON") { e.preventDefault(); togglePlay(); }
    else if (e.key === "c" || e.key === "C") { e.preventDefault(); captureNow(); }
  });

  // ---------- captures ----------
  async function grab(t) {
    var blob = await captureFrame(video, video.videoWidth, video.videoHeight, S.fmt, S.q / 100);
    return { blob: blob, url: URL.createObjectURL(blob), t: t, w: video.videoWidth, h: video.videoHeight, ext: EXT[blob.type] || "png" };
  }
  function capName(c) { return baseName(V && V.name) + "_" + stamp(c.t) + "." + c.ext; }
  async function captureNow() {
    if (!V || busy) return;
    video.pause();
    if (video.seeking) await once(video, "seeked");
    try { caps.push(await grab(video.currentTime)); renderCaps(); S3.toast("Captured " + fmtTS(video.currentTime)); S3.done(); }
    catch (e) { S3.toast("Couldn't capture this frame", "error"); }
  }
  $("#capture").addEventListener("click", captureNow);
  function renderCaps() {
    caps.sort(function (a, b) { return a.t - b.t; });
    var box = $("#caps"); box.innerHTML = "";
    $("#capsCard").hidden = !caps.length;
    $("#capCount").textContent = caps.length ? caps.length + " · " + S3.fmtBytes(caps.reduce(function (s, c) { return s + c.blob.size; }, 0)) : "";
    caps.forEach(function (c) {
      var img = S3.h("img", { src: c.url, alt: "Frame at " + fmtTS(c.t), title: "Go to " + fmtTS(c.t), loading: "lazy" });
      img.addEventListener("click", function () { if (V) { video.pause(); seek(c.t); } });
      box.appendChild(S3.h("div", { "class": "cap" }, [img, S3.h("div", { "class": "row" }, [
        S3.h("span", { "class": "mono grow", text: fmtTS(c.t) }),
        S3.h("button", { "class": "btn small icon", "aria-label": "Download frame " + fmtTS(c.t), html: S3.icon("download"), onclick: function () { S3.download(c.blob, capName(c)); S3.done(); } }),
        S3.h("button", { "class": "btn small icon ghost", "aria-label": "Remove frame " + fmtTS(c.t), html: S3.icon("x"), onclick: function () { URL.revokeObjectURL(c.url); caps.splice(caps.indexOf(c), 1); renderCaps(); } })
      ])]));
    });
  }
  $("#clearCaps").addEventListener("click", function () { caps.forEach(function (c) { URL.revokeObjectURL(c.url); }); caps = []; renderCaps(); });
  $("#zipAll").addEventListener("click", async function () {
    if (!caps.length) return;
    var files = await Promise.all(caps.map(async function (c) { return { name: capName(c), data: new Uint8Array(await c.blob.arrayBuffer()) }; }));
    if (sheetBlob) files.push({ name: baseName(V && V.name) + "_contact-sheet." + (EXT[sheetBlob.type] || "png"), data: new Uint8Array(await sheetBlob.arrayBuffer()) });
    S3.download(S3.zip(files), baseName(V && V.name) + "_frames.zip"); S3.done();
  });

  // ---------- contact sheet ----------
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888"; }
  function drawSheet(frames, L, info) { // frames: [{src, t}]
    var c = document.createElement("canvas"); c.width = L.W; c.height = L.H;
    var g = c.getContext("2d"), font = cssVar("--font");
    g.fillStyle = "#101215"; g.fillRect(0, 0, L.W, L.H);
    if (L.top) {
      g.fillStyle = "#eceef2"; g.font = "600 17px " + font; g.textBaseline = "middle";
      g.fillText(info.title, L.pad + 4, 20, L.W - 2 * L.pad);
      g.fillStyle = "#a5adb9"; g.font = "13px " + font; g.fillText(info.sub, L.pad + 4, 41, L.W - 2 * L.pad);
    }
    frames.forEach(function (f, i) {
      var x = L.pad + (i % L.cols) * (L.cellW + L.pad), y = L.top + L.pad + Math.floor(i / L.cols) * (L.cellH + L.pad);
      g.drawImage(f.src, x, y, L.cellW, L.cellH);
      if (info.stamps) {
        var label = fmtTS(f.t).replace(/\.(\d)\d\d$/, info.short ? ".$1" : ""); // tenths on short clips g.font = "600 12px " + font; g.textBaseline = "alphabetic";
        var tw = g.measureText(label).width;
        g.fillStyle = "rgba(0,0,0,.65)"; g.fillRect(x + L.cellW - tw - 14, y + L.cellH - 22, tw + 10, 18);
        g.fillStyle = "#fff"; g.fillText(label, x + L.cellW - tw - 9, y + L.cellH - 8);
      }
    });
    return c;
  }
  async function makeSheet() {
    if (!V || busy) return;
    busy = true; $("#makeSheet").disabled = true; video.pause();
    var n = S.count, times = evenTimes(n, video.duration), L = sheetLayout(n, +S.cols, +S.thumbW, video.videoWidth / video.videoHeight, S.header), frames = [], back = video.currentTime;
    try {
      for (var i = 0; i < n; i++) {
        $("#sheetProgress").textContent = "Capturing " + (i + 1) + " / " + n + "…";
        await seek(times[i]);
        var th = document.createElement("canvas"); th.width = L.cellW; th.height = L.cellH;
        th.getContext("2d").drawImage(video, 0, 0, L.cellW, L.cellH);
        frames.push({ src: th, t: times[i] });
        if (S.keep) caps.push(await grab(times[i]));
      }
      var sheet = drawSheet(frames, L, { stamps: S.stamps, short: video.duration < 60, title: V.name, sub: video.videoWidth + "×" + video.videoHeight + " · " + fmtTS(video.duration).replace(/\.\d+$/, "") + " · " + V.fps + " fps" + (V.size ? " · " + S3.fmtBytes(V.size) : "") + " · " + n + " frames" });
      sheetBlob = await new Promise(function (r) { sheet.toBlob(r, S.fmt, S.q / 100); });
      var img = $("#sheetImg"); if (img.src) URL.revokeObjectURL(img.src); img.src = URL.createObjectURL(sheetBlob);
      $("#sheetWrap").hidden = false; $("#sheetActions").hidden = false;
      $("#sheetProgress").textContent = L.W + " × " + L.H + " · " + S3.fmtBytes(sheetBlob.size);
      renderCaps(); S3.done();
    } catch (e) { $("#sheetProgress").textContent = ""; S3.toast("Couldn't build the sheet: " + (e && e.message || e), "error"); }
    await seek(back);
    busy = false; $("#makeSheet").disabled = false;
  }
  $("#makeSheet").addEventListener("click", makeSheet);
  $("#dlSheet").addEventListener("click", function () { if (sheetBlob) { S3.download(sheetBlob, baseName(V && V.name) + "_contact-sheet." + (EXT[sheetBlob.type] || "png")); S3.done(); } });

  // ---------- demo + self-test ----------
  function scene(g, t, W, H) {
    var grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, "hsl(" + (190 + t * 25) + ",60%,22%)"); grad.addColorStop(1, "hsl(" + (260 + t * 15) + ",55%,14%)");
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(255,255,255,.08)"; for (var i = 0; i < 6; i++) g.fillRect(0, H * 0.7 + i * 14, W, 6);
    g.fillStyle = "#f5c26b"; g.beginPath(); g.arc(W * 0.15 + W * 0.7 * (t / 3), H * 0.62 - Math.sin(t / 3 * Math.PI) * H * 0.4, H * 0.09, 0, 7); g.fill();
    g.fillStyle = "#3dd6d0"; g.fillRect(W * 0.08, H * 0.82, W * 0.84 * (t / 3), 8);
  }
  window.S3_DEMO = async function () {
    if (typeof MediaRecorder !== "function") return;
    var c = document.createElement("canvas"); c.width = 640; c.height = 360;
    var g = c.getContext("2d"), t0 = performance.now(), raf, stream = c.captureStream(30), chunks = [];
    (function draw() { scene(g, Math.min(3, (performance.now() - t0) / 1000), 640, 360); raf = requestAnimationFrame(draw); })();
    var r = new MediaRecorder(stream);
    r.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
    await new Promise(function (res) { r.onstop = res; r.start(); setTimeout(function () { r.stop(); }, 3100); });
    cancelAnimationFrame(raf); stream.getTracks().forEach(function (tr) { tr.stop(); });
    var blob = new Blob(chunks, { type: "video/webm" });
    if (!(await load(blob, "sunset-demo.webm"))) return;
    S.count = 8; S.cols = "4"; S.thumbW = "240"; S.keep = true; $("#count").value = 8; $("#cols").value = "4"; $("#thumbW").value = "240";
    await makeSheet();
    await seek(1.6);
  };

  window.S3_SELFTEST = async function () {
    var ok = frameIndex(1, 30) === 30 && frameIndex(0.999, 30) === 29 && frameIndex(1 / 3, 30) === 10 &&
      Math.abs(stepTime(1, 30, 1, 10) - 31.5 / 30) < 1e-9 && Math.abs(stepTime(1, 30, -1, 10) - 29.5 / 30) < 1e-9 &&
      Math.abs(stepTime(0, 25, -1, 10) - 0.02) < 1e-9 && Math.abs(stepTime(9.99, 25, 1, 10) - 9.98) < 1e-9;
    var et = evenTimes(4, 10); ok = ok && et.join() === "1.25,3.75,6.25,8.75";
    var L = sheetLayout(12, 0, 320, 16 / 9, true);
    ok = ok && L.cols === 4 && L.rows === 3 && L.cellH === 180 && L.W === 8 + 4 * 328 && L.H === 56 + 8 + 3 * 188;
    ok = ok && sheetLayout(3, 5, 200, 1, false).cols === 3 && autoCols(2) === 2 && autoCols(60) === 6;
    ok = ok && fmtTS(83.456) === "1:23.456" && fmtTS(3725.5) === "1:02:05.500" && stamp(83.456) === "1-23.456" && baseName('a/b:c.mp4') === "a-b-c" && baseName("") === "video";
    // capture pipeline: a known colour must come back pixel-exact from a PNG
    var src = document.createElement("canvas"); src.width = 64; src.height = 36;
    var g = src.getContext("2d"); g.fillStyle = "rgb(10,200,120)"; g.fillRect(0, 0, 64, 36);
    var png = await captureFrame(src, 64, 36, "image/png");
    var bmp = await createImageBitmap(png), chk = document.createElement("canvas"); chk.width = 64; chk.height = 36;
    var cg = chk.getContext("2d"); cg.drawImage(bmp, 0, 0); var px = cg.getImageData(32, 18, 1, 1).data;
    ok = ok && png.type === "image/png" && bmp.width === 64 && px[0] === 10 && px[1] === 200 && px[2] === 120;
    var z = new Uint8Array(await S3.zip([{ name: "f.png", data: new Uint8Array(await png.arrayBuffer()) }]).arrayBuffer());
    ok = ok && z[0] === 0x50 && z[1] === 0x4b && z[2] === 3 && z[3] === 4;
    // sheet canvas has the computed size
    var sh = drawSheet([{ src: src, t: 1 }, { src: src, t: 2 }], sheetLayout(2, 0, 64, 64 / 36, false), { stamps: true });
    ok = ok && sh.width === 8 + 2 * 72 && sh.height === 8 + 44;
    return ok;
  };
})();
