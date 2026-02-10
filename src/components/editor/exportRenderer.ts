/**
 * exportRenderer.ts
 * 
 * FIRST PRINCIPLES: Frame-by-frame export using the same canvas renderer as preview.
 * Generates raw RGB frames that FFmpeg can encode.
 * 
 * Export Pipeline:
 * 1. Create OffscreenCanvas at export resolution
 * 2. Step through video frame-by-frame (seek + render)
 * 3. Extract raw RGBA pixels from canvas
 * 4. Pass to Rust backend for FFmpeg encoding
 * 
 * Speed Optimizations:
 * - Use OffscreenCanvas (runs off main thread if in worker)
 * - Batch frame data transfer
 * - Minimize allocations by reusing buffers
 */

import {
    renderFrame,
    createOffscreenContext,
    createViewportState,
    createCursorState,
    RenderContext,
    RenderOptions,
    ViewportState,
    CursorState,
} from './canvasRenderer';
import { Effect, CursorPosition, CursorSettings, CanvasSettings } from './types';

// ============================================================================
// TYPES
// ============================================================================

export interface ExportConfig {
    /** Output width in pixels */
    width: number;
    /** Output height in pixels */
    height: number;
    /** Frames per second */
    fps: number;
    /** Start time in seconds */
    startTime: number;
    /** End time in seconds */
    endTime: number;
    /** Effects to apply */
    effects: Effect[];
    /** Cursor position data */
    cursorPositions: CursorPosition[];
    /** Cursor rendering settings */
    cursorSettings: CursorSettings;
    /** Canvas/background settings */
    canvasSettings: CanvasSettings;
}

export interface ExportProgress {
    currentFrame: number;
    totalFrames: number;
    percentage: number;
    elapsedMs: number;
    estimatedRemainingMs: number;
}

export type ProgressCallback = (progress: ExportProgress) => void;
export type FrameCallback = (frameData: Uint8Array, frameIndex: number) => Promise<void>;

// ============================================================================
// FRAME EXTRACTION
// ============================================================================

/**
 * Extract raw RGBA pixel data from canvas
 * 
 * Returns a Uint8Array with RGBA values for each pixel.
 * Format: [R, G, B, A, R, G, B, A, ...] for each pixel left-to-right, top-to-bottom
 */
export function extractFrameData(ctx: RenderContext): Uint8Array {
    const imageData = ctx.ctx.getImageData(0, 0, ctx.width, ctx.height);
    return new Uint8Array(imageData.data.buffer);
}

/**
 * Extract raw RGB pixel data (no alpha) from canvas
 * 
 * FFmpeg rawvideo format typically expects RGB24 (no alpha).
 * This is more efficient for encoding.
 */
export function extractFrameDataRGB(ctx: RenderContext): Uint8Array {
    const imageData = ctx.ctx.getImageData(0, 0, ctx.width, ctx.height);
    const rgba = imageData.data;
    const pixelCount = ctx.width * ctx.height;
    const rgb = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        rgb[i * 3] = rgba[i * 4];       // R
        rgb[i * 3 + 1] = rgba[i * 4 + 1]; // G
        rgb[i * 3 + 2] = rgba[i * 4 + 2]; // B
        // Skip alpha
    }

    return rgb;
}

// ============================================================================
// VIDEO FRAME SEEKING
// ============================================================================

/**
 * Seek video to specific time and wait for frame to be ready
 * 
 * FIRST PRINCIPLES: Video seeking is async - we must wait for 'seeked' event
 * before the frame data is available for drawing.
 */
function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            resolve();
        };

        const onError = () => {
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            reject(new Error(`Failed to seek to ${time}s`));
        };

        video.addEventListener('seeked', onSeeked);
        video.addEventListener('error', onError);
        video.currentTime = time;
    });
}

// ============================================================================
// MAIN EXPORT FUNCTION
// ============================================================================

/**
 * Export video frames by rendering each frame through the canvas pipeline
 * 
 * FIRST PRINCIPLES:
 * - This uses the EXACT same rendering code as preview
 * - We step through time at the export FPS rate
 * - Each frame is rendered to canvas, then pixels are extracted
 * - The frame callback handles sending data to the backend
 * 
 * @param video - Source video element (should be loaded and ready)
 * @param config - Export configuration
 * @param onFrame - Callback for each rendered frame (async to allow backpressure)
 * @param onProgress - Progress callback
 * @returns Promise that resolves when all frames are rendered
 */
