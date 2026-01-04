import { RefObject, useMemo, useRef } from 'react';
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
    backgroundColor: string;
    onTogglePlay: () => void;
    formatTimeDetailed: (seconds: number) => string;
}

// Binary search with cached last index for sequential access optimization
function getCursorAtTime(
    positions: CursorPosition[],
    timeMs: number,
    lastIndexRef: { current: number }
): { x: number; y: number } | null {
    const len = positions.length;
    if (len === 0) return null;

    // Check if last index is still valid (sequential playback optimization)
    const lastIdx = lastIndexRef.current;
    if (lastIdx >= 0 && lastIdx < len - 1) {
        const before = positions[lastIdx];
        const after = positions[lastIdx + 1];
        if (before.timestamp_ms <= timeMs && timeMs <= after.timestamp_ms) {
            // Cache hit - interpolate directly
            const range = after.timestamp_ms - before.timestamp_ms;
            if (range === 0) return { x: before.x, y: before.y };
            const t = (timeMs - before.timestamp_ms) / range;
            return {
                x: before.x + (after.x - before.x) * t,
                y: before.y + (after.y - before.y) * t,
            };
        }
    }

    // Edge cases
    if (timeMs <= positions[0].timestamp_ms) {
        lastIndexRef.current = 0;
        return { x: positions[0].x, y: positions[0].y };
    }
    if (timeMs >= positions[len - 1].timestamp_ms) {
        lastIndexRef.current = len - 2;
        return { x: positions[len - 1].x, y: positions[len - 1].y };
    }

    // Binary search
    let left = 0;
    let right = len - 1;
    while (left < right - 1) {
        const mid = (left + right) >> 1; // Faster than Math.floor
        if (positions[mid].timestamp_ms <= timeMs) {
            left = mid;
        } else {
            right = mid;
        }
    }

    lastIndexRef.current = left;
    const before = positions[left];
    const after = positions[right];

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
    backgroundColor,
    onTogglePlay,
    formatTimeDetailed,
}: VideoPreviewProps) {
    // Cache for cursor position lookup (sequential access optimization)
    const cursorIndexRef = useRef(0);

    // Check if there's an active zoom effect first (early bailout)
    const zoomEffect = useMemo(
        () => activeEffects.find(e => e.type === 'zoom'),
        [activeEffects]
    );

    const zoomStyle = useMemo(() => {
        // No zoom effect - use CSS transition for smooth return to normal
        if (!zoomEffect) {
            return {
                transform: 'scale(1) translate(0%, 0%)',
                transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
            };
        }

        // Constants
        const ZOOM_SCALE = 1.5;
        const ZOOM_TRANSITION_TIME = 0.6;

        const timeInEffect = currentTime - zoomEffect.startTime;
        const timeToEnd = zoomEffect.endTime - currentTime;

        // Initial target
        let viewportCenterX = zoomEffect.targetX ?? 0.5;
        let viewportCenterY = zoomEffect.targetY ?? 0.5;

        // Only do cursor lookup during hold phase
        if (cursorPositions.length > 0 && timeInEffect > ZOOM_TRANSITION_TIME && timeToEnd > ZOOM_TRANSITION_TIME) {
            const cursorPos = getCursorAtTime(cursorPositions, currentTime * 1000, cursorIndexRef);

            if (cursorPos) {
                const visibleRange = 1 / ZOOM_SCALE / 2;
                const margin = visibleRange * 0.8;

                const cursorOffsetX = cursorPos.x - viewportCenterX;
                const cursorOffsetY = cursorPos.y - viewportCenterY;

                if (Math.abs(cursorOffsetX) > margin) {
                    viewportCenterX += cursorOffsetX > 0 ? cursorOffsetX - margin : cursorOffsetX + margin;
                }
                if (Math.abs(cursorOffsetY) > margin) {
                    viewportCenterY += cursorOffsetY > 0 ? cursorOffsetY - margin : cursorOffsetY + margin;
                }

                // Clamp
                const minCenter = 1 / ZOOM_SCALE / 2;
                const maxCenter = 1 - minCenter;
                viewportCenterX = Math.max(minCenter, Math.min(maxCenter, viewportCenterX));
                viewportCenterY = Math.max(minCenter, Math.min(maxCenter, viewportCenterY));
            }
        }

        // Calculate zoom intensity with smoothstep (handles smooth animation mathematically)
        let zoomIntensity: number;
        if (timeInEffect < ZOOM_TRANSITION_TIME) {
            const t = timeInEffect / ZOOM_TRANSITION_TIME;
            zoomIntensity = t * t * (3 - 2 * t);
        } else if (timeToEnd < ZOOM_TRANSITION_TIME) {
            const t = timeToEnd / ZOOM_TRANSITION_TIME;
            zoomIntensity = t * t * (3 - 2 * t);
        } else {
            zoomIntensity = 1;
        }

        const currentScale = 1 + (ZOOM_SCALE - 1) * zoomIntensity;
        const translateX = (0.5 - viewportCenterX) * (currentScale - 1) * 100;
        const translateY = (0.5 - viewportCenterY) * (currentScale - 1) * 100;

        // CRITICAL: No CSS transition during active zoom - smoothstep handles smoothness
        // CSS transitions fight against rapid time updates causing lag
        return {
            transform: `scale(${currentScale.toFixed(3)}) translate(${translateX.toFixed(1)}%, ${translateY.toFixed(1)}%)`,
            // No transition - direct updates are smoother during playback
        };
    }, [zoomEffect, currentTime, cursorPositions]);

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
            {/* Padded canvas container - matches export behavior */}
            {/* When zooming to edges, the background color shows instead of black */}
            <div
                className="flex-1 flex items-center justify-center"
                style={{
                    backgroundColor: backgroundColor,
                }}
            >
                <div
                    className="relative flex items-center justify-center"
                    style={{
                        ...zoomStyle,
                        ...videoFilter,
                        // Add padding around video for zoom at edges
                        padding: '15%',
                    }}
                >
                    <video
                        ref={videoRef}
                        src={videoUrl}
                        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
                        onClick={onTogglePlay}
                        style={{ display: videoError ? 'none' : 'block' }}
                    />
                </div>
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
