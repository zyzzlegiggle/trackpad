import { RefObject, useMemo } from 'react';
import { Effect, CursorPosition } from './types';

interface VideoPreviewProps {
    videoUrl: string;
    videoRef: RefObject<HTMLVideoElement | null>;
    isPlaying: boolean;
    videoLoaded: boolean;
    videoError: string;
    activeEffects: Effect[];
    currentTime: number;
    duration: number;
    cursorPositions: CursorPosition[];
    onTogglePlay: () => void;
    formatTimeDetailed: (seconds: number) => string;
}

// Helper: Find cursor position at a given time (interpolated)
// Optimized with binary search for O(log n) performance
function getCursorAtTime(positions: CursorPosition[], timeMs: number): { x: number; y: number } | null {
    if (positions.length === 0) return null;

    // Binary search to find the position just before or at timeMs
    let left = 0;
    let right = positions.length - 1;

    // Handle edge cases
    if (timeMs <= positions[0].timestamp_ms) {
        return { x: positions[0].x, y: positions[0].y };
    }
    if (timeMs >= positions[right].timestamp_ms) {
        return { x: positions[right].x, y: positions[right].y };
    }

    // Binary search for the interval containing timeMs
    while (left < right - 1) {
        const mid = Math.floor((left + right) / 2);
        if (positions[mid].timestamp_ms <= timeMs) {
            left = mid;
        } else {
            right = mid;
        }
    }

    const before = positions[left];
    const after = positions[right];

    // Interpolate between before and after
    const range = after.timestamp_ms - before.timestamp_ms;
    if (range === 0) return { x: before.x, y: before.y };

    const t = (timeMs - before.timestamp_ms) / range;
    return {
        x: before.x + (after.x - before.x) * t,
        y: before.y + (after.y - before.y) * t,
    };
}


