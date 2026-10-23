'use strict';

// ════════════════════════════════════════════════════════════
//  FIREBASE SETUP GUIDE
// ════════════════════════════════════════════════════════════
const SETUP_RULES = {
  'firestore-rules': [
    "rules_version = '2';",
    "service cloud.firestore {",
    "  match /databases/{database}/documents {",
    "    match /users/{userId}/{document=**} {",
    "      allow read, write: if request.auth != null && request.auth.uid == userId;",
    "    }",
    "  }",
    "}"
  ].join('\n'),

  'storage-rules': [
    "rules_version = '2';",
    "service firebase.storage {",
    "  match /b/{bucket}/o {",
    "    match /users/{userId}/{allPaths=**} {",
    "      allow read, write: if request.auth != null && request.auth.uid == userId;",
    "    }",
    "  }",
    "}"
  ].join('\n'),

  'cors-create': `echo '[{"origin":["*"],"method":["GET"],"maxAgeSeconds":3600}]' > cors.json`,
  'cors-apply':  `gsutil cors set cors.json gs://YOUR_BUCKET_NAME`
};

function copyCode(id, btn) {
  const text = SETUP_RULES[id] || document.getElementById(id).textContent.trim();

  const done = () => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  };
  const fail = () => {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done, fail));
  } else {
    legacyCopy(text, done, fail);
  }
}

function legacyCopy(text, done, fail) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy') ? done() : fail(); }
  catch (e) { fail(); }
  document.body.removeChild(ta);
}

// ════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
// ════════════════════════════════════════════════════════════
const FIREBASE_CONFIG= {
    apiKey: "AIzaSyBEJHt7yyTUVUWFDdvxy96hPMBmLbSUxCk",
    authDomain: "tennis-stroke-analyzer.firebaseapp.com",
    databaseURL: "https://tennis-stroke-analyzer-default-rtdb.firebaseio.com",
    projectId: "tennis-stroke-analyzer",
    storageBucket: "tennis-stroke-analyzer.firebasestorage.app",
    messagingSenderId: "1014468885924",
    appId: "1:1014468885924:web:58c84a54d6e0bb9ad75531",
    measurementId: "G-9RCYSCP2VZ"
  };
const CONFIG_READY = FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";

// ════════════════════════════════════════════════════════════
//  FIREBASE INIT
// ════════════════════════════════════════════════════════════
let fbAuth, fbDb, fbStorage, unsubVideos = null;

function initFirebase() {
  firebase.initializeApp(FIREBASE_CONFIG);
  fbAuth    = firebase.auth();
  fbDb      = firebase.firestore();
  fbStorage = firebase.storage();

  fbAuth.onAuthStateChanged(user => {
    if (user) {
      document.getElementById('user-email-label').textContent = user.email;
      showMain();
      subscribeVideos(user.uid);
      loadUserSettings(user.uid);
      // Loading the AI models is heavy — deferred until after login so 
      // it doesn't compete with the auth form for the main thread while
      // someone's still typing their credentials.
      if (!app.modelsReady && !app._modelsLoading) {
        app._modelsLoading = true;
        loadModels();
      }
    } else {
      if (unsubVideos) { unsubVideos(); unsubVideos = null; }
      app.clips = []; app.uploads = []; app.clipsLoaded = false;
      showAuth();
    }
  });
}
