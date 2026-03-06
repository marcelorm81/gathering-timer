// === CONFIG ===
const NAMES = ['Shane', 'David', 'Miriam', 'Miguel', 'Andros', 'Lia', 'Greta', 'Jonas', 'Chris', 'Marcelo', 'Petter'];
const SLOT_MIN = 5;
const SESSION_MIN = 90;
const MAX_SLOTS = SESSION_MIN / SLOT_MIN;

// === AUDIO ===
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function beep(freq, ms, wave = 'sine', vol = 0.25) {
  const ac = getAudioCtx();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = wave;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + ms / 1000);
  osc.connect(gain).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + ms / 1000);
}

const sound = {
  tick:    () => beep(1200, 30, 'sine', 0.06),
  select:  () => { beep(600, 150); setTimeout(() => beep(900, 250), 150); },
  warning: () => { beep(880, 150); setTimeout(() => beep(880, 150), 200); setTimeout(() => beep(880, 150), 400); },
  done:    () => { beep(523, 200, 'square', 0.15); setTimeout(() => beep(659, 200, 'square', 0.15), 200); setTimeout(() => beep(784, 400, 'square', 0.15), 400); }
};

// === HAPTICS (web-haptics library — works on iOS Safari) ===
const haptics = {
  startBuzz() {
    const wh = window.__haptics;
    if (!wh) return;
    wh.trigger([{ duration: 2500, intensity: 1 }]);
  },
  stop() {
    const wh = window.__haptics;
    if (!wh) return;
    wh.cancel();
  },
  success() {
    const wh = window.__haptics;
    if (!wh) return;
    wh.trigger('success');
  },
  tap() {
    const wh = window.__haptics;
    if (!wh) return;
    wh.trigger('medium');
  }
};

// === STATE ===
let pool = [];
let queue = [];
let spinning = false;
let wheelAngleDeg = 0;

let timerIdx = 0;
let timerSec = 0;
let timerRef = null;
let paused = false;
let warned = false;
let deadlineMs = 0;   // wall-clock timestamp when timer hits 0
let pausedRemaining = 0; // ms remaining when paused

// === DOM ===
const $ = id => document.getElementById(id);
const canvas = $('wheel-canvas');
const c = canvas.getContext('2d');
const spinBtn   = $('spin-btn');
const spinInfo  = $('spin-info');
const listEl    = $('presenter-list');
const timeEl    = $('queue-time');
const startBtn  = $('start-btn');
const resetBtn  = $('reset-btn');
const overlay   = $('presentation-overlay');
const nameEl    = $('current-presenter-name');
const timerTextEl = $('timer-text');
const statusEl  = $('timer-status');
const progressBar = $('timer-progress-bar');
const skipBtn   = $('skip-btn');
const pauseBtn  = $('pause-btn');
const stopBtn   = $('stop-btn');
const nextBtn   = $('next-btn');
const nextEl    = $('up-next');
const timesUpCanvas = $('times-up-canvas');
const asciiSource   = $('ascii-source');
const presCard      = $('pres-card');
let stopAudio = null;
let stopAudioLoop = null;  // interval for repeating stop.mp3

// === ASCII RENDERER — edit these to tweak the look ===
const ASCII = {
  chars: '█▓▒░:· ',         // block ramp: dark → light (inverted)
  cols:  120,                // character columns (more = finer detail)
  fontSize: 5,               // px — controls cell size
  color: '#2a4010',          // Game Boy dark green
  contrast: 1.8,             // >1 = punchier
  brightness: 5,             // added to each pixel (0–255)
};

let asciiRAF = null;
const asciiSample = document.createElement('canvas');
const asciiSampleCtx = asciiSample.getContext('2d', { willReadFrequently: true });

