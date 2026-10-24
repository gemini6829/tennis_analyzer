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
  END_GRACE:     0.35,    // speed must stay below SPEED_END for this long (seconds) before the stroke actually ends — absorbs brief mid-swing deceleration blips so one stroke doesn't get split into two
  RED_TIMEOUT:   0.8,     // end the stroke if speed hasn't been above SPEED_START for this long (seconds), even if it never sustained a clean dip below SPEED_END — catches a swing that stalls in the "blue" zone
  MIN_FRAMES:    3,       // min frames before stroke can be declared
  COOLDOWN:      1.5,     // min seconds between strokes (prevents double-fire)
};

// ── Body-relative speed normalization ────────────────────────────────────
// Express wrist speed in units relative to the player's shoulder width.
const REFERENCE_SHOULDER_W = 0.18; // "typical" shoulder width in normalized coords

function bodyRelativeSpeed(dx, dy, dt, lms) {
  const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER];
  const sw = (ls?.visibility > 0.3 && rs?.visibility > 0.3)
    ? Math.abs(rs.x - ls.x) : null;
  // Only scale when shoulder width is reliable and meaningfully different from reference
  const scale = (sw && sw > 0.04) ? REFERENCE_SHOULDER_W / sw : 1;
  return Math.sqrt(dx * dx + dy * dy) / dt * scale;
}

// Find where the wrist was closest to the body midline before a stroke's speed
// trigger fired, as a proxy for "where the backswing started".
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
      showMarkerFeedback(marker, i);
    });
    track.appendChild(el);
  });
}

// TEMPORARY DEBUG DISPLAY — commented out for now, re-enable by uncommenting
// this function plus its call sites in processStroke() and the matching
// HTML/CSS for #debug-speed-badge
/*
function _updateDebugSpeedBadge(html) {
  const el = document.getElementById('debug-speed-badge');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML = html;
}
*/

