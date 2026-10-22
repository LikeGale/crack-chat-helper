// ==UserScript==
// @name         AI챗 기억 도우미 · 뜻 찾기 시험
// @namespace    crack-progress-helper-meaning-test
// @version      0.1.0
// @description  브라우저 안에서 뜻 계산 모델이 크랙 화면에서 도는지 한 번 확인하는 시험용 스크립트입니다. 확인이 끝나면 지워도 됩니다.
// @match        https://crack.wrtn.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      cdn.jsdelivr.net
// @connect      huggingface.co
// @connect      hf.co
// @connect      cas-bridge.xethub.hf.co
// @connect      cdn-lfs.huggingface.co
// @connect      cdn-lfs.hf.co
// @connect      cdn-lfs-us-1.hf.co
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.__CPH_MEANING_TEST) return;
  W.__CPH_MEANING_TEST = true;

  const LIB = (W.__CPH_MT_LIB) || 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
  const MODEL = 'Xenova/multilingual-e5-small';
  const CACHE = 'transformers-cache';
  // 로어(passage)와 입력(query) 짝. 뜻이 가까운 짝은 점수가 높고, 먼 짝은 낮아야 한다
  const LORE = [
    ['카페 모모', '학교 앞 작은 카페. 둘이 수업 끝나고 자주 들르는 단골집'],
    ['티볼트', '줄리엣의 사촌. 성미가 급하고 몬터규가를 미워함'],
    ['단검', '로미오가 늘 허리에 차고 다니는 짧은 칼'],
  ];
  const INPUTS = [
    ['수업 끝나고 늘 가던 커피집에서 보자', 0],
    ['그 성질 급한 사촌 놈이 또 시비를 걸어왔다', 1],
    ['허리춤의 칼자루를 꽉 쥐었다', 2],
    ['오늘은 날씨가 참 맑네', -1],
  ];

  const log = [];
  const t0 = Date.now();
  const sec = () => ((Date.now() - t0) / 1000).toFixed(1) + '초';

  // ---- 화면 ----
  const box = document.createElement('div');
  box.id = 'cph-mt';
  box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;width:min(360px,calc(100vw - 16px));max-height:70vh;overflow:auto;background:#fff;color:#111;border:1px solid #999;border-radius:10px;padding:10px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)';
  const title = document.createElement('b');
  title.textContent = '뜻 찾기 시험';
  const note = document.createElement('div');
  note.style.cssText = 'color:#555;margin:4px 0 8px';
  note.textContent = '시작을 누르면 뜻 계산 모델(약 120MB)을 처음 한 번 받아요. 와이파이에서 해 주세요. 두 번째부터는 기기에 저장된 것을 써요.';
  const lines = document.createElement('div');
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px';
  const mk = (text, fn) => { const b = document.createElement('button'); b.textContent = text; b.style.cssText = 'font:600 13px system-ui,sans-serif;padding:6px 10px;border-radius:8px;border:1px solid #888;background:#f3f3f3;color:#111'; b.onclick = fn; return b; };
  const startBtn = mk('시작', () => run());
  const copyBtn = mk('결과 복사', () => copy());
  const clearBtn = mk('받은 모델 지우기', () => clearCache());
  const closeBtn = mk('닫기', () => box.remove());
  copyBtn.disabled = true;
  btns.append(startBtn, copyBtn, clearBtn, closeBtn);
  box.append(title, note, lines, btns);
  (document.body || document.documentElement).append(box);

  function line(ok, text) {
    const d = document.createElement('div');
    d.textContent = (ok === true ? '✓ ' : ok === false ? '✗ ' : '… ') + text;
    d.style.color = ok === false ? '#b00020' : ok === true ? '#0a6b2b' : '#333';
    lines.append(d);
    log.push(d.textContent);
    return d;
  }
  const errText = (e) => String((e && (e.message || e.name)) || e).slice(0, 300);

  // ---- 받기: 크랙 페이지 제한을 피하려고 Tampermonkey로 받는다 ----
  let progressLine = null;
  function gmFetch(url, opt) {
    const u = String(url && url.url ? url.url : url);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: (opt && opt.method) || 'GET', url: u, responseType: 'arraybuffer', timeout: 600000,
        onprogress: (p) => {
          if (!progressLine || !/\.onnx/.test(u) || !p.total) return;
          progressLine.textContent = '… 모델 받는 중 ' + Math.round(p.loaded / p.total * 100) + '% (' + Math.round(p.total / 1048576) + 'MB)';
        },
        onload: (r) => {
          const h = new Headers();
          String(r.responseHeaders || '').split(/\r?\n/).forEach((l) => { const i = l.indexOf(':'); if (i > 0) { try { h.append(l.slice(0, i).trim(), l.slice(i + 1).trim()); } catch (e) { /* 이상한 머리 줄 */ } } });
          resolve(new Response(r.status === 204 || r.status === 304 ? null : r.response, { status: r.status || 200, statusText: r.statusText || '', headers: h }));
        },
        onerror: () => reject(new Error('받기 실패: ' + u)),
        ontimeout: () => reject(new Error('받기 시간 초과: ' + u)),
      });
    });
  }

  // ---- 라이브러리 불러오기: 되는 방법을 차례로 시험 ----
  async function loadLib() {
    const r = await gmFetch(LIB);
    if (!r.ok) throw new Error('라이브러리 받기 ' + r.status);
    const code = await r.text();
    line(true, '라이브러리 받음 ' + Math.round(code.length / 1024) + 'KB (' + sec() + ')');
    const tries = [
      ['blob 주소로 불러오기', () => { const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); return import(url); }],
      ['CDN 주소로 바로 불러오기', () => import(LIB)],
      ['글로 실행하기', () => {
        const m = code.match(/export\{([^}]*)\};?\s*(\/\/[^\n]*)?\s*$/);
        if (!m) throw new Error('export 줄을 못 찾음');
        const names = m[1].split(',').map((p) => { const [a, b] = p.trim().split(/\s+as\s+/); return JSON.stringify(b || a) + ':' + a; });
        const body = code.slice(0, m.index).replace(/import\.meta/g, '({url:' + JSON.stringify(LIB) + '})') + '\nreturn {' + names.join(',') + '};';
        return Function(body)();
      }],
    ];
    for (const [name, fn] of tries) {
      try {
        const mod = await fn();
        if (mod && mod.pipeline) { line(true, '라이브러리 켬: ' + name); return { mod, how: name }; }
        line(false, name + ': 모양이 다름');
      } catch (e) { line(false, name + ': ' + errText(e)); }
    }
    throw new Error('라이브러리를 켤 방법이 없음');
  }

  const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  async function run() {
    startBtn.disabled = true;
    lines.textContent = '';
    log.length = 0;
    log.push('기기: ' + navigator.userAgent);
    log.push('주소: ' + location.host + ' · isolated=' + !!W.crossOriginIsolated + ' · WebAssembly=' + (typeof WebAssembly) + ' · caches=' + (typeof caches));
    try {
      const had = typeof caches !== 'undefined' && (await caches.keys()).includes(CACHE);
      line(null, had ? '기기에 저장된 모델이 있어요' : '처음 받아요');
      const { mod, how } = await loadLib();
      const env = mod.env;
      env.allowLocalModels = false;
      env.fetch = gmFetch;
      try { env.backends.onnx.wasm.numThreads = 1; } catch (e) { /* 없으면 그대로 */ }
      progressLine = line(null, '모델 받는 중…');
      const t1 = Date.now();
      const ext = await mod.pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'wasm' });
      progressLine.textContent = '✓ 모델 켬 (' + ((Date.now() - t1) / 1000).toFixed(1) + '초' + (had ? ', 저장된 것' : '') + ')';
      progressLine.style.color = '#0a6b2b';
      log.push(progressLine.textContent);
      const emb = async (texts) => { const o = await ext(texts, { pooling: 'mean', normalize: true }); return o.tolist(); };
      const t2 = Date.now();
      const lv = await emb(LORE.map(([n, t]) => 'passage: ' + n + ': ' + t));
      const iv = await emb(INPUTS.map(([t]) => 'query: ' + t));
      const per = Math.round((Date.now() - t2) / (LORE.length + INPUTS.length));
      line(true, '글 하나 계산에 약 ' + per + 'ms');
      let good = 0, total = 0;
      INPUTS.forEach(([t, want], i) => {
        const sc = lv.map((v) => cos(v, iv[i]));
        const best = sc.indexOf(Math.max(...sc));
        const show = sc.map((s, j) => LORE[j][0] + ' ' + s.toFixed(2)).join(' · ');
        if (want >= 0) { total++; if (best === want) good++; }
        line(want < 0 ? null : best === want, '"' + t + '" → ' + show);
      });
      line(good === total, '맞힌 짝 ' + good + '/' + total + ' (크랙에서 돌아감, 방법: ' + how + ')');
    } catch (e) {
      line(false, '멈춤: ' + errText(e));
    }
    log.push('걸린 시간 ' + sec());
    copyBtn.disabled = false;
    startBtn.disabled = false;
    startBtn.textContent = '다시 시험';
  }

  function copy() {
    const text = '[뜻 찾기 시험 결과]\n' + log.join('\n');
    try { GM_setClipboard(text); copyBtn.textContent = '복사했어요'; } catch (e) { copyBtn.textContent = '복사 못 함'; }
    setTimeout(() => { copyBtn.textContent = '결과 복사'; }, 1500);
  }

  async function clearCache() {
    try { const ok = typeof caches !== 'undefined' && await caches.delete(CACHE); line(true, ok ? '받은 모델을 지웠어요' : '지울 모델이 없어요'); } catch (e) { line(false, '지우기 실패: ' + errText(e)); }
  }
})();
