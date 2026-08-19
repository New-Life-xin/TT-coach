// ---------- 错误诊断引擎（三层：量化偏差 → 错误类型 → 根因 → 优先级） ----------
/* 复用既有信号（jointSpeed/bodyScale 与 forceFeatures 同源），把量化偏差解释成
   「一次只说一个最关键问题」的教练诊断。第一版 3 条自动触发规则，阈值已在
   24 个业余素材上对照人工分数校准（**仅正手**；反手归一化速度随击型差异巨大，
   直接跳过）：
     - 重心不稳：肩/髋归一化平移速度 > 2.0（90分<0.7，60~70分>2.0）
     - 只动手臂不转腰：归一化腕速 > 6.0（88~91分≤5.6，60~70分≥8.7）
     - 肘部抬起：击球瞬间肩外展角 > 70°（90分<25°，60~70分 40~108°）
   规则表为纯数据数组，球拍/球追踪上线后按同结构增补即可。
   置信度（指南「四·六」）：conf=0.70+0.30×min((信号−阈值)/(饱和值−阈值),1)
     ≥0.85 明确 / 0.70~0.85 可能 / <0.70 不输出。 */
function diagMax(...vals){ const v = vals.filter(x => x != null); return v.length ? Math.max(...v) : null; }
function diagConf(signal, th, sat){   // 距阈值距离 → 置信度 0.70~1.0
  if (signal == null || sat <= th) return 0;
  const r = (signal - th) / (sat - th);
  return Math.round((0.70 + 0.30 * Math.min(Math.max(r, 0), 1)) * 100) / 100;
}
function diagConfLabel(c){
  if (c == null) return "未知";
  if (c >= 0.85) return "明确";
  if (c >= 0.70) return "可能";
  return "低";
}
const DIAG_RULES = [
  { id:"unstable", name:"重心不稳（身体晃动）", severity:"高", sev:3, ease:1,
    upstream:[], downstream:["arm_only"],
    cond: f => (f.shoulder_norm!=null && f.shoulder_norm>2.0) ||
               (f.hip_norm!=null && f.hip_norm>2.0),
    conf: f => diagConf(diagMax(f.shoulder_norm, f.hip_norm), 2.0, 2.8),
    ev: f => ({ 肩速:f.shoulder_norm, 髋速:f.hip_norm, 目标:"≤2.0" }),
    coach_phrase:"重心稳住，绕着身体中轴转，别左右乱晃",
    drill:"徒手转体挥拍 20 次，体会绕轴旋转；对镜看重心是否晃动",
    verify:"肩/髋归一化速度降到 2.0 以下" },
  { id:"arm_only", name:"只动手臂不转腰", severity:"高", sev:3, ease:2,
    upstream:["unstable"], downstream:[],
    cond: f => f.wrist_norm!=null && f.wrist_norm>6.0,
    conf: f => diagConf(f.wrist_norm, 6.0, 8.7),
    ev: f => ({ 腕速:f.wrist_norm, 目标:"≤6.0" }),
    coach_phrase:"先转腰再出手，用身体带着手臂走，别单靠手腕甩",
    drill:"徒手转腰带动挥拍 20 次，体会腰先于手",
    verify:"归一化腕速降到 6.0 以下" },
  { id:"elbow_high", name:"肘部抬起", severity:"中", sev:2, ease:2,
    upstream:[], downstream:[],
    cond: f => f.abduct_hit!=null && f.abduct_hit>70.0,
    conf: f => diagConf(f.abduct_hit, 70.0, 95.0),
    ev: f => ({ 击球肩外展角:f.abduct_hit, 目标:"≤60°" }),
    coach_phrase:"大臂放松下沉，肘部别超过肩线",
    drill:"夹球挥拍 20 次（腋下夹一张纸不掉）",
    verify:"击球时肩外展角降到 60° 以下" },
];

function abductionAngle(lm, side){   // 肩外展角：髋-肩-肘（顶点肩）
  const hip = lm[side.hip], sh = lm[side.sh], el = lm[side.el];
  if (Math.min(hip.visibility, sh.visibility, el.visibility) < 0.5) return null;
  return angle2D(hip, sh, el);
}