function startAsciiOverlay() {
  const card = presCard;
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const dpr = window.devicePixelRatio || 1;
  timesUpCanvas.width  = w * dpr;
  timesUpCanvas.height = h * dpr;
  timesUpCanvas.style.width  = w + 'px';
  timesUpCanvas.style.height = h + 'px';

  const ctx = timesUpCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  // Responsive cols: keep cell ≥ fontSize so blocks don't squeeze on mobile
  const cols = Math.min(ASCII.cols, Math.floor(w / ASCII.fontSize));

  // Measure actual character cell size so blocks tile perfectly
  ctx.font = `${ASCII.fontSize}px 'Kode Mono', monospace`;
  const cellW = w / cols;
  const cellH = cellW * 1.4;   // slightly taller than wide for blocks
  const rows  = Math.ceil(h / cellH);

  // Sampling canvas matches grid
  asciiSample.width  = cols;
  asciiSample.height = rows;

  asciiSource.currentTime = 0;
  asciiSource.play().catch(e => console.warn('ASCII video play failed:', e));
  timesUpCanvas.classList.remove('hidden');

  function renderFrame() {
    if (!asciiSource.videoWidth) {
      asciiRAF = requestAnimationFrame(renderFrame);
      return;
    }

    try {
      // Sample the video frame at low resolution
      asciiSampleCtx.drawImage(asciiSource, 0, 0, cols, rows);
      const pixels = asciiSampleCtx.getImageData(0, 0, cols, rows).data;

      ctx.clearRect(0, 0, w, h);
      ctx.font = `${ASCII.fontSize}px 'Kode Mono', monospace`;
      ctx.textBaseline = 'top';

      const chars = ASCII.chars;
      const cLen = chars.length - 1;
      const con = ASCII.contrast;
      const bri = ASCII.brightness;

      for (let r = 0; r < rows; r++) {
        const y = r * cellH;
        for (let c = 0; c < cols; c++) {
          const i = (r * cols + c) * 4;
          let lum = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
          lum = Math.min(255, Math.max(0, (lum - 128) * con + 128 + bri));
          const ci = Math.floor((lum / 255) * cLen);
          // Vary opacity slightly per character for depth
          const alpha = 0.5 + (ci / cLen) * 0.5;
          ctx.fillStyle = `rgba(42, 64, 16, ${alpha})`;
          ctx.fillText(chars[ci], c * cellW, y);
        }
      }
    } catch (e) {
      console.error('ASCII render error:', e);
    }

    asciiRAF = requestAnimationFrame(renderFrame);
  }

  asciiRAF = requestAnimationFrame(renderFrame);
}

function stopAsciiOverlay() {
  if (asciiRAF) { cancelAnimationFrame(asciiRAF); asciiRAF = null; }
  asciiSource.pause();
  timesUpCanvas.classList.add('hidden');
}

// === HiDPI CANVAS SETUP ===
let wheelSize = 400;

function setupHiDPICanvas() {
  const dpr = window.devicePixelRatio || 1;
  // Use the wheel-outer container to determine rendered size
  const outer = document.querySelector('.wheel-outer');
  const cssSize = outer ? Math.round(outer.clientWidth) || 400 : 400;
  wheelSize = cssSize;

  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  canvas.style.width = cssSize + 'px';
  canvas.style.height = cssSize + 'px';

  c.setTransform(1, 0, 0, 1, 0, 0);
  c.scale(dpr, dpr);
}

setupHiDPICanvas();

window.addEventListener('resize', () => {
  setupHiDPICanvas();
  drawWheel(wheelAngleDeg);
});

// === FAIR SHUFFLE ===
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function refillPool() {
  let p = shuffle(NAMES);
  if (queue.length > 0 && p[0] === queue[queue.length - 1]) {
    const s = 1 + Math.floor(Math.random() * (p.length - 1));
    [p[0], p[s]] = [p[s], p[0]];
  }
  return p;
}

function pickNext() {
  if (!pool.length) pool = refillPool();
  return pool.shift();
}

// === INDEX AT POINTER ===
// Returns the index of the name currently under the pointer
function indexAtPointer(angleDeg) {
  const sliceDeg = 360 / NAMES.length;
  const effective = ((270 - (angleDeg % 360)) % 360 + 360) % 360;
  return Math.floor(effective / sliceDeg) % NAMES.length;
}

function nameAtPointer(angleDeg) {
  return NAMES[indexAtPointer(angleDeg)];
}

// === TICKER ANIMATION ===
const pointerEl = document.querySelector('.wheel-pointer');
let tickerTween = null;

function tickPointer(speed) {
  // speed: 0 (slow) to 1 (fast) — controls deflection amount
  const deflect = 18 + speed * 30; // 18°–48° heavy bend
  const dur = 0.10 + (1 - speed) * 0.08; // snappy settle

  if (tickerTween) tickerTween.kill();
  tickerTween = gsap.fromTo(pointerEl,
    { rotation: deflect },
    {
      rotation: 0,
      duration: dur,
      ease: 'power3.out',
      overwrite: true
    }
  );
}

