// ---------- 球拍/球检测（YOLOv8 ONNX + onnxruntime-web）----------
/* 升级项「球拍与乒乓球追踪」第一阶段：可视化验证。
   本模块只负责检测并画框，不改评分逻辑（待真实视频验证模型效果后再整合评分）。

   模型：RacketVision（转播画面）训练的 YOLOv8-nano，2 类：
     0 = ball（球）  1 = tabletennis_racket（球拍）
   输出 [1, 4+nc, 8400]：前 4 通道是已 decode 的 cx,cy,w,h（640 空间绝对坐标），
   后 nc 通道是类别 logits（需 sigmoid）。运行时走 onnxruntime-web CDN，
   模型优先同源 assets/weights_best.onnx，失败回退 jsDelivr（file:// 单文件版）。 */

const DET = {
  imgsz: 640,           // 模型输入分辨率（训练时用 640）
  confThresh: 0.35,     // 置信度阈值
  iouThresh: 0.45,      // NMS IoU 阈值
  freq: 3,              // 实时模式降频：每 N 帧跑一次检测（球拍/球位置变化不快）
};
const DET_NAMES = { 0: "球", 1: "球拍" };
const DET_COLORS = { 0: "#ff5252", 1: "#00e676" };   // 球=红，拍=绿

let detSession = null, detInputName = null, detOutputName = null;
let detInitTried = false;                 // 失败过一次就不再重试（避免每帧重试拖慢）
let detPreCv = null, detPreCtx = null;    // letterbox 预处理离屏 canvas

async function initDetector(){
  if (detSession) return;
  if (detInitTried) return;
  detInitTried = true;
  try {
    if (!window.ort) {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js";
        s.onload = res;
        s.onerror = () => rej(new Error("onnxruntime-web 加载失败"));
        document.head.appendChild(s);
      });
    }
    const ort = window.ort;
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
    // 模型：优先同源 assets（GitHub Pages/本地服务器），失败回退 jsDelivr（file:// 单文件版）
    const urls = [
      "assets/weights_best.onnx",
      "https://cdn.jsdelivr.net/gh/New-Life-xin/TT-coach@latest/assets/weights_best.onnx",
    ];
    let session = null, lastErr = null;
    for (const u of urls) {
      try {
        session = await ort.InferenceSession.create(u, { executionProviders: ["wasm"] });
        break;
      } catch (e) { lastErr = e; }
    }
    if (!session) throw lastErr || new Error("模型加载失败");
    detSession = session;
    detInputName = session.inputNames[0];
    detOutputName = session.outputNames[0];
    detPreCv = document.createElement("canvas");
    detPreCv.width = detPreCv.height = DET.imgsz;
    detPreCtx = detPreCv.getContext("2d", { willReadFrequently: true });
    console.log("球拍/球检测就绪（onnxruntime-web）");
  } catch (e) {
    console.warn("球拍/球检测不可用（不影响评分）：", e);
    detSession = null;
  }
}

// 把检测框画到 canvas（dets 为归一化 [0,1] 坐标；mirror 用于前置镜头镜像）
function drawDetections(ctx, dets, w, h, mirror){
  for (const d of dets){
    const x = mirror ? 1 - d.x - d.w : d.x;
    ctx.strokeStyle = DET_COLORS[d.cls];
    ctx.lineWidth = Math.max(2, w / 320);
    ctx.strokeRect(x * w, d.y * h, d.w * w, d.h * h);
    ctx.fillStyle = DET_COLORS[d.cls];
    const fs = Math.max(11, w / 45);
    ctx.font = `${fs}px sans-serif`;
    const label = `${DET_NAMES[d.cls]} ${Math.round(d.conf * 100)}%`;
    const tw = ctx.measureText(label).width;
    const ly = d.y * h - fs - 4;
    ctx.fillRect(x * w, ly > 0 ? ly : d.y * h, tw + 8, fs + 4);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x * w + 4, (ly > 0 ? ly : d.y * h) + fs);
  }
}

// 主入口：对 video 跑检测，返回归一化 [0,1] 框数组 [{cls,x,y,w,h,conf}]
async function detectFrame(video){
  if (!detSession && !detInitTried) await initDetector();
  if (!detSession) return [];
  const sw = video.videoWidth || video.width;
  const sh = video.videoHeight || video.height;
  if (!sw || !sh) return [];

  // letterbox：保持宽高比缩到 640，灰色填充（114,114,114）
  const scale = Math.min(DET.imgsz / sw, DET.imgsz / sh);
  const dw = sw * scale, dh = sh * scale;
  const padX = (DET.imgsz - dw) / 2, padY = (DET.imgsz - dh) / 2;
  detPreCtx.fillStyle = "#727272";
  detPreCtx.fillRect(0, 0, DET.imgsz, DET.imgsz);
  detPreCtx.drawImage(video, padX, padY, dw, dh);
  const img = detPreCtx.getImageData(0, 0, DET.imgsz, DET.imgsz).data;

  // RGB → NCHW float32，归一化 /255
  const n = DET.imgsz * DET.imgsz;
  const data = new Float32Array(3 * n);
  for (let i = 0, p = 0; i < n; i++, p += 4){
    data[i]       = img[p] / 255;      // R
    data[i + n]   = img[p + 1] / 255;  // G
    data[i + 2*n] = img[p + 2] / 255;  // B
  }

  const ort = window.ort;
  const feeds = { [detInputName]: new ort.Tensor("float32", data, [1, 3, DET.imgsz, DET.imgsz]) };
  const out = await detSession.run(feeds);
  const t = out[detOutputName];           // [1, 4+nc, 8400]
  const channels = t.dims[1], anchors = t.dims[2];
  const nc = channels - 4;
  const raw = t.data;                     // 行主序：raw[a + channel*anchors]

  // decode：类别已是 sigmoid 概率（ultralytics 导出时 cls.sigmoid()），取 max 即可；
  // box 已是 640 空间绝对坐标，映射回原图
  const boxes = [];
  for (let a = 0; a < anchors; a++){
    let bestCls = -1, bestConf = -Infinity;
    for (let c = 0; c < nc; c++){
      const v = raw[a + (4 + c) * anchors];
      if (v > bestConf){ bestConf = v; bestCls = c; }
    }
    const conf = bestConf;   // 直接是概率，无需再 sigmoid
    if (conf < DET.confThresh) continue;
    const cx = raw[a], cy = raw[a + anchors];
    const w = raw[a + 2*anchors], h = raw[a + 3*anchors];
    const x = (cx - w/2 - padX) / scale;
    const y = (cy - h/2 - padY) / scale;
    boxes.push({ cls: bestCls, x: x/sw, y: y/sh, w: w/scale/sw, h: h/scale/sh, conf });
  }
  return nms(boxes, DET.iouThresh);
}

function iou(a, b){
  const ax1 = a.x, ay1 = a.y, ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx1 = b.x, by1 = b.y, bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const inter = ix * iy, uni = a.w*a.h + b.w*b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
function nms(boxes, th){
  boxes.sort((a, b) => b.conf - a.conf);
  const keep = [];
  while (boxes.length){
    const a = boxes.shift();
    keep.push(a);
    boxes = boxes.filter(b => iou(a, b) < th);
  }
  return keep;
}
