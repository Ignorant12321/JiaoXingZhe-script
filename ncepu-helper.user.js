// ==UserScript==
// @name         侥幸者
// @namespace    ncepu-lab
// @version      1.6
// @description  华北电力大学实验室安全平台视频助手：可拖动悬浮窗，支持自动连播、拖动解锁、快速看完、自定义倍速(0.1~16x)、自动答题（含多选）
// @match        http://ncepu.jcedutec.cn:8802/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const LS_KEY = 'ncepu_video_helper';

    let comp = null;
    let state = { autoplay: true, seekUnlock: true, autoComplete: false, autoAnswer: false, rate: 1, listOrder: true, collapsed: false, paused: false };
    let visited = [];
    try {
        const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        Object.assign(state, saved.state || {});
        visited = saved.visited || [];
        state.collapsed = false; // 面板打开时始终展开，不记忆折叠状态
        state.listOrder = true; // 始终按列表顺序播放，开关已移除
        state.seekUnlock = true; // 始终解锁拖动，开关已移除
    } catch (e) {}

    function saveState() {
        try { localStorage.setItem(LS_KEY, JSON.stringify({ state, visited })); } catch (e) {}
    }

    // ---------- Vue 组件查找 ----------
    function findComponent() {
        const app = document.querySelector('#app');
        const vue = app && app.__vue__;
        if (!vue) return null;
        const seen = new Set();
        function walk(inst) {
            if (!inst || seen.has(inst)) return null;
            seen.add(inst);
            try {
                if (inst.currTime !== undefined && typeof inst.timeUpdate === 'function') return inst;
            } catch (e) {}
            if (inst.$children) {
                for (let i = 0; i < inst.$children.length; i++) {
                    const r = walk(inst.$children[i]);
                    if (r) return r;
                }
            }
            return null;
        }
        return walk(vue);
    }

    function getVideo() { return document.querySelector('video'); }

    // ---------- 防跳课解锁 + 答题点强制定位 ----------
    let seekUnlocked = false;
    function unlockSeek() {
        const v = getVideo();
        if (!v || seekUnlocked) return;
        comp = findComponent();
        if (!comp) return;
        v.addEventListener('timeupdate', function () {
            if (state.seekUnlock) comp.currTime = v.currentTime;
            // 高倍速下平台弹窗需 ejectTime 精确等于 parseInt(currentTime)，视频可能瞬间滑过答题点。
            // 检测到已越过答题点但弹窗未出现时，把进度精确设回答题点并暂停，强制触发平台弹窗。
            if (state.autoplay && !isQuizOpen()) {
                const qs = (comp.model && comp.model.questionRelaList) || [];
                const cur = v.currentTime;
                for (let i = 0; i < qs.length; i++) {
                    const t = parseFloat(qs[i].ejectTime);
                    const qid = qs[i].id;
                    if (isNaN(t)) continue;
                    // 距答题点 1 秒内先降到 1x，确保自然跨过时精确命中
                    if (t > cur && t - cur <= 1) {
                        if (v.playbackRate !== 1) v.playbackRate = 1;
                        return;
                    }
                    // 已越过答题点但弹窗没弹：回定位并暂停，强制触发
                    if (cur >= t && !forcedQuiz[qid] && t < v.duration) {
                        forcedQuiz[qid] = true;
                        comp.currTime = t;
                        v.pause();
                        v.currentTime = t;
                        return;
                    }
                }
            }
        }, true);
        seekUnlocked = true;
    }

    // ---------- 快速看完（逐题，答题点不跳过） ----------
    let fastMode = false;

    function startFastForward() {
        fastMode = true;
        jumpToNextQuizOrEnd();
    }

    function jumpToNextQuizOrEnd() {
        const v = getVideo();
        comp = findComponent();
        if (!v || !comp || !v.duration) return;
        const qs = (comp.model && comp.model.questionRelaList) || [];
        const cur = v.currentTime;
        // 找当前位置之后最近的未经过答题点
        const next = qs.filter(function (q) {
            return parseFloat(q.ejectTime) > cur + 1;
        }).sort(function (a, b) {
            return parseFloat(a.ejectTime) - parseFloat(b.ejectTime);
        })[0];
        if (next) {
            const t = parseFloat(next.ejectTime);
            if (state.seekUnlock) comp.currTime = t - 1;
            v.currentTime = t - 1;
            v.play().catch(function () {});
        } else {
            // 所有答题点已处理，跳结尾
            if (state.seekUnlock) comp.currTime = v.duration - 0.5;
            v.currentTime = v.duration - 0.5;
            v.play().catch(function () {});
            fastMode = false;
        }
    }

    function doFastForward() {
        startFastForward();
    }

    // ---------- 倍速 ----------
    function applyRate() {
        const v = getVideo();
        if (!v) return;
        v.playbackRate = Math.min(16, Math.max(0.1, state.rate));
    }

    // ---------- 自动连播 ----------
    let lastEnded = 0;

    function selectedCourseText() {
        const wrappers = document.querySelectorAll('.ant-tree-node-content-wrapper');
        for (let i = 0; i < wrappers.length; i++) {
            if (wrappers[i].className.indexOf('selected') !== -1) {
                return (wrappers[i].textContent || '').replace(/\s+/g, ' ').trim();
            }
        }
        return '';
    }

    // 从组件 treeData（完整内存数据）展平出所有课程节点，不依赖 DOM 展开状态
    function allCoursesFromTree() {
        comp = findComponent();
        if (!comp || !comp.treeData) return [];
        const out = [];
        (function walk(arr) {
            (arr || []).forEach(function (n) {
                if (n.children && n.children.length) {
                    walk(n.children);
                } else {
                    out.push({ key: n.key, title: (n.title || n.label || '').replace(/\s+/g, ' ').trim() });
                }
            });
        })(comp.treeData);
        return out;
    }

    // 展开 treeData 中某个分类（DOM 层面点击 switcher，因 antd defaultExpandedKeys 非受控）
    function expandCategory(catTitle) {
        const tree = document.querySelector('.ant-tree');
        if (!tree) return;
        const switchers = tree.querySelectorAll('.ant-tree-switcher');
        for (let i = 0; i < switchers.length; i++) {
            const li = switchers[i].closest('li');
            const t = li ? li.querySelector('.ant-tree-title') : null;
            if (!t) continue;
            const txt = (t.textContent || '').replace(/\s+/g, ' ').trim();
            if (txt === catTitle) {
                if (switchers[i].className.indexOf('open') === -1) switchers[i].click();
                return;
            }
        }
    }

    // 从 treeData 找某课程所属分类标题
    function categoryOf(key) {
        comp = findComponent();
        if (!comp || !comp.treeData) return '';
        for (let i = 0; i < comp.treeData.length; i++) {
            const cat = comp.treeData[i];
            if (cat.children && cat.children.some(function (n) { return n.key === key; })) {
                return cat.title || '';
            }
        }
        return '';
    }

    // 切换到指定课程（key），先展开所属分类再 onSelect，不受 DOM 展开状态影响
    function switchToCourse(key, title) {
        comp = findComponent();
        if (!comp || !comp.onSelect) return false;
        expandCategory(categoryOf(key));
        // 切换课程后重置答题点强制记录
        Object.keys(forcedQuiz).forEach(function (k) { delete forcedQuiz[k]; });
        const node = { eventKey: key, key: key, label: '1', title: title || '' };
        try {
            comp.onSelect([key], { node: node, selected: true, selectedNodes: [{ eventKey: key }] });
            // 切换后把选中课程滚动到可见区域
            setTimeout(function () {
                const sel = document.querySelector('.ant-tree-node-content-wrapper.selected');
                if (sel) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 600);
            return true;
        } catch (e) { return false; }
    }

    function findNextCourse() {
        const all = allCoursesFromTree();
        if (!all.length) return null;
        comp = findComponent();
        const curKey = comp && comp.model ? comp.model.id : null;
        const curIdx = all.findIndex(function (x) { return x.key === curKey; });
        if (state.listOrder) {
            // 按列表顺序：当前课程之后的第一门课程（不限学完/未学），不循环
            for (let j = curIdx + 1; j < all.length; j++) {
                return { key: all[j].key, title: all[j].title };
            }
            return null;
        }
        // 未学顺序：从当前课程之后找第一个"未学"
        for (let j = curIdx + 1; j < all.length; j++) {
            const t = all[j].title;
            if (t.indexOf('未学') !== -1 && visited.indexOf(t) === -1) {
                return { key: all[j].key, title: t };
            }
        }
        // 当前课程之后没有未学，则从开头再找一遍（循环）
        for (let j = 0; j < all.length; j++) {
            const t = all[j].title;
            if (t.indexOf('未学') !== -1 && visited.indexOf(t) === -1) {
                return { key: all[j].key, title: t };
            }
        }
        return null;
    }

    function onEnded() {
        if (!state.autoplay) return;
        const v = getVideo();
        if (!v || !v.ended) return;
        if (Date.now() - lastEnded < 8000) return;
        lastEnded = Date.now();
        fastMode = false;
        comp = findComponent();
        const curTitle = comp && comp.model ? (comp.model.name || '') : '';
        if (curTitle) visited.push(curTitle);
        saveState();
        const next = findNextCourse();
        if (next) {
            switchToCourse(next.key, next.title);
        } else {
            console.log('[NCEPU] 无更多课程可切换');
        }
    }

    // ---------- 自动看完 ----------
    let lastFF = 0;
    function autoFastForward() {
        if (!state.autoplay || !state.autoComplete) return;
        const v = getVideo();
        if (!v || !v.duration) return;
        if (v.paused || v.ended) return;
        if (Date.now() - lastFF < 6000) return;
        // 仅当进度还靠前时才跳，避免对刚跳到结尾的视频反复触发
        if (v.currentTime >= v.duration - 5) return;
        lastFF = Date.now();
        // 逐题处理：跳到下一个答题点或结尾（不设置 fastMode，避免残留导致关闭后仍跳）
        jumpToNextQuizOrEnd();
    }

    // ---------- 答题处理 ----------
    function isQuizOpen() {
        comp = findComponent();
        return comp ? !!comp.showModal : false;
    }

    // 获取当前正在作答的题目：优先用弹窗 questionId 精确匹配，其次 timeStamp，最后按播放进度
    function currentQuestion() {
        const v = getVideo();
        comp = findComponent();
        if (!comp || !comp.model) return null;
        const qs = comp.model.questionRelaList || [];
        if (!qs.length) return null;
        // 弹窗当前题 id 最可靠（高倍速下 timeStamp 可能被后续 timeupdate 更新掉）
        if (comp.questionId) {
            const hit = qs.find(function (x) { return String(x.id) === String(comp.questionId); });
            if (hit) return hit;
        }
        // 组件 timeStamp 是当前答题点的精确时间戳
        if (comp.timeStamp) {
            const ts = Math.floor(parseFloat(comp.timeStamp));
            const hit = qs.find(function (x) { return Math.floor(parseFloat(x.ejectTime)) === ts; });
            if (hit) return hit;
        }
        if (!v) return qs[0];
        const cur = v.currentTime;
        let best = null;
        for (let i = 0; i < qs.length; i++) {
            const t = parseFloat(qs[i].ejectTime);
            if (t <= cur + 2) {
                if (!best || t > parseFloat(best.ejectTime)) best = qs[i];
            }
        }
        return best || qs[0];
    }

    // 从组件内存中直接读当前题目的正确答案（无需题库）
    function answerFromComponent(q) {
        if (!q) return null;
        return q.correctAnswer || null;
    }

    // 根据题型设置答案到组件字段（不点 DOM，避免 checkbox/radio 绑定不生效）
    // kind 1/2 单选/判断 -> option；kind 3 多选 -> selectedValues
    function setAnswer(comp, q, answer) {
        if (!comp || !q || !answer) return false;
        const kind = String(q.kind || (comp.model && comp.model.kind) || '2');
        const letters = String(answer).replace(/\s+/g, '').split(',').filter(Boolean).map(function (s) { return s.toUpperCase(); });
        if (kind === '3') {
            comp.selectedValues = letters;
            return letters.length > 0;
        }
        comp.option = letters[0] || '';
        return !!comp.option;
    }

    function submitModal() {
        setTimeout(function () {
            const m = document.querySelector('.ant-modal-wrap');
            if (!m || getComputedStyle(m).display === 'none') return;
            const btns = m.querySelectorAll('button');
            for (let i = 0; i < btns.length; i++) {
                if ((btns[i].textContent || '').indexOf('提') !== -1) { btns[i].click(); break; }
            }
        }, 400);
    }

    function autoAnswerQuiz() {
        if (!state.autoAnswer) return;
        comp = findComponent();
        const modal = document.querySelector('.ant-modal-wrap');
        if (!comp || !modal || getComputedStyle(modal).display === 'none') return;
        const q = currentQuestion();
        const ans = answerFromComponent(q);
        if (ans && setAnswer(comp, q, ans)) {
            submitModal();
        }
    }

    // ---------- 悬浮窗 ----------
    let panel, dragging = false, dragStart = null;
    const oldPos = {};
    const forcedQuiz = {}; // 已强制定位过的答题点（按题 id）

    function buildPanel() {
        if (document.getElementById('ncepu-helper')) return;
        const style = document.createElement('style');
        style.id = 'ncepu-helper-style';
        style.textContent = `
#ncepu-helper{position:fixed;top:120px;right:20px;z-index:999999;width:272px;background:#fff;border:1px solid #e6ebf2;border-radius:14px;box-shadow:0 12px 40px rgba(30,60,120,.16);font-family:'Microsoft YaHei',-apple-system,sans-serif;user-select:none;overflow:hidden;transition:box-shadow .2s}
#ncepu-helper:hover{box-shadow:0 14px 44px rgba(30,60,120,.22)}
#ncepu-helper .nh-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:linear-gradient(135deg,#2f6fed,#5b8def);color:#fff;cursor:move;font-size:14px;font-weight:600}
#ncepu-helper .nh-head .nh-dot{width:8px;height:8px;border-radius:50%;background:#6cff8f;box-shadow:0 0 6px rgba(108,255,143,.8);animation:nhpulse 2s infinite}
#ncepu-helper .nh-head .nh-title{flex:1;letter-spacing:.5px;text-shadow:0 1px 2px rgba(0,0,0,.15)}
#ncepu-helper .nh-head .nh-ver{font-size:10px;font-weight:400;opacity:.85;background:rgba(255,255,255,.25);padding:1px 7px;border-radius:9px;border:1px solid rgba(255,255,255,.2)}
#ncepu-helper .nh-collapse,#ncepu-helper .nh-hbtn{width:24px;height:24px;border:none;border-radius:7px;background:rgba(255,255,255,.2);color:#fff;font-size:12px;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .15s,transform .1s}
#ncepu-helper .nh-collapse:hover,#ncepu-helper .nh-hbtn:hover{background:rgba(255,255,255,.34)}
#ncepu-helper .nh-collapse:active,#ncepu-helper .nh-hbtn:active{transform:scale(.92)}
#ncepu-helper .nh-body{padding:10px 14px 14px;font-size:13px;color:#333}
#ncepu-helper .nh-sec{display:flex;align-items:center;gap:7px;margin:12px 0 2px;font-size:11px;color:#7c8698;font-weight:600;letter-spacing:1.5px}
#ncepu-helper .nh-sec:first-child{margin-top:2px}
#ncepu-helper .nh-sec::before{content:"";width:3px;height:13px;border-radius:2px;background:linear-gradient(180deg,#2f6fed,#5b8def)}
#ncepu-helper .nh-row{display:flex;align-items:center;justify-content:space-between;padding:7px 2px;border-radius:7px;transition:background .18s,padding .18s}
#ncepu-helper .nh-row:hover{background:#f6f9ff}
#ncepu-helper .nh-label{flex:1;color:#3a4150;font-size:13px}
#ncepu-helper .nh-rate{display:flex;align-items:center;gap:6px}
#ncepu-helper .nh-rate input{width:54px;padding:4px 7px;border:1px solid #d5dbe6;border-radius:7px;font-size:12px;outline:none;transition:border-color .15s,box-shadow .15s}
#ncepu-helper .nh-rate input:focus{border-color:#2f6fed;box-shadow:0 0 0 3px rgba(47,111,237,.12)}
#ncepu-helper .nh-rate-presets{display:flex;gap:4px;margin:2px 0 2px;padding-left:2px}
#ncepu-helper .nh-rate-presets .nh-rate-preset{flex:1;padding:4px 0;font-size:11px;background:#f1f4f9;color:#4a5568;box-shadow:none;transition:background .18s,color .18s,transform .12s}
#ncepu-helper .nh-rate-presets .nh-rate-preset:hover{background:#e2e8f0;color:#2d3748;box-shadow:none;transform:translateY(-1px)}
#ncepu-helper .nh-rate-presets .nh-rate-preset:active{transform:scale(.94)}
#ncepu-helper .nh-rate-presets .nh-rate-preset.active{background:#2f6fed;color:#fff}
#ncepu-helper .nh-btn{padding:5px 11px;border:none;border-radius:7px;background:#2f6fed;color:#fff;cursor:pointer;font-size:12px;transition:background .15s,transform .1s,box-shadow .15s}
#ncepu-helper .nh-btn:hover{background:#2456c9;box-shadow:0 3px 10px rgba(47,111,237,.3)}
#ncepu-helper .nh-btn:active{transform:scale(.95)}
#ncepu-helper .nh-btn.nh-ghost{background:#f1f4f9;color:#4a5568;box-shadow:none}
#ncepu-helper .nh-btn.nh-ghost:hover{background:#e2e8f0;color:#2d3748;box-shadow:none}
#ncepu-helper .nh-btn.nh-danger{background:#fdeded;color:#d64545;box-shadow:none}
#ncepu-helper .nh-btn.nh-danger:hover{background:#fbe0e0;box-shadow:none}
#ncepu-helper .nh-switch{position:relative;width:40px;height:22px;flex-shrink:0;cursor:pointer}
#ncepu-helper .nh-switch .track{position:absolute;inset:0;background:#ccd3de;border-radius:11px;transition:background .25s}
#ncepu-helper .nh-switch .thumb{position:absolute;top:2px;left:2px;width:18px;height:18px;background:#fff;border-radius:50%;transition:left .28s cubic-bezier(.34,1.56,.64,1);box-shadow:0 1px 4px rgba(0,0,0,.3)}
#ncepu-helper .nh-switch.on .track{background:#2f6fed}
#ncepu-helper .nh-switch.on .thumb{left:20px}
#ncepu-helper .nh-status{margin:10px -14px -14px;padding:10px 14px;font-size:11px;color:#8a94a6;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:opacity .3s,background-color .3s,border-color .3s,transform .15s,box-shadow .15s;border-top:1px solid #edf1f7;background:#fbfcfe;line-height:1.5;cursor:pointer;border-bottom-left-radius:14px;border-bottom-right-radius:14px}
#ncepu-helper .nh-status.nh-fade{opacity:0}
#ncepu-helper .nh-status.nh-red{color:#c0392b;font-weight:600;background:linear-gradient(135deg,#fdf3f2,#f9e7e6);border-top:1px solid #f0d5d3;transition:opacity .3s,background .3s,border-color .3s,transform .15s,box-shadow .15s}
#ncepu-helper .nh-status.nh-red:hover{background:linear-gradient(135deg,#fdeae8,#f8dedc)}
#ncepu-helper .nh-status.nh-red:active{transform:scale(.98);box-shadow:inset 0 2px 8px rgba(192,57,43,.15)}
#ncepu-helper .nh-status.nh-red::before{content:"⚠ ";font-size:11px}
#ncepu-helper .nh-status.nh-click{animation:nhclick .26s ease}
#ncepu-helper .nh-actions{display:flex;gap:6px;margin-bottom:2px}
#ncepu-helper .nh-actions .nh-btn{flex:1;padding:7px 4px;font-size:12px;transition:background .18s,color .18s,transform .12s,box-shadow .18s}
#ncepu-helper .nh-actions .nh-btn:hover{transform:translateY(-1px)}
#ncepu-helper .nh-actions .nh-btn:active{transform:scale(.95)}
#ncepu-helper .nh-actions .nh-btn.nh-warn{background:#f0f4ff;color:#2f6fed}
#ncepu-helper .nh-actions .nh-btn.nh-warn:hover{background:#e2ebff}
#ncepu-helper .nh-actions .nh-btn.nh-run{background:#2f6fed;color:#fff;font-weight:600}
#ncepu-helper .nh-actions .nh-btn.nh-run:hover{background:#2456c9}
#ncepu-helper .nh-actions .nh-btn.nh-stop{background:#fdeded;color:#d64545}
#ncepu-helper .nh-actions .nh-btn.nh-stop:hover{background:#fbe0e0}
#ncepu-helper .nh-warning{padding:18px 14px;text-align:center;animation:nhfade .35s ease}
#ncepu-helper .nh-warn-icon{font-size:34px;line-height:1;animation:nhbounce 2.4s infinite}
#ncepu-helper .nh-warn-title{font-size:14px;font-weight:600;margin:8px 0 2px;color:#333}
#ncepu-helper .nh-warn-desc{font-size:12px;color:#5b6472;line-height:1.7;text-align:left;background:#f7f9fc;border-radius:8px;padding:8px 10px;margin:10px 0;border:1px solid #eef1f6}
#ncepu-helper .nh-warn-desc li{margin:2px 0}
#ncepu-helper .nh-warn-btn{width:100%;padding:9px;border:none;border-radius:8px;background:linear-gradient(135deg,#2f6fed,#5b8def);color:#fff;font-size:13px;font-weight:600;cursor:pointer;transition:background .2s,box-shadow .2s,transform .12s;box-shadow:0 3px 12px rgba(47,111,237,.3)}
#ncepu-helper .nh-warn-btn:hover{background:linear-gradient(135deg,#2456c9,#4a7be0);box-shadow:0 5px 16px rgba(47,111,237,.4);transform:translateY(-1px)}
#ncepu-helper .nh-warn-btn:active{transform:scale(.97)}
#ncepu-helper .nh-warn-foot{font-size:10px;color:#a0a8b8;margin-top:10px;text-align:center}
#ncepu-helper .nh-warn-dev{font-size:10px;color:#a0a8b8;margin-bottom:2px;text-align:center}
#ncepu-helper .nh-main{display:none}
#ncepu-helper.show-main .nh-warning{display:none}
#ncepu-helper.show-main .nh-main{display:block;animation:nhfade .35s ease}
#ncepu-helper .nh-warning{animation:nhfade .35s ease}
#ncepu-helper.collapsed .nh-main{display:none}
#ncepu-helper.collapsed .nh-warning{display:none}
#ncepu-helper.collapsed .nh-body{padding:0 12px 0}
#ncepu-helper.collapsed .nh-status{margin:0 -12px 0;border-top:none;border-bottom-left-radius:14px;border-bottom-right-radius:14px}
@keyframes nhfade{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
@keyframes nhpulse{0%,100%{box-shadow:0 0 5px rgba(108,255,143,.6)}50%{box-shadow:0 0 12px rgba(108,255,143,1)}}
@keyframes nhbounce{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
@keyframes nhclick{0%{transform:scale(1)}35%{transform:scale(.94)}70%{transform:scale(1.03)}100%{transform:scale(1)}}
`;
        document.head.appendChild(style);

        panel = document.createElement('div');
        panel.id = 'ncepu-helper';
        panel.innerHTML = `
<div class="nh-head"><span class="nh-dot"></span><span class="nh-title">侥幸者</span><button class="nh-hbtn" id="nh-toggle">⏸</button><button class="nh-collapse" id="nh-collapse">−</button><button class="nh-hbtn" id="nh-reload">×</button></div>
<div class="nh-body">
  <div class="nh-warning">
    <div class="nh-warn-icon">⚠️</div>
    <div class="nh-warn-title">使用警告</div>
    <ul class="nh-warn-desc">
      <li>您可以跳过视频，但跳不过危险；唯有敬畏，才能护您周全</li>
      <li>请您确认风险后再使用</li>
    </ul>
    <button class="nh-warn-btn" id="nh-accept">我已了解，进入使用</button>
  </div>
  <div class="nh-main">
  <div class="nh-actions">
    <button class="nh-btn nh-warn" id="nh-back">⚠ 使用警告</button>
  </div>
  <div class="nh-sec">自动模式</div>
  <div class="nh-row"><span class="nh-label">自动连播</span><div class="nh-switch" data-key="autoplay"><div class="track"></div><div class="thumb"></div></div></div>
  <div class="nh-row"><span class="nh-label">自动看完</span><div class="nh-switch" data-key="autoComplete"><div class="track"></div><div class="thumb"></div></div></div>
  <div class="nh-row"><span class="nh-label">自动答题</span><div class="nh-switch" data-key="autoAnswer"><div class="track"></div><div class="thumb"></div></div></div>
  <div class="nh-sec">播放控制</div>
  <div class="nh-row"><span class="nh-label">快速看完</span><button class="nh-btn" id="nh-fast">跳至结尾</button></div>
  <div class="nh-row"><span class="nh-label">倍速</span><div class="nh-rate"><input id="nh-rate" type="number" min="0.1" max="16" step="0.1" value="1"><button class="nh-btn" id="nh-rate-set">设置</button></div></div>
  <div class="nh-rate-presets"><button class="nh-btn nh-rate-preset" data-rate="1">1x</button><button class="nh-btn nh-rate-preset" data-rate="2">2x</button><button class="nh-btn nh-rate-preset" data-rate="4">4x</button><button class="nh-btn nh-rate-preset" data-rate="8">8x</button><button class="nh-btn nh-rate-preset" data-rate="16">16x</button></div>
  </div>
  <div class="nh-status" id="nh-status"></div>
</div>`;
        document.body.appendChild(panel);

        panel.querySelectorAll('.nh-switch').forEach(function (sw) {
            sw.addEventListener('click', function () {
                const key = sw.dataset.key;
                state[key] = !state[key];
                if (key === 'autoComplete' && !state.autoComplete) {
                    fastMode = false;
                }
                render();
                if (key === 'rate') applyRate();
                saveState();
            });
        });

        panel.querySelector('#nh-fast').addEventListener('click', doFastForward);
        panel.querySelector('#nh-rate').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') setRate();
        });
        panel.querySelector('#nh-rate-set').addEventListener('click', setRate);
        panel.querySelectorAll('.nh-rate-preset').forEach(function (b) {
            b.addEventListener('click', function () {
                state.rate = Math.min(16, Math.max(0.1, parseFloat(b.dataset.rate)));
                panel.querySelector('#nh-rate').value = state.rate;
                applyRate();
                render();
                saveState();
            });
        });

        panel.querySelector('#nh-toggle').addEventListener('click', function () {
            state.paused = !state.paused;
            const v = getVideo();
            if (v) {
                if (state.paused) v.pause();
                else v.play().catch(function () {});
            }
            render();
            saveState();
        });
        panel.querySelector('#nh-reload').addEventListener('click', function () {
            location.reload();
        });
        [panel.querySelector('#nh-toggle'), panel.querySelector('#nh-reload')].forEach(function (b) {
            if (b) b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
        });
        panel.querySelector('#nh-collapse').addEventListener('click', function (e) {
            e.stopPropagation();
            state.collapsed = !state.collapsed;
            panel.classList.toggle('collapsed', state.collapsed);
            panel.querySelector('#nh-collapse').textContent = state.collapsed ? '+' : '−';
            saveState();
        });        panel.querySelector('#nh-accept').addEventListener('click', function () {
            panel.classList.add('show-main');
            state.paused = false;
            const v = getVideo();
            if (v && v.paused && state.autoplay) v.play().catch(function () {});
            render();
            saveState();
        });
        panel.querySelector('#nh-back').addEventListener('click', function () {
            goBackToWarning();
        });
        panel.querySelector('#nh-status').addEventListener('click', function () {
            const st = panel.querySelector('#nh-status');
            st.classList.remove('nh-click');
            void st.offsetWidth;
            st.classList.add('nh-click');
            setTimeout(goBackToWarning, 260);
        });
        function goBackToWarning() {
            panel.classList.remove('show-main');
            state.paused = true;
            const v = getVideo();
            if (v) v.pause();
            render();
            saveState();
        }

        function setRate() {
            let v = parseFloat(panel.querySelector('#nh-rate').value);
            if (isNaN(v)) v = 1;
            state.rate = Math.min(16, Math.max(0.1, v));
            panel.querySelector('#nh-rate').value = state.rate;
            applyRate();
            saveState();
        }

        const head = panel.querySelector('.nh-head');
        head.addEventListener('mousedown', function (e) {
            dragging = true;
            dragStart = { x: e.clientX, y: e.clientY };
            const r = panel.getBoundingClientRect();
            oldPos.l = r.left; oldPos.t = r.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            panel.style.left = (oldPos.l + e.clientX - dragStart.x) + 'px';
            panel.style.top = (oldPos.t + e.clientY - dragStart.y) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', function () { dragging = false; });

        render();
    }

    function render() {
        if (!panel) return;
        panel.classList.toggle('collapsed', !!state.collapsed);
        panel.querySelector('#nh-collapse').textContent = state.collapsed ? '+' : '−';
        panel.querySelectorAll('.nh-switch').forEach(function (sw) {
            sw.classList.toggle('on', !!state[sw.dataset.key]);
        });
        const rateInp = panel.querySelector('#nh-rate');
        if (rateInp && document.activeElement !== rateInp) rateInp.value = state.rate;
        panel.querySelectorAll('.nh-rate-preset').forEach(function (b) {
            b.classList.toggle('active', parseFloat(b.dataset.rate) === state.rate);
        });
        const tb = panel.querySelector('#nh-toggle');
        if (tb) tb.textContent = (state.paused || !isConfirmed()) ? '▶' : '⏸';
        const st = document.getElementById('nh-status');
        if (st) {
            const text = '安全不可儿戏，生命无法加速';
            st.classList.add('nh-red');
            if (st.textContent !== text) {
                st.textContent = text;
            }
        }
    }

    // ---------- 主循环 ----------
    let prevModal = false;
    function isConfirmed() {
        const p = document.getElementById('ncepu-helper');
        return p ? p.classList.contains('show-main') : false;
    }
    // 未确认时在捕获阶段拦截视频播放，杜绝平台自身自动播放
    let playGuarded = null;
    function guardPlay() {
        const v = getVideo();
        if (!v || playGuarded === v) return;
        playGuarded = v;
        v.addEventListener('play', function () {
            if (!isConfirmed()) v.pause();
        }, true);
    }
    setInterval(function () {
        const v = getVideo();
        if (!v) return;
        if (!isConfirmed()) {
            if (!v.paused) v.pause();
            guardPlay();
            render();
            return;
        }
        if (state.paused) {
            if (!v.paused) v.pause();
            render();
            return;
        }
        unlockSeek();
        if (state.rate !== 1 && v.playbackRate !== state.rate) applyRate();
        const modalNow = isQuizOpen();
        // 答题弹窗打开时：立即暂停视频（防高倍速下滑过答题点），自动连播+自动答题同时开启才自动作答
        if (modalNow) {
            if (!v.paused) v.pause();
            if (state.autoAnswer && state.autoplay) autoAnswerQuiz();
            prevModal = true;
            render();
            return;
        }
        // 弹窗刚关闭（刚答完一题）：自动连播+自动看完/快速看完模式下继续跳到下一题或结尾
        if (prevModal && state.autoplay && (state.autoComplete || fastMode)) {
            prevModal = false;
            jumpToNextQuizOrEnd();
            render();
            return;
        }
        prevModal = false;
        autoFastForward();
        if (v.ended) {
            onEnded();
        } else if (v.paused && state.autoplay) {
            v.play().catch(function () {});
        }
        render();
    }, 500);

    // ---------- 初始化 ----------
    setTimeout(function () {
        buildPanel();
        render();
        if (state.paused || !isConfirmed()) {
            const v = getVideo();
            if (v) v.pause();
            return;
        }
        unlockSeek();
        if (state.autoplay) {
            const v = getVideo();
            if (v && v.paused) v.play().catch(function () {});
        }
        applyRate();
    }, 1000);
})();