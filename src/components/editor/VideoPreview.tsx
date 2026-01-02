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
function getCursorAtTime(positions: CursorPosition[], timeMs: number): { x: number; y: number } | null {
    if (positions.length === 0) return null;

    // Find surrounding positions
    let before: CursorPosition | null = null;
    let after: CursorPosition | null = null;

    for (let i = 0; i < positions.length; i++) {
        if (positions[i].timestamp_ms <= timeMs) {
            before = positions[i];
        }
        if (positions[i].timestamp_ms >= timeMs && !after) {
            after = positions[i];
            break;
        }
    }

    if (!before && !after) return null;
    if (!before) return after ? { x: after.x, y: after.y } : null;
    if (!after) return { x: before.x, y: before.y };

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
    // 1. Zoom in on double-click position
    // 2. If cursor moves during zoom, follow it smoothly
    // 3. Zoom out when cursor stops or duration ends

    const zoomStyle = useMemo(() => {
        const zoomEffect = activeEffects.find(e => e.type === 'zoom');

        // Base style with GPU optimization
        const baseStyle: React.CSSProperties = {
            willChange: 'transform',
            transformOrigin: 'center center',
        };

        if (!zoomEffect || !zoomEffect.scale) {
            return {
                ...baseStyle,
                transform: 'scale(1) translate(0%, 0%)',
                transition: 'transform 0.4s cubic-bezier(0.25, 0.1, 0.25, 1)',
            };
        }

        const effectDuration = zoomEffect.endTime - zoomEffect.startTime;
        const progress = effectDuration > 0
            ? (currentTime - zoomEffect.startTime) / effectDuration
            : 0;

        // Convert current video time to milliseconds for cursor lookup
        const currentTimeMs = currentTime * 1000;

        // Get current cursor position (follow cursor during zoom)
        let targetX = zoomEffect.targetX || 0.5;
        let targetY = zoomEffect.targetY || 0.5;

        // If we have cursor positions, use them to follow cursor
        if (cursorPositions.length > 0 && progress > 0 && progress < 1) {
            const cursorPos = getCursorAtTime(cursorPositions, currentTimeMs);
            if (cursorPos) {
                // Smoothly blend between original click position and current cursor
                const followStrength = 0.7; // How much to follow cursor (0-1)
                targetX = targetX + (cursorPos.x - targetX) * followStrength;
                targetY = targetY + (cursorPos.y - targetY) * followStrength;
            }
        }

        const targetScale = zoomEffect.scale;
        const translateX = (0.5 - targetX) * (targetScale - 1) * 100;
        const translateY = (0.5 - targetY) * (targetScale - 1) * 100;

        // Calculate phase-based zoom intensity
        // Zoom in fast (first 0.5s), hold while cursor moves, zoom out fast (last 0.5s)
        const ZOOM_IN_DURATION = 0.5; // seconds
        const ZOOM_OUT_DURATION = 0.5; // seconds

        const zoomInProgress = Math.min(1, (currentTime - zoomEffect.startTime) / ZOOM_IN_DURATION);
        const zoomOutProgress = Math.max(0, (zoomEffect.endTime - currentTime) / ZOOM_OUT_DURATION);

        let zoomIntensity: number;
        let transitionDuration: number;

        if (zoomInProgress < 1) {
            // Zoom-in phase
            zoomIntensity = zoomInProgress;
            transitionDuration = 0.15; // Fast, responsive transitions during zoom-in
        } else if (zoomOutProgress < 1) {
            // Zoom-out phase
            zoomIntensity = zoomOutProgress;
            transitionDuration = 0.15; // Fast zoom-out
        } else {
            // Hold phase - follow cursor
            zoomIntensity = 1;
            transitionDuration = 0.2; // Smooth following
        }

        // Clamp intensity
        zoomIntensity = Math.max(0, Math.min(1, zoomIntensity));

        const currentScale = 1 + (targetScale - 1) * zoomIntensity;
        const currentTranslateX = translateX * zoomIntensity;
        const currentTranslateY = translateY * zoomIntensity;

        return {
            ...baseStyle,
            transform: `scale(${currentScale.toFixed(4)}) translate(${currentTranslateX.toFixed(2)}%, ${currentTranslateY.toFixed(2)}%)`,
            transition: `transform ${transitionDuration.toFixed(2)}s cubic-bezier(0.25, 0.1, 0.25, 1)`,
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
