'use strict';

// ════════════════════════════════════════════════════════════
//  APP STATE
// ════════════════════════════════════════════════════════════
const app = {
  clips:         [],   // {id, name, size, url, storagePath}
  uploads:       [],   // {id, name, progress, error}
  activeClipId:  null,
  poseModel:     null,
  cocoModel:     null,
  modelsReady:   false,
  landmarks:     null,
  racquetBox:    null,
  liveBallPos:   null,  // {x,y} normalised, most recent detection
  ballTrail:     [],    // [{x,y,t}] recent detections for path drawing (t = performance.now())
  ballDebugCount: 0,    // raw matching pixel count from last detectBall call
  detecting:     false,
  rafId:         null,
  frameCount:    0,
  detFrames:     0,
  lastFpsUpdate: performance.now(),
  scanComplete:    false, // true once a scan has finished (cached or fresh) (no new markers)
  scanning:        false, // true while auto-scan is running
  scanSending:     false, // true while a scan-frame poseModel.send is in-flight
  scanPoses:       0,     // diagnostic: poses detected during current scan
  scanGeneration:      0,     // incremented on every new scan; old coroutines bail when theirs differs
  strokeByStrokeMode:  false,
  lastPausedMarkerVT:  -Infinity,
  lastShownMarkerVT:   -Infinity, // last marker's score shown in continuous (non-auto-pause) playback — see timeupdate handler
  lastLandmarkVT:      -Infinity, // last video time a pose was detected (live path)
  lastNoBodyWarnVT:    -Infinity, // last video time we showed the no-body warning
  // Canvas sync cache
  canvasL: -1, canvasT: -1, canvasW: -1, canvasH: -1,
  // Settings
  ballDetectionOverlay: true, // when false, circles are hidden but detection still runs
  angleOverlay: false,        // when true, joint angle numbers are drawn on the skeleton
  voiceFeedbackEnabled: true, // when true, short coaching tips are read aloud after each stroke while recording
  // Recording
  recMode:      false, // true while recording screen is open (camera running)
  recRecording: false, // true while MediaRecorder is actively recording
  _recElapsed:  0,     // seconds since recording started (used as virtual video time)
  activeBlobUrl: null, // object URL for the current clip when loaded as a same-origin blob
  clipSelectGeneration: 0, // bumped on every selectClip() call; bails stale async loads
  activeVideoSrcUrl: null, // last URL assigned to videoEl.src, used to retry on transient load errors
  videoRetryCount: 0,      // consecutive retry attempts for the current clip's video element
  clipsLoaded: false,      // true once the first Firestore videos snapshot has arrived — distinguishes "still loading" from "genuinely no videos"
};

// ════════════════════════════════════════════════════════════
//  POSE LANDMARKS
// ════════════════════════════════════════════════════════════
const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13,    R_ELBOW: 14,
  L_WRIST: 15,    R_WRIST: 16,
  L_HIP: 23,      R_HIP: 24,
  L_KNEE: 25,     R_KNEE: 26,
  L_ANKLE: 27,    R_ANKLE: 28,
};

const SKELETON_EDGES = [
  [LM.L_SHOULDER, LM.R_SHOULDER], [LM.L_SHOULDER, LM.L_ELBOW], [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW], [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, LM.L_HIP], [LM.R_SHOULDER, LM.R_HIP], [LM.L_HIP, LM.R_HIP],
  [LM.L_HIP, LM.L_KNEE], [LM.L_KNEE, LM.L_ANKLE], [LM.R_HIP, LM.R_KNEE], [LM.R_KNEE, LM.R_ANKLE],
  [LM.NOSE, LM.L_SHOULDER], [LM.NOSE, LM.R_SHOULDER],
];

// ════════════════════════════════════════════════════════════
//  COURT CALIBRATION
// ════════════════════════════════════════════════════════════
let courtCalib = null; // null if not calibrated, or {points:[{x,y}×4]} in normalised coords.
const calib = {
  active:    false,
  points:    [],      // [{x,y} normalised], freeform polygon vertices
  closed:    false,   // true once the polygon has been closed
  dragIdx:   -1,      // index of the point currently being dragged, or -1
  cursorPos: null,    // {x,y} normalised mouse position (for crosshair preview)
};

// ════════════════════════════════════════════════════════════
//  MISC STATE FLAGS
// ════════════════════════════════════════════════════════════
let playerHandedness = 'right'; // 'right' | 'left'
let authMode = 'signin'; // 'signin' | 'signup'
