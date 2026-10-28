// ---------- 语音教练（预合成 mp3 播放 + 反馈决策） ----------
/* 2026-10-17 起：语音只做纠错这一条线（指出问题 → 改善就表扬 → 问题消失肯定一次）。
   模板相似度分数与教练评分不相关，所有依赖它的播报（个人最佳、连续进步、平均分、段位升降、
   按分数判断的疲劳提醒）一律不播；「是否改善」只看诊断指标（错误置信度）是否下降。
   相应的 mp3 仍保留在 assets/voice/，不再被调用。

   话术已由 工具/tts_xfyun.py 用讯飞音色 x6_lingfeihao_pro 预合成到 assets/voice/，
   本模块只做两件事：① 决定每拍说什么（基于真实分数/诊断，不做随机）；② 顺序播放 mp3。

   关键约束（对话术指南/工作日志）：
   - 默认开启（2026-09-17 起，保证一定有语音），可手动静音；1.5s 冷却，新结果覆盖旧结果（旧音频立刻停止）。
   - 个人成绩历史（连续进步/破最佳/疲劳）仅对填了 uid 的用户生效——匿名分数没有
     「主人」，不能混进个人历史；guest 只播纠错话术。
   - 「连续出现」是本次训练内的状态，放内存（页面刷新即重置），不跨会话持久化。
   - 纠错节奏（2026-09-10 起）像真实教练：有问题直接指出 → 下一拍改善就表扬
     （improving 话术）→ 错误消失表扬一次后、持续良好即静默；同一错误无改善时
     每 2 拍才重复纠正一次，避免每拍唠叨。

   组间总结（每 GROUP_SIZE 拍）与训练后总结（点「停止」时）：
   - 2026-10-26 起对所有用户（含 guest）生效：只报拍数与反复出现的问题，不涉及个人成绩历史。
   - 「一定出声」（2026-10-26，答辩前）：组间总结在没有反复出现的问题时也播一句
     「这一组没发现明显问题」（不说「动作很好」——规则只覆盖少数问题，没检出≠没问题）；
     连续 SILENT_MAX 拍没出声时补一句简短的「继续」，避免练很久听不到任何声音。
   - 新增话术若 mp3 尚未合成，自动用浏览器 TTS 读 VOICE_TEXT 里的文字兜底。
   - 组内/会话统计放内存（_group/_session），跨训练由 voiceResetSession 清空。 */

const VOICE_BASE = "assets/voice/";

// 新增话术的文字（mp3 未合成或加载失败时用浏览器 TTS 兜底；合成：工具/tts_xfyun.py --only=grp_c）
const VOICE_TEXT = {
  grp_clean: "这一组没发现明显问题，继续保持。",
  grp_clean_short: "继续，保持节奏。",
};

// 各错误的状态话术文件名（对照 工具/voice_scripts.json）
// improving = 「已有改善」话术（2026-09-10 起启用：改善就表扬，像真实教练）；
// hand_low 仅反手·侧面机位触发、样本少，未合改善/消失话术，improving/resolved 置 null。
const ERR_VOICE = {
  unstable:   { first: "err_unstable_first", rep: ["err_unstable_rep0", "err_unstable_rep1", "err_unstable_rep2"], improving: "err_unstable_improving", resolved: "err_unstable_resolved" },
  arm_only:   { first: "err_arm_only_first", rep: ["err_arm_only_rep0", "err_arm_only_rep1", "err_arm_only_rep2"], improving: "err_arm_only_improving", resolved: "err_arm_only_resolved" },
  elbow_high: { first: "err_elbow_high_first", rep: ["err_elbow_high_rep0", "err_elbow_high_rep1", "err_elbow_high_rep2"], improving: "err_elbow_high_improving", resolved: "err_elbow_high_resolved" },
  hand_low:   { first: "err_hand_low_first", rep: ["err_hand_low_first"], improving: null, resolved: null },
};

const VOICE = {
  enabled: true,       // 默认开启（2026-09-17 起；保证一定有语音，可手动静音）
  cooldownMs: 1500,    // 两拍之间最短间隔
  _lastSpoke: 0,
  _cur: null,          // 当前播放的 Audio（覆盖旧结果时停止）
};

// 连续错误状态（内存，页面刷新即重置）
// 教练状态机：有问题直接指出 → 下一拍改善就表扬 → 之后良好则静默（像真实教练，不每拍唠叨）
let _lastErr = null, _errStreak = { id: null, count: 0 };
let _errLastScore = 0, _errLastConf = 0, _errQuiet = 0;   // 改善判定 + 防唠叨节流

const IMPROVE_SCORE = 5;    // 分数较上一拍提升 ≥5 分视为「改善」
const IMPROVE_CONF  = 0.10; // 或错误置信度下降 ≥0.10 视为「改善」（错误指标向达标靠拢）
const REP_EVERY = 2;        // 同一错误无改善时，每 2 拍才重复纠正一次，其余静默

