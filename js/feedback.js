'use strict';

// ════════════════════════════════════════════════════════════
//  METRICS COMPUTATION
// ════════════════════════════════════════════════════════════
function computeMetrics(lms, aspect = 1) {
  const m = {};
  const a = (ai,bi,ci) => vis(lms[ai]) && vis(lms[bi]) && vis(lms[ci])
    ? angleDeg({x:lms[ai].x,y:lms[ai].y},{x:lms[bi].x,y:lms[bi].y},{x:lms[ci].x,y:lms[ci].y}, aspect)
    : undefined;

  m.leftElbow  = a(LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST);
  m.rightElbow = a(LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST);
  m.leftKnee   = a(LM.L_HIP,      LM.L_KNEE,  LM.L_ANKLE);
  m.rightKnee  = a(LM.R_HIP,      LM.R_KNEE,  LM.R_ANKLE);

  if (vis(lms[LM.L_SHOULDER]) && vis(lms[LM.R_SHOULDER])) {
    const dx = (lms[LM.R_SHOULDER].x - lms[LM.L_SHOULDER].x) * aspect;
    const dy = lms[LM.R_SHOULDER].y - lms[LM.L_SHOULDER].y;
    let tilt = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI); // 0-180
    // A level shoulder line has the same physical tilt whichever shoulder you
    // measure it from — but when body rotation flips which shoulder is on
    // which side in the image, dx flips sign and this would otherwise read
    // as ~180° instead of ~0°. Fold the upper half back down to [0,90].
    if (tilt > 90) tilt = 180 - tilt;
    m.shoulderTilt = tilt;
  }

  if (vis(lms[LM.L_SHOULDER]) && vis(lms[LM.R_SHOULDER]) && vis(lms[LM.L_HIP]) && vis(lms[LM.R_HIP])) {
    const msX = (lms[LM.L_SHOULDER].x + lms[LM.R_SHOULDER].x) / 2 * aspect;
    const msY = (lms[LM.L_SHOULDER].y + lms[LM.R_SHOULDER].y) / 2;
    const mhX = (lms[LM.L_HIP].x + lms[LM.R_HIP].x) / 2 * aspect;
    const mhY = (lms[LM.L_HIP].y + lms[LM.R_HIP].y) / 2;
    m.trunkLean = Math.abs(Math.atan2(msX - mhX, mhY - msY) * 180 / Math.PI);
  }

  const rW = lms[LM.R_WRIST], rS = lms[LM.R_SHOULDER];
  const lW = lms[LM.L_WRIST], lS = lms[LM.L_SHOULDER];
  if (vis(rW) && vis(rS)) m.rightWristHigh = rS.y - rW.y;
  if (vis(lW) && vis(lS)) m.leftWristHigh  = lS.y - lW.y;

  // Average visibility of key landmarks — used to warn when player is out of frame
  const KEY_VIS_LMS = [
    LM.L_SHOULDER, LM.R_SHOULDER,
    LM.L_ELBOW,    LM.R_ELBOW,
    LM.L_WRIST,    LM.R_WRIST,
    LM.L_HIP,      LM.R_HIP,
    LM.L_KNEE,     LM.R_KNEE,
  ];
  m.bodyVisibility = KEY_VIS_LMS.reduce((s, i) => s + (lms[i]?.visibility ?? 0), 0) / KEY_VIS_LMS.length;

  return m;
}

// ════════════════════════════════════════════════════════════
//  FEEDBACK GENERATION
// ════════════════════════════════════════════════════════════
// Physically plausible ranges for each metric.
// Values outside these are almost certainly pose detection artefacts.
const PLAUSIBLE = {
  knee:         [70,  185],
  elbow:        [15,  180],
  shoulderTilt: [0,   60],
  trunkLean:    [0,   45],
};
function plausible(val, key) {
  const [lo, hi] = PLAUSIBLE[key];
  return val >= lo && val <= hi;
}

