/* 乒乓球 AI 动作评分系统 - 纯浏览器版核心逻辑
   模块：姿态提取(MediaPipe WASM) / 动作分割 / DTW评分 / 段位成长 / 教练反馈 / 实时摄像头评分

   变更说明（2026-08）：
   1) 删除"按段位自适应调整评分严格度"的机制——此前低段位用户使用宽松 k 值，
      动作不规范也会显示异常高分，造成误导。现在所有用户统一使用按真实数据
      校准的固定 k 值（SCORE_K = 50），分数横向可比。段位系统仅保留为
      成长轨迹与教练寄语，不再影响评分本身。
   2) 新增实时评分模式：申请摄像头权限后逐帧检测姿态，在线跟踪肘部速度，
      挥拍结束后立即（毫秒级）完成 DTW 比对并给出分数与纠正建议。

   开源借鉴标注：
   - 实时检测循环（requestAnimationFrame + detectForVideo + video.currentTime
     去重守卫）参考 Google 官方 MediaPipe tasks-vision pose_landmarker
     Web 示例（Apache-2.0）：
     https://github.com/google-ai-edge/mediapipe-samples/tree/main/examples/pose_landmarker
   - 摄像头实时姿态反馈的产品形态参考 ergoSmart（MediaPipe Pose 实时网络摄像头
     姿态教练）：https://github.com/princesinghrajput/ergoSmart
   - 肘部速度峰值定位击球时刻 + 关节角度序列 DTW 比对评分的思路，与
     Lyu et al. 2025（Frontiers in Sports and Active Living, MediaPipe 乒乓球
     正手生物力学量化框架）及 LearnOpenCV《AI Fitness Trainer》一致。
   以上仅为思路/模式借鉴，代码均为本项目自研实现。 */

"use strict";

// ---------- 配置 ----------
const JOINTS = ["left_elbow_angle", "right_elbow_angle",
                "left_shoulder_angle", "right_shoulder_angle",
                "left_knee_angle", "right_knee_angle"];
const LM = { nose:0, left_shoulder:11, right_shoulder:12, left_elbow:13, right_elbow:14,
             left_wrist:15, right_wrist:16, left_hip:23, right_hip:24,
             left_knee:25, right_knee:26, left_ankle:27, right_ankle:28 };
const ANGLE_DEFS = {
  left_elbow_angle: ["left_shoulder","left_elbow","left_wrist"],
  right_elbow_angle: ["right_shoulder","right_elbow","right_wrist"],
  left_shoulder_angle: ["left_hip","left_shoulder","left_elbow"],
  right_shoulder_angle: ["right_hip","right_shoulder","right_elbow"],
  left_knee_angle: ["left_hip","left_knee","left_ankle"],
  right_knee_angle: ["right_hip","right_knee","right_ankle"],
};
const WEIGHTS = { left_elbow_angle:0.08, right_elbow_angle:0.22,
                  left_shoulder_angle:0.10, right_shoulder_angle:0.20,
                  left_knee_angle:0.20, right_knee_angle:0.20 };
const FB_RULES = {
  right_elbow_angle: [10,20,"持拍臂肘部伸展幅度与标准偏差较大，注意击球瞬间手臂充分伸展"],
  left_elbow_angle:  [10,20,"非持拍臂配合偏差较大，注意保持平衡姿态"],
  right_shoulder_angle:[10,20,"持拍侧转体幅度不足/过大，引拍时注意腰腹带动转体"],
  left_shoulder_angle: [10,20,"随挥侧肩部偏差较大，注意肩线整体转动"],
  right_knee_angle:  [12,25,"右腿弯曲程度不稳定，注意保持重心下沉"],
  left_knee_angle:   [12,25,"左腿弯曲程度不稳定，注意保持重心下沉"],
};
const JOINT_CN = { right_elbow_angle:"右肘", left_elbow_angle:"左肘",
  right_shoulder_angle:"右肩", left_shoulder_angle:"左肩",
  right_knee_angle:"右膝", left_knee_angle:"左膝" };

/* 评分严格度：固定 k，按真实数据校准（同类动作互评≈70-80分，明显错误动作<60分）。
   不再按段位调整——所有用户同一把尺子，分数才可比、可追踪。 */
const SCORE_K = 50.0;

/* 段位仅用于成长轨迹与教练寄语，不影响评分严格度（已删除各段位独立的 k 值）。 */
const TIERS = [
  {name:"青铜", std:25, minAvg:0,  focus:["left_knee_angle","right_knee_angle","left_shoulder_angle"],
   motto:"先把根基打牢：站稳、屈膝、重心下沉", next:"升级关键：保持膝盖弯曲、重心稳定"},
  {name:"白银", std:18, minAvg:55, focus:["right_shoulder_angle","left_shoulder_angle","right_knee_angle"],
   motto:"开始用身体打球：转体带动手臂", next:"升级关键：引拍时充分转体，用腰腹带动挥拍"},
  {name:"黄金", std:12, minAvg:62, focus:["right_elbow_angle","right_shoulder_angle"],
   motto:"动作框架已成型，雕琢发力链条", next:"升级关键：击球瞬间手臂充分伸展，发力从脚到腰到手一气呵成"},
  {name:"铂金", std:8,  minAvg:70, focus:["right_elbow_angle","left_elbow_angle","right_shoulder_angle"],
   motto:"细节决定上限：一致性比爆发更重要", next:"升级关键：每一次挥拍的角度曲线都要稳定复现"},
  {name:"大师", std:5,  minAvg:78, focus:["right_elbow_angle","left_elbow_angle"],
   motto:"精益求精，向教科书级动作对齐", next:"保持：与精英模板的逐帧偏差控制在个位数"},
];
const PLACEMENT = 3, DEMOTE_SHIELD = 3;
const LR_PAIRS = [["left_shoulder","right_shoulder"],["left_elbow","right_elbow"],
  ["left_wrist","right_wrist"],["left_hip","right_hip"],["left_knee","right_knee"],
  ["left_ankle","right_ankle"]];
