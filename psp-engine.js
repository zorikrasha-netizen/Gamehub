/*!
 * PSP Engine v1.1
 * Fixes: File→blobUrl, opts.name, wait for EJS_emulator
 */
(function (global) {
'use strict';

/* ============================================================
 * 0) COI تلقائي
 * ============================================================ */
(function ensureCOI() {
  if (global.crossOriginIsolated) return;
  if (location.protocol === 'file:') {
    console.error('[PSPEngine] file:// مش مدعوم. شغّل سيرفر محلي.');
    return;
  }
  if (document.querySelector('script[data-psp-coi]')) return;
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/coi-serviceworker@0.1.7/coi-serviceworker.min.js';
  s.setAttribute('data-psp-coi', '1');
  s.onerror = function () {
    console.warn('[PSPEngine] فشل تحميل coi-serviceworker — أضف COOP + COEP على السيرفر يدويًا.');
  };
  document.head.appendChild(s);
})();

/* ============================================================
 * 1) إعدادات PPSSPP للـ 60 FPS
 * ============================================================ */
var PSP_60FPS = {
  ppsspp_cpu_core: 'IR JIT',
  ppsspp_fast_memory: 'enabled',
  ppsspp_ignore_bad_memory_access: 'enabled',
  ppsspp_io_timing_method: 'Fast',
  ppsspp_func_replacements: 'enabled',
  ppsspp_gpu_hardware_transform: 'enabled',
  ppsspp_software_rendering: 'disabled',
  ppsspp_skip_gpu_readbacks: 'enabled',
  ppsspp_lazy_texture_caching: 'enabled',
  ppsspp_vertex_cache: 'enabled',
  ppsspp_rendering_mode: 'Buffered rendering',
  ppsspp_internal_resolution: '480x272',
  ppsspp_texture_scaling_level: 'disabled',
  ppsspp_texture_anisotropic_filtering: 'disabled',
  ppsspp_texture_filtering: 'Auto',
  ppsspp_auto_frameskip: 'enabled',
  ppsspp_frameskip: 'disabled',
  ppsspp_inflight_frames: 'Up to 1',
  ppsspp_force_lag_sync: 'disabled',
  ppsspp_audio_latency: 'low'
};

/* ============================================================
 * 2) الحالة والإعدادات
 * ============================================================ */
var config = {
  player: null,
  dataPath: null,
  language: 'ar-AR',
  color: '#1aafff',
  backgroundColor: '#0a0a0a',
  showFPS: true,
  customOptions: {},
  buttons: null,
  onReady: null,
  onStart: null,
  onError: null,
  onStop: null
};

var state = {
  loading: false,
  loaded: false,
  running: false,
  emulator: null,
  fpsRAF: null,
  currentBlobUrl: null
};

var listeners = { ready: [], start: [], error: [], stop: [] };

function emit(evt, data) {
  (listeners[evt] || []).forEach(function (fn) {
    try { fn(data); } catch (e) { console.error('[PSPEngine]', e); }
  });
  var cb = config['on' + evt.charAt(0).toUpperCase() + evt.slice(1)];
  if (typeof cb === 'function') {
    try { cb(data); } catch (e) { console.error('[PSPEngine]', e); }
  }
}

function on(evt, fn) {
  if (listeners[evt]) listeners[evt].push(fn);
  return API;
}

/* ============================================================
 * 3) فحص المتطلبات
 * ============================================================ */
function check() {
  return {
    crossOriginIsolated: global.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    webgl2: (function () {
      try { return !!document.createElement('canvas').getContext('webgl2'); }
      catch (e) { return false; }
    })(),
    secureContext: global.isSecureContext,
    fileProtocol: location.protocol === 'file:'
  };
}

function isReady() {
  var c = check();
  return c.crossOriginIsolated && c.sharedArrayBuffer && c.webgl2 && c.secureContext && !c.fileProtocol;
}

function reason() {
  var c = check();
  if (c.fileProtocol) return 'file:// غير مدعوم — استخدم HTTPS أو localhost';
  if (!c.secureContext) return 'السياق غير آمن — استخدم HTTPS أو localhost';
  if (!c.crossOriginIsolated) return 'Cross-Origin Isolation مش مفعّل — الصفحة هتعيد التحميل تلقائيًا. لو استمرت المشكلة، تأكد من تحميل coi-serviceworker محليًا.';
  if (!c.sharedArrayBuffer) return 'SharedArrayBuffer مش متاح (بيحتاج COI)';
  if (!c.webgl2) return 'WebGL2 غير مدعوم في المتصفح';
  return null;
}

/* ============================================================
 * 4) تحميل loader.js
 * ============================================================ */
function loadEJS() {
  return new Promise(function (resolve, reject) {
    document.querySelectorAll('script[data-psp-engine]').forEach(function (s) { s.remove(); });
    try { if (state.emulator && typeof state.emulator.exit === 'function') state.emulator.exit(); } catch (e) {}
    state.emulator = null;
    state.loaded = false;

    var s = document.createElement('script');
    s.src = config.dataPath + 'loader.js';
    s.setAttribute('data-psp-engine', '1');
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('فشل تحميل ' + s.src)); };
    document.head.appendChild(s);
  });
}