const GROUP_SIZE = 6;         // 组间总结：每 6 拍（2026-10-26 由 10 改 6，学员一组多拍不到 10 拍）
const SILENT_MAX = 4;         // 连续 4 拍没出声 → 补一句「继续」
const MIN_SESSION_SHOTS = 3;  // 训练后总结：至少 3 拍才算一次训练

// 会话统计（内存，startLive 重置，stopLive 播完清空）
function _newSession(){ return { shots:0, scores:[], errCount:{}, best:0, tierIdx:null, lastEvent:null }; }
function _newGroup(){ return { scores:[], errCount:{} }; }
let _session = _newSession();
let _group = _newGroup();
let _silent = 0;   // 连续没出声的拍数
function voiceResetSession(){ _session = _newSession(); _group = _newGroup(); _silent = 0; }

function voiceSetEnabled(on){
  VOICE.enabled = !!on;
  if (!on && VOICE._cur){ try { VOICE._cur.pause(); } catch(e){} VOICE._cur = null; }
  try { localStorage.setItem("tt_voice_enabled", on ? "1" : "0"); } catch(e){}
}
function voiceIsEnabled(){
  try { return localStorage.getItem("tt_voice_enabled") !== "0"; } catch(e){ return true; }
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
    a.volume = 1.0;
    a.onended = next;
    const id = ids[i];
    a.onerror = () => { if (VOICE_TEXT[id]) _ttsSay(VOICE_TEXT[id], next); else next(); };
    i++;
    a.play().catch(() => {
      // 自动播放策略可能拦截：先解锁音频再重试一次，仍失败才跳过下一条
      unlockAudio().then(() => a.play().catch(next));
    });
  };
  next();
}

