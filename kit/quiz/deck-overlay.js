/**
 * deck-overlay.js — 放映页发题浮层的唯一 UI 实现。
 *
 * 文览 Electron（exec-present.js）与文枢 Web（race-deck.js）都只当宿主适配器：
 * 各自负责连自己的状态源，再把统一 state 交给本模块渲染。这里不连 WS、不发
 * 命令、不推断题目来源，只管 DOM、样式、键位与计时展示。
 *
 * state 契约：
 *   phase: 'idle' | 'running' | 'revealed' | 'error'
 *   questionKey, stem, options[], limitSec, remainingSec, online, answered
 *   reveal: { answer, distribution[], fastest, leaderboard[] }
 *   leaderboard: [{ rank, studentNo, studentName, score, correct, answers, offRoster }]
 *   message, showControls, voidArmed
 * opts 契约：
 *   onClose(), onAction(action)  // action: close | void | reopen | exit
 */
(function (global) {
  "use strict";

  var CSS_ID = "md2s-quiz-deck-css";

  var CSS = [
    /* 题干行内发题按钮：文览与文枢共用，绿色且落题干右侧，不另起一行。 */
    ".md2s-quiz-with-launch { display: flex; align-items: flex-start; gap: 12px; }",
    ".md2s-quiz-inline-text { flex: 1; min-width: 0; }",
    ".md2s-quiz-launch { display: inline-flex; align-items: center; flex: 0 0 auto;",
    "  margin: 0; padding: 5px 14px; cursor: pointer; font-size: 15px; line-height: 1.2;",
    "  white-space: nowrap; color: #fff; background: #2b8a3e;",
    "  border: 1px solid #237a36; border-radius: 6px; }",
    ".md2s-quiz-launch:hover { background: #237a36; }",
    ".md2s-quiz-launch:disabled { opacity: 0.55; cursor: default; }",
    ".md2s-quiz-ov, .md2s-quiz-ov * { box-sizing: border-box; }",
    ".md2s-quiz-ov { position: fixed; inset: 0; z-index: 120000;",
    "  background: rgba(15,25,40,.55); display: flex; align-items: center; justify-content: center;",
    "  font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }",
    ".md2s-quiz-card { width: min(1360px,94vw); height: min(86vh,940px); display: flex;",
    "  background: #fff; color: #22303f; border-radius: 14px; overflow: hidden;",
    "  box-shadow: 0 12px 48px rgba(15,25,40,.35); }",
    ".md2s-quiz-l { flex: 1.25; padding: 30px 36px; border-right: 1px solid #e3e8ee; overflow: auto; }",
    ".md2s-quiz-r { flex: 1; padding: 22px 30px; display: flex; flex-direction: column;",
    "  justify-content: center; gap: 12px; background: #f7f9fb; color: #33414f; overflow: auto; }",
    ".md2s-quiz-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }",
    ".md2s-quiz-key { font-size: 15px; color: #2b6cb0; background: #e8f0fa; border-radius: 5px; padding: 3px 10px; }",
    ".md2s-quiz-limit { font-size: 15px; color: #8a5a00; background: #fdf3e0; border-radius: 5px; padding: 3px 10px; }",
    ".md2s-quiz-stem { font-size: 26px; line-height: 1.6; margin: 0 0 22px; white-space: pre-wrap; word-break: break-word; }",
    ".md2s-quiz-opts { display: flex; flex-direction: column; gap: 10px; }",
    ".md2s-quiz-opt { display: flex; gap: 14px; padding: 14px 20px; border: 1px solid #e3e8ee;",
    "  border-radius: 8px; font-size: 22px; line-height: 1.5; background: #fff; }",
    ".md2s-quiz-opt b { color: #5b6b7c; flex: none; }",
    ".md2s-quiz-opt.md2s-quiz-correct { border-color: #2b8a3e; background: #e9f7ec; }",
    ".md2s-quiz-opt.md2s-quiz-correct b { color: #2b8a3e; }",
    ".md2s-quiz-answer { margin-top: 14px; font-size: 19px; color: #2b8a3e; }",
    ".md2s-quiz-live-title { font-size: 22px; font-weight: 700; color: #1f3a5f; text-align: center; }",
    ".md2s-quiz-clock { font-size: 84px; font-weight: 700; color: #1f3a5f; text-align: center;",
    "  font-variant-numeric: tabular-nums; line-height: 1; }",
    ".md2s-quiz-clock.md2s-quiz-done { font-size: 46px; color: #2b8a3e; }",
    ".md2s-quiz-clock.md2s-quiz-waiting { font-size: 34px; color: #7c93ad; }",
    ".md2s-quiz-prog { height: 14px; background: #e3e8ee; border-radius: 7px; overflow: hidden; }",
    ".md2s-quiz-prog i { display: block; height: 100%; background: #2b6cb0; }",
    ".md2s-quiz-metrics { display: flex; gap: 16px; }",
    ".md2s-quiz-metric { flex: 1; background: #fff; border: 1px solid #e3e8ee; border-radius: 12px;",
    "  padding: 12px 14px; text-align: center; }",
    ".md2s-quiz-metric span { display: block; font-size: 16px; color: #5b6b7c; }",
    ".md2s-quiz-metric b { display: block; margin-top: 4px; font-size: 30px; color: #1f3a5f;",
    "  font-variant-numeric: tabular-nums; }",
    ".md2s-quiz-stat { font-size: 21px; color: #5b6b7c; text-align: center; line-height: 1.5; }",
    ".md2s-quiz-stat b { color: #1f3a5f; font-size: 27px; }",
    ".md2s-quiz-hint { font-size: 14px; color: #8a97a5; text-align: center; }",
    ".md2s-quiz-block { display: flex; flex-direction: column; gap: 7px; }",
    ".md2s-quiz-block-title { font-size: 17px; font-weight: 700; color: #33414f; }",
    ".md2s-quiz-dist { display: flex; flex-direction: column; gap: 7px; }",
    ".md2s-quiz-drow { display: flex; align-items: center; gap: 10px; font-size: 16px; }",
    ".md2s-quiz-drow .dletter { width: 22px; flex: none; color: #5b6b7c; text-align: center; }",
    ".md2s-quiz-drow.md2s-quiz-correct .dletter { color: #2b8a3e; font-weight: 700; }",
    ".md2s-quiz-drow .dbar { flex: 1; height: 18px; background: #e9edf2; border-radius: 4px; overflow: hidden; }",
    ".md2s-quiz-drow .dbar i { display: block; height: 100%; background: #7c93ad; }",
    ".md2s-quiz-drow.md2s-quiz-correct .dbar i { background: #2b8a3e; }",
    ".md2s-quiz-drow .dcount { width: 38px; flex: none; color: #33414f; text-align: right;",
    "  font-variant-numeric: tabular-nums; }",
    ".md2s-quiz-board { width: 100%; border-collapse: collapse; font-size: 15px; }",
    ".md2s-quiz-board th { color: #6b7a89; font-weight: 400; text-align: left; padding: 3px 8px;",
    "  border-bottom: 1px solid #dfe5eb; }",
    ".md2s-quiz-board td { padding: 3px 8px; border-bottom: 1px solid #e9edf2; color: #33414f; }",
    ".md2s-quiz-board .n { text-align: right; font-variant-numeric: tabular-nums; }",
    ".md2s-quiz-board tr.off td { color: #9aa5b1; }",
    ".md2s-quiz-board tr.md2s-quiz-focus td { background: #fff4e2; outline: 2px solid #f59630; outline-offset: -2px; }",
    ".md2s-quiz-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }",
    ".md2s-quiz-action { padding: 8px 18px; border: 1px solid #cbd5df; border-radius: 7px;",
    "  background: #fff; color: #33414f; font: inherit; font-size: 16px; cursor: pointer; }",
    ".md2s-quiz-action.md2s-quiz-primary { background: #2b6cb0; border-color: #2b6cb0; color: #fff; }",
    ".md2s-quiz-action.md2s-quiz-danger { background: #8a2f1f; border-color: #8a2f1f; color: #fff; }",
    ".md2s-quiz-action.md2s-quiz-focus { outline: 3px solid #f59630; outline-offset: 1px; }",
    ".md2s-quiz-close { position: absolute; top: 14px; right: 18px; border: 0; border-radius: 50%;",
    "  width: 40px; height: 40px; font-size: 24px; background: rgba(255,255,255,.9);",
    "  color: #33414f; cursor: pointer; }"
  ];

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = CSS.join("\n");
    document.head.appendChild(style);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function letterOf(i) { return String.fromCharCode(65 + i); }

  function ensureSkeleton(root) {
    if (root.querySelector(".md2s-quiz-card")) return;
    root.innerHTML =
      '<div class="md2s-quiz-card">' +
      '  <div class="md2s-quiz-l">' +
      '    <div class="md2s-quiz-head"><span class="md2s-quiz-key"></span>' +
      '      <span class="md2s-quiz-limit"></span></div>' +
      '    <div class="md2s-quiz-stem"></div>' +
      '    <div class="md2s-quiz-opts"></div>' +
      '    <div class="md2s-quiz-answer"></div>' +
      "  </div>" +
      '  <div class="md2s-quiz-r">' +
      '    <div class="md2s-quiz-live-title">答题实况</div>' +
      '    <div class="md2s-quiz-clock">等待发题</div>' +
      '    <div class="md2s-quiz-prog"><i></i></div>' +
      '    <div class="md2s-quiz-metrics">' +
      '      <div class="md2s-quiz-metric"><span>在线</span><b class="md2s-quiz-online">0</b></div>' +
      '      <div class="md2s-quiz-metric"><span>已答</span><b class="md2s-quiz-answered">0</b></div>' +
      "    </div>" +
      '    <div class="md2s-quiz-stat"></div>' +
      '    <div class="md2s-quiz-dist-block md2s-quiz-block">' +
      '      <div class="md2s-quiz-block-title">揭晓分布</div><div class="md2s-quiz-dist"></div>' +
      "    </div>" +
      '    <div class="md2s-quiz-board-block md2s-quiz-block">' +
      '      <div class="md2s-quiz-block-title">排行榜</div><div class="md2s-quiz-board-wrap"></div>' +
      "    </div>" +
      '    <div class="md2s-quiz-actions"></div>' +
      '    <div class="md2s-quiz-hint">↑↓ 遍历 · 确定激活 · Esc 关闭浮层（答题继续）</div>' +
      "  </div>" +
      "</div>" +
      '<button class="md2s-quiz-close" title="关闭浮层">×</button>';
  }

  function visible(root, selector, show) {
    var el = root.querySelector(selector);
    if (el) el.style.display = show ? "" : "none";
  }

  function refreshFocus(root) {
    var bag = root.__quizDeck;
    if (!bag) return;
    bag.focus = [];
    var nodes = root.querySelectorAll("[data-md2s-quiz-focus]");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetParent !== null || document.activeElement === nodes[i]) bag.focus.push(nodes[i]);
    }
    if (bag.focusIdx >= bag.focus.length) bag.focusIdx = 0;
    paintFocus(root);
  }

  function paintFocus(root) {
    var bag = root.__quizDeck;
    if (!bag) return;
    bag.focus.forEach(function (el, i) { el.classList.toggle("md2s-quiz-focus", i === bag.focusIdx); });
    var cur = bag.focus[bag.focusIdx];
    if (cur && cur.scrollIntoView) {
      try { cur.scrollIntoView({ block: "nearest" }); } catch (e) { /* 老浏览器忽略 */ }
    }
  }

  function render(root, state) {
    if (!root) return;
    state = state || {};
    ensureSkeleton(root);
    var bag = root.__quizDeck;
    if (!bag) return;
    bag.state = state;

    var phase = state.phase || "idle";
    var revealed = phase === "revealed" && !!state.reveal;
    var answer = revealed ? (state.reveal.answer || "") : "";
    var options = state.options || [];
    var qkey = root.querySelector(".md2s-quiz-key");
    var limit = root.querySelector(".md2s-quiz-limit");
    var stem = root.querySelector(".md2s-quiz-stem");
    var clock = root.querySelector(".md2s-quiz-clock");
    var prog = root.querySelector(".md2s-quiz-prog");
    var online = root.querySelector(".md2s-quiz-online");
    var answered = root.querySelector(".md2s-quiz-answered");
    var stat = root.querySelector(".md2s-quiz-stat");
    var answerEl = root.querySelector(".md2s-quiz-answer");

    qkey.textContent = state.questionKey || "—";
    visible(root, ".md2s-quiz-key", !!state.questionKey);
    visible(root, ".md2s-quiz-limit", phase === "running" || phase === "revealed");
    limit.textContent = "限时 " + (state.limitSec || 30) + "s";

    if (phase === "error") {
      stem.textContent = state.message || "发题失败";
      clock.textContent = "—";
      clock.className = "md2s-quiz-clock md2s-quiz-waiting";
      stat.textContent = "";
      answerEl.textContent = "";
      visible(root, ".md2s-quiz-prog", false);
      visible(root, ".md2s-quiz-metrics", false);
      visible(root, ".md2s-quiz-stat", false);
      visible(root, ".md2s-quiz-answer", false);
      visible(root, ".md2s-quiz-dist-block", false);
      visible(root, ".md2s-quiz-board-block", false);
      visible(root, ".md2s-quiz-actions", false);
      return;
    }

    stem.textContent = state.stem || "等待发题…";
    visible(root, ".md2s-quiz-metrics", true);
    visible(root, ".md2s-quiz-stat", true);
    online.textContent = String(state.online || 0);
    answered.textContent = String(state.answered || 0);

    var optsSig = JSON.stringify([phase, options, answer, state.stem]);
    if (bag.sigs.opts !== optsSig) {
      bag.sigs.opts = optsSig;
      var optsBox = root.querySelector(".md2s-quiz-opts");
      optsBox.innerHTML = "";
      options.forEach(function (text, i) {
        var row = document.createElement("div");
        row.className = "md2s-quiz-opt" + (revealed && answer === letterOf(i) ? " md2s-quiz-correct" : "");
        var b = document.createElement("b");
        b.textContent = letterOf(i) + ".";
        var span = document.createElement("span");
        span.textContent = text;
        row.appendChild(b);
        row.appendChild(span);
        optsBox.appendChild(row);
      });
    }

    visible(root, ".md2s-quiz-answer", revealed);
    answerEl.innerHTML = revealed
      ? "正确答案 <b>" + esc(answer || "—") + "</b>"
      : "";

    if (phase === "running") {
      clock.className = "md2s-quiz-clock";
      clock.textContent = Math.max(0, state.remainingSec || 0) + "s";
      visible(root, ".md2s-quiz-prog", true);
      var ratio = state.limitSec
        ? Math.max(0, Math.min(100, ((state.remainingSec || 0) / state.limitSec) * 100))
        : 0;
      root.querySelector(".md2s-quiz-prog i").style.width = ratio.toFixed(1) + "%";
      stat.innerHTML = "作答进行中 · 同学提交后实时刷新";
    } else if (revealed) {
      clock.className = "md2s-quiz-clock md2s-quiz-done";
      clock.textContent = "已揭晓";
      visible(root, ".md2s-quiz-prog", false);
      var dist0 = state.reveal.distribution || [];
      var total = dist0.reduce(function (a, b) { return a + (Number(b) || 0); }, 0);
      var ai = answer ? answer.charCodeAt(0) - 65 : -1;
      var right = ai >= 0 ? (dist0[ai] || 0) : 0;
      var rate = total ? Math.round((right / total) * 100) : 0;
      var fast = state.reveal.fastest && state.reveal.fastest.durationMs
        ? " · 最快 " + esc(state.reveal.fastest.studentNo || "—") +
          "（" + (state.reveal.fastest.durationMs / 1000).toFixed(1) + "s）"
        : "";
      stat.innerHTML = "正确率 <b>" + rate + "%</b>" + fast;
    } else {
      clock.className = "md2s-quiz-clock md2s-quiz-waiting";
      clock.textContent = "等待发题";
      visible(root, ".md2s-quiz-prog", false);
      stat.textContent = phase === "idle" ? "发题后开始倒计时与实时统计" : "等待实况…";
    }

    var distCounts = (state.reveal && state.reveal.distribution) || [];
    var distSig = JSON.stringify([phase, options, distCounts, answer]);
    if (bag.sigs.dist !== distSig) {
      bag.sigs.dist = distSig;
      var distBox = root.querySelector(".md2s-quiz-dist");
      distBox.innerHTML = "";
      var max = Math.max.apply(null, [1].concat(distCounts));
      options.forEach(function (_, i) {
        var count = Number(distCounts[i]) || 0;
        var row = document.createElement("div");
        row.className = "md2s-quiz-drow" + (revealed && answer === letterOf(i) ? " md2s-quiz-correct" : "");
        var l = document.createElement("span"); l.className = "dletter"; l.textContent = letterOf(i);
        var bar = document.createElement("span"); bar.className = "dbar";
        var fill = document.createElement("i");
        fill.style.width = Math.round((count / max) * 100) + "%";
        bar.appendChild(fill);
        var c = document.createElement("span"); c.className = "dcount"; c.textContent = String(count);
        row.appendChild(l); row.appendChild(bar); row.appendChild(c);
        distBox.appendChild(row);
      });
    }
    visible(root, ".md2s-quiz-dist-block", options.length > 0);

    var rows = revealed ? (state.leaderboard || (state.reveal && state.reveal.leaderboard) || []) : [];
    var rowSig = JSON.stringify(rows);
    if (bag.sigs.board !== rowSig) {
      bag.sigs.board = rowSig;
      var wrap = root.querySelector(".md2s-quiz-board-wrap");
      wrap.innerHTML = "";
      if (!rows.length) {
        wrap.textContent = "暂无作答记录";
        wrap.style.cssText = "font-size:15px;color:#8a97a5;padding:6px 2px";
      } else {
        wrap.style.cssText = "max-height:150px;overflow:auto;border:1px solid #e9edf2;border-radius:6px";
        var table = document.createElement("table");
        table.className = "md2s-quiz-board";
        table.innerHTML = "<thead><tr><th>#</th><th>学号</th><th class='n'>得分</th><th class='n'>答对</th></tr></thead>";
        var tbody = document.createElement("tbody");
        rows.slice(0, 12).forEach(function (r) {
          var tr = document.createElement("tr");
          tr.setAttribute("data-md2s-quiz-focus", "");
          tr.setAttribute("data-md2s-quiz-action", "row");
          if (r.offRoster) tr.className = "off";
          tr.innerHTML = "<td class='n'>" + esc(r.rank) + "</td><td>" +
            esc(r.studentNo || r.studentName || "—") + (r.offRoster ? " *" : "") +
            "</td><td class='n'>" + esc(r.score) + "</td><td class='n'>" +
            esc(r.correct) + "/" + esc(r.answers) + "</td>";
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
      }
    }
    visible(root, ".md2s-quiz-board-block", revealed && rows.length > 0);

    var actionsSig = JSON.stringify([phase, !!state.showControls]);
    if (bag.sigs.actions !== actionsSig) {
      bag.sigs.actions = actionsSig;
      var box = root.querySelector(".md2s-quiz-actions");
      box.innerHTML = "";
      if (state.showControls) {
        var defs = phase === "running"
          ? [["close", "收卷揭晓", "md2s-quiz-primary"], ["void", "作废", "md2s-quiz-danger"], ["exit", "退出", ""]]
          : phase === "revealed"
            ? [["reopen", "再来一次", "md2s-quiz-primary"], ["exit", "退出", ""]]
            : [["exit", "退出", ""]];
        defs.forEach(function (d) {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "md2s-quiz-action " + d[2];
          btn.setAttribute("data-md2s-quiz-focus", "");
          btn.setAttribute("data-md2s-quiz-action", d[0]);
          btn.textContent = d[1];
          box.appendChild(btn);
        });
      }
    }
    visible(root, ".md2s-quiz-actions", !!state.showControls);

    var voidBtn = root.querySelector('[data-md2s-quiz-action="void"]');
    if (voidBtn) {
      voidBtn.classList.toggle("md2s-quiz-danger", !!state.voidArmed);
      voidBtn.textContent = state.voidArmed ? "再按确定 = 作废" : "作废";
    }
    refreshFocus(root);

    // 翻页笔进场焦点沿用文枢旧语义：答题中落在「收卷揭晓」，揭晓后落在「退出」。
    // 必须先 refreshFocus 拿到本阶段的可聚焦节点，否则新挂载时 bag.focus 还是空数组。
    // 阶段切换时重置一次，遍历途中 render（倒计时刷新）不抢焦点。
    if (bag.lastFocusPhase !== phase) {
      bag.lastFocusPhase = phase;
      bag.focusIdx = phase === "running" ? 0 : Math.max(0, bag.focus.length - 1);
      paintFocus(root);
    }
  }

  function onKey(ev) {
    var root = this;
    var bag = root.__quizDeck;
    if (!bag) return;
    var k = ev.key;
    if (k === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      if (bag.opts.onClose) bag.opts.onClose();
      return;
    }
    if (k === "ArrowDown" || k === "ArrowUp") {
      ev.preventDefault();
      ev.stopPropagation();
      if (bag.focus.length) {
        bag.focusIdx = (bag.focusIdx + (k === "ArrowDown" ? 1 : -1) + bag.focus.length) % bag.focus.length;
        paintFocus(root);
      }
      return;
    }
    if (k === "Enter" || k === " " || k === "Spacebar") {
      ev.preventDefault();
      ev.stopPropagation();
      var cur = bag.focus[bag.focusIdx];
      if (cur && cur.getAttribute("data-md2s-quiz-action")) {
        var action = cur.getAttribute("data-md2s-quiz-action");
        if (bag.opts.onAction) bag.opts.onAction(action);
      }
      return;
    }
    if (k === "PageUp" || k === "PageDown" || k === "ArrowLeft" || k === "ArrowRight" ||
        k === "Home" || k === "End") {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  function mount(state, opts) {
    injectCss();
    var root = document.createElement("div");
    root.className = "md2s-quiz-ov";
    root.__quizDeck = { bag: true, sigs: {}, focus: [], focusIdx: 0, opts: opts || {}, state: null };
    root.__quizDeckKey = function (ev) { onKey.call(root, ev); };
    // 只挂 document capture：按钮在浮层内，事件必然经过 document；两者都挂会双触发。
    document.addEventListener("keydown", root.__quizDeckKey, true);
    document.body.appendChild(root);
    render(root, state);

    root.querySelector(".md2s-quiz-close").addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (root.__quizDeck.opts.onClose) root.__quizDeck.opts.onClose();
    });
    root.addEventListener("click", function (ev) {
      if (ev.target !== root) return;
      if (root.__quizDeck.opts.onClose) root.__quizDeck.opts.onClose();
    });
    root.addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest("[data-md2s-quiz-action]") : null;
      if (!btn || !root.contains(btn)) return;
      ev.preventDefault();
      ev.stopPropagation();
      var list = root.__quizDeck.focus;
      var idx = list.indexOf(btn);
      if (idx >= 0) root.__quizDeck.focusIdx = idx;
      if (root.__quizDeck.opts.onAction) {
        root.__quizDeck.opts.onAction(btn.getAttribute("data-md2s-quiz-action"));
      }
    });
    return root;
  }

  function destroy(root) {
    if (!root) return;
    if (root.__quizDeckKey) {
      document.removeEventListener("keydown", root.__quizDeckKey, true);
      root.removeEventListener("keydown", root.__quizDeckKey, true);
    }
    root.remove();
  }

  global.Md2sQuizDeck = { mount: mount, render: render, destroy: destroy, injectCss: injectCss };
})(window);