function diagFeatures(frames, hand){
  const side = hand === 'left' ? { sh:11, hip:23, el:13, wr:15 }
                               : { sh:12, hip:24, el:14, wr:16 };
  const scale = bodyScale(frames);
  const wrSp = jointSpeed(frames, side.wr);
  const shSp = jointSpeed(frames, side.sh);
  const hipSp = jointSpeed(frames, side.hip);
  const wrist_norm = wrSp.length ? Math.max(...wrSp) / scale : null;
  const shoulder_norm = shSp.length ? Math.max(...shSp) / scale : null;
  const hip_norm = hipSp.length ? Math.max(...hipSp) / scale : null;
  // 击球瞬间肩外展角：腕速峰值帧附近的中位数（近似 Python 击球阶段均值）
  let abduct_hit = null;
  if (wrSp.length){
    let hi = 0;
    for (let i = 1; i < wrSp.length; i++) if (wrSp[i] > wrSp[hi]) hi = i;
    const vals = [];
    for (let i = Math.max(0, hi-1); i <= Math.min(frames.length-1, hi+2); i++){
      if (frames[i].lm){ const a = abductionAngle(frames[i].lm, side); if (a != null) vals.push(a); }
    }
    if (vals.length){ vals.sort((a,b)=>a-b); abduct_hit = vals[Math.floor(vals.length/2)]; }
  }
  // 持拍侧腕可见率（数据质量门控：腕不可见时发力链类信号不可靠）
  const wrist_vis = frames.length ? frames.reduce((n, f) =>
    n + (f.lm && f.lm[side.wr] && f.lm[side.wr].visibility > 0.5 ? 1 : 0), 0) / frames.length : 0;
  return { wrist_norm, shoulder_norm, hip_norm, abduct_hit, wrist_vis };
}

function diagnose(frames, hand, act){
  if (act === "反手攻球") return { skip:true, reason:"反手暂不支持诊断（反手速度信号随击型差异大，待专项定标）" };
  const f = diagFeatures(frames, hand);
  if (f.wrist_vis < 0.3) return { skip:true, reason:"暂时无法判断：持拍侧手臂未入镜。建议从持拍侧正面近景拍摄，让挥拍手臂完整入镜", features:f };
  const triggered = [];
  for (const r of DIAG_RULES){
    try {
      if (!r.cond(f)) continue;
      const confidence = r.conf ? r.conf(f) : 0;
      if (confidence < 0.70) continue;   // 指南「四·六」：<0.70 不输出
      triggered.push({
        id:r.id, name:r.name, severity:r.severity, sev:r.sev, ease:r.ease,
        confidence, confidence_label: diagConfLabel(confidence),
        evidence:r.ev(f), coach_phrase:r.coach_phrase, drill:r.drill, verify:r.verify,
        upstream:r.upstream, downstream:r.downstream });
    }
    catch(e) {}
  }
  if (!triggered.length) return { skip:false, top:null, features:f, ranked:[], chain:[] };
  // 根因 = 触发项中没有上游触发的那个；多根因取严重度最高
  const ids = new Set(triggered.map(t=>t.id));
  let roots = triggered.filter(t => !t.upstream.some(u => ids.has(u)));
  if (!roots.length) roots = triggered.slice();
  roots.sort((a,b) => (b.sev - a.sev) || (b.confidence - a.confidence) || (a.ease - b.ease));
  const root = roots[0];
  // 因果链：沿 downstream 找触发的下游
  const chain = [root.name], seen = new Set([root.id]);
  let cur = root;
  while (cur.downstream.length){
    const nxtId = cur.downstream.find(d => ids.has(d) && !seen.has(d));
    if (!nxtId) break;
    cur = triggered.find(t => t.id === nxtId);
    chain.push(cur.name); seen.add(nxtId);
  }
  // 优先级：根因优先 → 严重度高 → 置信度高 → 易改善（指南「四·七」）
  const ranked = triggered.slice().sort((a,b) =>
    ((a.id===root.id?0:1) - (b.id===root.id?0:1)) || (b.sev - a.sev) ||
    (b.confidence - a.confidence) || (a.ease - b.ease));
  return { skip:false, top: root, features:f, ranked, chain };
}
