import { RefObject, useRef, useState, useEffect, useCallback } from 'react';
import { Effect, CursorPosition, ClickEvent, CanvasSettings, CursorSettings } from './types';
import {
    renderFrame,
    createViewportState,
    createCursorState,
    ViewportState,
    CursorState,
    RenderContext,
} from './canvasRenderer';

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
    // Canvas reference for unified rendering
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderContextRef = useRef<RenderContext | null>(null);

    // Persistent state for smooth transitions between frames
    const viewportStateRef = useRef<ViewportState>(createViewportState());
    const cursorStateRef = useRef<CursorState>(createCursorState());

    // Animation loop ref
    const rafIdRef = useRef<number | null>(null);

    // Active ripples for click animation
    const [activeRipples, setActiveRipples] = useState<RippleState[]>([]);
    const lastProcessedClickRef = useRef<number>(-1);

    // Store props in refs to avoid closure stale values in RAF loop
    const activeEffectsRef = useRef(activeEffects);
    const cursorPositionsRef = useRef(cursorPositions);
    const cursorSettingsRef = useRef(cursorSettings);
    const canvasSettingsRef = useRef(canvasSettings);

    // Update refs when props change
    useEffect(() => {
        activeEffectsRef.current = activeEffects;
        cursorPositionsRef.current = cursorPositions;
        cursorSettingsRef.current = cursorSettings;
        canvasSettingsRef.current = canvasSettings;
    }, [activeEffects, cursorPositions, cursorSettings, canvasSettings]);

    // Initialize canvas when video loads or canvas size changes
    const initCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        if (!canvas || !video || !videoLoaded) return;

        // Set canvas size to match video aspect ratio within container
        const container = canvas.parentElement;
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const aspectRatio = video.videoWidth / video.videoHeight;

        let canvasWidth: number, canvasHeight: number;
        if (containerRect.width / containerRect.height > aspectRatio) {
            // Container is wider than video
            canvasHeight = containerRect.height;
            canvasWidth = canvasHeight * aspectRatio;
        } else {
            // Container is taller than video
            canvasWidth = containerRect.width;
            canvasHeight = canvasWidth / aspectRatio;
        }

        // Use device pixel ratio for crisp rendering
        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvasWidth * dpr;
        canvas.height = canvasHeight * dpr;
        canvas.style.width = `${canvasWidth}px`;
        canvas.style.height = `${canvasHeight}px`;

        // Create render context
        try {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.scale(dpr, dpr);
                renderContextRef.current = {
                    canvas,
                    ctx,
                    width: canvasWidth,
                    height: canvasHeight,
                };
            }
        } catch (e) {
            console.error('Failed to create canvas context:', e);
        }
    }, [videoRef, videoLoaded]);

    // Initialize canvas when video loads
    useEffect(() => {
        initCanvas();
    }, [initCanvas, videoLoaded]);

    // Handle window resize
    useEffect(() => {
        const handleResize = () => initCanvas();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [initCanvas]);

    // Process click events to show ripples during playback
    useEffect(() => {
        if (!canvasSettings.clickRippleEnabled || !isPlaying) return;

        const currentTimeMs = currentTime * 1000;
        const RIPPLE_DURATION_MS = 400;
        const CLICK_TOLERANCE_MS = 50;

        clickEvents.forEach((click, index) => {
            if (index <= lastProcessedClickRef.current) return;

            const timeDiff = currentTimeMs - click.timestamp_ms;
            if (timeDiff >= 0 && timeDiff < CLICK_TOLERANCE_MS) {
                const ripple: RippleState = {
                    id: `ripple-${click.timestamp_ms}-${index}`,
                    x: click.x,
                    y: click.y,
                    startTime: Date.now(),
                };
                setActiveRipples(prev => [...prev, ripple]);
                lastProcessedClickRef.current = index;

                setTimeout(() => {
                    setActiveRipples(prev => prev.filter(r => r.id !== ripple.id));
                }, RIPPLE_DURATION_MS);
            }
        });
    }, [currentTime, clickEvents, isPlaying, canvasSettings.clickRippleEnabled]);

    // Reset click processing when seeking or stopping
    useEffect(() => {
        if (!isPlaying) {
            lastProcessedClickRef.current = -1;
            setActiveRipples([]);
        }
    }, [isPlaying]);

    // =========================================================================
    // MAIN ANIMATION LOOP - Uses unified canvas renderer
    // =========================================================================
    useEffect(() => {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        if (!canvas || !video) return;

        const animate = () => {
            const renderCtx = renderContextRef.current;
            if (!renderCtx || !video.videoWidth) {
                rafIdRef.current = requestAnimationFrame(animate);
                return;
            }

            const effects = activeEffectsRef.current;
            const positions = cursorPositionsRef.current;
            const cursorSettings = cursorSettingsRef.current;
            const canvasSettings = canvasSettingsRef.current;

            // Read time directly from video element (not React state)
            const time = video.currentTime;

            // Render frame using unified renderer
            // This is the SAME code path used for export!
            renderFrame(video, time, renderCtx, {
                effects,
                cursorPositions: positions,
                cursorSettings,
                canvasSettings,
                viewportState: viewportStateRef.current,
                cursorState: cursorStateRef.current,
            });

            // Draw click ripples on top (preview-only feature)
            if (canvasSettings.clickRippleEnabled && activeRipples.length > 0) {
                const ctx = renderCtx.ctx;
                const now = Date.now();

                activeRipples.forEach(ripple => {
                    const elapsed = now - ripple.startTime;
                    const progress = Math.min(elapsed / 400, 1);
                    const radius = 20 + 30 * progress;
                    const opacity = 1 - progress;

                    ctx.save();
                    ctx.strokeStyle = `rgba(255, 255, 255, ${opacity * 0.8})`;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(
                        ripple.x * renderCtx.width,
                        ripple.y * renderCtx.height,
                        radius,
                        0,
                        Math.PI * 2
                    );
                    ctx.stroke();
                    ctx.restore();
                });
            }

            rafIdRef.current = requestAnimationFrame(animate);
        };

        rafIdRef.current = requestAnimationFrame(animate);

        return () => {
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
            }
        };
    }, [videoRef, activeRipples]);

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

            {/* Canvas container - renders video with all effects */}
            <div
                className="flex-1 flex items-center justify-center overflow-hidden"
                style={{ backgroundColor: canvasSettings.backgroundColor }}
            >
                {/* Hidden video element - source for canvas rendering */}
                <video
                    ref={videoRef}
                    src={videoUrl}
                    className="hidden"
                    crossOrigin="anonymous"
                />

                {/* Canvas for unified rendering */}
                <canvas
                    ref={canvasRef}
                    className="max-w-full max-h-full"
                    onClick={onTogglePlay}
                    style={{
                        cursor: 'pointer',
                        borderRadius: `${canvasSettings.borderRadius}px`,
                    }}
                />
            </div>

            {/* Play button overlay */}
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