/* انتظار EJS_emulator (loader.js غير متزامن) */
function waitForEmulator(timeoutMs) {
  return new Promise(function (resolve) {
    if (global.EJS_emulator) return resolve(global.EJS_emulator);
    var start = Date.now();
    var iv = setInterval(function () {
      if (global.EJS_emulator) {
        clearInterval(iv);
        resolve(global.EJS_emulator);
      } else if (Date.now() - start > (timeoutMs || 10000)) {
        clearInterval(iv);
        resolve(null);
      }
    }, 50);
  });
}

/* ============================================================
 * 5) عداد FPS
 * ============================================================ */
function startFPS() {
  if (!config.showFPS || state.fpsRAF) return;
  var el = document.getElementById('psp-fps');
  if (!el) {
    el = document.createElement('div');
    el.id = 'psp-fps';
    el.style.cssText =
      'position:fixed;top:8px;left:8px;background:rgba(0,0,0,.7);color:#888;' +
      'padding:4px 10px;border-radius:6px;font-size:12px;font-family:monospace;' +
      'z-index:99999;pointer-events:none;user-select:none';
    el.textContent = 'FPS: --';
    document.body.appendChild(el);
  }
  var frames = 0, last = performance.now();
  function tick() {
    frames++;
    var now = performance.now();
    if (now - last >= 1000) {
      var fps = Math.round(frames * 1000 / (now - last));
      el.textContent = 'FPS: ' + fps;
      el.style.color = fps >= 55 ? '#4caf50' : (fps >= 30 ? '#ff9800' : '#f44336');
      frames = 0;
      last = now;
    }
    state.fpsRAF = requestAnimationFrame(tick);
  }
  state.fpsRAF = requestAnimationFrame(tick);
}

function stopFPS() {
  if (state.fpsRAF) { cancelAnimationFrame(state.fpsRAF); state.fpsRAF = null; }
  var el = document.getElementById('psp-fps');
  if (el) el.remove();
}

/* ============================================================
 * 6) تحويل game → File
 * ============================================================ */
function resolveGame(game) {
  return new Promise(function (resolve, reject) {
    if (typeof File !== 'undefined' && game instanceof File) return resolve(game);
    if (typeof Blob !== 'undefined' && game instanceof Blob) {
      return resolve(new File([game], 'game.cso', { type: game.type || 'application/octet-stream' }));
    }
    if (typeof game === 'string') {
      return fetch(game, { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error('فشل تحميل اللعبة: ' + game + ' (' + res.status + ')');
          return res.blob();
        })
        .then(function (blob) {
          var name = game.split('?')[0].split('#')[0].split('/').pop() || 'game.cso';
          resolve(new File([blob], name, { type: blob.type || 'application/octet-stream' }));
        })
        .catch(reject);
    }
    reject(new Error('game لازم يكون File أو Blob أو URL'));
  });
}

/* استخراج اسم عرض مناسب */
function deriveDisplayName(game, file, opts) {
  var name = (opts && opts.name) || null;
  if (!name && game && typeof game.name === 'string' && game.name !== 'game.cso' && game.name !== 'game.blob') {
    name = game.name;
  }
  if (!name) name = file.name || 'game';
  name = String(name).replace(/\.(iso|cso|pbp|chd|elf|zip|7z|rar|bin)$/i, '');
  return name || 'game';
}

/* ============================================================
 * 7) التشغيل
 * ============================================================ */