function generateFeedback(m, type) {
  const cards = [];
  const isServe = type?.type === 'Serve / Overhead';

  const knees = [m.leftKnee, m.rightKnee].filter(v => v !== undefined);
  if (knees.length) {
    const avg = knees.reduce((a,b)=>a+b,0)/knees.length;
    if (!plausible(avg, 'knee')) {
      // skip — measurement is outside physical range, likely a detection error
    } else if (isServe) {
      if (avg > 178)
        cards.push({type:'warn', cat:'Stance', short:'Allow slight knee flex', text:'Legs very straight on average — allow a touch of knee bend during your loading phase for a safer, more powerful leg drive.', sev:(avg-178)/178});
      else if (avg >= 100)
        cards.push({type:'good', cat:'Stance', short:'Good leg drive', text:'Good knee extension through the serve — solid leg drive.'});
      else
        cards.push({type:'info', cat:'Stance', short:'Deep knee bend', text:'Deep knee bend on average this swing — make sure you extend fully upward into contact.'});
    } else if (avg > 168)
      cards.push({type:'warn', cat:'Stance', short:'Bend your knees more', text:'Legs nearly straight — bend your knees for an athletic base. This is crucial for stability and power transfer.', sev:(avg-152)/152});
    else if (avg > 152)
      cards.push({type:'warn', cat:'Stance', short:'Bend knees a bit more', text:'Bend knees a bit more. A lower center of gravity improves balance and explosive movement.', sev:(avg-152)/152});
    else if (avg >= 115)
      cards.push({type:'good', cat:'Stance', short:'Great knee bend', text:'Excellent knee bend. Your athletic position looks solid and ready to generate power.'});
    else
      cards.push({type:'info', cat:'Stance', short:'Very deep knee bend', text:'Very deep knee bend — make sure you can still transfer weight and move laterally.'});
  }

  const isRightHanded = playerHandedness !== 'left';
  const elbow = isRightHanded ? (m.rightElbow ?? m.leftElbow) : (m.leftElbow ?? m.rightElbow);
  if (elbow !== undefined && plausible(elbow, 'elbow')) {
    if (elbow > 162)
      cards.push({type:'warn', cat:'Arm', short:'Add slight elbow bend', text:'Arm too straight — keep a slight elbow bend to absorb pace and maintain control through contact.', sev:(elbow-162)/162});
    else if (elbow >= 100)
      cards.push({type:'good', cat:'Arm', short:'Good arm extension', text:'Good arm extension with a natural elbow bend — solid for power transfer.'});
    else if (elbow >= 65)
      cards.push({type:'info', cat:'Arm', short:'Compact elbow angle', text:'Compact elbow angle. Fine during backswing or follow-through — ensure full extension at contact.'});
    else
      cards.push({type:'warn', cat:'Arm', short:'Extend arm at contact', text:'Elbow staying compact through the swing on average. Drive your arm forward through the ball for more power.', sev:(65-elbow)/65});
  }

  // Shoulder tilt — how level the shoulder line is (vertical tilt/roll between
  // the two shoulders), not how far the shoulders have turned toward the net.
  // That's a different, unmeasured concept — don't conflate the two here.
  if (m.shoulderTilt !== undefined && plausible(m.shoulderTilt, 'shoulderTilt')) {
    if (m.shoulderTilt < 7)
      cards.push({type:'good', cat:'Posture', short:'Shoulders level', text:'Shoulders level on average — balanced upper-body line.'});
    else if (m.shoulderTilt < 16)
      cards.push({type:'info', cat:'Posture', short:'Slight shoulder tilt', text:'Slight shoulder tilt. Keeping shoulders level helps maintain consistent balance and contact height.'});
    else
      cards.push({type:'warn', cat:'Posture', short:'Shoulders tilted', text:'Shoulders noticeably tilted — one side dropping lower than the other can throw off balance and contact point.', sev:(m.shoulderTilt-16)/16});
  }

  // Trunk lean
  if (m.trunkLean !== undefined && plausible(m.trunkLean, 'trunkLean')) {
    if (m.trunkLean <= 11)
      cards.push({type:'good', cat:'Posture', short:'Good upright posture', text:'Good upright spine alignment on average.'});
    else if (m.trunkLean <= 23)
      cards.push({type:'info', cat:'Posture', short:'Slight trunk lean', text:'Slight trunk lean — a little forward lean is natural; maintain overall balance.'});
    else
      cards.push({type:'warn', cat:'Posture', short:'Stay more upright', text:'Significant torso lean. Staying more upright improves consistency and reduces back stress.', sev:(m.trunkLean-23)/23});
  }

  // High arm (serve/overhead)
  const highArm = Math.max(m.rightWristHigh ?? -1, m.leftWristHigh ?? -1);
  if (highArm > 0.07)
    cards.push({type:'tip', cat:'Shot Type', short:'Serve/overhead detected', text:'High arm extension detected — looks like a serve or overhead. Focus on full trophy position and consistent toss.'});

  if (app.racquetBox)
    cards.push({type:'info', cat:'Racquet', short:'Racquet detected', text:'Racquet detected in frame. Tracking position relative to body for swing path analysis.'});

  return cards;
}

