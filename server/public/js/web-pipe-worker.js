// The picture's path on transmitir.html, off the page's thread: each captured frame is redrawn on a GPU
// canvas (frames the hardware encoder takes, instead of the CPU-side ones the capture hands over), sized
// to the preset and capped to its fps, with the camera over it or the "já volto" card instead of it.
// The same as the app's pipeline (public/js/host.js), plus a slow redraw while the screen is still, so a
// friend who arrives then gets the picture at once and the encoder never sits idle for long.
'use strict';
let quality = { res: '1080', fps: 60 };
const BOX = { 720: [1280, 720], 1080: [1920, 1080] };
let away = false, card = null;
// The camera: the newest frame, replaced as the next one arrives. Layout: w is its width as a share of
// the picture's; x and y place it between the edges (0 = left or top, 1 = right or bottom)
let camFrame = null, camLayout = null, camReader = null, camRect = null, sentRect = '';
let canvas = null, ctx = null;
// The screen frame last read (kept to draw again under a new camera frame or while the screen is still)
let lastScreen = null, lastScreenAt = 0, lastTs = -Infinity;
let lastOutAt = 0, lastOutTs = -Infinity;
let screenReader = null;
const totals = { inFrames: 0, outFrames: 0, drawMs: 0, srcW: 0, srcH: 0, outW: 0, outH: 0 };
let statsAt = 0;

// Fits a 16:9 box whatever the shape: an ultrawide 2560x1080 goes as 1920x810, not 2560x1080
function targetSize(w, h) {
  const box = BOX[quality.res];
  if (!box || !w || !h) return { w: w || 1280, h: h || 720 };
  const s = Math.min(1, box[0] / w, box[1] / h);
  if (s >= 1) return { w, h };
  return { w: Math.max(2, Math.round(w * s / 2) * 2), h: Math.max(2, Math.round(h * s / 2) * 2) };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

function stopCam() {
  if (camReader) { camReader.cancel().catch(() => {}); camReader = null; }
  if (camFrame) { camFrame.close(); camFrame = null; }
}
async function readCam(readable) {
  stopCam();
  const reader = readable.getReader();
  camReader = reader;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (camReader !== reader) { value.close(); break; }
      if (camFrame) camFrame.close();
      camFrame = value;
      camTick();
    }
  } catch {}
}
// A still screen sends no frames and a game's capture can stall for a second: the camera would freeze
// with it. A new camera frame draws the last screen frame again when nothing else has been drawn lately.
function camTick() {
  if (!lastScreen || !ctx || !camLayout || (away && card)) return;
  const now = performance.now();
  if (now - lastOutAt < 20 || now - lastScreenAt < 50) return;
  render(lastScreen, null);
}

function drawCam(w, h) {
  camRect = null;
  if (!camFrame || !camLayout) return;
  const m = Math.round(h * 0.025);
  const aspect = camFrame.displayHeight / camFrame.displayWidth;
  let cw = Math.round(w * clamp(camLayout.w, 0.08, 0.9));
  if (cw * aspect > h - 2 * m) cw = Math.round((h - 2 * m) / aspect);
  const ch = Math.round(cw * aspect);
  const x = Math.round(m + clamp(camLayout.x, 0, 1) * Math.max(0, w - 2 * m - cw));
  const y = Math.round(m + clamp(camLayout.y, 0, 1) * Math.max(0, h - 2 * m - ch));
  camRect = [x / w, y / h, cw / w, ch / h];
  const r = Math.round(ch * 0.08);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, cw, ch, r);
  ctx.clip();
  ctx.drawImage(camFrame, x, y, cw, ch);
  ctx.restore();
  ctx.lineWidth = Math.max(2, Math.round(h / 360));
  ctx.strokeStyle = 'rgba(243, 248, 236, 0.85)';
  ctx.beginPath();
  ctx.roundRect(x, y, cw, ch, r);
  ctx.stroke();
}
function drawCard(w, h) {
  ctx.fillStyle = '#0B1A10';
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w / card.width, h / card.height);
  ctx.drawImage(card, (w - card.width * s) / 2, (h - card.height * s) / 2, card.width * s, card.height * s);
}