// === WHEEL DRAWING ===
// highlightIdx: index of name at pointer to color orange (text only, no BG)
function drawWheel(angleDeg, highlightIdx) {
  const size = wheelSize;
  const cx = size / 2;
  const cy = size / 2;
  const r = cx - 2;
  const n = NAMES.length;
  const slice = (2 * Math.PI) / n;
  const rad = (angleDeg * Math.PI) / 180;

  // Scale factor relative to the 400px base design
  const s = size / 400;
  const fontSize = Math.round(12 * s);
  const labelPad = Math.round(18 * s);

  c.clearRect(0, 0, size, size);

  // Solid background disc — exact same as page background
  c.beginPath();
  c.arc(cx, cy, r, 0, 2 * Math.PI);
  c.fillStyle = '#e5e5e5';
  c.fill();

  c.save();
  c.translate(cx, cy);
  c.rotate(rad);

  const innerR = Math.round(4 * s);
  const grooveOffset = 0.006;

  for (let i = 0; i < n; i++) {
    const a0 = i * slice;

    // Dark side of groove
    c.save();
    c.rotate(a0 - grooveOffset);
    c.beginPath();
    c.moveTo(innerR, 0);
    c.lineTo(r - 2, 0);
    c.strokeStyle = 'rgba(0, 0, 0, 0.07)';
    c.lineWidth = 1;
    c.stroke();
    c.restore();

    // Light side of groove
    c.save();
    c.rotate(a0 + grooveOffset);
    c.beginPath();
    c.moveTo(innerR, 0);
    c.lineTo(r - 2, 0);
    c.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    c.lineWidth = 1;
    c.stroke();
    c.restore();

    // Name label — orange if this name is under the pointer
    c.save();
    c.rotate(a0 + slice / 2);
    c.textAlign = 'right';
    c.textBaseline = 'middle';

    if (highlightIdx !== undefined && i === highlightIdx) {
      c.fillStyle = '#d4a035';
      c.font = `700 ${fontSize}px 'Kode Mono', monospace`;
    } else {
      c.fillStyle = '#444';
      c.font = `500 ${fontSize}px 'Kode Mono', monospace`;
    }

    c.fillText(NAMES[i], r - labelPad, 0);
    c.restore();
  }

  c.restore();

  // Soft fade at the outer edge — blends wheel into the neumorphic ring
  const fadeWidth = Math.round(12 * s);
  const grad = c.createRadialGradient(cx, cy, r - fadeWidth, cx, cy, r);
  grad.addColorStop(0, 'rgba(229, 229, 229, 0)');
  grad.addColorStop(1, 'rgba(229, 229, 229, 0.6)');
  c.beginPath();
  c.arc(cx, cy, r, 0, 2 * Math.PI);
  c.fillStyle = grad;
  c.fill();
}

// === SPIN ===
function spin() {
  if (spinning || queue.length >= MAX_SLOTS) return;
  getAudioCtx();

  spinning = true;
  spinBtn.disabled = true;
  haptics.startBuzz();

  const name = pickNext();
  const idx = NAMES.indexOf(name);
  const sliceDeg = 360 / NAMES.length;

  const targetRemainder = 270 - idx * sliceDeg - sliceDeg / 2;
  const jitter = (Math.random() - 0.5) * sliceDeg * 0.6;
  const desiredRemainder = ((targetRemainder + jitter) % 360 + 360) % 360;

  const fullSpins = (5 + Math.floor(Math.random() * 3)) * 360;
  const currentRemainder = ((wheelAngleDeg % 360) + 360) % 360;
  const extraToAlign = ((desiredRemainder - currentRemainder) % 360 + 360) % 360;
  const targetTotal = wheelAngleDeg + fullSpins + extraToAlign;

  let lastTickIdx = indexAtPointer(wheelAngleDeg);
  const totalTravel = targetTotal - wheelAngleDeg;

  const proxy = { angle: wheelAngleDeg };
  gsap.to(proxy, {
    angle: targetTotal,
    duration: 4 + Math.random(),
    ease: 'power4.out',
    onUpdate() {
      // Highlight the name currently under the pointer in orange
      const currentIdx = indexAtPointer(proxy.angle);
      drawWheel(proxy.angle, currentIdx);

      // Tick when pointer crosses into a new name segment
      if (currentIdx !== lastTickIdx) {
        sound.tick();
        // Speed ratio: 0 at end, 1 at start — controls ticker intensity
        const progress = (proxy.angle - wheelAngleDeg) / totalTravel;
        const speed = Math.max(0, 1 - progress);
        tickPointer(speed);
        lastTickIdx = currentIdx;
      }
    },
    onComplete() {
      haptics.stop();
      haptics.success();
      wheelAngleDeg = targetTotal;
      spinning = false;
      updateSpinBtn();
      sound.select();
      const landedIdx = indexAtPointer(wheelAngleDeg);
      const landed = NAMES[landedIdx];
      // Keep the final landed name highlighted
      drawWheel(wheelAngleDeg, landedIdx);
      // Reset pointer to rest position
      gsap.to(pointerEl, { rotation: 0, duration: 0.15, ease: 'power2.out' });
      addToQueue(landed);
    }
  });
}