function start(game, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {

    var why = reason();
    if (why) {
      var err = new Error('المحرك مش جاهز: ' + why);
      emit('error', err);
      return reject(err);
    }

    if (state.loading) {
      console.warn('[PSPEngine] جاري التحميل بالفعل...');
      return resolve();
    }
    state.loading = true;

    var playerSel = opts.player || config.player;
    var playerEl = typeof playerSel === 'string' ? document.querySelector(playerSel) : playerSel;
    if (!playerEl) {
      state.loading = false;
      var e2 = new Error('عنصر اللاعب غير موجود: ' + playerSel);
      emit('error', e2);
      return reject(e2);
    }
    playerEl.innerHTML = '';

    // Revoke any previous blob URL
    if (state.currentBlobUrl) {
      try { URL.revokeObjectURL(state.currentBlobUrl); } catch (e) {}
      state.currentBlobUrl = null;
    }

    resolveGame(game)
      .then(function (file) {
        // FIX #1: File → blob URL (EJS gameUrl expects string, not File)
        var blobUrl = URL.createObjectURL(file);
        state.currentBlobUrl = blobUrl;

        // FIX #2: proper display name
        var displayName = deriveDisplayName(game, file, opts);

        global.EJS_player = playerEl;
        global.EJS_core = 'psp';
        global.EJS_pathtodata = config.dataPath;
        global.EJS_threads = true;
        global.EJS_startOnLoaded = true;
        global.EJS_language = config.language;
        global.EJS_color = config.color;
        global.EJS_backgroundColor = config.backgroundColor;
        global.EJS_gameName = displayName;
        global.EJS_gameUrl = blobUrl;
        global.EJS_defaultOptions = Object.assign({}, PSP_60FPS, config.customOptions);
        if (config.buttons) global.EJS_Buttons = config.buttons;

        global.EJS_ready = function () {
          state.loaded = true;
          state.loading = false;
          emit('ready');
        };
        global.EJS_onGameStart = function () {
          state.running = true;
          startFPS();
          emit('start');
        };

        return loadEJS();
      })
      .then(function () {
        // FIX #3: wait for EJS_emulator (loader.js is async)
        return waitForEmulator(10000);
      })
      .then(function (emulator) {
        state.emulator = emulator;
        if (!emulator) {
          console.warn('[PSPEngine] EJS_emulator لم يظهر خلال 10 ثواني — لكن التشغيل استمر');
        }
        resolve();
      })
      .catch(function (err) {
        state.loading = false;
        console.error('[PSPEngine]', err);
        emit('error', err);
        reject(err);
      });
  });
}

/* ============================================================
 * 8) الإيقاف
 * ============================================================ */
function stop() {
  stopFPS();
  try { if (state.emulator && typeof state.emulator.exit === 'function') state.emulator.exit(); } catch (e) {}
  state.emulator = null;
  state.running = false;
  state.loaded = false;
  if (state.currentBlobUrl) {
    try { URL.revokeObjectURL(state.currentBlobUrl); } catch (e) {}
    state.currentBlobUrl = null;
  }
  emit('stop');
}

/* ============================================================
 * 9) التهيئة
 * ============================================================ */
function init(userConfig) {
  Object.assign(config, userConfig || {});

  if (!config.dataPath) {
    var scripts = document.querySelectorAll('script[src*="psp-engine"]');
    if (scripts.length) {
      var src = scripts[scripts.length - 1].src;
      config.dataPath = src.substring(0, src.lastIndexOf('/') + 1);
    } else {
      config.dataPath = new URL('./data/', document.baseURI).href;
    }
  }
  if (!config.dataPath.endsWith('/')) config.dataPath += '/';
  return API;
}

/* ============================================================
 * 10) ربط زرار Load + File Input
 * ============================================================ */
function bindUI(opts) {
  opts = opts || {};
  var btnSel = opts.button || '#load';
  var inputSel = opts.input || '#rom';
  var playerSel = opts.player || config.player;

  var btn = typeof btnSel === 'string' ? document.querySelector(btnSel) : btnSel;
  var input = typeof inputSel === 'string' ? document.querySelector(inputSel) : inputSel;

  if (!btn || !input) {
    console.warn('[PSPEngine.bindUI] الزرار أو الـ input مش موجود: ' + btnSel + ' / ' + inputSel);
    return API;
  }

  if (!config.player && playerSel) config.player = playerSel;

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    input.click();
  });

  input.addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جاري التحميل...';
    start(f, { player: playerSel })
      .then(function () {
        btn.textContent = 'شغّال ✅';
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = originalText;
        alert('مش هيشتغل:\n' + err.message);
      });
  });

  return API;
}

/* ============================================================
 * 11) Auto-init
 * ============================================================ */
function autoInit() {
  var el = document.querySelector('[data-psp-engine]');
  if (!el) return null;

  init({
    player: el,
    dataPath: el.getAttribute('data-psp-data') || undefined,
    color: el.getAttribute('data-psp-color') || undefined,
    language: el.getAttribute('data-psp-language') || undefined,
    showFPS: el.getAttribute('data-psp-fps') !== 'false'
  });

  var gameUrl = el.getAttribute('data-psp-game');
  if (gameUrl) start(gameUrl).catch(function () {});

  return API;
}

/* ============================================================
 * 12) Public API
 * ============================================================ */
var API = {
  version: '1.1.0',
  init: init,
  start: start,
  stop: stop,
  bindUI: bindUI,
  check: check,
  isReady: isReady,
  reason: reason,
  on: on,
  getState: function () { return Object.assign({}, state); },
  getConfig: function () { return Object.assign({}, config); },
  getEmulator: function () { return state.emulator; },
  autoInit: autoInit
};

global.PSPEngine = API;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    if (document.querySelector('[data-psp-engine]')) autoInit();
  });
} else {
  if (document.querySelector('[data-psp-engine]')) autoInit();
}

})(window);