// iOS Safari only allows SpeechSynthesis to actually produce audio if the first
// speak() call in the page session happens synchronously inside a real user-gesture
// handler (a tap). speakStrokeFeedback() is triggered asynchronously from a pose-
// detection callback, which has no gesture in its call stack — iOS silently queues
// those calls without ever playing them (no onstart, no onerror, nothing). Priming
// with a near-silent utterance from an actual onclick handler (see openRecordModal)
// unlocks speech for the rest of the session so later async calls work normally.
function _primeVoiceSynthesis() {
  if (!window.speechSynthesis) return;
  // Separately from the gesture-unlock issue: iOS can also silently no-op speak()
  // calls made before its voice list has finished loading. Call getVoices() now
  // to nudge that loading to start early, well before the first real utterance.
  speechSynthesis.getVoices();
  try {
    const primer = new SpeechSynthesisUtterance(' ');
    primer.volume = 0.01;
    speechSynthesis.speak(primer);
  } catch (e) {}
}

// Speaks the single most useful coaching tip for a just-completed stroke, while
// recording. Only one short line per stroke — reading out every card would talk
// over the player's next swing.
const VOICE_FEEDBACK_PRIORITY = { warn: 0, tip: 1, info: 2, good: 3 };
function speakStrokeFeedback(m, type) {
  if (!window.speechSynthesis) return;
  const cards = generateFeedback(m, type);
  if (!cards.length) return;
  const warnCards = cards.filter(c => c.type === 'warn');
  const best = warnCards.length
    ? warnCards.reduce((a, b) => (b.sev ?? 0) > (a.sev ?? 0) ? b : a)
    : cards.reduce((a, b) =>
        (VOICE_FEEDBACK_PRIORITY[b.type] ?? 4) < (VOICE_FEEDBACK_PRIORITY[a.type] ?? 4) ? b : a);
  const text = best.short || best.text;
  if (!text) return;

  speechSynthesis.cancel(); // don't queue behind a previous stroke's still-playing line
  const utter = new SpeechSynthesisUtterance(text);
  // Leaving utter.voice unset relies on the engine's implicit default, which some
  // browsers handle inconsistently before voices have fully loaded — pick one
  // explicitly when the list is available.
  const voices = speechSynthesis.getVoices();
  if (voices.length) {
    utter.voice = voices.find(v => v.lang?.startsWith('en')) || voices[0];
  }
  utter.onerror = (e) => {
    // 'canceled'/'interrupted' fire every time a later speakStrokeFeedback() call
    // cancels this same still-playing utterance to speak the next stroke's line
    // (see the cancel() above) — that's expected, intentional behavior, not a
    // real failure. Only genuine synthesis failures are worth logging.
    if (e.error === 'canceled' || e.error === 'interrupted') return;
    console.warn('[TA] Speech synthesis error:', e.error);
  };
  speechSynthesis.speak(utter);
}

