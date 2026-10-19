// Player extras on the viewer page: reactions, who's watching (and your name), the floating window,
// zoom, prints and clips, cinema mode, keyboard shortcuts, the "why is it stuttering" note and the
// frogs that light up while their stream has sound. Runs on what room.js sets up (same page scope).
(function () {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const live = () => body.dataset.state === 'live';

  // ---------- Popovers: one open at a time; a click elsewhere or Esc closes them ----------
  const pops = {
    react: { btn: $('btn-react'), pop: $('react-tray') },
    more: { btn: $('btn-more'), pop: $('more-menu') },
    viewers: { btn: $('btn-viewers'), pop: $('viewers-pop') }
  };
  function setOpen(entry, open) {
    entry.pop.hidden = !open;
    entry.btn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    for (const other of Object.values(pops)) if (other !== entry && !other.pop.hidden) setOpen(other, false);
    entry.onOpen?.();
    window.keepPlayerBar?.();
  }
  for (const entry of Object.values(pops)) {
    entry.btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(entry, entry.pop.hidden); });
    entry.pop.addEventListener('click', (e) => e.stopPropagation());
  }
  const closeAll = () => { for (const p of Object.values(pops)) if (!p.pop.hidden) setOpen(p, false); };
  document.addEventListener('click', closeAll);

  // ---------- Files: prints and clips land in the downloads folder ----------
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const pad = (n) => String(n).padStart(2, '0');
  function fileStamp() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}`;
  }
  // The streamer's name as a file-name piece ("Igão!" -> "igao")
  function who() {
    const name = infoFor(selectedId)?.name || 'transmissao';
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'transmissao';
  }

  // ---------- Extras show only with a picture on stage ----------
  const extras = $('player-extras');
  const moreWrap = $('more-wrap');
  function renderExtras() {
    extras.hidden = !live();
    moreWrap.hidden = !live();
    if (!live()) {
      setOpen(pops.react, false);
      setOpen(pops.more, false);
      exitZoom();
    } else {
      setTimeout(maybeCallout, 4000);
    }
    syncClips();
  }
  new MutationObserver(renderExtras).observe(body, { attributes: true, attributeFilter: ['data-state'] });

  // ---------- Reactions ----------
  const EMOJIS = ['🔥', '😂', '👏', '😮', '🐸', '❤️'];
  const tray = $('react-tray');
  const layer = $('reaction-layer');
  // Same pace the server allows (6 every 4 s), so what floats here is what the others see
  const sentAt = [];
  for (const emoji of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'react-btn';
    b.textContent = emoji;
    b.setAttribute('aria-label', 'Reagir com ' + emoji);
    b.addEventListener('click', () => {
      const now = Date.now();
      while (sentAt.length && now - sentAt[0] > 4000) sentAt.shift();
      if (sentAt.length >= 6) { b.classList.remove('nope'); void b.offsetWidth; b.classList.add('nope'); return; }
      if (!sendReaction(emoji)) return;
      sentAt.push(now);
      floatReaction(emoji, 'Você', true);
    });
    tray.append(b);
  }

  function floatReaction(emoji, name, mine) {
    if (!live()) return;
    while (layer.childElementCount >= 14) layer.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'reaction' + (mine ? ' mine' : '');
    // Spread out, so a burst from several people doesn't pile up on one spot
    el.style.setProperty('--x', (5 + Math.random() * 30).toFixed(1) + '%');
    el.style.setProperty('--drift', Math.round((Math.random() - 0.5) * 80) + 'px');
    el.style.bottom = Math.round(64 + Math.random() * 56) + 'px';
    el.style.animationDelay = Math.round(Math.random() * 140) + 'ms';
    el.append(
      Object.assign(document.createElement('span'), { className: 'reaction-emoji', textContent: emoji }),
      Object.assign(document.createElement('span'), { className: 'reaction-name', textContent: name })
    );
    layer.append(el);
    el.addEventListener('animationend', () => el.remove());
    // With reduced motion there's no animation to end
    setTimeout(() => el.remove(), 4500);
  }
  document.addEventListener('fs-reaction', (e) => {
    const r = e.detail;
    if (!r.mine && EMOJIS.includes(r.emoji)) floatReaction(r.emoji, r.name || 'Sapo', false);
  });

  // ---------- Who's watching, and your name ----------
  const nameInput = $('viewer-name');
  function renderViewerNames() {
    const list = $('viewer-names');
    const names = viewerNames.slice();
    const me = names.indexOf(viewerName);
    if (me > 0) { names.splice(me, 1); names.unshift(viewerName); }
    const items = names.map(n => {
      const li = document.createElement('li');
      li.textContent = n;
      if (n === viewerName) li.append(Object.assign(document.createElement('span'), { className: 'viewer-you', textContent: 'você' }));
      return li;
    });
    const total = parseInt(viewerCount.textContent, 10) || names.length;
    if (total > names.length) items.push(Object.assign(document.createElement('li'), { className: 'viewer-more', textContent: `e mais ${total - names.length}` }));
    if (!items.length) items.push(Object.assign(document.createElement('li'), { className: 'viewer-more', textContent: 'Ninguém por aqui ainda' }));
    list.replaceChildren(...items);
  }
  pops.viewers.onOpen = () => { nameInput.value = viewerName; renderViewerNames(); };
  document.addEventListener('fs-room-update', () => { if (!pops.viewers.pop.hidden) renderViewerNames(); });
  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!setViewerName(nameInput.value)) { nameInput.focus(); return; }
    showToast(`Pronto, agora você aparece como ${viewerName}.`);
    setOpen(pops.viewers, false);
    hideCallout();
  });

  // Once: the first stream watched here while the name is still the automatic "Sapo 123"
  const callout = $('name-callout');
  const CALLOUT_KEY = 'fs-name-callout';
  let calloutTimer = null;
  function hideCallout() {
    callout.hidden = true;
    clearTimeout(calloutTimer);
    storage.set(CALLOUT_KEY, '1');
  }
  function maybeCallout() {
    if (!live() || !callout.hidden || storage.get(VIEWER_NAME_SET_KEY) === '1' || storage.get(CALLOUT_KEY) === '1') return;
    callout.hidden = false;
    calloutTimer = setTimeout(() => { callout.hidden = true; }, 15000);
  }
  $('btn-name-callout').addEventListener('click', (e) => {
    e.stopPropagation();
    hideCallout();
    setOpen(pops.viewers, true);
    nameInput.focus();
    nameInput.select();
  });
  $('btn-name-callout-close').addEventListener('click', (e) => { e.stopPropagation(); hideCallout(); });

  // ---------- Menu: data saver, levelled sound, clips ----------
  const optSaver = $('opt-data-saver');
  const optLevel = $('opt-levelling');
  const optClips = $('opt-clips');
  optSaver.checked = dataSaver;
  optLevel.checked = audioFx.levelling;
  function renderSaverHint() {
    const viaServer = !!channels.get(selectedId)?.pc?.isSfu;
    $('data-saver-hint').textContent = viaServer
      ? 'Com muita gente na sala, todos recebem a mesma imagem: isto passa a valer quando a sala esvaziar.'
      : 'Imagem menor, uns 0,5 GB por hora em vez de até 5 GB. Bom no 4G.';
  }
  pops.more.onOpen = renderSaverHint;
  optSaver.addEventListener('change', () => {
    setDataSaver(optSaver.checked);
    showToast(optSaver.checked ? 'Economizando dados: a imagem fica menor para gastar menos.' : 'Qualidade normal de novo.');
  });
  optLevel.addEventListener('change', () => {
    setLevelling(optLevel.checked);
    showToast(optLevel.checked ? 'Volume equilibrado: explosões mais baixas, vozes mais claras.' : 'Som original de novo.');
  });

  // ---------- Clips: the last half minute or so, saved on demand ----------
  // MediaRecorder can't cut the start off a recording, so two recorders run half a minute apart and each
  // starts over every minute: the older one always holds at least the last 30 s (and at most a minute).
  const CLIPS_KEY = 'fs-clips';
  const CLIP_PERIOD = 60000;
  const clip = { slots: [], stream: null, mime: '', timer: null, lateStart: null };
  const btnClip = $('btn-clip');
  optClips.checked = !isTouch && storage.get(CLIPS_KEY) === '1';
  optClips.addEventListener('change', () => {
    storage.set(CLIPS_KEY, optClips.checked ? '1' : '0');
    syncClips();
    if (optClips.checked && clip.stream) showToast('Clipes ligados: o botão do relógio (ou a tecla C) salva os últimos segundos.');
  });

  function clipMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const m of ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return '';
  }

  function startSlot(slot) {
    if (!clip.stream) return;
    let rec;
    try {
      rec = new MediaRecorder(clip.stream, { mimeType: clip.mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 128000 });
    } catch (err) {
      reportError('Clip recorder failed: ' + err.message);
      showToast('Este navegador não conseguiu gravar clipes.');
      optClips.checked = false;
      return stopClips();
    }
    const chunks = [];
    Object.assign(slot, { rec, chunks, startedAt: Date.now(), save: false, restart: false });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      if (slot.save) saveClipFile(new Blob(chunks, { type: clip.mime.split(';')[0] }), Date.now() - slot.startedAt);
      if (slot.rec === rec) slot.rec = null;
      if (slot.restart && clip.stream) startSlot(slot);
    };
    rec.start(1000);
  }

  function restartSlot(slot, save) {
    if (!slot.rec) return startSlot(slot);
    slot.save = save;
    slot.restart = true;
    try { slot.rec.stop(); } catch { startSlot(slot); }
  }

  function stopClips() {
    clearInterval(clip.timer);
    clearTimeout(clip.lateStart);
    for (const s of clip.slots) {
      s.restart = false;
      s.save = false;
      try { s.rec?.stop(); } catch {}
    }
    clip.slots = [];
    clip.stream = null;
    btnClip.hidden = true;
  }

  function syncClips() {
    const want = optClips.checked && !isTouch && live() && remoteVideo.srcObject;
    const stream = want ? remoteVideo.srcObject : null;
    if (stream && stream === clip.stream) return;
    stopClips();
    if (!stream) return;
    clip.mime = clipMime();
    if (!clip.mime) {
      optClips.checked = false;
      showToast('Este navegador não grava clipes.');
      return;
    }
    clip.stream = stream;
    clip.slots = [{}, {}];
    startSlot(clip.slots[0]);
    clip.lateStart = setTimeout(() => startSlot(clip.slots[1]), CLIP_PERIOD / 2);
    clip.timer = setInterval(() => {
      for (const s of clip.slots) if (s.rec && !s.save && Date.now() - s.startedAt >= CLIP_PERIOD) restartSlot(s, false);
    }, 1000);
    btnClip.hidden = false;
  }
  // A new stream on stage (another streamer, a reconnect) starts the recorders over
  remoteVideo.addEventListener('loadedmetadata', syncClips);
  remoteVideo.addEventListener('emptied', syncClips);

  function saveClip() {
    if (!clip.stream) { showToast('Ligue "Clipes" no menu ⋯ para poder salvar os últimos segundos.'); return; }
    const slot = clip.slots.filter(s => s.rec && !s.save).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!slot || Date.now() - slot.startedAt < 3000) { showToast('O clipe ainda está começando. Tente de novo em alguns segundos.'); return; }
    showToast('Salvando o clipe…');
    restartSlot(slot, true);
  }
  function saveClipFile(blob, ms) {
    download(blob, `frogshare-clipe-${who()}-${fileStamp()}.${/mp4/.test(blob.type) ? 'mp4' : 'webm'}`);
    showToast(`Clipe salvo (${Math.round(ms / 1000)} s) nos seus downloads.`);
  }
  btnClip.addEventListener('click', saveClip);

  // ---------- Print ----------
  function flash() {
    const el = Object.assign(document.createElement('div'), { className: 'camera-flash' });
    videoArea.append(el);
    el.addEventListener('animationend', () => el.remove());
    setTimeout(() => el.remove(), 800);
  }
  async function takePrint() {
    if (!live() || !remoteVideo.videoWidth) { showToast('Ainda não tem imagem para salvar.'); return; }
    const c = document.createElement('canvas');
    c.width = remoteVideo.videoWidth;
    c.height = remoteVideo.videoHeight;
    c.getContext('2d').drawImage(remoteVideo, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    if (!blob) { showToast('Não deu para salvar o print.'); return; }
    flash();
    download(blob, `frogshare-print-${who()}-${fileStamp()}.png`);
    let copied = false;
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        copied = true;
      }
    } catch {}
    showToast(copied ? 'Print salvo e copiado: é só colar no Discord.' : 'Print salvo nos seus downloads.');
  }
  $('btn-print').addEventListener('click', takePrint);

  // ---------- Floating window (picture in picture) ----------
  const btnPip = $('btn-pip');
  const pipOk = !!document.pictureInPictureEnabled && typeof remoteVideo.requestPictureInPicture === 'function';
  btnPip.hidden = !pipOk;
  async function togglePip() {
    if (!pipOk) { showToast('Este navegador não tem janelinha flutuante.'); return; }
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (live()) await remoteVideo.requestPictureInPicture();
    } catch (err) {
      showToast('Não deu para abrir a janelinha: ' + err.message);
    }
  }
  btnPip.addEventListener('click', togglePip);
  remoteVideo.addEventListener('enterpictureinpicture', () => {
    btnPip.setAttribute('aria-pressed', 'true');
    $('pip-note').hidden = false;
  });
  remoteVideo.addEventListener('leavepictureinpicture', () => {
    btnPip.setAttribute('aria-pressed', 'false');
    $('pip-note').hidden = true;
  });
  $('btn-pip-back').addEventListener('click', () => { document.exitPictureInPicture?.().catch(() => {}); });
  // The stream ended: a floating window showing nothing would just sit there
  remoteVideo.addEventListener('emptied', () => {
    if (document.pictureInPictureElement === remoteVideo && !remoteVideo.srcObject) document.exitPictureInPicture().catch(() => {});
  });

  // ---------- Zoom: Ctrl + wheel or a pinch, drag to move around ----------
  const zoom = { s: 1, x: 0, y: 0 };
  const zoomChip = $('zoom-chip');
  function applyZoom() {
    const on = zoom.s > 1.001;
    remoteVideo.style.transformOrigin = '0 0';
    remoteVideo.style.transform = on ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` : '';
    videoArea.classList.toggle('zoomed', on);
    zoomChip.hidden = !on;
    if (on) zoomChip.textContent = `${zoom.s.toFixed(1).replace('.', ',')}× · ${isTouch ? 'toque para voltar' : 'Z volta ao normal'}`;
  }
  function clampPan() {
    const w = videoArea.clientWidth, h = videoArea.clientHeight;
    zoom.x = Math.min(0, Math.max(w - w * zoom.s, zoom.x));
    zoom.y = Math.min(0, Math.max(h - h * zoom.s, zoom.y));
  }
  // Keeps the point under (px, py) where it is while the scale changes
  function zoomAt(px, py, s) {
    s = Math.min(5, Math.max(1, s));
    const cx = (px - zoom.x) / zoom.s, cy = (py - zoom.y) / zoom.s;
    zoom.s = s;
    zoom.x = px - cx * s;
    zoom.y = py - cy * s;
    if (s <= 1.001) Object.assign(zoom, { s: 1, x: 0, y: 0 });
    clampPan();
    applyZoom();
  }
  function exitZoom() {
    Object.assign(zoom, { s: 1, x: 0, y: 0 });
    applyZoom();
  }
  const areaPoint = (e) => {
    const r = videoArea.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  videoArea.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !live()) return;
    e.preventDefault();
    const [px, py] = areaPoint(e);
    zoomAt(px, py, zoom.s * Math.exp(-e.deltaY * 0.0025));
  }, { passive: false });

  const pointers = new Map();
  let pan = null, pinch = null;
  remoteVideo.addEventListener('pointerdown', (e) => {
    if (!live()) return;
    pointers.set(e.pointerId, areaPoint(e));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), s: zoom.s };
      pan = null;
    } else if (zoom.s > 1.001) {
      pan = { x: e.clientX, y: e.clientY, zx: zoom.x, zy: zoom.y };
    }
    try { remoteVideo.setPointerCapture(e.pointerId); } catch {}
  });
  remoteVideo.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, areaPoint(e));
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, pinch.s * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d);
    } else if (pan) {
      zoom.x = pan.zx + (e.clientX - pan.x);
      zoom.y = pan.zy + (e.clientY - pan.y);
      clampPan();
      applyZoom();
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) pan = null;
  };
  remoteVideo.addEventListener('pointerup', endPointer);
  remoteVideo.addEventListener('pointercancel', endPointer);
  $('btn-zoom').addEventListener('click', () => {
    const next = zoom.s < 1.5 ? 2 : zoom.s < 2.5 ? 3 : 1;
    if (next === 1) exitZoom();
    else zoomAt(videoArea.clientWidth / 2, videoArea.clientHeight / 2, next);
  });
  zoomChip.addEventListener('click', exitZoom);
  new ResizeObserver(() => { clampPan(); applyZoom(); }).observe(videoArea);
  // Another stream on stage starts at normal size
  remoteVideo.addEventListener('emptied', exitZoom);

  // ---------- Cinema mode: only the video, without leaving the window ----------
  const CINEMA_KEY = 'fs-cinema';
  const btnCinema = $('btn-cinema');
  function setCinema(on) {
    body.classList.toggle('cinema', on);
    btnCinema.setAttribute('aria-pressed', String(on));
    storage.set(CINEMA_KEY, on ? '1' : '0');
  }
  btnCinema.addEventListener('click', () => setCinema(!body.classList.contains('cinema')));
  if (!isTouch && storage.get(CINEMA_KEY) === '1') setCinema(true);

  // ---------- Keyboard shortcuts ----------
  const shortcuts = $('shortcuts');
  function openShortcuts() {
    // In fullscreen only the video area is drawn, so the list goes inside it
    (document.fullscreenElement || document.body).append(shortcuts);
    shortcuts.hidden = false;
    $('btn-shortcuts-close').focus();
  }
  const closeShortcuts = () => { shortcuts.hidden = true; };
  $('btn-shortcuts').addEventListener('click', (e) => { e.stopPropagation(); setOpen(pops.more, false); openShortcuts(); });
  $('btn-shortcuts-close').addEventListener('click', closeShortcuts);
  shortcuts.addEventListener('click', (e) => { if (e.target === shortcuts) closeShortcuts(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!shortcuts.hidden) closeShortcuts();
      else if (Object.values(pops).some(p => !p.pop.hidden)) closeAll();
      else if (body.classList.contains('cinema') && !document.fullscreenElement) setCinema(false);
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '?') { e.preventDefault(); if (shortcuts.hidden) openShortcuts(); else closeShortcuts(); return; }
    if (!live()) return;
    const k = e.key.toLowerCase();
    if (k === 't' && !isTouch) setCinema(!body.classList.contains('cinema'));
    else if (k === 'j') togglePip();
    else if (k === 'p') takePrint();
    else if (k === 'c') saveClip();
    else if (k === 'z') exitZoom();
    else return;
    e.preventDefault();
  });

  // ---------- Why it stutters ----------
  const bubble = $('diag-bubble');
  const shownAt = new Map();
  let bubbleTimer = null;
  document.addEventListener('fs-diag', (e) => {
    const { level, reason, text } = e.detail;
    bubble.dataset.level = level;
    if (level === 'ok') { bubble.hidden = true; return; }
    $('diag-text').textContent = text;
    // The info panel already says it at the top
    if (infoOpen) { bubble.hidden = true; return; }
    // Each explanation pops up at most every 3 minutes; meanwhile the info button keeps a dot
    if (!bubble.hidden || Date.now() - (shownAt.get(reason) || 0) < 180000) return;
    shownAt.set(reason, Date.now());
    bubble.hidden = false;
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => { bubble.hidden = true; }, 12000);
  });
  $('diag-close').addEventListener('click', () => { bubble.hidden = true; });

  // ---------- Frogs light up while their stream has sound (group rooms) ----------
  const smoothed = new Map();
  setInterval(() => {
    if (document.hidden || !body.classList.contains('has-stream-list')) return;
    for (const ch of channels.values()) {
      const level = channelLevel(ch.hostId);
      const value = Math.max(level || 0, (smoothed.get(ch.hostId) || 0) * 0.75);
      smoothed.set(ch.hostId, value);
      const speaking = level != null && value > 0.02 && !ch.muted;
      for (const el of document.querySelectorAll(`[data-host-id="${CSS.escape(ch.hostId)}"]`)) el.classList.toggle('speaking', speaking);
    }
  }, 160);

  renderExtras();
})();