function processStroke(lms) {
  const rW = lms[LM.R_WRIST], lW = lms[LM.L_WRIST];
  const wrist = (rW?.visibility ?? 0) >= (lW?.visibility ?? 0) ? rW : lW;
  if (!wrist || wrist.visibility < 0.4) return;

  const vt = app.recRecording ? app._recElapsed : videoEl.currentTime;

  // Pending serve check — must run before the cooldown guard so it fires during cooldown.
  // Check BOTH wrists — at contact MediaPipe sometimes favours the non-hitting arm.
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

  // Don't start a new stroke during the cooldown window after the last one
  if (!stroke.active && (vt - stroke.lastStrokeVT) < stroke.COOLDOWN) {
    stroke.prevPos = { x: wrist.x, y: wrist.y };
    stroke.prevVT  = vt;
    // _updateDebugSpeedBadge(`speed: —  (cooldown, ${(stroke.COOLDOWN - (vt - stroke.lastStrokeVT)).toFixed(2)}s left)\nstart≥${stroke.SPEED_START}  end<${stroke.SPEED_END}`);
    return;
  }

  if (stroke.prevPos && stroke.prevVT !== vt) {
    const dt = Math.abs(vt - stroke.prevVT);
    if (dt > 0 && dt < 1.0) {  // ignore big jumps (seek)
      const dx = wrist.x - stroke.prevPos.x;
      const dy = wrist.y - stroke.prevPos.y;
      const speed = bodyRelativeSpeed(dx, dy, dt, lms);
      // const _speedCls = speed > stroke.SPEED_START ? 'hot' : speed < stroke.SPEED_END ? 'cool' : '';
      // _updateDebugSpeedBadge(`speed: <span class="${_speedCls}">${speed.toFixed(3)}</span>\nstart≥${stroke.SPEED_START}  end<${stroke.SPEED_END}\nactive: ${stroke.active}`);

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
        // Require speed to stay below SPEED_END continuously for END_GRACE seconds
        // before actually ending the stroke — a brief mid-swing deceleration (e.g.
        // the pause in a two-hander's transition, or a kick serve) would otherwise
        // end the stroke early and register the follow-through as a second, separate
        // stroke once speed picks back up again.
        const isSlow = speed < stroke.SPEED_END && enoughTravel;
        if (isSlow) {
          if (stroke.slowSinceVT === null) stroke.slowSinceVT = vt;
        } else {
          stroke.slowSinceVT = null;
        }
        const slowLongEnough = stroke.slowSinceVT !== null && (vt - stroke.slowSinceVT) >= stroke.END_GRACE;
        // Second, independent end condition: if speed hasn't been "red" (above
        // SPEED_START) for RED_TIMEOUT seconds, end the stroke even if it never
        // sustained a clean dip below SPEED_END — catches a swing that stalls in
        // the "blue" zone (between the two thresholds) without ever going properly
        // slow, which the grace-window check above wouldn't otherwise catch.
        if (speed > stroke.SPEED_START) stroke.lastRedVT = vt;
        const redTimedOut = stroke.lastRedVT !== null && (vt - stroke.lastRedVT) > stroke.RED_TIMEOUT;
        // const sinceRed = stroke.lastRedVT !== null ? (vt - stroke.lastRedVT) : 0;
        // _updateDebugSpeedBadge(`speed: <span class="${_speedCls}">${speed.toFixed(3)}</span>\nstart≥${stroke.SPEED_START}  end<${stroke.SPEED_END}\nactive: ${stroke.active}\nsince red: ${sinceRed.toFixed(2)}s / ${stroke.RED_TIMEOUT}s`);
        if ((slowLongEnough || forceEnd || redTimedOut) && stroke.buffer.length >= stroke.MIN_FRAMES) {
          // Report the moment the swing actually slowed down, not `vt` (now) — which
          // is later by however long it took to CONFIRM the stroke had ended (the
          // END_GRACE or RED_TIMEOUT delay). Reporting raw `vt` would make the
          // recorded stop time overshoot the true end by a variable amount depending
          // on which condition fired, which is what made it look inconsistent.
          const actualEndVT = slowLongEnough ? stroke.slowSinceVT
            : redTimedOut ? stroke.lastRedVT
            : vt; // forceEnd: no clean "last known good" timestamp — use now
          stroke.slowSinceVT = null;
          stroke.lastRedVT   = null;
          const avg   = avgMetrics(stroke.buffer);
          const type  = classifyStrokeType(stroke.buffer);
          const score = scoreStroke(avg, type);

          // Voice feedback fires here, independent of the scan/marker reconciliation
          // below — recording has no background scan to sync against, so waiting on
          // that logic would sometimes silently skip speaking.
          if (app.recRecording && app.voiceFeedbackEnabled) speakStrokeFeedback(avg, type);

          // Use the scan marker's pre-computed score so the feedback panel and
          // marker colour are always the same number. Live playback updates the
          // type only (dense 30fps frames give better classification accuracy).
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

          // Sync with scan markers: refine type/score/endTime if scan found it,
          // or add a new marker if the scan hadn't finished yet. This part stays
          // conservative on purpose — only a close time match (or a still-in-
          // progress scan) gets to create/mutate a stored marker.
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
            // scanComplete && !withinWindow: don't create/mutate a marker (the scan
            // already catalogued every real stroke, so this is probably a timing
            // mismatch rather than a genuinely new one) — but the panel should
            // still reflect the stroke that was just played instead of silently
            // freezing on whatever was shown last.
            panelResult = { metrics: avg, cards: generateFeedback(avg, type), score: displayScore, type, poseUnreliable: stroke.poseUnreliable };
          }
          if (panelResult) {
            stroke.frozenResult = panelResult;
            if (!app.strokeByStrokeMode) renderFrozenFeedback();
          }

          renderStrokeMarkers();

          // Watch for wrist-above-shoulder in the next 2.5 s (serve reclassification)
          const pendingIdx = withinWindow ? stroke.markers.indexOf(nearest)
            : (!app.scanComplete ? stroke.markers.length - 1 : -1);
          stroke.pendingServeCheck = pendingIdx >= 0
            ? { markerIdx: pendingIdx, expiresVT: vt + 2.5 } : null;

          // Auto-pause is now handled by timeupdate scanning marker positions,
          // so no timeout needed here.
        }
      }
    }
  }
  stroke.prevPos = { x: wrist.x, y: wrist.y };
  stroke.prevVT  = vt;
}
