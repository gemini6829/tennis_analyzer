'use strict';

// ════════════════════════════════════════════════════════════
//  STROKE DETECTION
// ════════════════════════════════════════════════════════════
const stroke = {
  prevPos:       null,
  prevVT:        0,       // video time at last sample
  active:        false,
  startVT:       0,       // video time when current stroke began
  buffer:        [],      // metrics snapshots during stroke
  frozenResult:          null,    // {metrics, cards, score} — stays until next stroke
  lastDetectedStartVT:   null,   // startVT of the most recently completed live stroke
  markers:            [],   // [{startTime, score}] — one per completed stroke
  deletedTimes:       [],   // startTimes of user-deleted strokes — blocks live re-detection
  lastStrokeVT:       -999, // video time when last stroke ended
  pendingServeCheck:  null,
  wristHistory:       [],
  poseUnreliable:     false, // true if any buffer frame had impossible anatomy
  slowSinceVT:        null,  // video time speed first dropped below SPEED_END, continuously — null when not currently dipping
  lastRedVT:          null,  // video time of the most recent frame with speed > SPEED_START, during the current stroke
  SPEED_START:   0.65,    // normalized units/sec (in video-time) to start stroke
  SPEED_END:     0.25,    // drop below this to end stroke
  END_GRACE:     0.35,    // seconds speed must stay below SPEED_END before the stroke actually ends
  RED_TIMEOUT:   0.8,     // ends the stroke if speed hasn't exceeded SPEED_START for this long (seconds)
  MIN_FRAMES:    3,       // min frames before stroke can be declared
  COOLDOWN:      1.5,     // min seconds between strokes (prevents double-fire)
};

const REFERENCE_SHOULDER_W = 0.18;

function bodyRelativeSpeed(dx, dy, dt, lms) {
  const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER];
  const sw = (ls?.visibility > 0.3 && rs?.visibility > 0.3)
    ? Math.abs(rs.x - ls.x) : null;
  const scale = (sw && sw > 0.04) ? REFERENCE_SHOULDER_W / sw : 1;
  return Math.sqrt(dx * dx + dy * dy) / dt * scale;
}

const PREP_START_MAX_LOOKBACK = 1.2; // seconds
function findPrepStart(history, currentVT, minVT) {
  const clampedMinVT = Math.max(minVT, currentVT - PREP_START_MAX_LOOKBACK);
  let bestVT = null, minDist = Infinity;
  for (const h of history) {
    if (h.vt < clampedMinVT || h.vt > currentVT) continue;
    const d = Math.abs(h.x - h.midX);
    if (d < minDist) { minDist = d; bestVT = h.vt; }
  }
  return bestVT;
}

function resetStrokeDetector() {
  stroke.prevPos     = null;
  stroke.prevVT      = 0;
  stroke.active      = false;
  stroke.buffer      = [];
  stroke.slowSinceVT = null;
  stroke.lastRedVT   = null;
  stroke.fastFrames  = 0; // clear partial debounce count so it doesn't carry across a seek
}

function renderStrokeMarkers() {
  const track = document.getElementById('scrub-track');
  track.querySelectorAll('.stroke-marker').forEach(m => m.remove());
  if (!videoEl.duration) return;
  stroke.markers.forEach((marker, i) => {
    const { startTime, endTime, score, type } = marker;
    const startPct = (startTime / videoEl.duration) * 100;
    // endTime isn't always known yet so fall back to a short fixed span so it's
    // still visible rather than collapsing to zero width.
    const effectiveEnd = endTime != null ? endTime : startTime + 0.5;
    const widthPct = Math.max(((effectiveEnd - startTime) / videoEl.duration) * 100, 0.4);
    const bodyVis = marker.metrics?.bodyVisibility ?? 1;
    const color   = bodyVis < 0.45 ? '#484f58'  // grey = out of frame
      : score === null ? '#8b949e'
      : score >= 70 ? '#3fb950' : score >= 45 ? '#d29922' : '#f85149';
    const el    = document.createElement('div');
    el.className = 'stroke-marker';
    el.style.left       = startPct + '%';
    el.style.width      = widthPct + '%';
    el.style.background = color;
    const typeStr = type ? `${type.type} · ` : '';
    el.title = bodyVis < 0.15
      ? `Stroke ${i + 1}: no body detected — player outside frame (click to jump)`
      : bodyVis < 0.45
      ? `Stroke ${i + 1}: player partially out of frame (click to jump)`
      : `Stroke ${i + 1}: ${typeStr}Score ${score !== null ? score : '?'} (click to jump)`;
    el.addEventListener('click', e => {
      e.stopPropagation();
      videoEl.currentTime = startTime;
      showMarkerFeedback(marker);
    });
    track.appendChild(el);
  });
}

