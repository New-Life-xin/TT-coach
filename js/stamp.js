// ---------- 实时模式「盖印」（stamp.js，最后加载，只做展示）----------
/* 实时捕捉时每出一次结果，在画面右下角盖一个朱砂印：第几拍 + 这一拍的诊断。
   只包装 showResult 读出结果，不改变评分、诊断、语音与上报的任何逻辑。
   印上不放分数：分数是未经验证的模板相似度，详见右侧小字。 */
(function () {
  "use strict";
  var stamp = document.getElementById("stamp");
  if (!stamp || typeof window.showResult !== "function") return;
  var n = 0, timer = null;
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var orig = window.showResult;
  window.showResult = function (agg) {
    var out = orig.apply(this, arguments);
    try {
      if (agg && agg.liveMs !== undefined) {
        n += 1;
        var d = agg.diag, line;
        if (d && !d.skip && d.top) line = esc(d.top.name) + (d.top.coach_phrase ? "<br>" + esc(d.top.coach_phrase) : "");
        else if (d && d.skip) line = esc(d.reason || "这一拍暂时无法判断");
        else line = "动作已记录";
        stamp.innerHTML = "<b>第 " + n + " 拍</b><span>" + line + "</span>";
        stamp.hidden = false;
        stamp.classList.remove("pop"); void stamp.offsetWidth; stamp.classList.add("pop");
        clearTimeout(timer);
        timer = setTimeout(function () { stamp.hidden = true; }, 4000);
      }
    } catch (e) { /* 展示失败不影响评分 */ }
    return out;
  };
  // 摄像头画面出现时把它滚到屏幕顶部（手机横屏时标题区会占掉大半屏；模型首次加载可能要等几秒）
  var cw = document.getElementById("camwrap"), panel = document.querySelector("#panelLive .panel");
  if (cw && panel && window.MutationObserver) {
    var shown = false;
    new MutationObserver(function () {
      var on = cw.style.display === "block";
      if (on && !shown) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      shown = on;
    }).observe(cw, { attributes: true, attributeFilter: ["style"] });
  }
  // 停止摄像头后计数清零
  var stop = document.getElementById("btnLiveStop");
  if (stop) stop.addEventListener("click", function () { n = 0; stamp.hidden = true; });
})();