const LR_ANGLES = [["left_elbow_angle","right_elbow_angle"],
  ["left_shoulder_angle","right_shoulder_angle"],["left_knee_angle","right_knee_angle"]];

/* 实时模式参数 */
const LIVE = {
  bufferSec: 3.0,        // 滚动缓冲时长（覆盖 引拍0.8s + 随挥0.6s + 余量）
  preSec: 0.8, postSec: 0.6,   // 挥拍段截取窗口（与离线分割一致）
  endRatio: 0.45,        // 速度回落至峰值比例以下判定随挥结束
  endHoldSec: 0.15,      // 需持续低于该比例的时间
  cooldownSec: 0.6,      // 两次评分之间的冷却（支持连续挥拍，峰值间隔通常>1s）
  minPeakSpeed: 1.6,     // 峰值速度下限（归一化坐标/秒），过滤走动噪音
  warmupSec: 1.5,        // 摄像头开启后的预热期，期间不触发
  readyHoldSec: 0.8,     // 首次就位：全身入镜且站定持续时间（仅需一次，之后锁存）
  armLostSec: 1.5,       // 人体丢失超过该时长后才解除就绪，回到首次就位流程
  triggerRatio: 0.7,     // 上升沿触发：速度从阈值×该比例以下冲到阈值以上才算新挥拍
  maxHipDrift: 0.18,     // 挥拍段内髋部横移上限，超过判为走动/调整位置
};

const TEMPLATES = JSON.parse(document.getElementById("tpl-data").textContent);
const $ = id => document.getElementById(id);
const setStatus = t => $("status").textContent = t;

// ---------- 数学：角度 & DTW ----------
function angle2D(a, b, c) {   // 角ABC（顶点B），2D
  const bax = a.x-b.x, bay = a.y-b.y, bcx = c.x-b.x, bcy = c.y-b.y;
  const na = Math.hypot(bax,bay), nc = Math.hypot(bcx,bcy);
  if (na < 1e-8 || nc < 1e-8) return null;
  let cos = (bax*bcx + bay*bcy) / (na*nc);
  cos = Math.max(-1, Math.min(1, cos));
  return Math.acos(cos) * 180 / Math.PI;
}

function dtwPath(s, t) {      // 经典DTW + 路径回溯
  const n = s.length, m = t.length;
  const D = Array.from({length:n+1}, () => new Float64Array(m+1).fill(Infinity));
  D[0][0] = 0;
  for (let i=1;i<=n;i++) for (let j=1;j<=m;j++) {
    const c = Math.abs(s[i-1]-t[j-1]);
    D[i][j] = c + Math.min(D[i-1][j], D[i][j-1], D[i-1][j-1]);
  }
  let i=n, j=m; const path=[];
  while (i>0 && j>0) {
    path.push([i-1,j-1]);
    if (D[i-1][j-1] <= D[i-1][j] && D[i-1][j-1] <= D[i][j-1]) { i--; j--; }
    else if (D[i-1][j] <= D[i][j-1]) i--;
    else j--;
  }
  return path;
}

function fillCol(seq, j) {    // 该关节列：null用均值填充
  const vals = seq.map(f=>f[j]).filter(v=>v!==null&&v!==undefined);
  const mean = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 90;
  return seq.map(f => (f[j]===null||f[j]===undefined) ? mean : f[j]);
}

function scoreSeq(userAngles, tplAngles, k) {  // userAngles/tplAngles: 帧数组[6]
  let total = 0; const detail = {};
  JOINTS.forEach((joint, idx) => {
    const u = fillCol(userAngles, idx), t = fillCol(tplAngles, idx);
    const path = dtwPath(u, t);
    let dev = 0;
    for (const [a,b] of path) dev += Math.abs(u[a]-t[b]);
    dev /= path.length;
    const w = WEIGHTS[joint];
    detail[joint] = { mean_deviation_deg: +dev.toFixed(2), weight: w,
                      joint_score: +(100*Math.exp(-dev/k)).toFixed(2) };
    total += w * dev;
  });
  return { score: +(100*Math.exp(-total/k)).toFixed(2), joint_detail: detail };
}

// ---------- 姿态 -> 角度序列 ----------
function frameAngles(lm) {
  const P = {}; for (const n in LM) P[n] = lm[LM[n]];
  const row = JOINTS.map(j => {
    const [a,b,c] = ANGLE_DEFS[j].map(n => P[n]);
    if (Math.min(a.visibility, b.visibility, c.visibility) < 0.5) return null;
    return angle2D(a,b,c);
  });
  return row;
}

function mirrorAngles(frames) {   // 左右角度交换（左手镜像用）
  return frames.map(row => {
    const r = row.slice();
    for (const [a,b] of LR_ANGLES) {
      const ia = JOINTS.indexOf(a), ib = JOINTS.indexOf(b);
      [r[ia], r[ib]] = [r[ib], r[ia]];
    }
    return r;
  });
}

