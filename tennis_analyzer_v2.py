#!/usr/bin/env python3
"""
🎾 Tennis Stroke Analyzer v2 — Phase-Aware Edition
Requirements: pip install mediapipe opencv-python numpy matplotlib
Usage: python tennis_analyzer_v2.py practice.mp4 --hand right
"""
import cv2, json, os, urllib.request
import mediapipe as mp
import numpy as np
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum
from datetime import datetime
from collections import Counter

# ==================== DATA CLASSES ====================
@dataclass
class FramePose:
    frame_number: int
    timestamp_ms: float
    landmarks: dict
    raw_landmarks: Optional[object] = None

class StrokeType(Enum):
    FOREHAND = "forehand"
    BACKHAND = "backhand"
    SERVE = "serve"
    OVERHEAD = "overhead"
    UNKNOWN = "unknown"

class StrokePhase(Enum):
    PREPARATION = "preparation"
    ACCELERATION = "acceleration"
    CONTACT = "contact"
    FOLLOW_THROUGH = "follow_through"

@dataclass
class DetectedStroke:
    stroke_type: StrokeType
    phase: StrokePhase
    start_frame: int
    end_frame: int
    contact_frame: int
    confidence: float
    dominant_side: str
    keypoint_sequence: list
    velocity_segment: Optional[object] = None

@dataclass
class FormIssue:
    category: str
    severity: str
    description: str
    suggestion: str
    ideal_range: str
    measured_value: float

@dataclass
class StrokeAnalysis:
    stroke_type: str
    overall_score: float
    form_issues: list
    strengths: list
    summary: str

