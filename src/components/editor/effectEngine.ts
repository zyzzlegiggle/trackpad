/**
 * effectEngine.ts
 * 
 * FIRST PRINCIPLES: Single source of truth for all effect calculations.
 * This module contains pure math functions with NO DOM dependencies.
 * Used by both preview (canvas rendering) and export (frame generation).
 * 
 * Key Design Decisions:
 * - All calculations operate on normalized coordinates (0-1)
 * - Time is in seconds
 * - Output is a FrameState that can be applied to any rendering target
 */

import { Effect, CursorPosition, CursorSettings, EasingPreset } from './types';
import { ZOOM_EASING_PRESETS } from './constants';

// ============================================================================
// TYPES
// ============================================================================

/** Complete state of a video frame at a given time */
export interface FrameState {
    // Transform state
    scale: number;           // 1.0 = no zoom, 2.0 = 2x zoom
    viewportX: number;       // Viewport center X (0-1, where video should be centered)
    viewportY: number;       // Viewport center Y (0-1)

    // Cursor state (if visible)
    cursorX: number;         // Smoothed cursor X (0-1)
    cursorY: number;         // Smoothed cursor Y (0-1)
    cursorVisible: boolean;
    cursorScale: number;     // 1.0 = normal, up to 1.5 for velocity scaling

    // Visual effects
    blurIntensity: number;   // 0 = no blur, higher = more blur

    // Active effects (for debugging/visualization)
    activeZoomId: string | null;
}

/** Viewport state tracked across frames for smooth panning */
export interface ViewportState {
    x: number;
    y: number;
    lastEffectId: string;
}

/** Cursor state tracked across frames for smooth movement */
export interface CursorState {
    x: number;
    y: number;
    prevX: number;
    prevY: number;
    velocity: number;
}

// ============================================================================
// PURE MATH FUNCTIONS
// ============================================================================

/**
 * Smoothstep interpolation: t² × (3 - 2t)
 * Creates smooth ease-in/ease-out transitions
 */
