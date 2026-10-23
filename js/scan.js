'use strict';

// ════════════════════════════════════════════════════════════
//  BACKGROUND SCAN
// ════════════════════════════════════════════════════════════
// Separate stroke-detection state used only during the background scan
const scan = {
  prevPos:      null,
  prevVT:       0,
  active:       false,
  startVT:      0,
  buffer:       [],
  lastStrokeVT: -999,
  SPEED_START:  0.25,
  SPEED_END:    0.20, // high enough to match real post-stroke deceleration at 0.2s intervals
  slowSinceVT:  null, // video time speed first dropped below SPEED_END, continuously — null when not currently dipping
  lastRedVT:    null, // video time of the most recent frame with speed > SPEED_START, during the current stroke
  END_GRACE:    0.35, // speed must stay below SPEED_END for this long (seconds) before the stroke actually ends
  RED_TIMEOUT:  0.8,  // end the stroke if speed hasn't been above SPEED_START for this long (seconds)
  MIN_FRAMES:   2,
  COOLDOWN:     1.5,
  maxSpeed:          0,
  pendingServeCheck: null,
  wristHistory:      [],
  poseUnreliable:    false, // true if any buffer frame had impossible anatomy
  ballHistory:       [],    // rolling [{vt, x, y}] of detected ball positions
  ballTriggered:     false, // true if current stroke was started by ball contact
};

const scanEl = document.getElementById('scan-el');

function tryStartScan() {
  if (!app.modelsReady || !videoEl.duration || !isFinite(videoEl.duration) || app.scanning) return;
  const clip = app.clips.find(c => c.id === app.activeClipId);
  if (clip?.fromRecording) return; // skip scan, use live detection
  if (clip?.name?.toLowerCase().endsWith('.webm')) return; // WebM = Android MediaRecorder, no seek index
  if (loadCachedScan(clip)) return; // cached results found
  startScan();
}

async function startScan() {
  if (!app.modelsReady || !videoEl.duration || !isFinite(videoEl.duration) || app.scanning) return;
  const myGen = ++app.scanGeneration;
  const bail  = () => app.scanGeneration !== myGen;

  app.scanning      = true;
  stroke.markers    = [];
  stroke.frozenResult = null;
  scan.prevPos      = null;
  scan.prevVT       = 0;
  scan.active       = false;
  scan.lastStrokeVT = -999;
  scan.maxSpeed     = 0;
  scan.slowSinceVT  = null;
  scan.lastRedVT    = null;
  scan.ballHistory  = [];
  scan.ballTriggered = false;

  renderStrokeMarkers();
  showScanProgressUI();

  scanEl.src = videoEl.src;
  scanEl.load();
  await Promise.race([
    new Promise(r => scanEl.addEventListener('loadedmetadata', r, { once: true })),
    new Promise(r => setTimeout(r, 6000)),
  ]);
  if (bail()) return;

  const sw = scanEl.videoWidth  || videoEl.videoWidth  || 640;
  const sh = scanEl.videoHeight || videoEl.videoHeight || 360;
  const scanCanvas  = document.createElement('canvas');
  scanCanvas.width  = sw;
  scanCanvas.height = sh;
  const scanCtx2d   = scanCanvas.getContext('2d');

  const STEP     = 0.2;
  const duration = videoEl.duration;

  for (let t = 0; t <= duration; t += STEP) {
    if (bail() || !app.scanning) break;

    scanEl.currentTime = t;
    await Promise.race([
      new Promise(r => scanEl.addEventListener('seeked', r, { once: true })),
      new Promise(r => setTimeout(r, 2000)),
    ]);
    if (bail() || !app.scanning) break;

    if (scanEl.readyState < 2) {
      let pollDone = false;
      await Promise.race([
        new Promise(r => {
          const poll = () => {
            if (pollDone) return;
            if (scanEl.readyState >= 2) { pollDone = true; r(); }
            else setTimeout(poll, 30);
          };
          poll();
        }),
        new Promise(r => setTimeout(() => { pollDone = true; r(); }, 1000)),
      ]);
    }
    if (bail() || !app.scanning) break;

    scanCtx2d.drawImage(scanEl, 0, 0, sw, sh);

    // Ball detection — runs synchronously on the already-drawn canvas frame
    let ballPos = null;
    try { ballPos = detectBall(scanCtx2d, sw, sh); } catch(e) { console.warn('[TA] detectBall error during scan:', e); }
    processScanBall(ballPos, t);

    try {
      app.scanSending = true;
      app.detecting   = true;
      await Promise.race([
        app.poseModel.send({ image: scanCanvas }),
        new Promise(r => setTimeout(r, 1500)),
      ]);
    } catch(e) {}
    app.detecting   = false;
    app.scanSending = false;

    if (bail()) return; // don't touch UI or global state if superseded
    updateScanProgressUI();
  }

  // If the stroke was still active when the clip ended, declare it now rather than discard it.
  if (scan.active && scan.buffer.length >= 1) {
    const avg  = avgMetrics(scan.buffer);
    const type = classifyStrokeType(scan.buffer, true);
    stroke.markers.push({ startTime: scan.startVT, endTime: scanEl.currentTime, score: scoreStroke(avg, type), type, metrics: avg, cards: generateFeedback(avg, type), poseUnreliable: scan.poseUnreliable });
    scan.active        = false;
    scan.buffer        = [];
    scan.slowSinceVT   = null;
    scan.lastRedVT     = null;
    scan.ballTriggered = false;
  }

  if (bail()) return; // superseded — leave cleanup to the newer scan

  // If app.scanning is still true here the loop ran to completion naturally.
  // If it's false the user pressed Skip — don't mark complete so live detection
  // can still add markers as the video plays.
  const completedFully = app.scanning;
  app.scanning     = false;
  app.scanSending  = false;
  app.detecting    = false;
  app.scanComplete = completedFully;
  scanEl.src       = '';
  renderStrokeMarkers();
  showScanCompleteUI();

  await saveScanResults();

  if (!videoEl.paused) startLoop(); else detectFrame();
}