// ---------- 动作分割 ----------
function segment(frames) {   // frames: [{t, lm|null, angles}]
  const n = frames.length;
  if (n < 10) return [];
  const ts = frames.map(f=>f.t);
  const speed = new Array(n).fill(0);
  for (const elbow of [LM.left_elbow, LM.right_elbow]) {
    const xs = frames.map(f => (f.lm && f.lm[elbow].visibility>0.5) ? f.lm[elbow].x : NaN);
    const ys = frames.map(f => (f.lm && f.lm[elbow].visibility>0.5) ? f.lm[elbow].y : NaN);
    // 插值
    let last=NaN;
    for (let i=0;i<n;i++) { if (!isNaN(xs[i])) last=xs[i]; else xs[i]=last; }
    for (let i=n-1;i>=0;i--) { if (!isNaN(xs[i])) last=xs[i]; else xs[i]=last; }
    let lastY=NaN;
    for (let i=0;i<n;i++) { if (!isNaN(ys[i])) lastY=ys[i]; else ys[i]=lastY; }
    for (let i=n-1;i>=0;i--) { if (!isNaN(ys[i])) lastY=ys[i]; else ys[i]=lastY; }
    for (let i=1;i<n;i++) {
      const dt = ts[i]-ts[i-1] || 1e-3;
      const v = Math.hypot(xs[i]-xs[i-1], ys[i]-ys[i-1]) / dt;
      if (!isNaN(v)) speed[i] = Math.max(speed[i], v);
    }
  }
  // 平滑
  const sm = speed.map((_,i) => {
    const s = speed.slice(Math.max(0,i-2), i+3);
    return s.reduce((a,b)=>a+b,0)/s.length;
  });
  const sorted = [...sm].sort((a,b)=>a-b);
  const p75 = sorted[Math.floor(n*0.75)];
  const mx = sorted[n-1];
  const th = p75 + 0.25*(mx-p75);
  const effFps = 1 / ((ts[n-1]-ts[0])/(n-1) || 1/15);
  const minGap = Math.floor(0.9*effFps);
  const pre = Math.floor(0.8*effFps), post = Math.floor(0.6*effFps);
  const peaks = [];
  for (let i=2;i<n-2;i++) {
    if (sm[i] > th && sm[i]>=sm[i-1] && sm[i]>=sm[i+1] && sm[i]-Math.min(sm[i-2],sm[i+2]) > th*0.25) {
      if (peaks.length && i-peaks[peaks.length-1] < minGap) {
        if (sm[i] > sm[peaks[peaks.length-1]]) peaks[peaks.length-1] = i;
      } else peaks.push(i);
    }
  }
  const segs = [];
  let lastEnd = -1;
  for (const p of peaks) {
    const s = Math.max(0,p-pre), e = Math.min(n,p+post+1);
    if (s <= lastEnd) continue;
    const seg = frames.slice(s,e);
    const det = seg.filter(f=>f.lm).length/seg.length;
    if (det < 0.6) continue;
    const hips = seg.filter(f=>f.lm && f.lm[LM.left_hip].visibility>0.5)
                    .map(f=>f.lm[LM.left_hip].x);
    if (hips.length>5 && Math.max(...hips)-Math.min(...hips) > 0.15) continue;
    segs.push({ peakIdx:p, peakTime:+ts[p].toFixed(2), peakSpeed:+sm[p].toFixed(3),
                detRate:+det.toFixed(2),
                angles: seg.filter(f=>f.lm).map(f=>f.angles),
                lms: seg.filter(f=>f.lm).map(f=>f.lm) });
    lastEnd = e;
  }
  return segs;
}

// ---------- 段位成长（localStorage，只记录成长，不影响评分严格度） ----------
function ladderKey(uid){ return "tt_ladder_" + uid; }
function getLadder(uid){
  const d = localStorage.getItem(ladderKey(uid));
  return d ? JSON.parse(d) : { tierIdx:0, lp:0, sessions:0, scoreSum:0, lowStreak:0 };
}
function saveLadder(uid, L){ localStorage.setItem(ladderKey(uid), JSON.stringify(L)); }

function coachText(tier, tierIdx, detail, event, sessions){
  const parts = [];
  if (event==="placement") parts.push(`已完成${PLACEMENT}次定段评估，教练已为你记录了训练起点。`);
  else if (event==="promote") parts.push("最近进步明显，已进入下一训练阶段——继续保持。");
  else if (event==="demote") parts.push("最近状态有波动，先回到上一阶段的训练重点巩固一下，这不是退步，是为了走得更稳。");
  else if (sessions<=PLACEMENT) parts.push(`初始评估进行中（${sessions}/${PLACEMENT}），再完成几次练习，系统就能画出你的成长曲线。`);
  const gaps = tier.focus.map(j=>[detail[j]?detail[j].mean_deviation_deg:0, j])
                         .filter(g=>g[0]>0).sort((a,b)=>b[0]-a[0]);
  if (gaps.length){
    const [dev, worst] = gaps[0];
    const jn = {right_elbow_angle:"持拍臂肘部",left_elbow_angle:"非持拍臂肘部",
      right_shoulder_angle:"持拍侧转体",left_shoulder_angle:"随挥侧肩部",
      right_knee_angle:"右腿支撑",left_knee_angle:"左腿支撑"}[worst];
    if (dev > tier.std) parts.push(`当前最值得投入的是${jn}（与标准偏差约${dev.toFixed(0)}°，本阶段目标是压到${tier.std}°以内）。`);
    else parts.push(`${jn}已达标，${tier.motto}。`);
  }
  if (tierIdx < TIERS.length-1) parts.push(tier.next + "。");
  return parts.join("");
}

function recordLadder(uid, score, detail){
  const L = getLadder(uid);
  L.sessions++; L.scoreSum += score;
  let event = null;
  if (score >= 70){ L.lp += 22 + (score-70)*0.6; L.lowStreak = 0; }
  else if (score >= 55){ L.lp += 8; L.lowStreak = 0; }
  else { L.lowStreak++; if (L.lowStreak > DEMOTE_SHIELD) L.lp -= 10; }
  if (L.lp >= 100 && L.sessions > PLACEMENT && L.tierIdx < TIERS.length-1){
    L.tierIdx++; L.lp = 20; L.lowStreak = 0; event = "promote";
  } else if (L.sessions === PLACEMENT){
    const avg = L.scoreSum / L.sessions;
    L.tierIdx = 0;
    TIERS.forEach((t,i)=>{ if (avg >= t.minAvg) L.tierIdx = i; });
    L.lp = 50; event = "placement";
  } else if (L.lp < 0 && L.tierIdx > 0){
    L.tierIdx--; L.lp = 70; L.lowStreak = 0; event = "demote";
  }
  L.lp = Math.max(0, Math.min(199, L.lp));
  saveLadder(uid, L);
  const tier2 = TIERS[L.tierIdx];
  return { tier: tier2.name, tierIdx: L.tierIdx, lp: +L.lp.toFixed(1),
           sessions: L.sessions, event,
           coaching: coachText(tier2, L.tierIdx, detail, event, L.sessions) };
}

