// ---------- 参与研究（research.js，独立于本地评分引擎）----------
/* 默认是离线版：本页所有评分都在浏览器里完成、什么都不上传。
   学员登录（或凭邀请码注册）后，「上传视频」模式多一个「上传到服务器分析」：
   只上传原视频，由服务器用与微信小程序完全相同的流程分析并保存训练记录；
   勾选同意后，视频再交给教练评测（保留期满自动删除，可随时撤回）。
   浏览器本地算出的分数不上传、不作为研究数据。

   接口（与小程序共用，经分析服务 /api/v1 转发）：
     POST /auth/register  POST /auth/token  POST /auth/refresh
     POST /videos（multipart）→ {task_id}   GET /tasks/{id}   POST /tasks/{id}/sync
     DELETE /coach/items/student/{session_id}/video  撤回交给教练的视频
   仅在 ttcoach.cn 同源页面可用（分析服务不开放跨域）；本地调试可在 index.html 里声明
   window.RESEARCH_CONFIG = { base: "http://127.0.0.1:8000" }。 */
(function () {
  "use strict";
  var CFGB = window.RESEARCH_CONFIG && window.RESEARCH_CONFIG.base;
  var BASE = CFGB != null ? CFGB : (location.hostname === "ttcoach.cn" ? "" : null);
  var API = "/api/v1";
  var MAX_MB = 50, MAX_SEC = 60, POLL_MS = 2000, POLL_MAX = 150;
  var K = { access: "tt_r_access", refresh: "tt_r_refresh", user: "tt_r_user", task: "tt_r_task" };

  function $(id) { return document.getElementById(id); }
  function lget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ldel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function user() { try { return JSON.parse(lget(K.user) || "null"); } catch (e) { return null; } }
  function save(d) {
    lset(K.access, d.access_token); lset(K.refresh, d.refresh_token);
    if (d.user) lset(K.user, JSON.stringify({ login: d.user.login_name, code: d.user.participant_code, role: d.user.role }));
  }
  function signOut() { [K.access, K.refresh, K.user, K.task].forEach(ldel); setRetest(null); render(); }

  async function detail(res) {
    try { var j = await res.json(); return j.detail || j.message || ""; } catch (e) { return ""; }
  }
  async function refresh() {
    var rt = lget(K.refresh); if (!rt) return false;
    try {
      var r = await fetch(BASE + API + "/auth/refresh", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: rt }) });
      if (!r.ok) return false;
      save(await r.json()); return true;
    } catch (e) { return false; }
  }
  async function api(path, opts, retried) {
    opts = opts || {};
    var h = Object.assign({}, opts.headers || {});
    if (opts.json !== undefined) h["Content-Type"] = "application/json";
    var t = lget(K.access); if (t) h.Authorization = "Bearer " + t;
    var r = await fetch(BASE + API + path, { method: opts.method || "GET", headers: h,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body });
    if (r.status === 401 && !retried && await refresh()) return api(path, opts, true);
    if (r.status === 401) { signOut(); throw new Error("登录已过期，请重新登录"); }
    return r;
  }

  // ---------------------------------------------------------------- 登录 / 注册
  var mode = "login";
  function setForm(m) {
    mode = m;
    $("rsTabLogin").classList.toggle("on", m === "login");
    $("rsTabReg").classList.toggle("on", m === "register");
    $("rsRegOnly").style.display = m === "register" ? "" : "none";
    $("rsSubmit").textContent = m === "register" ? "注册并登录" : "登录";
    $("rsName").placeholder = m === "register" ? "起一个好记的登录名（2–20 个字）" : "登录名或研究编号";
    $("rsPwd").autocomplete = m === "register" ? "new-password" : "current-password";
    $("rsMsg").textContent = "";
  }
  async function submitAuth(e) {
    e.preventDefault();
    var name = $("rsName").value.trim(), pwd = $("rsPwd").value, msg = $("rsMsg");
    if (!name || !pwd) { msg.textContent = "请填写登录名和密码"; return; }
    var body, path;
    if (mode === "register") {
      if (pwd.length < 6) { msg.textContent = "密码至少 6 位"; return; }
      if (pwd !== $("rsPwd2").value) { msg.textContent = "两次输入的密码不一致"; return; }
      var inv = $("rsInvite").value.trim();
      if (!inv) { msg.textContent = "请填写教练发的邀请码"; return; }
      path = "/auth/register"; body = { invite_code: inv, login_name: name, password: pwd };
    } else {
      path = "/auth/token"; body = { participant_code: name, password: pwd };
    }
    $("rsSubmit").disabled = true; msg.textContent = mode === "register" ? "正在注册…" : "正在登录…";
    try {
      var r = await fetch(BASE + API + path, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await detail(r) || ("失败（HTTP " + r.status + "）"));
      save(await r.json());
      $("rsPwd").value = ""; $("rsPwd2").value = "";
      render();
      if (mode === "register") note("注册成功。请记住登录名「" + (user().login || name) +
        "」和密码，换手机或电脑时用同一个账号登录。");
    } catch (err) { msg.textContent = err.message || "网络错误，请稍后再试"; }
    finally { $("rsSubmit").disabled = false; }
  }
  function note(t) { $("rsNote").textContent = t; $("rsNote").style.display = t ? "" : "none"; }

  // ---------------------------------------------------------------- 上传与轮询
  function pickedFile() { var f = $("file"); return f && f.files && f.files[0]; }
  function duration(file) {
    return new Promise(function (res) {
      var v = document.createElement("video"), u = URL.createObjectURL(file), done = false;
      function fin(d) { if (done) return; done = true; URL.revokeObjectURL(u); res(d); }
      v.preload = "metadata"; v.muted = true;
      v.onloadedmetadata = function () { fin(isFinite(v.duration) ? v.duration : null); };
      v.onerror = function () { fin(null); };
      setTimeout(function () { fin(null); }, 4000);
      v.src = u;
    });
  }
  function uploadXHR(form, onProgress) {
    return new Promise(function (resolve, reject) {
      function send(retried) {
        var x = new XMLHttpRequest();
        x.open("POST", BASE + API + "/videos");
        var t = lget(K.access); if (t) x.setRequestHeader("Authorization", "Bearer " + t);
        x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
        x.onload = async function () {
          var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
          if (x.status === 401 && !retried && await refresh()) return send(true);
          if (x.status >= 200 && x.status < 300) return resolve(j);
          reject(new Error(j.detail || ("上传失败（HTTP " + x.status + "）")));
        };
        x.onerror = function () { reject(new Error("网络中断，上传没有完成，请重试")); };
        x.send(form);
      }
      send(false);
    });
  }
  var polling = null;
  async function startUpload() {
    var f = pickedFile(), st = $("rsStatus");
    $("rsResult").innerHTML = "";
    if (!f) { st.textContent = "请先在上方选择视频"; return; }
    if (f.size > MAX_MB * 1024 * 1024) { st.textContent = "视频超过 " + MAX_MB + "MB，请剪短或压缩后再传"; return; }
    var d = await duration(f);
    if (d != null && d > MAX_SEC + 1) { st.textContent = "视频超过 " + MAX_SEC + " 秒，请剪到 1 分钟以内"; return; }
    var form = new FormData();
    form.append("file", f, f.name || "clip.mp4");
    form.append("action", $("action").value);
    form.append("angle", $("angle").value);
    form.append("client", "web");
    if ($("rsTask").value) form.append("task", $("rsTask").value);
    if ($("rsFeed").value) form.append("feed_mode", $("rsFeed").value);
    form.append("share_with_coach", $("rsShare").checked ? "true" : "false");
    if (retestRx) {
      form.append("prescription_id", retestRx.id);
      var dr = $("rsDrills").value;
      if (dr) form.append("drills", dr);
      // 自报完成练习（与小程序一致）；失败不阻断复测
      if (dr === "done" && !retestRx.drillsDone) api("/prescriptions/" + retestRx.id + "/drills", { method: "POST", json: { note: null } }).catch(function () {});
    }
    $("rsUpload").disabled = true;
    try {
      st.textContent = "正在上传 0%";
      var j = await uploadXHR(form, function (p) { st.textContent = "正在上传 " + Math.round(p * 100) + "%"; });
      lset(K.task, j.task_id);
      poll(j.task_id);
    } catch (err) { st.textContent = err.message; $("rsUpload").disabled = false; }
  }
  var STATUS = { queued: "排队中", running: "服务器分析中" };
  function poll(tid) {
    var n = 0, st = $("rsStatus");
    clearInterval(polling);
    $("rsUpload").disabled = true;
    polling = setInterval(async function () {
      if (++n > POLL_MAX) { clearInterval(polling); st.textContent = "分析时间较长，可稍后刷新页面查看"; $("rsUpload").disabled = false; return; }
      try {
        var r = await api("/tasks/" + encodeURIComponent(tid));
        if (r.status === 404) { clearInterval(polling); ldel(K.task); st.textContent = "任务已过期"; $("rsUpload").disabled = false; return; }
        var t = await r.json();
        if (t.status === "done") { clearInterval(polling); ldel(K.task); st.textContent = "完成"; setRetest(null); showResult(tid, t); $("rsUpload").disabled = false; loadRx(); }
        else if (t.status === "failed" || t.status === "interrupted") {
          clearInterval(polling); ldel(K.task); $("rsUpload").disabled = false;
          st.textContent = t.error || "分析失败";
        } else st.textContent = (STATUS[t.status] || t.status) + (t.progress ? " " + t.progress + "%" : "") + (t.note ? " · " + t.note : "");
      } catch (e) { st.textContent = "网络不稳定，正在重试…"; }
    }, POLL_MS);
  }

  // ---------------------------------------------------------------- 结果
  function row(label, html, cls) { return '<div class="rs-row ' + (cls || "") + '"><span>' + label + "</span><div>" + html + "</div></div>"; }
  function showResult(tid, t) {
    var r = t.result || {}, ev = r.evaluation || {}, html = "";
    var dg = ev.diagnosis || {}, sc = ev.scoring || {};
    var issues = {};
    (r.strokes || []).forEach(function (s) {
      var top = s.diag && s.diag.top; if (top && top.name) issues[top.name] = (issues[top.name] || 0) + 1;
    });
    var names = Object.keys(issues).sort(function (a, b) { return issues[b] - issues[a]; });
    html += row("动作诊断", (names.length ? "<b>" + esc(names.join("、")) + "</b><br>" : "") + esc(dg.message || "暂无诊断"), names.length ? "warn" : "");
    var drill = null;
    (r.strokes || []).some(function (s) { drill = s.diag && s.diag.drill; return !!drill; });
    if (drill) html += row("下一步练", esc(drill), "gold");
    if (sc.status && sc.status !== "ok") html += row("系统评分", esc(sc.message || "本次不给分档"));
    if (r.view && r.view.note) html += row("机位", esc(r.view.note));
    if (r.prescription_error) html += row("训练处方", "暂不可用：" + esc(r.prescription_error), "bad");
    var sync = t.sync_status || r.backend_sync;
    if (sync === "failed") html += row("保存", '结果还没存进训练记录。<button type="button" id="rsRetry" class="rs-mini">重试保存</button>', "bad");
    else html += row("保存", "已存入你的训练记录");
    var cs = r.coach_share;
    if (cs) html += row("教练评测", esc(cs.message) + (cs.status === "done" && r.backend_session_id
      ? ' <button type="button" id="rsWithdraw" class="rs-mini">撤回视频</button>' : ""), cs.status === "done" ? "" : "bad");
    $("rsResult").innerHTML = html;
    showRx(r);
    showFeedback(r);
    var b = $("rsRetry");
    if (b) b.onclick = async function () {
      b.disabled = true; b.textContent = "正在保存…";
      try {
        var res = await api("/tasks/" + encodeURIComponent(tid) + "/sync", { method: "POST", json: {} });
        var j = await res.json();
        if (res.ok && j.backend_sync === "synced") { t.sync_status = "synced"; t.result = j.result || r; showResult(tid, t); }
        else { b.disabled = false; b.textContent = "仍未保存，再试一次"; }
      } catch (e) { b.disabled = false; b.textContent = "重试失败，再试一次"; }
    };
    var w = $("rsWithdraw");
    if (w) w.onclick = async function () {
      if (!confirm("撤回后教练将看不到这段视频，视频会从服务器删除。确定撤回？")) return;
      w.disabled = true;
      try {
        var res = await api("/coach/items/student/" + encodeURIComponent(r.backend_session_id) + "/video", { method: "DELETE" });
        if (res.ok || res.status === 204) { w.replaceWith(document.createTextNode("（已撤回，视频已删除）")); }
        else { w.disabled = false; alert(await detail(res) || "撤回失败"); }
      } catch (e) { w.disabled = false; }
    };
  }

  // ---------------------------------------------------------------- 训练处方与复测（与小程序一致）
  var OUTCOME_CN = {
    resolved: "本次复测指标达到目标", met_unconfirmed: "指标达标，待确认（条件未完全核对）",
    improving: "指标向目标靠近", no_change: "指标无明显变化",
    insufficient: "证据不足", not_comparable: "与上次不可比"
  };
  var RX_STATUS_CN = { no_supported_issue: "没有稳定出现的问题", insufficient_data: "数据不足", out_of_scope: "超出支持范围", error: "系统暂不可用" };
  var retestRx = null;
  function rxView(p) {
    if (!p) return null;
    var u = p.metric_unit || "";
    return { id: p.id, name: p.error_name, action: p.action, angle: p.angle || "自动", status: p.status,
      attempts: p.attempts || 0, phrase: p.coach_phrase || "", drill: p.drill || "", verify: p.verify || "",
      drillsDone: !!p.drills_done_at, cond: (p.baseline_snapshot && p.baseline_snapshot.condition) || {},
      baseline: p.metric_label + "：开处方时中位数 " + (p.baseline_metric != null ? p.baseline_metric.toFixed(2) : "—") + u +
        "（目标 ≤" + p.threshold + u + "），" + p.baseline_n + " 拍中 " + Math.round(p.baseline_rate * 100) + "% 出现" };
  }
  function rxCard(rx, title, extra) {
    var h = '<div class="rs-rx"><h3>' + esc(title) + '</h3><div class="rs-rx-name">先改：' + esc(rx.name) + "</div>" + (extra || "") +
      '<p>' + esc(rx.baseline) + "</p>" + (rx.phrase ? "<p>要点：" + esc(rx.phrase) + "</p>" : "") +
      (rx.drill ? '<p class="rs-drill">练习：' + esc(rx.drill) + "</p>" : "") + (rx.verify ? "<p>达标：" + esc(rx.verify) + "</p>" : "");
    if (rx.status === "active") {
      h += '<div class="rs-rx-actions"><button type="button" class="btn" data-rx-retest="' + esc(rx.id) + '">我练完了，去复测</button>' +
        '<button type="button" class="btn ghost" data-rx-close="' + esc(rx.id) + '">暂不练这个</button></div>' +
        '<p class="rs-hint">复测请尽量用相近的机位（' + esc(rx.angle) + '），系统会用同一指标与这次对比。</p>';
    } else h += '<p class="rs-hint">这个处方已结束。</p>';
    return h + "</div>";
  }
  var rxCache = {};
  async function showRx(r) {
    var box = $("rsRxBox"); if (!box) return;
    box.innerHTML = "";
    if (r.retest) {
      var t = r.retest, extra = '<div class="rs-outcome' + (t.outcome === "resolved" ? " good" : "") + '">' +
        esc(OUTCOME_CN[t.outcome] || t.outcome) + "</div><p>" + esc(t.message || "") + "</p>";
      box.innerHTML = '<div class="rs-rx"><h3>复测结果</h3>' + extra + "</div>";
      try {
        var res = await api("/prescriptions/" + encodeURIComponent(t.prescription_id));
        if (res.ok) { var rx = rxView(await res.json()); rxCache[rx.id] = rx; box.innerHTML = rxCard(rx, "复测结果", extra); bindRx(box); }
      } catch (e) {}
      return;
    }
    var prop = r.prescription;
    if (!prop) return;
    if (prop.prescription) {
      var rx2 = rxView(prop.prescription); rxCache[rx2.id] = rx2;
      box.innerHTML = rxCard(rx2, prop.created ? "本次训练处方" : "进行中的训练处方",
        !prop.created && prop.reason ? "<p>" + esc(prop.reason) + "</p>" : "");
      bindRx(box);
    } else if (prop.reason) {
      var lab = RX_STATUS_CN[prop.status] ? "：暂不开（" + RX_STATUS_CN[prop.status] + "）" : "";
      box.innerHTML = '<div class="rs-rx muted"><h3>训练处方' + esc(lab) + "</h3><p>" + esc(prop.reason) + "</p></div>";
    }
  }
  function bindRx(scope) {
    scope.querySelectorAll("[data-rx-retest]").forEach(function (b) {
      b.onclick = function () { startRetest(b.getAttribute("data-rx-retest")); };
    });
    scope.querySelectorAll("[data-rx-close]").forEach(function (b) {
      b.onclick = async function () {
        if (!confirm("放弃这个处方？放弃后下次训练会根据新的表现重新开处方。")) return;
        b.disabled = true;
        try { var res = await api("/prescriptions/" + b.getAttribute("data-rx-close") + "/close", { method: "POST", json: {} });
          if (res.ok) { loadRx(); var c = b.closest(".rs-rx"); if (c) c.querySelector(".rs-rx-actions").outerHTML = '<p class="rs-hint">已放弃这个处方。</p>'; }
          else { b.disabled = false; alert(await detail(res) || "操作失败"); }
        } catch (e) { b.disabled = false; }
      };
    });
  }
  async function loadRx() {
    var box = $("rsRxList"); if (!box || !lget(K.access)) return;
    try {
      var res = await api("/prescriptions?status_filter=active");
      if (!res.ok) return;
      var list = (await res.json()).map(rxView);
      list.forEach(function (x) { rxCache[x.id] = x; });
      box.innerHTML = list.map(function (x) {
        return '<button type="button" class="rs-rx-item" data-rx-retest="' + esc(x.id) + '"><b>训练处方 · ' + esc(x.name) + "</b><span>" +
          esc(x.action) + " · " + esc(x.angle) + "机位" + (x.attempts ? " · 已复测 " + x.attempts + " 次" : "") + "　练完后点此复测 ›</span></button>";
      }).join("");
      bindRx(box);
    } catch (e) {}
  }
  async function startRetest(id) {
    var rx = rxCache[id];
    if (!rx) { try { var res = await api("/prescriptions/" + id); if (res.ok) rx = rxCache[id] = rxView(await res.json()); } catch (e) {} }
    if (!rx) return;
    setRetest(rx);
    var tab = $("tabUpload"); if (tab) tab.click();
    var box = $("rsUploadBox"); if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // 复测模式：动作与机位锁定为开处方时的（阈值按机位分档），训练条件按上次预填
  function setRetest(rx) {
    retestRx = rx;
    var bn = $("rsRetestBanner"), act = $("action"), ang = $("angle");
    if (!bn) return;
    if (!rx) {
      bn.style.display = "none";
      [act, ang].forEach(function (el) { if (el) el.disabled = false; });
      $("rsUpload").textContent = "上传到服务器分析";
      return;
    }
    bn.style.display = "";
    $("rsRetestName").textContent = rx.name;
    $("rsRetestTip").textContent = "动作和机位已锁定为上次的（" + rx.action + " · " + rx.angle + "），训练任务和喂球方式按上次预填；前后条件一致才能比较。至少打 3–5 拍。";
    if (act) { act.value = rx.action; act.disabled = true; }
    if (ang) { ang.value = (Array.prototype.some.call(ang.options, function (o) { return o.value === rx.angle; }) ? rx.angle : "自动"); ang.disabled = true; }
    if (rx.cond.task) $("rsTask").value = rx.cond.task;
    if (rx.cond.feed_mode) $("rsFeed").value = rx.cond.feed_mode;
    $("rsDrills").value = rx.drillsDone ? "done" : "";
    $("rsUpload").textContent = "上传复测视频";
  }

  // ---------------------------------------------------------------- 结果反馈（与小程序一致）
  var ACT_CN = { fh: "正手攻球", bh: "反手攻球" };
  function showFeedback(r) {
    var box = $("rsFeedback"); if (!box) return;
    var first = (r.strokes || [])[0] || {};
    box.dataset.score = r.score != null ? r.score : 0;
    box.dataset.action = ACT_CN[first.action] || first.action || "未知";
    box.style.display = "";
    $("rsFbAgree").checked = false; $("rsFbConsent").checked = false; $("rsFbNote").value = "";
    $("rsFbMsg").textContent = ""; $("rsFbSubmit").disabled = false; $("rsFbSubmit").textContent = "提交反馈";
  }
  async function submitFeedback() {
    var box = $("rsFeedback"), msg = $("rsFbMsg"), btn = $("rsFbSubmit");
    var note = $("rsFbNote").value.trim();
    // 网页不显示分数，「评分是否符合」没有被问到：在备注里标明，避免被当成「认可评分」
    var userNote = "[网页·未显示分数] " + note;
    var base = { program_score: Math.max(0, Math.min(100, +box.dataset.score || 0)), program_action: box.dataset.action,
      score_agree: false, action_agree: $("rsFbAgree").checked, user_note: userNote };
    btn.disabled = true; msg.textContent = "提交中…";
    try {
      var res;
      if ($("rsFbConsent").checked) {
        var f = pickedFile();
        if (!f) throw new Error("原视频已不可用，请重新选择视频后再提交复核");
        var form = new FormData();
        Object.keys(base).forEach(function (k) { form.append(k, String(base[k])); });
        form.append("consent_video", "true");
        form.append("video", f, f.name || "clip.mp4");
        res = await api("/reviews", { method: "POST", body: form });
      } else {
        res = await api("/reviews/feedback", { method: "POST", json: base });
      }
      if (!res.ok) throw new Error(await detail(res) || ("提交失败（HTTP " + res.status + "）"));
      msg.textContent = $("rsFbConsent").checked ? "已提交教练复核，谢谢。" : "反馈已记录，谢谢。";
      btn.textContent = "已提交";
    } catch (e) { msg.textContent = e.message || "提交失败，请稍后再试"; btn.disabled = false; }
  }

  // ---------------------------------------------------------------- 教练审核入口
  // 已登录的教练 / 研究者：带上当前登录状态直接进入审核页（同一网站，不用再登录一次）
  function goCoach(e) {
    var u = user(), at = lget(K.access), rt = lget(K.refresh);
    if (BASE === "" && at && u && ["coach", "researcher", "admin"].indexOf(u.role) >= 0) {
      try { sessionStorage.setItem("at", at); if (rt) sessionStorage.setItem("rt", rt); } catch (err) {}
    }
    if (BASE === "") { if (e) e.preventDefault(); location.href = "/api/v1/coach/app"; }
  }

  // ---------------------------------------------------------------- 渲染
  function render() {
    var box = $("researchBox"); if (!box) return;
    if (BASE === null) {
      $("rsOff").style.display = ""; $("rsAuth").style.display = "none"; $("rsIn").style.display = "none";
      $("rsUploadBox").style.display = "none"; return;
    }
    $("rsOff").style.display = "none";
    var u = lget(K.access) && user();
    $("rsAuth").style.display = u ? "none" : "";
    $("rsIn").style.display = u ? "" : "none";
    $("rsUploadBox").style.display = u ? "" : "none";
    if (u) $("rsWho").textContent = (u.login || u.code) + (u.login ? "（研究编号 " + u.code + "）" : "");
    var staff = !!(u && ["coach", "researcher", "admin"].indexOf(u.role) >= 0);
    var cb = $("rsCoach"); if (cb) cb.style.display = staff ? "" : "none";
    var list = $("rsRxList"); if (list) { if (u) loadRx(); else list.innerHTML = ""; }
    // 早先登录时没记下角色：向服务器补问一次（兑换教练码后角色也会变）
    if (u && !u.role && !render._asked) {
      render._asked = true;
      api("/auth/me").then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
        if (me && me.role) { u.role = me.role; lset(K.user, JSON.stringify(u)); render(); }
      }).catch(function () {});
    }
    var fb = $("rsFeedback"); if (fb && !u) fb.style.display = "none";
  }
  function init() {
    if (!$("researchBox")) return;
    $("rsTabLogin").onclick = function () { setForm("login"); };
    $("rsTabReg").onclick = function () { setForm("register"); };
    $("rsForm").onsubmit = submitAuth;
    $("rsLogout").onclick = function () { signOut(); note(""); };
    $("rsUpload").onclick = startUpload;
    $("rsRetestCancel").onclick = function () { setRetest(null); };
    $("rsFbSubmit").onclick = submitFeedback;
    ["rsCoach", "coachLink"].forEach(function (id) { var a = $(id); if (a) a.addEventListener("click", goCoach); });
    setForm("login");
    render();
    var pending = lget(K.task);
    if (pending && lget(K.access)) { $("rsStatus").textContent = "继续查看上次的分析…"; poll(pending); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.ResearchSDK = { render: render, signOut: signOut };
})();
