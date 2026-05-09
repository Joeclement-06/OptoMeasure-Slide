/**
 * OptoMeasure v4 — shared.js
 * Complete optical engine shared by controller and VR device.
 *
 * BASE-IN FUSION FIX:
 * BI shift direction: targets move OUTWARD from the divider.
 *   Left eye  → moves LEFT  (negative X from centre)
 *   Right eye → moves RIGHT (positive X from centre)
 * This is OPPOSITE to BO and is physically correct for divergence.
 * The +8D lens does NOT invert the horizontal direction of perceived movement
 * for purposes of vergence demand — the image appears displaced in the same
 * direction as the screen target from the patient's perspective.
 *
 * Both modes use the SAME prism values: 0→8→15→20→24→30→38 Δ
 * BI uses formula m=55 (gentler shift per prism dioptre) but same prism targets.
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   OPTICAL CONFIGURATION
   ───────────────────────────────────────────────────────────────────────── */
const VR_CONFIG = {
    magnification:  4,
    lensPower:      8.0,
    objectDistance: 10,   // cm
    imageDistance:  36,   // cm — virtual image with +8D

    device: {
        name:             'Vivo Y3 (1938)',
        physicalWidthCm:  15.93,   // 6.27" × 2.54
        physicalHeightCm:  7.47,   // 2.94" × 2.54
        resolutionW:      1544,
        resolutionH:       720,
        ppi:               270,
    },

    layout: {
        containerWidthCm:  15.93,
        containerHeightCm:  7.47,
        eyeWidthCm:         7.965,  // half screen
        lineLengthCm:       3,      // 3 cm each side of dot (6 cm total)
    },

    lineLengthCm:    3,    // per side
    lineThicknessPx: 4,
    dotSizePx:       12,

    defaultIPD: 63,  // mm
    minIPD:     50,
    maxIPD:     90,

    // Base-Out formula:  prism = 65 × shiftCm + 2
    formula:   { m: 80, c: 2 },

    // Base-In formula:   prism = 55 × shiftCm + 2
    // Same prism targets — smaller shift (gentler, fights +8D convergence bias)
    formulaBI: { m: 80, c: 2 },

    // Slider range (continuous, 0.1Δ increments)
    sliderMin:  0,
    sliderMax:  35,
    sliderStep: 0.2,

    // Smooth animation duration (ms)
    animDuration: 900,
};

/* ─────────────────────────────────────────────────────────────────────────────
   FORMULA FUNCTIONS
   ───────────────────────────────────────────────────────────────────────── */

/** prism (Δ) from on-screen shift per eye (cm) */
function shiftToPrism(shiftCm, mode) {
    const f = (mode === 'BI') ? VR_CONFIG.formulaBI : VR_CONFIG.formula;
    return f.m * shiftCm + f.c;
}

/** on-screen shift per eye (cm) from prism (Δ) */
function prismToShift(prism, mode) {
    const f = (mode === 'BI') ? VR_CONFIG.formulaBI : VR_CONFIG.formula;
    return (prism - f.c) / f.m;
}

/* ─────────────────────────────────────────────────────────────────────────────
   DEVICE PIXEL SCALING
   CRITICAL: window.innerWidth gives CSS pixels (not physical px on Android)
   ───────────────────────────────────────────────────────────────────────── */
function getDevicePxPerCm() {
    const sw = Math.max(window.innerWidth,  window.innerHeight);
    const sh = Math.min(window.innerWidth,  window.innerHeight);
    return {
        x: sw / VR_CONFIG.device.physicalWidthCm,
        y: sh / VR_CONFIG.device.physicalHeightCm,
    };
}

function cmToPixels(cm)  { return cm * getDevicePxPerCm().x; }
function cmToPixelsY(cm) { return cm * getDevicePxPerCm().y; }
function mmToPixels(mm)  { return (mm / 10) * getDevicePxPerCm().x; }

/* ─────────────────────────────────────────────────────────────────────────────
   SMOOTH ANIMATION ENGINE
   ───────────────────────────────────────────────────────────────────────── */
/**
 * Eased number interpolator.
 * Returns a cancel function.
 *
 * @param {number}   from       start value
 * @param {number}   to         target value
 * @param {number}   duration   ms
 * @param {Function} onUpdate   called each frame with current value
 * @param {Function} [onDone]   called when complete
 */
function smoothAnimate(from, to, duration, onUpdate, onDone) {
    if (Math.abs(to - from) < 0.0001) { onUpdate(to); if (onDone) onDone(); return () => {}; }
    let start = null;
    let rafId = null;
    const ease = t => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; // ease-in-out-cubic

    function frame(ts) {
        if (!start) start = ts;
        const elapsed = ts - start;
        const progress = Math.min(elapsed / duration, 1);
        const val = from + (to - from) * ease(progress);
        onUpdate(val);
        if (progress < 1) {
            rafId = requestAnimationFrame(frame);
        } else {
            if (onDone) onDone();
        }
    }
    rafId = requestAnimationFrame(frame);
    return () => { if (rafId) cancelAnimationFrame(rafId); };
}

/* ─────────────────────────────────────────────────────────────────────────────
   ROOM CODE
   ───────────────────────────────────────────────────────────────────────── */
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}