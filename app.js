// === CONSTANTS ===
const NAMES = ['Shane', 'David', 'Miriam', 'Miguel', 'Andros', 'Lia', 'Greta', 'Jonas', 'Chris', 'Marcelo'];
const SLOT_DURATION = 5; // minutes per presenter
const SESSION_DURATION = 90; // total session in minutes
const MAX_PRESENTERS = SESSION_DURATION / SLOT_DURATION; // 18 slots

const COLORS = [
  '#6c63ff', '#ff6b6b', '#51cf66', '#ffc107',
  '#4dabf7', '#e599f7', '#ff922b', '#20c997',
  '#f06595', '#845ef7'
];

// === AUDIO ===
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new AudioCtx();
  return audioCtx;
}

function playTone(freq, duration, type = 'sine', volume = 0.3) {
  const ctx = ensureAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

function playWarningSound() {
  playTone(880, 0.15, 'sine', 0.25);
  setTimeout(() => playTone(880, 0.15, 'sine', 0.25), 200);
  setTimeout(() => playTone(880, 0.15, 'sine', 0.25), 400);
}

function playDoneSound() {
  playTone(523, 0.2, 'square', 0.2);
  setTimeout(() => playTone(659, 0.2, 'square', 0.2), 200);
  setTimeout(() => playTone(784, 0.4, 'square', 0.2), 400);
}

function playTickSound() {
  playTone(1200, 0.03, 'sine', 0.08);
}

function playSelectSound() {
  playTone(600, 0.15, 'sine', 0.2);
  setTimeout(() => playTone(900, 0.25, 'sine', 0.2), 150);
}

// === STATE ===
let shufflePool = [];
let presenterQueue = [];
let isSpinning = false;
let currentRotation = 0;

// Presentation state
let presentationIndex = 0;
let timerInterval = null;
let timeRemaining = 0;
let isPaused = false;
let warningPlayed = false;

// === DOM REFS ===
const canvas = document.getElementById('wheel');
const ctx = canvas.getContext('2d');
const spinBtn = document.getElementById('spin-btn');
const spinInfo = document.getElementById('spin-info');
const presenterList = document.getElementById('presenter-list');
const queueTime = document.getElementById('queue-time');
const startBtn = document.getElementById('start-btn');
const resetBtn = document.getElementById('reset-btn');
const overlay = document.getElementById('presentation-overlay');
const currentPresenterName = document.getElementById('current-presenter-name');
const timerText = document.getElementById('timer-text');
const timerProgress = document.getElementById('timer-progress');
const timerStatus = document.getElementById('timer-status');
const skipBtn = document.getElementById('skip-btn');
const pauseBtn = document.getElementById('pause-btn');
const stopBtn = document.getElementById('stop-presentations-btn');
const upNext = document.getElementById('up-next');

// === SHUFFLE POOL (fair selection) ===
function refillPool() {
  const pool = [...NAMES];
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // Ensure last selected isn't first in new pool
  if (presenterQueue.length > 0) {
    const lastPicked = presenterQueue[presenterQueue.length - 1];
    if (pool[0] === lastPicked) {
      const swapIdx = 1 + Math.floor(Math.random() * (pool.length - 1));
      [pool[0], pool[swapIdx]] = [pool[swapIdx], pool[0]];
    }
  }
  return pool;
}

function getNextName() {
  if (shufflePool.length === 0) {
    shufflePool = refillPool();
  }
  return shufflePool.shift();
}

// === WHEEL DRAWING ===
function drawWheel(rotation = 0) {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 4;
  const sliceAngle = (2 * Math.PI) / NAMES.length;

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);

  NAMES.forEach((name, i) => {
    const start = i * sliceAngle;
    const end = start + sliceAngle;

    // Slice
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, start, end);
    ctx.closePath();
    ctx.fillStyle = COLORS[i % COLORS.length];
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Text
    ctx.save();
    ctx.rotate(start + sliceAngle / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 3;
    ctx.fillText(name, r - 16, 5);
    ctx.shadowBlur = 0;
    ctx.restore();
  });

  // Center circle
  ctx.beginPath();
  ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = '#e0e5ec';
  ctx.fill();
  ctx.shadowColor = 'rgba(0,0,0,0.15)';
  ctx.shadowBlur = 8;
  ctx.strokeStyle = '#d1d9e6';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.restore();
}