// === QUEUE ===
function addToQueue(name) {
  queue.push(name);
  renderQueue();
  updateInfo();
}

function removeFromQueue(i) {
  const el = listEl.children[i];
  if (!el) return;
  el.classList.add('removing');
  setTimeout(() => {
    queue.splice(i, 1);
    renderQueue();
    updateInfo();
  }, 300);
}

function renderQueue() {
  listEl.innerHTML = '';
  queue.forEach((name, i) => {
    const li = document.createElement('li');
    li.className = 'presenter-item';
    li.innerHTML = `
      <div class="presenter-number">${i + 1}</div>
      <div class="presenter-name">${name}</div>
      <div class="presenter-duration">${SLOT_MIN} min</div>
      <button class="presenter-remove" data-i="${i}">&times;</button>
    `;
    listEl.appendChild(li);
    gsap.from(li, { opacity: 0, x: 20, duration: 0.3, ease: 'power2.out' });
  });

  listEl.querySelectorAll('.presenter-remove').forEach(btn => {
    btn.onclick = () => removeFromQueue(+btn.dataset.i);
  });
}

function updateInfo() {
  const total = queue.length * SLOT_MIN;
  timeEl.textContent = `${total} / ${SESSION_MIN} min`;
  startBtn.disabled = queue.length === 0;
  updateSpinBtn();

  if (queue.length >= MAX_SLOTS) {
    spinInfo.textContent = 'Session full — start or remove someone';
  } else {
    const left = MAX_SLOTS - queue.length;
    spinInfo.textContent = `${left} slot${left !== 1 ? 's' : ''} remaining`;
  }
}

function updateSpinBtn() {
  spinBtn.disabled = spinning || queue.length >= MAX_SLOTS;
}

function resetAll() {
  queue = [];
  pool = [];
  wheelAngleDeg = 0;
  spinning = false;
  drawWheel(0);
  renderQueue();
  updateInfo();
  spinInfo.textContent = '';
}

// === PRESENTATION MODE ===
function startPresentations() {
  if (!queue.length) return;
  getAudioCtx();
  timerIdx = 0;
  overlay.classList.remove('hidden');
  runPresenter();
}

function runPresenter() {
  if (timerIdx >= queue.length) { stopAll(); return; }

  nameEl.textContent = queue[timerIdx];
  timerSec = SLOT_MIN * 60;
  deadlineMs = Date.now() + timerSec * 1000;
  paused = false;
  warned = false;
  pauseBtn.textContent = 'Pause';
  pauseBtn.disabled = false;
  skipBtn.disabled = false;
  nextBtn.classList.add('hidden');
  statusEl.textContent = '';
  statusEl.className = 'pres-status';
  timerTextEl.classList.remove('urgency', 'urgency-critical');
  // Hide ASCII overlay and stop audio from previous presenter
  stopAsciiOverlay();
  presCard.classList.remove('times-up');
  if (stopAudioLoop) { clearInterval(stopAudioLoop); stopAudioLoop = null; }
  if (stopAudio) { stopAudio.pause(); stopAudio = null; }
  timerTextEl.style.visibility = '';
  updateTimerUI();
  showUpNext();

  clearInterval(timerRef);
  timerRef = setInterval(tick, 1000);
}

