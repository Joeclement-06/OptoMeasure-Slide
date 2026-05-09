/**
 * OptoMeasure v4 — vr.js
 * Patient VR renderer. Receives commands from controller via PeerJS.
 *
 * BASE-IN DIRECTION FIX (critical):
 *   BO: left target moves RIGHT (+shiftPx toward divider = convergence demand)
 *       right target moves LEFT  (-shiftPx toward divider)
 *   BI: left target moves LEFT  (-shiftPx away from divider = divergence demand)
 *       right target moves RIGHT (+shiftPx away from divider)
 *
 * IPD offset and prism shift are composed in ONE transform to avoid
 * margin/transform conflict that caused incorrect positioning.
 *
 * Smooth animation: VR interpolates between old and new shift values
 * over VR_CONFIG.animDuration ms so there are no jarring jumps.
 */
(function () {
    'use strict';

    /* ── STATE ─────────────────────────────────────────────────────────────── */
    const vr = {
        prism:       0,          // current displayed prism (Δ) — animated
        targetPrism: 0,          // target prism sent by controller
        mode:        'BO',
        ipd:         VR_CONFIG.defaultIPD,
        ipdOffset:   0,          // manual calibration offset (px)
        connected:   false,
        peer:        null,
        conn:        null,
        roomCode:    '',
        cancelAnim:  null,       // cancel running animation
        pingTimer:   null,
        missedPongs: 0,
    };

    /* ── DOM ───────────────────────────────────────────────────────────────── */
    const $ = id => document.getElementById(id);

    /* ── LAYOUT ────────────────────────────────────────────────────────────── */
    function computeLayout() {
        const L  = VR_CONFIG.layout;
        const px = getDevicePxPerCm();

        const cW = L.containerWidthCm  * px.x;
        const cH = L.containerHeightCm * px.y;
        const eW = L.eyeWidthCm        * px.x;

        const c = $('vrContainer');
        c.style.setProperty('--cW', cW + 'px');
        c.style.setProperty('--cH', cH + 'px');
        c.style.setProperty('--eW', eW + 'px');

        console.log('[VR] px/cm', px.x.toFixed(2) + '×' + px.y.toFixed(2),
            '| container', cW.toFixed(0) + '×' + cH.toFixed(0),
            '| viewport', window.innerWidth + '×' + window.innerHeight);
    }

    /* ── LINE GEOMETRY ─────────────────────────────────────────────────────── */
    function renderLines() {
        const px    = getDevicePxPerCm();
        const lenH  = VR_CONFIG.layout.lineLengthCm * px.x;  // 3 cm per side
        const lenV  = VR_CONFIG.layout.lineLengthCm * px.y;
        const thick = VR_CONFIG.lineThicknessPx;
        const dot   = VR_CONFIG.dotSizePx;
        const half  = dot / 2;

        // Left eye — horizontal
        $('hLineLeft').style.cssText  = `width:${lenH}px;height:${thick}px;right:${half}px;left:auto;`;
        $('hLineRight').style.cssText = `width:${lenH}px;height:${thick}px;left:${half}px;right:auto;`;

        // Right eye — vertical
        $('vLineTop').style.cssText    = `height:${lenV}px;width:${thick}px;bottom:${half}px;top:auto;`;
        $('vLineBottom').style.cssText = `height:${lenV}px;width:${thick}px;top:${half}px;bottom:auto;`;

        // Dots
        ['dotLeft','dotRight'].forEach(id => {
            $(id).style.cssText = `width:${dot}px;height:${dot}px;`;
        });
    }

    /* ── CORE VISUAL STATE ─────────────────────────────────────────────────── */
    /**
     * applyVisualState(prismValue)
     *
     * GEOMETRY:
     *   shiftCm  = prismToShift(prism, mode)          — per eye, in cm
     *   shiftPx  = shiftCm × pxPerCm                  — in CSS pixels
     *
     *   IPD offset:
     *     eyeWPx   = half-screen width in CSS px
     *     baseHalf = eyeWPx / 2  (geometric centre from divider)
     *     halfIPD  = ipd_mm / 10 × pxPerCm
     *     ipdOff   = halfIPD − baseHalf + ipdOffset
     *
     *   BASE-OUT (convergence — targets move INWARD):
     *     left  translateX = −ipdOff + shiftPx   (moves right, toward divider)
     *     right translateX = +ipdOff − shiftPx   (moves left,  toward divider)
     *
     *   BASE-IN (divergence — targets move OUTWARD):
     *     left  translateX = −ipdOff − shiftPx   (moves left,  away from divider)
     *     right translateX = +ipdOff + shiftPx   (moves right, away from divider)
     *
     * Both modes: ipdOff centres the dot on the patient's pupil at prism=0.
     */
    function applyVisualState(prismVal) {
        if (prismVal === undefined) prismVal = vr.prism;

        const px      = getDevicePxPerCm();
        const shiftCm = prismToShift(Math.max(0, prismVal), vr.mode);
        const shiftPx = shiftCm * px.x;

        const eyeWPx    = VR_CONFIG.layout.eyeWidthCm * px.x;
        const baseHalf  = eyeWPx / 2;
        const halfIPDpx = mmToPixels(vr.ipd) / 2;
        const ipdOff    = halfIPDpx - baseHalf + vr.ipdOffset;

        let leftX, rightX;

        if (vr.mode === 'BO') {
            // Convergence: targets move inward (toward divider)
            leftX  = -ipdOff + shiftPx;
            rightX =  ipdOff - shiftPx;
        } else {
            // Divergence: targets move outward (away from divider)
            leftX  = -ipdOff - shiftPx;
            rightX =  ipdOff + shiftPx;
        }

        const lc = $('leftContent');
        const rc = $('rightContent');
        lc.style.marginLeft = '';
        rc.style.marginLeft = '';
        lc.style.transform  = `translate(calc(-50% + ${leftX}px), -50%)`;
        rc.style.transform  = `translate(calc(-50% + ${rightX}px), -50%)`;

        updateDebug(shiftPx, ipdOff, leftX, rightX, prismVal, shiftCm);
    }

    /* ── SMOOTH PRISM ANIMATION ────────────────────────────────────────────── */
    function animateToPrism(targetPrism) {
        if (vr.cancelAnim) vr.cancelAnim();
        const fromPrism = vr.prism;
        vr.targetPrism  = targetPrism;

        vr.cancelAnim = smoothAnimate(
            fromPrism,
            targetPrism,
            VR_CONFIG.animDuration,
            function (val) {
                vr.prism = val;
                applyVisualState(val);
            },
            function () {
                vr.prism = targetPrism;
            }
        );
    }

    /* ── DEBUG OVERLAY ─────────────────────────────────────────────────────── */
    let debugOn = false;
    function updateDebug(shiftPx, ipdOff, lX, rX, prism, shiftCm) {
        const el = $('debugOverlay');
        if (!el || !debugOn) return;
        const px = getDevicePxPerCm();
        el.textContent =
            `Mode: ${vr.mode} | Prism: ${prism.toFixed(2)}Δ | ShiftCm: ${shiftCm.toFixed(4)}\n` +
            `ShiftPx: ${shiftPx.toFixed(1)} | IPD: ${vr.ipd}mm | ipdOff: ${ipdOff.toFixed(1)}\n` +
            `leftX: ${lX.toFixed(1)} | rightX: ${rX.toFixed(1)}\n` +
            `px/cm x:${px.x.toFixed(2)} y:${px.y.toFixed(2)}\n` +
            `viewport: ${window.innerWidth}×${window.innerHeight}`;
    }

    /* ── COMMAND HANDLER ───────────────────────────────────────────────────── */
    function handleCommand(data) {
        switch (data.type) {

            case 'update':
                if (data.mode !== undefined) vr.mode = data.mode;
                if (data.ipd  !== undefined) vr.ipd  = data.ipd;
                if (data.ipdOffset !== undefined) vr.ipdOffset = data.ipdOffset;
                // Animate to new prism
                animateToPrism(data.prism || 0);
                break;

            case 'mode':
                // Mode switch — jump to 0 then let slider drive
                vr.mode = data.value;
                vr.prism = 0;
                vr.targetPrism = 0;
                if (vr.cancelAnim) vr.cancelAnim();
                applyVisualState(0);
                break;

            case 'ipd':
                vr.ipd = data.value;
                applyVisualState();
                break;

            case 'ipdOffset':
                vr.ipdOffset = data.value;
                applyVisualState();
                break;

            case 'reset':
                vr.mode = data.mode || vr.mode;
                vr.prism = 0;
                vr.targetPrism = 0;
                if (vr.cancelAnim) vr.cancelAnim();
                applyVisualState(0);
                break;

            case 'pong':
                vr.missedPongs = 0;
                break;
        }
    }

    /* ── KEEPALIVE ─────────────────────────────────────────────────────────── */
    function startPing() {
        stopPing();
        vr.pingTimer = setInterval(function () {
            if (!vr.connected) return;
            if (vr.conn && vr.conn.open) {
                vr.conn.send({ type: 'ping' });
                vr.missedPongs++;
                if (vr.missedPongs >= 3) {
                    console.warn('[VR] Stale connection — showing overlay');
                    onDisconnected();
                }
            }
        }, 5000);
    }
    function stopPing() {
        if (vr.pingTimer) clearInterval(vr.pingTimer);
        vr.pingTimer = null;
        vr.missedPongs = 0;
    }

    /* ── FULLSCREEN ────────────────────────────────────────────────────────── */
    function requestFullscreen() {
        const el  = document.documentElement;
        const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
        if (!rfs) return;
        rfs.call(el)
            .then(() => setTimeout(() => { computeLayout(); renderLines(); applyVisualState(); }, 300))
            .catch(() => {});
        if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(() => {});
        }
    }

    /* ── CONNECTION UI ─────────────────────────────────────────────────────── */
    function onConnected() {
        vr.connected = true;
        $('connectOverlay').classList.add('hidden');
        $('connIndicator').classList.add('connected');
        setStatus('connected', 'Controller connected');
        startPing();
    }

    function onDisconnected() {
        vr.connected = false;
        stopPing();
        $('connIndicator').classList.remove('connected');
        $('connectOverlay').classList.remove('hidden');
        setStatus('waiting', 'Controller disconnected. Waiting…');
    }

    function setStatus(state, msg) {
        const dot  = $('statusDot');
        const text = $('statusText');
        if (dot)  dot.className  = 'status-dot ' + state;
        if (text) text.textContent = msg;
    }

    /* ── PEERJS ────────────────────────────────────────────────────────────── */
    function initPeer() {
        vr.roomCode = generateRoomCode();
        $('roomCode').textContent = vr.roomCode;

        if (vr.peer) { try { vr.peer.destroy(); } catch (_) {} }

        const peerId  = 'optovr-' + vr.roomCode.toLowerCase();
        const opts    = {
            debug: 0,
            config: { iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ]},
        };
        vr.peer = new Peer(peerId, opts);

        vr.peer.on('open', () => console.log('[VR] peer ready:', peerId));

        vr.peer.on('connection', function (conn) {
            if (vr.connected) { conn.close(); return; }
            vr.conn = conn;
            conn.on('open',  () => { onConnected(); conn.send({ type:'connected', roomCode: vr.roomCode }); requestFullscreen(); });
            conn.on('data',  handleCommand);
            conn.on('close', onDisconnected);
            conn.on('error', () => onDisconnected());
        });

        vr.peer.on('error', function (err) {
            console.error('[VR] peer error:', err.type);
            setStatus('waiting', 'Error: ' + err.type + '. Retrying…');
            setTimeout(initPeer, 3000);
        });
    }

    /* ── INIT ──────────────────────────────────────────────────────────────── */
    function init() {
        computeLayout();
        renderLines();
        applyVisualState(0);
        initPeer();

        window.addEventListener('resize', () => { computeLayout(); renderLines(); applyVisualState(); });

        document.addEventListener('click', function (e) {
            if (e.target.closest('#btnCopy')) return;
            if (vr.connected) requestFullscreen();
        });

        const btnCopy = $('btnCopy');
        if (btnCopy) {
            btnCopy.addEventListener('click', async function (e) {
                e.stopPropagation();
                try {
                    await navigator.clipboard.writeText(vr.roomCode);
                    btnCopy.querySelector('.copy-icon').textContent = '✅';
                    setTimeout(() => btnCopy.querySelector('.copy-icon').textContent = '📋', 2000);
                } catch (_) {}
            });
        }

        document.addEventListener('keydown', function (e) {
            if (e.key === 'd' || e.key === 'D') {
                debugOn = !debugOn;
                const el = $('debugOverlay');
                if (el) el.style.display = debugOn ? 'block' : 'none';
                if (debugOn) applyVisualState();
            }
        });
    }

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', init)
        : init();
})();