export async function exportFrames(
    video: HTMLVideoElement,
    config: ExportConfig,
    onFrame: FrameCallback,
    onProgress?: ProgressCallback
): Promise<void> {
    const {
        width,
        height,
        fps,
        startTime,
        endTime,
        effects,
        cursorPositions,
        cursorSettings,
        canvasSettings,
    } = config;

    // Create rendering context
    const renderCtx = createOffscreenContext(width, height);

    // Initialize state (persists across frames for smooth transitions)
    const viewportState: ViewportState = createViewportState();
    const cursorState: CursorState = createCursorState();

    // Calculate frame timing
    const duration = endTime - startTime;
    const totalFrames = Math.ceil(duration * fps);
    const frameDuration = 1 / fps;

    const startMs = performance.now();

    // Render options (reused for each frame)
    const renderOptions: RenderOptions = {
        effects,
        cursorPositions,
        cursorSettings,
        canvasSettings,
        viewportState,
        cursorState,
    };

    // Pre-filter effects to only those in the export range
    const relevantEffects = effects.filter(e =>
        (e.startTime <= endTime && e.endTime >= startTime)
    );
    renderOptions.effects = relevantEffects;

    console.log(`[ExportRenderer] Starting export: ${totalFrames} frames at ${fps}fps`);
    console.log(`[ExportRenderer] Resolution: ${width}x${height}`);
    console.log(`[ExportRenderer] Time range: ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s`);

    // Pause video during export
    video.pause();

    // Render each frame
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        const time = startTime + frameIndex * frameDuration;

        // Seek video to frame time
        await seekVideo(video, time);

        // Render frame using unified renderer
        renderFrame(video, time, renderCtx, renderOptions);

        // Extract raw RGB pixel data
        const frameData = extractFrameDataRGB(renderCtx);

        // Send frame to callback (async to allow backpressure from FFmpeg)
        await onFrame(frameData, frameIndex);

        // Report progress
        if (onProgress && frameIndex % 10 === 0) {
            const elapsedMs = performance.now() - startMs;
            const framesPerMs = frameIndex / elapsedMs;
            const remainingFrames = totalFrames - frameIndex;
            const estimatedRemainingMs = framesPerMs > 0 ? remainingFrames / framesPerMs : 0;

            onProgress({
                currentFrame: frameIndex,
                totalFrames,
                percentage: (frameIndex / totalFrames) * 100,
                elapsedMs,
                estimatedRemainingMs,
            });
        }
    }

    // Final progress update
    if (onProgress) {
        const elapsedMs = performance.now() - startMs;
        onProgress({
            currentFrame: totalFrames,
            totalFrames,
            percentage: 100,
            elapsedMs,
            estimatedRemainingMs: 0,
        });
    }

    console.log(`[ExportRenderer] Export complete: ${totalFrames} frames in ${((performance.now() - startMs) / 1000).toFixed(2)}s`);
}

// ============================================================================
// BATCH EXPORT (for memory efficiency)
// ============================================================================

/**
 * Export frames in batches, useful for large videos to manage memory
 * 
 * @param video - Source video element
 * @param config - Export configuration  
 * @param batchSize - Number of frames per batch
 * @param onBatch - Callback with batch of frame data
 * @param onProgress - Progress callback
 */
export async function exportFramesBatched(
    video: HTMLVideoElement,
    config: ExportConfig,
    batchSize: number,
    onBatch: (frames: Uint8Array[], startIndex: number) => Promise<void>,
    onProgress?: ProgressCallback
): Promise<void> {
    const {
        width,
        height,
        fps,
        startTime,
        endTime,
        effects,
        cursorPositions,
        cursorSettings,
        canvasSettings,
    } = config;

    const renderCtx = createOffscreenContext(width, height);
    const viewportState: ViewportState = createViewportState();
    const cursorState: CursorState = createCursorState();

    const duration = endTime - startTime;
    const totalFrames = Math.ceil(duration * fps);
    const frameDuration = 1 / fps;

    const startMs = performance.now();

    const renderOptions: RenderOptions = {
        effects: effects.filter(e => e.startTime <= endTime && e.endTime >= startTime),
        cursorPositions,
        cursorSettings,
        canvasSettings,
        viewportState,
        cursorState,
    };

    video.pause();

    let batch: Uint8Array[] = [];
    let batchStartIndex = 0;

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        const time = startTime + frameIndex * frameDuration;

        await seekVideo(video, time);
        renderFrame(video, time, renderCtx, renderOptions);
        batch.push(extractFrameDataRGB(renderCtx));

        // When batch is full, send it
        if (batch.length >= batchSize || frameIndex === totalFrames - 1) {
            await onBatch(batch, batchStartIndex);
            batchStartIndex = frameIndex + 1;
            batch = [];
        }

        if (onProgress && frameIndex % 10 === 0) {
            const elapsedMs = performance.now() - startMs;
            const framesPerMs = frameIndex / elapsedMs;
            const remainingFrames = totalFrames - frameIndex;

            onProgress({
                currentFrame: frameIndex,
                totalFrames,
                percentage: (frameIndex / totalFrames) * 100,
                elapsedMs,
                estimatedRemainingMs: framesPerMs > 0 ? remainingFrames / framesPerMs : 0,
            });
        }
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Calculate total frame count for an export
 */
export function calculateFrameCount(startTime: number, endTime: number, fps: number): number {
    return Math.ceil((endTime - startTime) * fps);
}

/**
 * Calculate estimated file size for raw RGB export (uncompressed)
 * This is for planning purposes - actual export will be much smaller after encoding
 */
export function calculateRawSize(width: number, height: number, frameCount: number): number {
    return width * height * 3 * frameCount; // RGB = 3 bytes per pixel
}
