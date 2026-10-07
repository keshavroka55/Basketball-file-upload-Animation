(() => {
  const $ = (id) => document.getElementById(id);
  const card = $('card'), file = $('file'), hint = $('hint'), dotsEl = $('dots');
  const dropzone = $('dropzone'), placeholder = $('placeholder'), list = $('list');
  const pill = $('pill'), countEl = $('count'), net = $('net'), picker = $('picker');

  /* ---------- Tuning ---------- */
  const G = 1500;          // gravity (px/s²)
  const POWER = 14;        // launch speed (px/s) per px of slingshot pull
  const MAX_PULL = 120;    // max slingshot stretch (px)
  const R = 10;            // collision radius of the file
  const REST = 0.5;        // bounce restitution
  const DRAG = 0.1;        // light air drag (1/s)
  const DT = 1 / 240;      // fixed physics step
  const HINT_NONE = 'Click the file to choose one from your device';
  const HINT_READY = 'Drag the file back & release to throw it';
  const HINT_NEED = 'Choose a file first, then throw it';
  const HINT_AIM = 'Release to shoot!';

  /* ---------- State ---------- */
  let W = 0, H = 0;
  let home = { x: 70, y: 470 };
  const rim = { x: 220, y: 316, hw: 38 };
  let state = 'idle'; // idle | aiming | flying | scoring | waiting
  const pos = { x: 0, y: 0 }, vel = { x: 0, y: 0 };
  let rot = 0, omega = 0, scale = 1, opacity = 1;
  let flightTime = 0, floorHits = 0, scoreStartY = 0, last = 0, raf = 0, acc = 0;
  let grab = { x: 0, y: 0 };
  let count = 2;

  /* ---------- Net drawing ---------- */
  (function buildNet() {
    const n = 8, topY = (x) => 62 + 7 * Math.sqrt(Math.max(0, 1 - ((x - 49) / 38) ** 2));
    const top = [], bot = [];
    for (let i = 0; i <= n; i++) {
      const x = 11 + (i * 76) / n;
      top.push([x, topY(x)]);
      bot.push([29 + (i * 40) / n, 118]);
    }
    let d = '';
    for (let i = 0; i <= n; i++) {
      if (i < n) d += `M${top[i][0]} ${top[i][1]}L${bot[i + 1][0]} ${bot[i + 1][1]}`;
      if (i > 0) d += `M${top[i][0]} ${top[i][1]}L${bot[i - 1][0]} ${bot[i - 1][1]}`;
    }
    [0.33, 0.66].forEach((t) => {
      const y = 62 + 56 * t, half = 38 - 18 * t;
      d += `M${49 - half} ${y + 3}Q49 ${y + 9} ${49 + half} ${y + 3}`;
    });
    d += 'M29 118Q49 123 69 118';
    net.innerHTML = `<path d="${d}"/>`;
  })();

  /* ---------- Sound (Web Audio, no files needed) ---------- */
  const audio = {
    ctx: null, on: true,
    unlock() {
      if (!this.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) this.ctx = new AC(); }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(f0, dur, { type = 'sine', vol = 0.08, delay = 0, f1 = f0 } = {}) {
      if (!this.on || !this.ctx) return;
      const t = this.ctx.currentTime + delay, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    },
    noise(dur, freq, vol = 0.1) {
      if (!this.on || !this.ctx) return;
      const len = Math.floor(this.ctx.sampleRate * dur), buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = this.ctx.createBufferSource(), flt = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
      src.buffer = buf; flt.type = 'bandpass'; flt.frequency.value = freq; g.gain.value = vol;
      src.connect(flt).connect(g).connect(this.ctx.destination);
      src.start();
    },
    shoot() { this.tone(260, 0.18, { type: 'triangle', vol: 0.06, f1: 620 }); },
    bounce(k = 1) { this.tone(170, 0.09, { type: 'triangle', vol: 0.12 * k + 0.02, f1: 90 }); },
    swish() { this.noise(0.4, 2200, 0.12); },
    success() {
      this.tone(660, 0.14, { vol: 0.07 });
      this.tone(880, 0.14, { vol: 0.07, delay: 0.1 });
      this.tone(1175, 0.22, { vol: 0.07, delay: 0.2 });
    },
  };

  $('soundBtn').addEventListener('click', (e) => {
    audio.unlock();
    audio.on = !audio.on;
    e.currentTarget.setAttribute('aria-pressed', audio.on);
    $('soundOn').toggleAttribute('hidden', !audio.on);
    $('soundOff').toggleAttribute('hidden', audio.on);
    if (audio.on) audio.tone(700, 0.1, { vol: 0.06 });
  });

  /* ---------- Layout / render ---------- */
  function measure() {
    const c = card.getBoundingClientRect(), a = $('rimAnchor').getBoundingClientRect();
    W = c.width; H = c.height;
    rim.x = a.left + a.width / 2 - c.left;
    rim.y = a.top + a.height / 2 - c.top;
    home = { x: Math.max(60, W * 0.16), y: H - 150 };
  }

  function render() {
    file.style.transform = `translate(${pos.x - 20}px, ${pos.y - 26}px) rotate(${rot}deg) scale(${scale})`;
    file.style.opacity = opacity;
  }

  function setHint(text) {
    if (hint.textContent === text) return;
    hint.classList.add('swap');
    setTimeout(() => { hint.textContent = text; hint.classList.remove('swap'); }, 150);
  }

  /* ---------- Trajectory preview dots ---------- */
  const DOTS = 22;
  const dotEls = Array.from({ length: DOTS }, () => dotsEl.appendChild(document.createElement('i')));

  function drawDots(vx, vy) {
    // integrate with the exact same physics as the flight (minus collisions)
    let x = pos.x, y = pos.y;
    const h = 1 / 120, every = 6;
    let n = 0;
    for (let i = 1; n < DOTS && i < 400; i++) {
      vy += G * h; vx *= 1 - DRAG * h; vy *= 1 - DRAG * h;
      x += vx * h; y += vy * h;
      if (i % every) continue;
      const el = dotEls[n];
      el.style.transform = `translate(${x}px, ${y}px) scale(${1 - n * 0.025})`;
      el.style.opacity = y > H - 30 ? 0 : Math.max(0.15, 0.95 - n * 0.05);
      n++;
    }
  }
  const hideDots = () => dotEls.forEach((el) => (el.style.opacity = 0));

  /* ---------- Choose a file, then throw it ----------
     1) Click the file  -> your device's file picker opens, pick a file.
     2) Press the file, drag back and release (slingshot) to throw it.
     A file must be chosen before it can be thrown. When it scores, that file is "uploaded". */
  const local = (e) => { const c = card.getBoundingClientRect(); return { x: e.clientX - c.left, y: e.clientY - c.top }; };

  const extEl = $('fileExt'), nameEl = $('fileName');
  let chosen = null;       // { name, size } of the file picked from the device
  let press = null;        // pointer-down info on the file
  let dragged = false;     // true if the last press turned into a drag (so no picker)
  const idleHint = () => (chosen ? HINT_READY : HINT_NONE);

  function paintFile() {
    if (chosen) {
      const ext = (chosen.name.includes('.') ? chosen.name.split('.').pop() : 'file').slice(0, 4).toUpperCase();
      extEl.textContent = ext;
      extEl.setAttribute('font-size', ext.length > 3 ? 5.2 : 6.5);
      nameEl.textContent = chosen.name;
    } else {
      extEl.textContent = 'PDF';
      extEl.setAttribute('font-size', 6.5);
      nameEl.textContent = 'Click to choose a file';
    }
    nameEl.classList.toggle('set', !!chosen);
    file.classList.toggle('has-file', !!chosen);
  }

  function setThrowFile(f) {
    chosen = { name: f.name, size: f.size };
    paintFile();
    file.classList.remove('picked'); void file.offsetWidth; file.classList.add('picked');
    audio.tone(660, 0.12, { vol: 0.06 });
    if (state === 'idle') setHint(idleHint());
  }

  function nudge() {   // tried to throw without choosing a file
    file.classList.remove('shake'); void file.offsetWidth; file.classList.add('shake');
    setHint(HINT_NEED);
    clearTimeout(nudge.t);
    nudge.t = setTimeout(() => { if (state === 'idle') setHint(idleHint()); }, 1800);
  }

  function launch(vx, vy) {
    hideDots();
    file.classList.remove('grabbing', 'snap');
    file.classList.add('flying');
    scale = 1;
    vel.x = vx; vel.y = vy;
    omega = vx * 0.12;
    flightTime = 0; floorHits = 0; acc = 0;
    state = 'flying';
    audio.shoot();
    last = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function aim(e) {
    const p = local(e);
    let dx = p.x - grab.x, dy = p.y - grab.y;      // how far the pointer moved since grabbing
    const d = Math.hypot(dx, dy);
    if (d > MAX_PULL) { dx *= MAX_PULL / d; dy *= MAX_PULL / d; }
    pos.x = home.x + dx; pos.y = home.y + dy;
    rot = dx * 0.12;
    render();
    drawDots(-dx * POWER, -dy * POWER);
  }

  function release() {
    if (state !== 'aiming') return;
    file.classList.remove('grabbing');
    const dx = home.x - pos.x, dy = home.y - pos.y;
    if (Math.hypot(dx, dy) < 14) {            // tiny pull = cancel
      hideDots();
      file.classList.add('snap');
      pos.x = home.x; pos.y = home.y; rot = 0; render();
      state = 'idle'; setHint(idleHint());
      return;
    }
    launch(dx * POWER, dy * POWER);
  }

  file.addEventListener('pointerdown', (e) => {
    if (state !== 'idle') return;
    e.preventDefault();
    audio.unlock();
    file.setPointerCapture(e.pointerId);
    file.classList.remove('snap');
    press = { x: e.clientX, y: e.clientY, drag: false };
    dragged = false;
    grab = local(e);
  });
  file.addEventListener('pointermove', (e) => {
    if (!press) return;
    if (!press.drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) {
      dragged = true;
      if (!chosen) { press = null; nudge(); return; }      // no file chosen -> can't throw
      press.drag = true; state = 'aiming';
      file.classList.add('grabbing'); setHint(HINT_AIM);
    }
    if (press && press.drag) aim(e);
  });
  ['pointerup', 'pointercancel'].forEach((ev) => file.addEventListener(ev, () => {
    if (!press) return;
    const wasDrag = press.drag; press = null;
    if (wasDrag) release();
  }));

  // a plain click (no drag) opens the device's file picker
  file.addEventListener('click', () => {
    if (dragged) { dragged = false; return; }
    if (state === 'idle') picker.click();
  });
  file.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && state === 'idle') { e.preventDefault(); picker.click(); }
  });

  /* ---------- Physics ---------- */
  function collidePoint(px, py) {
    const dx = pos.x - px, dy = pos.y - py, d = Math.hypot(dx, dy), r = R + 3;
    if (d < r && d > 0) {
      const nx = dx / d, ny = dy / d, vn = vel.x * nx + vel.y * ny;
      pos.x += nx * (r - d); pos.y += ny * (r - d);
      if (vn < 0) {
        vel.x -= (1 + REST) * vn * nx; vel.y -= (1 + REST) * vn * ny;
        omega = -omega * 0.7 + nx * 90;
        audio.bounce(Math.min(1, -vn / 700));
      }
    }
  }

  function step(h) {
    const prevY = pos.y;
    vel.y += G * h;
    vel.x *= 1 - DRAG * h; vel.y *= 1 - DRAG * h;
    pos.x += vel.x * h; pos.y += vel.y * h;
    rot += omega * h;

    if (state === 'scoring') return;

    if (pos.x < R) { pos.x = R; vel.x = -vel.x * 0.6; audio.bounce(0.4); }
    if (pos.x > W - R) { pos.x = W - R; vel.x = -vel.x * 0.6; audio.bounce(0.4); }

    // the file flies in front of the backboard, so only the rim is solid
    collidePoint(rim.x - rim.hw, rim.y);                    // rim edges
    collidePoint(rim.x + rim.hw, rim.y);

    if (prevY < rim.y && pos.y >= rim.y && vel.y > 0 && Math.abs(pos.x - rim.x) < rim.hw - 6) {
      score();
      return;
    }

    const floor = H - 46;
    if (pos.y > floor) {
      pos.y = floor;
      if (Math.abs(vel.y) > 120) audio.bounce(0.5);
      vel.y = -vel.y * 0.45; vel.x *= 0.8; omega *= 0.6;
      floorHits++;
    }
  }

  function loop(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    flightTime += dt;

    acc += dt;
    while (acc >= DT && state !== 'waiting') { step(DT); acc -= DT; }

    if (state === 'scoring') {
      vel.x *= 0.92;
      const s = Math.min(1, (pos.y - scoreStartY) / 80);
      scale = 1 - 0.6 * s;
      opacity = 1 - s;
      if (s >= 1) { opacity = 0; render(); respawn(450); return; }
    } else if (state === 'flying') {
      const resting = floorHits > 0 && Math.abs(vel.y) < 80 && Math.abs(vel.x) < 40;
      if (flightTime > 3.4 || floorHits >= 3 || resting) { respawn(350); render(); return; }
    }

    render();
    if (state === 'flying' || state === 'scoring') raf = requestAnimationFrame(loop);
  }

  /* ---------- Score + respawn ---------- */
  function score() {
    state = 'scoring';
    scoreStartY = pos.y;
    vel.x *= 0.25;
    vel.y = Math.max(vel.y, 260);
    omega *= 0.3;
    audio.swish();
    setTimeout(() => audio.success(), 120);
    net.classList.remove('wobble'); void net.getBoundingClientRect(); net.classList.add('wobble');
    const f = chosen || { name: 'document.pdf', size: 2.4 * 1024 * 1024 };
    chosen = null;                       // used up: choose another file for the next throw
    addUpload(f.name, f.size);
  }

  function respawn(delay) {
    state = 'waiting';
    cancelAnimationFrame(raf);
    setTimeout(() => {
      file.classList.remove('flying');
      paintFile();
      file.classList.add('snap');
      pos.x = home.x; pos.y = home.y; rot = 0; omega = 0; scale = 0.5; opacity = 0;
      render();
      requestAnimationFrame(() => requestAnimationFrame(() => { scale = 1; opacity = 1; render(); }));
      setTimeout(() => { state = 'idle'; setHint(idleHint()); }, 360);
    }, delay);
  }

  /* ---------- Upload items (simulated progress) ---------- */
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  function addUpload(name, bytes) {
    const ext = (name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
    const el = document.createElement('div');
    el.className = 'upload-item';
    el.innerHTML = `
      <div class="row"><span class="badge"></span><span class="name"></span><span class="pct">0%</span></div>
      <div class="bar"><i></i></div>
      <div class="row meta"><span class="status">Uploading file...</span><span class="size"></span></div>`;
    el.querySelector('.badge').textContent = ext;
    el.querySelector('.name').textContent = name;
    el.querySelector('.size').textContent = fmtSize(bytes);
    list.prepend(el);
    placeholder.hidden = true;

    while (list.children.length > 2) removeItem(list.lastElementChild, true);

    const bar = el.querySelector('.bar i'), pct = el.querySelector('.pct'), status = el.querySelector('.status');
    const dur = 2200 + Math.random() * 600, t0 = performance.now() + 250;
    (function tick(now) {
      if (!el.isConnected) return;
      const p = Math.min(1, Math.max(0, (now - t0) / dur));
      const eased = 1 - Math.pow(1 - p, 1.6);
      bar.style.width = eased * 100 + '%';
      pct.textContent = Math.round(eased * 100) + '%';
      if (p < 1) return requestAnimationFrame(tick);
      el.classList.add('done');
      pct.textContent = 'Done';
      status.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg> File uploaded successfully';
      bumpCount();
      setTimeout(() => removeItem(el), 3200);
    })(performance.now());
  }

  function removeItem(el, instant) {
    if (!el || !el.isConnected) return;
    const kill = () => { el.remove(); if (!list.children.length) placeholder.hidden = false; };
    if (instant) return kill();
    el.classList.add('leaving');
    setTimeout(kill, 300);
  }

  function bumpCount() {
    countEl.textContent = ++count;
    pill.classList.add('hot');
    clearTimeout(bumpCount.t);
    bumpCount.t = setTimeout(() => pill.classList.remove('hot'), 2200);
  }

  /* ---------- Real file drop / browse (bonus) ---------- */
  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('over'); }));
  dropzone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  dropzone.addEventListener('click', () => { if (state === 'idle') picker.click(); });
  picker.addEventListener('change', () => {
    const f = picker.files[0];
    picker.value = '';
    if (f) setThrowFile(f);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  function handleFiles(files) {
    [...files].slice(0, 2).forEach((f, i) => setTimeout(() => addUpload(f.name, f.size), i * 350));
  }

  /* ---------- Init ---------- */
  function init() {
    measure();
    paintFile();
    if (state === 'idle') { pos.x = home.x; pos.y = home.y; rot = 0; scale = 1; opacity = 1; render(); }
  }
  window.addEventListener('resize', init);
  window.addEventListener('load', init);
  init();
})();