function scoreStroke(m, type) {
  const isServe = type?.type === 'Serve / Overhead';
  let pts = 0, max = 0;
  const score1 = (val, min, max_val, weight, plausKey) => {
    if (val === undefined) return;
    const w = plausible(val, plausKey) ? weight : weight * 0.1;
    max += w;
    if (val >= min && val <= max_val) pts += w;
    else if (val >= min*0.85 && val <= max_val*1.1) pts += w * 0.55;
    else pts += w * 0.12;
  };
  const knees = [m.leftKnee, m.rightKnee].filter(v=>v!==undefined);
  const [kneeMin, kneeMax] = isServe ? [100, 178] : [115, 152];
  if (knees.length) score1(knees.reduce((a,b)=>a+b,0)/knees.length, kneeMin, kneeMax, 30, 'knee');
  const isRightHandedScore = playerHandedness !== 'left';
  score1(isRightHandedScore ? (m.rightElbow ?? m.leftElbow) : (m.leftElbow ?? m.rightElbow), 100, 162, 30, 'elbow');
  score1(m.shoulderTilt, 0, 7, 20, 'shoulderTilt');
  score1(m.trunkLean,    0, 11, 20, 'trunkLean');
  return max > 0 ? Math.round(pts / max * 100) : null;
}

function toggleStrokeByStroke() {
  app.strokeByStrokeMode = document.getElementById('sbs-toggle').checked;
  saveUserSetting('strokeByStrokeMode', app.strokeByStrokeMode);
}

function nextStroke() {
  if (app.sbsPauseTimeout) { clearTimeout(app.sbsPauseTimeout); app.sbsPauseTimeout = null; }
  app.lastLandmarkVT   = videoEl.currentTime;
  app.lastNoBodyWarnVT = videoEl.currentTime;
  // Restore the last stroke's feedback (or waiting state) so the warning
  // screen doesn't linger once the player resumes
  if (stroke.frozenResult) {
    renderFrozenFeedback();
  } else {
    setFeedbackWaiting();
  }
  videoEl.play();
}


function showNoBodyBar() {
  document.getElementById('no-body-bar').classList.add('visible');
}

function hideNoBodyBar() {
  document.getElementById('no-body-bar').classList.remove('visible');
  app.lastNoBodyWarnVT = videoEl.currentTime;
}

// Returns true when MediaPipe landmarks violate basic anatomical ordering.
// In MediaPipe normalised coords Y=0 is the top of the frame, Y=1 is the
// bottom — so a body part that is physically higher should have a SMALLER Y.
// Normal ordering: shoulder.y < hip.y < knee.y < ankle.y
// Any significant inversion signals a detection error.
function isAnatomicallyImpossible(lms) {
  const MIN_VIS = 0.5;
  const MARGIN  = 0.05; // allow 5% slack for natural variation / camera tilt
  const ok = lm => lm && lm.visibility >= MIN_VIS;

  // Nose must be above shoulders
  if (ok(lms[LM.NOSE]) && ok(lms[LM.L_SHOULDER]) && lms[LM.NOSE].y > lms[LM.L_SHOULDER].y + MARGIN) return true;
  if (ok(lms[LM.NOSE]) && ok(lms[LM.R_SHOULDER]) && lms[LM.NOSE].y > lms[LM.R_SHOULDER].y + MARGIN) return true;

  // Shoulders must be above hips
  if (ok(lms[LM.L_SHOULDER]) && ok(lms[LM.L_HIP]) && lms[LM.L_SHOULDER].y > lms[LM.L_HIP].y + MARGIN) return true;
  if (ok(lms[LM.R_SHOULDER]) && ok(lms[LM.R_HIP]) && lms[LM.R_SHOULDER].y > lms[LM.R_HIP].y + MARGIN) return true;

  // Hips must be above knees
  if (ok(lms[LM.L_HIP]) && ok(lms[LM.L_KNEE]) && lms[LM.L_HIP].y > lms[LM.L_KNEE].y + MARGIN) return true;
  if (ok(lms[LM.R_HIP]) && ok(lms[LM.R_KNEE]) && lms[LM.R_HIP].y > lms[LM.R_KNEE].y + MARGIN) return true;

  // Knees must be above ankles
  if (ok(lms[LM.L_KNEE]) && ok(lms[LM.L_ANKLE]) && lms[LM.L_KNEE].y > lms[LM.L_ANKLE].y + MARGIN) return true;
  if (ok(lms[LM.R_KNEE]) && ok(lms[LM.R_ANKLE]) && lms[LM.R_KNEE].y > lms[LM.R_ANKLE].y + MARGIN) return true;

  return false;
}

function showCameraShiftBar() {
  document.getElementById('camera-shift-bar').classList.add('visible');
}