function generateFeedback(result){
  const issues = [];
  for (const j in result.joint_detail){
    const d = result.joint_detail[j], [mild, severe, text] = FB_RULES[j];
    if (d.mean_deviation_deg >= severe) issues.push([d.weight*d.mean_deviation_deg, "重点改进："+text]);
    else if (d.mean_deviation_deg >= mild) issues.push([d.weight*d.mean_deviation_deg, text]);
  }
  issues.sort((a,b)=>b[0]-a[0]);
  if (!issues.length) return "动作规范，各关节与标准模板匹配良好，继续保持！";
  const s = result.score;
  const head = s>=85 ? "动作与标准模板高度接近。" : s>=70 ? "动作基本规范，仍有提升空间。"
               : "动作与标准差距较明显，建议对照模板分解练习。";
  return head + " " + issues.slice(0,3).map(x=>x[1]).join("；") + "。";
}

// ---------- MediaPipe 加载（单文件版已全部内嵌；双文件版从 CDN 加载） ----------
let landmarker = null, _modelU8 = null;
function b64ToU8(b64){ const bin = atob(b64), n = bin.length, u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i); return u8; }
async function initModel(){
  if (landmarker) return;
  let vision, fileset, base;
  if (window.MPVision && typeof WASM_LOADER_B64 !== "undefined") {
    // 单文件版：运行时/WASM/模型全部内嵌，零联网
    setStatus("正在初始化 AI 姿态模型（已内置，无需联网）...");
    vision = window.MPVision;
    const wasmJsUrl  = URL.createObjectURL(new Blob([b64ToU8(WASM_LOADER_B64)], { type: "text/javascript" }));
    const wasmBinUrl = URL.createObjectURL(new Blob([b64ToU8(WASM_BINARY_B64)], { type: "application/wasm" }));
    fileset = { wasmLoaderPath: wasmJsUrl, wasmBinaryPath: wasmBinUrl, assetLoaderPath: wasmJsUrl };
    if (!_modelU8) _modelU8 = b64ToU8(MODEL_B64);
    base = { modelAssetBuffer: _modelU8 };
  } else {
    // 线上部署版（GitHub Pages）：骨架走 github.io，模型二进制走 jsDelivr
    // 国内 CDN（同源仓库 assets/ 目录），失败时回退 googleapis。
    // 手动 fetch 以便显示下载进度、避免"无网络连接"错觉。
    $("net").style.display = "block";
    setStatus("正在加载 AI 运行时...");
    const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
    vision = await import(`${CDN}/+esm`);
    fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    const MODEL_URLS = [
      "https://cdn.jsdelivr.net/gh/New-Life-xin/TT-coach@b2ff7ee3166f22326e535d2626bb99ffb10daf0b/assets/pose_landmarker_full.task",
      "https://fastly.jsdelivr.net/gh/New-Life-xin/TT-coach@b2ff7ee3166f22326e535d2626bb99ffb10daf0b/assets/pose_landmarker_full.task",
      "https://gcore.jsdelivr.net/gh/New-Life-xin/TT-coach@b2ff7ee3166f22326e535d2626bb99ffb10daf0b/assets/pose_landmarker_full.task",
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    ];
    let buf = null, lastErr = null;
    for (const url of MODEL_URLS) {
      try {
        setStatus("正在下载 AI 姿态模型（约9MB）...");
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const total = +resp.headers.get("content-length") || 9398198;
        const reader = resp.body.getReader();
        const chunks = []; let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); got += value.length;
          setStatus(`正在下载 AI 姿态模型 ${(got/1048576).toFixed(1)}/9.0 MB（${Math.round(got/total*100)}%）...`);
        }
        buf = new Uint8Array(got);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
        break;
      } catch (e) { lastErr = e; }
    }
    if (!buf) throw new Error("模型下载失败，请检查网络后刷新重试：" + (lastErr && lastErr.message));
    setStatus("正在初始化 AI 姿态模型...");
    base = { modelAssetBuffer: buf };
  }
  const opts = (del) => ({
    baseOptions: Object.assign({ delegate: del }, base),
    runningMode: "VIDEO", numPoses: 1,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5 });
  try { landmarker = await vision.PoseLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch(e) { landmarker = await vision.PoseLandmarker.createFromOptions(fileset, opts("CPU")); }
  setStatus("模型就绪 ✔");
}

// ---------- 评分：与标准库多模板比对取最佳 ----------
/* 自动判别正反手：2026-08 标准库扩充至 119 个模板（新增 48 个按文件名
   准确标注的示范动作段，并纠正 2 个高置信错标），留一法交叉验证
   判别准确率 95.8%。此处额外输出判别置信度（正反手最佳分之差），
   分差过小时提示用户可手动指定动作类型。 */
/* 视角与持拍手判定（2026-08 新增）：
   标准库模板全部为背面拍摄，MediaPipe 输出的是人体解剖学左右（与拍摄方向无关），
   而 2D 关节角随视角镜像——正面拍摄右手球员时，角度序列恰好像"背面左手"，
   旧逻辑仅靠镜像匹配胜负推断持拍手，会把右手误判为左手。
   解决方案：
   - 视角：正面拍摄时鼻/眼关键点可见，背面拍摄时被头部遮挡 → 用面部点可见度区分；
   - 持拍手：挥拍段内哪侧手腕速度积分大，哪侧就是持拍手（与视角无关，天然可靠）；
   - 两者结合推出"应有的镜像状态"（右手+正面 或 左手+背面 ⇒ 需要镜像对齐模板），
     并在匹配备忘中锁定该镜像方向，避免正反手因镜像歧义被翻转。 */