// ════════════════════════════════════════════════════════════
//  STROKE TYPE CLASSIFICATION
//  isScan=true  → buffer sampled at 0.2 s intervals (sparse)
//  isScan=false → buffer sampled at ~30 fps (dense)
// ════════════════════════════════════════════════════════════
function classifyStrokeType(buffer, isScan = false) {
  const frames = buffer.filter(f => f._wx !== undefined);
  if (frames.length < 2) return null;

  const xs = frames.map(f => f._wx);
  const ys = frames.map(f => f._wy);
  const mid = frames[Math.floor(frames.length / 2)];

  const shoulderY = mid._shoulderY ?? 0.35;

  const xRange  = Math.max(...xs) - Math.min(...xs);
  const yRange  = Math.max(...ys) - Math.min(...ys);
  const yTravel = ys[ys.length - 1] - ys[0];

  // ── Forehand vs Backhand ──────────────────────────────────────────────────
  const isRightHanded  = playerHandedness !== 'left';
  const avgLsX         = frames.reduce((s, f) => s + (f._lsX ?? 0.4), 0) / frames.length;
  const avgRsX         = frames.reduce((s, f) => s + (f._rsX ?? 0.6), 0) / frames.length;
  const shoulderMidX   = (avgLsX + avgRsX) / 2;
  const domSign        = Math.sign(isRightHanded ? (avgRsX - avgLsX) : (avgLsX - avgRsX)) || 1;

  const signedDisps = frames.map(f => {
    const wx = isRightHanded ? (f._rwx ?? 0.5) : (f._lwx ?? 0.5);
    return (wx - shoulderMidX) * domSign;
  });

  const maxNonDomExcursion = Math.max(...signedDisps.map(d => -d));

  const wristSaysBackhand = maxNonDomExcursion >= 0.10;

  let elbowSaysBackhand = null;
  {
    const domElbowKey = isRightHanded ? '_rex' : '_lex';
    const midFrame = frames.reduce((best, f) => {
      const d = Math.abs((isRightHanded ? (f._rwx ?? 0.5) : (f._lwx ?? 0.5)) - shoulderMidX);
      return (!best || d < Math.abs((isRightHanded ? (best._rwx ?? 0.5) : (best._lwx ?? 0.5)) - shoulderMidX)) ? f : best;
    }, null);
    if (midFrame) {
      // _rex/_lex are the dominant elbow x in normalised coords (stored in computeMetrics via _rightDom)
      const elbowX = isRightHanded
        ? (midFrame[domElbowKey] ?? midFrame._lsX ?? null)
        : (midFrame[domElbowKey] ?? midFrame._rsX ?? null);
      const wristX = isRightHanded ? (midFrame._rwx ?? null) : (midFrame._lwx ?? null);
      if (elbowX !== null && wristX !== null) {
        const wristPastElbow = (wristX - elbowX) * domSign;
        elbowSaysBackhand = wristPastElbow < -0.03;
      }
    }
  }

  const isForehand = !wristSaysBackhand && (elbowSaysBackhand !== true);
  const side = isForehand ? 'Forehand' : 'Backhand';

  // ── 1. SERVE / OVERHEAD ───────────────────────────────────────────────────
  const minRwY    = Math.min(...frames.map(f => f._rwy ?? 1));
  const minLwY    = Math.min(...frames.map(f => f._lwy ?? 1));
  const minWristY = Math.min(minRwY, minLwY);
  if (minWristY < shoulderY - 0.08)
    return { type: 'Serve / Overhead', icon: '' };

  // ── 2. VOLLEY ─────────────────────────────────────────────────────────────
  if (!isScan && xRange < 0.11 && yRange < 0.10 && frames.length <= 10)
    return { type: `${side} Volley`, icon: '' };

  // ── 3. SLICE ──────────────────────────────────────────────────────────────
  if (yTravel > 0.09 && xRange > 0.04)
    return { type: `${side} Slice`, icon: '↘' };

  // ── 4. GROUNDSTROKE ───────────────────────────────────────────────────────
  return { type: 'Groundstroke', icon: '' };
}

