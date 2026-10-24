'use strict';

// Scan/classification logic changes so a fresh scan is needed.
const SCAN_VERSION = 11;

// ════════════════════════════════════════════════════════════
//  DOM REFS
// ════════════════════════════════════════════════════════════
const videoEl   = document.getElementById('video-el');
const canvas    = document.getElementById('overlay-canvas');
const ctx       = canvas.getContext('2d');
document.getElementById('video-viewport').addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  app.debugMouseX = (e.clientX - r.left) / r.width;
  app.debugMouseY = (e.clientY - r.top)  / r.height;
});
document.getElementById('video-viewport').addEventListener('mouseleave', () => {
  app.debugMouseX = null;
  app.debugMouseY = null;
});
const fileInput = document.getElementById('file-input');

// Offscreen canvas for live ball detection
const ballDetCanvas = document.createElement('canvas');
ballDetCanvas.width  = 640;
ballDetCanvas.height = 360;
const ballDetCtx = ballDetCanvas.getContext('2d', { willReadFrequently: true });

// Offscreen canvas used as an intermediate frame source for MediaPipe pose
// detection during live playback
const poseDetCanvas = document.createElement('canvas');
const poseDetCtx    = poseDetCanvas.getContext('2d');

// ════════════════════════════════════════════════════════════
//  BALL DETECTION
// ════════════════════════════════════════════════════════════
// Returns true if the RGB pixel matches a light yellow tennis ball.
// Key signatures:
//   - Both R and G are high (bright / light colour)
//   - R is close to G — yellow means roughly equal red and green
//   - B is clearly lower than both — distinguishes yellow from white/grey
//   - Eliminates green court (R much lower than G there)
// Calibrated from three measured ball frames and court surface:
//   Ball frame 1: R=156 G=208 B=163
//   Ball frame 2: R=185 G=209 B=149
//   Ball frame 3: R=193 G=208 B=191
//   Court:        R=99  G=114 B=81
//
// Motion-based ball detection — compares consecutive frames pixel-by-pixel.
// The ball is the fastest small object in frame, creating a tight high-magnitude
// diff cluster. Player/camera motion creates large spread-out regions which are
// filtered out by the high-cell-count rejection below.
let ballPrevData      = null;  // previous frame pixel data
let ballArrivalFrame  = null;  // per-pixel frame counter: when did this pixel last change significantly?
let ballDetFrameCount = 0;     // increments every detectBall() call
let ballDetErrors     = 0;
let _clusterVisited   = null;  // reusable visited buffer for global cluster DFS
let _clusterStack     = null;  // reusable stack buffer for global cluster DFS
let ballLastValidList = [];   // [{x, y, t}] recent accepted detections — cluster must be near any one
let ballPendingDet    = null; // unconfirmed candidate — must be followed by consistent detection
const BALL_MAX_SPEED  = 0.3; // fallback when no pose data available
const BALL_RESET_MS   = 2000; // reset trajectory reference after this gap (new rally/serve)

// ── Court calibration (persistence) ────────────────────────────────────
function calibLocalKey(clipId) { return `courtCalib_${clipId}`; }

function loadCourtCalib(clipId) {
  try {
    const raw = localStorage.getItem(calibLocalKey(clipId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.points?.length >= 3) return data;
  } catch(e) {}
  return null;
}

function saveCourtCalib(clipId, points) {
  try {
    localStorage.setItem(calibLocalKey(clipId), JSON.stringify({ points, savedAt: Date.now() }));
  } catch(e) {}
}

async function saveCourtCalibFirestore(clipId, points) {
  const userId = fbAuth?.currentUser?.uid;
  if (!userId || !clipId) return;
  try {
    await fbDb.collection('users').doc(userId)
      .collection('videos').doc(clipId)
      .update({ courtCalib: { points, savedAt: Date.now() } });
  } catch(e) {
    console.warn('[TA] Failed to save court calibration to Firestore:', e);
  }
}

function applyCourtCalib(data) {
  courtCalib = data;
  const btn = document.getElementById('calib-btn');
  if (btn) {
    btn.classList.toggle('calibrated', !!data);
    btn.title       = data ? 'Play area set — click to redo' : 'Mark play area';
    btn.textContent = data ? '⊹ Area ✓' : '⊹ Area';
  }
}

// ── Calibration UI helpers ────────────────────────────────────────────────────

function showCalibBanner() {
  document.getElementById('calib-banner').classList.add('visible');
}
function hideCalibBanner() {
  document.getElementById('calib-banner').classList.remove('visible');
}
function dismissCalibBanner() { hideCalibBanner(); }

function startCalibration() {
  hideCalibBanner();
  calib.active    = true;
  calib.points    = [];
  calib.closed    = false;
  calib.dragIdx   = -1;
  calib.cursorPos = null;
  videoEl.pause();
  if (videoEl.currentTime > 0.5) videoEl.currentTime = 0;
  document.getElementById('calib-overlay').classList.add('active');
  document.getElementById('calib-ui').classList.add('active');
  document.querySelector('.ctrl-row').style.display = 'none';
  document.getElementById('scrub-track').style.display = 'none';
  canvas.style.pointerEvents = 'none';
  updateCalibStepLabel();
  drawCalibCanvas();
}

function updateCalibStepLabel() {
  const el         = document.getElementById('calib-step-label');
  const confirmBtn = document.getElementById('calib-confirm-btn');
  const closeBtn   = document.getElementById('calib-close-poly-btn');
  const n = calib.points.length;

  if (calib.closed) {
    el.innerHTML = `<strong>Area complete.</strong> Drag any point to adjust, then confirm.`;
    confirmBtn.disabled = false;
    closeBtn.style.display = 'none';
  } else if (n === 0) {
    el.innerHTML = `Click anywhere on the video to start drawing the play area.`;
    confirmBtn.disabled = true;
    closeBtn.style.display = 'none';
  } else if (n < 3) {
    el.innerHTML = `<strong>${n} point${n > 1 ? 's' : ''} placed.</strong> Keep clicking to add more.`;
    confirmBtn.disabled = true;
    closeBtn.style.display = 'none';
  } else {
    el.innerHTML = `<strong>${n} points placed.</strong> Click near the <strong style="color:#f78166">first point</strong> to close the shape, or use the button.`;
    confirmBtn.disabled = true;
    closeBtn.style.display = '';
  }
}

function closeCalibPolygon() {
  if (calib.points.length < 3) return;
  calib.closed = true;
  updateCalibStepLabel();
  drawCalibCanvas();
}

function redoCalibration() {
  calib.points  = [];
  calib.closed  = false;
  calib.dragIdx = -1;
  updateCalibStepLabel();
  drawCalibCanvas();
}

function cancelCalibration() {
  calib.active  = false;
  calib.points  = [];
  calib.closed  = false;
  calib.dragIdx = -1;
  document.getElementById('calib-overlay').classList.remove('active');
  document.getElementById('calib-ui').classList.remove('active');
  document.querySelector('.ctrl-row').style.display = '';
  document.getElementById('scrub-track').style.display = '';
  canvas.style.pointerEvents = 'none';
  drawOverlay();
}

function confirmCalibration() {
  if (!calib.closed || calib.points.length < 3) return;
  const pts = calib.points.slice();
  saveCourtCalib(app.activeClipId, pts);
  saveCourtCalibFirestore(app.activeClipId, pts); // async, non-blocking
  applyCourtCalib({ points: pts });
  calib.active = false;
  calib.points = [];
  calib.closed = false;
  document.getElementById('calib-overlay').classList.remove('active');
  document.getElementById('calib-ui').classList.remove('active');
  document.querySelector('.ctrl-row').style.display = '';
  document.getElementById('scrub-track').style.display = '';
  canvas.style.pointerEvents = 'none';
  drawOverlay();
}

// Convert pointer event → normalised canvas coords {x,y}
function calibEventPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

// Is pos within snap radius of the first point? (used to close polygon on click)
const CALIB_SNAP = 0.04; // normalised
function nearFirstPoint(pos) {
  if (calib.points.length < 3) return false;
  const f = calib.points[0];
  return Math.hypot(pos.x - f.x, pos.y - f.y) < CALIB_SNAP;
}

// ── Calibration canvas drawing ────────────────────────────────────────────────
function drawCalibCanvas() {
  drawOverlay(); // base frame + existing overlays

  const pts = calib.points;
  const cw  = canvas.width, ch = canvas.height;
  if (pts.length === 0) return;

  // Draw the polygon path (closed or open)
  ctx.beginPath();
  ctx.moveTo(pts[0].x * cw, pts[0].y * ch);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * cw, pts[i].y * ch);
  if (calib.closed) {
    ctx.closePath();
    ctx.fillStyle   = 'rgba(63,185,80,0.13)';
    ctx.strokeStyle = 'rgba(63,185,80,0.85)';
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(63,185,80,0.75)';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Ghost line from last point to cursor
    if (calib.cursorPos) {
      const last = pts[pts.length - 1];
      // If close enough to snap to first point, preview the closing line
      const snapping = nearFirstPoint(calib.cursorPos);
      const targetX  = snapping ? pts[0].x * cw : calib.cursorPos.x * cw;
      const targetY  = snapping ? pts[0].y * ch : calib.cursorPos.y * ch;
      ctx.beginPath();
      ctx.moveTo(last.x * cw, last.y * ch);
      ctx.lineTo(targetX, targetY);
      ctx.strokeStyle = snapping ? 'rgba(63,185,80,0.7)' : 'rgba(63,185,80,0.3)';
      ctx.lineWidth   = snapping ? 2 : 1.5;
      ctx.setLineDash(snapping ? [] : [4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // If snapping, also preview the closing segment back to first
      if (snapping && pts.length >= 3) {
        // Closing segment is already drawn by the ghost-line stroke above; just fill a preview polygon
        ctx.beginPath();
        ctx.moveTo(pts[0].x * cw, pts[0].y * ch);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * cw, pts[i].y * ch);
        ctx.closePath();
        ctx.fillStyle = 'rgba(63,185,80,0.1)';
        ctx.fill();
      }
    }
  }

  // Draw point dots
  pts.forEach((pt, i) => {
    const px = pt.x * cw, py = pt.y * ch;
    const isFirst = i === 0;
    const canSnap = isFirst && !calib.closed && pts.length >= 3 &&
                    calib.cursorPos && nearFirstPoint(calib.cursorPos);

    const radius = canSnap ? 13 : 8;
    const color  = isFirst ? '#f78166' : '#3fb950';

    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle   = color + (canSnap ? '44' : '28');
    ctx.strokeStyle = color;
    ctx.lineWidth   = canSnap ? 2.5 : 1.5;
    ctx.fill(); ctx.stroke();

    ctx.font         = 'bold 10px sans-serif';
    ctx.fillStyle    = color;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(i + 1, px, py);
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
  });

  // Crosshair when still placing points
  if (!calib.closed && calib.cursorPos && !nearFirstPoint(calib.cursorPos)) {
    const cx2 = calib.cursorPos.x * cw, cy2 = calib.cursorPos.y * ch;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(cx2 - 10, cy2); ctx.lineTo(cx2 + 10, cy2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx2, cy2 - 10); ctx.lineTo(cx2, cy2 + 10); ctx.stroke();
  }
}

// ── Calibration overlay pointer events ───────────────────────────────────────
const calibOverlayEl = document.getElementById('calib-overlay');

calibOverlayEl.addEventListener('mousemove', e => {
  if (!calib.active) return;
  const pos = calibEventPos(e);
  if (calib.dragIdx >= 0) {
    calib.points[calib.dragIdx] = pos;
    updateCalibStepLabel();
  }
  calib.cursorPos = pos;
  drawCalibCanvas();
});

calibOverlayEl.addEventListener('mousedown', e => {
  if (!calib.active) return;
  e.preventDefault();
  const pos = calibEventPos(e);

  // Snap-close MUST be checked before drag — both radii overlap at the first
  // point, and drag would silently move it instead of closing the polygon.
  if (!calib.closed && nearFirstPoint(pos)) {
    closeCalibPolygon();
    return;
  }

  // Drag an existing point to adjust it
  const HIT = 0.03;
  const idx = calib.points.findIndex(pt => Math.hypot(pt.x - pos.x, pt.y - pos.y) < HIT);
  if (idx >= 0) {
    calib.dragIdx = idx;
    return;
  }

  if (calib.closed) return; // polygon complete — only drag allowed

  // Add a new point
  calib.points.push({ ...pos });
  updateCalibStepLabel();
  drawCalibCanvas();
});

calibOverlayEl.addEventListener('mouseup', () => {
  if (calib.dragIdx >= 0) {
    calib.dragIdx = -1;
    drawCalibCanvas();
  }
});

calibOverlayEl.addEventListener('mouseleave', () => {
  calib.dragIdx   = -1;
  calib.cursorPos = null;
  if (calib.active) drawCalibCanvas();
});

// Dynamic velocity limit calibrated by the player's shoulder width.
// Shoulder width in normalised coords naturally scales with camera zoom:
// wider frame (zoomed out) → smaller shoulder → smaller limit, and vice versa.
// 6 shoulder-widths/second ≈ 60-80mph on a typical broadcast shot.
function dynamicBallMaxSpeed() {
  const lms = app.landmarks;
  if (lms) {
    const ls = lms[11], rs = lms[12]; // L_SHOULDER, R_SHOULDER
    if (ls && rs && (ls.visibility ?? 1) > 0.4 && (rs.visibility ?? 1) > 0.4) {
      const dx = ls.x - rs.x, dy = ls.y - rs.y;
      const sw = Math.sqrt(dx * dx + dy * dy);
      if (sw > 0.03) return 2 * sw; // 2 shoulder-widths per second
    }
  }
  return BALL_MAX_SPEED;
}

function resetBallMotion() {
  ballPrevData      = null;
  ballArrivalFrame  = null;
  ballDetFrameCount = 0;
  ballLastValidList = [];
  ballPendingDet    = null;
  app.ballTrail     = [];
  app.liveBallPos   = null;
  app.debugClusterHistory = [];
  app.debugClusters      = [];
  // Clear the camera-shift streak too — otherwise a partial count from before
  // a seek/clip-change survives it, and one unrelated over-threshold frame at
  // the new position can falsely complete the "3 consecutive frames" streak.
  app._cameraShiftFrames = 0;
  app._cameraShiftLastT  = null;
  hideCameraShiftBar();
}

// Build a list of normalised exclude boxes covering all detected people.

// ── Play-area polygon test ────────────────────────────────────────────────────
// Standard ray-casting point-in-polygon. poly is [{x,y}] in pixel coords.
function pointInPolygon(px, py, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

// ── Global motion compensation ────────────────────────────────────────────────
// Estimate the integer pixel translation of the camera between two frames by
// subsampling and finding the shift that minimises pixel-level differences.
// Returns {dx, dy} — the amount the camera moved (prev→curr).
// We search ±MAX_SHIFT pixels. Subsampling at STEP skips most pixels for speed.
function estimateCameraShift(curr, prev, w, h) {
  const MAX_SHIFT = 6;
  const STEP      = 8; // sample every 8th pixel → ~(80×45)=3600 samples
  let bestScore = Infinity, bestDx = 0, bestDy = 0;

  for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy++) {
    for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx++) {
      let score = 0;
      // Only sample pixels where both curr and shifted-prev are in-bounds
      for (let py = MAX_SHIFT; py < h - MAX_SHIFT; py += STEP) {
        for (let px = MAX_SHIFT; px < w - MAX_SHIFT; px += STEP) {
          const ci = (py * w + px) * 4;
          const pi = ((py - dy) * w + (px - dx)) * 4;
          score += Math.abs(curr[ci]   - prev[pi])
                 + Math.abs(curr[ci+1] - prev[pi+1])
                 + Math.abs(curr[ci+2] - prev[pi+2]);
        }
      }
      if (score < bestScore) { bestScore = score; bestDx = dx; bestDy = dy; }
    }
  }
  return { dx: bestDx, dy: bestDy, score: bestScore };
}

