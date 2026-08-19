// ---------- 发力方式（身体带动 vs 甩手臂）----------
/* 归一化近端速度 = 段内肩/髋峰值速度 / 躯干长（单位「躯干长/秒」）。
   肩/髋是「近端」关节：速度越小越接近绕稳定轴旋转（身体带动、放松高效），
   越大越「甩手臂」（近端平移大）。离线留一验证 ρ=+0.84，比形态 DTW(+0.55) 强，
   故作为独立第二维展示（主分仍为形态 DTW，此处不重定标）。 */
function jointSpeed(frames, idx){   // frames: [{t, lm}]，lm 为 MediaPipe 33 点
  const n = frames.length;
  if (n < 3) return [];
  const xs = frames.map(f => (f.lm && f.lm[idx].visibility > 0.5) ? f.lm[idx].x : NaN);
  const ys = frames.map(f => (f.lm && f.lm[idx].visibility > 0.5) ? f.lm[idx].y : NaN);
  let last = NaN;
  for (let i = 0; i < n; i++){ if (!isNaN(xs[i])) last = xs[i]; else xs[i] = last; }
  for (let i = n - 1; i >= 0; i--){ if (!isNaN(xs[i])) last = xs[i]; else xs[i] = last; }
  let lastY = NaN;
  for (let i = 0; i < n; i++){ if (!isNaN(ys[i])) lastY = ys[i]; else ys[i] = lastY; }
  for (let i = n - 1; i >= 0; i--){ if (!isNaN(ys[i])) lastY = ys[i]; else ys[i] = lastY; }
  // 中心差分速度（与 Python joint_speed 的 np.gradient 等效），dt 用真实时间戳差
  const sp = new Array(n).fill(0);
  for (let i = 0; i < n; i++){
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    const dt = (frames[i1].t - frames[i0].t) || 1e-3;
    sp[i] = Math.hypot((xs[i1] - xs[i0]) / dt, (ys[i1] - ys[i0]) / dt);
  }
  // 5 帧移动平均平滑（np.convolve mode=same 的等价）
  const sm = new Array(n).fill(0);
  for (let i = 0; i < n; i++){
    let s = 0, c = 0;
    for (let j = i - 2; j <= i + 2; j++){ if (j >= 0 && j < n){ s += sp[j]; c++; } }
    sm[i] = s / c;
  }
  return sm;
}

function bodyScale(frames){   // 躯干长中位数（双肩中点 ~ 双髋中点）
  const vals = [];
  for (const f of frames){
    const p = f.lm;
    if (!p || Math.min(p[11].visibility, p[12].visibility,
                       p[23].visibility, p[24].visibility) < 0.5) continue;
    const shx = (p[11].x + p[12].x) / 2, shy = (p[11].y + p[12].y) / 2;
    const hpx = (p[23].x + p[24].x) / 2, hpy = (p[23].y + p[24].y) / 2;
    vals.push(Math.hypot(shx - hpx, shy - hpy));
  }
  vals.sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)] : 1.0;
}

function forceFeatures(frames, hand){   // hand: 'right'|'left'（持拍手）
  const side = hand === 'left' ? { sh: 11, hip: 23 } : { sh: 12, hip: 24 };
  const shSp = jointSpeed(frames, side.sh);
  const hipSp = jointSpeed(frames, side.hip);
  const scale = bodyScale(frames);
  const shN = shSp.length ? Math.max(...shSp) / scale : 0;
  const hipN = hipSp.length ? Math.max(...hipSp) / scale : 0;
  const avg = (shN + hipN) / 2;
  const rating = avg <= 1.2 ? "身体带动充分" : avg >= 2.8 ? "偏向甩手臂" : "发力方式居中";
  return { shN, hipN, avg, rating };
}

function forceTipText(rating){
  if (rating === "身体带动充分")
    return "肩/髋近端速度低，说明主要靠转体与重心转移带动挥拍，而非甩手臂——发力方式高效。";
  if (rating === "偏向甩手臂")
    return "肩/髋近端速度偏高，提示较多靠手臂发力、身体参与不足。建议先转体、用腰腹带动，再顺势挥臂。";
  return "发力方式居中：身体与手臂均有参与，可进一步强化「先转体、再挥臂」的发力顺序。";
}
