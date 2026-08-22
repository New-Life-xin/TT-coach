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
let detCounter = 0, liveDets = [], detBusy = false;   // 球拍/球检测（降频 + 防堆积，不阻塞评分）

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
  initDetector();   // 球拍/球检测并行加载，失败静默（不影响评分）
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

    // 球拍/球检测（降频 + 防堆积，异步不阻塞姿态评分）
    if (detCounter++ % DET.freq === 0 && !detBusy){
      detBusy = true;
      detectFrame(cam).then(d => { liveDets = d; })
        .catch(() => { liveDets = []; })
        .finally(() => { detBusy = false; });
    }

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
    if (liveDets.length){
      drawDetections($("camcv").getContext("2d"), liveDets,
                     cam.videoWidth, cam.videoHeight, liveFacing === "user");
    }
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
  const force = forceFeatures(segFrames, (vh.hand || "right"));
  const diag = diagnose(segFrames, (vh.hand || "right"), act, bm.conf);
  const ms = Math.round(performance.now() - t0);
  showResult({ r, act, tpl, mirrored, conf: bm.conf, vh,
               seg: { peakTime: (livePeakT % 3600).toFixed(2), detRate: det },
               ladder, liveMs: ms, force, diag });
  voicePlay(voiceFeedback(uid, r.score, diag));   // 语音教练（默认静音，见 voice.js）
  $("liveStatus").textContent = `上一次挥拍 ${r.score} 分（${ms}ms 出分），继续挥拍可再次评分`;
}