// Reusable buffer for the player exclusion mask — avoids GC pressure.
let _playerMaskBuf = null;

// Build a per-pixel exclusion mask covering the player's body skeleton.
// Uses sampled circles along each segment (fast) rather than exact capsule math.
// Returns a Uint8Array of length w*h, or null if no landmarks.
function buildPlayerMask(lms, w, h) {
  if (!lms) return null;
  const n = w * h;
  if (!_playerMaskBuf || _playerMaskBuf.length !== n) _playerMaskBuf = new Uint8Array(n);
  else _playerMaskBuf.fill(0);
  const mask = _playerMaskBuf;

  // Stamp a filled circle into the mask.
  const fillCircle = (cx, cy, r) => {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let py = y0; py <= y1; py++) {
      const dy = py - cy;
      for (let px = x0; px <= x1; px++) {
        const dx = px - cx;
        if (dx * dx + dy * dy <= r2) mask[py * w + px] = 1;
      }
    }
  };

  // Sample N+1 circles evenly along a segment to approximate a capsule.
  const fillSegment = (ax, ay, bx, by, r, steps = 4) => {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      fillCircle(ax + t * (bx - ax), ay + t * (by - ay), r);
    }
  };

  const pt = idx => {
    const p = lms[idx];
    if (!p || (p.visibility ?? 1) < 0.3) return null;
    return [p.x * w, p.y * h];
  };

  const LIMB_R  = 14;
  const TORSO_R = 22;
  const HEAD_R  = 24;

  const nose = pt(0);
  if (nose) fillCircle(nose[0], nose[1], HEAD_R);
  const lEar = pt(7), rEar = pt(8);
  if (lEar && rEar) fillSegment(lEar[0], lEar[1], rEar[0], rEar[1], HEAD_R, 2);

  const ls = pt(11), rs = pt(12), lh = pt(23), rh = pt(24);
  if (ls && rs) fillSegment(ls[0], ls[1], rs[0], rs[1], TORSO_R, 3);
  if (lh && rh) fillSegment(lh[0], lh[1], rh[0], rh[1], TORSO_R, 3);
  if (ls && lh) fillSegment(ls[0], ls[1], lh[0], lh[1], TORSO_R, 4);
  if (rs && rh) fillSegment(rs[0], rs[1], rh[0], rh[1], TORSO_R, 4);

  const le = pt(13), re = pt(14), lw = pt(15), rw = pt(16);
  if (ls && le) fillSegment(ls[0], ls[1], le[0], le[1], LIMB_R, 3);
  if (le && lw) fillSegment(le[0], le[1], lw[0], lw[1], LIMB_R, 3);
  if (rs && re) fillSegment(rs[0], rs[1], re[0], re[1], LIMB_R, 3);
  if (re && rw) fillSegment(re[0], re[1], rw[0], rw[1], LIMB_R, 3);

  const lk = pt(25), rk = pt(26), la = pt(27), ra = pt(28);
  if (lh && lk) fillSegment(lh[0], lh[1], lk[0], lk[1], LIMB_R, 3);
  if (lk && la) fillSegment(lk[0], lk[1], la[0], la[1], LIMB_R, 3);
  if (rh && rk) fillSegment(rh[0], rh[1], rk[0], rk[1], LIMB_R, 3);
  if (rk && ra) fillSegment(rk[0], rk[1], ra[0], ra[1], LIMB_R, 3);

  return mask;
}