function analyzeViewAndHand(lms){   // lms: 段内有检出的帧的 landmarks 数组
  let faceSum = 0, faceN = 0;
  const spd = { left: 0, right: 0 };
  for (let i = 0; i < lms.length; i++){
    const lm = lms[i];
    for (const f of [0, 2, 5]){ faceSum += lm[f].visibility; faceN++; }  // 鼻、双眼
    if (i > 0){
      const p = lms[i-1];
      for (const [side, w] of [["left",15],["right",16]]){
        if (lm[w].visibility > 0.5 && p[w].visibility > 0.5)
          spd[side] += Math.hypot(lm[w].x-p[w].x, lm[w].y-p[w].y);
      }
    }
  }
  const faceVis = faceN ? faceSum/faceN : 0;
  const view = faceVis > 0.55 ? "front" : faceVis < 0.35 ? "back" : null;
  let hand = null;
  const tot = spd.left + spd.right;
  if (tot > 1e-6){
    if (spd.right > spd.left * 1.25) hand = "right";
    else if (spd.left > spd.right * 1.25) hand = "left";
  }
  // 模板=背面+右手 ⇒ 需镜像当且仅当 (右手且正面) 或 (左手且背面)
  let mirrorLock = null;
  if (view && hand) mirrorLock = (hand === "right") === (view === "front");
  return { view, hand, mirrorLock, faceVis: +faceVis.toFixed(2) };
}

function bestMatch(segAngles, actionReq, mirrorLock){
  const actions = actionReq==="自动" ? ["正手攻球","反手攻球"] : [actionReq];
  let best = null; const bestByAct = {};
  const mirrorOpts = (mirrorLock === null || mirrorLock === undefined)
    ? [false, true] : [mirrorLock];
  for (const act of actions){
    const tpls = TEMPLATES.filter(t=>t.action===act);
    for (const mirrored of mirrorOpts){
      const ua = mirrored ? mirrorAngles(segAngles) : segAngles;
      for (const tpl of tpls){
        const r = scoreSeq(ua, tpl.angles, SCORE_K);   // 固定 k，不随段位变化
        if (!best || r.score > best.r.score) best = { r, act, tpl, mirrored };
        if (!bestByAct[act] || r.score > bestByAct[act].r.score)
          bestByAct[act] = { r, act, tpl, mirrored };
      }
    }
  }
  if (actionReq==="自动" && bestByAct["正手攻球"] && bestByAct["反手攻球"]){
    const d = Math.abs(bestByAct["正手攻球"].r.score - bestByAct["反手攻球"].r.score);
    best.conf = d >= 8 ? "高" : d >= 3 ? "中" : "低";
  }
  return best;
}

// ---------- 视频帧提取（上传模式） ----------
async function extractFrames(file){
  const url = URL.createObjectURL(file);
  const vid = $("vid");
  vid.src = url;
  await new Promise((res, rej) => { vid.onloadedmetadata = res;
    vid.onerror = () => rej(new Error("视频解码失败：浏览器只支持 H.264/H.265 编码的 mp4 或 webm，请换用手机直接拍摄的视频")); });
  const dur = vid.duration;
  if (!dur || !isFinite(dur)) throw new Error("视频无法解码，请换 mp4 格式");
  const step = 1/15;                       // 15fps 采样
  const frames = [];
  let t = 0, done = 0;
  while (t < dur) {
    await new Promise(res => { vid.onseeked = res; vid.currentTime = t; });
    const res = landmarker.detectForVideo(vid, Math.round(t*1000));
    const lm = (res.landmarks && res.landmarks.length) ? res.landmarks[0] : null;
    frames.push({ t, lm, angles: lm ? frameAngles(lm) : null });
    t += step; done++;
    if (done % 10 === 0) setStatus(`分析中... ${Math.min(100, Math.round(t/dur*100))}%`);
  }
  URL.revokeObjectURL(url);
  const det = frames.filter(f=>f.lm).length / frames.length;
  if (det < 0.3) throw new Error(
    `人体姿态检出率仅 ${(det*100).toFixed(0)}%，无法评分。请确认：直接拍摄（非录屏）、全身入镜、人物占画面一半以上、光线充足`);
  return frames;
}

async function runUpload(file, actionReq, uid){
  await initModel();
  setStatus("提取姿态中...");
  const frames = await extractFrames(file);
  const segs = segment(frames);
  if (!segs.length) throw new Error("未能检出有效击球动作，请确认视频包含完整的挥拍动作");
  const seg = segs.reduce((a,b)=> a.peakSpeed>=b.peakSpeed?a:b);
  const vh = analyzeViewAndHand(seg.lms);
  const bm = bestMatch(seg.angles, actionReq, vh.mirrorLock);
  const { r, act, tpl, mirrored } = bm;
  const ladder = recordLadder(uid, r.score, r.joint_detail);
  return { r, act, tpl, mirrored, seg, ladder, conf: bm.conf, vh };
}

// ---------- 实时摄像头评分 ----------
/* 实现要点（低延迟）：
   - getUserMedia 申请 640x480 流，GPU 优先的 MediaPipe VIDEO 模式逐帧检测；
     用 video.currentTime 变化做去重守卫，避免对同一帧重复推理（官方示例模式）。
   - 推理在 requestAnimationFrame 循环内同步完成，不做网络往返，帧到结果零等待。
   - 在线维护 3s 滚动缓冲与肘部速度状态机：超过动态阈值→跟踪峰值→
     回落至 45% 以下并持续 0.15s 即判定随挥结束，立刻截取 [峰值-0.8s, 峰值+0.6s]
     送入 DTW 比对。119 个模板 ×2 镜像 ×6 关节的 DTW 总量为毫秒级，
     从随挥结束到出分通常 < 200ms。
   - 防误触发（就绪门控）：首次检测前需全身核心点（肩/髋/膝）可见且髋部
     站定 0.8s，之后锁存"已就位"，人体丢失 1.5s 以上才解除；连续挥拍通过
     速度上升沿触发（两次挥拍间速度自然回落），无需每次重新站定；
     评分前检查段内髋部横移，走动/调整位置不计分。 */