// 浏览器 TTS 兜底（不少微信内置浏览器没有中文语音包，可能无声；正式话术仍以 mp3 为准）
function _ttsSay(text, done){
  try {
    if (!window.speechSynthesis){ done && done(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN"; u.rate = 0.95; u.volume = 1;
    let fired = false; const fin = () => { if (!fired){ fired = true; done && done(); } };
    u.onend = fin; u.onerror = fin; setTimeout(fin, 4000);
    speechSynthesis.speak(u);
  } catch(e){ done && done(); }
}

// 预先下载常用话术（双文件版）：每段 mp3 第一次播放要先从服务器下载，实测 0.3–2.3 秒，
// 会让纠错语音明显落后于动作。开启摄像头时把开场与四类纠错话术（约 0.4MB）先下到浏览器缓存。
let _voiceWarmed = false;
function voiceWarm(){
  if (_voiceWarmed || window.VOICE_B64) return;
  _voiceWarmed = true;
  if (navigator.connection && navigator.connection.saveData) return;   // 省流量模式不预下载
  const ids = ["evt_start", "grp_clean", "grp_clean_short", "grp_weak", "grp_next"];
  for (const e in ERR_VOICE){
    const v = ERR_VOICE[e];
    [v.first, ...v.rep, v.improving, v.resolved].forEach(x => { if (x && ids.indexOf(x) < 0) ids.push(x); });
  }
  ids.forEach(id => { try { fetch(VOICE_BASE + id + ".mp3").catch(() => {}); } catch(e){} });
}

// 音频解锁：在用户手势（点击开启摄像头/切换语音）时建 AudioContext 并 resume，
// 顺带播 1 帧静音，解锁后续 Web Audio 与 HTMLAudio 的自动播放限制。
let _audioCtx = null;
async function unlockAudio(){
  voiceWarm();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _audioCtx = _audioCtx || new AC();
    if (_audioCtx.state === "suspended") await _audioCtx.resume();
    const buf = _audioCtx.createBuffer(1, 1, 22050);
    const src = _audioCtx.createBufferSource(); src.buffer = buf;
    src.connect(_audioCtx.destination); src.start(0);
  } catch(e){}
  // 顺带激活 speechSynthesis（iOS 需在用户手势内首次 speak，否则稍后 TTS 可能被静默）
  try {
    if (window.speechSynthesis){
      const u = new SpeechSynthesisUtterance(""); u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch(e){}
}

// 就位提示音（Web Audio 合成，不受「语音教练」静音开关影响）：短促上扬双音
function beepReady(){
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _audioCtx = _audioCtx || new AC();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const t0 = _audioCtx.currentTime;
    [[880, 0], [1320, 0.12]].forEach(([f, dt]) => {
      const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
      o.connect(g); g.connect(_audioCtx.destination);
      o.start(t0 + dt); o.stop(t0 + dt + 0.25);
    });
  } catch(e){}
}

// 就位语音「训练开始」：优先讯飞 mp3（若已加入 VOICE_B64），否则浏览器 TTS 兜底。
// 跟语音开关走；静音时 beepReady 仍作为「一定有声音」的兜底音。
function speakStart(){
  if (!VOICE.enabled) return;
  // 讯飞 mp3 两个版本都有（单文件版内嵌、双文件版在 assets/voice/）；浏览器 TTS 只作兜底：
  // 不少手机 / 微信内置浏览器没有中文语音包，TTS 会直接无声。
  if (window.VOICE_B64 ? window.VOICE_B64["evt_start"] : true){ VOICE._lastSpoke = 0; voicePlay(["evt_start"]); return; }
  try {
    if (window.speechSynthesis){
      const u = new SpeechSynthesisUtterance("训练开始");
      u.lang = "zh-CN"; u.rate = 0.9; u.volume = 1;
      speechSynthesis.speak(u);
    }
  } catch(e){}
}

// 推进连续错误状态（不产生播报）：与 _errFeedback 共用同一状态机。
// 组间总结/事件命中时会「跳过」单拍纠错，这里仍要推进状态，保证下一拍「改善/消失」判定连续。
function _errAdvance(errId, score, conf){
  if (errId !== _lastErr){
    _errStreak = { id: errId, count: 1 };
    _errLastScore = score; _errLastConf = conf; _errQuiet = 0;
  } else {
    _errStreak.count++;
    _errLastScore = score; _errLastConf = conf;
  }
  _lastErr = errId;
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
// 只总结这一组最常出现的问题；没有反复出现的问题就不播（「没检出」不等于动作没问题，规则覆盖有限）
function _groupSummary(){
  const top = _topFromCount(_group.errCount);
  return top ? ["grp_weak", "err_name_" + top.id, "grp_next", "err_focus_" + top.id] : ["grp_clean"];
}

// 训练后总结（点停止时）：总拍数 + 平均分 + 段位变化 + 短板 + 下次重点
function voiceSessionSummary(uid){
  if (_session.shots < MIN_SESSION_SHOTS){ voiceResetSession(); return null; }
  // 只报拍数和最常出现的问题；不报平均分、不报段位（都来自未经验证的模板相似度）
  const ids = ["sum_total", "nump_" + Math.min(_session.shots, 100), "sum_pai"];
  const top = _topFromCount(_session.errCount);
  if (top) ids.push("grp_weak", "err_name_" + top.id, "grp_next", "err_focus_" + top.id);
  ids.push("sum_end");
  voiceResetSession();
  return ids;
}

// 纠错反馈（所有用户，含 guest）：像真实教练 —— 有问题直接指出 → 改善就表扬 → 良好则静默
function _errFeedback(errId, score, conf){
  let result = null;
  if (errId && ERR_VOICE[errId]){
    const v = ERR_VOICE[errId];
    if (errId !== _lastErr){
      result = [v.first];                        // ① 有问题：直接指出
    } else {
      // 改善判定：只看错误置信度下降（错误指标向达标靠拢）；不看模板相似度分数（未经验证）
      const improved = conf != null && _errLastConf != null && _errLastConf - conf >= IMPROVE_CONF;
      if (improved){
        _errQuiet = 0;                           // ② 改善：有 improving 话术则表扬，否则静默（不纠正）
        if (v.improving) result = [v.improving];
      } else {
        _errQuiet++;                             // ③ 未改善：节流重复纠正（防唠叨）
        if (_errQuiet >= REP_EVERY){
          _errQuiet = 0;
          const n = _errStreak.count + 1;        // 连续拍数（含当前拍）
          const idx = Math.min(Math.floor(n / REP_EVERY) - 1, v.rep.length - 1);
          result = [v.rep[Math.max(0, idx)]];
        }
      }
    }
  } else if (!errId && _lastErr && ERR_VOICE[_lastErr] && ERR_VOICE[_lastErr].resolved){
    result = [ERR_VOICE[_lastErr].resolved];     // ④ 错误消失：明显表扬（一次，之后良好即静默）
  }
  _errAdvance(errId, score, conf);
  return result;
}

// 反馈决策：返回要播放的文件名数组
// 优先级：组间总结（有反复出现的问题时）> 首要错误纠正 / 改善表扬 > 错误消失肯定 > 静默
// （原「疲劳 / 破最佳 / 连续进步」依赖模板相似度分数，2026-10-17 起停用）
function voiceFeedback(uid, score, diag, ladder){
  const errId = (diag && diag.top) ? diag.top.id : null;
  const errConf = (diag && diag.top) ? diag.top.confidence : null;

  // ---- 会话 + 组统计（2026-10-26 起含 guest：只统计拍数和问题次数，不进个人历史）----
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

  let ids = null;
  // ---- 组间总结：满 GROUP_SIZE 拍一定播一次（有反复问题报问题，否则报「没发现明显问题」）----
  if (_group.scores.length >= GROUP_SIZE){
    ids = _groupSummary();
    _group = _newGroup();
    _errAdvance(errId, score, errConf);
  } else {
    ids = _errFeedback(errId, score, errConf);
  }
  // ---- 兜底：连续 SILENT_MAX 拍没出声，补一句简短提示 ----
  if (ids && ids.length){ _silent = 0; }
  else if (++_silent >= SILENT_MAX){ _silent = 0; ids = ["grp_clean_short"]; }
  return ids;
}
