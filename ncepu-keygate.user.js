// ==UserScript==
// @name         侥幸者
// @namespace    ncepu-lab
// @version      3.0.0
// @description  刷课辅助：跳过视频/自动连播/自动看完/自动答题/倍速(0.1~16x)/自动翻页，需注册码激活（Keygate 版）
// @match        http://ncepu.jcedutec.cn:8802/*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 侥幸者 —— Keygate 版（原作者 ncepu-helper.user.js + 注册码授权）
     * 面板三个视图：风险警告 -> 注册码验证 -> 主界面
     * 未激活时主脚本 isConfirmed() 恒为 false，功能全部不执行。
     *
     * Keygate 差异：
     *   - 一个注册码可按「计划激活数」绑定多台设备（如 100 个名额）
     *   - license_key 本身就是凭证，脚本不再暴露任何 API 密钥
     *   - /license/verify 把「无效/过期/停用/他机」全部塌缩为 404，
     *     客户端据此区分「服务端拒绝」与「网络不可达」
     * ============================================================ */
    // ============================================================
    // 一、授权配置：只填 Keygate 的地址（前端与 API 同一个端口，默认 9000）
    // 不需要 API_KEY / SECRET / PROJECT_ID。
    // ============================================================
    // const API_BASE = 'http://localhost:9000';   // Keygate 部署地址
    const API_BASE = 'https://key.ignorant.top';   // Keygate 部署地址
    const RECHECK_MS = 6 * 60 * 60 * 1000;   // 本地凭证 6 小时后联网复核
    const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000;   // 仅「真断网」时的离线宽限期
    const TIMEOUT_MS = 12000;
    const CACHE_SALT = 'ncepu-kg-cache-v1';   // 本地缓存签名盐（防手改 localstorage，非安全密钥）

    // ============================================================
    // 二、SHA-256 / HMAC-SHA256
    // 页面是 http://（非安全上下文），crypto.subtle 不可用，故内置纯 JS 实现。
    // 已与 Node crypto 逐位比对通过。
    // ============================================================
        var K256 = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];
        function utf8Bytes(str) {
            var out = [];
            for (var i = 0; i < str.length; i++) {
                var c = str.charCodeAt(i);
                if (c < 0x80) out.push(c);
                else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
                else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
                    var cp = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
                    out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
                } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            }
            return out;
        }
        function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
        function sha256Bytes(bytes) {
            var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
            var len = bytes.length;
            var total = len + 9;
            total += (64 - (total % 64)) % 64;
            var data = new Uint8Array(total);
            data.set(bytes);
            data[len] = 0x80;
            var dv = new DataView(data.buffer);
            dv.setUint32(total - 8, Math.floor(len / 536870912), false);
            dv.setUint32(total - 4, (len * 8) >>> 0, false);
            var w = new Uint32Array(64);
            for (var off = 0; off < total; off += 64) {
                var i;
                for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
                for (i = 16; i < 64; i++) {
                    var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                    var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
                }
                var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
                for (i = 0; i < 64; i++) {
                    var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                    var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
                    var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                    var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
                    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
                }
                H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
                H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
            }
            var out = new Uint8Array(32);
            var odv = new DataView(out.buffer);
            for (var j = 0; j < 8; j++) odv.setUint32(j * 4, H[j], false);
            return out;
        }
        function toHex(bytes) {
            var s = '';
            for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
            return s;
        }
        function hmacHex(secret, message) {
            var key = utf8Bytes(secret);
            if (key.length > 64) key = Array.prototype.slice.call(sha256Bytes(key));
            while (key.length < 64) key.push(0);
            var msg = utf8Bytes(message);
            var inner = new Uint8Array(64 + msg.length);
            var outer = new Uint8Array(96);
            for (var i = 0; i < 64; i++) {
                inner[i] = key[i] ^ 0x36;
                outer[i] = key[i] ^ 0x5c;
            }
            inner.set(msg, 64);
            outer.set(sha256Bytes(inner), 64);
            return toHex(sha256Bytes(outer));
        }

    // ============================================================
    // 三、Keygate 客户端
    // 公共 SDK 端点 /api/v1/license/*：无需签名、无需 API_KEY，
    // 请求体里的 license_key + identifier 就是凭证。
    // 响应统一信封：{ success, data } 或 { success:false, error:{code,message,details} }
    // ============================================================

    // 构造带 code/status/details 的业务错误，便于区分「服务端拒绝」与「网络不可达」
    function appErr(status, code, message, details) {
        const e = new Error(message || ('HTTP ' + status));
        e.status = status;
        e.code = code;
        e.details = details || null;
        return e;
    }
    function tryJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
    // 成功信封 -> data；失败信封 -> 抛 appErr
    function unwrapEnv(j) {
        if (j && j.success === true && Object.prototype.hasOwnProperty.call(j, 'data')) return j.data;
        if (j && j.success === false && j.error) throw appErr(0, j.error.code, j.error.message, j.error.details);
        return j;
    }
    function buildAppErr(status, body) {
        const j = typeof body === 'string' ? tryJson(body) : body;
        if (j && j.error && j.error.code) return appErr(status, j.error.code, j.error.message, j.error.details);
        return appErr(status, '', 'HTTP ' + status, null);
    }

    function apiCall(method, path, bodyObj) {
        const payload = bodyObj === null ? '' : JSON.stringify(bodyObj);
        const headers = { 'Content-Type': 'application/json' };
        const url = API_BASE + path;

        // 油猴：走扩展后台请求，不受 CORS / 私有网络保护(PNA)限制
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise(function (resolve, reject) {
                GM_xmlhttpRequest({
                    method: method,
                    url: url,
                    headers: headers,
                    data: bodyObj === null ? undefined : payload,
                    timeout: TIMEOUT_MS,
                    onload: function (r) {
                        if (r.status < 200 || r.status >= 300) {
                            reject(buildAppErr(r.status, r.responseText));
                            return;
                        }
                        try { resolve(unwrapEnv(JSON.parse(r.responseText))); }
                        catch (e) { if (e && e.code) { reject(e); return; } reject(new Error('响应解析失败')); }
                    },
                    onerror: function () { reject(new Error('网络请求失败')); },
                    ontimeout: function () { reject(new Error('请求超时')); },
                    onabort: function () { reject(new Error('请求已中止')); }
                });
            });
        }
        // 控制台 / 非扩展环境：原生 fetch
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
        return fetch(url, {
            method: method,
            headers: headers,
            body: bodyObj === null ? undefined : payload,
            signal: ctl ? ctl.signal : undefined
        }).then(function (r) {
            if (timer) clearTimeout(timer);
            return r.json().then(function (j) {
                if (!r.ok) throw buildAppErr(r.status, j);
                return unwrapEnv(j);
            }, function () {
                throw appErr(r.status, '', 'HTTP ' + r.status, null);
            });
        });
    }

    // 激活：把本设备 identifier 绑定到该注册码。
    // 同设备重复激活返回 already_activated，不额外消耗名额；
    // 名额耗尽时服务端返回 409 ACTIVATION_LIMIT{max,current}。
    function activateOnServer(code) {
        return apiCall('POST', '/api/v1/license/activate', {
            license_key: code,
            identifier: getDeviceId(),
            identifier_type: 'device',
            label: '侥幸者-' + deviceLabel()
        });
    }
    // 复核：仅当注册码可用且「本设备已激活」时返回 200，
    // 其余（不存在/过期/停用/未在本机激活）全部塌缩为 404。
    function fetchStatus(code) {
        return apiCall('POST', '/api/v1/license/verify', {
            license_key: code,
            identifier: getDeviceId()
        });
    }
    function deviceLabel() {
        try { return String(navigator.platform || 'device').slice(0, 24); }
        catch (e) { return 'device'; }
    }
    // 服务端明确给出的拒绝原因（非 2xx 且携带 error.code）
    function serverRejectMessage(e) {
        const code = e && e.code;
        if (code === 'ACTIVATION_LIMIT') {
            const d = (e && e.details) || {};
            return '该注册码可绑定设备数已达上限（' + (d.current || '?') + '/' + (d.max || '?') + '）';
        }
        if (code === 'LICENSE_EXPIRED') return '注册码已过期';
        if (code === 'LICENSE_SUSPENDED') return '注册码已被暂停';
        if (code === 'LICENSE_REVOKED') return '注册码已被撤销';
        if (code === 'LICENSE_CANCELED') return '注册码已取消';
        if (code === 'LICENSE_NOT_FOUND' || (e && e.status === 404)) return '注册码无效';
        if (code === 'LOCKED_OUT' || (e && e.status === 429)) return '尝试次数过多，请稍后再试';
        if (e && e.status === 400) return '注册码格式不正确';
        return (e && e.message) || '注册码无效';
    }

    // ============================================================
    // 四、授权状态
    // ============================================================
    const LIC_LS_KEY = 'ncepu_license';
    const LIC_DEVICE_KEY = 'ncepu_license_device';

    const lic = { activated: false, pending: false, pendingP: null, code: '', expiresAt: 0, expiryKnown: true, message: '' };

    // 本地缓存不是凭证，只是「上次成功时的快照」，必须用 CACHE_SALT 签名。
    // 没有这一层的话，把 localStorage 里的 code 改成任意字符串，在离线宽限期也能蒙混过关。
    function cacheSig(code, expiresAt, device) {
        return hmacHex(CACHE_SALT, 'LIC1|' + code + '|' + (expiresAt || 0) + '|' + device).slice(0, 32);
    }

    function licLoad() {
        try {
            const s = JSON.parse(localStorage.getItem(LIC_LS_KEY) || 'null');
            if (!s || !s.code) return null;
            // 签名对不上 = 被人手改过，直接当作没有缓存
            if (s.sig !== cacheSig(s.code, s.expiresAt || 0, s.device || '')) return null;
            return s;
        } catch (e) { return null; }
    }
    function licSave() {
        try {
            const dev = getDeviceId();
            localStorage.setItem(LIC_LS_KEY, JSON.stringify({
                code: lic.code, expiresAt: lic.expiresAt, lastOnline: Date.now(),
                device: dev, sig: cacheSig(lic.code, lic.expiresAt, dev)
            }));
        } catch (e) {}
    }
    function licClear() { try { localStorage.removeItem(LIC_LS_KEY); } catch (e) {} }

    // 设备标识：激活时作为 identifier 传给服务端，服务端据此按名额计数，
    // 同一设备重复激活（already_activated）不会占用新名额。
    function getDeviceId() {
        try {
            let d = localStorage.getItem(LIC_DEVICE_KEY);
            if (d) return d;
            const buf = new Uint8Array(8);
            if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
            else for (let i = 0; i < 8; i++) buf[i] = Math.floor(Math.random() * 256);
            d = 'ncepu-' + toHex(buf);
            localStorage.setItem(LIC_DEVICE_KEY, d);
            return d;
        } catch (e) { return 'ncepu-unknown'; }
    }

    // Keygate 的 valid_until 是 RFC3339 字符串（UTC），null 表示永久；
    // grace_days 是到期后的宽限天数。用同一口径算本地过期时间。
    function normExpires(validUntil, graceDays) {
        if (!validUntil) return 0;
        const t = Date.parse(validUntil);
        if (!isFinite(t)) return 0;
        return t + (graceDays || 0) * 86400000;
    }
    function isExpired() { return !!lic.expiresAt && Date.now() > lic.expiresAt; }

    // 静默复核：只在后台确认本地注册码是否还有效，不改动任何界面状态。
    // 用于「每次进入警告界面后验证」——复核不该把用户从警告页拽到别的视图，
    // 失效时只把 lic.activated 置 false，等他点「我已了解，进入使用」时再要码。
    let silentCheck = false;

    // expiresAtKnown === false 表示「有效期未知」：激活成功但随后的详情复核失败。
    // 此时不能把 expiresAt 当成 0(=永久有效) 落盘，否则本来有期限的码
    // 会被本地缓存成永不过期。只在内存里放行，并安排一次快速复核去补齐。
    function markActivated(code, expiresAt, expiresAtKnown) {
        lic.activated = true;
        lic.code = code;
        lic.expiresAt = expiresAt || 0;
        lic.expiryKnown = expiresAtKnown !== false;
        lic.message = '';
        if (lic.expiryKnown) licSave(); else licClear();
        if (!silentCheck) enterMainNow();        // 校验通过 -> 进入主界面
        scheduleRecheck(lic.expiryKnown ? RECHECK_MS : 60 * 1000);
        console.log('[侥幸者] 注册码激活成功:', code, lic.expiryKnown ? '' : '(有效期未知, 60 秒后复核)');
    }

    function markRejected(message) {
        lic.activated = false;
        lic.message = message || '注册码无效';
        licClear();
        console.warn('[侥幸者] 注册码校验失败:', lic.message);
        if (!silentCheck) showGate(lic.message);
    }

    // 「服务端明确答复」和「网络不可达」是两回事：
    //   HTTP 4xx/5xx  -> 服务端答复了（码不存在/被禁），必须立刻失效，不许宽限
    //   TypeError / AbortError / 超时 -> 根本没连上，才允许走离线宽限
    // 早先的版本把两者都当成「离线」，等于「码不存在也能白嫖 7 天」。
    function isNetworkError(e) {
        if (!e) return false;
        if (e.name === 'TypeError' || e.name === 'AbortError') return true;   // fetch 断网 / 超时
        return /网络请求失败|请求超时|请求已中止|无法连接|Failed to fetch|NetworkError/i.test(String(e.message || ''));
    }

    // 只有真断网才允许离线宽限；且必须是签名有效、属于本机的缓存
    function softFail(message, err) {
        if (isNetworkError(err)) {
            const s = licLoad();
            if (s && s.code && s.device === getDeviceId() && !isExpired()
                && Date.now() - (s.lastOnline || 0) < OFFLINE_GRACE_MS) {
                console.warn('[侥幸者] 网络不可达，' + Math.round((OFFLINE_GRACE_MS - (Date.now() - (s.lastOnline || 0))) / 3600000) + ' 小时内离线放行');
                markActivated(s.code, s.expiresAt || 0, true);
                return;
            }
        }
        markRejected(message);
    }

    // 激活成功：顺带复核一次拿过期时间与宽限天数
    function afterVerified(code) {
        return fetchStatus(code).then(function (d) {
            markActivated(code, normExpires(d && d.valid_until, d && d.grace_days), true);
            return true;
        }).catch(function () {
            // 复核失败不代表码无效（activate 已经成功了），但有效期无从得知
            markActivated(code, 0, false);
            return true;
        });
    }

    function activate(code) {
        code = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!code) { markRejected('请输入注册码'); return Promise.resolve(false); }
        if (lic.pendingP) { showGate('正在校验中，请稍候再试'); return Promise.resolve(false); }
        if (!API_BASE) {
            markRejected('脚本未配置 Keygate 地址');
            return Promise.resolve(false);
        }
        const p = activateOnServer(code).then(function () {
            return afterVerified(code);
        }).catch(function (e) {
            // 带 code 的是服务端答复（含 404/403/409/429），立刻失效，不许宽限
            if (e && e.code) {
                markRejected(serverRejectMessage(e));
                return false;
            }
            softFail(isNetworkError(e) ? '无法连接服务器，请检查网络' : ('校验失败：' + e.message), e);
            return lic.activated;
        });
        lic.pending = true;
        lic.pendingP = p.then(function (r) { lic.pending = false; lic.pendingP = null; return r; },
            function (e) { lic.pending = false; lic.pendingP = null; throw e; });
        return lic.pendingP;
    }

    // 定期复核：只查状态，不再激活。
    // 同一时刻只发一个请求：连点「进入使用」会复用进行中的那次，不会打出一串请求。
    function recheck() {
        if (!lic.code) return Promise.resolve(false);
        if (lic.pendingP) return lic.pendingP;
        lic.pending = true;
        const p = fetchStatus(lic.code).then(function (d) {
            if (!d) { markRejected('注册码无效'); return false; }
            markActivated(lic.code, normExpires(d.valid_until, d.grace_days), true);
            return true;
        }).catch(function (e) {
            // 带 code 的是服务端答复（失效/停用/他机全为 404），与网络错误区分开
            if (e && e.code) {
                markRejected(serverRejectMessage(e));
                return false;
            }
            softFail(isNetworkError(e) ? '无法连接服务器' : ('注册码校验失败：' + e.message), e);
            return lic.activated;
        });
        lic.pendingP = p.then(function (r) { lic.pending = false; lic.pendingP = null; return r; },
            function (e) { lic.pending = false; lic.pendingP = null; throw e; });
        return lic.pendingP;
    }

    let recheckTimer = null;
    function scheduleRecheck(delay) {
        if (recheckTimer) clearTimeout(recheckTimer);
        recheckTimer = setTimeout(function () { recheck(); }, delay || RECHECK_MS);
    }

    // 每次进入警告界面都向服务端复核一次本地注册码（静默，不改界面）
    function verifyOnWarning() {
        if (!lic.code) return;
        silentCheck = true;
        recheck().then(function () {
            silentCheck = false;
            console.log('[侥幸者] 警告界面复核:', lic.activated ? '通过' : ('未通过 · ' + lic.message));
        }, function () { silentCheck = false; });
    }

    // ============================================================
    // 五、面板内的注册码界面
    // 视图状态由 #ncepu-helper 上的类决定：
    //   （无）        -> 风险警告
    //   show-gate     -> 注册码验证
    //   show-main     -> 主界面
    // ============================================================
    function showGate(message) {
        if (!panel) return;
        panel.classList.remove('show-main');
        panel.classList.add('show-gate');
        const tip = panel.querySelector('#ng-tip');
        if (tip) {
            tip.style.color = message ? '#c0392b' : '#8a94a6';
            tip.textContent = message || '';
        }
        const inp = panel.querySelector('#ng-code');
        if (inp) setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
    }

    // 切换到主界面（只做状态迁移，不代表已通过校验）
    function enterMainNow() {
        if (!panel) return;
        panel.classList.remove('show-gate');
        panel.classList.add('show-main');
        state.paused = false;
        const v = getVideo();
        if (v && v.paused && state.autoplay) v.play().catch(function () {});
        render();
        saveState();
    }

    // 点「我已了解，进入使用」：每次都向服务端复核，通过才放行。
    // 这是唯一的放行入口——面板上看到的界面/状态都不作为依据。
    function confirmAccess() {
        if (lic.pendingP) return lic.pendingP.then(function (r) { return lic.activated; });
        if (!lic.code) { showGate('请输入注册码后使用'); return Promise.resolve(false); }
        const btn = panel && panel.querySelector('#nh-accept');
        if (btn) btn.disabled = true;
        silentCheck = true;              // 切不切视图由本函数决定
        return recheck().then(function () {
            silentCheck = false;
            if (btn) btn.disabled = false;
            if (lic.activated) { enterMainNow(); return true; }
            showGate(lic.message || '注册码无效，请重新输入');
            return false;
        });
    }

    function wireGate() {
        if (!panel) return;
        const inp = panel.querySelector('#ng-code');
        const go = panel.querySelector('#ng-go');
        const retry = panel.querySelector('#ng-retry');
        if (inp) {
            inp.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && go) go.click();
            });
        }
        if (go) {
            go.addEventListener('click', function () {
                go.disabled = true;
                go.textContent = '校验中…';
                const tip = panel.querySelector('#ng-tip');
                if (tip) { tip.style.color = '#8a94a6'; tip.textContent = ''; }
                activate(inp ? inp.value : '').then(function (ok) {
                    go.disabled = false;
                    go.textContent = '激活并进入';
                    if (!ok) {
                        const t = panel.querySelector('#ng-tip');
                        if (t) { t.style.color = '#c0392b'; t.textContent = lic.message || '激活失败'; }
                    }
                });
            });
        }
        if (retry) {
            retry.addEventListener('click', function () { showGate(''); });
        }
    }

    // ============================================================
    // 六、侥幸者面板（原主脚本，已集成授权门控）
    // ============================================================
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
#ncepu-helper .ncepu-gate{display:none}
#ncepu-helper.show-gate .nh-warning{display:none!important}
#ncepu-helper.show-gate .ncepu-gate{display:block;animation:nhfade .35s ease}
#ncepu-helper.show-main .ncepu-gate{display:none!important}
#ncepu-helper.collapsed .ncepu-gate{display:none!important}
#ncepu-helper .ncepu-gate .ng-title{font-size:14px;font-weight:600;text-align:center;color:#333;margin:0 0 10px}
#ncepu-helper .ncepu-gate input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d5dbe6;border-radius:8px;font-size:12px;letter-spacing:1px;text-transform:uppercase;outline:none;transition:border-color .15s,box-shadow .15s}
#ncepu-helper .ncepu-gate input:focus{border-color:#2f6fed;box-shadow:0 0 0 3px rgba(47,111,237,.12)}
#ncepu-helper .ncepu-gate .ng-tip{text-align:center;min-height:18px;margin-top:9px;font-size:12px;line-height:1.5;color:#c0392b;word-break:break-all}
#ncepu-helper .ncepu-gate .ng-actions{margin-top:8px;display:flex;gap:8px}
#ncepu-helper .ncepu-gate .ng-btn{flex:1;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#2f6fed,#5b8def);color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 3px 12px rgba(47,111,237,.3)}
#ncepu-helper .ncepu-gate .ng-btn:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}
#ncepu-helper .ncepu-gate .ng-btn.ng-retry{flex:0 0 84px;background:#eef1f6;color:#5b6472;box-shadow:none}
#ncepu-helper .ncepu-gate .ng-foot{margin-top:12px;font-size:10px;color:#a0a8b8;text-align:center;line-height:1.7}
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
  <div class="ncepu-gate">
    <div class="ng-title">注册码验证</div>
    <div class="ng-row"><input id="ng-code" type="text" placeholder="XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false"></div>
    <div class="ng-tip" id="ng-tip"></div>
    <div class="ng-actions"><button class="ng-btn" id="ng-go">激活并进入</button><button class="ng-btn ng-retry" id="ng-retry">重新输入</button></div>
    <div class="ng-foot">本工具需有效注册码方可使用</div>
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
        });
        panel.querySelector('#nh-accept').addEventListener('click', function () {
            confirmAccess();     // 每次点击都向服务端复核，不看本地标志
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
            panel.classList.remove('show-gate');
            state.paused = true;
            const v = getVideo();
            if (v) v.pause();
            render();
            saveState();
            verifyOnWarning();      // 每次进入警告界面都复核一次注册码
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

        wireGate();
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
        if (!p || !p.classList.contains('show-main')) return false;
        // 未激活一律视为未确认：视频暂停、全部功能不执行
        return !!lic.activated;
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

    // ---------- 授权初始化 ----------
    (function initLicense() {
        const s = licLoad();          // 签名不对/被改过 -> null
        if (s && s.code) {
            // 缓存只用来预填输入框，绝不直接激活。
            // 必须先向服务端复核一次，通过之后才允许进入主界面。
            lic.code = s.code;
            lic.expiresAt = s.expiresAt || 0;
            setTimeout(function () { verifyOnWarning(); }, 400);
        }
        window.NCEPU_LICENSE = {
            get activated() { return lic.activated; },
            get code() { return lic.code; },
            get message() { return lic.message; },
            get device() { return getDeviceId(); },
            get mode() { return typeof GM_xmlhttpRequest === 'function' ? 'GM_xmlhttpRequest' : 'fetch'; },
            activate: activate, recheck: recheck, show: showGate, confirm: confirmAccess,
            __force: function (v) { lic.activated = !!v; },   // 测试钩子：伪造本地激活标志
            __probe: licLoad, __hmac: hmacHex
        };
        console.log('[侥幸者] 已启动 · 授权模式:', window.NCEPU_LICENSE.mode);
    })();
})();