let liveStream = null, liveRunning = false, liveLastVideoTime = -1;
let liveFacing = "user";          // user=前置(自拍镜像) / environment=后置
let liveBuf = [];                 // [{t, lm, angles}]
let liveState = "idle", livePeakV = 0, livePeakT = 0, liveBelowSince = 0, liveCooldownUntil = 0;
let liveSpeeds = [];              // 近期平滑速度，用于动态阈值
let liveReadySince = 0, liveStartT = 0;   // 就绪门控（首次就位）
let liveArmed = false, liveLastSeenT = 0; // 就绪锁存：一旦就位，人体不丢失就一直保持
let livePrevV = 0;                        // 上一帧速度，上升沿触发用
let livePrevElbow = null, liveFpsT = 0, liveFpsN = 0;

const SKELETON = [   // 骨骼连线（肩/肘/腕/髋/膝/踝）
  [11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],
  [23,25],[25,27],[24,26],[26,28]];

function liveReset(){
  liveBuf = []; liveState = "idle"; livePeakV = 0; livePeakT = 0;
  liveBelowSince = 0; liveCooldownUntil = 0; liveSpeeds = []; livePrevElbow = null;
  liveReadySince = 0; liveStartT = performance.now() / 1000;
  liveArmed = false; liveLastSeenT = 0; livePrevV = 0;
}

async function openCamera(facing){
  if (liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream = null; }
  liveStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: facing },
    audio: false });
  const cam = $("cam");
  // 前置自拍镜像显示（符合直觉），后置正常显示
  cam.style.transform = facing === "user" ? "scaleX(-1)" : "none";
  cam.srcObject = liveStream;
  await new Promise(res => { cam.onloadedmetadata = res; });
  await cam.play();
}

async function startLive(){
  // iOS 兼容性要点：
  // 1) getUserMedia 必须在用户点击后的"激活窗口"内发起——iOS Safari 中
  //    若先 await 模型初始化（2-4秒）再申请权限，激活已过期会被静默拒绝。
  //    因此摄像头申请与模型初始化并行发起，摄像头优先。
  // 2) file:// 或微信/文件 App 内置的 WebView 没有摄像头 API，需给出明确提示。
  if (!window.isSecureContext)
    throw new Error("当前页面环境不允许调用摄像头。iPhone 请用 Safari 直接打开本页面" +
                    "（不要在微信或「文件」App 内打开），或改用「上传视频」模式直接拍摄");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    throw new Error("当前浏览器不支持摄像头调用。iPhone 请用 Safari 直接打开本页面" +
                    "（不要在微信或「文件」App 内打开）；电脑请用最新版 Chrome / Edge");
  const camPromise = openCamera(liveFacing);
  const modelPromise = initModel();
  try {
    await camPromise;
  } catch (e) {
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError"))
      throw new Error("摄像头权限被拒绝。iPhone：弹窗中点「允许」；" +
                      "如已拒绝过，请到 设置 → Safari → 相机 改为「询问」或「允许」后重试");
    if (e && e.name === "NotFoundError")
      throw new Error("未检测到摄像头设备");
    throw e;
  }
  await modelPromise;
  $("camwrap").style.display = "block";
  $("btnCamFlip").style.display = "inline-block";
  liveReset();
  liveRunning = true;
  $("liveStatus").textContent = "请退后站定，全身入镜后即可开始挥拍";
  requestAnimationFrame(liveLoop);
}

function stopLive(){
  liveRunning = false;
  if (liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream = null; }
  $("camwrap").style.display = "none";
  $("btnCamFlip").style.display = "none";
  $("liveStatus").textContent = "摄像头已关闭";
}