function hideCameraShiftBar() {
  document.getElementById('camera-shift-bar').classList.remove('visible');
}

function showDetectErrorBar() {
  document.getElementById('detect-error-bar').classList.add('visible');
}

function hideDetectErrorBar() {
  document.getElementById('detect-error-bar').classList.remove('visible');
}

function showBadPoseBar() {
  document.getElementById('bad-pose-bar').classList.add('visible');
}

function hideBadPoseBar() {
  document.getElementById('bad-pose-bar').classList.remove('visible');
}

function skipToVisibleStroke() {
  const currentVT = videoEl.currentTime;
  // Find the next marker after the current position with CONFIRMED acceptable
  // body visibility — a marker with no computed metrics at all means visibility
  // was never measured, not that it's good, so it must not pass this check.
  const nextGood = stroke.markers.find(m =>
    m.startTime > currentVT &&
    (m.metrics?.bodyVisibility ?? 0) >= 0.45
  );
  if (nextGood) {
    // Seek to 0.5 s before the stroke so the auto-pause fires naturally
    videoEl.currentTime = Math.max(0, nextGood.startTime - 0.5);
  }
  videoEl.play();
}

let _undoMarker = null; // { marker, index } — single-level undo for "Not a stroke"

function notAStroke() {
  if (stroke.lastDetectedStartVT !== null && stroke.markers.length) {
    let bestIdx = -1, bestDist = Infinity;
    stroke.markers.forEach((m, i) => {
      const d = Math.abs(m.startTime - stroke.lastDetectedStartVT);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    if (bestIdx >= 0 && bestDist < 2.0) {
      // Only clear/replace the previous undo slot once a new deletion actually
      // happens — a no-op call (nothing matched) shouldn't destroy a still-valid
      // pending undo from an earlier call.
      _undoMarker = { marker: { ...stroke.markers[bestIdx] }, index: bestIdx };
      stroke.deletedTimes.push(_undoMarker.marker.startTime);
      stroke.markers.splice(bestIdx, 1);
      renderStrokeMarkers();
      saveScanResults(true); // force: this is a deliberate user edit, not a scan result
      document.getElementById('undo-bar').classList.add('visible');
    }
  }
  stroke.lastDetectedStartVT = null;
  videoEl.play();
}

function undoDeleteStroke() {
  if (!_undoMarker) return;
  const restoredTime = _undoMarker.marker.startTime;
  stroke.deletedTimes = stroke.deletedTimes.filter(t => Math.abs(t - restoredTime) > 0.1);
  stroke.markers.splice(_undoMarker.index, 0, _undoMarker.marker);
  stroke.markers.sort((a, b) => a.startTime - b.startTime);
  _undoMarker = null;
  renderStrokeMarkers();
  saveScanResults(true); // force: this is a deliberate user edit, not a scan result
  document.getElementById('undo-bar').classList.remove('visible');
  setFeedbackWaiting('Stroke restored.');
}

function hideUndoBar() {
  _undoMarker = null;
  document.getElementById('undo-bar').classList.remove('visible');
}

// Collapsible <details> elements get replaced wholesale on every re-render
// (new stroke, new frame), which would otherwise reset any section the user
// manually expanded back to its hard-coded default each time. Track which
// ones the user has explicitly opened/closed so re-renders can restore that
// choice instead of clobbering it. Keyed by a stable identity, not DOM
// identity, since the actual elements are recreated on every render.
let _metricsTableExpanded = null; // null = no explicit user choice yet — use the default
const _expandedFeedbackCardKeys = new Set();

// After injecting HTML containing .metrics-details/.fb-card-detail elements,
// call this so toggling them updates the trackers above for the next render.
function _wireDetailsPersistence(container) {
  const metricsDetails = container.querySelector('.metrics-details');
  if (metricsDetails) {
    metricsDetails.addEventListener('toggle', () => { _metricsTableExpanded = metricsDetails.open; });
  }
  container.querySelectorAll('.fb-card-detail').forEach(el => {
    const key = el.dataset.cardKey;
    if (!key) return;
    el.addEventListener('toggle', () => {
      if (el.open) _expandedFeedbackCardKeys.add(key);
      else _expandedFeedbackCardKeys.delete(key);
    });
  });
}

// Renders coaching cards, shared between the frozen post-stroke feedback panel
// and the live per-frame feedback panel shown while recording.
function feedbackCardsHtml(cards, isMobLayout) {
  if (!cards.length) return '';
  let html = `<div class="fb-section"><div class="fb-lbl">Coaching</div>`;
  for (const c of cards) {
    const tag = c.type === 'good' ? '✓ Great' : c.type === 'warn' ? '⚠ Improve' : c.type === 'tip' ? 'Tip' : 'ℹ Info';
    if (isMobLayout) {
      const tagWord = c.type === 'good' ? 'Great' : c.type === 'warn' ? 'Improve' : c.type === 'tip' ? 'Tip' : 'Info';
      // Same category + headline recurs across different strokes with the same
      // issue — use it as a stable identity so "user expanded this" survives
      // the <details> element itself being recreated on the next render.
      // Keep the Set keyed on the raw (unescaped) string — el.dataset reads
      // back the HTML-decoded attribute value, so the two must match exactly.
      const cardKeyRaw = c.cat + '|' + c.type + '|' + (c.short || c.text);
      const cardOpen = _expandedFeedbackCardKeys.has(cardKeyRaw) ? ' open' : '';
      html += `<div class="fb-card ${c.type}">
        <details class="fb-card-detail" data-card-key="${escHtml(cardKeyRaw)}"${cardOpen}>
          <summary class="fb-card-summary"><span class="fb-tag">${c.cat} — ${tagWord}</span> ${c.short || c.text}</summary>
          <div class="fb-text">${c.text}</div>
        </details>
      </div>`;
    } else {
      html += `<div class="fb-card ${c.type}"><div class="fb-tag">${c.cat} — ${tag}</div><div class="fb-text">${c.text}</div></div>`;
    }
  }
  html += `</div>`;
  return html;
}

const JOINT_ANGLE_METRIC_DEFS = [
  { key:'leftElbow',    label:'Left Elbow',    good:[100,162], plausKey:'elbow'        },
  { key:'rightElbow',   label:'Right Elbow',   good:[100,162], plausKey:'elbow'        },
  { key:'leftKnee',     label:'Left Knee',     good:[115,152], plausKey:'knee'         },
  { key:'rightKnee',    label:'Right Knee',    good:[115,152], plausKey:'knee'         },
  { key:'shoulderTilt', label:'Shoulder Tilt', good:[0,7],     plausKey:'shoulderTilt' },
  { key:'trunkLean',    label:'Trunk Lean',    good:[0,11],    plausKey:'trunkLean'    },
];

// Collapsible joint-angle table, shared between the frozen post-stroke feedback
// panel and the live per-frame feedback panel shown while recording.
function jointAngleTableHtml(m, isMobLayout, type) {
  const isServe = type?.type === 'Serve / Overhead';
  // Default: open on desktop, closed on mobile — but once the user has
  // explicitly toggled it, honor their choice instead on every later render.
  const defaultOpen = !isMobLayout;
  const openAttr = (_metricsTableExpanded ?? defaultOpen) ? ' open' : '';
  let html = `<div class="fb-section"><details class="metrics-details"${openAttr}>
    <summary class="fb-lbl metrics-summary">Joint Angles</summary>
    <div class="metrics-tbl" style="margin-top:6px">`;
  for (const def of JOINT_ANGLE_METRIC_DEFS) {
    if (m[def.key] === undefined) {
      html += `<div class="m-row"><span class="m-name">${def.label}</span><span class="m-val m-dim">low visibility</span></div>`;
      continue;
    }
    const val  = Math.round(m[def.key]);
    const isOutlier  = !plausible(val, def.plausKey);
    if (isOutlier) {
      // Physically implausible — almost certainly a detection error. Don't show
      // a number at all; showing one (even flagged) invites reading it as data.
      html += `<div class="m-row"><span class="m-name">${def.label}</span><span class="m-val m-dim" title="Value outside normal physical range — likely a detection error">possibly inaccurate</span></div>`;
      continue;
    }
    const isKnee = def.key === 'leftKnee' || def.key === 'rightKnee';
    const good = (isServe && isKnee) ? [100, 178] : def.good;
    const cls  = val >= good[0] && val <= good[1] ? 'm-good'
               : (val < good[0]*0.8 || val > good[1]*1.12) ? 'm-bad' : 'm-warn';
    html += `<div class="m-row"><span class="m-name">${def.label}</span><span class="m-val ${cls}">${val}°</span></div>`;
  }
  html += `</div></details></div>`;
  return html;
}

// Live joint-angle feedback shown on the recording screen — same coaching cards
// and joint-angle table as post-stroke analysis, but computed from the current
// frame's landmarks (no stroke classification or score, since no stroke has
// necessarily completed yet).
function renderRecFeedback(lms) {
  const scroll = document.getElementById('rec-feedback-scroll');
  if (!scroll) return;

  if (!lms) {
    scroll.innerHTML = `
      <div class="fb-waiting">
        Get in frame to see live joint-angle feedback.
      </div>`;
    return;
  }

  const recPreview = document.getElementById('rec-preview');
  const m = computeMetrics(lms, recPreview.videoWidth / recPreview.videoHeight);
  const bodyVis = m.bodyVisibility ?? 0;
  if (bodyVis < 0.45) {
    const noDetection = bodyVis < 0.15;
    scroll.innerHTML = `
      <div class="fb-waiting">
        <div style="font-size:13px;font-weight:600;color:#d29922;margin-bottom:6px">
          ${noDetection ? 'Player outside frame' : 'Player partially out of frame'}
        </div>
        <div style="font-size:12px;color:#8b949e;line-height:1.6">
          ${noDetection
            ? 'No body detected — step into frame to see live feedback.'
            : "Key body landmarks aren't visible — move fully into frame for accurate feedback."}
        </div>
      </div>`;
    return;
  }

  const isMobLayout = document.body.classList.contains('force-mobile') ||
    (!document.body.classList.contains('force-desktop') && window.innerWidth <= 768);

  const cards = generateFeedback(m);
  let html = cards.length ? feedbackCardsHtml(cards, isMobLayout) : `
    <div class="fb-waiting" style="padding:14px 6px">
      <div class="fb-waiting-icon">✓</div>
      Nothing to flag right now — keep swinging.
    </div>`;
  html += jointAngleTableHtml(m, isMobLayout);

  scroll.innerHTML = html;
  _wireDetailsPersistence(scroll);
}

function showMarkerFeedback(marker, idx) {
  if (!marker.metrics && !marker.cards) return;
  // Track which marker is on screen regardless of how it got there (auto-pause,
  // the continuous-playback reveal, or a direct click on its tick) — notAStroke()
  // uses this to know exactly which marker "Not a stroke" should remove.
  stroke.lastDetectedStartVT = marker.startTime;
  stroke.frozenResult = {
    metrics:        marker.metrics || {},
    cards:          marker.cards   || [],
    score:          marker.score,
    type:           marker.type,
    poseUnreliable: marker.poseUnreliable || false,
  };
  renderFrozenFeedback();
}

// ════════════════════════════════════════════════════════════
//  FEEDBACK UI
// ════════════════════════════════════════════════════════════
function renderFrozenFeedback() {
  const { metrics: m, cards, score, poseUnreliable } = stroke.frozenResult;
  const scroll = document.getElementById('feedback-scroll');

  // Visibility check — warn and skip if player not fully in frame
  const bodyVis = m.bodyVisibility ?? 1; // unknown (old cache) = assume fine
  if (bodyVis < 0.45) {
    const noDetection = bodyVis < 0.15;
    scroll.innerHTML = `
      <div class="fb-waiting">
        <div style="font-size:13px;font-weight:600;color:#d29922;margin-bottom:6px">
          ${noDetection ? 'Player outside frame' : 'Player partially out of frame'}
        </div>
        <div style="font-size:12px;color:#8b949e;line-height:1.6">
          ${noDetection
            ? 'No body was detected — the player appears to be outside the frame.'
            : "Key body landmarks aren't visible — this stroke can't be accurately analyzed."}
        </div>
      </div>
      <div class="sbs-actions">
        <button class="sbs-next" onclick="skipToVisibleStroke()">⏭ Skip to next visible</button>
        <button class="sbs-reject" onclick="nextStroke()">▶ Continue</button>
      </div>`;
    hideUndoBar();
    return;
  }

  let html = '';

  const isMobLayout = document.body.classList.contains('force-mobile') ||
    (!document.body.classList.contains('force-desktop') && window.innerWidth <= 768);

  // Stroke label with type
  const t = stroke.frozenResult.type;
  const typeLabel = t ? (t.icon ? `${t.icon} ${t.type}` : t.type) : 'Stroke';

  // Score — explicit numeric check, not just "!== null": a marker with a
  // missing/corrupted score field (e.g. old cached data predating this field)
  // would otherwise pass "undefined !== null" and render the literal text
  // "undefined" in the score badge.
  const hasScore = typeof score === 'number' && !isNaN(score);
  let sc, bc, desc;
  if (hasScore) {
    sc   = score >= 70 ? 'good' : score >= 45 ? 'ok' : 'bad';
    bc   = score >= 70 ? '#3fb950' : score >= 45 ? '#d29922' : '#f85149';
    desc = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 50 ? 'Fair' : 'Needs work';
  }

  if (isMobLayout) {
    // Compact layout: classification badge + mini score box share a row so
    // the score no longer eats the full panel width on phones.
    html += `<div class="fb-top-row">
      <div class="fb-stroke-label"><div class="dot"></div> ${typeLabel}</div>
      ${hasScore ? `<div class="score-badge score-badge-mini">
        <div class="score-val ${sc}">${score}</div>
      </div>` : ''}
    </div>`;
    if (hasScore && poseUnreliable) {
      html += `<div style="margin:-4px 0 12px;font-size:11px;color:#8b949e;display:flex;align-items:center;gap:5px"><span style="color:#d29922">⚠</span> Body landmarks were unreliable during this stroke — score may be inaccurate</div>`;
    }
  } else {
    html += `<div style="margin-bottom:10px">
      <div class="fb-stroke-label"><div class="dot"></div> ${typeLabel}</div>
    </div>`;
    if (hasScore) {
      html += `<div class="fb-section"><div class="fb-lbl">Stroke Score</div>
        <div class="score-badge">
          <div><div class="score-lbl">Overall</div><div class="score-val ${sc}">${score}</div></div>
          <div>
            <div class="score-bar-wrap"><div class="score-bar" style="width:${score}%;background:${bc}"></div></div>
            <div class="score-desc">${desc} &nbsp;/100</div>
          </div>
        </div>
        ${poseUnreliable ? `<div style="margin-top:7px;font-size:11px;color:#8b949e;display:flex;align-items:center;gap:5px"><span style="color:#d29922">⚠</span> Body landmarks were unreliable during this stroke — score may be inaccurate</div>` : ''}
        </div>`;
    }
  }

  // Feedback cards (shown first)
  html += feedbackCardsHtml(cards, isMobLayout);

  // Metrics table (below coaching; collapsible on mobile)
  html += jointAngleTableHtml(m, isMobLayout, t);

  scroll.innerHTML = html;
  hideUndoBar();

  // "Not a stroke" is useful regardless of playback mode — a misdetection is a
  // misdetection whether or not auto-pause happened to be on when it showed up.
  // "Next stroke" only makes sense when auto-pause actually paused the video for
  // this stroke; showing it during normal continuous playback (already playing)
  // would just be a no-op button.
  scroll.innerHTML += `
    <div class="sbs-actions">
      ${app.strokeByStrokeMode ? `<button class="sbs-next" onclick="nextStroke()">▶ Next stroke</button>` : ''}
      <button class="sbs-reject" onclick="notAStroke()">✕ Not a stroke</button>
    </div>`;
  // Must run after the LAST innerHTML write above — the += just before this
  // reparses the whole container, which would otherwise discard listeners
  // attached to the metrics-details/fb-card-detail elements written earlier.
  _wireDetailsPersistence(scroll);
}

function setFeedbackWaiting(msg) {
  document.getElementById('feedback-scroll').innerHTML = `
    <div class="fb-waiting">
      ${msg || 'Play the video and swing.<br>Feedback will appear after each stroke.'}
    </div>`;
}

