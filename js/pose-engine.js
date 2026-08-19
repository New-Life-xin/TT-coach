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
    // 运行时优先走本站同源 assets/mp/（零跨域、可缓存），失败回退 jsDelivr CDN
    const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
    try {
      vision = await import("./assets/mp/vision_bundle.mjs");
      fileset = await vision.FilesetResolver.forVisionTasks("./assets/mp/wasm");
    } catch (e) {
      vision = await import(`${CDN}/+esm`);
      fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    }
    // 模型优先走本站同源（GitHub Pages 自带缓存），jsDelivr/googleapis 作回退
    const MODEL_URLS = [
      "assets/pose_landmarker_full.task",
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
  setStatus("模型就绪");
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
  const force = forceFeatures(seg.frames, (vh.hand || "right"));
  const diag = diagnose(seg.frames, (vh.hand || "right"), act);
  return { r, act, tpl, mirrored, seg, ladder, conf: bm.conf, vh, force, diag };
}
