/**
 * OptoMeasure v4 — controller.js
 * Doctor's controller. Sends prism commands to VR device via PeerJS.
 *
 * Features:
 *   • Continuous slider 0–25Δ (0.1Δ increments)
 *   • BO / BI mode — same prism values, different formula coefficients
 *   • IPD adjustment + calibration offset (horizontal fine-tune)
 *   • Break / Recovery / Blur recording with timestamps
 *   • Keepalive pong reply
 *   • Smooth debounced sends so slider doesn't flood connection
 */
(function () {
    'use strict';

    /* ── STATE ─────────────────────────────────────────────────────────────── */
    const ctrl = {
        prism:      0,
        mode:       'BO',
        ipd:        VR_CONFIG.defaultIPD,
        ipdOffset:  0,      // px calibration offset
        connected:  false,
        peer:       null,
        conn:       null,
        sendTimer:  null,   // debounce timer
        results:    [],     // { type, prism, mode, time }
    };

    /* ── DOM ───────────────────────────────────────────────────────────────── */
    const $ = id => document.getElementById(id);

    /* ── TOAST ─────────────────────────────────────────────────────────────── */
    function showToast(msg, dur = 2200) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(t._t);
        t._t = setTimeout(() => t.classList.remove('show'), dur);
    }

    /* ── SEND ──────────────────────────────────────────────────────────────── */
    function sendCmd(data) {
        if (ctrl.connected && ctrl.conn && ctrl.conn.open) {
            try { ctrl.conn.send(data); } catch (_) {}
        }
    }

    /** Debounced full-state update — prevents flooding on rapid slider moves */
    function sendUpdate() {
        clearTimeout(ctrl.sendTimer);
        ctrl.sendTimer = setTimeout(function () {
            sendCmd({
                type:      'update',
                prism:     ctrl.prism,
                mode:      ctrl.mode,
                ipd:       ctrl.ipd,
                ipdOffset: ctrl.ipdOffset,
            });
        }, 16); // ~1 frame debounce
    }

    /* ── UI REFRESH ────────────────────────────────────────────────────────── */
    function refreshUI() {
        // Prism display
        $('prismDisplay').textContent = ctrl.prism.toFixed(1);

        // Slider
        const sl = $('prismSlider');
        sl.value = ctrl.prism;
        updateSliderFill();

        // Mode buttons
        $('btnBO').classList.toggle('active', ctrl.mode === 'BO');
        $('btnBI').classList.toggle('active', ctrl.mode === 'BI');

        // Mode colour class on body
        document.body.setAttribute('data-mode', ctrl.mode);

        // IPD
        $('ipdDisplay').textContent = ctrl.ipd;
        $('ipdSlider').value        = ctrl.ipd;
        updateIPDFill();

        // Calibration offset
        $('calDisplay').textContent = (ctrl.ipdOffset >= 0 ? '+' : '') + ctrl.ipdOffset;
    }

    function updateSliderFill() {
        const sl  = $('prismSlider');
        const pct = ((sl.value - sl.min) / (sl.max - sl.min)) * 100;
        $('sliderFill').style.width = pct + '%';
    }

    function updateIPDFill() {
        const sl  = $('ipdSlider');
        const pct = ((sl.value - sl.min) / (sl.max - sl.min)) * 100;
        $('ipdFill').style.width = pct + '%';
    }

    /* ── CONNECTION ────────────────────────────────────────────────────────── */
    function destroyPeer() {
        if (ctrl.peer) { try { ctrl.peer.destroy(); } catch (_) {} ctrl.peer = null; ctrl.conn = null; }
    }

    function connect() {
        const code = $('inputCode').value.trim().toUpperCase();
        if (code.length < 4) { $('connectHint').textContent = 'Enter a valid code.'; return; }
        destroyPeer();
        $('connectHint').textContent = 'Connecting…';
        $('btnConnect').disabled = true;

        const myId = 'optoctrl-' + Date.now();
        const opts = {
            debug: 0,
            config: { iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ]},
        };
        ctrl.peer = new Peer(myId, opts);

        ctrl.peer.on('open', function () {
            const target = 'optovr-' + code.toLowerCase();
            ctrl.conn = ctrl.peer.connect(target, { reliable: true });

            ctrl.conn.on('open', function () {
                ctrl.connected = true;
                onConnected();
            });
            ctrl.conn.on('data', function (d) {
                if (d.type === 'ping') sendCmd({ type: 'pong' });
                if (d.type === 'connected') console.log('[Ctrl] VR confirmed:', d.roomCode);
            });
            ctrl.conn.on('close', onDisconnected);
            ctrl.conn.on('error', () => { $('connectHint').textContent = 'Connection error.'; $('btnConnect').disabled = false; });

            setTimeout(() => {
                if (!ctrl.connected) {
                    $('connectHint').textContent = 'No response — check code.';
                    $('btnConnect').disabled = false;
                    destroyPeer();
                }
            }, 12000);
        });

        ctrl.peer.on('error', function (e) {
            $('connectHint').textContent = 'Peer error: ' + e.type;
            $('btnConnect').disabled = false;
        });
    }

    function onConnected() {
        $('connDot').classList.add('connected');
        $('connText').textContent = 'Connected';
        $('connectScreen').classList.add('hidden');
        $('mainScreen').classList.add('visible');
        showToast('✅ VR device connected!');
        sendUpdate();
    }

    function onDisconnected() {
        ctrl.connected = false;
        $('connDot').classList.remove('connected');
        $('connText').textContent = 'Offline';
        $('connectScreen').classList.remove('hidden');
        $('mainScreen').classList.remove('visible');
        $('btnConnect').disabled = false;
        $('connectHint').textContent = 'Connection lost. Re-enter code.';
        showToast('⚠ Disconnected');
    }

    /* ── ACTIONS ───────────────────────────────────────────────────────────── */
    function setPrism(val) {
        ctrl.prism = Math.max(VR_CONFIG.sliderMin, Math.min(VR_CONFIG.sliderMax, parseFloat(val)));
        refreshUI();
        sendUpdate();
    }

    function setMode(mode) {
        ctrl.mode  = mode;
        ctrl.prism = 0;
        refreshUI();
        sendCmd({ type: 'mode', value: mode });
        sendUpdate();
        showToast(mode === 'BO' ? '◀▶ Base-Out — Convergence' : '▶◀ Base-In — Divergence');
    }

    function setIPD(val) {
        ctrl.ipd = parseInt(val, 10);
        refreshUI();
        sendCmd({ type: 'ipd', value: ctrl.ipd });
    }

    function adjustCalibration(delta) {
        ctrl.ipdOffset = Math.max(-50, Math.min(50, ctrl.ipdOffset + delta));
        refreshUI();
        sendCmd({ type: 'ipdOffset', value: ctrl.ipdOffset });
    }

    function resetCalibration() {
        ctrl.ipdOffset = 0;
        refreshUI();
        sendCmd({ type: 'ipdOffset', value: 0 });
    }

    function resetPrism() {
        ctrl.prism = 0;
        refreshUI();
        sendCmd({ type: 'reset', mode: ctrl.mode });
        showToast('Reset to 0Δ');
    }

    /* ── RECORDING ─────────────────────────────────────────────────────────── */
    function record(type) {
        if (!ctrl.connected) { showToast('Not connected'); return; }
        const entry = {
            type,
            prism: ctrl.prism.toFixed(1),
            mode:  ctrl.mode,
            time:  new Date().toLocaleTimeString(),
        };
        ctrl.results.push(entry);
        renderResults();
        showToast(`${type} recorded: ${entry.prism}Δ`);
    }

    function renderResults() {
        const container = $('resultsList');
        if (!container) return;
        container.innerHTML = '';
        ctrl.results.forEach(function (r, i) {
            const el = document.createElement('div');
            el.className = 'result-entry result-' + r.type.toLowerCase().replace(' ', '-');
            el.innerHTML =
                `<span class="re-badge">${r.type}</span>` +
                `<span class="re-prism">${r.prism} Δ</span>` +
                `<span class="re-mode">${r.mode}</span>` +
                `<span class="re-time">${r.time}</span>` +
                `<button class="re-del" data-i="${i}" title="Delete">×</button>`;
            container.appendChild(el);
        });
        container.querySelectorAll('.re-del').forEach(btn => {
            btn.addEventListener('click', function () {
                ctrl.results.splice(parseInt(this.dataset.i), 1);
                renderResults();
            });
        });
    }

    function clearResults() {
        ctrl.results = [];
        renderResults();
        showToast('Results cleared');
    }

    /* ── EVENT BINDING ─────────────────────────────────────────────────────── */
    function bindEvents() {
        $('btnConnect').addEventListener('click', connect);
        $('inputCode').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });

        // Prism slider
        $('prismSlider').addEventListener('input', function () { setPrism(this.value); });
        $('prismSlider').addEventListener('change', function () { setPrism(this.value); });

        // Mode
        $('btnBO').addEventListener('click', () => setMode('BO'));
        $('btnBI').addEventListener('click', () => setMode('BI'));

        // Reset
        $('btnReset').addEventListener('click', resetPrism);

        // IPD slider
        $('ipdSlider').addEventListener('input', function () { setIPD(this.value); });

        // Calibration offset buttons
        $('calLeft').addEventListener('click',  () => adjustCalibration(-2));
        $('calRight').addEventListener('click', () => adjustCalibration(+2));
        $('calReset').addEventListener('click', resetCalibration);

        // Record buttons
        $('btnBlur').addEventListener('click',     () => record('Blur'));
        $('btnBreak').addEventListener('click',    () => record('Break'));
        $('btnRecovery').addEventListener('click', () => record('Recovery'));
        $('btnClearRes').addEventListener('click', clearResults);

        // Keyboard
        document.addEventListener('keydown', function (e) {
            if (document.activeElement === $('inputCode')) return;
            switch (e.key) {
                case 'ArrowRight': case 'ArrowUp': case '+': case '=':
                    e.preventDefault(); setPrism(ctrl.prism + 0.5); break;
                case 'ArrowLeft': case 'ArrowDown': case '-':
                    e.preventDefault(); setPrism(ctrl.prism - 0.5); break;
                case 'r': case 'R':
                    if (!e.ctrlKey) { e.preventDefault(); resetPrism(); } break;
                case 'b': case 'B': e.preventDefault(); record('Break');    break;
                case 'v': case 'V': e.preventDefault(); record('Recovery'); break;
                case 'i': case 'I': e.preventDefault(); setMode(ctrl.mode === 'BO' ? 'BI' : 'BO'); break;
                case 'u': case 'U': e.preventDefault(); record('Blur');     break;
            }
        });

        // Touch pass-through
        document.querySelectorAll('.tap-btn').forEach(btn => {
            btn.addEventListener('touchend', function (e) { e.preventDefault(); this.click(); }, { passive: false });
        });
    }

    /* ── INIT ──────────────────────────────────────────────────────────────── */
    function init() {
        // Set slider attrs from config
        const sl = $('prismSlider');
        sl.min   = VR_CONFIG.sliderMin;
        sl.max   = VR_CONFIG.sliderMax;
        sl.step  = VR_CONFIG.sliderStep;
        sl.value = 0;

        const isl = $('ipdSlider');
        isl.min   = VR_CONFIG.minIPD;
        isl.max   = VR_CONFIG.maxIPD;
        isl.value = VR_CONFIG.defaultIPD;

        bindEvents();
        refreshUI();
    }

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', init)
        : init();
})();