// searchRegions: [{cx, cy, r} normalised] array, or null/empty for full-frame search.
// courtPoly: [{x,y} normalised] × 4 from calibration, or null.
// excludeMask: Uint8Array[w*h] — pixels set to 1 are skipped (player body), or null.
function detectBall(ctx2d, w, h, searchRegions, courtPoly, excludeMask) {
  const MOTION_THRESHOLD = 25;  // min total RGB diff to count as a significant pixel change
  const MAX_BALL_FRAMES  = 6;   // second change must occur within this many frames of the first
  const MIN_CLUSTER      = 5;   // cluster must have at least this many pixels
  const MAX_CLUSTER      = 40;  // cluster must have at most this many pixels
  const MAX_BBOX         = 8;   // cluster bounding box must fit within this size (px, each axis)
  const CLUSTER_RADIUS   = 2;   // pixels within this distance are considered part of the same cluster

  let curr;
  try {
    curr = ctx2d.getImageData(0, 0, w, h).data;
  } catch (e) {
    app.ballDebugCount = -1;
    if (ballDetErrors++ < 3) console.warn('[TA] Ball detect getImageData failed:', e.message);
    return null;
  }

  const numPixels = w * h;

  if (!ballPrevData || ballPrevData.length !== curr.length) {
    ballPrevData      = new Uint8ClampedArray(curr);
    ballArrivalFrame  = new Uint16Array(numPixels);
    ballDetFrameCount = 1;
    app.ballDebugCount = 0;
    return null;
  }

  ballDetFrameCount++;
  if (ballDetFrameCount > 60000) ballDetFrameCount = 1;

  // Camera-shake compensation: find the global pixel translation between frames
  // and compare each pixel against the same real-world position in the previous frame.
  const camShift = estimateCameraShift(curr, ballPrevData, w, h);
  const shiftDx  = camShift.dx, shiftDy = camShift.dy;

  if (!ballArrivalFrame || ballArrivalFrame.length !== numPixels)
    ballArrivalFrame = new Uint16Array(numPixels);

  // Optional court mask — only check pixels inside the calibrated play area.
  let courtMask = null;
  if (courtPoly && courtPoly.length >= 3) {
    const poly = courtPoly.map(p => ({ x: p.x * w, y: p.y * h }));
    courtMask = new Uint8Array(numPixels);
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++)
        if (pointInPolygon(px, py, poly))
          courtMask[py * w + px] = 1;
  }

  // Search regions — cluster-level filter only (pixels always fully scanned).
  const hasSearchRegions = searchRegions && searchRegions.length > 0;
  const srList = hasSearchRegions
    ? searchRegions.map(sr => ({ cx: sr.cx, cy: sr.cy, r2: sr.r * sr.r }))
    : [];

  // Color gate — reject pixels that are clearly not a tennis ball.
  const isBallColor = (r, g, b) =>
    !(r > 170 && r > g + 80 && r > b + 80) &&  // not bright red
    !(r > 130 && b > 130 && g < 80);             // not bright purple/magenta

  const transitMask = new Uint8Array(numPixels);
  const pv = ballPrevData;
  const af = ballArrivalFrame;
  const fc = ballDetFrameCount;

  // ── Step 1: find transit pixels ───────────────────────────────────────────
  // A transit pixel is one that changed significantly (≥ MOTION_THRESHOLD) twice
  // within MAX_BALL_FRAMES frames, with at least one frame passing the color gate.
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (courtMask  && !courtMask[py * w + px])  continue;
      if (excludeMask &&  excludeMask[py * w + px]) continue; // inside player body

      const i  = (py * w + px) * 4;
      const pi = py * w + px;

      const ppx = px - shiftDx, ppy = py - shiftDy;
      if (ppx < 0 || ppx >= w || ppy < 0 || ppy >= h) continue;
      const si = (ppy * w + ppx) * 4;

      const diff = Math.abs(curr[i]   - pv[si])
                 + Math.abs(curr[i+1] - pv[si+1])
                 + Math.abs(curr[i+2] - pv[si+2]);

      if (diff <= MOTION_THRESHOLD) continue;

      const arrived = af[pi];
      if (arrived > 0 && (fc - arrived) <= MAX_BALL_FRAMES) {
        const cr = curr[i], cg = curr[i+1], cb = curr[i+2];
        const pr = pv[si],  pg = pv[si+1],  pb = pv[si+2];
        if (isBallColor(cr, cg, cb) || isBallColor(pr, pg, pb))
          transitMask[pi] = 1;
        af[pi] = 0;
      } else {
        if (arrived === 0 || (fc - arrived) > MAX_BALL_FRAMES)
          af[pi] = fc;
      }
    }
  }

  ballPrevData = new Uint8ClampedArray(curr);

  // ── Step 2: group transit pixels into clusters via DFS ────────────────────
  // Pixels within CLUSTER_RADIUS of each other are merged into the same cluster.
  if (!_clusterVisited || _clusterVisited.length < numPixels) _clusterVisited = new Uint8Array(numPixels);
  if (!_clusterStack   || _clusterStack.length   < numPixels) _clusterStack   = new Int32Array(numPixels);
  const visited = _clusterVisited;
  const stack   = _clusterStack;
  visited.fill(0);

  let clusters = [];

  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      const gi = gy * w + gx;
      if (visited[gi] || !transitMask[gi]) continue;

      visited[gi] = 1;
      let top = 0, size = 0, sumX = 0, sumY = 0;
      let minX = gx, maxX = gx, minY = gy, maxY = gy;
      const clPx = [];
      stack[top++] = gi;

      while (top > 0) {
        const cur = stack[--top];
        const cx = cur % w, cy = Math.floor(cur / w);
        size++;
        sumX += cx; sumY += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (size <= MAX_CLUSTER) clPx.push(cur);

        for (let dy = -CLUSTER_RADIUS; dy <= CLUSTER_RADIUS; dy++) {
          for (let dx = -CLUSTER_RADIUS; dx <= CLUSTER_RADIUS; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const ni = ny * w + nx;
            if (!visited[ni] && transitMask[ni]) { visited[ni] = 1; stack[top++] = ni; }
          }
        }
      }

      // ── Step 3: size filter ───────────────────────────────────────────────────
      const clW = maxX - minX + 1;
      const clH = maxY - minY + 1;
      if (size < MIN_CLUSTER || size > MAX_CLUSTER || clW > MAX_BBOX || clH > MAX_BBOX) continue;
      const MAX_ASPECT = 2.0;
      if (Math.max(clW, clH) / Math.min(clW, clH) > MAX_ASPECT) continue;

      clusters.push({
        x: minX / w,         y: minY / h,
        w: clW / w,          h: clH / h,
        count: size,
        centX: sumX / size / w,
        centY: sumY / size / h,
        _px: clPx,
      });
    }
  }

  // ── Step 3.5: proximity filter ───────────────────────────────────────────
  // If two clusters are very close to each other, reject both — a single ball
  // produces one cluster; nearby pairs indicate a larger moving object (e.g.
  // player limb) that was split by the size filter.
  {
    const PROXIMITY = 0.05; // normalised (~32 px on 640 px width)
    const P2 = PROXIMITY * PROXIMITY;
    const reject = new Uint8Array(clusters.length);
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const dx = clusters[i].centX - clusters[j].centX;
        const dy = clusters[i].centY - clusters[j].centY;
        if (dx * dx + dy * dy < P2) { reject[i] = 1; reject[j] = 1; }
      }
    }
    clusters = clusters.filter((_, k) => !reject[k]);
  }

  // ── Step 4: search region filter (cluster-level) ─────────────────────────
  // A cluster passes if it's within radius of ANY recent valid position.
  if (hasSearchRegions) {
    clusters = clusters.filter(cl =>
      srList.some(sr => {
        const dx = cl.centX - sr.cx, dy = cl.centY - sr.cy;
        return dx * dx + dy * dy <= sr.r2;
      })
    );
  }

  // Clear the pixel-index buffer before clusters get stored in history — keeps
  // debugClusterHistory entries lean (it only needs count/bbox, not every pixel).
  for (const cl of clusters) delete cl._px;

  app.debugClusters  = clusters;
  app.ballDebugCount = clusters.length;

  if (clusters.length === 0) return null;

  // Return the largest cluster's centroid.
  let best = clusters[0];
  for (let i = 1; i < clusters.length; i++)
    if (clusters[i].count > best.count) best = clusters[i];

  return { x: best.centX, y: best.centY };
}