function tick() {
  if (paused) return;
  // Derive from wall clock so screen-lock / throttling can't drift
  timerSec = Math.ceil((deadlineMs - Date.now()) / 1000);
  updateTimerUI();

  if (timerSec === 60 && !warned) {
    warned = true;
    sound.warning();
    statusEl.textContent = '1 minute left';
    statusEl.className = 'pres-status warning-text';
    timerTextEl.classList.add('urgency');
  }

  if (timerSec <= 10 && timerSec > 0) {
    statusEl.textContent = 'wrapping up';
    statusEl.className = 'pres-status danger-text';
    timerTextEl.classList.remove('urgency');
    timerTextEl.classList.add('urgency-critical');
  }

  if (timerSec <= 0) {
    clearInterval(timerRef);
    // Hide the 0:00 so the ASCII overlay is unobstructed
    timerTextEl.style.visibility = 'hidden';
    // Play stop.mp3 immediately, then repeat every 5s
    stopAudio = new Audio('stop.mp3');
    stopAudio.play().catch(() => {});
    stopAudioLoop = setInterval(() => {
      const a = new Audio('stop.mp3');
      a.play().catch(() => {});
    }, 5000);
    statusEl.textContent = "time's up";
    statusEl.className = 'pres-status danger-text';
    // Show ASCII overlay on the Game Boy screen
    startAsciiOverlay();
    presCard.classList.add('times-up');
    nextBtn.classList.remove('hidden');
    pauseBtn.disabled = true;
    skipBtn.disabled = true;
  }
}

function updateTimerUI() {
  const t = Math.max(0, timerSec);
  const m = Math.floor(t / 60);
  const s = t % 60;
  timerTextEl.textContent = `${m}:${String(s).padStart(2, '0')}`;

  // Update the horizontal progress bar
  const pct = t / (SLOT_MIN * 60);
  progressBar.style.width = (pct * 100) + '%';

  // Change bar opacity based on time (stays Game Boy green)
  if (t <= 10) {
    progressBar.style.background = '#2a4010';
  } else if (t <= 60) {
    progressBar.style.background = '#3a5818';
  } else {
    progressBar.style.background = '#486820';
  }
}

function showUpNext() {
  if (timerIdx + 1 < queue.length) {
    nextEl.textContent = 'Up next — ' + queue[timerIdx + 1];
    nextEl.style.display = '';
  } else if (timerIdx + 1 >= queue.length) {
    nextEl.textContent = 'Last presenter';
    nextEl.style.display = '';
  }
}

function togglePause() {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  if (paused) {
    pausedRemaining = deadlineMs - Date.now();
    statusEl.textContent = 'paused';
    statusEl.className = 'pres-status';
    // Freeze the clock pulse while paused
    timerTextEl.classList.remove('urgency', 'urgency-critical');
  } else {
    deadlineMs = Date.now() + pausedRemaining;
    if (timerSec <= 10) {
      statusEl.textContent = 'wrapping up';
      statusEl.className = 'pres-status danger-text';
      timerTextEl.classList.add('urgency-critical');
    } else if (timerSec <= 60) {
      statusEl.textContent = '1 minute left';
      statusEl.className = 'pres-status warning-text';
      timerTextEl.classList.add('urgency');
    } else {
      statusEl.textContent = '';
      statusEl.className = 'pres-status';
    }
  }
}

function advanceToNext() {
  timerIdx++;
  runPresenter();
}

function skipPresenter() {
  clearInterval(timerRef);
  timerIdx++;
  runPresenter();
}

function stopAll() {
  clearInterval(timerRef);
  stopAsciiOverlay();
  presCard.classList.remove('times-up');
  if (stopAudioLoop) { clearInterval(stopAudioLoop); stopAudioLoop = null; }
  if (stopAudio) { stopAudio.pause(); stopAudio = null; }
  timerTextEl.style.visibility = '';
  overlay.classList.add('hidden');
}

// === EVENTS ===
spinBtn.addEventListener('click', () => { haptics.tap(); spin(); });
startBtn.addEventListener('click', () => { haptics.tap(); startPresentations(); });
resetBtn.addEventListener('click', () => { haptics.tap(); resetAll(); });
skipBtn.addEventListener('click', () => { haptics.tap(); skipPresenter(); });
pauseBtn.addEventListener('click', () => { haptics.tap(); togglePause(); });
nextBtn.addEventListener('click', () => { haptics.tap(); advanceToNext(); });
stopBtn.addEventListener('click', () => { haptics.tap(); stopAll(); });

// === KEYBOARD SHORTCUTS (desktop only) ===
if (!('ontouchstart' in window)) {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const overlayVisible = !overlay.classList.contains('hidden');

    if (!overlayVisible) {
      if (e.key === 'Enter') { e.preventDefault(); spin(); }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); startPresentations(); }
    }
  });
}

// === INIT ===
drawWheel(0);
updateInfo();
