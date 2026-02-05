import { RefObject, useMemo, useRef, useState, useEffect } from 'react';
import { Effect, CursorPosition, ClickEvent, CanvasSettings, CursorSettings, EasingPreset } from './types';
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
    cursorSettings: CursorSettings;
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
    cursorSettings,
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

    // Custom cursor state - position and velocity for smooth rendering
    const cursorOverlayRef = useRef<HTMLDivElement>(null);
    const cursorStateRef = useRef({ x: 0.5, y: 0.5, prevX: 0.5, prevY: 0.5, velocity: 0 });

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
    const cursorSettingsRef = useRef(cursorSettings);

    // Update refs when props change
    useEffect(() => {
        activeEffectsRef.current = activeEffects;
        cursorPositionsRef.current = cursorPositions;
        easingDurationRef.current = easingDuration;
        cursorSettingsRef.current = cursorSettings;
    }, [activeEffects, cursorPositions, easingDuration, cursorSettings]);

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
            // ANTICIPATION MODEL: Zoom-in happens BEFORE startTime, so effect is active from (startTime - duration)
            const zoomEffect = effects.find(
                e => e.type === 'zoom' && time >= (e.startTime - duration) && time <= e.endTime
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

                // ANTICIPATION TIMING: Zoom is fully in AT startTime (the click moment)
                // Zoom-in happens from (startTime - duration) to startTime
                // Hold happens from startTime to (endTime - duration)
                // Zoom-out happens from (endTime - duration) to endTime
                const anticipationStart = zoomEffect.startTime - duration;
                const timeFromAnticipation = time - anticipationStart; // Time since zoom-in began
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

                // Follow cursor during hold phase (between startTime and endTime - duration)
                // With anticipation model, hold starts at startTime (fully zoomed) and ends at (endTime - duration)
                if (positions.length > 0 && time >= zoomEffect.startTime && timeToEnd > ZOOM_TRANSITION_TIME) {
                    const cursorPos = getCursorAtTime(positions, time * 1000, cursorIndexRef);
                    if (cursorPos) {
                        // SMART VIEWPORT PANNING (First Principles):
                        // Instead of always following cursor, only pan when cursor approaches viewport edges.
                        // This keeps cursor in an "inner container" for better UX (less jerky, easier to aim).
                        //
                        // Inner container: 70% of viewport (35% from center each way)
                        // Outer container: 15% margin on each edge - triggers panning
                        const INNER_MARGIN = 0.15;  // 15% margin for outer container
                        const PAN_SPEED = 0.08;     // How fast viewport moves when panning

                        // Calculate visible viewport size at current zoom
                        // At scale S, viewport shows 1/S of the video in each dimension
                        const halfViewport = 0.5 / ZOOM_SCALE;
                        const innerHalf = halfViewport * (1 - 2 * INNER_MARGIN);  // Inner safe zone

                        // Cursor position relative to viewport center
                        const relX = cursorPos.x - viewportX;
                        const relY = cursorPos.y - viewportY;

                        // If cursor is outside inner container, move viewport towards it
                        if (Math.abs(relX) > innerHalf) {
                            const direction = relX > 0 ? 1 : -1;
                            const overshoot = Math.abs(relX) - innerHalf;
                            viewportX += direction * PAN_SPEED * overshoot * 2;
                        }
                        if (Math.abs(relY) > innerHalf) {
                            const direction = relY > 0 ? 1 : -1;
                            const overshoot = Math.abs(relY) - innerHalf;
                            viewportY += direction * PAN_SPEED * overshoot * 2;
                        }

                        // Clamp viewport to video bounds
                        const minCenter = 0.5 / ZOOM_SCALE;
                        const maxCenter = 1 - minCenter;
                        viewportX = Math.max(minCenter, Math.min(maxCenter, viewportX));
                        viewportY = Math.max(minCenter, Math.min(maxCenter, viewportY));

                        viewportRef.current.x = viewportX;
                        viewportRef.current.y = viewportY;
                    }
                }

                // Smoothstep for zoom in/out with ANTICIPATION model
                // Zoom-in: from (startTime - duration) to startTime → fully zoomed AT startTime
                // Hold: from startTime to (endTime - duration)
                // Zoom-out: from (endTime - duration) to endTime
                let zoomIntensity: number;
                if (timeFromAnticipation < ZOOM_TRANSITION_TIME) {
                    // Zooming IN (anticipation phase before the click)
                    const t = timeFromAnticipation / ZOOM_TRANSITION_TIME;
                    zoomIntensity = t * t * (3 - 2 * t);
                } else if (timeToEnd < ZOOM_TRANSITION_TIME) {
                    // Zooming OUT
                    const t = timeToEnd / ZOOM_TRANSITION_TIME;
                    zoomIntensity = t * t * (3 - 2 * t);
                } else {
                    // Hold phase (fully zoomed)
                    zoomIntensity = 1;
                }

                const currentScale = 1 + (ZOOM_SCALE - 1) * zoomIntensity;
                const translateX = (0.5 - viewportX) * (currentScale - 1) * 100;
                const translateY = (0.5 - viewportY) * (currentScale - 1) * 100;

                // Use translate3d for GPU acceleration
                container.style.transform = `translate3d(${translateX.toFixed(1)}%, ${translateY.toFixed(1)}%, 0) scale(${currentScale.toFixed(3)})`;
            }

            // Update custom cursor overlay position
            // FIRST PRINCIPLES: Cursor positions are normalized (0-1) relative to the captured video content.
            // We need to position the cursor relative to where the VIDEO actually renders, not the container.
            // The container has padding which offsets the video, so we must account for this.
            const cursorEl = cursorOverlayRef.current;
            const curSettings = cursorSettingsRef.current;
            const videoEl = video; // Already have reference from earlier

            if (cursorEl && curSettings.visible && positions.length > 0 && videoEl) {
                const rawPos = getCursorAtTime(positions, time * 1000, cursorIndexRef);
                if (rawPos) {
                    const state = cursorStateRef.current;

                    // Lerp for smooth movement (lower = smoother but laggy)
                    const smoothing = curSettings.smoothing;
                    state.x += (rawPos.x - state.x) * smoothing;
                    state.y += (rawPos.y - state.y) * smoothing;

                    // Calculate velocity (distance per frame, normalized)
                    const dx = state.x - state.prevX;
                    const dy = state.y - state.prevY;
                    const frameVelocity = Math.hypot(dx, dy);
                    // Smooth velocity over time
                    state.velocity = state.velocity * 0.8 + frameVelocity * 0.2;

                    state.prevX = state.x;
                    state.prevY = state.y;

                    // Apply velocity scaling if enabled (subtle effect)
                    const velocityScale = curSettings.velocityScale
                        ? 1 + Math.min(state.velocity * 30, 0.5) // Max 1.5x scale
                        : 1;

                    // FIRST PRINCIPLES FIX: Get actual video element position within container
                    // The video element uses object-contain, so its rendered dimensions may differ
                    // from the container. We need to calculate where the video actually is.
                    const videoRect = videoEl.getBoundingClientRect();
                    const containerEl = container;
                    const containerRect = containerEl.getBoundingClientRect();

                    // Calculate video position relative to container (in pixels)
                    const videoOffsetX = videoRect.left - containerRect.left;
                    const videoOffsetY = videoRect.top - containerRect.top;

                    // Cursor pixel position within container:
                    // = video offset + (normalized cursor pos * video dimensions)
                    const cursorPixelX = videoOffsetX + state.x * videoRect.width;
                    const cursorPixelY = videoOffsetY + state.y * videoRect.height;

                    // Convert to percentage of container for CSS positioning
                    const cursorPercentX = (cursorPixelX / containerRect.width) * 100;
                    const cursorPercentY = (cursorPixelY / containerRect.height) * 100;

                    // Update cursor DOM position directly (bypass React)
                    cursorEl.style.left = `${cursorPercentX.toFixed(2)}%`;
                    cursorEl.style.top = `${cursorPercentY.toFixed(2)}%`;
                    cursorEl.style.transform = `translate(-50%, -50%) scale(${velocityScale.toFixed(2)})`;
                    cursorEl.style.opacity = '1';
                }
            } else if (cursorEl) {
                cursorEl.style.opacity = '0';
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

                    {/* Custom Cursor Overlay - positioned via RAF for 60fps smoothness */}
                    {cursorSettings.visible && cursorPositions.length > 0 && (
                        <div
                            ref={cursorOverlayRef}
                            className="absolute pointer-events-none"
                            style={{
                                left: '50%',
                                top: '50%',
                                width: `${cursorSettings.size}px`,
                                height: `${cursorSettings.size}px`,
                                opacity: 0,
                                transition: 'opacity 0.15s ease',
                            }}
                        >
                            {/* SVG Cursor based on style */}
                            {cursorSettings.style === 'pointer' && (
                                <svg viewBox="0 0 24 24" fill={cursorSettings.color} className="w-full h-full drop-shadow-lg">
                                    <path d="M4 4l7.07 17 2.51-7.39L21 11.07z" />
                                    <path d="M4 4l7.07 17 2.51-7.39L21 11.07z" stroke="black" strokeWidth="0.5" fill="none" />
                                </svg>
                            )}
                            {cursorSettings.style === 'circle' && (
                                <svg viewBox="0 0 24 24" className="w-full h-full">
                                    <circle cx="12" cy="12" r="10" fill={cursorSettings.color} opacity="0.9" />
                                    <circle cx="12" cy="12" r="10" stroke="black" strokeWidth="0.5" fill="none" />
                                    <circle cx="12" cy="12" r="3" fill="black" opacity="0.5" />
                                </svg>
                            )}
                            {cursorSettings.style === 'crosshair' && (
                                <svg viewBox="0 0 24 24" stroke={cursorSettings.color} strokeWidth="2" className="w-full h-full drop-shadow-lg">
                                    <line x1="12" y1="2" x2="12" y2="22" strokeLinecap="round" />
                                    <line x1="2" y1="12" x2="22" y2="12" strokeLinecap="round" />
                                    <circle cx="12" cy="12" r="4" fill="none" />
                                </svg>
                            )}

                            {/* Click Ripple Effect (cursor-specific) */}
                            {cursorSettings.clickRipple && activeRipples.length > 0 && (
                                <div
                                    className="absolute inset-0 pointer-events-none"
                                    style={{
                                        borderRadius: '50%',
                                        border: `2px solid ${cursorSettings.color}`,
                                        animation: 'click-ripple 0.4s ease-out forwards',
                                    }}
                                />
                            )}
                        </div>
                    )}
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