// ════════════════════════════════════════════════════════════
//  AI MODEL LOADING
// ════════════════════════════════════════════════════════════
async function loadModels() {
  setStatus('loading', 'Loading pose model…');
  try {
    app.poseModel = new Pose({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}`,
    });
    app.poseModel.setOptions({
      modelComplexity: 2, smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    app.poseModel.onResults(onPoseResults);
    // Warm up
    const warm = document.createElement('canvas');
    warm.width = 64; warm.height = 64;
    await app.poseModel.send({ image: warm });

    setStatus('loading', 'Loading object detection…');
    app.cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });

    app.modelsReady = true;
    setStatus('ready', 'AI Ready');
    tryStartScan(); // start scan if video was already loaded before models finished
  } catch (e) {
    console.error('[TA] Model load failed:', e);
    setStatus('error', 'Model error');
  }
}

function setStatus(state, text) {
  const dot  = document.getElementById('status-dot');
  const span = document.getElementById('status-text');
  dot.className = 'status-dot' + (state === 'ready' ? ' ready' : state === 'error' ? ' error' : '');
  span.textContent = text;
}

// ════════════════════════════════════════════════════════════
//  USER SETTINGS  (handedness + overlay/feedback toggles — persisted to Firestore)
// ════════════════════════════════════════════════════════════
async function loadUserSettings(userId) {
  try {
    const doc  = await fbDb.collection('users').doc(userId).get();
    const data = doc.exists ? doc.data() : {};
    if (data.handedness) {
      playerHandedness = data.handedness;
      updateHandednessBtn();
    }
    // Fall back to the same defaults the app state is initialised with, for
    // settings this account has never changed (or never saved before this
    // was added to Firestore).
    app.ballDetectionOverlay = data.ballDetectionOverlay ?? true;
    app.angleOverlay         = data.angleOverlay         ?? false;
    app.voiceFeedbackEnabled = data.voiceFeedbackEnabled  ?? true;
    app.strokeByStrokeMode   = data.strokeByStrokeMode    ?? false;
    const sbsToggle = document.getElementById('sbs-toggle');
    if (sbsToggle) sbsToggle.checked = app.strokeByStrokeMode;
  } catch(e) { console.warn('[TA] Could not load settings:', e); }
}

// Persists one setting field to this account's Firestore user doc. Silently
// no-ops when signed out — callers still update the in-memory app.* value
// first, so the UI stays responsive even if the save can't happen yet.
async function saveUserSetting(key, value) {
  const userId = fbAuth.currentUser?.uid;
  if (!userId) return;
  try {
    await fbDb.collection('users').doc(userId).set({ [key]: value }, { merge: true });
  } catch(e) { console.warn('[TA] Could not save setting (' + key + '):', e); }
}

async function toggleHandedness() {
  playerHandedness = playerHandedness === 'right' ? 'left' : 'right';
  updateHandednessBtn();
  await saveUserSetting('handedness', playerHandedness);
}

function updateHandednessBtn() {
  // Update the modal's handedness buttons if they're visible
  const isRight = playerHandedness === 'right';
  document.getElementById('sm-hand-right')?.classList.toggle('active', isRight);
  document.getElementById('sm-hand-left')?.classList.toggle('active', !isRight);
}

// ════════════════════════════════════════════════════════════
//  SETTINGS MODAL
// ════════════════════════════════════════════════════════════
function openSettings() {
  // Sync layout buttons + current indicator
  const savedLayout = localStorage.getItem('ta_layout');
  document.getElementById('sm-layout-desktop').classList.toggle('active', savedLayout === 'desktop');
  document.getElementById('sm-layout-mobile').classList.toggle('active', savedLayout === 'mobile');
  // Sync handedness buttons
  const isRight = playerHandedness === 'right';
  document.getElementById('sm-hand-right').classList.toggle('active', isRight);
  document.getElementById('sm-hand-left').classList.toggle('active', !isRight);
  // Sync auto-pause
  document.getElementById('sm-autopause-toggle').checked = app.strokeByStrokeMode;
  // Sync ball overlay
  document.getElementById('sm-ball-toggle').checked = app.ballDetectionOverlay;
  // Sync angle overlay
  document.getElementById('sm-angle-toggle').checked = app.angleOverlay;
  // Sync voice feedback
  document.getElementById('sm-voice-toggle').checked = app.voiceFeedbackEnabled;
  // Play area button — disabled if no clip loaded, label reflects current state
  const calibBtn = document.getElementById('sm-calib-btn');
  calibBtn.disabled = !app.activeClipId;
  calibBtn.textContent = courtCalib ? 'Mark again' : 'Mark area';
  document.getElementById('settings-backdrop').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-backdrop').classList.remove('open');
}

function onSettingsBackdropClick(e) {
  if (e.target === document.getElementById('settings-backdrop')) closeSettings();
}

// ── LAYOUT SELECTION ──────────────────────────────────────
function applyLayout(type) {
  document.body.classList.remove('force-desktop', 'force-mobile');
  if (type === 'desktop') document.body.classList.add('force-desktop');
  else if (type === 'mobile') document.body.classList.add('force-mobile');
}

function chooseLayout(type) {
  localStorage.setItem('ta_layout', type);
  applyLayout(type);
  document.getElementById('format-screen').classList.remove('visible');
  bootApp();
}

function settingsSetLayout(type) {
  localStorage.setItem('ta_layout', type);
  applyLayout(type);
  document.getElementById('sm-layout-desktop').classList.toggle('active', type === 'desktop');
  document.getElementById('sm-layout-mobile').classList.toggle('active', type === 'mobile');
  // Close mobile sidebar if switching to desktop
  if (type === 'desktop') closeMobileSidebar();
}

function bootApp() {
  if (!CONFIG_READY) {
    document.getElementById('setup-screen').classList.add('visible');
  } else {
    initFirebase(); // loadModels() now runs after login — see onAuthStateChanged
  }
}

function toggleMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const isOpen = sidebar.classList.contains('mob-open');
  sidebar.classList.toggle('mob-open', !isOpen);
  backdrop.classList.toggle('visible', !isOpen);
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('mob-open');
  document.getElementById('sidebar-backdrop').classList.remove('visible');
}

function toggleFullscreen() {
  const panel = document.getElementById('video-panel');
  const video = document.getElementById('video-el');
  const isFs  = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFs) {
    if      (panel.requestFullscreen)       panel.requestFullscreen().catch(() => {});
    else if (panel.webkitRequestFullscreen) panel.webkitRequestFullscreen();
    else if (video.webkitEnterFullscreen)   video.webkitEnterFullscreen(); // iOS Safari
  } else {
    if      (document.exitFullscreen)       document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}
function _updateFsBtn() {
  const btn = document.getElementById('btn-fullscreen');
  if (btn) btn.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? '✕' : '⛶';
}
document.addEventListener('fullscreenchange',       _updateFsBtn);
document.addEventListener('webkitfullscreenchange', _updateFsBtn);

// App-wide full screen (whole page, not just the video) — hides the browser's
// address bar/toolbar. Only works where the Fullscreen API supports arbitrary
// elements, which excludes iOS Safari entirely (it only supports it for
// <video>); there, the only way to hide that chrome is "Add to Home Screen"
// (see the manifest.json / apple-mobile-web-app meta tags in <head>).
function toggleAppFullscreen() {
  const el = document.documentElement;
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFs) {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    return;
  }
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else alert('Full screen isn\'t supported in this browser.\n\nOn iPhone: tap the Share button in Safari, then "Add to Home Screen" — opening the app from that icon hides the address bar automatically.');
}
function _updateAppFsBtn() {
  const btn = document.getElementById('sm-fullscreen-btn');
  if (!btn) return;
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  btn.textContent = isFs ? '✕ Exit' : '⛶ Enter';
}
document.addEventListener('fullscreenchange',       _updateAppFsBtn);
document.addEventListener('webkitfullscreenchange', _updateAppFsBtn);

function settingsSetHandedness(h) {
  if (playerHandedness === h) return;
  toggleHandedness(); // already updates the sm-hand-right/left buttons via updateHandednessBtn()
}

function settingsToggleAutoPause(on) {
  app.strokeByStrokeMode = on;
  // Keep existing #sbs-toggle in sync
  const el = document.getElementById('sbs-toggle');
  if (el) el.checked = on;
  saveUserSetting('strokeByStrokeMode', on);
}

function settingsToggleBallOverlay(on) {
  app.ballDetectionOverlay = on;
  saveUserSetting('ballDetectionOverlay', on);
}

function settingsToggleAngleOverlay(on) {
  app.angleOverlay = on;
  saveUserSetting('angleOverlay', on);
}

function settingsToggleVoiceFeedback(on) {
  app.voiceFeedbackEnabled = on;
  if (!on) {
    if (window.speechSynthesis) speechSynthesis.cancel();
  }
  saveUserSetting('voiceFeedbackEnabled', on);
}

function settingsOpenCalib() {
  closeSettings();
  startCalibration();
}

// ════════════════════════════════════════════════════════════
//  AUTH SCREEN
// ════════════════════════════════════════════════════════════
document.getElementById('auth-toggle').addEventListener('click', () => {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  const isSignup = authMode === 'signup';
  document.getElementById('auth-title').textContent      = isSignup ? 'Create your account' : 'Sign in to your account';
  document.getElementById('auth-submit').textContent     = isSignup ? 'Create Account' : 'Sign In';
  document.getElementById('auth-toggle').textContent     = isSignup ? 'Sign in instead' : 'Create account';
  document.getElementById('auth-footer-text').textContent= isSignup ? 'Already have an account?' : 'Don\'t have an account?';
  document.getElementById('auth-confirm').style.display  = isSignup ? '' : 'none';
  document.getElementById('auth-reset').style.display    = isSignup ? 'none' : '';
  document.getElementById('auth-password').autocomplete  = isSignup ? 'new-password' : 'current-password';
  showAuthError('');
});

document.getElementById('auth-submit').addEventListener('click', handleAuthSubmit);
document.getElementById('auth-email').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('auth-password').focus(); });
document.getElementById('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') handleAuthSubmit(); });
document.getElementById('auth-confirm').addEventListener('keydown', e => { if (e.key === 'Enter') handleAuthSubmit(); });

document.getElementById('auth-reset').addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  if (!email) { showAuthError('Enter your email address first.'); return; }
  try {
    await fbAuth.sendPasswordResetEmail(email);
    showAuthError('Reset email sent — check your inbox.', true);
  } catch (e) { showAuthError(friendlyAuthError(e)); }
});

async function handleAuthSubmit() {
  const btn = document.getElementById('auth-submit');
  // The Enter-key shortcuts on the password/confirm fields call this function
  // directly, bypassing the (disabled) button — so the re-entry guard has to
  // live here rather than relying on the button's disabled state alone.
  if (btn.disabled) return;

  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-password').value;
  const conf  = document.getElementById('auth-confirm').value;
  showAuthError('');

  if (!email || !pass) { showAuthError('Please fill in all fields.'); return; }
  if (authMode === 'signup' && pass !== conf) { showAuthError('Passwords do not match.'); return; }
  if (authMode === 'signup' && pass.length < 6) { showAuthError('Password must be at least 6 characters.'); return; }

  btn.disabled = true;
  btn.textContent = '…';

  try {
    if (authMode === 'signup') {
      await fbAuth.createUserWithEmailAndPassword(email, pass);
    } else {
      await fbAuth.signInWithEmailAndPassword(email, pass);
    }
    // onAuthStateChanged fires → showMain()
  } catch (e) {
    showAuthError(friendlyAuthError(e));
    btn.disabled = false;
    btn.textContent = authMode === 'signup' ? 'Create Account' : 'Sign In';
  }
}

function showAuthError(msg, isInfo) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
  el.style.color = isInfo ? '#79c0ff' : '#ffa198';
  el.style.borderColor = isInfo ? 'rgba(88,166,255,0.35)' : 'rgba(248,81,73,0.35)';
  el.style.background  = isInfo ? 'rgba(88,166,255,0.1)' : 'rgba(248,81,73,0.12)';
}

function friendlyAuthError(e) {
  const map = {
    'auth/user-not-found':    'No account found with that email.',
    'auth/wrong-password':    'Incorrect password.',
    'auth/invalid-email':     'Invalid email address.',
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/network-request-failed': 'Network error — check your connection.',
    'auth/invalid-credential': 'Incorrect email or password.',
  };
  return map[e.code] || e.message;
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  // Stop every background process before tearing down auth — otherwise the
  // scan loop / camera keep running (and racing saveScanResults() against a
  // currentUser that's about to go null) after the user thinks they've signed out.
  stopScan();               // signal any in-progress background scan to bail
  window.closeRecordModal(); // stop MediaRecorder + release the camera, if recording
  stopLoop();               // stop the live-detection animation frame loop
  videoEl.pause();
  // Flush whatever stroke results/deletions are in memory while we still have
  // a valid signed-in user — saveScanResults() silently no-ops once signed out.
  await saveScanResults();
  app.activeClipId = null;
  app.landmarks = null;
  app.racquetBox = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  await fbAuth.signOut();
});

// ════════════════════════════════════════════════════════════
//  VIDEO LIBRARY  (Firebase Storage + Firestore)
// ════════════════════════════════════════════════════════════
function subscribeVideos(userId) {
  if (unsubVideos) unsubVideos();
  app.clipsLoaded = false;
  unsubVideos = fbDb
    .collection('users').doc(userId)
    .collection('videos')
    .orderBy('uploadedAt', 'desc')
    .onSnapshot(
      snap => {
        app.clipsLoaded = true;
        app.clips = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderClipList();
        // Auto-open a clip after recording upload
        if (app._pendingAutoSelect) {
          const found = app.clips.find(c => c.id === app._pendingAutoSelect);
          if (found) { app._pendingAutoSelect = null; selectClip(found.id); }
        }

        if (app.activeClipId) {
          const freshClip = app.clips.find(c => c.id === app.activeClipId);

          // Guard against the cache-then-server double-fire race: if Firestore just
          // delivered real, COMPLETE scan results for the active clip while a scan is
          // already running (started from stale cache data), cancel the scan and use
          // the cached results instead. Must require scanComplete — otherwise a
          // partial cached result (loadCachedScan() rejects it) would still stop the
          // active scan here first, leaving nothing running and nothing loaded.
          if (app.scanning && freshClip?.scanResults?.length && (freshClip.scanVersion ?? 0) >= SCAN_VERSION
              && freshClip.scanComplete === true) {
            stopScan();
            loadCachedScan(freshClip);
          }

          // If the active clip now has courtCalib from Firestore but we don't have
          // it locally yet (e.g. saved on another device after this clip was opened),
          // apply and render it immediately.
          if (!courtCalib && freshClip?.courtCalib?.points?.length >= 3) {
            applyCourtCalib(freshClip.courtCalib);
            saveCourtCalib(app.activeClipId, freshClip.courtCalib.points);
            drawOverlay();
          }
        }
      },
      err => console.error('[TA] Firestore error:', err)
    );
}

async function uploadClips(files, { autoSelect = false, fromRecording = false } = {}) {
  const userId = fbAuth.currentUser?.uid;
  if (!userId) return;

  for (const file of files) {
    if (!file.type.startsWith('video/')) continue;

    const uid       = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const upEntry   = { id: uid, name: file.name, progress: 0, error: null };
    app.uploads.push(upEntry);
    renderClipList();

    const path      = `users/${userId}/videos/${uid}/${file.name}`;
    const ref       = fbStorage.ref(path);
    const task      = ref.put(file, { contentType: file.type });

    task.on('state_changed',
      snap => {
        upEntry.progress = Math.round(snap.bytesTransferred / snap.totalBytes * 100);
        renderClipList();
      },
      err => {
        upEntry.error = err.message;
        renderClipList();
        setTimeout(() => {
          app.uploads = app.uploads.filter(u => u.id !== uid);
          renderClipList();
        }, 4000);
      },
      async () => {
        const downloadURL = await task.snapshot.ref.getDownloadURL();
        await fbDb
          .collection('users').doc(userId)
          .collection('videos').doc(uid)
          .set({
            name:        file.name,
            size:        file.size,
            uploadedAt:  firebase.firestore.FieldValue.serverTimestamp(),
            storagePath: path,
            downloadURL,
            ...(fromRecording ? { fromRecording: true } : {}),
          });
        app.uploads = app.uploads.filter(u => u.id !== uid);
        if (autoSelect) app._pendingAutoSelect = uid;
        // Firestore listener will add the clip to app.clips
      }
    );
  }
}

async function deleteClip(clipId) {
  if (!confirm('Permanently delete this video?')) return;
  const userId = fbAuth.currentUser?.uid;
  if (!userId) return;
  const clip = app.clips.find(c => c.id === clipId);
  if (!clip) return;

  try {
    if (clip.storagePath) await fbStorage.ref(clip.storagePath).delete();
    await fbDb.collection('users').doc(userId).collection('videos').doc(clipId).delete();
    // Court calibration also lives in localStorage, keyed by clip ID, outside
    // Firestore — clean it up too, or it's an orphaned entry left behind forever.
    try { localStorage.removeItem(calibLocalKey(clipId)); } catch(e) {}

    if (app.activeClipId === clipId) {
      // Stop any scan still running against this clip — otherwise it keeps
      // processing frames in the background and its eventual saveScanResults()
      // races the just-deleted Firestore doc (harmless since app.activeClipId
      // is cleared below, but pointless wasted work in the meantime).
      stopScan();
      stopLoop();
      videoEl.pause();
      videoEl.removeAttribute('src');
      if (app.activeBlobUrl) { URL.revokeObjectURL(app.activeBlobUrl); app.activeBlobUrl = null; }
      app.landmarks = null;
      app.racquetBox = null;
      app.activeClipId = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      showSection('upload');
    }
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

async function renameClip(clipId) {
  const userId = fbAuth.currentUser?.uid;
  if (!userId) return;
  const clip = app.clips.find(c => c.id === clipId);
  if (!clip) return;

  const input = prompt('Rename video', clip.name || '');
  if (input === null) return; // cancelled
  const newName = input.trim();
  if (!newName || newName === clip.name) return;

  try {
    await fbDb.collection('users').doc(userId).collection('videos').doc(clipId).update({ name: newName });
    // Firestore listener will refresh app.clips and re-render
  } catch (err) {
    alert('Rename failed: ' + err.message);
  }
}

function renderClipList() {
  const list = document.getElementById('clip-list');
  if (!app.clips.length && !app.uploads.length) {
    list.innerHTML = app.clipsLoaded
      ? `<div class="clip-empty">No videos yet.<br>Upload one to start.</div>`
      : `<div class="clip-empty"><div class="clip-loading-spinner"></div>Loading videos…</div>`;
    return;
  }

  const uploadHTML = app.uploads.map(u => `
    <div class="clip-upload${u.error ? ' error' : ''}">
      <div class="clip-upload-icon">${u.error ? '⚠' : '↑'}</div>
      <div class="clip-upload-info">
        <div class="clip-upload-name">${escHtml(u.name)}</div>
        ${u.error
          ? `<div class="clip-upload-pct" style="color:#ffa198">${escHtml(u.error)}</div>`
          : `<div class="clip-upload-bar"><div class="clip-upload-fill" style="width:${u.progress}%"></div></div>
             <div class="clip-upload-pct">${u.progress}% — uploading…</div>`}
      </div>
    </div>`).join('');

  const clipsHTML = app.clips.map(c => `
    <div class="clip-item${c.id === app.activeClipId ? ' active' : ''}" data-id="${c.id}">
      <div class="clip-thumb">▶</div>
      <div class="clip-info">
        <div class="clip-name" title="${escHtml(c.name)}">${escHtml(c.name)}</div>
        <div class="clip-meta">${c._duration ? fmtTime(c._duration) + ' · ' : ''}${fmtSize(c.size || 0)}</div>
      </div>
      <div class="clip-actions">
        <button class="clip-act clip-rename" data-clip-id="${c.id}" title="Rename">✎</button>
        <button class="clip-act clip-del" data-clip-id="${c.id}" title="Delete">×</button>
      </div>
    </div>`).join('');

  list.innerHTML = uploadHTML + clipsHTML;
}

document.getElementById('clip-list').addEventListener('click', e => {
  const renameBtn = e.target.closest('.clip-rename');
  if (renameBtn) { e.stopPropagation(); renameClip(renameBtn.dataset.clipId); return; }
  const delBtn = e.target.closest('.clip-del');
  if (delBtn) { e.stopPropagation(); deleteClip(delBtn.dataset.clipId); return; }
  const item = e.target.closest('.clip-item');
  if (item) selectClip(item.dataset.id);
});

async function selectClip(id) {
  const clip = app.clips.find(c => c.id === id);
  if (!clip) return;

  const myGen = ++app.clipSelectGeneration;

  closeMobileSidebar();
  stopLoop();
  videoEl.pause();
  videoEl.removeAttribute('src');
  if (app.activeBlobUrl) { URL.revokeObjectURL(app.activeBlobUrl); app.activeBlobUrl = null; }
  app.landmarks      = null;
  app.racquetBox     = null;
  app.activeClipId   = id;
  app.activeClipIsRecording = !!(clip.fromRecording || clip.name?.toLowerCase().endsWith('.webm'));
  app.recMode        = false;   // ensure recording state is fully cleared
  app.recRecording   = false;

  // Reset calibration UI for the new clip
  hideCalibBanner();
  cancelCalibration();
  applyCourtCalib(null);
  app.frameCount       = 0;
  app.detFrames        = 0;
  app.lastDetVideoTime = -1;
  app.lastFpsUpdate    = performance.now();
  document.getElementById('det-fps').textContent = '';
  stopScan();
  resetStrokeDetector();
  stroke.frozenResult       = null;
  stroke.markers            = [];
  stroke.deletedTimes       = clip.deletedStartTimes || [];
  stroke.lastStrokeVT       = -999;
  stroke.pendingServeCheck  = null;
  stroke.wristHistory       = [];
  scan.pendingServeCheck    = null;
  scan.wristHistory         = [];
  app.scanComplete          = false;
  scan.prevPos        = null;
  scan.active         = false;
  scan.lastStrokeVT   = -999;
  scan.slowSinceVT    = null;
  scan.lastRedVT      = null;
  renderStrokeMarkers();

  app.lastPausedMarkerVT = -Infinity;
  app.lastShownMarkerVT  = -Infinity;
  app.lastLandmarkVT     = -Infinity;
  app.lastNoBodyWarnVT   = -Infinity;
  hideUndoBar();
  hideNoBodyBar();
  hideBadPoseBar();
  hideDetectErrorBar();
  renderClipList();
  showSection('analyzer');
  showLoading(true, 'Loading video…');

  // Reset playback controls to default state
  document.getElementById('btn-pp').textContent = '▶';
  const speedPick = document.getElementById('speed-pick');
  speedPick.value = '1';
  videoEl.playbackRate = 1;

  const srcUrl = clip.downloadURL || clip.url;
  app.activeVideoSrcUrl = srcUrl;
  app.videoRetryCount = 0;
  if (app.activeClipIsRecording) {
    // Loading the remote URL directly into <video crossorigin> leaves it subject to
    // cross-origin canvas tainting — some mobile browsers (notably iOS Safari/WebKit)
    // enforce this inconsistently for MediaRecorder-produced clips: playback works
    // fine, but drawImage/getImageData (and MediaPipe's internal frame reads) throw
    // "SecurityError: The operation is insecure." Fetching the bytes into a local
    // Blob and playing that via an object URL sidesteps it — blob: URLs are always
    // same-origin for canvas purposes regardless of how the data was fetched.
    try {
      const resp = await fetch(srcUrl);
      const blob = await resp.blob();
      if (myGen !== app.clipSelectGeneration) return; // superseded by a newer selectClip()
      app.activeBlobUrl = URL.createObjectURL(blob);
      videoEl.src = app.activeBlobUrl;
    } catch (e) {
      console.warn('[TA] Blob fetch failed, falling back to direct URL:', e);
      if (myGen !== app.clipSelectGeneration) return;
      videoEl.src = srcUrl;
    }
  } else {
    videoEl.src = srcUrl;
  }
  videoEl.load();
}

// ════════════════════════════════════════════════════════════
//  VIDEO EVENTS
// ════════════════════════════════════════════════════════════
videoEl.addEventListener('loadedmetadata', () => {
  showLoading(false);
  updateScrub();
  document.getElementById('feedback-scroll').innerHTML = '';
  // Cache duration on the clip object and re-render the sidebar
  if (app.activeClipId && videoEl.duration) {
    const clip = app.clips.find(c => c.id === app.activeClipId);
    if (clip) { clip._duration = videoEl.duration; renderClipList(); }
  }
  // Legacy clips recorded before _fixWebmDuration() existed still report
  // duration as Infinity (scrub bar never fills, time label never shows a
  // total). Force the browser to index the file and discover the real
  // duration by seeking past the end, then return to where we were.
  if (!isFinite(videoEl.duration)) _fixInfiniteDuration();
});

function _fixInfiniteDuration() {
  const resumeAt = videoEl.currentTime;
  const onDurationChange = () => {
    videoEl.removeEventListener('durationchange', onDurationChange);
    videoEl.currentTime = resumeAt;
    updateScrub();
    if (app.activeClipId && isFinite(videoEl.duration)) {
      const clip = app.clips.find(c => c.id === app.activeClipId);
      if (clip) { clip._duration = videoEl.duration; renderClipList(); }
    }
  };
  videoEl.addEventListener('durationchange', onDurationChange);
  videoEl.currentTime = 1e101;
}

videoEl.addEventListener('loadeddata', () => {
  syncCanvas();
  resetBallMotion();

  // Load or prompt court calibration — prefer Firestore, fall back to localStorage
  const clipId = app.activeClipId;
  if (clipId) {
    const clip = app.clips.find(c => c.id === clipId);
    const firestoreCalib = clip?.courtCalib?.points?.length >= 3 ? clip.courtCalib : null;
    const saved = firestoreCalib || loadCourtCalib(clipId);
    // Sync Firestore data back to localStorage if not already there
    if (firestoreCalib && !loadCourtCalib(clipId)) saveCourtCalib(clipId, firestoreCalib.points);
    applyCourtCalib(saved);
    if (!saved) showCalibBanner();
    drawOverlay(); // render polygon immediately without waiting for pose detection
  }

  tryStartScan(); // auto-scan once video and models are both ready
});

videoEl.addEventListener('play', () => {
  document.getElementById('btn-pp').textContent = '⏸';
  document.getElementById('live-dot').classList.remove('off');
  // Reset no-body clocks so we don't fire immediately if there was a recent gap
  app.lastLandmarkVT   = videoEl.currentTime;
  app.lastNoBodyWarnVT = videoEl.currentTime;
  startLoop();
});

videoEl.addEventListener('pause', () => {
  document.getElementById('btn-pp').textContent = '▶';
  document.getElementById('live-dot').classList.add('off');
  drawOverlay();
});

videoEl.addEventListener('ended', () => {
  document.getElementById('btn-pp').textContent = '▶';
  document.getElementById('live-dot').classList.add('off');
  stopLoop();
  resetBallMotion();
  // Do NOT touch app.scanning here — the background scan runs on its own
  // separate scanEl with its own independent timeline/seek position. The
  // main video reaching the end of normal playback has nothing to do with
  // whether the scan (which could be anywhere in the video) has finished.
});

videoEl.addEventListener('seeked', () => {
  if (app.sbsPauseTimeout) { clearTimeout(app.sbsPauseTimeout); app.sbsPauseTimeout = null; }
  resetStrokeDetector();
  resetBallMotion();
  app.lastDetVideoTime = -1; // allow detection to fire immediately after seek
  stroke.lastStrokeVT = videoEl.currentTime - stroke.COOLDOWN - 0.01;
  app.lastPausedMarkerVT = videoEl.currentTime; // only pause on markers after the seek point
  app.lastShownMarkerVT  = videoEl.currentTime; // only auto-show markers after the seek point
  updateScrub();
  if (app.modelsReady && !app.detecting && !app.scanning) detectFrame();
});

videoEl.addEventListener('timeupdate', () => {
  updateScrub();
  if (app.scanning) updateScanProgressUI();

  if (videoEl.paused || app.scanning) return;
  const vt = videoEl.currentTime;

  // No-body detection: show bottom-bar warning if landmarks absent for 1.5 s.
  // Does NOT pause — the user can keep watching or choose to skip.
  if (app.modelsReady && app.lastLandmarkVT > -Infinity) {
    const noBodyFor = vt - app.lastLandmarkVT;
    const recentlyWarned = vt - app.lastNoBodyWarnVT < 5.0;
    if (noBodyFor > 1.5 && !recentlyWarned) {
      app.lastNoBodyWarnVT = vt;
      showNoBodyBar();
    }
  }

  // Auto-pause: driven by scan markers so every detected stroke gets a pause,
  // regardless of whether live detection caught it.
  if (app.strokeByStrokeMode) {
    const pending = stroke.markers.find(m => {
      if (m.startTime <= app.lastPausedMarkerVT) return false;
      const pauseAt = m.endTime != null ? m.endTime + 0.2 : m.startTime + 1.0;
      return vt >= pauseAt;
    });
    if (pending) {
      app.lastPausedMarkerVT = pending.startTime;
      videoEl.pause();
      showMarkerFeedback(pending, stroke.markers.indexOf(pending));
    }
  } else {
    // Continuous playback: show each stroke's score/feedback the moment the
    // scrubber reaches its tick mark, driven purely by marker position vs.
    // playback time — not by live pose re-detection matching a scan marker
    // (see processStroke()), which can drift out of sync and previously left
    // the panel stuck on an old stroke or blank entirely for cached/rescanned
    // clips. Every marker already has its score/cards computed (from the scan
    // or from cache), so there's nothing to detect here — just reveal it.
    const nextMarker = stroke.markers.find(m => {
      if (m.startTime <= app.lastShownMarkerVT) return false;
      const revealAt = m.endTime != null ? m.endTime + 0.2 : m.startTime + 1.0;
      return vt >= revealAt;
    });
    if (nextMarker) {
      app.lastShownMarkerVT = nextMarker.startTime;
      showMarkerFeedback(nextMarker, stroke.markers.indexOf(nextMarker));
    }
  }
});

const VIDEO_LOAD_MAX_RETRIES = 4;
const VIDEO_LOAD_RETRY_DELAY_MS = 1500;

videoEl.addEventListener('error', () => {
  const err = videoEl.error;
  if (err?.code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && err?.code !== MediaError.MEDIA_ERR_NETWORK) return;
  if (!videoEl.getAttribute('src')) return; // no real source assigned (e.g. element was just cleared) — nothing to retry

  // These errors are often transient (e.g. a Firebase Storage download URL that
  // isn't fully propagated yet) and resolve on their own a few seconds later, so
  // retry quietly behind the loading spinner instead of alarming the user.
  if (app.activeVideoSrcUrl && app.videoRetryCount < VIDEO_LOAD_MAX_RETRIES) {
    app.videoRetryCount++;
    const myGen = app.clipSelectGeneration;
    showLoading(true, 'Loading video, please wait…');
    setTimeout(() => {
      if (myGen !== app.clipSelectGeneration || !app.activeVideoSrcUrl) return; // superseded by a newer selectClip()
      videoEl.src = app.activeVideoSrcUrl;
      videoEl.load();
    }, VIDEO_LOAD_RETRY_DELAY_MS);
    return;
  }

  showLoading(false);
  document.getElementById('feedback-scroll').innerHTML = `
    <div class="fb-waiting">
      Couldn't load this video.<br><br>
      Please check your connection and try again.
    </div>`;
});

// ════════════════════════════════════════════════════════════
//  CANVAS SYNC
//  With object-fit:contain the video ELEMENT fills the viewport
//  but the rendered content is letterboxed inside it. We must
//  position the canvas over the content area, not the element.
// ════════════════════════════════════════════════════════════
function syncCanvas() {
  const vpr = document.getElementById('video-viewport').getBoundingClientRect();
  const vr  = videoEl.getBoundingClientRect(); // element rect (full viewport)

  // Intrinsic video dimensions
  const vw = videoEl.videoWidth  || vr.width;
  const vh = videoEl.videoHeight || vr.height;
  if (vr.width < 1 || vr.height < 1) return;

  // Calculate the actual rendered content rect within the element
  // (object-fit: contain — letterbox on the short axis)
  const elemAspect    = vr.width / vr.height;
  const videoAspect   = vw / vh;
  let contentW, contentH, contentOffsetX, contentOffsetY;
  if (videoAspect > elemAspect) {
    // Wider than element → black bars top & bottom
    contentW       = vr.width;
    contentH       = vr.width / videoAspect;
    contentOffsetX = 0;
    contentOffsetY = (vr.height - contentH) / 2;
  } else {
    // Taller than element → black bars left & right
    contentH       = vr.height;
    contentW       = vr.height * videoAspect;
    contentOffsetX = (vr.width - contentW) / 2;
    contentOffsetY = 0;
  }

  // Position canvas relative to the viewport container
  const newL = Math.round(vr.left - vpr.left + contentOffsetX);
  const newT = Math.round(vr.top  - vpr.top  + contentOffsetY);
  const newW = Math.round(contentW);
  const newH = Math.round(contentH);

  if (newW < 1 || newH < 1) return;

  if (newL !== app.canvasL || newT !== app.canvasT || newW !== app.canvasW || newH !== app.canvasH) {
    canvas.style.left   = newL + 'px';
    canvas.style.top    = newT + 'px';
    canvas.style.width  = newW + 'px';
    canvas.style.height = newH + 'px';
    canvas.width  = newW;
    canvas.height = newH;
    app.canvasL = newL; app.canvasT = newT;
    app.canvasW = newW; app.canvasH = newH;
  }
}


// Landmarks map 1:1 to canvas since canvas now covers exactly the content area
function lmPx(lm) {
  return { x: lm.x * canvas.width, y: lm.y * canvas.height };
}

window.addEventListener('resize', () => { syncCanvas(); drawOverlay(); });

// ════════════════════════════════════════════════════════════
//  DETECTION LOOP
// ════════════════════════════════════════════════════════════
function startLoop() {
  stopLoop();
  app.detecting = false; // clear any stuck flag from a detection that ended mid-await
  // Only clear a STALE scanSending flag left over from a scan that already
  // stopped — onPoseResults() routes purely on this flag, so if a scan is
  // still actively running, clearing it here would steal its in-flight pose
  // result into live processing instead of processScanStroke(). loop() below
  // already skips real detection work entirely while app.scanning is true,
  // so there's nothing for the live path to gain by resetting it in that case.
  if (!app.scanning) app.scanSending = false;
  loop();
}

// Returns true if the detected racquet bbox centre is within
// a reasonable distance of either wrist landmark.
// Filters out false positives on crowd/background objects.
function isRacquetNearWrist(bbox) {
  if (!app.landmarks) return true; // no pose yet — allow it through
  const [rx, ry, rw, rh] = bbox;
  const cx = (rx + rw / 2) / (videoEl.videoWidth  || 1); // normalised 0-1
  const cy = (ry + rh / 2) / (videoEl.videoHeight || 1);
  const wrists = [app.landmarks[LM.L_WRIST], app.landmarks[LM.R_WRIST]];
  return wrists.some(w => {
    if (!w || w.visibility < 0.4) return false;
    const dx = cx - w.x, dy = cy - w.y;
    return Math.sqrt(dx * dx + dy * dy) < 0.3; // within 30% of frame width
  });
}

function stopLoop() {
  if (app.rafId) { cancelAnimationFrame(app.rafId); app.rafId = null; }
  app.liveBallPos = null;
  app.ballTrail   = [];
}

async function loop() {
  if (videoEl.paused || videoEl.ended) return;

  // Keep canvas aligned to video every frame (cheap rect read)
  syncCanvas();

  // During background scan: keep drawing the overlay with last known landmarks
  if (app.scanning) {
    drawOverlay();
    app.rafId = requestAnimationFrame(loop);
    return;
  }

  app.frameCount++;

  // Live ball detection — runs every 3 frames on a small offscreen canvas
  // Run ball detection every 40ms of video time, regardless of playback speed.
  // This keeps the ball's displacement between detections constant — at 2× speed
  // we detect twice as often in real time so the ball hasn't moved further.
  const DET_VIDEO_INTERVAL = 0.04; // seconds of video time between detections
  const curVT = videoEl.currentTime;
  if (!videoEl.paused && videoEl.videoWidth &&
      (curVT - app.lastDetVideoTime) >= DET_VIDEO_INTERVAL) {
    app.lastDetVideoTime = curVT;
    const now = performance.now();

    // Wrapped in try/catch: drawImage/getImageData on some mobile browsers can throw
    // (e.g. a tainted-canvas SecurityError) for content that plays back just fine.
    // An uncaught throw here would stop this async function before it reaches
    // requestAnimationFrame(loop) below, silently killing ALL live detection
    // (pose included) for the rest of playback — one bad frame shouldn't do that.
    try {
      // Build search regions from recent valid detections.
      // Expire entries older than BALL_RESET_MS, then pass all survivors as search circles.
      // A cluster passes if it's near ANY of them — covers both sides of the court.
      const SEARCH_RADIUS = 0.5;
      ballLastValidList = ballLastValidList.filter(p => now - p.t <= BALL_RESET_MS);
      const searchRegions = ballLastValidList.length > 0
        ? ballLastValidList.map(p => ({ cx: p.x, cy: p.y, r: SEARCH_RADIUS }))
        : null; // null = full-frame search until first detection

      ballDetCtx.drawImage(videoEl, 0, 0, 640, 360);
      const playerMask = buildPlayerMask(app.landmarks, 640, 360);
      const rawPos = detectBall(ballDetCtx, 640, 360, searchRegions, courtCalib?.points, playerMask);

      // Record cluster bounding boxes for the cluster outline debug overlay.
      if (!app.debugClusterHistory) app.debugClusterHistory = [];
      if (app.debugClusters && app.debugClusters.length > 0)
        app.debugClusterHistory.push({ clusters: app.debugClusters, t: now });
      app.debugClusterHistory = app.debugClusterHistory.filter(e => now - e.t < 2000);

      // Accept detection directly — append to list, no velocity gating.
      app.liveBallPos = rawPos || null;
      if (rawPos) {
        ballLastValidList.push({ x: rawPos.x, y: rawPos.y, t: now });
        app.ballTrail.push({ x: rawPos.x, y: rawPos.y, t: now });
        const TRAIL_MS = 3000;
        app.ballTrail = app.ballTrail.filter(p => now - p.t < TRAIL_MS);
      }
    } catch (e) {
      console.warn('[TA] Ball detection:', e);
      showDetectErrorBar();
    }
  }

  if (!app.detecting && app.modelsReady && !app.scanning) {
    app.detecting = true;
    // Always draw to an offscreen canvas first rather than feeding the <video>
    // element straight into MediaPipe's WebGL texture pipeline — that can silently
    // yield blank/empty results on some mobile browsers, not just for recordings/
    // infinite-duration clips as originally assumed here (regular finite-duration
    // uploads can hit it too, which showed up as feedback/scores never updating
    // during mobile playback). The background scan already does this unconditionally
    // for every clip type and doesn't have this problem — match that here.
    let _sendImg = videoEl;
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (vw && vh && videoEl.readyState >= 2) {
      // drawImage() on a cross-origin video can throw a SecurityError on some
      // mobile browsers even with crossorigin="anonymous" set, if the CORS
      // response for that particular request is missing/inconsistent. Since this
      // runs unguarded right before the rAF loop reschedules itself, an uncaught
      // throw here would silently kill the entire live loop (overlay, ball
      // detection, everything) with no console trace — it would just stop.
      try {
        if (poseDetCanvas.width  !== vw) poseDetCanvas.width  = vw;
        if (poseDetCanvas.height !== vh) poseDetCanvas.height = vh;
        poseDetCtx.drawImage(videoEl, 0, 0);
        _sendImg = poseDetCanvas;
      } catch (e) {
        console.warn('[TA] drawImage failed (likely a tainted cross-origin video) — falling back to sending the raw video element:', e);
      }
    }
    // Fire-and-forget — mirrors _recLoop pattern which is proven to work for live camera.
    // Using await here risks concurrent sends (old scan + new loop) that can permanently
    // hang MediaPipe's internal queue. Fire-and-forget avoids that race.
    app.poseModel.send({ image: _sendImg })
      .catch(e => console.warn('[TA] Detection:', e))
      .finally(() => {
        app.detecting = false;
        // FPS display
        app.detFrames++;
        const now = performance.now();
        if (now - app.lastFpsUpdate > 1000) {
          document.getElementById('det-fps').textContent =
            Math.round(app.detFrames * 1000 / (now - app.lastFpsUpdate)) + ' fps';
          app.detFrames = 0;
          app.lastFpsUpdate = now;
        }
      });

    if (app.frameCount % 20 === 0 && app.cocoModel && !app.scanning) {
      app.cocoModel.detect(videoEl).then(preds => {
        const racquet = preds.find(p =>
          p.class === 'tennis racket' &&
          p.score > 0.6 &&
          isRacquetNearWrist(p.bbox)
        );
        if (racquet) {
          const scaleX = canvas.width  / videoEl.videoWidth;
          const scaleY = canvas.height / videoEl.videoHeight;
          const [rx, ry, rw, rh] = racquet.bbox;
          app.racquetBox = { x: rx*scaleX, y: ry*scaleY, w: rw*scaleX, h: rh*scaleY };
        } else {
          app.racquetBox = null;
        }
      }).catch(() => {});
    }
  }

  app.rafId = requestAnimationFrame(loop);
}

async function detectFrame() {
  if (!app.modelsReady || app.detecting) return;
  app.detecting = true;
  try {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (vw && vh) {
      if (poseDetCanvas.width  !== vw) poseDetCanvas.width  = vw;
      if (poseDetCanvas.height !== vh) poseDetCanvas.height = vh;
      poseDetCtx.drawImage(videoEl, 0, 0);
    }
    await app.poseModel.send({ image: vw ? poseDetCanvas : videoEl });
    // Also run racquet detection on seek/replay so the box appears immediately
    if (app.cocoModel) {
      const preds   = await app.cocoModel.detect(videoEl);
      const racquet = preds.find(p => p.class === 'tennis racket' && p.score > 0.6 && isRacquetNearWrist(p.bbox));
      if (racquet) {
        const scaleX = canvas.width  / videoEl.videoWidth;
        const scaleY = canvas.height / videoEl.videoHeight;
        const [rx, ry, rw, rh] = racquet.bbox;
        app.racquetBox = { x: rx*scaleX, y: ry*scaleY, w: rw*scaleX, h: rh*scaleY };
      } else {
        app.racquetBox = null;
      }
      drawOverlay();
    }
  } catch(e) {/* */}
  app.detecting = false;
}

// ════════════════════════════════════════════════════════════
//  POSE RESULTS → DRAW + STROKE DETECTION
// ════════════════════════════════════════════════════════════
function onPoseResults(results) {
  // ── Recording mode: draw skeleton on rec canvas, run live stroke detection ──
  if (app.recMode) {
    app.landmarks = results.poseLandmarks || null;
    if (app.landmarks && app.recRecording) processStroke(app.landmarks);
    const rc = document.getElementById('rec-canvas');
    if (rc && rc.width > 0) drawRecOverlay(rc.getContext('2d'), rc);
    // Live joint-angle feedback panel — throttled to every few frames so DOM
    // updates don't compete with the pose-detection loop for CPU.
    app._recFeedbackFrames = (app._recFeedbackFrames || 0) + 1;
    if (app._recFeedbackFrames % 5 === 0) renderRecFeedback(app.landmarks);
    return;
  }

  if (app.scanSending) {
    if (app.scanning && results.poseLandmarks) {
      app.scanPoses++;
      processScanStroke(results.poseLandmarks);
    }
    return;
  }

  // Live detection path
  app.landmarks = results.poseLandmarks || null;
  if (app.landmarks) {
    app.lastLandmarkVT = videoEl.currentTime;
    hideNoBodyBar();
    if (isAnatomicallyImpossible(app.landmarks)) {
      showBadPoseBar();
    } else {
      hideBadPoseBar();
    }
    if (!videoEl.paused) processStroke(app.landmarks);
  }
  drawOverlay();
}

// ════════════════════════════════════════════════════════════
//  CANVAS DRAWING
// ════════════════════════════════════════════════════════════
function drawOverlay() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Play area calibration outline
  if (courtCalib && courtCalib.points && courtCalib.points.length >= 3 && !calib.active) {
    const pts = courtCalib.points;
    const cw = canvas.width, ch = canvas.height;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x * cw, pts[0].y * ch);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * cw, pts[i].y * ch);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(63,185,80,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(63,185,80,0.04)';
    ctx.fill();
    // Small vertex dots
    pts.forEach((pt, i) => {
      ctx.beginPath();
      ctx.arc(pt.x * cw, pt.y * ch, 3, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#f78166' : '#3fb950';
      ctx.fill();
    });
    ctx.restore();
  }

  const lms = app.landmarks;

  if (lms) {
    // Skeleton
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(88,166,255,0.75)';
    for (const [a, b] of SKELETON_EDGES) {
      const pa = lms[a], pb = lms[b];
      if (!pa || !pb || pa.visibility < 0.35 || pb.visibility < 0.35) continue;
      const pa2 = lmPx(pa), pb2 = lmPx(pb);
      ctx.beginPath(); ctx.moveTo(pa2.x, pa2.y); ctx.lineTo(pb2.x, pb2.y); ctx.stroke();
    }

    // Joints
    const _mob = document.body.classList.contains('force-mobile') ||
      (!document.body.classList.contains('force-desktop') && window.innerWidth <= 768);
    for (let i = 0; i < lms.length; i++) {
      const lm = lms[i];
      if (!lm || lm.visibility < 0.35) continue;
      const pt = lmPx(lm);
      const dotR = _mob ? (i < 11 ? 1 : 2) : (i < 11 ? 4 : 5);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, dotR, 0, Math.PI*2);
      ctx.fillStyle = jointColor(i); ctx.fill();
      if (!_mob) { ctx.strokeStyle = '#00000066'; ctx.lineWidth = 1.5; ctx.stroke(); }
    }

    // Angle labels (shown only when angle overlay is enabled)
    if (app.angleOverlay) {
      drawAngleLabel(lms, LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST);
      drawAngleLabel(lms, LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST);
      drawAngleLabel(lms, LM.L_HIP, LM.L_KNEE, LM.L_ANKLE);
      drawAngleLabel(lms, LM.R_HIP, LM.R_KNEE, LM.R_ANKLE);
    }

  }


  // Racquet box
  if (app.racquetBox) {
    const { x, y, w, h } = app.racquetBox;
    ctx.strokeStyle = '#f0a020'; ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(240,160,32,0.1)'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#f0a020';
    ctx.font = 'bold 11px sans-serif';
    ctx.shadowColor = '#00000099'; ctx.shadowBlur = 3;
    ctx.fillText('Racquet', x+4, y > 14 ? y-4 : y+h+13);
    ctx.shadowBlur = 0;
  }

  // Cluster outlines — cyan rectangle around each cluster that survived all
  // post-filters (persistence + adjacency + connectivity). Fades over 2 s so
  // brief detections remain visible. Hover shows pixel count.
  if (app.debugClusterHistory && app.debugClusterHistory.length > 0) {
    const cw = canvas.width, ch = canvas.height;
    const nowT = performance.now();
    const FADE_MS = 2000;

    // A cluster must have been seen in roughly the same area in a recent previous
    // entry (within CONFIRM_MS) before it is drawn. One-off detections are hidden.
    const CONFIRM_MS   = 300;          // look-back window (~7 frames at 40 ms each)
    const CONFIRM_DIST = 0.15;         // normalised proximity (~96 px on 640-wide frame)
    const CONFIRM_D2   = CONFIRM_DIST * CONFIRM_DIST;

    // Newest visible entry — only circles from this entry count toward the warning.
    const newestT = app.debugClusterHistory.reduce((max, e) => {
      const f = Math.max(0, 1 - (nowT - e.t) / FADE_MS);
      return f > 0 ? Math.max(max, e.t) : max;
    }, -Infinity);
    let newCircleCount = 0;

    // First pass: collect all drawable circles without rendering.
    // This lets us know newCircleCount before deciding whether to draw.
    const renderedCircles = [];
    const circlesToDraw = []; // { circX, circY, circR, frac, isNew }
    for (let ei = 0; ei < app.debugClusterHistory.length; ei++) {
      const entry = app.debugClusterHistory[ei];
      const frac = Math.max(0, 1 - (nowT - entry.t) / FADE_MS);
      if (frac <= 0) continue;
      for (const cl of entry.clusters) {
        if (cl.count < 5 || cl.count > 40) continue; // enforce MIN/MAX_CLUSTER
        if (cl.w * 640 > 8 || cl.h * 360 > 8) continue; // enforce MAX_BBOX (8px on 640×360)
        const bwCheck = Math.round(cl.w * 640), bhCheck = Math.round(cl.h * 360);
        if (bwCheck === 0 || bhCheck === 0 || Math.max(bwCheck, bhCheck) / Math.min(bwCheck, bhCheck) > 2) continue;

        // Confirmation: require a cluster in the same area within a recent older entry.
        const confirmed = app.debugClusterHistory.some((prev, pi) => {
          if (pi >= ei) return false;                        // only older entries
          if (entry.t - prev.t > CONFIRM_MS) return false;  // within time window
          return prev.clusters.some(pc => {
            const dx = cl.centX - pc.centX, dy = cl.centY - pc.centY;
            return dx * dx + dy * dy < CONFIRM_D2;
          });
        });
        if (!confirmed) continue;

        const px = cl.x * cw, py = cl.y * ch;
        const pw = cl.w * cw, ph = cl.h * ch;
        const ox = px - 2, oy = py - 2, ow = pw + 4, oh = ph + 4;

        const circR = Math.max(ow, oh) / 2;
        const circX = ox + ow / 2, circY = oy + oh / 2;

        // Skip if this circle overlaps any already-rendered circle from an older entry.
        const overlaps = renderedCircles.some(rc => {
          const dx = circX - rc.x, dy = circY - rc.y;
          return dx * dx + dy * dy < (circR + rc.r) * (circR + rc.r);
        });
        if (overlaps) continue;
        renderedCircles.push({ x: circX, y: circY, r: circR });

        const isNew = entry.t === newestT;
        if (isNew) newCircleCount++;
        circlesToDraw.push({ circX, circY, circR, frac, isNew });
      }
    }

    // If the new-circle count exceeds the threshold, purge those entries from history
    // entirely so they leave no traces in future frames.
    if (newCircleCount > 5) {
      app.debugClusterHistory = app.debugClusterHistory.filter(e => e.t !== newestT);
    }

    // Second pass: only draw if within threshold AND overlay is enabled.
    if (newCircleCount <= 5 && app.ballDetectionOverlay) {
      for (const c of circlesToDraw) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 4;
        ctx.strokeStyle = `rgba(0,230,255,${(c.frac * 0.95).toFixed(2)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(c.circX, c.circY, c.circR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,160,30,${(c.frac * 0.45).toFixed(2)})`;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // Camera-shift warning: require 3 consecutive over-threshold frames before showing,
    // then hold the bar visible for 2 s after the last trigger.
    if (newCircleCount > 5) {
      app._cameraShiftFrames = (app._cameraShiftFrames || 0) + 1;
      if (app._cameraShiftFrames >= 3) {
        app._cameraShiftLastT = performance.now();
        showCameraShiftBar();
      }
    } else {
      app._cameraShiftFrames = 0;
      if (app._cameraShiftLastT && performance.now() - app._cameraShiftLastT > 2000) {
        hideCameraShiftBar();
      }
    }
  }
}

function jointColor(i) {
  if (i <= 10) return '#ff79c6';
  if (i <= 16) return '#79c0ff';
  if (i <= 22) return '#56d364';
  return '#ffa657';
}

// ── Live recording overlay (drawn on #rec-canvas, not the main canvas) ──────
function drawRecOverlay(rctx, rc) {
  rctx.clearRect(0, 0, rc.width, rc.height);
  const lms = app.landmarks;
  if (!lms) return;
  const W = rc.width, H = rc.height;

  // The canvas's drawing buffer is sized to the camera's native resolution
  // (often 1080p+), but on a phone it's displayed at a much smaller physical
  // size than that — CSS scales the whole buffer down, so lines/dots drawn at
  // desktop-appropriate widths end up looking hairline-thin on mobile. Scale
  // them up on mobile to compensate.
  const _mob = document.body.classList.contains('force-mobile') ||
    (!document.body.classList.contains('force-desktop') && window.innerWidth <= 768);

  // Skeleton edges
  rctx.lineWidth = _mob ? 5 : 2;
  rctx.strokeStyle = 'rgba(88,166,255,0.75)';
  for (const [a, b] of SKELETON_EDGES) {
    const pa = lms[a], pb = lms[b];
    if (!pa || !pb || pa.visibility < 0.35 || pb.visibility < 0.35) continue;
    rctx.beginPath();
    rctx.moveTo(pa.x * W, pa.y * H);
    rctx.lineTo(pb.x * W, pb.y * H);
    rctx.stroke();
  }

  // Joints
  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i];
    if (!lm || lm.visibility < 0.35) continue;
    const x = lm.x * W, y = lm.y * H;
    const r = (i < 11 ? 1 : 2) * (_mob ? 3 : 1);
    rctx.beginPath(); rctx.arc(x, y, r, 0, Math.PI * 2);
    rctx.fillStyle = jointColor(i); rctx.fill();
    if (_mob) { rctx.strokeStyle = '#00000066'; rctx.lineWidth = 1.5; rctx.stroke(); }
  }

  // Angle labels — always shown during recording with 4-tier color coding
  const YELLOW_MARGIN = 15;
  const drawRecLbl = (ai, bi, ci) => {
    const a = lms[ai], b = lms[bi], c = lms[ci];
    if (!a || !b || !c || a.visibility < 0.45 || b.visibility < 0.45 || c.visibility < 0.45) return;
    const ang = angleDeg({x:a.x,y:a.y},{x:b.x,y:b.y},{x:c.x,y:c.y}, W / H);
    const isElbow   = bi === LM.L_ELBOW || bi === LM.R_ELBOW;
    const goodMin   = isElbow ? 80  : 115;
    const goodMax   = isElbow ? 155 : 165;
    const plausKey  = isElbow ? 'elbow' : 'knee';
    // Physically implausible — almost certainly a detection error. Don't draw
    // a number for it at all.
    if (!plausible(ang, plausKey)) return;
    let color;
    if (ang >= goodMin && ang <= goodMax) {
      color = '#3fb950';  // green — within good range
    } else if ((ang >= goodMin - YELLOW_MARGIN && ang < goodMin) ||
               (ang > goodMax && ang <= goodMax + YELLOW_MARGIN)) {
      color = '#d29922';  // yellow — borderline
    } else {
      color = '#f85149';  // red   — outside good range
    }
    const px = b.x * W, py = b.y * H;
    const txt = Math.round(ang) + '°';
    rctx.font = 'bold 12px monospace';
    rctx.strokeStyle = 'rgba(0,0,0,0.8)'; rctx.lineWidth = 3;
    rctx.strokeText(txt, px + 6, py - 6);
    rctx.fillStyle = color;
    rctx.fillText(txt, px + 6, py - 6);
  };
  drawRecLbl(LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST);
  drawRecLbl(LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST);
  drawRecLbl(LM.L_HIP, LM.L_KNEE, LM.L_ANKLE);
  drawRecLbl(LM.R_HIP, LM.R_KNEE, LM.R_ANKLE);
}

function drawAngleLabel(lms, ai, bi, ci) {
  const a = lms[ai], b = lms[bi], c = lms[ci];
  if (!a || !b || !c || a.visibility < 0.45 || b.visibility < 0.45 || c.visibility < 0.45) return;
  const ang = angleDeg({x:a.x,y:a.y},{x:b.x,y:b.y},{x:c.x,y:c.y}, videoEl.videoWidth / videoEl.videoHeight);
  const isElbow = bi === LM.L_ELBOW || bi === LM.R_ELBOW;
  // Physically implausible — almost certainly a detection error. Don't draw
  // a number for it at all.
  if (!plausible(ang, isElbow ? 'elbow' : 'knee')) return;
  const pt   = lmPx(b);
  const good = isElbow ? (ang >= 80 && ang <= 155) : (ang >= 115 && ang <= 165);
  ctx.font = 'bold 11px monospace';
  ctx.shadowColor = '#00000099'; ctx.shadowBlur = 3;
  ctx.fillStyle = good ? '#56d364' : '#ffa657';
  ctx.fillText(`${Math.round(ang)}°`, pt.x + 7, pt.y - 5);
  ctx.shadowBlur = 0;
}

// ════════════════════════════════════════════════════════════
//  MATH
// ════════════════════════════════════════════════════════════
// aspect = frame width / height. MediaPipe landmarks normalize x by image
// width and y by image height independently, so for any non-square frame
// (practically every real video) the raw x/y aren't on the same physical
// scale — computing atan2 directly on them distorts the angle. Scaling x by
// the aspect ratio puts both axes back on a common scale before measuring.
function angleDeg(a, b, c, aspect = 1) {
  const ax = a.x * aspect, bx = b.x * aspect, cx = c.x * aspect;
  const r = Math.atan2(c.y-b.y, cx-bx) - Math.atan2(a.y-b.y, ax-bx);
  let d = Math.abs(r * 180 / Math.PI);
  if (d > 180) d = 360 - d;
  return d;
}

function vis(lm, t=0.4) { return lm && lm.visibility >= t; }

// ════════════════════════════════════════════════════════════
//  CONTROLS
// ════════════════════════════════════════════════════════════
function updateScrub() {
  const dur = videoEl.duration;
  if (!dur && dur !== 0) return; // undefined / NaN — metadata not loaded yet
  const ct  = videoEl.currentTime;
  // dur === 0 passes isFinite() but dividing by it below would give NaN (0/0)
  // or Infinity — treat a zero-length video the same as an unknown duration.
  const finite = isFinite(dur) && dur > 0;
  const pct = finite ? Math.min(100, (ct / dur) * 100) : 0;
  document.getElementById('scrub-fill').style.width = pct + '%';
  document.getElementById('scrub-thumb').style.left  = pct + '%';
  document.getElementById('time-label').textContent  =
    finite ? `${fmtTime(ct)} / ${fmtTime(dur)}` : fmtTime(ct);
}

const scrubTrack = document.getElementById('scrub-track');
let scrubDrag = false;
scrubTrack.addEventListener('click', e => {
  if (!isFinite(videoEl.duration)) return; // can't seek by % with no known duration
  const r = scrubTrack.getBoundingClientRect();
  videoEl.currentTime = ((e.clientX - r.left) / r.width) * videoEl.duration;
});
scrubTrack.addEventListener('mousedown', () => scrubDrag = true);
document.addEventListener('mousemove', e => {
  if (!scrubDrag || !isFinite(videoEl.duration)) return;
  const r   = scrubTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  videoEl.currentTime = pct * videoEl.duration;
});
document.addEventListener('mouseup', () => scrubDrag = false);

document.getElementById('btn-pp').addEventListener('click',  () => videoEl.paused ? videoEl.play() : videoEl.pause());
document.getElementById('btn-rw10').addEventListener('click', () => { videoEl.currentTime = Math.max(0, videoEl.currentTime - 10); });
document.getElementById('btn-rw5').addEventListener('click',  () => { videoEl.currentTime = Math.max(0, videoEl.currentTime - 5); });
document.getElementById('btn-ff5').addEventListener('click',  () => { videoEl.currentTime = isFinite(videoEl.duration) ? Math.min(videoEl.duration, videoEl.currentTime + 5)  : videoEl.currentTime + 5; });
document.getElementById('btn-ff10').addEventListener('click', () => { videoEl.currentTime = isFinite(videoEl.duration) ? Math.min(videoEl.duration, videoEl.currentTime + 10) : videoEl.currentTime + 10; });
document.getElementById('speed-pick').addEventListener('change', e => { videoEl.playbackRate = parseFloat(e.target.value); });

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space')      { e.preventDefault(); videoEl.paused ? videoEl.play() : videoEl.pause(); }
  if (e.code === 'ArrowLeft')  { e.preventDefault(); videoEl.currentTime = Math.max(0, videoEl.currentTime - (e.shiftKey ? 10 : 5)); }
  if (e.code === 'ArrowRight') {
    e.preventDefault();
    // Unlike the ff buttons, this used Math.min(videoEl.duration, ...) directly —
    // if duration is NaN (metadata not loaded yet), Math.min(NaN, x) is NaN,
    // setting currentTime to NaN and breaking seeking entirely.
    const step = e.shiftKey ? 10 : 5;
    videoEl.currentTime = isFinite(videoEl.duration)
      ? Math.min(videoEl.duration, videoEl.currentTime + step)
      : videoEl.currentTime + step;
  }
});

// ════════════════════════════════════════════════════════════
//  FILE HANDLING
// ════════════════════════════════════════════════════════════
fileInput.addEventListener('change', e => { uploadClips(Array.from(e.target.files)); fileInput.value = ''; });

function triggerPicker() { fileInput.click(); }
document.getElementById('browse-btn').addEventListener('click', triggerPicker);
document.getElementById('sidebar-add-btn').addEventListener('click', triggerPicker);
document.getElementById('drop-zone').addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') triggerPicker(); });

document.addEventListener('dragenter', e => { e.preventDefault(); document.getElementById('drop-zone').classList.add('drag-over'); });
document.addEventListener('dragover',  e => { e.preventDefault(); document.getElementById('drop-zone').classList.add('drag-over'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.getElementById('drop-zone').classList.remove('drag-over'); });
document.addEventListener('drop', e => {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  uploadClips(Array.from(e.dataTransfer.files));
});

// ════════════════════════════════════════════════════════════
//  UI HELPERS
// ════════════════════════════════════════════════════════════
function showSection(which) {
  document.getElementById('upload-area').style.display   = which === 'upload'   ? 'flex' : 'none';
  document.getElementById('analyzer-area').style.display = which === 'analyzer' ? 'flex' : 'none';
  document.getElementById('rescan-btn').disabled = which !== 'analyzer';
}

function showLoading(show, msg) {
  const el = document.getElementById('video-loading');
  el.style.display = show ? 'flex' : 'none';
  if (msg) document.getElementById('loading-msg').textContent = msg;
}

function showMain() {
  document.getElementById('setup-screen').classList.remove('visible');
  document.getElementById('auth-screen').classList.remove('visible');
  document.getElementById('main-app').classList.add('visible');
  showSection('upload');
}

function showAuth() {
  document.getElementById('setup-screen').classList.remove('visible');
  document.getElementById('main-app').classList.remove('visible');
  document.getElementById('analyzer-area').style.display = 'none';
  document.getElementById('upload-area').style.display   = 'flex';
  stopLoop();
  document.getElementById('auth-screen').classList.add('visible');
}

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ════════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════════
// Apply saved layout preference, or show the format picker on first visit
const _savedLayout = localStorage.getItem('ta_layout');
if (_savedLayout) {
  applyLayout(_savedLayout);
  bootApp();
} else {
  document.getElementById('format-screen').classList.add('visible');
}
