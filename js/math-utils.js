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
                lms: seg.filter(f=>f.lm).map(f=>f.lm),
                frames: seg.map(f => ({ t: f.t, lm: f.lm })) });
    lastEnd = e;
  }
  return segs;
}
