// ---------- 实时摄像头评分 ----------
/* 实现要点（低延迟）：
   - getUserMedia 申请 1280x720（16:9 横屏）流；用 video.currentTime 变化做去重
     守卫，避免对同一帧重复推理（官方示例模式）。
   - 多人锁定：未就位时用 IMAGE 模式每帧重检测（选当前最显著/近侧更大的人，
     不粘先入镜的陪练），就位后切回 VIDEO 模式追踪已锁定的正确用户；就位还需
     体型跨度（肩→膝）≥ minBodyH，排除远处的小人。
   - 推理在 requestAnimationFrame 循环内同步完成，不做网络往返，帧到结果零等待。
   - 在线维护 3s 滚动缓冲与肘部速度状态机：超过动态阈值→跟踪峰值→
     回落至 45% 以下并持续 0.15s 即判定随挥结束，立刻截取 [峰值-0.8s, 峰值+0.6s]
     送入 DTW 比对。119 个模板 ×2 镜像 ×6 关节的 DTW 总量为毫秒级，
     从随挥结束到出分通常 < 200ms。
   - 防误触发（就绪门控）：首次检测前需全身核心点（肩/髋/膝）可见、体型够大
     且髋部站定 0.8s，就位瞬间播「训练开始」+ 绿框；之后锁存"已就位"，人体丢失
     或换成远处小人 1.5s 以上才解除；连续挥拍通过速度上升沿触发（两次挥拍间
     速度自然回落），无需每次重新站定；评分前检查段内髋部横移，走动/调整位置不计分。 */
let liveStream = null, liveRunning = false, liveLastVideoTime = -1;
let liveFacing = "user";          // user=前置(自拍镜像) / environment=后置
let liveBuf = [];                 // [{t, lm, angles}]
let liveState = "idle", livePeakV = 0, livePeakT = 0, liveBelowSince = 0, liveCooldownUntil = 0;
let liveSpeeds = [];              // 近期平滑速度，用于动态阈值
let liveReadySince = 0, liveStartT = 0;   // 就绪门控（首次就位）
let liveArmed = false, liveLastSeenT = 0; // 就绪锁存：一旦就位，人体不丢失就一直保持
let liveSmallSince = 0;                   // 就位后体型持续过小（换成远处陪练）的起始时间
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
  liveArmed = false; liveLastSeenT = 0; livePrevV = 0; liveSmallSince = 0;
}

// 体型估算：肩中线 y → 膝中线 y 的垂直跨度（归一化）。
// 只用肩(11/12)+膝(25/26)——这两组点本就参与就位判定，不依赖鼻子/脚踝可见度。
function bodyScale(lm){
  if (!lm) return 0;
  const top = (lm[11].y + lm[12].y) / 2;
  const bot = (lm[25].y + lm[26].y) / 2;
  return Math.max(0, bot - top);
}

// 就位瞬间反馈：用户架好手机后看不到屏幕，靠声音 + 绿框知道可以开始挥拍了
function onArmed(){
  beepReady();   // Web Audio 兜底音（不受静音开关影响，一定响）
  speakStart();  // 「训练开始」语音（优先讯飞 mp3，缺失则浏览器 TTS）
  const w = $("camwrap");
  w.classList.add("armed");
  setTimeout(() => w.classList.remove("armed"), 1600);
}

// 竖屏提示：横屏画面更宽、全身入镜更稳，手机可架近一些（语音也更清晰）
function updateOrientHint(){
  const el = $("orientHint");
  if (!el) return;
  el.style.display = (window.innerHeight > window.innerWidth) ? "block" : "none";
}
window.addEventListener("resize", updateOrientHint);
window.addEventListener("orientationchange", updateOrientHint);

async function openCamera(facing){
  if (liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream = null; }
  // 横屏 16:9：横屏画面更宽、全身入镜更稳，手机可架近一些（语音也更清晰）。
  // 低端机若掉帧明显，可降为 { width:{ideal:960}, height:{ideal:540} }。
  liveStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: facing },
    audio: false });
  const cam = $("cam");
  // 前置自拍镜像显示（符合直觉），后置正常显示
  cam.style.transform = facing === "user" ? "scaleX(-1)" : "none";
  cam.srcObject = liveStream;
  await new Promise(res => { cam.onloadedmetadata = res; });
  await cam.play();
  // 尽力锁横屏（Android Chrome 生效，iOS Safari 静默失败；竖屏由 updateOrientHint 提示）
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape"); } catch(e){}
  updateOrientHint();
}