export function smoothstep(t: number): number {
    const clamped = Math.max(0, Math.min(1, t));
    return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Linear interpolation between two values
 */
export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/**
 * Clamp value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Get cursor position at a specific time using binary search + linear interpolation
 * 
 * FIRST PRINCIPLES:
 * - Cursor data is sampled at ~60Hz during recording
 * - For any given frame time, we find the two surrounding samples
 * - Linear interpolation between them gives smooth movement
 */
export function getCursorAtTime(
    positions: CursorPosition[],
    timeMs: number,
    lastIndex: number = 0
): { x: number; y: number; index: number } | null {
    const len = positions.length;
    if (len === 0) return null;

    // Check if last index is still valid (sequential playback optimization)
    if (lastIndex >= 0 && lastIndex < len - 1) {
        const before = positions[lastIndex];
        const after = positions[lastIndex + 1];
        if (before.timestamp_ms <= timeMs && timeMs <= after.timestamp_ms) {
            // Cache hit - interpolate directly
            const range = after.timestamp_ms - before.timestamp_ms;
            if (range === 0) return { x: before.x, y: before.y, index: lastIndex };
            const t = (timeMs - before.timestamp_ms) / range;
            return {
                x: before.x + (after.x - before.x) * t,
                y: before.y + (after.y - before.y) * t,
                index: lastIndex,
            };
        }
    }

    // Edge cases
    if (timeMs <= positions[0].timestamp_ms) {
        return { x: positions[0].x, y: positions[0].y, index: 0 };
    }
    if (timeMs >= positions[len - 1].timestamp_ms) {
        return { x: positions[len - 1].x, y: positions[len - 1].y, index: len - 2 };
    }

    // Binary search
    let left = 0;
    let right = len - 1;
    while (left < right - 1) {
        const mid = (left + right) >> 1;
        if (positions[mid].timestamp_ms <= timeMs) {
            left = mid;
        } else {
            right = mid;
        }
    }

    const before = positions[left];
    const after = positions[right];
    const range = after.timestamp_ms - before.timestamp_ms;
    if (range === 0) return { x: before.x, y: before.y, index: left };

    const t = (timeMs - before.timestamp_ms) / range;
    return {
        x: before.x + (after.x - before.x) * t,
        y: before.y + (after.y - before.y) * t,
        index: left,
    };
}

/**
 * Get easing duration for a zoom effect based on its preset
 */
export function getEasingDuration(easing: EasingPreset | undefined): number {
    const preset = easing || 'mellow';
    return ZOOM_EASING_PRESETS[preset]?.duration || 0.35;
}

// ============================================================================
// VIEWPORT PANNING (Smart Camera Following)
// ============================================================================

/**
 * FIRST PRINCIPLES: Smart Viewport Panning
 * 
 * Instead of always centering on cursor, we create an "inner safe zone".
 * The viewport only moves when the cursor approaches the edges.
 * This creates smoother, less distracting camera movement.
 * 
 * @param currentViewport Current viewport center (0-1)
 * @param cursorPos Current cursor position (0-1)
 * @param zoomScale Current zoom scale (1 = no zoom)
 * @returns New viewport position
 */
export function computeSmartPan(
    currentX: number,
    currentY: number,
    cursorX: number,
    cursorY: number,
    zoomScale: number
): { x: number; y: number } {
    // Configuration matching VideoPreview.tsx
    const INNER_MARGIN = 0.15;  // 15% margin for outer container
    const PAN_SPEED = 0.08;     // How fast viewport moves when panning

    // Calculate visible viewport size at current zoom
    // At scale S, viewport shows 1/S of the video in each dimension
    const halfViewport = 0.5 / zoomScale;
    const innerHalf = halfViewport * (1 - 2 * INNER_MARGIN);  // Inner safe zone

    let newX = currentX;
    let newY = currentY;

    // Cursor position relative to viewport center
    const relX = cursorX - currentX;
    const relY = cursorY - currentY;

    // If cursor is outside inner container, move viewport towards it
    if (Math.abs(relX) > innerHalf) {
        const direction = relX > 0 ? 1 : -1;
        const overshoot = Math.abs(relX) - innerHalf;
        newX += direction * PAN_SPEED * overshoot * 2;
    }
    if (Math.abs(relY) > innerHalf) {
        const direction = relY > 0 ? 1 : -1;
        const overshoot = Math.abs(relY) - innerHalf;
        newY += direction * PAN_SPEED * overshoot * 2;
    }

    // Clamp viewport to video bounds (prevent showing black edges)
    const minCenter = 0.5 / zoomScale;
    const maxCenter = 1 - minCenter;
    newX = clamp(newX, minCenter, maxCenter);
    newY = clamp(newY, minCenter, maxCenter);

    return { x: newX, y: newY };
}

// ============================================================================
// MAIN FRAME STATE COMPUTATION
// ============================================================================

/**
 * FIRST PRINCIPLES: Compute the complete visual state of a frame
 * 
 * This is THE function that both preview and export use.
 * Given time + effects + cursor data → outputs exactly what to render.
 * 
 * Timing Model (ANTICIPATION):
 * - Zoom-in:  (startTime - easingDuration) → startTime  (zoom reaches full AT the click)
 * - Hold:     startTime → (endTime - easingDuration)    (hold at full zoom, follow cursor)
 * - Zoom-out: (endTime - easingDuration) → endTime      (zoom back to normal)
 */
export function computeFrameState(
    time: number,
    effects: Effect[],
    cursorPositions: CursorPosition[],
    cursorSettings: CursorSettings,
    viewportState: ViewportState,
    cursorState: CursorState
): FrameState {
    const timeMs = time * 1000;

    // Initialize result
    const result: FrameState = {
        scale: 1.0,
        viewportX: 0.5,
        viewportY: 0.5,
        cursorX: cursorState.x,
        cursorY: cursorState.y,
        cursorVisible: cursorSettings.visible && cursorPositions.length > 0,
        cursorScale: 1.0,
        blurIntensity: 0,
        activeZoomId: null,
    };

    // ========================================================================
    // ZOOM EFFECT COMPUTATION
    // ========================================================================

    // Find active zoom effect (with anticipation timing)
    let activeZoom: Effect | null = null;
    for (const effect of effects) {
        if (effect.type !== 'zoom') continue;

        const easingDuration = getEasingDuration(effect.easing);
        const anticipationStart = effect.startTime - easingDuration;

        if (time >= anticipationStart && time <= effect.endTime) {
            activeZoom = effect;
            break;
        }
    }

    if (activeZoom) {
        const easingDuration = getEasingDuration(activeZoom.easing);
        const ZOOM_SCALE = activeZoom.scale || 2.0;

        // ANTICIPATION timing
        const anticipationStart = activeZoom.startTime - easingDuration;
        const timeFromAnticipation = time - anticipationStart;
        const timeToEnd = activeZoom.endTime - time;

        // Initialize viewport for new effect
        if (viewportState.lastEffectId !== activeZoom.id) {
            viewportState.x = activeZoom.targetX ?? 0.5;
            viewportState.y = activeZoom.targetY ?? 0.5;
            viewportState.lastEffectId = activeZoom.id;
        }

        let viewportX = viewportState.x;
        let viewportY = viewportState.y;

        // Follow cursor during HOLD phase
        // Hold: from startTime to (endTime - easingDuration)
        if (cursorPositions.length > 0 && time >= activeZoom.startTime && timeToEnd > easingDuration) {
            const cursorPos = getCursorAtTime(cursorPositions, timeMs);
            if (cursorPos) {
                const panned = computeSmartPan(viewportX, viewportY, cursorPos.x, cursorPos.y, ZOOM_SCALE);
                viewportX = panned.x;
                viewportY = panned.y;

                // Update state for next frame
                viewportState.x = viewportX;
                viewportState.y = viewportY;
            }
        }

        // Compute zoom intensity using smoothstep
        let zoomIntensity: number;
        if (timeFromAnticipation < easingDuration) {
            // Zooming IN (anticipation phase before the click)
            const t = timeFromAnticipation / easingDuration;
            zoomIntensity = smoothstep(t);
        } else if (timeToEnd < easingDuration) {
            // Zooming OUT
            const t = timeToEnd / easingDuration;
            zoomIntensity = smoothstep(t);
        } else {
            // Hold phase (fully zoomed)
            zoomIntensity = 1;
        }

        result.scale = 1 + (ZOOM_SCALE - 1) * zoomIntensity;
        result.viewportX = viewportX;
        result.viewportY = viewportY;
        result.activeZoomId = activeZoom.id;
    } else {
        // No active zoom - reset viewport
        viewportState.x = 0.5;
        viewportState.y = 0.5;
        viewportState.lastEffectId = '';
    }

    // ========================================================================
    // BLUR EFFECT COMPUTATION
    // ========================================================================

    for (const effect of effects) {
        if (effect.type === 'blur' && time >= effect.startTime && time <= effect.endTime) {
            result.blurIntensity = effect.intensity || 5;
            break;
        }
    }

    // ========================================================================
    // CURSOR COMPUTATION
    // ========================================================================

    if (cursorSettings.visible && cursorPositions.length > 0) {
        const rawPos = getCursorAtTime(cursorPositions, timeMs);
        if (rawPos) {
            // Apply smoothing (lerp towards target)
            const smoothing = cursorSettings.smoothing;
            cursorState.x += (rawPos.x - cursorState.x) * smoothing;
            cursorState.y += (rawPos.y - cursorState.y) * smoothing;

            // Calculate velocity for optional scaling
            const dx = cursorState.x - cursorState.prevX;
            const dy = cursorState.y - cursorState.prevY;
            const frameVelocity = Math.hypot(dx, dy);
            cursorState.velocity = cursorState.velocity * 0.8 + frameVelocity * 0.2;

            cursorState.prevX = cursorState.x;
            cursorState.prevY = cursorState.y;

            // Velocity scaling (subtle effect)
            result.cursorScale = cursorSettings.velocityScale
                ? 1 + Math.min(cursorState.velocity * 30, 0.5)
                : 1;

            result.cursorX = cursorState.x;
            result.cursorY = cursorState.y;
            result.cursorVisible = true;
        }
    }

    return result;
}

// ============================================================================
// CANVAS TRANSFORM HELPERS
// ============================================================================

/**
 * Convert FrameState to canvas 2D transform parameters
 * 
 * FIRST PRINCIPLES:
 * - Canvas origin is at (0, 0) top-left
 * - We need to translate so that (viewportX, viewportY) appears at canvas center
 * - Then scale around that point
 * 
 * Formula matches VideoPreview.tsx:
 *   translateX = (0.5 - viewportX) * (scale - 1) * canvasWidth
 *   translateY = (0.5 - viewportY) * (scale - 1) * canvasHeight
 */
export function computeCanvasTransform(
    frameState: FrameState,
    canvasWidth: number,
    canvasHeight: number,
    paddingPercent: number
): {
    translateX: number;
    translateY: number;
    scale: number;
    videoX: number;      // Video position within canvas
    videoY: number;
    videoWidth: number;  // Rendered video size
    videoHeight: number;
} {
    // Base scale from padding
    const baseScale = 1.0 - (2 * paddingPercent / 100);
    const effectiveScale = baseScale * frameState.scale;

    // Video dimensions at current scale
    const videoWidth = canvasWidth * effectiveScale;
    const videoHeight = canvasHeight * effectiveScale;

    // Centered position
    const centeredX = (canvasWidth - videoWidth) / 2;
    const centeredY = (canvasHeight - videoHeight) / 2;

    // Offset for viewport targeting
    // This makes (viewportX, viewportY) appear at canvas center
    const offsetX = (0.5 - frameState.viewportX) * (frameState.scale - 1) * canvasWidth * baseScale;
    const offsetY = (0.5 - frameState.viewportY) * (frameState.scale - 1) * canvasHeight * baseScale;

    return {
        translateX: offsetX,
        translateY: offsetY,
        scale: frameState.scale,
        videoX: centeredX + offsetX,
        videoY: centeredY + offsetY,
        videoWidth,
        videoHeight,
    };
}

// ============================================================================
// STATE FACTORY FUNCTIONS
// ============================================================================

/** Create initial viewport state */
export function createViewportState(): ViewportState {
    return { x: 0.5, y: 0.5, lastEffectId: '' };
}

/** Create initial cursor state */
export function createCursorState(): CursorState {
    return { x: 0.5, y: 0.5, prevX: 0.5, prevY: 0.5, velocity: 0 };
}
