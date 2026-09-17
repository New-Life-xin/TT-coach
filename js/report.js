// ---------- 匿名化上报 SDK（report.js，最后加载）----------
/* 只把「分数/特征/诊断」的匿名聚合结果上报给后端，绝不上传原始视频、
   33 点关键点坐标或角度序列。白名单字段见 anonymize()。

   对接 FastAPI（backend/）：
     POST /auth/token         登录 → 存 access/refresh 到 sessionStorage
     POST /sessions           开始训练（惰性，首次上报时自动建）
     POST /sessions/{id}/strokes   批量上报单拍（内嵌诊断）
     PATCH /sessions/{id}     结束会话

   后端地址：默认 http://localhost:8000；上线改成你的域名（在 index.html 里
   提前声明 window.REPORT_CONFIG = { base: "https://你的域名" } 即可）。 */
(function () {
  "use strict";

  var CFG = {
    base: (window.REPORT_CONFIG && window.REPORT_CONFIG.base) || "https://ttcoach.cn",
    api: "/api/v1",
    version: "1.0.0"
  };
  var KEY = { access: "tt_report_access", refresh: "tt_report_refresh", session: "tt_report_session" };
  var _seq = 0;   // 会话内第 N 拍（1 起）

  function sget(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sset(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function sdel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  function el(id) { return document.getElementById(id); }
  function token() { return sget(KEY.access); }
  function save(data) { sset(KEY.access, data.access_token); sset(KEY.refresh, data.refresh_token); }

  function rawFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    var t = token();
    if (t) headers["Authorization"] = "Bearer " + t;
    return fetch(CFG.base + CFG.api + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
  }

  async function api(path, opts) {
    opts = opts || {};
    var res = await rawFetch(path, opts);
    // access 过期 → 用 refresh 换一次后重试（仅重试一次，防死循环）
    if (res.status === 401 && !opts._retried && token()) {
      var ok = await refresh();
      if (ok) { opts._retried = true; return rawFetch(path, opts); }
    }
    return res;
  }

  async function refresh() {
    var rt = sget(KEY.refresh);
    if (!rt) return false;
    try {
      var res = await fetch(CFG.base + CFG.api + "/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: rt })
      });
      if (!res.ok) return false;
      save(await res.json());
      return true;
    } catch (e) { return false; }
  }

  async function login(code, pwd) {
    var res = await fetch(CFG.base + CFG.api + "/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participant_code: code, password: pwd })
    });
    if (!res.ok) {
      var detail = "";
      try { detail = (await res.json()).detail || ""; } catch (e) {}
      throw new Error(detail || ("登录失败（HTTP " + res.status + "）"));
    }
    var data = await res.json();
    save(data);
    return data;
  }

  function isAuthed() { return !!token(); }

  async function beginSession() {
    var res = await api("/sessions", {
      method: "POST",
      body: {
        client_version: CFG.version,
        condition: { diagnosis: true, voice: (typeof VOICE !== "undefined" && VOICE.enabled) || false }
      }
    });
    if (!res.ok) { console.warn("建会话失败 HTTP " + res.status); return null; }
    var data = await res.json();
    sset(KEY.session, data.id);
    _seq = 0;
    return data.id;
  }

  async function endSession() {
    var sid = sget(KEY.session);
    sdel(KEY.session); _seq = 0;   // 立即释放，下次挥拍新建会话
    if (!sid) return;
    try { await api("/sessions/" + sid, { method: "PATCH", body: { ended_at: new Date().toISOString() } }); }
    catch (e) {}
  }

  function logout() { endSession(); sdel(KEY.access); sdel(KEY.refresh); }

  // ---------- 匿名化：白名单，绝不透传 seg.frames/lms/angles 与 tpl.angles ----------
  function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }

  function buildFeatures(agg) {
    var f = {};
    var d = agg.diag && agg.diag.features;
    if (d) for (var k in d) { var v = d[k]; if (v != null && typeof v !== "object") f["diag_" + k] = v; }
    var fc = agg.force;
    if (fc) { f.force_shN = num(fc.shN); f.force_hipN = num(fc.hipN); f.force_wrN = num(fc.wrN); }
    if (agg.conf != null) f.match_conf = agg.conf;
    return f;
  }

  function buildLadder(L) {
    if (!L) return {};
    return { tier: L.tier || null, tierIdx: num(L.tierIdx), lp: num(L.lp),
             sessions: num(L.sessions), event: L.event || null };
  }

  function buildDiag(diag) {
    if (!diag || !diag.top) return null;
    var top = diag.top;
    var errors = [];
    if (diag.ranked && diag.ranked.length) {
      errors = diag.ranked.map(function (e) {
        return {
          id: e.id, name: e.name,
          confidence: num(e.confidence), confidence_label: e.confidence_label || null,
          severity: e.severity || null, is_root_cause: !!(e.id === top.id),
          evidence: e.evidence || {}, coach_phrase: e.coach_phrase || null,
          drill: e.drill || null, verify: e.verify || null
        };
      });
    }
    return {
      top_id: top.id, top_name: top.name,
      confidence: num(top.confidence), confidence_label: top.confidence_label || null,
      severity: top.severity || null, errors: errors
    };
  }

  function anonymize(agg) {
    var score = (agg.r && typeof agg.r.score === "number") ? agg.r.score : null;
    return {
      action: agg.act || null,
      angle: agg.angle || null,
      side: (agg.vh && agg.vh.hand) ? (agg.vh.hand === "left" ? "l" : "r") : null,
      score: score,
      force_rating: (agg.force && agg.force.rating) || null,
      force_avg: (agg.force && typeof agg.force.avg === "number") ? +agg.force.avg.toFixed(3) : null,
      latency_ms: num(agg.liveMs),
      peak_time: (agg.seg && agg.seg.peakTime != null) ? +agg.seg.peakTime : null,
      detect_rate: num(agg.seg && agg.seg.detRate),
      mirrored: !!agg.mirrored,
      matched_template_id: (agg.tpl && agg.tpl.id != null) ? agg.tpl.id : null,
      matched_athlete: (agg.tpl && agg.tpl.athlete) || null,
      features: buildFeatures(agg),
      ladder: buildLadder(agg.ladder),
      diag: buildDiag(agg.diag)
    };
  }

  async function submitStroke(agg) {
    if (!token()) return false;   // 未登录不上报（静默）
    try {
      var payload = anonymize(agg);
      if (payload.score == null) return false;
      var sid = sget(KEY.session);
      if (!sid) sid = await beginSession();
      if (!sid) return false;
      payload.seq_in_session = ++_seq;
      var res = await api("/sessions/" + sid + "/strokes",
        { method: "POST", body: { strokes: [payload] } });
      if (!res.ok) {
        console.warn("上报失败 HTTP " + res.status, await res.text().catch(function () { return ""; }));
        return false;
      }
      setReportStatus("已上报第 " + _seq + " 拍（" + payload.score + " 分）");
      return true;
    } catch (e) { console.warn("上报异常", e); return false; }
  }

  // ---------- 登录 UI ----------
  function setReportStatus(t) { var s = el("reportStatus"); if (s) s.textContent = t; }

  function syncAuth() {
    var authed = isAuthed();
    var loginBtn = el("reportLogin"), logoutBtn = el("reportLogout");
    if (loginBtn) loginBtn.style.display = authed ? "none" : "";
    if (logoutBtn) logoutBtn.style.display = authed ? "" : "none";
    if (authed) setReportStatus("已登录：数据将匿名上报");
  }

  function bindUI() {
    var codeEl = el("reportCode"), pwdEl = el("reportPwd"),
        loginBtn = el("reportLogin"), logoutBtn = el("reportLogout");
    if (!loginBtn) return;
    loginBtn.onclick = function () {
      var code = codeEl ? codeEl.value.trim() : "";
      var pwd = pwdEl ? pwdEl.value : "";
      if (!code || !pwd) { setReportStatus("请输入参与码与密码"); return; }
      loginBtn.disabled = true; setReportStatus("登录中…");
      login(code, pwd).then(syncAuth)
        .catch(function (e) { setReportStatus("登录失败：" + e.message); })
        .finally(function () { loginBtn.disabled = false; });
    };
    if (logoutBtn) logoutBtn.onclick = function () { logout(); syncAuth(); setReportStatus("已退出，不再上报"); };
    syncAuth();
  }

  // 包装 showResult：实时 + 上传的唯一汇合点，上报不阻塞界面
  var _origShow = window.showResult;
  if (typeof _origShow === "function") {
    window.showResult = function (agg) {
      try { submitStroke(agg); } catch (e) { console.warn(e); }
      return _origShow(agg);
    };
  }
  // 包装 stopLive：实时训练结束时收尾会话
  var _origStop = window.stopLive;
  if (typeof _origStop === "function") {
    window.stopLive = function () {
      try { endSession(); } catch (e) {}
      return _origStop.apply(this, arguments);
    };
  }
  // 页面关闭时尽力收尾（fire-and-forget）
  window.addEventListener("pagehide", function () { try { endSession(); } catch (e) {} });

  window.ReportSDK = {
    login: login, logout: logout, isAuthed: isAuthed,
    beginSession: beginSession, endSession: endSession,
    submitStroke: submitStroke, anonymize: anonymize
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindUI);
  else bindUI();
})();