// === SPIN LOGIC ===
function getWinnerFromRotation(finalRotation) {
  const sliceAngle = 360 / NAMES.length;
  // Pointer is at top (270° in standard math coords, but we use CSS rotation)
  // Normalize the angle: the pointer is at top, wheel spins clockwise
  const normalizedDeg = ((-(finalRotation * 180 / Math.PI) % 360) + 360) % 360;
  const index = Math.floor(normalizedDeg / sliceAngle);
  return NAMES[index];
}

function spin() {
  if (isSpinning || presenterQueue.length >= MAX_PRESENTERS) return;

  ensureAudioCtx();
  isSpinning = true;
  spinBtn.disabled = true;

  const nextName = getNextName();
  const nameIndex = NAMES.indexOf(nextName);
  const sliceAngle = (2 * Math.PI) / NAMES.length;

  // Calculate target rotation so pointer lands on the chosen name
  const targetSliceCenter = nameIndex * sliceAngle + sliceAngle / 2;
  const extraSpins = (4 + Math.floor(Math.random() * 3)) * 2 * Math.PI;
  const targetRotation = currentRotation - extraSpins - targetSliceCenter +
    (Math.random() * sliceAngle * 0.6 - sliceAngle * 0.3);

  // Tick sound during spin
  let lastTickAngle = currentRotation;
  const tickInterval = sliceAngle;

  gsap.to({}, {
    duration: 0,
    onStart: () => {
      gsap.to({ rot: currentRotation }, {
        rot: targetRotation,
        duration: 3.5 + Math.random() * 1.5,
        ease: 'power4.out',
        onUpdate: function() {
          const r = this.targets()[0].rot;
          drawWheel(r);

          // Tick sounds
          const delta = Math.abs(r - lastTickAngle);
          if (delta >= tickInterval) {
            playTickSound();
            lastTickAngle = r;
          }
        },
        onComplete: () => {
          currentRotation = targetRotation;
          isSpinning = false;
          spinBtn.disabled = presenterQueue.length >= MAX_PRESENTERS;
          playSelectSound();
          addToQueue(nextName);
        }
      });
    }
  });
}

// === PRESENTER QUEUE ===
function addToQueue(name) {
  presenterQueue.push(name);
  renderQueue();
  updateQueueInfo();
}

function removeFromQueue(index) {
  const item = presenterList.children[index];
  if (item) {
    item.classList.add('removing');
    setTimeout(() => {
      presenterQueue.splice(index, 1);
      renderQueue();
      updateQueueInfo();
    }, 300);
  }
}

function renderQueue() {
  presenterList.innerHTML = '';
  presenterQueue.forEach((name, i) => {
    const li = document.createElement('li');
    li.className = 'presenter-item';
    li.innerHTML = `
      <div class="presenter-number">${i + 1}</div>
      <div class="presenter-name">${name}</div>
      <div class="presenter-duration">${SLOT_DURATION} min</div>
      <button class="presenter-remove" data-index="${i}">&times;</button>
    `;
    presenterList.appendChild(li);

    // Animate entry
    gsap.from(li, { opacity: 0, x: 30, duration: 0.35, ease: 'back.out(1.4)' });
  });

  // Remove button listeners
  presenterList.querySelectorAll('.presenter-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      removeFromQueue(parseInt(btn.dataset.index));
    });
  });
}

function updateQueueInfo() {
  const totalMin = presenterQueue.length * SLOT_DURATION;
  queueTime.textContent = `${totalMin} / ${SESSION_DURATION} min`;
  startBtn.disabled = presenterQueue.length === 0;
  spinBtn.disabled = isSpinning || presenterQueue.length >= MAX_PRESENTERS;

  if (presenterQueue.length >= MAX_PRESENTERS) {
    spinInfo.textContent = 'Session full! Start presentations or remove someone.';
  } else {
    const remaining = MAX_PRESENTERS - presenterQueue.length;
    spinInfo.textContent = `${remaining} slot${remaining !== 1 ? 's' : ''} remaining`;
  }
}