// One output frame: from a screen frame (new, or the last one again), or the card alone
function render(src, ts) {
  if (!ctx) return;
  const t0 = performance.now();
  const showCard = away && card;
  if (!src && !showCard) return;
  const { w, h } = src ? targetSize(src.displayWidth, src.displayHeight) : { w: canvas.width || 1280, h: canvas.height || 720 };
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingQuality = 'high';
  }
  if (showCard) {
    drawCard(w, h);
    camRect = null;
  } else {
    ctx.drawImage(src, 0, 0, w, h);
    drawCam(w, h);
  }
  const now = performance.now();
  // Always later than the previous frame, whichever path drew it
  const guess = lastOutTs + Math.round((now - lastOutAt) * 1000);
  const outTs = Math.max(ts == null ? guess : ts, lastOutTs + 1000);
  const out = new VideoFrame(canvas, { timestamp: outTs });
  lastOutTs = outTs;
  lastOutAt = now;
  totals.outFrames++;
  totals.drawMs += now - t0;
  if (src) { totals.srcW = src.displayWidth; totals.srcH = src.displayHeight; }
  totals.outW = w;
  totals.outH = h;
  self.postMessage({ frame: out }, [out]);
  const rectKey = camRect ? camRect.map(v => v.toFixed(4)).join() : '';
  if (rectKey !== sentRect) { sentRect = rectKey; self.postMessage({ camRect }); }
  if (now - statsAt > 1000) { statsAt = now; self.postMessage({ stats: { ...totals } }); }
}

// Draws again what viewers should see now (the card, the camera moved, back from the card): at once, or
// as soon as the fps allows (a drag sends more moves than frames)
let refreshTimer = null;
function refreshNow() {
  const wait = 1000 / quality.fps - (performance.now() - lastOutAt);
  if (wait > 1) {
    if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refreshNow(); }, wait);
    return;
  }
  if (away && card) render(null, null);
  else if (lastScreen) render(lastScreen, null);
}

// A still screen sends nothing: once a second the last picture goes again, so whoever arrives gets it
setInterval(() => {
  if (!ctx || performance.now() - lastOutAt < 1000) return;
  refreshNow();
}, 250);

async function readScreen(readable, width, height) {
  if (screenReader) screenReader.cancel().catch(() => {});
  const reader = readable.getReader();
  screenReader = reader;
  if (!canvas) {
    canvas = new OffscreenCanvas(width || 1280, height || 720);
    ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
  }
  lastTs = -Infinity;
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || screenReader !== reader) { if (frame) frame.close(); break; }
      totals.inFrames++;
      // The fps cap, with 15% slack so a 60 fps source isn't halved by capture jitter
      if (frame.timestamp - lastTs < (1e6 / quality.fps) * 0.85) { frame.close(); continue; }
      lastTs = frame.timestamp;
      if (lastScreen) lastScreen.close();
      lastScreen = frame;
      lastScreenAt = performance.now();
      // While the card is up the screen isn't drawn at all (the card goes again once a second)
      if (!(away && card)) render(frame, frame.timestamp);
    }
  } catch (err) {
    if (screenReader === reader) self.postMessage({ error: err.message });
  }
}

self.onmessage = (e) => {
  const d = e.data || {};
  if (d.quality) quality = d.quality;
  if ('card' in d) { if (card) card.close(); card = d.card || null; }
  if ('camLayout' in d) camLayout = d.camLayout;
  if ('cam' in d) { if (d.cam) readCam(d.cam); else stopCam(); }
  if ('away' in d) away = !!d.away;
  if (d.readable) { readScreen(d.readable, d.width, d.height); return; }
  if ('away' in d || 'card' in d || 'camLayout' in d || ('cam' in d && !d.cam)) refreshNow();
};