# ==================== MODULE 1: POSE ESTIMATOR ====================
class PoseEstimator:
    TENNIS_LANDMARKS = {
        'LEFT_SHOULDER': 11, 'RIGHT_SHOULDER': 12,
        'LEFT_ELBOW': 13, 'RIGHT_ELBOW': 14,
        'LEFT_WRIST': 15, 'RIGHT_WRIST': 16,
        'LEFT_HIP': 23, 'RIGHT_HIP': 24,
        'LEFT_KNEE': 25, 'RIGHT_KNEE': 26,
        'LEFT_ANKLE': 27, 'RIGHT_ANKLE': 28,
        'NOSE': 0,
    }
    MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task"

    def __init__(self, min_detection_confidence=0.5, min_tracking_confidence=0.5):
        self._use_legacy = hasattr(mp, 'solutions') and hasattr(getattr(mp, 'solutions', None), 'pose')
        if self._use_legacy:
            self._init_legacy(min_detection_confidence, min_tracking_confidence)
        else:
            self._init_tasks(min_detection_confidence, min_tracking_confidence)

    def _init_legacy(self, det_conf, track_conf):
        self.mp_pose = mp.solutions.pose
        self.pose = self.mp_pose.Pose(static_image_mode=False, model_complexity=2,
            enable_segmentation=False, min_detection_confidence=det_conf,
            min_tracking_confidence=track_conf)
        self.mp_drawing = mp.solutions.drawing_utils

    def _init_tasks(self, det_conf, track_conf):
        model_path = self._ensure_model()
        BaseOptions = mp.tasks.BaseOptions
        Opts = mp.tasks.vision.PoseLandmarkerOptions
        self._running_mode = mp.tasks.vision.RunningMode
        self._landmarker_cls = mp.tasks.vision.PoseLandmarker
        self._video_options = Opts(base_options=BaseOptions(model_asset_path=model_path),
            running_mode=self._running_mode.VIDEO,
            min_pose_detection_confidence=det_conf, min_tracking_confidence=track_conf)
        self._image_options = Opts(base_options=BaseOptions(model_asset_path=model_path),
            running_mode=self._running_mode.IMAGE, min_pose_detection_confidence=det_conf)

    def _ensure_model(self):
        d = os.path.join(os.path.expanduser("~"), ".tennis_analyzer")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "pose_landmarker_heavy.task")
        if not os.path.exists(p):
            print("📥 Downloading pose model (~26MB)...")
            urllib.request.urlretrieve(self.MODEL_URL, p)
            print("   ✅ Saved to", p)
        return p

    def _extract_landmarks(self, pl):
        if not pl: return None
        lm = pl[0]; d = {}
        for name, idx in self.TENNIS_LANDMARKS.items():
            l = lm[idx]; d[name] = (l.x, l.y, l.z, l.visibility)
        return d

    def process_video(self, video_path):
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS); poses = []; fn = 0
        if self._use_legacy:
            while cap.isOpened():
                ret, frame = cap.read()
                if not ret: break
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                r = self.pose.process(rgb)
                if r.pose_landmarks:
                    lm = {}
                    for name, idx in self.TENNIS_LANDMARKS.items():
                        l = r.pose_landmarks.landmark[idx]
                        lm[name] = (l.x, l.y, l.z, l.visibility)
                    poses.append(FramePose(fn, (fn/fps)*1000, lm, r.pose_landmarks))
                fn += 1
        else:
            with self._landmarker_cls.create_from_options(self._video_options) as lmk:
                while cap.isOpened():
                    ret, frame = cap.read()
                    if not ret: break
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    ts = int((fn / fps) * 1000)
                    r = lmk.detect_for_video(img, ts)
                    d = self._extract_landmarks(r.pose_landmarks)
                    if d: poses.append(FramePose(fn, ts, d, None))
                    fn += 1
        cap.release(); return poses

    def process_frame(self, frame, frame_number=0, timestamp_ms=0):
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        if self._use_legacy:
            r = self.pose.process(rgb)
            if r.pose_landmarks:
                lm = {}
                for name, idx in self.TENNIS_LANDMARKS.items():
                    l = r.pose_landmarks.landmark[idx]
                    lm[name] = (l.x, l.y, l.z, l.visibility)
                return FramePose(frame_number, timestamp_ms, lm, r.pose_landmarks)
        else:
            with self._landmarker_cls.create_from_options(self._image_options) as lmk:
                img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                r = lmk.detect(img)
                d = self._extract_landmarks(r.pose_landmarks)
                if d: return FramePose(frame_number, timestamp_ms, d, None)
        return None

    def draw_pose(self, frame, fp):
        a = frame.copy()
        if self._use_legacy and fp.raw_landmarks:
            self.mp_drawing.draw_landmarks(a, fp.raw_landmarks, self.mp_pose.POSE_CONNECTIONS)
        else:
            h, w = a.shape[:2]
            for name, (x, y, z, vis) in fp.landmarks.items():
                if vis > 0.5: cv2.circle(a, (int(x*w), int(y*h)), 5, (0,255,0), -1)
        return a

    def close(self):
        if self._use_legacy: self.pose.close()


