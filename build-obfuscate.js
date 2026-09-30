// 将 ncepu-keygate.user.js 混淆为 ncepu-keygate.obf.user.js
// 用法：Node.js 环境直接运行 `node build-obfuscate.js`
// 头部（// ==UserScript== ... // ==/UserScript==）原样保留，@grant GM_xmlhttpRequest 等元数据不会被破坏。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INPUT = 'ncepu-keygate.user.js';
const OUTPUT = 'ncepu-keygate.obf.user.js';

const headerRe = /^(\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==.*?\n)([\s\S]*)$/;

const obfOptions = {
    compact: true,
    target: 'browser',
    renameGlobals: false,                 // 关键：不改名宿主全局，GM_xmlhttpRequest/window/document/localStorage 保持原名
    selfDefending: true,                  // 代码被格式化/重排版时拒绝执行
    stringArray: true,
    stringArrayThreshold: 1,
    rotateStringArray: true,
    stringArrayEncoding: ['base64'],      // 字符串数组 base64 编码
    identifierNamesGenerator: 'hexadecimal',
    numbersToExpressions: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    transformObjectKeys: true,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.25,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    unicodeEscapeSequence: false,
    disableConsoleOutput: false,          // 保留 console 输出，方便出问题时排查；高安全可改 true
    debugProtection: false,               // 开启会让打开 DevTools 时页面卡死；高安全可改 true
    debugProtectionInterval: 0,
    sourceMap: false,
};

function main() {
    const src = fs.readFileSync(INPUT, 'utf8');
    const m = src.match(headerRe);
    if (!m) {
        console.error('[x] UserScript header not found in ' + INPUT);
        process.exit(1);
    }
    const header = m[1];
    let body = m[2];

    let obfuscator;
    try {
        obfuscator = require(path.join(__dirname, 'node_modules', 'javascript-obfuscator'));
    } catch (e) {
        console.error('[x] javascript-obfuscator not installed: run `npm install --no-save javascript-obfuscator` first');
        process.exit(2);
    }

    console.log('[*] Obfuscating (source ' + body.length + ' chars)...');
    const started = Date.now();
    const result = obfuscator.obfuscate(body, obfOptions).getObfuscatedCode();
    const out = header + '\n' + result;

    try {
        new vm.Script(out);               // compile-only, verify syntax
    } catch (e) {
        console.error('[x] obfuscated output failed syntax check: ' + e.message);
        process.exit(3);
    }

    fs.writeFileSync(OUTPUT, out);
    console.log('[ok] Done: ' + OUTPUT + ' (' + out.length + ' chars, ' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
    console.log('[i] Give this single file to classmates; the UserScript header is preserved.');
    console.log('[i] Harder mode: set disableConsoleOutput/debugProtection to true and rerun.');
}

main();