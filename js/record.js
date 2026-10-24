'use strict';

// ════════════════════════════════════════════════════════════
//  CAMERA RECORDING
// ════════════════════════════════════════════════════════════
(function() {
  let _stream = null, _mr = null, _chunks = [], _timerInt = null, _secs = 0;
  let _recStartMs = 0, _recEndMs = 0;  // performance.now() timestamps for exact duration
  let _facing = 'environment';
  // Bumped by _stopPreview() — invalidates any in-flight _startPreview() call
  // (e.g. one still awaiting the camera permission prompt when the modal is
  // closed), so a late-resolving getUserMedia() gets stopped instead of
  // silently starting the camera after the UI has already gone away.
  let _previewGen = 0;
  let _zoom = 1, _zoomMin = 1, _zoomMax = 5, _hwZoom = false;
  let _pinchDist0 = null, _zoom0 = 1;

  function _setErr(msg) {
    const el = document.getElementById('rec-error');
    el.textContent = msg; el.style.display = msg ? 'block' : 'none';
  }

  function _setRecording(on) {
    const shutter = document.getElementById('rec-shutter');
    shutter.classList.toggle('recording', on);
    document.getElementById('rec-timer-badge').classList.toggle('active', on);
    document.getElementById('rec-flip-btn').style.opacity = on ? '0.4' : '1';
    document.getElementById('rec-flip-btn').style.pointerEvents = on ? 'none' : '';
  }

  async function _applyZoom(z) {
    _zoom = Math.max(_zoomMin, Math.min(_zoomMax, z));
    document.getElementById('rec-zoom-label').textContent = _zoom.toFixed(1).replace(/\.0$/, '') + '×';
    if (_hwZoom && _stream) {
      const track = _stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.();
      if (caps?.zoom) {
        const hw = caps.zoom.min + (_zoom - 1) / (_zoomMax - 1) * (caps.zoom.max - caps.zoom.min);
        try { await track.applyConstraints({ advanced: [{ zoom: hw }] }); return; } catch(e) {}
      }
    }
    // CSS scale fallback — hardware zoom (above) zooms the actual captured
    // frames, so the pose overlay (drawn from landmarks detected on those
    // frames) naturally stays in sync. This software fallback only scales the
    // *display*, leaving detection running on unzoomed frames, so the overlay
    // canvas must get the identical transform or it drifts away from the
    // now-magnified video underneath it.
    const scaleCss = `scale(${_zoom})`;
    document.getElementById('rec-preview').style.transform = scaleCss;
    document.getElementById('rec-canvas').style.transform  = scaleCss;
  }

  function _initZoom() {
    _zoom = 1; _hwZoom = false;
    document.getElementById('rec-preview').style.transform = '';
    document.getElementById('rec-canvas').style.transform  = '';
    document.getElementById('rec-zoom-label').textContent = '1×';
    if (!_stream) return;
    const track = _stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.();
    if (caps?.zoom) { _hwZoom = true; _zoomMax = Math.min(caps.zoom.max, 8); }
    else { _zoomMax = 5; }
  }

  // Pinch-to-zoom touch handlers
  function _onTouchStart(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      _pinchDist0 = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      _zoom0 = _zoom;
    }
  }
  function _onTouchMove(e) {
    if (e.touches.length === 2 && _pinchDist0) {
      e.preventDefault();
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      _applyZoom(_zoom0 * (d / _pinchDist0));
    }
  }
  function _onTouchEnd(e) { if (e.touches.length < 2) _pinchDist0 = null; }

  async function _startPreview() {
    _stopRecAnalysis();
    _stopPreview(); // bumps _previewGen, invalidating any earlier in-flight attempt
    const myGen = _previewGen;
    _setErr('');
    if (!window.isSecureContext) {
      _setErr('Camera requires HTTPS. Open the app via your Firebase Hosting URL (https://…) or use an ngrok tunnel.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      _setErr('Camera not supported in this browser. Try Chrome or Safari.');
      return;
    }
    const attempts = [
      { video: { facingMode: { ideal: _facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true },
      { video: { facingMode: { ideal: _facing } }, audio: true },
      { video: true, audio: true },
      { video: true }
    ];
    let lastErr = null;
    for (const c of attempts) {
      let s = null;
      try {
        s = await navigator.mediaDevices.getUserMedia(c);
        // The modal may have been closed (or a newer _startPreview() call
        // started) while we were awaiting the permission prompt — don't start
        // the camera into a UI that's no longer there.
        if (myGen !== _previewGen) { s.getTracks().forEach(t => t.stop()); return; }
        const v = document.getElementById('rec-preview');
        v.srcObject = s;
        await v.play();
        if (myGen !== _previewGen) { s.getTracks().forEach(t => t.stop()); v.srcObject = null; return; }
        // Only commit to this stream once the preview has actually started
        // successfully — a stream obtained here but abandoned below (play()
        // throwing, or trying a looser constraint set next) must be stopped,
        // not left running while a different attempt takes over.
        _stream = s;
        _initZoom();
        return;
      } catch(e) {
        if (s) s.getTracks().forEach(t => t.stop());
        lastErr = e;
        if (e.name === 'NotAllowedError') break;
      }
    }
    if (myGen !== _previewGen) return; // closed/superseded while failing through attempts
    const msg = lastErr.name === 'NotAllowedError'
      ? 'Camera access denied. Please allow camera permissions in your browser settings.'
      : lastErr.name === 'NotFoundError' ? 'No camera found on this device.'
      : 'Could not access camera (' + (lastErr.name || lastErr.message) + ').';
    _setErr(msg);
  }

  function _stopPreview() {
    _previewGen++; // invalidate any in-flight _startPreview() call
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
    document.getElementById('rec-preview').srcObject = null;
  }

  function _applyOrientationUI() {
    const hint = document.getElementById('rec-rotate-hint');
    if (!hint) return;
    const isPortrait = window.innerHeight > window.innerWidth;
    // Show banner in portrait; hide when user rotates (but not if they dismissed it)
    if (!isPortrait) {
      hint.style.display = 'none';
    } else if (hint.style.display === 'none' && hint.dataset.dismissed === '1') {
      // user manually dismissed — don't re-show
    } else {
      hint.style.display = 'flex';
      hint.dataset.dismissed = '';
    }
    _syncRecLandscapeLayout();
  }

  // Wrapper around _applyOrientationUI(): some mobile browsers (notably iOS Safari)
  // fire 'orientationchange'/the screen.orientation 'change' event BEFORE
  // window.innerWidth/innerHeight and getBoundingClientRect() have caught up to the
  // new orientation. Measuring immediately can bake in stale (pre-rotation)
  // dimensions into _syncRecLandscapeLayout()'s pixel calculation, which is why
  // flipping into landscape could look different from opening already in landscape
  // (where the first measurement is correct from the start). Re-run a couple more
  // times after the event so a late-settling layout still gets picked up.
  function _checkRecOrientation() {
    _applyOrientationUI();
    requestAnimationFrame(() => requestAnimationFrame(_applyOrientationUI));
    setTimeout(_applyOrientationUI, 300);
  }

  // Phone landscape: size the video column in real pixels so video height + the
  // controls strip's height together exactly fill the available window height,
  // and the camera keeps its natural aspect ratio (no stretching/cropping).
  // CSS alone (aspect-ratio on an "auto" grid column paired with a "1fr" row)
  // isn't reliably supported across mobile browsers for this, so it's computed
  // here from measured pixel heights instead.
  function _syncRecLandscapeLayout() {
    const layout = document.getElementById('rec-layout');
    if (!layout) return;
    const isPhoneLandscape = window.matchMedia('(max-height: 500px) and (orientation: landscape)').matches;
    if (!isPhoneLandscape) {
      layout.style.gridTemplateColumns = '';
      return;
    }
    const controlsBar = document.getElementById('rec-controls-bar');
    const totalH = layout.getBoundingClientRect().height;
    const ctrlH  = controlsBar ? controlsBar.getBoundingClientRect().height : 0;
    const videoH = Math.max(0, totalH - ctrlH);
    const videoW = Math.round(videoH * 16 / 9);
    layout.style.gridTemplateColumns = videoW + 'px 1fr';
  }

  // Dismiss button sets a flag so we don't re-show on minor resize events
  window._recHintDismiss = function() {
    const hint = document.getElementById('rec-rotate-hint');
    if (hint) { hint.style.display = 'none'; hint.dataset.dismissed = '1'; }
  };

  window.openRecordModal = function() {
    _primeVoiceSynthesis(); // must happen directly inside this tap handler — see comment above the function
    _secs = 0; _chunks = []; _pendingBlob = null; _pendingExt = null;
    document.getElementById('rec-timer-badge').textContent = '⏺ 0:00';
    _setRecording(false);
    _setErr('');
    app._recFeedbackFrames = 0;
    renderRecFeedback(null);
    const hint = document.getElementById('rec-rotate-hint');
    if (hint) { hint.dataset.dismissed = ''; }  // reset dismiss on open
    // Defensive: 'renaming' should already be gone from closeRecordModal(),
    // but a fresh open should never be able to inherit a leftover take's state.
    document.getElementById('rec-screen').classList.remove('renaming');
    document.getElementById('rec-screen').classList.add('visible');
    _checkRecOrientation();
    // Listen for both — resize is the more reliable "layout actually changed"
    // signal and acts as a backstop even on browsers where screen.orientation
    // fires early (see _checkRecOrientation's comment).
    if (screen.orientation) {
      screen.orientation.addEventListener('change', _checkRecOrientation);
    }
    window.addEventListener('resize', _checkRecOrientation);
    _startPreview().then(() => {
      if (app.modelsReady) _startRecAnalysis();
    });
    // Attach pinch listeners
    const v = document.getElementById('rec-preview');
    v.addEventListener('touchstart', _onTouchStart, { passive: false });
    v.addEventListener('touchmove',  _onTouchMove,  { passive: false });
    v.addEventListener('touchend',   _onTouchEnd);
  };

  window.closeRecordModal = function() {
    if (_mr && _mr.state !== 'inactive') {
      // _mr.onstop (_onStop) runs asynchronously after stop() — if left attached,
      // it would still fire after this function already discarded the pending
      // blob and hidden the UI, resurrecting _pendingBlob and re-adding the
      // 'renaming' class so a *cancelled* recording's rename screen could
      // reappear the next time the modal opens.
      _mr.onstop = null;
      _mr.ondataavailable = null;
      _mr.stop();
    }
    clearInterval(_timerInt);
    _stopRecAnalysis();
    _stopPreview();
    if (window.speechSynthesis) speechSynthesis.cancel();
    _pendingBlob = null;
    document.getElementById('rec-screen').classList.remove('visible', 'renaming');
    _setRecording(false);
    if (screen.orientation) {
      screen.orientation.removeEventListener('change', _checkRecOrientation);
    }
    window.removeEventListener('resize', _checkRecOrientation);
    const hint = document.getElementById('rec-rotate-hint');
    if (hint) { hint.style.display = 'none'; hint.dataset.dismissed = ''; }
    const v = document.getElementById('rec-preview');
    v.removeEventListener('touchstart', _onTouchStart);
    v.removeEventListener('touchmove',  _onTouchMove);
    v.removeEventListener('touchend',   _onTouchEnd);
  };

  window.recFlipCamera = async function() {
    if (_mr && _mr.state !== 'inactive') return;
    _facing = _facing === 'environment' ? 'user' : 'environment';
    await _startPreview();
    if (app.modelsReady) _startRecAnalysis();
  };

  // Single button toggles record/stop
  window.recToggle = function() {
    if (_mr && _mr.state === 'recording') {
      // Stop — capture exact timestamp before stop() so duration is precise
      _recEndMs = performance.now();
      app.recRecording = false;
      _mr.stop();
      clearInterval(_timerInt);
      _setRecording(false);
    } else {
      // Start — reset every property a previous take could have left behind,
      // not just the obvious ones, so a stale value never leaks into this one.
      if (!_stream) return;
      _chunks = []; _secs = 0;
      _pendingBlob = null; _pendingExt = null;
      app._recElapsed = 0;
      _recStartMs = performance.now();
      if (window.speechSynthesis) speechSynthesis.cancel(); // clear any leftover line from a previous take
      _primeVoiceSynthesis(); // second unlock attempt, directly inside this tap handler too
      const mimeType = ['video/webm;codecs=vp9','video/webm','video/mp4']
        .find(t => MediaRecorder.isTypeSupported(t)) || '';
      try { _mr = new MediaRecorder(_stream, mimeType ? { mimeType } : {}); }
      catch(e) { _mr = new MediaRecorder(_stream); }
      _mr.ondataavailable = e => { if (e.data?.size > 0) _chunks.push(e.data); };
      _mr.onstop = _onStop;
      _mr.onerror = (e) => {
        console.warn('[TA] MediaRecorder error:', e.error);
        _setErr('Recording error (' + (e.error?.name || 'unknown') + '). Please try recording again.');
        app.recRecording = false;
        clearInterval(_timerInt);
        _setRecording(false);
      };
      try {
        _mr.start(200);
      } catch(e) {
        _setErr('Could not start recording (' + (e.name || e.message) + ').');
        return;
      }
      app.recRecording = true;
      // Reset stroke state for fresh recording session
      resetStrokeDetector();
      stroke.markers = [];
      _setRecording(true);
      document.getElementById('rec-timer-badge').textContent = '⏺ 0:00';
      _timerInt = setInterval(() => {
        _secs++;
        document.getElementById('rec-timer-badge').textContent = '⏺ ' + fmtTime(_secs);
      }, 1000);
    }
  };

  let _pendingBlob = null, _pendingExt = null;
  let _recRafId = null, _recDetecting = false;

  function _startRecAnalysis() {
    app.recMode = true;
    _recDetecting = false;
    const recVideo  = document.getElementById('rec-preview');
    const recCanvas = document.getElementById('rec-canvas');

    function _recLoop() {
      if (!app.recMode) return;

      // Update elapsed recording time
      if (app.recRecording) {
        app._recElapsed = (performance.now() - _recStartMs) / 1000;
      }

      // Fit canvas to video frame dimensions
      if (recVideo.videoWidth && recCanvas.width !== recVideo.videoWidth) {
        recCanvas.width  = recVideo.videoWidth;
        recCanvas.height = recVideo.videoHeight;
      }

      // Send frame to pose model
      if (app.poseModel && !_recDetecting && !app.scanSending && recVideo.readyState >= 2) {
        _recDetecting = true;
        app.poseModel.send({ image: recVideo })
          .catch(() => {})
          .finally(() => { _recDetecting = false; });
      }

      _recRafId = requestAnimationFrame(_recLoop);
    }
    _recLoop();
  }

  function _stopRecAnalysis() {
    app.recMode      = false;
    app.recRecording = false;
    if (_recRafId) { cancelAnimationFrame(_recRafId); _recRafId = null; }
    _recDetecting = false;
    const rc = document.getElementById('rec-canvas');
    if (rc) rc.getContext('2d').clearRect(0, 0, rc.width, rc.height);
  }

  // Patch the EBML Duration element in a WebM blob so the browser reports a
  // finite duration instead of Infinity. MediaRecorder WebM typically omits
  // duration or writes 0.
  //
  // IMPORTANT: we only search the EBML header section (before the first
  // Cluster element, ID 0x1F43B675). The Duration element is always inside
  // the Info block which precedes Cluster. Scanning the whole file risks a
  // false-positive match inside VP8/VP9 bitstream data, which would corrupt
  // a video block (manifests as random pixels and a frozen/truncated video).
  async function _fixWebmDuration(blob, secs) {
    if (!blob.type.includes('webm') || !(secs > 0)) return blob;
    try {
      const buf  = await blob.arrayBuffer();
      const arr  = new Uint8Array(buf);
      const view = new DataView(buf);
      const ms   = secs * 1000;

      // Locate the first Cluster element to bound our search
      let limit = Math.min(arr.length - 12, 65536); // max 64 KB header scan
      for (let i = 4; i < Math.min(arr.length - 4, 65536); i++) {
        if (arr[i]===0x1F && arr[i+1]===0x43 && arr[i+2]===0xB6 && arr[i+3]===0x75) {
          limit = i; break;
        }
      }

      // Search for Duration (ID 0x44 0x89) only within the header section
      for (let i = 4; i < limit; i++) {
        if (arr[i] === 0x44 && arr[i + 1] === 0x89) {
          if (arr[i + 2] === 0x88) { view.setFloat64(i + 3, ms, false); break; } // float64
          if (arr[i + 2] === 0x84) { view.setFloat32(i + 3, ms, false); break; } // float32
        }
      }
      return new Blob([arr], { type: blob.type });
    } catch (e) { return blob; }
  }

  async function _onStop() {
    if (!_chunks.length) return;
    const mime = _mr?.mimeType || 'video/webm';
    _pendingExt = mime.includes('mp4') ? 'mp4' : 'webm';
    let blob = new Blob(_chunks, { type: mime });
    // Fix WebM duration so the video is seekable and MediaPipe can scan it.
    // Use the precise stop timestamp (not _secs, which is an integer counter).
    const exactSecs = _recEndMs > _recStartMs ? (_recEndMs - _recStartMs) / 1000 : _secs;
    if (_pendingExt === 'webm') blob = await _fixWebmDuration(blob, exactSecs);
    _pendingBlob = blob;

    // Stop camera and live pose-detection analysis — recording is done, and
    // the renaming screen covers the preview anyway, so there's nothing left
    // for either to usefully do. Previously only the camera stopped; the
    // analysis rAF loop (and its app.recMode-gated state) kept running
    // indefinitely behind the rename overlay until the modal was closed.
    _stopPreview();
    _stopRecAnalysis();

    // Pre-fill rename input with a timestamped default
    const now = new Date();
    const ts  = now.getFullYear() + '-'
      + String(now.getMonth()+1).padStart(2,'0') + '-'
      + String(now.getDate()).padStart(2,'0');
    const inp = document.getElementById('rec-rename-input');
    inp.value = 'Recording ' + ts;

    document.getElementById('rec-screen').classList.add('renaming');
    setTimeout(() => inp.select(), 50); // auto-select text for easy rename
  }

  window.recConfirmUpload = function() {
    if (!_pendingBlob) return;
    const inp  = document.getElementById('rec-rename-input');
    const name = (inp.value.trim() || 'Recording') + '.' + _pendingExt;
    const file = new File([_pendingBlob], name, { type: _pendingBlob.type });
    _pendingBlob = null;
    closeRecordModal();
    // Show the analyzer section immediately with an "Uploading" overlay so the
    // user gets feedback while the file transfers to Firebase Storage.
    showSection('analyzer');
    showLoading(true, 'Uploading…');
    uploadClips([file], { autoSelect: true, fromRecording: true });
  };
})();