# ==================== MODULE 2: ROBUST STROKE DETECTOR ====================
# Fixes: smoothing, adaptive threshold, min peak, cooldown, window merging
class StrokeDetector:
    def __init__(self, fps=30.0, dominant_hand="right"):
        self.fps = fps
        self.dominant_hand = dominant_hand
        self.wrist_key = f"{dominant_hand.upper()}_WRIST"
        self.elbow_key = f"{dominant_hand.upper()}_ELBOW"
        self.shoulder_key = f"{dominant_hand.upper()}_SHOULDER"
        self.smooth_window = max(3, int(fps * 0.15))
        self.threshold_multiplier = 2.5    # Higher = fewer detections
        self.min_peak_percentile = 85      # Only top 15% velocity peaks
        self.cooldown_seconds = 1.0        # Min gap between strokes
        self.merge_gap_seconds = 0.5       # Merge windows within this gap
        self.min_stroke_seconds = 0.2
        self.max_stroke_seconds = 3.0

    def detect_strokes(self, poses):
        min_f = max(4, int(self.min_stroke_seconds * self.fps))
        if len(poses) < min_f: return []
        raw_v = self._wrist_velocity(poses)
        v = self._smooth(raw_v, self.smooth_window)
        thr = self._adaptive_threshold(v)
        wins = self._find_windows(v, thr)
        wins = self._merge(wins, int(self.merge_gap_seconds * self.fps))
        min_peak = np.percentile(v[v > 0], self.min_peak_percentile) if np.any(v > 0) else 0.05
        wins = [(s,e) for s,e in wins if np.max(v[s:e+1]) >= min_peak]
        max_f = int(self.max_stroke_seconds * self.fps)
        wins = [(s,e) for s,e in wins if min_f <= (e-s) <= max_f]
        wins = self._cooldown(wins, int(self.cooldown_seconds * self.fps))
        strokes = []
        for s, e in wins:
            sp = poses[s:e+1]; vs = v[s:e+1]
            ci = int(np.argmax(vs)); cf = s + ci
            strokes.append(DetectedStroke(self._classify(sp, ci), StrokePhase.CONTACT,
                poses[s].frame_number, poses[e].frame_number, poses[cf].frame_number,
                self._confidence(sp, vs, v), self.dominant_hand, sp, velocity_segment=vs))
        return strokes

    def _smooth(self, sig, w):
        if w < 3: return sig
        x = np.arange(-w//2, w//2+1)
        k = np.exp(-x**2/(2*(w/4)**2)); k /= k.sum()
        return np.convolve(np.pad(sig, w//2, mode='edge'), k, mode='valid')[:len(sig)]

    def _adaptive_threshold(self, v):
        nz = v[v > 0]
        if len(nz) == 0: return 0.05
        return max(np.median(nz) + self.threshold_multiplier * np.std(nz), 0.02)

    def _find_windows(self, v, thr):
        in_s, wins, s = False, [], 0
        for i, vel in enumerate(v):
            if vel > thr and not in_s: in_s, s = True, max(0, i-3)
            elif vel < thr*0.4 and in_s:
                in_s = False; wins.append((s, min(len(v)-1, i+3)))
        if in_s: wins.append((s, len(v)-1))
        return wins

    def _merge(self, wins, gap):
        if len(wins) <= 1: return wins
        m = [wins[0]]
        for s, e in wins[1:]:
            if s - m[-1][1] <= gap: m[-1] = (m[-1][0], e)
            else: m.append((s, e))
        return m

    def _cooldown(self, wins, cd):
        if not wins: return []
        f = [wins[0]]
        for s, e in wins[1:]:
            if s - f[-1][1] >= cd: f.append((s, e))
        return f

    def _wrist_velocity(self, poses):
        pos = []
        for p in poses:
            w = p.landmarks.get(self.wrist_key)
            pos.append(np.array([w[0],w[1]]) if w else (pos[-1] if pos else np.array([0,0])))
        pos = np.array(pos); v = np.zeros(len(pos))
        for i in range(1, len(pos)): v[i] = np.linalg.norm(pos[i]-pos[i-1])
        return v

    def _classify(self, poses, ci):
        cp = poses[min(ci, len(poses)-1)]; lm = cp.landmarks
        wrist = np.array(lm.get(self.wrist_key,(0,0,0,0))[:2])
        nose = np.array(lm.get('NOSE',(0,0,0,0))[:2])
        shoulder = np.array(lm.get(self.shoulder_key,(0,0,0,0))[:2])
        if wrist[1] < nose[1]-0.05:
            return StrokeType.SERVE if wrist[1] < shoulder[1]-0.15 else StrokeType.OVERHEAD
        cx = (lm.get('LEFT_SHOULDER',(0,))[0]+lm.get('RIGHT_SHOULDER',(0,))[0])/2
        if self.dominant_hand == "right":
            return StrokeType.FOREHAND if wrist[0] > cx else StrokeType.BACKHAND
        return StrokeType.FOREHAND if wrist[0] < cx else StrokeType.BACKHAND

    def _confidence(self, poses, vs, all_v):
        vis = [p.landmarks.get(k,(0,0,0,0))[3] for p in poses
               for k in [self.wrist_key,self.elbow_key,self.shoulder_key] if p.landmarks.get(k)]
        av = np.mean(vis) if vis else 0
        peak = np.max(vs) if len(vs) > 0 else 0
        gm = np.mean(all_v[all_v>0]) if np.any(all_v>0) else 1
        prom = min(peak/(gm+1e-8), 5.0)/5.0
        shape = (1.0-abs(np.argmax(vs)/len(vs)-0.45)*2) if len(vs) > 2 else 0.3
        return round(min(av*0.3+prom*0.4+shape*0.3, 1.0), 2)

# ==================== MODULE 3: PHASE SEGMENTER ====================
class StrokePhaseSegmenter:
    def __init__(self, contact_window_ms=50.0, fps=30.0):
        self.contact_window_frames = max(1, int(contact_window_ms/1000*fps))
        self.fps = fps

    def segment(self, poses, velocities):
        n = len(poses)
        if n < 4: return self._fallback(poses)
        peak_idx = int(np.argmax(velocities))
        peak_vel = velocities[peak_idx] if velocities[peak_idx] > 0 else 1e-8
        cs = max(0, peak_idx - self.contact_window_frames)
        ce = min(n-1, peak_idx + self.contact_window_frames)
        accel_s = 0
        for i in range(cs-1, -1, -1):
            if velocities[i] < peak_vel*0.2: accel_s = i+1; break
        phases = {'preparation':[], 'acceleration':[], 'contact':[], 'follow_through':[]}
        for i, pose in enumerate(poses):
            if i < accel_s: phases['preparation'].append((i, pose))
            elif i < cs: phases['acceleration'].append((i, pose))
            elif i <= ce: phases['contact'].append((i, pose))
            else: phases['follow_through'].append((i, pose))
        if not phases['preparation'] and phases['acceleration']:
            sp = max(1, len(phases['acceleration'])//3)
            phases['preparation'] = phases['acceleration'][:sp]
            phases['acceleration'] = phases['acceleration'][sp:]
        return phases

    def _fallback(self, poses):
        n = len(poses); q = max(1, n//4)
        return {'preparation':[(i,poses[i]) for i in range(0,q)],
                'acceleration':[(i,poses[i]) for i in range(q,2*q)],
                'contact':[(i,poses[i]) for i in range(2*q,3*q)],
                'follow_through':[(i,poses[i]) for i in range(3*q,n)]}

    def get_representative_frame(self, pf, position='middle'):
        if not pf: return None
        if position=='start': return pf[0][1]
        elif position=='end': return pf[-1][1]
        return pf[len(pf)//2][1]


# ==================== MODULE 4: PHASE-AWARE FORM ANALYZER ====================
class PhaseAwareFormAnalyzer:
    PHASE_CHECKS = {
        "forehand": {
            "preparation": [("knee_bend",(120,155),"Bend knees more — sit into an athletic stance.")],
            "acceleration": [("hip_rotation",(30,60),"Drive with your hips first for power.")],
            "contact": [("elbow_angle",(150,175),"Extend arm at contact — reach to meet the ball."),
                        ("wrist_height",(0.35,0.65),"Contact at waist-to-chest height.")],
            "follow_through": [("follow_through_height",(0.1,0.45),"Finish high near opposite shoulder.")],
        },
        "backhand": {
            "preparation": [("knee_bend",(120,155),"Bend knees — lower center of gravity."),
                            ("shoulder_turn",(60,100),"Turn shoulders — show back to net.")],
            "contact": [("elbow_angle",(155,180),"Extend more — push through the ball."),
                        ("wrist_height",(0.35,0.65),"Keep contact between waist and chest.")],
            "follow_through": [("follow_through_height",(0.1,0.5),"Follow through across body, finish high.")],
        },
        "serve": {
            "preparation": [("knee_bend",(100,140),"Bend knees deeply — load legs like a spring.")],
            "acceleration": [("elbow_angle_trophy",(80,120),"Bend elbow ~90° in trophy position.")],
            "contact": [("arm_extension",(160,180),"Full extension — hit at highest point."),
                        ("contact_height",(0.0,0.2),"Contact as high as possible above head.")],
            "follow_through": [],
        },
    }
    TIPS = {
        "knee_bend":{"low":"Over-bending — find balanced stance.","high":"Bend knees more! Sit in a chair for power."},
        "elbow_angle":{"low":"Extend arm more at contact.","high":"Keep slight bend for control."},
        "arm_extension":{"low":"Reach higher! Full extension at contact.","high":"Good extension."},
        "wrist_height":{"low":"Hitting too low — let ball rise.","high":"Hitting too high — hit earlier."},
        "contact_height":{"low":"Toss higher, reach up on serve.","high":"Good height."},
        "shoulder_turn":{"low":"Turn shoulders more — show back to net.","high":"Over-rotating — keep controlled."},
        "hip_rotation":{"low":"Drive with hips before shoulders!","high":"Good hip rotation."},
        "follow_through_height":{"low":"Finish higher near opposite shoulder.","high":"Finishing too high — uppercut swing."},
        "elbow_angle_trophy":{"low":"Elbow too bent in trophy position.","high":"Bend elbow more in trophy (~90°)."},
    }

    def __init__(self):
        self.segmenter = StrokePhaseSegmenter()

    def analyze_stroke(self, stroke, velocities_segment=None):
        sn = stroke.stroke_type.value; poses = stroke.keypoint_sequence; side = stroke.dominant_side
        if velocities_segment is None or len(velocities_segment)==0:
            velocities_segment = np.zeros(len(poses))
        phases = self.segmenter.segment(poses, velocities_segment)
        if sn not in self.PHASE_CHECKS:
            return StrokeAnalysis(sn, 50, [], ["Stroke detected"], f"{sn} — limited analysis.")
        issues, strengths, scores = [], [], []
        for pname, pchecks in self.PHASE_CHECKS[sn].items():
            pframes = phases.get(pname, [])
            if not pframes: continue
            for metric, rng, dtip in pchecks:
                if rng is None: continue
                rep = self.segmenter.get_representative_frame(pframes,
                    'middle' if pname in ('preparation','follow_through') else 'end')
                if not rep: continue
                val = self._measure(metric, rep, side, phases)
                if val is None: continue
                lo, hi = rng
                if lo <= val <= hi:
                    strengths.append(f"Good {metric.replace('_',' ')} during {pname} ({val:.0f})")
                    scores.append(1.0)
                else:
                    d = "low" if val < lo else "high"
                    sev = "moderate" if abs(val-(lo if d=="low" else hi)) > 15 else "minor"
                    tip = self.TIPS.get(metric,{}).get(d, dtip)
                    issues.append(FormIssue(f"{metric} ({pname})", sev,
                        f"{metric.replace('_',' ').title()} during {pname}: {val:.1f} "
                        f"({'below' if d=='low' else 'above'} ideal {lo}-{hi})",
                        tip, f"{lo}-{hi}", round(val,1)))
                    span=(hi-lo)/2; dist=min(abs(val-lo),abs(val-hi))
                    scores.append(max(0, 1.0-dist/(span+1e-8)*0.5))
        ti = self._check_tempo(phases, sn)
        if ti: issues.append(ti)
        overall = np.mean(scores)*100 if scores else 50
        return StrokeAnalysis(sn, round(overall,1), issues, strengths,
                              self._summary(sn, overall, issues, strengths, phases))

    def _measure(self, m, pose, side, phases):
        s = side.upper(); lm = pose.landmarks
        def ang(a,b,c):
            ba,bc=a-b,c-b; cv=np.dot(ba,bc)/(np.linalg.norm(ba)*np.linalg.norm(bc)+1e-8)
            return float(np.degrees(np.arccos(np.clip(cv,-1,1))))
        def pt(n): return np.array(lm.get(n,(0,0,0,0))[:2])
        if m=="knee_bend": return ang(pt(f"{s}_HIP"),pt(f"{s}_KNEE"),pt(f"{s}_ANKLE"))
        if m in ("elbow_angle","arm_extension","elbow_angle_trophy"):
            return ang(pt(f"{s}_SHOULDER"),pt(f"{s}_ELBOW"),pt(f"{s}_WRIST"))
        if m in ("wrist_height","follow_through_height","contact_height"):
            return lm.get(f"{s}_WRIST",(0,0.5,0,0))[1]
        if m in ("shoulder_turn","hip_rotation"):
            pf = phases.get('preparation',[])
            if not pf: return None
            pp = pf[0][1]
            if m=="shoulder_turn":
                def vec(p): return np.array(p.landmarks.get("RIGHT_SHOULDER",(0,0,0,0))[:2])-np.array(p.landmarks.get("LEFT_SHOULDER",(0,0,0,0))[:2])
            else:
                def vec(p): return np.array(p.landmarks.get("RIGHT_HIP",(0,0,0,0))[:2])-np.array(p.landmarks.get("LEFT_HIP",(0,0,0,0))[:2])
            v1,v2=vec(pp),vec(pose)
            cv=np.dot(v1,v2)/(np.linalg.norm(v1)*np.linalg.norm(v2)+1e-8)
            return float(np.degrees(np.arccos(np.clip(cv,-1,1))))
        return None

    def _check_tempo(self, phases, sn):
        total = sum(len(v) for v in phases.values())
        if total < 5: return None
        pr = len(phases.get('preparation',[]))/total
        if pr < 0.15:
            return FormIssue("tempo","moderate",f"Rushed preparation ({pr:.0%}). Take more time.",
                "Don't rush backswing! Early preparation = better timing.","25-40%",round(pr*100,1))
        fl = len(phases.get('follow_through',[]))
        if fl < 2 and sn not in ("volley","overhead"):
            return FormIssue("tempo","moderate","Incomplete follow-through.",
                "Let swing flow after contact for consistency and injury prevention.",
                "≥20%",round((fl/total)*100,1))
        return None

    def _summary(self, sn, score, issues, strengths, phases):
        pl = {k:len(v) for k,v in phases.items()}; t = sum(pl.values())
        lines = [f"\n{'='*55}", f"  {sn.upper()} — Score: {score:.0f}/100  (Phase-Aware)", "="*55]
        lines.append(f"\n📊 Phases ({t} frames):")
        for p, c in pl.items():
            pct = c/t*100 if t > 0 else 0
            lines.append(f"   {p:18s} {'█'*int(pct/5)}{'░'*(20-int(pct/5))} {c:3d}f ({pct:.0f}%)")
        if strengths: lines += ["\n✅ Strengths:"] + [f"   • {s}" for s in strengths]
        if issues:
            lines += ["\n⚠️  Improve:"]
            for i in issues:
                lines += [f"   {'🔴' if i.severity=='major' else '🟡'} {i.description}",
                          f"      💡 {i.suggestion}"]
        if score >= 80: lines.append("\n🎾 Great form! Focus on consistency.")
        elif score >= 60: lines.append("\n🎾 Good foundation! Work on tips above.")
        else: lines.append("\n🎾 Keep practicing! One phase at a time.")
        return "\n".join(lines)

# ==================== MODULE 5: DTW TEMPLATE MATCHER ====================
class StrokeTemplateMatcher:
    def __init__(self): self.templates = {}
    def add_template(self, name, feat, phases=None):
        self.templates.setdefault(name,[]).append({'features':feat,'phases':phases})
    def extract_features(self, poses, side):
        s = side.upper(); feats = []
        for p in poses:
            lm = p.landmarks
            def pt(n): return np.array(lm.get(n,(0,0,0,0))[:2])
            def ang(a,b,c):
                ba,bc=a-b,c-b; cv=np.dot(ba,bc)/(np.linalg.norm(ba)*np.linalg.norm(bc)+1e-8)
                return float(np.degrees(np.arccos(np.clip(cv,-1,1))))
            def la(p1,p2): d=p2-p1; return float(np.degrees(np.arctan2(d[1],d[0])))
            bcx = (lm.get("LEFT_SHOULDER",(0,))[0]+lm.get("RIGHT_SHOULDER",(0,))[0])/2
            feats.append([ang(pt(f"{s}_SHOULDER"),pt(f"{s}_ELBOW"),pt(f"{s}_WRIST")),
                ang(pt(f"{s}_HIP"),pt(f"{s}_KNEE"),pt(f"{s}_ANKLE")),
                lm.get(f"{s}_WRIST",(0,0.5,0,0))[1],
                lm.get(f"{s}_WRIST",(0,0,0,0))[0]-bcx,
                la(pt("LEFT_SHOULDER"),pt("RIGHT_SHOULDER")),
                la(pt("LEFT_HIP"),pt("RIGHT_HIP"))])
        return np.array(feats)
    def dtw_distance(self, s1, s2):
        n,m=len(s1),len(s2)
        s1n=(s1-s1.mean(0))/(s1.std(0)+1e-8); s2n=(s2-s2.mean(0))/(s2.std(0)+1e-8)
        c=np.full((n+1,m+1),np.inf); c[0,0]=0
        for i in range(1,n+1):
            for j in range(1,m+1):
                c[i,j]=np.linalg.norm(s1n[i-1]-s2n[j-1])+min(c[i-1,j],c[i,j-1],c[i-1,j-1])
        return c[n,m]/(n+m)
    def classify(self, poses, side):
        feat = self.extract_features(poses, side)
        best = (None, float('inf'))
        for name, ts in self.templates.items():
            for t in ts:
                d = self.dtw_distance(feat, t['features'])
                if d < best[1]: best = (name, d)
        return best
    def build_template_from_video(self, poses, side, name, phases=None):
        self.add_template(name, self.extract_features(poses, side), phases)
        print(f"✅ Template '{name}' registered ({len(poses)} frames)")

# ==================== MODULE 6: MAIN APPLICATION ====================
class TennisStrokeAnalyzer:
    def __init__(self, dominant_hand="right", fps=30.0):
        self.pose_estimator = PoseEstimator()
        self.stroke_detector = StrokeDetector(fps=fps, dominant_hand=dominant_hand)
        self.form_analyzer = PhaseAwareFormAnalyzer()
        self.template_matcher = StrokeTemplateMatcher()
        self.fps = fps

    def analyze_video(self, video_path):
        print(f"🎾 Analyzing: {video_path} (hand: {self.stroke_detector.dominant_hand})")
        print("\n📐 Step 1/3: Extracting poses...")
        poses = self.pose_estimator.process_video(video_path)
        print(f"   ✅ {len(poses)} frames")
        if not poses: return {"poses":[],"strokes":[],"analyses":[]}
        print("\n🏓 Step 2/3: Detecting strokes (robust)...")
        strokes = self.stroke_detector.detect_strokes(poses)
        print(f"   ✅ {len(strokes)} strokes")
        for i,s in enumerate(strokes):
            print(f"      #{i+1}: {s.stroke_type.value} (frames {s.start_frame}-{s.end_frame}, conf {s.confidence:.0%})")
        print("\n📊 Step 3/3: Phase-aware analysis...")
        analyses = [self.form_analyzer.analyze_stroke(s,
            s.velocity_segment if s.velocity_segment is not None else np.array([])) for s in strokes]
        return {"video_path":video_path, "total_frames":len(poses), "total_strokes":len(strokes),
                "poses":poses, "strokes":strokes, "analyses":analyses,
                "timestamp":datetime.now().isoformat()}

    def analyze_live(self, camera_index=0):
        cap = cv2.VideoCapture(camera_index)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0; recent = []; fn = 0
        print("🎾 Live mode — press 'q' to quit")
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret: break
            pose = self.pose_estimator.process_frame(frame, fn, (fn/fps)*1000)
            if pose:
                recent.append(pose); recent = recent[-int(fps*3):]
                frame = self.pose_estimator.draw_pose(frame, pose)
                strokes = self.stroke_detector.detect_strokes(recent)
                if strokes:
                    s = strokes[-1]
                    a = self.form_analyzer.analyze_stroke(s, s.velocity_segment or np.array([]))
                    cv2.putText(frame, f"{s.stroke_type.value.upper()} ({a.overall_score:.0f})",
                                (30,50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0,255,0), 3)
                    if a.form_issues:
                        cv2.putText(frame, f"Tip: {a.form_issues[0].suggestion[:80]}",
                                    (30,100), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255,255,0), 2)
            cv2.imshow("Tennis Analyzer", frame)
            if cv2.waitKey(1) & 0xFF == ord('q'): break
            fn += 1
        cap.release(); cv2.destroyAllWindows()

    def print_report(self, results):
        print(f"\n{'='*60}\n  🎾 TENNIS STROKE ANALYSIS REPORT v2\n{'='*60}")
        print(f"  Video: {results.get('video_path','N/A')}")
        print(f"  Frames: {results.get('total_frames',0)} | Strokes: {results.get('total_strokes',0)}")
        for a in results.get("analyses",[]): print(a.summary)
        ai = [i for a in results.get("analyses",[]) for i in a.form_issues]
        if ai:
            print(f"\n{'='*60}\n  🎯 TOP PRIORITIES\n{'='*60}")
            for cat,cnt in Counter(i.category for i in ai).most_common(3):
                s = next(i for i in ai if i.category==cat)
                print(f"\n  {cnt}x — {cat}\n     💡 {s.suggestion}")

    def save_report(self, results, path):
        data = {"video":results.get("video_path"), "timestamp":results.get("timestamp"),
                "total_strokes":results.get("total_strokes"), "strokes":[
            {"i":i+1,"type":s.stroke_type.value,"conf":s.confidence,
             "frames":f"{s.start_frame}-{s.end_frame}","score":a.overall_score,
             "strengths":a.strengths,"issues":[{"cat":iss.category,"sev":iss.severity,
             "desc":iss.description,"tip":iss.suggestion,"val":iss.measured_value,
             "ideal":iss.ideal_range} for iss in a.form_issues]}
            for i,(s,a) in enumerate(zip(results.get("strokes",[]),results.get("analyses",[])))]}
        with open(path,"w") as f: json.dump(data, f, indent=2)
        print(f"💾 Saved to {path}")

    def export_annotated_video(self, video_path, results, output_path):
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        w,h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        out = cv2.VideoWriter(output_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w,h))
        fa = {}
        for s,a in zip(results.get("strokes",[]),results.get("analyses",[])):
            for fn in range(s.start_frame, s.end_frame+1): fa[fn] = (s, a)
        pm = {p.frame_number:p for p in results.get("poses",[])}
        fn = 0
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret: break
            if fn in pm: frame = self.pose_estimator.draw_pose(frame, pm[fn])
            if fn in fa:
                s,a = fa[fn]
                cv2.putText(frame, f"{s.stroke_type.value.upper()} - {a.overall_score:.0f}/100",
                            (30,50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0,255,0), 3)
                if a.form_issues:
                    cv2.putText(frame, f"Tip: {a.form_issues[0].suggestion[:80]}",
                                (30,100), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255,255,0), 2)
            out.write(frame); fn += 1
        cap.release(); out.release()
        print(f"🎬 Annotated video → {output_path}")

    def close(self): self.pose_estimator.close()

# ==================== CLI ====================
if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="🎾 Tennis Stroke Analyzer v2")
    p.add_argument("video", nargs="?", help="Video file path")
    p.add_argument("--live", action="store_true", help="Live camera")
    p.add_argument("--hand", default="right", choices=["left","right"])
    p.add_argument("--output", default="tennis_report.json")
    p.add_argument("--annotated-video", default=None, help="Export annotated video")
    # Tuning parameters
    p.add_argument("--sensitivity", type=float, default=2.5,
                   help="Detection sensitivity (higher=fewer detections, default=2.5)")
    p.add_argument("--cooldown", type=float, default=1.0,
                   help="Min seconds between strokes (default=1.0)")
    args = p.parse_args()

    analyzer = TennisStrokeAnalyzer(dominant_hand=args.hand)
    analyzer.stroke_detector.threshold_multiplier = args.sensitivity
    analyzer.stroke_detector.cooldown_seconds = args.cooldown

    if args.live:
        analyzer.analyze_live()
    elif args.video:
        r = analyzer.analyze_video(args.video)
        analyzer.print_report(r)
        analyzer.save_report(r, args.output)
        if args.annotated_video:
            analyzer.export_annotated_video(args.video, r, args.annotated_video)
    else:
        print("Usage:")
        print("  python tennis_analyzer_v2.py practice.mp4 --hand right")
        print("  python tennis_analyzer_v2.py --live --hand right")
        print("  python tennis_analyzer_v2.py video.mp4 --sensitivity 3.0 --cooldown 1.5")
    analyzer.close()


