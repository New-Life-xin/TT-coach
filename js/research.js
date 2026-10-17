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
    if (d.user) lset(K.user, JSON.stringify({ login: d.user.login_name, code: d.user.participant_code }));
  }
  function signOut() { [K.access, K.refresh, K.user, K.task].forEach(ldel); render(); }

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
        if (t.status === "done") { clearInterval(polling); ldel(K.task); st.textContent = "完成"; showResult(tid, t); $("rsUpload").disabled = false; }
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
    if (r.retest) html += row("复测", esc(r.retest.message || r.retest.outcome));
    else if (r.prescription) html += row("训练处方", esc((r.prescription.prescription && r.prescription.created ? "已开处方：" + r.prescription.prescription.error_name + "。" : "") + (r.prescription.reason || "")));
    if (r.prescription_error) html += row("训练处方", esc(r.prescription_error), "bad");
    var sync = t.sync_status || r.backend_sync;
    if (sync === "failed") html += row("保存", '结果还没存进训练记录。<button type="button" id="rsRetry" class="rs-mini">重试保存</button>', "bad");
    else html += row("保存", "已存入你的训练记录");
    var cs = r.coach_share;
    if (cs) html += row("教练评测", esc(cs.message) + (cs.status === "done" && r.backend_session_id
      ? ' <button type="button" id="rsWithdraw" class="rs-mini">撤回视频</button>' : ""), cs.status === "done" ? "" : "bad");
    $("rsResult").innerHTML = html;
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
  }
  function init() {
    if (!$("researchBox")) return;
    $("rsTabLogin").onclick = function () { setForm("login"); };
    $("rsTabReg").onclick = function () { setForm("register"); };
    $("rsForm").onsubmit = submitAuth;
    $("rsLogout").onclick = function () { signOut(); note(""); };
    $("rsUpload").onclick = startUpload;
    setForm("login");
    render();
    var pending = lget(K.task);
    if (pending && lget(K.access)) { $("rsStatus").textContent = "继续查看上次的分析…"; poll(pending); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.ResearchSDK = { render: render, signOut: signOut };
})();
