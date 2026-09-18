// ---------- 错误诊断引擎（三层：量化偏差 → 错误类型 → 根因 → 优先级） ----------
/* 复用既有信号（jointSpeed/bodyScale 与 forceFeatures 同源），把量化偏差解释成
   「一次只说一个最关键问题」的教练诊断。第一版 4 条自动触发规则，阈值已在
   业余素材上对照人工分数校准（速度/外展角 3 条仅正手；反手归一化速度随击型差异
   巨大、外展角方向相反，暂不启用；「手过低」已按 动作×机位 分档扩到反手）：
     - 重心不稳：肩/髋归一化平移速度 > 2.0（90分<0.7，60~70分>2.0）
     - 甩手/手臂发力过猛：归一化腕速 > 6.0，仅正面/后45度机位启用（88~91分≤5.6，60~70分≥8.7；原名「只动手臂不转腰」，实抓甩手快；侧面/偏侧面投影放大且不分离，2026-09-06 起禁用）
     - 肘部抬得过高：击球瞬间肩外展角 > 70°（90分<25°，60~70分 40~108°；后45度只抓极端，轻微抬肘需正面）
     - 拍子/手过低：腕肩落差 > 0.40（反手·仅侧面拍摄，见 diagHandLowParams）；正手已禁用（机位重标后「正面」=0，无标定依据）
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
function diagHandLowParams(f){   // 「手/拍子过低」阈值按 动作×机位 分档；返回 {th,sat,label} 或 null（不诊断）
  // 2026-08-29 机位重标后「正面」=0：正手腕肩落差无标定依据 → 禁用（与 error_rules.py 同步）。
  // 反手：腕肩落差仅在「侧面」机位可靠（低0.49 vs 高0.32/中0.24）；后45度重标后不分离（低0.36 vs 高0.39）。
  //   机位由用户手动选择（resolveAngle：面部可见度判不出侧面，故反手「手过低」需手动选「侧面」）。
  if (f.action !== "反手攻球") return null;   // 正手禁用
  if (f.angle === "侧面") return { th:0.40, sat:0.55, label:"0.40" };
  return null;
}

function diagArmOnlyParams(f){   // 「甩手」阈值按机位分档（与 error_rules._arm_only_params 同步）；返回 {th,sat,label} 或 null（不诊断）
  // 2026-09-06 分机位复核：正面/后45度 好球≤4.8（阈值 6.0 安全）；侧面/偏侧面 2D 腕速被投影放大
  // 且好坏不分离（89分真实段 10.5、教练侧面 11~13，差球仅 3.8）→ 侧面族机位禁用。缺省按正面。
  if (f.action !== "正手攻球") return null;
  const ang = f.angle || "正面";
  return (ang === "正面" || ang === "后45度") ? { th:6.0, sat:8.7, label:"6.0" } : null;
}

// 机位：优先用户手动选择；「自动」时退回 analyzeViewAndHand 的面部可见度（只能判正/背面，
// 判不出「侧面」——反手「手过低」需手动选「侧面」才会触发）。
function resolveAngle(sel, view){
  if (sel && sel !== "自动") return sel;
  if (view === "back") return "后45度";
  return "正面";   // front 或 null（无法判定）都按正面；反手侧面规则需手动选
}
const DIAG_RULES = [
  { id:"unstable", name:"重心不稳（身体晃动）", severity:"高", sev:3, ease:1,
    applies_to:["正手攻球"],
    upstream:[], downstream:["arm_only"],
    cond: f => (f.shoulder_norm!=null && f.shoulder_norm>2.0) ||
               (f.hip_norm!=null && f.hip_norm>2.0),
    conf: f => diagConf(diagMax(f.shoulder_norm, f.hip_norm), 2.0, 2.8),
    ev: f => ({ 肩速:f.shoulder_norm, 髋速:f.hip_norm, 目标:"≤2.0" }),
    coach_phrase:"重心稳住：击球前重心回到后腿，蹬地转髋把重心前移到前腿，绕中轴转，别左右乱晃",
    drill:"徒手体会重心转移：后腿蹬地→转髋→重心前移 20 次，对镜看重心是否左右晃",
    verify:"肩/髋归一化速度降到 2.0 以下" },
  { id:"arm_only", name:"甩手/手臂发力过猛", severity:"高", sev:3, ease:2,  // 原名「只动手臂不转腰」，实抓甩手快；不转腰由转髋/转肩候选承载
    applies_to:["正手攻球"],
    upstream:["unstable"], downstream:[],
    // 2026-09-06 起按机位分档（diagArmOnlyParams）：侧面/偏侧面好球会被投影放大误报，仅正面/后45度启用
    cond: f => { const p = diagArmOnlyParams(f); return f.wrist_norm!=null && p!=null && f.wrist_norm>p.th; },
    conf: f => { const p = diagArmOnlyParams(f); return p ? diagConf(f.wrist_norm, p.th, p.sat) : 0; },
    ev: f => ({ 腕速:f.wrist_norm, 目标:"≤6.0" }),
    coach_phrase:"别甩手腕。发力要由下往上：先蹬地转髋、再转腰转肩，最后手臂顺势挥出，别单靠手",
    drill:"分解发力链 20 次：蹬地→转髋→转肩→挥臂，体会力量从腿上传到拍子；再慢速挥拍压住腕速",
    verify:"归一化腕速降到 6.0 以下" },
  { id:"elbow_high", name:"肘部抬得过高", severity:"中", sev:2, ease:2,
    applies_to:["正手攻球"],
    upstream:[], downstream:[],
    cond: f => f.abduct_hit!=null && f.abduct_hit>70.0,
    conf: f => diagConf(f.abduct_hit, 70.0, 95.0),
    ev: f => ({ 击球肩外展角:f.abduct_hit, 目标:"≤60°" }),
    coach_phrase:"大臂放松下沉，肘部别超过肩线",
    drill:"夹球挥拍 20 次（腋下夹一张纸不掉）",
    verify:"击球时肩外展角降到 60° 以下" },
  { id:"hand_low", name:"拍子/手过低", severity:"高", sev:3, ease:1,
    applies_to:["正手攻球","反手攻球"],
    upstream:[], downstream:["late_contact"],
    cond: f => { const p = diagHandLowParams(f); return f.wrist_drop!=null && p!=null && f.wrist_drop>p.th; },
    conf: f => { const p = diagHandLowParams(f); return diagConf(f.wrist_drop, p.th, p.sat); },
    ev: f => { const p = diagHandLowParams(f); return { 腕肩落差:f.wrist_drop, 目标:`≤${p.label}×躯干长` }; },
    coach_phrase:"把手腕抬起来，拍子别垂到胯边，保持拍面朝前",
    drill:"对镜摆准备姿势，手腕抬到肩下定型 15 次 + 挥拍保持手位 20 次",
    verify:"引拍时腕肩落差降到标准以内" },
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
  // 腕肩落差：击球前(引拍)阶段持拍侧腕相对肩的垂直落差 / bodyScale，度量「手/拍子过低」。
  // JS 无七阶段切分，用腕速峰值之前的帧近似引拍（Python 用 phases["引拍"]）；阈值已校准。
  let wrist_drop = null;
  if (wrSp.length){
    let hi = 0;
    for (let i = 1; i < wrSp.length; i++) if (wrSp[i] > wrSp[hi]) hi = i;
    const drops = [];
    for (let i = 0; i < hi; i++){
      const lm = frames[i].lm;
      if (lm && lm[side.sh] && lm[side.wr] &&
          lm[side.sh].visibility > 0.5 && lm[side.wr].visibility > 0.5){
        drops.push((lm[side.wr].y - lm[side.sh].y) / scale);
      }
    }
    if (drops.length){ drops.sort((a,b)=>a-b); wrist_drop = drops[Math.floor(drops.length/2)]; }
  }
  // 持拍侧腕可见率（数据质量门控：腕不可见时发力链类信号不可靠）
  const wrist_vis = frames.length ? frames.reduce((n, f) =>
    n + (f.lm && f.lm[side.wr] && f.lm[side.wr].visibility > 0.5 ? 1 : 0), 0) / frames.length : 0;
  return { wrist_norm, shoulder_norm, hip_norm, abduct_hit, wrist_drop, wrist_vis };
}

function diagnose(frames, hand, act, conf, angle){
  const f = diagFeatures(frames, hand);
  if (f.wrist_vis < 0.3) return { skip:true, reason:"暂时无法判断：持拍侧手臂未入镜。建议从持拍侧正面近景拍摄，让挥拍手臂完整入镜", features:f };
  // 非挥拍段守卫（与 error_diagnosis._is_non_swing 同步）：肩/髋同时爆炸（>4.0 躯干长/秒）物理上不可能是挥拍，
  // 是分割器误检的走动/捡球段（实测 5.8~24.1），跳过以防「好球被误判甩手/重心不稳」。
  if (Math.max(f.shoulder_norm ?? 0, f.hip_norm ?? 0) > 4.0)
    return { skip:true, reason:"本段疑似非挥拍动作（走动/捡球等），已跳过诊断", features:f };
  // 反手分档：仅「侧面」机位可诊断「手过低」（腕肩落差在侧面视角才可靠，与 error_rules._hand_low_params 同步）。
  // 不根据低置信度把已识别为反手的动作改按正手规则诊断；这会掩盖识别不确定性，
  // 也会令界面中的动作类别与建议依据相互矛盾。
  const isBackhand = (act === "反手攻球");
  if (isBackhand && angle !== "侧面")
    return { skip:true, reason:"反手动作仅在侧面机位可做可靠诊断；当前识别置信度不足时请提交复核或从侧面重新拍摄", features:f };
  const effAct = act;
  f.action = effAct;
  f.angle = angle;   // 正手也需要机位：甩手规则已按机位分档（2026-09-06）
  const triggered = [];
  for (const r of DIAG_RULES){
    if (!r.applies_to.includes(effAct)) continue;
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
