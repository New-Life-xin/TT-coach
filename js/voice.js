// ---------- 语音教练（预合成 mp3 播放 + 反馈决策） ----------
/* 话术已由 工具/tts_xfyun.py 用讯飞音色 x6_lingfeihao_pro 预合成到 assets/voice/，
   本模块只做两件事：① 决定每拍说什么（基于真实分数/诊断，不做随机）；② 顺序播放 mp3。

   关键约束（对话术指南/工作日志）：
   - 默认静音，用户手动开启；1.5s 冷却，新结果覆盖旧结果（旧音频立刻停止）。
   - 个人成绩历史（连续进步/破最佳/疲劳）仅对填了 uid 的用户生效——匿名分数没有
     「主人」，不能混进个人历史；guest 只播纠错话术。
   - 「连续出现」是本次训练内的状态，放内存（页面刷新即重置），不跨会话持久化。

   组间总结（每 10 拍）与训练后总结（点「停止」时）：
   - 也仅对非 guest 生效（匿名只播纠错，不播任何总结）。
   - 组内/会话统计放内存（_group/_session），跨训练由 voiceResetSession 清空。 */

const VOICE_BASE = "assets/voice/";

// 各错误的状态话术文件名（对照 工具/voice_scripts.json；improving 暂不触发）
const ERR_VOICE = {
  unstable:   { first: "err_unstable_first", rep: ["err_unstable_rep0", "err_unstable_rep1", "err_unstable_rep2"], resolved: "err_unstable_resolved" },
  arm_only:   { first: "err_arm_only_first", rep: ["err_arm_only_rep0", "err_arm_only_rep1", "err_arm_only_rep2"], resolved: "err_arm_only_resolved" },
  elbow_high: { first: "err_elbow_high_first", rep: ["err_elbow_high_rep0", "err_elbow_high_rep1", "err_elbow_high_rep2"], resolved: "err_elbow_high_resolved" },
  hand_low:   { first: "err_hand_low_first", rep: ["err_hand_low_first"], resolved: null },
};

const VOICE = {
  enabled: false,      // 默认关闭
  cooldownMs: 1500,    // 两拍之间最短间隔
  _lastSpoke: 0,
  _cur: null,          // 当前播放的 Audio（覆盖旧结果时停止）
};

// 连续错误状态（内存，页面刷新即重置）
let _lastErr = null, _errStreak = { id: null, count: 0 };

const GROUP_SIZE = 10;        // 组间总结：每 10 拍
const MIN_SESSION_SHOTS = 3;  // 训练后总结：至少 3 拍才算一次训练

// 会话统计（内存，startLive 重置，stopLive 播完清空）
function _newSession(){ return { shots:0, scores:[], errCount:{}, best:0, tierIdx:null, lastEvent:null }; }
function _newGroup(){ return { scores:[], errCount:{} }; }
let _session = _newSession();
let _group = _newGroup();
function voiceResetSession(){ _session = _newSession(); _group = _newGroup(); }

function voiceSetEnabled(on){
  VOICE.enabled = !!on;
  if (!on && VOICE._cur){ try { VOICE._cur.pause(); } catch(e){} VOICE._cur = null; }
  try { localStorage.setItem("tt_voice_enabled", on ? "1" : "0"); } catch(e){}
}
function voiceIsEnabled(){
  try { return localStorage.getItem("tt_voice_enabled") === "1"; } catch(e){ return false; }
}

// 个人成绩历史（仅非 guest，跨会话）
function voiceGetHist(uid){
  try { const raw = localStorage.getItem("tt_voice_" + uid); if (raw) return JSON.parse(raw); } catch(e){}
  return { scores: [], best: 0 };
}
function voicePutHist(uid, hist){
  try { localStorage.setItem("tt_voice_" + uid, JSON.stringify(hist)); } catch(e){}
}

// 顺序播放若干 mp3（文件名数组）；新播报会立刻覆盖旧播报
function voicePlay(ids){
  if (!VOICE.enabled || !ids || !ids.length) return;
  const now = Date.now();
  if (now - VOICE._lastSpoke < VOICE.cooldownMs) return;
  VOICE._lastSpoke = now;
  if (VOICE._cur){ try { VOICE._cur.pause(); } catch(e){} VOICE._cur = null; }
  let i = 0;
  const next = () => {
    if (i >= ids.length){ VOICE._cur = null; return; }
    // 单文件版 VOICE_B64 内嵌 base64；双文件版走 assets/voice/ 路径
    const src = (window.VOICE_B64 && window.VOICE_B64[ids[i]])
      ? "data:audio/mpeg;base64," + window.VOICE_B64[ids[i]]
      : VOICE_BASE + ids[i] + ".mp3";
    const a = new Audio(src);
    VOICE._cur = a;
    a.onended = next;
    a.onerror = next;
    i++;
    a.play().catch(next);
  };
  next();
}

// 连续错误计数：同一错误连续出现则 +1，否则重置
function _bumpStreak(errId){
  if (errId && _errStreak.id === errId) _errStreak.count++;
  else _errStreak = { id: errId, count: errId ? 1 : 0 };
}

