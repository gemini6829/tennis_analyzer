# AI-Powered Tennis Stroke Analyzer

This web application analyzes tennis videos using computer vision and provides automated feedback on stroke mechanics. The project was originally designed to give junior players from a community tennis program an opportunity to receive feedback on their technique outside of weekly lessons.

[Tennis Stroke Analyzer Demo](https://youtu.be/zILttDkncro)

## How It Works

The analyzer processes uploaded or recorded tennis videos:

- **MediaPipe Pose** detects body landmarks such as shoulders, elbows, wrists, hips, knees, and ankles.
- Wrist movement is used to identify the beginning and end of tennis strokes.
- Wrist trajectory and body position are used to classify stroke type, including serves, slices, and groundstrokes, with volley classification during live playback.
- Joint angles and posture measurements are calculated throughout the stroke.
- The application generates a stroke score and coaching feedback based on the measured technique.
- A custom motion-based ball detector estimates ball position using frame differences, motion filtering, and pixel clustering.

Uploaded videos are also analyzed through a background scan so detected strokes can be marked along the playback timeline before the user watches the entire video.

## Main Features

- Upload or record tennis videos
- MediaPipe body landmark overlay
- Automatic stroke detection
- Stroke classification
- Joint-angle and posture measurements
- Automated stroke scoring and coaching feedback
- Tennis ball motion detection
- Background video scanning
- Clickable stroke markers on the video timeline
- Optional auto-pause after detected strokes
- Desktop and mobile layouts
- Firebase authentication and cloud video storage

### JavaScript Files

- **`app.js`** — Main application logic, video playback, ball detection, model loading, and video library controls
- **`state.js`** — Shared application state and MediaPipe landmark definitions
- **`strokeDetection.js`** — Stroke detection and stroke classification
- **`scan.js`** — Background video scanning and saved scan results
- **`feedback.js`** — Technique measurements, scoring, and coaching feedback
- **`record.js`** — Camera recording and live recording analysis
- **`firebase.js`** — Firebase configuration, authentication, and initialization

## Algorithm Diagrams

The `assets/` folder contains diagrams illustrating several of the project's main algorithms:

- Ball detection
- Stroke detection
- Stroke classification

## Documentation

For more detail about the development process and algorithms:

- [Summer Development Log](docs/Summer%20Development%20Log.pdf) — experiments, debugging, feature development, and approaches
- [Technical Specifications](docs/Technical%20Specifications.pdf) — current implementation and major algorithms

## Possible Future Extensions

- Incorporate ball detection to identify stroke phases such as preparation, contact, and follow-through for more precise feedback
- Develop stroke-specific scoring and feedback
- Test the analyzer across a more diverse set of players and videos

## Tools

- JavaScript, HTML, CSS
- MediaPipe Pose
- TensorFlow\.js / COCO-SSD
- Firebase Authentication
- Firebase Firestore
- Firebase Storage

## Contributions

Project concept, application design, algorithms, testing, and feature development by Lily Wang. Claude Code was used as an AI programming assistant during implementation and debugging.