function resetAll() {
  presenterQueue = [];
  shufflePool = [];
  currentRotation = 0;
  isSpinning = false;
  drawWheel(0);
  renderQueue();
  updateQueueInfo();
  spinInfo.textContent = '';
}

// === PRESENTATION MODE ===
function startPresentations() {
  if (presenterQueue.length === 0) return;
  ensureAudioCtx();
  presentationIndex = 0;
  overlay.classList.remove('hidden');
  startCurrentPresenter();
}

function startCurrentPresenter() {
  if (presentationIndex >= presenterQueue.length) {
    endAllPresentations();
    return;
  }

  const name = presenterQueue[presentationIndex];
  currentPresenterName.textContent = name;
  timeRemaining = SLOT_DURATION * 60;
  isPaused = false;
  warningPlayed = false;
  pauseBtn.textContent = 'PAUSE';
  timerStatus.textContent = '';
  timerStatus.className = 'timer-status';
  timerProgress.classList.remove('warning', 'danger');

  updateTimerDisplay();
  updateUpNext();

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 1000);
}

function tickTimer() {
  if (isPaused) return;

  timeRemaining--;
  updateTimerDisplay();

  // 1 minute warning
  if (timeRemaining === 60 && !warningPlayed) {
    warningPlayed = true;
    playWarningSound();
    timerStatus.textContent = '1 MINUTE LEFT';
    timerStatus.className = 'timer-status warning-text';
    timerProgress.classList.add('warning');
  }

  // 10 seconds left
  if (timeRemaining <= 10 && timeRemaining > 0) {
    timerProgress.classList.remove('warning');
    timerProgress.classList.add('danger');
  }

  // Done
  if (timeRemaining <= 0) {
    clearInterval(timerInterval);
    playDoneSound();
    timerStatus.textContent = 'TIME\'S UP!';
    timerStatus.className = 'timer-status warning-text';

    setTimeout(() => {
      presentationIndex++;
      startCurrentPresenter();
    }, 2000);
  }
}

function updateTimerDisplay() {
  const totalSeconds = SLOT_DURATION * 60;
  const mins = Math.floor(Math.max(0, timeRemaining) / 60);
  const secs = Math.max(0, timeRemaining) % 60;
  timerText.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

  // Ring progress
  const circumference = 2 * Math.PI * 90;
  const progress = timeRemaining / totalSeconds;
  timerProgress.style.strokeDashoffset = circumference * (1 - progress);
}

function updateUpNext() {
  if (presentationIndex + 1 < presenterQueue.length) {
    upNext.textContent = `Up next: ${presenterQueue[presentationIndex + 1]}`;
  } else {
    upNext.textContent = presentationIndex + 1 >= presenterQueue.length ? '' : '';
  }
}

function togglePause() {
  isPaused = !isPaused;
  pauseBtn.textContent = isPaused ? 'RESUME' : 'PAUSE';
  if (isPaused) {
    timerStatus.textContent = 'PAUSED';
    timerStatus.className = 'timer-status';
  } else {
    timerStatus.textContent = timeRemaining <= 60 ? '1 MINUTE LEFT' : '';
    timerStatus.className = timeRemaining <= 60 ? 'timer-status warning-text' : 'timer-status';
  }
}

function skipPresenter() {
  clearInterval(timerInterval);
  presentationIndex++;
  startCurrentPresenter();
}

function endAllPresentations() {
  clearInterval(timerInterval);
  overlay.classList.add('hidden');
  timerStatus.textContent = '';
}

// === EVENT LISTENERS ===
spinBtn.addEventListener('click', spin);
startBtn.addEventListener('click', startPresentations);
resetBtn.addEventListener('click', resetAll);
skipBtn.addEventListener('click', skipPresenter);
pauseBtn.addEventListener('click', togglePause);
stopBtn.addEventListener('click', endAllPresentations);

// === INIT ===
drawWheel(0);
updateQueueInfo();
