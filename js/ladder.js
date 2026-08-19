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
