/**
 * canvasRenderer.ts
 * 
 * FIRST PRINCIPLES: Unified canvas rendering for both preview and export.
 * Uses effectEngine for all calculations, then renders to canvas.
 * 
 * Key capabilities:
 * - Render a video frame with all effects applied
 * - Draw custom cursor overlay
 * - Support for background color and padding
 * - Works with both HTMLCanvasElement and OffscreenCanvas
 */

import {
    FrameState,
    ViewportState,
    CursorState,
    computeFrameState,
    computeCanvasTransform,
    createViewportState,
    createCursorState,
} from './effectEngine';
import { Effect, CursorPosition, CursorSettings, CanvasSettings, CursorStyle } from './types';

// ============================================================================
// TYPES
// ============================================================================

export interface RenderContext {
    canvas: HTMLCanvasElement | OffscreenCanvas;
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    width: number;
    height: number;
}

export interface RenderOptions {
    effects: Effect[];
    cursorPositions: CursorPosition[];
    cursorSettings: CursorSettings;
    canvasSettings: CanvasSettings;
    viewportState: ViewportState;
    cursorState: CursorState;
}

// ============================================================================
// CURSOR RENDERING
// ============================================================================

/**
 * Draw cursor on canvas based on style
 */
function drawCursor(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    color: string,
    style: CursorStyle,
    scale: number = 1.0
): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    const halfSize = size / 2;

    switch (style) {
        case 'pointer':
            // Arrow pointer cursor
            ctx.beginPath();
            ctx.moveTo(-halfSize * 0.5, -halfSize);  // Top of arrow
            ctx.lineTo(-halfSize * 0.5, halfSize * 0.5);  // Down left side
            ctx.lineTo(0, halfSize * 0.2);  // Inner corner
            ctx.lineTo(halfSize * 0.3, halfSize);  // Arrow tail
            ctx.lineTo(halfSize * 0.5, halfSize * 0.5);  // Tail end
            ctx.lineTo(0, halfSize * 0.1);  // Back to inner
            ctx.lineTo(halfSize * 0.5, halfSize * 0.1);  // Right side
            ctx.closePath();

            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 1;
            ctx.stroke();
            break;

        case 'circle':
            // Circle cursor with center dot
            ctx.beginPath();
            ctx.arc(0, 0, halfSize * 0.8, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.9;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 0.5;
            ctx.stroke();

            // Center dot
            ctx.beginPath();
            ctx.arc(0, 0, halfSize * 0.25, 0, Math.PI * 2);
            ctx.fillStyle = 'black';
            ctx.globalAlpha = 0.5;
            ctx.fill();
            ctx.globalAlpha = 1;
            break;

        case 'crosshair':
            // Crosshair cursor
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';

            // Vertical line
            ctx.beginPath();
            ctx.moveTo(0, -halfSize);
            ctx.lineTo(0, halfSize);
            ctx.stroke();

            // Horizontal line
            ctx.beginPath();
            ctx.moveTo(-halfSize, 0);
            ctx.lineTo(halfSize, 0);
            ctx.stroke();

            // Center circle
            ctx.beginPath();
            ctx.arc(0, 0, halfSize * 0.33, 0, Math.PI * 2);
            ctx.stroke();
            break;
    }

    ctx.restore();
}

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

/**
 * Render a single frame to canvas
 * 
 * FIRST PRINCIPLES:
 * 1. Clear canvas with background color
 * 2. Compute frame state using effect engine
 * 3. Draw video frame with transforms applied
 * 4. Draw cursor overlay if visible
 * 5. Apply any post-processing (blur, etc.)
 * 
 * @param video - Source video element (for preview) or ImageBitmap (for export)
 * @param time - Current time in seconds
 * @param renderCtx - Canvas rendering context
 * @param options - Effect and settings options
 * @returns The computed FrameState for debugging/inspection
 */
export function renderFrame(
    video: HTMLVideoElement | ImageBitmap,
    time: number,
    renderCtx: RenderContext,
    options: RenderOptions
): FrameState {
    const { ctx, width, height } = renderCtx;
    const { effects, cursorPositions, cursorSettings, canvasSettings, viewportState, cursorState } = options;

    // Step 1: Compute frame state
    const frameState = computeFrameState(
        time,
        effects,
        cursorPositions,
        cursorSettings,
        viewportState,
        cursorState
    );

    // Step 2: Clear with background color
    ctx.fillStyle = canvasSettings.backgroundColor;
    ctx.fillRect(0, 0, width, height);

    // Step 3: Compute transform
    const transform = computeCanvasTransform(
        frameState,
        width,
        height,
        canvasSettings.paddingPercent
    );

    // Step 4: Draw video with transforms
    ctx.save();

    // Apply blur if needed
    if (frameState.blurIntensity > 0) {
        ctx.filter = `blur(${frameState.blurIntensity}px)`;
    }

    // Get video dimensions
    const videoWidth = video instanceof HTMLVideoElement ? video.videoWidth : video.width;
    const videoHeight = video instanceof HTMLVideoElement ? video.videoHeight : video.height;

    // Calculate aspect ratio preserving dimensions
    const aspectRatio = videoWidth / videoHeight;
    const canvasAspect = width / height;

    let drawWidth: number, drawHeight: number;
    if (aspectRatio > canvasAspect) {
        // Video is wider than canvas
        drawWidth = transform.videoWidth;
        drawHeight = transform.videoWidth / aspectRatio;
    } else {
        // Video is taller than canvas
        drawHeight = transform.videoHeight;
        drawWidth = transform.videoHeight * aspectRatio;
    }

    // Center the video in the transformed area
    const drawX = (width - drawWidth) / 2 + transform.translateX;
    const drawY = (height - drawHeight) / 2 + transform.translateY;

    // Apply border radius via clip path if needed
    if (canvasSettings.borderRadius > 0) {
        ctx.beginPath();
        roundRect(ctx, drawX, drawY, drawWidth, drawHeight, canvasSettings.borderRadius * frameState.scale);
        ctx.clip();
    }

    // Draw the video frame
    ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);

    ctx.restore();

    // Step 5: Draw cursor overlay
    if (frameState.cursorVisible) {
        // Convert normalized cursor position to canvas coordinates
        // Cursor pos is relative to video content, so we need to map to canvas
        const cursorCanvasX = drawX + frameState.cursorX * drawWidth;
        const cursorCanvasY = drawY + frameState.cursorY * drawHeight;

        drawCursor(
            ctx,
            cursorCanvasX,
            cursorCanvasY,
            cursorSettings.size * frameState.scale,  // Scale cursor with zoom
            cursorSettings.color,
            cursorSettings.style,
            frameState.cursorScale
        );
    }

    return frameState;
}

/**
 * Helper: Draw rounded rectangle path
 */
function roundRect(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
): void {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ============================================================================
// RENDER CONTEXT FACTORY
// ============================================================================

/**
 * Create a render context from a canvas element
 */
export function createRenderContext(canvas: HTMLCanvasElement | OffscreenCanvas): RenderContext {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Failed to get 2D rendering context');
    }

    return {
        canvas,
        ctx: ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
        width: canvas.width,
        height: canvas.height,
    };
}

/**
 * Create an OffscreenCanvas for export rendering
 */
export function createOffscreenContext(width: number, height: number): RenderContext {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Failed to get OffscreenCanvas 2D context');
    }

    return {
        canvas,
        ctx,
        width,
        height,
    };
}

// ============================================================================
// STATE EXPORTS (re-exported for convenience)
// ============================================================================

export { createViewportState, createCursorState, type ViewportState, type CursorState };