export function VideoPreview({
    videoUrl,
    videoRef,
    isPlaying,
    videoLoaded,
    videoError,
    activeEffects,
    currentTime,
    duration,
    cursorPositions,
    onTogglePlay,
    formatTimeDetailed,
}: VideoPreviewProps) {
    // First Principles Cursor-Following Zoom:
    // 1. Smooth zoom in to the initial target position (not too close - 1.5x)
    // 2. Only pan when cursor moves OUTSIDE visible zoomed area
    // 3. Smooth zoom out at end of effect

    const zoomStyle = useMemo(() => {
        const zoomEffect = activeEffects.find(e => e.type === 'zoom');

        // Base style with GPU optimization
        const baseStyle: React.CSSProperties = {
            willChange: 'transform',
            transformOrigin: 'center center',
        };

        if (!zoomEffect) {
            return {
                ...baseStyle,
                transform: 'scale(1) translate(0%, 0%)',
                transition: 'transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
            };
        }

        // Fixed moderate zoom level (first principle: not too close)
        const ZOOM_SCALE = 1.5;
        const ZOOM_TRANSITION_TIME = 0.6; // seconds for smooth in/out

        const timeInEffect = currentTime - zoomEffect.startTime;
        const timeToEnd = zoomEffect.endTime - currentTime;

        // Initial target from the effect (where the click happened)
        const initialTargetX = zoomEffect.targetX ?? 0.5;
        const initialTargetY = zoomEffect.targetY ?? 0.5;

        // Start with initial target
        let viewportCenterX = initialTargetX;
        let viewportCenterY = initialTargetY;

        // Get current cursor position
        const currentTimeMs = currentTime * 1000;
        const cursorPos = cursorPositions.length > 0
            ? getCursorAtTime(cursorPositions, currentTimeMs)
            : null;

        // First principle: Only pan if cursor would be outside visible area
        // At 1.5x zoom, visible area is 1/1.5 = 0.667 of the full frame
        // So visible range from center is +/- 0.333
        if (cursorPos && timeInEffect > ZOOM_TRANSITION_TIME && timeToEnd > ZOOM_TRANSITION_TIME) {
            const visibleRange = 1 / ZOOM_SCALE / 2; // Half the visible area
            const margin = visibleRange * 0.8; // Add 20% margin before panning

            // Check if cursor is outside the visible boundary
            const cursorOffsetX = cursorPos.x - viewportCenterX;
            const cursorOffsetY = cursorPos.y - viewportCenterY;

            // Only adjust if cursor would be clipped
            if (Math.abs(cursorOffsetX) > margin) {
                // Move viewport minimally to keep cursor visible with margin
                const adjustment = cursorOffsetX > 0
                    ? cursorOffsetX - margin
                    : cursorOffsetX + margin;
                viewportCenterX += adjustment;
            }
            if (Math.abs(cursorOffsetY) > margin) {
                const adjustment = cursorOffsetY > 0
                    ? cursorOffsetY - margin
                    : cursorOffsetY + margin;
                viewportCenterY += adjustment;
            }

            // Clamp viewport center to valid range (prevent showing black edges)
            const minCenter = 1 / ZOOM_SCALE / 2;
            const maxCenter = 1 - minCenter;
            viewportCenterX = Math.max(minCenter, Math.min(maxCenter, viewportCenterX));
            viewportCenterY = Math.max(minCenter, Math.min(maxCenter, viewportCenterY));
        }

        // Calculate zoom intensity with smooth ease-in and ease-out
        let zoomIntensity: number;

        if (timeInEffect < ZOOM_TRANSITION_TIME) {
            // Zoom-in phase: smooth ease-in using cubic bezier approximation
            const t = timeInEffect / ZOOM_TRANSITION_TIME;
            zoomIntensity = t * t * (3 - 2 * t); // Smoothstep function
        } else if (timeToEnd < ZOOM_TRANSITION_TIME) {
            // Zoom-out phase: smooth ease-out
            const t = timeToEnd / ZOOM_TRANSITION_TIME;
            zoomIntensity = t * t * (3 - 2 * t); // Smoothstep function
        } else {
            // Hold phase: fully zoomed
            zoomIntensity = 1;
        }

        // Calculate final transform values
        const currentScale = 1 + (ZOOM_SCALE - 1) * zoomIntensity;
        const translateX = (0.5 - viewportCenterX) * (currentScale - 1) * 100;
        const translateY = (0.5 - viewportCenterY) * (currentScale - 1) * 100;

        // Use longer transition during zoom in/out, shorter for panning
        const isTransitioning = timeInEffect < ZOOM_TRANSITION_TIME || timeToEnd < ZOOM_TRANSITION_TIME;
        const transitionDuration = isTransitioning ? 0.15 : 0.3;

        return {
            ...baseStyle,
            transform: `scale(${currentScale.toFixed(4)}) translate(${translateX.toFixed(2)}%, ${translateY.toFixed(2)}%)`,
            transition: `transform ${transitionDuration}s cubic-bezier(0.4, 0, 0.2, 1)`,
        };
    }, [activeEffects, currentTime, cursorPositions]);

    // Memoize blur filter
    const videoFilter = useMemo(() => {
        const blurEffect = activeEffects.find(e => e.type === 'blur');
        if (!blurEffect || !blurEffect.intensity) return {};
        return {
            filter: `blur(${blurEffect.intensity}px)`,
            transition: 'filter 0.3s ease',
        };
    }, [activeEffects]);

    return (
        <div className="relative flex-1 min-h-0 bg-gray-900 rounded-xl overflow-hidden flex flex-col">
            {videoError && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-red-500 text-sm z-10">
                    <span>{videoError}</span>
                </div>
            )}
            {!videoLoaded && !videoError && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-400 text-sm z-10">Loading video...</div>
            )}
            <div className="flex-1 flex items-center justify-center" style={{ ...zoomStyle, ...videoFilter }}>
                <video
                    ref={videoRef}
                    src={videoUrl}
                    className="max-w-full max-h-full object-contain"
                    onClick={onTogglePlay}
                    style={{ display: videoError ? 'none' : 'block' }}
                />
            </div>
            <div className="absolute top-0 left-0 right-0 bottom-12 flex items-center justify-center cursor-pointer" onClick={onTogglePlay}>
                {!isPlaying && videoLoaded && (
                    <div className="w-14 h-14 bg-white/95 rounded-full flex items-center justify-center shadow-lg transition-transform duration-200 hover:scale-110">
                        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5.5 h-5.5 text-gray-900 ml-0.5">
                            <polygon points="5,3 19,12 5,21" />
                        </svg>
                    </div>
                )}
            </div>

            {/* Playback Controls Bar */}
            <div className="flex items-center gap-3 px-4 py-2 bg-black/60 backdrop-blur-sm">
                <button
                    className="w-8 h-8 border-none bg-transparent rounded-md cursor-pointer flex items-center justify-center text-white transition-colors duration-200 hover:bg-white/15"
                    onClick={onTogglePlay}
                >
                    {isPlaying ? (
                        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                            <rect x="6" y="4" width="4" height="16" />
                            <rect x="14" y="4" width="4" height="16" />
                        </svg>
                    ) : (
                        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                            <polygon points="5,3 19,12 5,21" />
                        </svg>
                    )}
                </button>
                <div className="flex items-center gap-1 font-mono text-sm text-white">
                    <span>{formatTimeDetailed(currentTime)}</span>
                    <span className="text-white/50">/</span>
                    <span className="text-white/70">{formatTimeDetailed(duration)}</span>
                </div>
            </div>
        </div>
    );
}