function stopScan() {
  app.scanning    = false; // scan loop checks this flag and exits on next iteration
  app.scanSending = false; // prevent onPoseResults from routing stale scan results
  ctx.clearRect(0, 0, canvas.width, canvas.height); // remove stale scan overlay immediately
}

// ════════════════════════════════════════════════════════════
//  SCAN RESULT PERSISTENCE
// ════════════════════════════════════════════════════════════
async function saveScanResults() {
  const userId = fbAuth.currentUser?.uid;
  const clipId = app.activeClipId;
  if (!userId || !clipId) return; // always save, even empty — persists deletions

  // Safety net: if this scan found 0 strokes but Firestore already has valid results
  // for this clip (e.g. a race-condition scan ran on stale data), do not overwrite.
  if (stroke.markers.length === 0) {
    const existingClip = app.clips.find(c => c.id === clipId);
    if (existingClip?.scanResults?.length && (existingClip.scanVersion ?? 0) >= SCAN_VERSION) {
      console.warn('[TA] Scan produced 0 strokes but Firestore has valid results — skipping overwrite.');
      return;
    }
  }

  try {
    await fbDb.collection('users').doc(userId)
      .collection('videos').doc(clipId)
      .update({
        scanResults: stroke.markers.map(m => ({
          startTime: m.startTime,
          endTime:        m.endTime       ?? null,
          poseUnreliable: m.poseUnreliable ?? false,
          score:          m.score,
          type:      m.type  || null,
          // Strip underscore classification keys — display keys only
          metrics:   m.metrics ? Object.fromEntries(Object.entries(m.metrics).filter(([k]) => !k.startsWith('_'))) : null,
          cards:     m.cards  || null,
        })),
        deletedStartTimes: stroke.deletedTimes,
        scanVersion: SCAN_VERSION,
        // Whether the scan that produced these results ran to completion, or was
        // skipped partway through — see loadCachedScan(), which must not treat a
        // partial result set as the final word on this clip's strokes.
        scanComplete: app.scanComplete,
        scannedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
  } catch(e) {
    console.warn('[TA] Could not save scan results:', e);
  }
}

function loadCachedScan(clip) {
  if (!clip?.scanResults?.length) return false;
  // Reject stale cache from older classification logic
  if ((clip.scanVersion ?? 0) < SCAN_VERSION) return false;
  // Reject a partial result set from a scan that was skipped before finishing —
  // its stroke list is incomplete, so fall through to a fresh scan rather than
  // presenting a few strokes as if they were the whole video's analysis.
  if (clip.scanComplete !== true) return false;
  app.scanComplete = true;
  stroke.markers = clip.scanResults.map(m => ({
    startTime:      m.startTime,
    endTime:        m.endTime       ?? null,
    poseUnreliable: m.poseUnreliable ?? false,
    score:          m.score,
    type:           m.type    || null,
    metrics:        m.metrics || null,
    cards:          m.cards   || null,
  }));
  renderStrokeMarkers();
  showCachedScanUI(stroke.markers.length);
  return true;
}

function showCachedScanUI(n) {
  document.getElementById('feedback-scroll').innerHTML = '';
}

async function rescanVideo() {
  if (!app.activeClipId) return;
  const userId = fbAuth.currentUser?.uid;
  const clipId = app.activeClipId;
  if (userId && clipId) {
    try {
      await fbDb.collection('users').doc(userId)
        .collection('videos').doc(clipId)
        .update({ scanResults: firebase.firestore.FieldValue.delete(), scannedAt: firebase.firestore.FieldValue.delete() });
    } catch(e) { /* ignore */ }
  }
  stroke.markers             = [];
  stroke.deletedTimes        = [];
  stroke.frozenResult        = null;
  stroke.pendingServeCheck   = null;
  stroke.wristHistory        = [];
  scan.pendingServeCheck     = null;
  scan.wristHistory          = [];
  scan.ballHistory           = [];
  scan.ballTriggered         = false;
  app.scanComplete           = false;
  stroke.lastStrokeVT    = -999;
  app.lastPausedMarkerVT = -Infinity;
  app.lastShownMarkerVT  = -Infinity;
  renderStrokeMarkers();
  startScan();
}

// Called after each scan frame with the detected ball position (or null).
// Maintains a rolling position history and fires a ball-triggered stroke
// start when a significant direction reversal is detected — i.e. the
// moment of contact, when the ball bounces off the racquet.
function processScanBall(pos, vt) {
  if (pos) {
    scan.ballHistory.push({ vt, x: pos.x, y: pos.y });
  }
  // Keep only recent history (within 1.5 s)
  while (scan.ballHistory.length && vt - scan.ballHistory[0].vt > 1.5)
    scan.ballHistory.shift();

  // Need at least 3 positions to compute two velocity vectors
  const hist = scan.ballHistory;
  if (hist.length < 3) return;

  const p0 = hist[hist.length - 3];
  const p1 = hist[hist.length - 2];
  const p2 = hist[hist.length - 1];

  // Only consider recent, consecutive detections (no big time gaps)
  if (p2.vt - p0.vt > 1.0) return;

  const v1x = p1.x - p0.x, v1y = p1.y - p0.y;
  const v2x = p2.x - p1.x, v2y = p2.y - p1.y;
  const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
  const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);

  // Ball must be moving meaningfully both before and after contact
  if (mag1 < 0.03 || mag2 < 0.03) return;

  const cosAngle = (v1x * v2x + v1y * v2y) / (mag1 * mag2);

  // Direction reversal: angle > ~100° between velocity vectors
  if (cosAngle < -0.18 && !scan.active && (vt - scan.lastStrokeVT) >= scan.COOLDOWN) {
    scan.active         = true;
    scan.ballTriggered  = true;
    scan.poseUnreliable = false;
    const minVT  = scan.lastStrokeVT + scan.COOLDOWN;
    scan.startVT = Math.max(minVT, p1.vt - 0.4); // start just before contact
    scan.buffer  = [];
    scan.slowSinceVT = null;
    scan.lastRedVT   = vt;
    console.log('[TA] Ball-triggered stroke at', vt.toFixed(2));
    console.log('[TA] Ball-triggered stroke at', vt.toFixed(2));
  }
}

// Stroke detection used during the scan (separate state from live detector)
function processScanStroke(lms) {
  const rW = lms[LM.R_WRIST], lW = lms[LM.L_WRIST];
  const wrist = (rW?.visibility ?? 0) >= (lW?.visibility ?? 0) ? rW : lW;
  if (!wrist || wrist.visibility < 0.3) return;

  const vt = scanEl.currentTime;

  // Pending serve check: runs every frame even during cooldown, so we don't miss
  // the wrist-above-shoulder contact that happens after the slow prep motion ends.
  // Check BOTH wrists — at contact MediaPipe sometimes favours the non-hitting arm.
  if (scan.pendingServeCheck) {
    const { markerIdx, expiresVT } = scan.pendingServeCheck;
    const shoulderY   = ((lms[LM.L_SHOULDER]?.y ?? 0.35) + (lms[LM.R_SHOULDER]?.y ?? 0.35)) / 2;
    const minWristY   = Math.min(rW?.y ?? 1, lW?.y ?? 1);
    if (minWristY < shoulderY - 0.06) {
      if (stroke.markers[markerIdx]) stroke.markers[markerIdx].type = { type: 'Serve / Overhead', icon: '' };
      scan.pendingServeCheck = null;
      renderStrokeMarkers();
    } else if (vt >= expiresVT) {
      scan.pendingServeCheck = null;
    }
  }

  if (!scan.active && (vt - scan.lastStrokeVT) < scan.COOLDOWN) {
    scan.prevPos = { x: wrist.x, y: wrist.y }; scan.prevVT = vt; return;
  }

  if (scan.prevPos && scan.prevVT !== vt) {
    const dt = Math.abs(vt - scan.prevVT);
    if (dt > 0 && dt < 2.5) {
      const dx = wrist.x - scan.prevPos.x, dy = wrist.y - scan.prevPos.y;
      const speed = bodyRelativeSpeed(dx, dy, dt, lms);
      if (speed > scan.maxSpeed) scan.maxSpeed = speed;

      // Maintain rolling wrist history for prep-start detection
      const scanMidX = ((lms[LM.L_SHOULDER]?.x ?? 0.4) + (lms[LM.R_SHOULDER]?.x ?? 0.6)) / 2;
      scan.wristHistory.push({ vt, x: wrist.x, midX: scanMidX });
      while (scan.wristHistory.length && vt - scan.wristHistory[0].vt > 2.0)
        scan.wristHistory.shift();

      if (!scan.active && speed > scan.SPEED_START) {
        scan.active        = true;
        scan.poseUnreliable = false;
        const minVT  = scan.lastStrokeVT + scan.COOLDOWN;
        const prepVT = findPrepStart(scan.wristHistory, vt, minVT);
        scan.startVT = prepVT ?? Math.max(minVT, vt - 1.0);
        scan.buffer  = [];
        scan.slowSinceVT = null;
        scan.lastRedVT   = vt;
      }
      if (scan.active) {
        if (isAnatomicallyImpossible(lms)) scan.poseUnreliable = true;
        const m = computeMetrics(lms);
        // Store wrist trajectory data for stroke type classification
        const aw = (rW?.visibility ?? 0) >= (lW?.visibility ?? 0) ? rW : lW;
        m._wx = aw?.x ?? 0.5; m._wy = aw?.y ?? 0.5;
        m._rightDom  = (rW?.visibility ?? 0) >= (lW?.visibility ?? 0);
        m._hipX      = ((lms[LM.L_HIP]?.x ?? 0.4) + (lms[LM.R_HIP]?.x ?? 0.6)) / 2;
        m._shoulderY = ((lms[LM.L_SHOULDER]?.y ?? 0.35) + (lms[LM.R_SHOULDER]?.y ?? 0.35)) / 2;
        m._rwx = rW?.x ?? 0.5; m._rwy = rW?.y ?? 0.5;
        m._lwx = lW?.x ?? 0.5; m._lwy = lW?.y ?? 0.5;
        m._rex = lms[LM.R_ELBOW]?.x ?? null;
        m._lex = lms[LM.L_ELBOW]?.x ?? null;
        m._lsX = lms[LM.L_SHOULDER]?.x ?? 0.4;
        m._rsX = lms[LM.R_SHOULDER]?.x ?? 0.6;
        scan.buffer.push(m);
        // End stroke when speed drops AND wrist has traveled enough (cross-body check),
        // AND speed has stayed low for END_GRACE seconds — a brief mid-swing
        // deceleration blip would otherwise end the stroke early and register the
        // follow-through as a second, separate stroke once speed picks back up.
        const firstBuf   = scan.buffer[0];
        const swingTravel = firstBuf
          ? Math.sqrt((wrist.x - firstBuf._wx) ** 2 + (wrist.y - firstBuf._wy) ** 2)
          : 1;
        const longEnough = scan.buffer.length >= 8; // ~1.6 s fallback
        const isSlow = speed < scan.SPEED_END && (swingTravel > 0.05 || longEnough);
        if (isSlow) {
          if (scan.slowSinceVT === null) scan.slowSinceVT = vt;
        } else {
          scan.slowSinceVT = null;
        }
        const slowLongEnough = scan.slowSinceVT !== null && (vt - scan.slowSinceVT) >= scan.END_GRACE;
        // Second, independent end condition: if speed hasn't been above SPEED_START
        // for RED_TIMEOUT seconds, end the stroke even if it never sustained a clean
        // dip below SPEED_END — catches a swing that stalls between the two
        // thresholds without ever going properly slow.
        if (speed > scan.SPEED_START) scan.lastRedVT = vt;
        const redTimedOut = scan.lastRedVT !== null && (vt - scan.lastRedVT) > scan.RED_TIMEOUT;
        if ((slowLongEnough || redTimedOut) && scan.buffer.length >= scan.MIN_FRAMES) {
          // Report the moment the swing actually slowed down, not `vt` (now) — see
          // the matching comment in processStroke() for why.
          const actualEndVT = slowLongEnough ? scan.slowSinceVT : scan.lastRedVT;
          scan.lastRedVT = null;
          scan.slowSinceVT = null;
          const avg  = avgMetrics(scan.buffer);
          const type = classifyStrokeType(scan.buffer, true);
          stroke.markers.push({ startTime: scan.startVT, endTime: actualEndVT, score: scoreStroke(avg, type), type, metrics: avg, cards: generateFeedback(avg, type), poseUnreliable: scan.poseUnreliable });
          scan.pendingServeCheck = { markerIdx: stroke.markers.length - 1, expiresVT: vt + 2.5 };
          scan.lastStrokeVT  = vt;
          scan.active        = false;
          scan.buffer        = [];
          scan.ballTriggered = false;
          renderStrokeMarkers();
          updateScanProgressUI();
        }
      }
    }
  }
  scan.prevPos = { x: wrist.x, y: wrist.y };
  scan.prevVT  = vt;
}

// Scan UI helpers
function showScanProgressUI() {
  app.scanPoses = 0;
  document.getElementById('feedback-scroll').innerHTML = `
    <div class="fb-waiting">
      <div style="font-size:13px;font-weight:600;color:#c9d1d9;margin-bottom:6px">Scanning video for strokes…</div>
      <div style="font-size:12px;color:#8b949e;margin-bottom:14px;line-height:1.6">
        Running in the background — feel free to watch any part of the video.<br>
        The overlay and live analysis will appear once the scan is complete.
      </div>
      <div style="background:#21262d;border-radius:4px;overflow:hidden;height:5px;margin-bottom:8px">
        <div id="scan-bar" style="height:100%;background:#388bfd;width:0%;transition:width 0.3s;border-radius:4px"></div>
      </div>
      <div id="scan-pct" style="font-size:12px;color:#8b949e;margin-bottom:6px">0%</div>
      <div style="font-size:12px;color:#484f58">Poses: <span id="scan-poses">0</span> &nbsp;·&nbsp; Strokes: <span id="scan-count">0</span> &nbsp;·&nbsp; Max speed: <span id="scan-maxspeed">0.000</span></div>
      <div style="margin-top:14px">
        <button onclick="stopScan()" style="background:none;border:1px solid #30363d;border-radius:5px;color:#8b949e;font-size:11px;padding:4px 12px;cursor:pointer">Skip scan</button>
      </div>
    </div>`;
}

function updateScanProgressUI() {
  const bar   = document.getElementById('scan-bar');
  const pct   = document.getElementById('scan-pct');
  const count = document.getElementById('scan-count');
  if (!bar || !videoEl.duration) return;
  const p = Math.round((scanEl.currentTime / videoEl.duration) * 100);
  bar.style.width    = p + '%';
  if (pct)   pct.textContent   = p + '%';
  if (count) count.textContent = stroke.markers.length;
  const posesEl = document.getElementById('scan-poses');
  if (posesEl) posesEl.textContent = app.scanPoses;
  const speedEl = document.getElementById('scan-maxspeed');
  if (speedEl) speedEl.textContent = scan.maxSpeed.toFixed(3);
}

function showScanCompleteUI() {
  const n = stroke.markers.length;
  // Show first stroke's analysis immediately rather than a plain text message
  if (n > 0 && stroke.markers[0].metrics) {
    showMarkerFeedback(stroke.markers[0], 0);
    return;
  }
  document.getElementById('feedback-scroll').innerHTML = `
    <div class="fb-waiting">
      <div style="font-size:13px;font-weight:600;color:#3fb950;margin-bottom:6px">Scan complete</div>
      <div style="font-size:12px;color:#8b949e;line-height:1.6">
        ${n === 0
          ? 'No strokes detected. Try playing the video — feedback appears in real time.'
          : `<strong style="color:#c9d1d9">${n} stroke${n !== 1 ? 's' : ''}</strong> detected.<br>
             Click a marker or play through the video for coaching feedback.`}
      </div>
    </div>`;
}