async function startLive(){
  unlockAudio();   // 必须在首次 await 之前（点击手势内）解锁，否则 iOS 自动播放会被静默拦截
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
  voiceResetSession();   // 清空上一次训练残留的组/会话统计
  liveRunning = true;
  updateOrientHint();
  $("liveStatus").textContent = "请退后站定，全身入镜后即可开始挥拍";
  requestAnimationFrame(liveLoop);
}

function stopLive(){
  liveRunning = false;
  if (liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream = null; }
  $("camwrap").style.display = "none";
  $("btnCamFlip").style.display = "none";
  $("liveStatus").textContent = "摄像头已关闭";
  // 训练后总结（非 guest 且 ≥3 拍才播；voicePlay 内部检查静音，静音则不播）
  voicePlay(voiceSessionSummary($("uid").value.trim() || "guest"));
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
    // 未就位：用 IMAGE 模式每帧重检测（选当前最显著的人，不粘先入镜的陪练）；
    // 就位后：用 VIDEO 模式追踪已锁定的正确用户，保证挥拍过程平滑。
    const res = liveArmed
      ? landmarker.detectForVideo(cam, Math.round(t*1000))
      : landmarkerImg.detect(cam);
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
    const bScale = bodyScale(lm);
    if (liveArmed){
      if (t - liveLastSeenT > LIVE.armLostSec){
        liveArmed = false; liveReadySince = 0;   // 人走了，回到首次就位流程
      } else if (bScale < LIVE.minBodyH){
        // 锁定的「人」换成了远处的小人（如对面陪练），持续超时后解除就绪重新检测
        if (!liveSmallSince) liveSmallSince = t;
        if (t - liveSmallSince > LIVE.armLostSec){
          liveArmed = false; liveReadySince = 0;
        }
      } else {
        liveSmallSince = 0;
      }
    }
    // 首次就位判定：肩髋膝六个核心点都可见、体型够大（近侧用户，排除远侧陪练）、
    // 且髋部移动速度低于阈值（站定）
    if (!liveArmed){
      let ready = false, tooSmall = false;
      if (lm && [11,12,23,24,25,26].every(i => lm[i].visibility > 0.5)){
        tooSmall = bScale < LIVE.minBodyH;
        if (!tooSmall && liveBuf.length >= 2){
          const prevLm = liveBuf[liveBuf.length-2].lm;
          if (prevLm && prevLm[23].visibility > 0.5 && prevLm[24].visibility > 0.5){
            const hx = (lm[23].x+lm[24].x)/2, hy = (lm[23].y+lm[24].y)/2;
            const px = (prevLm[23].x+prevLm[24].x)/2, py = (prevLm[23].y+prevLm[24].y)/2;
            const hv = Math.hypot(hx-px, hy-py) /
                       Math.max(1e-3, t - liveBuf[liveBuf.length-2].t);
            ready = hv < 0.3;
          }
        }
      }
      if (ready){ if (!liveReadySince) liveReadySince = t; }
      else liveReadySince = 0;
      if (liveReadySince > 0 &&
          t - liveReadySince >= LIVE.readyHoldSec &&
          t - liveStartT >= LIVE.warmupSec){
        liveArmed = true;
        onArmed();   // 就位瞬间：声音 + 绿框反馈
      }
      var readyHint = !lm ? "未检测到人体，请站入画面"
        : (tooSmall ? "请站近一些，让全身占满画面"
          : (ready ? "保持站定…" : "请退后站定，全身入镜后即可开始"));
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
  const angle = resolveAngle($("angle").value, vh.view);
  const diag = diagnose(segFrames, (vh.hand || "right"), act, bm.conf, angle);
  const ms = Math.round(performance.now() - t0);
  showResult({ r, act, tpl, mirrored, conf: bm.conf, vh,
               seg: { peakTime: (livePeakT % 3600).toFixed(2), detRate: det },
               ladder, liveMs: ms, force, diag, angle });
  voicePlay(voiceFeedback(uid, r.score, diag, ladder));   // 语音教练（默认开启，见 voice.js）
  $("liveStatus").textContent = `上一次挥拍 ${r.score} 分（${ms}ms 出分），继续挥拍可再次评分`;
}