function avgMetrics(buffer) {
  const sums = {}, counts = {};
  for (const m of buffer) {
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number') {
        sums[k]   = (sums[k]   || 0) + v;
        counts[k] = (counts[k] || 0) + 1;
      }
    }
  }
  const result = {};
  for (const k of Object.keys(sums)) result[k] = sums[k] / counts[k];
  return result;
}

function processStroke(lms) {
  const rW = lms[LM.R_WRIST], lW = lms[LM.L_WRIST];
  const wrist = (rW?.visibility ?? 0) >= (lW?.visibility ?? 0) ? rW : lW;
  if (!wrist || wrist.visibility < 0.4) return;

  const vt = app.recRecording ? app._recElapsed : videoEl.currentTime;

  // Must run before the cooldown guard so it fires during cooldown.
  if (stroke.pendingServeCheck) {
    const { markerIdx, expiresVT } = stroke.pendingServeCheck;
    const shoulderY = ((lms[LM.L_SHOULDER]?.y ?? 0.35) + (lms[LM.R_SHOULDER]?.y ?? 0.35)) / 2;
    const minWristY = Math.min(rW?.y ?? 1, lW?.y ?? 1);
    if (minWristY < shoulderY - 0.06) {
      const marker = stroke.markers[markerIdx];
      if (marker) {
        marker.type = { type: 'Serve / Overhead', icon: '' };
        if (stroke.frozenResult && stroke.lastDetectedStartVT === marker.startTime) {
          stroke.frozenResult.type = marker.type;
          renderFrozenFeedback();
        }
        renderStrokeMarkers();
      }
      stroke.pendingServeCheck = null;
    } else if (vt > expiresVT) {
      stroke.pendingServeCheck = null;
    }
  }

  if (!stroke.active && (vt - stroke.lastStrokeVT) < stroke.COOLDOWN) {
    stroke.prevPos = { x: wrist.x, y: wrist.y };
    stroke.prevVT  = vt;
    return;
  }

  if (stroke.prevPos && stroke.prevVT !== vt) {
    const dt = Math.abs(vt - stroke.prevVT);
    if (dt > 0 && dt < 1.0) {  // ignore big jumps (seek)
      const dx = wrist.x - stroke.prevPos.x;
      const dy = wrist.y - stroke.prevPos.y;
      const speed = bodyRelativeSpeed(dx, dy, dt, lms);

      // Maintain rolling wrist history for prep-start detection
      const liveMidX = ((lms[LM.L_SHOULDER]?.x ?? 0.4) + (lms[LM.R_SHOULDER]?.x ?? 0.6)) / 2;
      stroke.wristHistory.push({ vt, x: wrist.x, midX: liveMidX });
      while (stroke.wristHistory.length && vt - stroke.wristHistory[0].vt > 2.0)
        stroke.wristHistory.shift();

      if (!stroke.active && speed > stroke.SPEED_START) {
        stroke.fastFrames = (stroke.fastFrames || 0) + 1;
        if (stroke.fastFrames >= 3) {
          stroke.fastFrames    = 0;
          stroke.active        = true;
          stroke.poseUnreliable = false;
          const minVT    = stroke.lastStrokeVT + stroke.COOLDOWN;
          const prepVT   = findPrepStart(stroke.wristHistory, vt, minVT);
          stroke.startVT = prepVT ?? Math.max(minVT, vt - 1.0);
          stroke.buffer  = [];
          stroke.slowSinceVT = null;
          stroke.lastRedVT   = vt;
        }
      } else if (!stroke.active) {
        stroke.fastFrames = 0; // reset counter if speed drops before threshold is met
      }

      if (stroke.active) {
        if (isAnatomicallyImpossible(lms)) stroke.poseUnreliable = true;
        // processStroke() runs for both live playback and recording — landmarks
        // are normalized against whichever source frame the pose model actually
        // saw, so the aspect ratio must match that source, not always videoEl.
        const srcW = app.recRecording ? document.getElementById('rec-preview').videoWidth  : videoEl.videoWidth;
        const srcH = app.recRecording ? document.getElementById('rec-preview').videoHeight : videoEl.videoHeight;
        const m = computeMetrics(lms, srcW / srcH);
        // Augment with wrist trajectory data for stroke type classification
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
        stroke.buffer.push(m);
        // forceEnd is measured from first buffer frame (swing start), not pushed-back startVT
        const swingStartVT   = stroke.buffer[0] ? vt - (stroke.buffer.length - 1) * (1 / 30) : vt;
        const forceEnd       = (vt - swingStartVT) > 2.5;
        const firstBuf       = stroke.buffer[0];
        const swingTravel    = firstBuf
          ? Math.sqrt((wrist.x - firstBuf._wx) ** 2 + (wrist.y - firstBuf._wy) ** 2)
          : 1;
        const enoughTravel   = swingTravel > 0.08;
        const isSlow = speed < stroke.SPEED_END && enoughTravel;
        if (isSlow) {
          if (stroke.slowSinceVT === null) stroke.slowSinceVT = vt;
        } else {
          stroke.slowSinceVT = null;
        }
        const slowLongEnough = stroke.slowSinceVT !== null && (vt - stroke.slowSinceVT) >= stroke.END_GRACE;
        if (speed > stroke.SPEED_START) stroke.lastRedVT = vt;
        const redTimedOut = stroke.lastRedVT !== null && (vt - stroke.lastRedVT) > stroke.RED_TIMEOUT;
        if ((slowLongEnough || forceEnd || redTimedOut) && stroke.buffer.length >= stroke.MIN_FRAMES) {
          const actualEndVT = slowLongEnough ? stroke.slowSinceVT
            : redTimedOut ? stroke.lastRedVT
            : vt;
          stroke.slowSinceVT = null;
          stroke.lastRedVT   = null;
          const avg   = avgMetrics(stroke.buffer);
          const type  = classifyStrokeType(stroke.buffer);
          const score = scoreStroke(avg, type);

          if (app.recRecording && app.voiceFeedbackEnabled) speakStrokeFeedback(avg, type);

          const nearest = stroke.markers.reduce((best, m) => {
            const d = Math.abs(m.startTime - stroke.startVT);
            return (!best || d < Math.abs(best.startTime - stroke.startVT)) ? m : best;
          }, null);
          const withinWindow = nearest && Math.abs(nearest.startTime - stroke.startVT) < 2.0;
          const displayScore = withinWindow && nearest.score !== null ? nearest.score : score;

          stroke.lastDetectedStartVT = stroke.startVT;
          stroke.lastStrokeVT = forceEnd ? stroke.startVT + 0.5 : vt;
          stroke.active       = false;
          stroke.buffer       = [];

          let panelResult = null;
          if (withinWindow) {
            nearest.type         = type;
            nearest.score        = displayScore;
            nearest.endTime      = actualEndVT;
            nearest.poseUnreliable = nearest.poseUnreliable || stroke.poseUnreliable;
            panelResult = { metrics: avg, cards: generateFeedback(avg, type), score: displayScore, type, poseUnreliable: nearest.poseUnreliable };
          } else if (!app.scanComplete) {
            const wasDeleted = stroke.deletedTimes.some(t => Math.abs(t - stroke.startVT) < 2.0);
            if (!wasDeleted) {
              stroke.markers.push({ startTime: stroke.startVT, endTime: actualEndVT, score: displayScore, type, metrics: avg, cards: generateFeedback(avg, type), poseUnreliable: stroke.poseUnreliable });
              stroke.markers.sort((a, b) => a.startTime - b.startTime);
              panelResult = { metrics: avg, cards: generateFeedback(avg, type), score: displayScore, type, poseUnreliable: stroke.poseUnreliable };
            }
          } else {
            panelResult = { metrics: avg, cards: generateFeedback(avg, type), score: displayScore, type, poseUnreliable: stroke.poseUnreliable };
          }
          if (panelResult) {
            // Don't render here — the timeupdate handler's continuous-playback
            // reveal (driven by marker position vs. playback time) is the sole
            // trigger for showing this in non-step mode; rendering from both
            // here and there was causing every stroke's feedback panel to
            // render twice.
            stroke.frozenResult = panelResult;
          }

          renderStrokeMarkers();

          const pendingIdx = withinWindow ? stroke.markers.indexOf(nearest)
            : (!app.scanComplete ? stroke.markers.length - 1 : -1);
          stroke.pendingServeCheck = pendingIdx >= 0
            ? { markerIdx: pendingIdx, expiresVT: vt + 2.5 } : null;
        }
      }
    }
  }
  stroke.prevPos = { x: wrist.x, y: wrist.y };
  stroke.prevVT  = vt;
}