function drawSkeleton(lm, w, h){
  const cv = $("camcv"), ctx = cv.getContext("2d");
  if (cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
  ctx.clearRect(0,0,w,h);
  if (!lm) return;
  const mirror = liveFacing === "user";   // 前置镜像显示，后置正常
  const X = p => (mirror ? 1-p.x : p.x) * w;
  ctx.strokeStyle = "#00e676"; ctx.lineWidth = 3;
  for (const [a,b] of SKELETON){
    const pa = lm[a], pb = lm[b];
    if (pa.visibility < 0.5 || pb.visibility < 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(X(pa), pa.y*h);
    ctx.lineTo(X(pb), pb.y*h);
    ctx.stroke();
  }
  ctx.fillStyle = "#ff5252";
  for (const idx of [11,12,13,14,15,16,23,24,25,26,27,28]){
    const p = lm[idx];
    if (p.visibility < 0.5) continue;
    ctx.beginPath();
    ctx.arc(X(p), p.y*h, 4, 0, Math.PI*2);
    ctx.fill();
  }
}

function liveElbowSpeed(f, prev){
  // 双肘取大者（归一化坐标速度），与离线分割口径一致
  let v = 0;
  for (const e of [LM.left_elbow, LM.right_elbow]){
    if (f.lm && f.lm[e].visibility > 0.5 && prev && prev.lm && prev.lm[e].visibility > 0.5){
      const dt = f.t - prev.t;
      if (dt > 1e-3){
        v = Math.max(v, Math.hypot(f.lm[e].x - prev.lm[e].x,
                                   f.lm[e].y - prev.lm[e].y) / dt);
      }
    }
  }
  return v;
}

function liveThreshold(){
  if (liveSpeeds.length < 20) return Infinity;
  const s = [...liveSpeeds].sort((a,b)=>a-b);
  const p75 = s[Math.floor(s.length*0.75)], mx = s[s.length-1];
  return Math.max(p75 + 0.25*(mx-p75), LIVE.minPeakSpeed*0.6);
}

function liveLoop(){
  if (!liveRunning) return;
  const cam = $("cam");
  if (cam.readyState >= 2 && cam.currentTime !== liveLastVideoTime){
    liveLastVideoTime = cam.currentTime;
    const t = performance.now() / 1000;
    const res = landmarker.detectForVideo(cam, Math.round(t*1000));
    const lm = (res.landmarks && res.landmarks.length) ? res.landmarks[0] : null;
    const frame = { t, lm, angles: lm ? frameAngles(lm) : null };

    // 滚动缓冲
    liveBuf.push(frame);
    while (liveBuf.length && liveBuf[0].t < t - LIVE.bufferSec) liveBuf.shift();

    // FPS 统计
    liveFpsN++;
    if (t - liveFpsT >= 1){
      $("liveFps").textContent = liveFpsN + " fps";
      liveFpsT = t; liveFpsN = 0;
    }

    // 在线挥拍状态机（连续挥拍版）：
    // - 首次就位需全身入镜且站定 0.8s（防止架设备/走动时误触发）；
    // - 就位后锁存，只要人体不丢失超过 1.5s 就一直保持"已就位"，
    //   之后每次挥拍用"速度上升沿"触发，无需再次站定/安静，支持连续多球。
    const v = liveElbowSpeed(frame, livePrevElbow);
    livePrevElbow = frame;
    if (v > 0){
      liveSpeeds.push(v);
      if (liveSpeeds.length > 120) liveSpeeds.shift();
    }
    // 人体存在判定（肩肘可见即可，连续挥拍中不要求全身静止）
    const personHere = lm && [11,12,13,14].every(i => lm[i].visibility > 0.5);
    if (personHere) liveLastSeenT = t;
    if (liveArmed && t - liveLastSeenT > LIVE.armLostSec){
      liveArmed = false; liveReadySince = 0;   // 人走了，回到首次就位流程
    }
    // 首次就位判定：肩髋膝六个核心点都可见，且髋部移动速度低于阈值（站定）
    if (!liveArmed){
      let ready = false;
      if (lm && [11,12,23,24,25,26].every(i => lm[i].visibility > 0.5) &&
          liveBuf.length >= 2){
        const prevLm = liveBuf[liveBuf.length-2].lm;
        if (prevLm && prevLm[23].visibility > 0.5 && prevLm[24].visibility > 0.5){
          const hx = (lm[23].x+lm[24].x)/2, hy = (lm[23].y+lm[24].y)/2;
          const px = (prevLm[23].x+prevLm[24].x)/2, py = (prevLm[23].y+prevLm[24].y)/2;
          const hv = Math.hypot(hx-px, hy-py) /
                     Math.max(1e-3, t - liveBuf[liveBuf.length-2].t);
          ready = hv < 0.3;
        }
      }
      if (ready){ if (!liveReadySince) liveReadySince = t; }
      else liveReadySince = 0;
      if (liveReadySince > 0 &&
          t - liveReadySince >= LIVE.readyHoldSec &&
          t - liveStartT >= LIVE.warmupSec){
        liveArmed = true;
      }
      var readyHint = !lm ? "未检测到人体，请站入画面"
        : (ready ? "保持站定…" : "请退后站定，全身入镜后即可开始");
    }
    const armed = liveArmed;
    const th = liveThreshold();
    if (t < liveCooldownUntil){
      // 冷却中
    } else if (liveState === "idle"){
      if (!armed){
        $("liveStatus").textContent = readyHint;
      } else if (v > th && livePrevV <= th * LIVE.triggerRatio){
        // 上升沿触发：速度刚从低位冲过阈值才算新一次挥拍，
        // 连续动作中两次挥拍之间速度自然回落，无需人为站定等待
        liveState = "swing"; livePeakV = v; livePeakT = t; liveBelowSince = 0;
        $("liveStatus").textContent = "检测到挥拍…";
      } else {
        $("liveStatus").textContent = "已就位，可连续挥拍…";
      }
    } else { // swing
      if (v > livePeakV){ livePeakV = v; livePeakT = t; liveBelowSince = 0; }
      else if (v < livePeakV * LIVE.endRatio){
        if (!liveBelowSince) liveBelowSince = t;
        if (t - liveBelowSince >= LIVE.endHoldSec && livePeakV >= LIVE.minPeakSpeed){
          liveScore(t);
          liveState = "idle"; livePeakV = 0;
          liveCooldownUntil = t + LIVE.cooldownSec;
        }
      } else liveBelowSince = 0;
    }
    livePrevV = personHere ? v : 0;

    drawSkeleton(lm, cam.videoWidth, cam.videoHeight);
  }
  requestAnimationFrame(liveLoop);
}

function liveScore(nowT){
  // 截取 [峰值-0.8s, 峰值+0.6s]（缓冲内取交集）
  const winAll = liveBuf.filter(f => f.t >= livePeakT - LIVE.preSec && f.t <= nowT);
  const segFrames = winAll.filter(f => f.lm && f.t <= Math.min(livePeakT + LIVE.postSec, nowT));
  const minLen = 8;
  if (segFrames.length < minLen){
    $("liveStatus").textContent = "本次挥拍有效帧不足，请退后一步确保全身入镜";
    return;
  }
  // 质量门控（与离线分割一致）：段内髋部横移过大视为走动/调整位置，不计分
  const hips = segFrames
    .filter(f => f.lm[LM.left_hip].visibility > 0.5)
    .map(f => f.lm[LM.left_hip].x);
  if (hips.length > 5 && Math.max(...hips) - Math.min(...hips) > LIVE.maxHipDrift){
    $("liveStatus").textContent = "检测到身体移动（非有效挥拍），请站稳后再挥";
    return;
  }
  const det = segFrames.length / Math.max(1, winAll.length);
  const t0 = performance.now();
  const uid = $("uid").value.trim() || "guest";
  const angles = segFrames.map(f => f.angles);
  const vh = analyzeViewAndHand(segFrames.map(f => f.lm));
  const bm = bestMatch(angles, $("action").value, vh.mirrorLock);
  const { r, act, tpl, mirrored } = bm;
  const ladder = recordLadder(uid, r.score, r.joint_detail);
  const ms = Math.round(performance.now() - t0);
  showResult({ r, act, tpl, mirrored, conf: bm.conf, vh,
               seg: { peakTime: (livePeakT % 3600).toFixed(2), detRate: det },
               ladder, liveMs: ms });
  $("liveStatus").textContent = `上一次挥拍 ${r.score} 分（${ms}ms 出分），继续挥拍可再次评分`;
}

// ---------- 结果展示（上传 / 实时共用） ----------
function showResult({ r, act, tpl, mirrored, seg, ladder, liveMs, conf, vh }){
  $("score").textContent = r.score;
  $("grade").textContent = r.score>=85?"优秀":r.score>=70?"良好":r.score>=55?"及格":"需加强";
  // 持拍手以手腕速度实测为准（与拍摄方向无关），视角用面部点可见度判定
  const handViewTxt = (vh && vh.hand)
    ? ` ｜ ${vh.hand==="right"?"右手":"左手"}持拍` +
      (vh.view ? `·${vh.view==="front"?"正面":"背面"}拍摄` : "") +
      (mirrored ? "（已镜像对齐模板）" : "")
    : (mirrored ? " ｜ 已镜像对齐模板" : "");
  $("meta").innerHTML =
    `匹配动作：<b>${act}</b> ｜ 最佳匹配模板：${tpl.athlete}（#${tpl.id} · ${tpl.level}）`+
    (conf?` ｜ 正反手判别置信度：<b>${conf}</b>`+(conf==="低"?"（正反手模板分差过小，如与实际不符请手动指定动作类型）":""):"")+`<br>`+
    `击球峰值 @${seg.peakTime}s ｜ 段检出率 ${(seg.detRate*100).toFixed(0)}%`+
    handViewTxt+
    (liveMs!==undefined?` ｜ 实时评分耗时 ${liveMs}ms`:"");
  $("joints").innerHTML = JOINTS.map(j=>{
    const d = r.joint_detail[j];
    return `<div class="joint"><div class="lbl"><span>${JOINT_CN[j]}</span>
      <span>${d.joint_score}分（偏差${d.mean_deviation_deg}°）</span></div>
      <div class="bar"><i style="width:${d.joint_score}%"></i></div></div>`;
  }).join("");
  $("feedback").textContent = "💡 " + generateFeedback(r);
  $("stage").textContent = "训练阶段 · " + ladder.tier +
    (ladder.sessions<=PLACEMENT?`（初始评估 ${ladder.sessions}/${PLACEMENT}）`:"");
  $("lp").textContent = "阶段进度 " + ladder.lp + "%";
  $("lpbar").style.width = ladder.lp + "%";
  $("coaching").textContent = "🏋️ " + ladder.coaching;
  $("coachbox").style.display = "block";
  $("result").style.display = "block";
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- UI：模式切换 ----------
function switchMode(mode){
  const live = mode === "live";
  $("panelUpload").style.display = live ? "none" : "block";
  $("panelLive").style.display = live ? "block" : "none";
  $("tabUpload").classList.toggle("on", !live);
  $("tabLive").classList.toggle("on", live);
  if (!live && liveRunning) stopLive();
}
$("tabUpload").onclick = () => switchMode("upload");
$("tabLive").onclick = () => switchMode("live");

// ---------- UI：上传模式 ----------
const drop=$("drop"), file=$("file"), btn=$("btn");
drop.onclick = ()=>file.click();
drop.ondragover = e=>{e.preventDefault();drop.classList.add("on");};
drop.ondragleave = ()=>drop.classList.remove("on");
drop.ondrop = e=>{e.preventDefault();drop.classList.remove("on");file.files=e.dataTransfer.files;show();};
file.onchange = show;
function show(){ if(file.files[0]){ $("fname").textContent="📹 "+file.files[0].name; btn.disabled=false; } }

btn.onclick = async ()=>{
  btn.disabled = true;
  $("err").style.display="none"; $("result").style.display="none"; $("coachbox").style.display="none";
  const uid = $("uid").value.trim() || "guest";
  try {
    const out = await runUpload(file.files[0], $("action").value, uid);
    showResult(out);
    setStatus("完成 ✔");
  } catch(e){
    console.error(e);
    const el = $("err");
    el.textContent = "❌ " + (e.message || e);
    el.style.display = "block";
    setStatus("");
  }
  btn.disabled = false;
};

// ---------- UI：实时模式 ----------
$("btnLiveStart").onclick = async ()=>{
  $("err").style.display = "none";
  $("btnLiveStart").disabled = true;
  try {
    await startLive();
    $("btnLiveStart").style.display = "none";
    $("btnLiveStop").style.display = "block";
  } catch(e){
    console.error(e);
    const el = $("err");
    el.textContent = "❌ 摄像头启动失败：" + (e.message || e) +
      "（请在浏览器地址栏允许摄像头权限）";
    el.style.display = "block";
  }
  $("btnLiveStart").disabled = false;
};
$("btnLiveStop").onclick = ()=>{
  stopLive();
  $("btnLiveStop").style.display = "none";
  $("btnLiveStart").style.display = "block";
};
$("btnCamFlip").onclick = async ()=>{
  if (!liveRunning) return;
  $("btnCamFlip").disabled = true;
  $("liveStatus").textContent = "正在切换镜头…";
  try {
    liveFacing = liveFacing === "user" ? "environment" : "user";
    await openCamera(liveFacing);
    liveReset();
    liveRunning = true;   // openCamera 不改动 liveRunning，重置状态机即可
    $("liveStatus").textContent = "已切换到" +
      (liveFacing === "user" ? "前置" : "后置") + "镜头，站定一次即可，之后可连续挥拍";
  } catch (e) {
    console.error(e);
    $("liveStatus").textContent = "镜头切换失败：" + (e.message || e);
  }
  $("btnCamFlip").disabled = false;
};
