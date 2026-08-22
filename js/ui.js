// ---------- 结果展示（上传 / 实时共用） ----------
function showResult({ r, act, tpl, mirrored, seg, ladder, liveMs, conf, vh, force, diag }){
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
  $("feedback").textContent = generateFeedback(r);
  // 发力方式维度（身体带动 vs 甩手臂）：独立第二维，主分不变
  const fb = $("forcebox");
  if (force && (force.shN > 0 || force.hipN > 0 || force.wrN > 0)){
    fb.style.display = "block";
    $("forceGrade").textContent = force.rating;
    $("forceSh").textContent = force.shN.toFixed(2) + " 躯干长/秒";
    $("forceHip").textContent = force.hipN.toFixed(2) + " 躯干长/秒";
    $("forceWr").textContent = force.wrN.toFixed(2) + " 躯干长/秒";
    $("forceShBar").style.width = Math.min(100, force.shN / 3 * 100) + "%";
    $("forceHipBar").style.width = Math.min(100, force.hipN / 3 * 100) + "%";
    $("forceWrBar").style.width = Math.min(100, force.wrN / 8.7 * 100) + "%";
    let tip = forceTipText(force.rating, force);
    if (act === "反手攻球") tip += "（反手标定样本较少，此评级以正手数据为参考。）";
    $("forceTip").textContent = tip;
  } else {
    fb.style.display = "none";
  }
  // 错误诊断：一次只说一个最关键问题（反手 / 无触发 / 帧不足时隐藏）
  const db = $("diagbox");
  const dOk = diag && !diag.skip && diag.top;
  const dSkip = diag && diag.skip;
  db.style.display = (dOk || dSkip) ? "block" : "none";
  if (dOk){
    const g = $("diagGrade");
    const c = diag.top.confidence;
    g.textContent = `${diag.top.severity} · ${diag.top.name}` +
      (c != null ? `（置信度${c.toFixed(2)}·${diag.top.confidence_label}）` : "");
    g.className = "diag-grade" + (diag.top.severity === "中" ? " sev-mid" : "");
    $("diagChain").innerHTML = diag.chain.length > 1
      ? "根因链：" + diag.chain.map((n,i)=> i===0?`<b>${n}</b>`:n).join(" → ")
      : "";
    $("diagEvidence").textContent = "依据：" + Object.entries(diag.top.evidence)
      .filter(([,v]) => v != null)
      .map(([k,v]) => typeof v === "number" && isFinite(v) ? `${k}=${v.toFixed(1)}` : `${k}=${v}`)
      .join("　");
    $("diagTip").textContent = "教练提示：" + diag.top.coach_phrase;
    $("diagDrill").textContent = "专项练习：" + diag.top.drill;
    $("diagVerify").textContent = "达标标准：" + diag.top.verify;
    const det = $("diagRanked");
    if (diag.ranked.length > 1){
      det.parentElement.style.display = "block";
      $("diagCount").textContent = diag.ranked.length;
      det.innerHTML = diag.ranked.map((t,i)=>
        `<li>${i===0?"<b>（首要）</b>":""}${t.name}（${t.severity}·${t.confidence_label}）：${t.coach_phrase}</li>`).join("");
    } else {
      det.parentElement.style.display = "none";
    }
  } else if (dSkip){
    // 数据质量 / 动作类型不支持：输出「暂时无法判断」而非硬判（指南「四·一」）
    const g = $("diagGrade");
    g.textContent = diag.reason || "暂时无法判断";
    g.className = "diag-grade skip";
    $("diagChain").innerHTML = "";
    $("diagEvidence").textContent = "";
    $("diagTip").textContent = diag.reason === "反手暂不支持诊断"
      ? "第一版诊断仅覆盖正手攻球，反手击球暂不输出诊断结论。"
      : "证据不足时系统不输出错误结论，请正面拍摄、持拍侧入镜、相机保持稳定后重试。";
    $("diagDrill").textContent = "";
    $("diagVerify").textContent = "";
    $("diagRanked").parentElement.style.display = "none";
  }
  $("stage").textContent = "训练阶段 · " + ladder.tier +
    (ladder.sessions<=PLACEMENT?`（初始评估 ${ladder.sessions}/${PLACEMENT}）`:"");
  $("lp").textContent = "阶段进度 " + ladder.lp + "%";
  $("lpbar").style.width = ladder.lp + "%";
  $("coaching").textContent = ladder.coaching;
  $("coachbox").style.display = "block";
  $("result").style.display = "block";
  $("result").classList.remove("show"); void $("result").offsetWidth; $("result").classList.add("show");
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
function show(){ if(file.files[0]){ $("fname").textContent=file.files[0].name; btn.disabled=false; } }

btn.onclick = async ()=>{
  btn.disabled = true;
  $("err").style.display="none"; $("result").style.display="none"; $("coachbox").style.display="none";
  const uid = $("uid").value.trim() || "guest";
  try {
    const out = await runUpload(file.files[0], $("action").value, uid);
    showResult(out);
    setStatus("完成");
  } catch(e){
    console.error(e);
    const el = $("err");
    el.textContent = (e.message || e);
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
    el.textContent = "摄像头启动失败：" + (e.message || e) +
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

// ---------- 语音教练开关（默认关，记忆用户选择） ----------
$("btnVoice").onclick = () => {
  voiceSetEnabled(!VOICE.enabled);
  $("btnVoice").textContent = VOICE.enabled ? "🔊 语音开" : "🔇 语音关";
};
if (voiceIsEnabled()) VOICE.enabled = true;
$("btnVoice").textContent = VOICE.enabled ? "🔊 语音开" : "🔇 语音关";