function _round(n){ return Math.round(n); }
function _mean(arr){ return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// 出现次数最多的错误（≥2 次才算「主要短板」，1 次太偶然）
function _topFromCount(count){
  let top = null, topN = 0;
  for (const e in count) if (count[e] > topN){ topN = count[e]; top = e; }
  return top && topN >= 2 ? { id: top, n: topN } : null;
}

// 组间总结拼装（每 10 拍）：平均分 + 稳定性 + 最高频错误 + 下一组重点
function _groupSummary(){
  const avg = _round(_mean(_group.scores));
  const ids = ["grp_avg", "num_" + avg];
  const spread = Math.max(..._group.scores) - Math.min(..._group.scores);
  if (spread <= 12) ids.push("grp_stable");
  else if (spread >= 25) ids.push("grp_unstable");
  const top = _topFromCount(_group.errCount);
  if (top) ids.push("grp_weak", "err_name_" + top.id, "grp_next", "err_focus_" + top.id);
  else ids.push("grp_noerr");
  return ids;
}

// 训练后总结（点停止时）：总拍数 + 平均分 + 段位变化 + 短板 + 下次重点
function voiceSessionSummary(uid){
  const isGuest = !uid || uid === "guest";
  if (isGuest || _session.shots < MIN_SESSION_SHOTS){ voiceResetSession(); return null; }
  const ids = ["sum_total", "nump_" + Math.min(_session.shots, 100), "sum_pai",
               "sum_avg", "num_" + _round(_mean(_session.scores))];
  const ev = _session.lastEvent, ti = _session.tierIdx;
  if (ev === "promote"   && ti != null) ids.push("sum_promote",   "tier_" + ti);
  else if (ev === "placement" && ti != null) ids.push("sum_placement", "tier_" + ti);
  else if (ev === "demote" && ti != null) ids.push("sum_demote",  "tier_" + ti);
  const top = _topFromCount(_session.errCount);
  if (top) ids.push("grp_weak", "err_name_" + top.id, "grp_next", "err_focus_" + top.id);
  else ids.push("grp_noerr");
  ids.push("sum_end");
  voiceResetSession();
  return ids;
}

// 纠错反馈（所有用户，含 guest）：首要错误纠正 / 错误消失肯定
function _errFeedback(errId){
  let result = null;
  if (errId && ERR_VOICE[errId]){
    _bumpStreak(errId);
    const v = ERR_VOICE[errId];
    result = _errStreak.count === 1
      ? [v.first]
      : [v.rep[Math.min(_errStreak.count - 2, v.rep.length - 1)]];
  } else if (!errId && _lastErr && ERR_VOICE[_lastErr] && ERR_VOICE[_lastErr].resolved){
    result = [ERR_VOICE[_lastErr].resolved];
  }
  _lastErr = errId;
  return result;
}

// 反馈决策：返回要播放的文件名数组（话术指南「八·语音决策优先级」）
// 优先级：组间总结 > 疲劳 > 破最佳 > 连续进步 > 首要错误纠正 > 错误消失肯定 > 静默
function voiceFeedback(uid, score, diag, ladder){
  const isGuest = !uid || uid === "guest";
  const errId = (diag && diag.top) ? diag.top.id : null;

  if (isGuest) return _errFeedback(errId);   // 匿名：只纠错，无统计/总结

  // ---- 会话 + 组统计（非 guest）----
  _session.shots++;
  _session.scores.push(score);
  _session.best = Math.max(_session.best, score);
  if (errId) _session.errCount[errId] = (_session.errCount[errId] || 0) + 1;
  if (ladder){
    _session.tierIdx = ladder.tierIdx;
    if (ladder.event) _session.lastEvent = ladder.event;
  }
  _group.scores.push(score);
  if (errId) _group.errCount[errId] = (_group.errCount[errId] || 0) + 1;

  // ---- 个人历史（跨会话：疲劳/破最佳/连续进步）----
  const hist = voiceGetHist(uid);
  const scores = hist.scores, prevBest = hist.best;
  const firstRun = scores.length === 0;
  let decided = null;

  // 1. 明显疲劳：最近3拍都低于此前基线均值5分以上
  if (scores.length >= 3){
    const last3 = scores.slice(-3);
    const base = scores.length >= 4
      ? scores.slice(0, -3).reduce((a, b) => a + b, 0) / (scores.length - 3)
      : scores.reduce((a, b) => a + b, 0) / scores.length;
    if (last3.length === 3 && last3.every(s => s < base - 5)) decided = ["evt_fatigue"];
  }
  // 2. 打破个人最佳（首次训练不触发）
  if (!decided && !firstRun && score > prevBest && score >= 70)
    decided = ["evt_best", "num_" + Math.round(score)];
  // 3. 连续三拍进步
  if (!decided && scores.length >= 2){
    const p1 = scores[scores.length - 1], p2 = scores[scores.length - 2];
    if (p2 < p1 && p1 < score) decided = ["evt_improving", "num_" + Math.round(score)];
  }

  // 无论是否命中事件，都推进个人历史
  scores.push(score); if (scores.length > 12) scores.shift();
  hist.best = Math.max(prevBest, score);
  voicePutHist(uid, hist);

  // ---- 组间总结：满 10 拍优先于一切即时反馈 ----
  if (_group.scores.length >= GROUP_SIZE){
    const ids = _groupSummary();
    _group = _newGroup();
    _bumpStreak(errId);
    _lastErr = errId;
    return ids;
  }

  if (decided){
    _bumpStreak(errId);
    _lastErr = errId;
    return decided;
  }

  return _errFeedback(errId);
}
