import { RefObject, useMemo, useRef, useState, useEffect } from 'react';
import { Effect, CursorPosition, ClickEvent, CanvasSettings, EasingPreset } from './types';
import { ZOOM_EASING_PRESETS } from './constants';

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
    clickEvents: ClickEvent[];
    canvasSettings: CanvasSettings;
    onTogglePlay: () => void;
    formatTimeDetailed: (seconds: number) => string;
}

// Click ripple component - renders expanding circle at click position
interface RippleState {
    id: string;
    x: number; // Normalized 0-1
    y: number; // Normalized 0-1
    startTime: number;
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
    clickEvents,
    canvasSettings,
    onTogglePlay,
    formatTimeDetailed,
}: VideoPreviewProps) {
    // Cache for cursor position lookup (sequential access optimization)
    const cursorIndexRef = useRef(0);

    // Ref for direct DOM manipulation - bypasses React reconciliation for 60fps
    const zoomContainerRef = useRef<HTMLDivElement>(null);

    // Active ripples for click animation
    const [activeRipples, setActiveRipples] = useState<RippleState[]>([]);
    const lastProcessedClickRef = useRef<number>(-1);

    // Check if there's an active zoom effect first
    const zoomEffect = useMemo(
        () => activeEffects.find(e => e.type === 'zoom'),
        [activeEffects]
    );

    // Get easing duration from zoom effect
    const easingDuration = useMemo(() => {
        if (!zoomEffect) return 0.35; // Default mellow
        const preset: EasingPreset = zoomEffect.easing || 'mellow';
        return ZOOM_EASING_PRESETS[preset].duration;
    }, [zoomEffect]);

    // Process click events to show ripples during playback
    useEffect(() => {
        if (!canvasSettings.clickRippleEnabled || !isPlaying) return;

        const currentTimeMs = currentTime * 1000;
        const RIPPLE_DURATION_MS = 400;
        const CLICK_TOLERANCE_MS = 50; // Show ripple if within 50ms of click

        // Find clicks near current time that we haven't processed yet
        clickEvents.forEach((click, index) => {
            if (index <= lastProcessedClickRef.current) return;

            const timeDiff = currentTimeMs - click.timestamp_ms;
            if (timeDiff >= 0 && timeDiff < CLICK_TOLERANCE_MS) {
                // Add new ripple
                const ripple: RippleState = {
                    id: `ripple-${click.timestamp_ms}-${index}`,
                    x: click.x,
                    y: click.y,
                    startTime: Date.now(),
                };
                setActiveRipples(prev => [...prev, ripple]);
                lastProcessedClickRef.current = index;

                // Remove ripple after animation completes
                setTimeout(() => {
                    setActiveRipples(prev => prev.filter(r => r.id !== ripple.id));
                }, RIPPLE_DURATION_MS);
            }
        });
    }, [currentTime, clickEvents, isPlaying, canvasSettings.clickRippleEnabled]);

    // Reset click processing when seeking or stopping
    useEffect(() => {
        if (!isPlaying) {
            // When paused/stopped, reset to process clicks from the beginning
            lastProcessedClickRef.current = -1;
            setActiveRipples([]);
        }
    }, [isPlaying]);

    // PERFORMANCE OPTIMIZATION: Use requestAnimationFrame for smooth 60fps zoom
    // First Principles: 
    // - React's render cycle adds latency between video time and visual updates
    // - RAF reads video.currentTime directly, bypassing React state entirely
    // - This is how professional tools (Screen Studio, Cursorful) achieve smoothness

    // Persist viewport position between frames for smooth camera movement
    const viewportRef = useRef({ x: 0.5, y: 0.5, lastEffectId: '' });
    const rafIdRef = useRef<number | null>(null);

    // Store effect data in refs to avoid closure stale values in RAF loop
    const activeEffectsRef = useRef(activeEffects);
    const cursorPositionsRef = useRef(cursorPositions);
    const easingDurationRef = useRef(easingDuration);

    // Update refs when props change
    useEffect(() => {
        activeEffectsRef.current = activeEffects;
        cursorPositionsRef.current = cursorPositions;
        easingDurationRef.current = easingDuration;
    }, [activeEffects, cursorPositions, easingDuration]);

    // Main animation loop - runs at 60fps using RAF
    useEffect(() => {
        const container = zoomContainerRef.current;
        const video = videoRef.current;
        if (!container || !video) return;

        const animate = () => {
            const effects = activeEffectsRef.current;
            const positions = cursorPositionsRef.current;
            const duration = easingDurationRef.current;

            // Read time directly from video element (not React state!)
            const time = video.currentTime;

            // Find active zoom effect at current time
            const zoomEffect = effects.find(
                e => e.type === 'zoom' && time >= e.startTime && time <= e.endTime
            );

            const ZOOM_SCALE = zoomEffect?.scale || 3.0;
            const ZOOM_TRANSITION_TIME = duration;

            if (!zoomEffect) {
                // No zoom - smoothly reset with CSS transition
                container.style.transform = 'translate3d(0, 0, 0) scale(1)';
                container.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
                viewportRef.current = { x: 0.5, y: 0.5, lastEffectId: '' };
            } else {
                // Active zoom - disable transition, compute directly
                container.style.transition = 'none';

                const timeInEffect = time - zoomEffect.startTime;
                const timeToEnd = zoomEffect.endTime - time;

                // Initialize viewport for new effect
                if (viewportRef.current.lastEffectId !== zoomEffect.id) {
                    viewportRef.current = {
                        x: zoomEffect.targetX ?? 0.5,
                        y: zoomEffect.targetY ?? 0.5,
                        lastEffectId: zoomEffect.id,
                    };
                }

                let viewportX = viewportRef.current.x;
                let viewportY = viewportRef.current.y;

                // Follow cursor during hold phase
                if (positions.length > 0 && timeInEffect > ZOOM_TRANSITION_TIME && timeToEnd > ZOOM_TRANSITION_TIME) {
                    const cursorPos = getCursorAtTime(positions, time * 1000, cursorIndexRef);
                    if (cursorPos) {
                        const SMOOTHING = 0.12; // Slightly higher = more responsive
                        viewportX += (cursorPos.x - viewportX) * SMOOTHING;
                        viewportY += (cursorPos.y - viewportY) * SMOOTHING;

                        const minCenter = 1 / ZOOM_SCALE / 2;
                        const maxCenter = 1 - minCenter;
                        viewportX = Math.max(minCenter, Math.min(maxCenter, viewportX));
                        viewportY = Math.max(minCenter, Math.min(maxCenter, viewportY));

                        viewportRef.current.x = viewportX;
                        viewportRef.current.y = viewportY;
                    }
                }

                // Smoothstep for zoom in/out
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
                const translateX = (0.5 - viewportX) * (currentScale - 1) * 100;
                const translateY = (0.5 - viewportY) * (currentScale - 1) * 100;

                // Use translate3d for GPU acceleration
                container.style.transform = `translate3d(${translateX.toFixed(1)}%, ${translateY.toFixed(1)}%, 0) scale(${currentScale.toFixed(3)})`;
            }

            // Continue loop
            rafIdRef.current = requestAnimationFrame(animate);
        };

        // Start animation loop
        rafIdRef.current = requestAnimationFrame(animate);

        // Cleanup on unmount
        return () => {
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
            }
        };
    }, [videoRef]); // Only re-run if videoRef changes

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
                className="flex-1 flex items-center justify-center overflow-hidden"
                style={{
                    backgroundColor: canvasSettings.backgroundColor,
                }}
            >
                <div
                    ref={zoomContainerRef}
                    className="relative flex items-center justify-center w-full h-full"
                    style={{
                        ...videoFilter,
                        padding: `${canvasSettings.paddingPercent}%`,
                        willChange: 'transform',  // GPU acceleration hint
                    }}
                >
                    <video
                        ref={videoRef}
                        src={videoUrl}
                        className="max-w-full max-h-full object-contain shadow-2xl"
                        onClick={onTogglePlay}
                        style={{
                            display: videoError ? 'none' : 'block',
                            imageRendering: 'auto',  // Let browser optimize
                            borderRadius: `${canvasSettings.borderRadius}px`,
                        }}
                    />

                    {/* Click Ripples Overlay - positioned over the video */}
                    {canvasSettings.clickRippleEnabled && activeRipples.map(ripple => (
                        <div
                            key={ripple.id}
                            className="absolute pointer-events-none rounded-full border-2 border-white/80"
                            style={{
                                left: `${ripple.x * 100}%`,
                                top: `${ripple.y * 100}%`,
                                width: '40px',
                                height: '40px',
                                animation: 'click-ripple 0.4s ease-out forwards',
                            }}
                        />
                    ))}
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

