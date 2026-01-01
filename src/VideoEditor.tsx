import { useState, useRef, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

// Click event from recording
interface ClickEvent {
    timestamp_ms: number;
    x: number;
    y: number;
    is_double_click: boolean;
}

interface VideoEditorProps {
    videoPath: string;
    onClose: () => void;
    clickEvents?: ClickEvent[];
}

// Unified effect interface with lane support
type EffectType = 'zoom' | 'blur' | 'slowmo';

// Easing curve point for controlling zoom in/out intensity over time
interface EasingPoint {
    t: number;     // Normalized time (0-1) within the effect
    value: number; // Intensity (0-1), where 0=no effect, 1=full effect
}

// Default S-curve: fade in, hold, fade out
const DEFAULT_EASING_CURVE: EasingPoint[] = [
    { t: 0, value: 0 },      // Start: no zoom
    { t: 0.2, value: 1 },    // 20%: fully zoomed in
    { t: 0.8, value: 1 },    // 80%: still zoomed
    { t: 1, value: 0 },      // End: zoom out
];

// Interpolate easing curve to get intensity at a given progress (0-1)
const sampleEasingCurve = (curve: EasingPoint[], progress: number): number => {
    if (progress <= 0) return curve[0]?.value ?? 0;
    if (progress >= 1) return curve[curve.length - 1]?.value ?? 0;

    // Find surrounding points
    for (let i = 0; i < curve.length - 1; i++) {
        const p1 = curve[i];
        const p2 = curve[i + 1];
        if (progress >= p1.t && progress <= p2.t) {
            // Linear interpolation between points
            const localProgress = (progress - p1.t) / (p2.t - p1.t);
            // Use smooth step for nicer interpolation
            const smooth = localProgress * localProgress * (3 - 2 * localProgress);
            return p1.value + (p2.value - p1.value) * smooth;
        }
    }
    return curve[curve.length - 1]?.value ?? 0;
};

interface Effect {
    id: string;
    type: EffectType;
    startTime: number;
    endTime: number;
    lane: number; // 0-indexed lane for effect placement
    // Type-specific properties
    scale?: number;
    targetX?: number;
    targetY?: number;
    intensity?: number;
    speed?: number;
    // Easing curve for zoom effects
    easingCurve?: EasingPoint[];
}

const EFFECT_CONFIG: Record<EffectType, { label: string; color: string; defaultDuration: number }> = {
    zoom: { label: 'Zoom', color: '#10b981', defaultDuration: 2 },
    blur: { label: 'Blur', color: '#3b82f6', defaultDuration: 2 },
    slowmo: { label: 'Slow-Mo', color: '#f59e0b', defaultDuration: 3 },
};

// Check if two time ranges overlap
const rangesOverlap = (s1: number, e1: number, s2: number, e2: number): boolean => {
    return s1 < e2 && e1 > s2;
};

function VideoEditor({ videoPath, onClose, clickEvents = [] }: VideoEditorProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const timelineRef = useRef<HTMLDivElement>(null);
    const tracksContainerRef = useRef<HTMLDivElement>(null);

    // Video state
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [videoError, setVideoError] = useState("");

    // Trim state
    const [trimStart, setTrimStart] = useState(0);
    const [trimEnd, setTrimEnd] = useState(0);

    // Effects state
    const [effects, setEffects] = useState<Effect[]>([]);
    const [selectedEffectId, setSelectedEffectId] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState<string | null>(null);
    const [dragStartY, setDragStartY] = useState<number>(0);
    const [dragStartLane, setDragStartLane] = useState<number>(0);

    // Export state
    const [isExporting, setIsExporting] = useState(false);
    const [exportStatus, setExportStatus] = useState("");

    const videoUrl = convertFileSrc(videoPath);

    // Calculate the number of lanes needed
    const laneCount = effects.length > 0 ? Math.max(...effects.map(e => e.lane)) + 1 : 0;

    // Calculate timeline duration - extends beyond video if effects go further
    const maxEffectEnd = effects.length > 0 ? Math.max(...effects.map(e => e.endTime)) : 0;
    const timelineDuration = Math.max(duration, maxEffectEnd);

    // Get active effects at current playhead
    const activeEffects = effects.filter(
        e => currentTime >= e.startTime && currentTime <= e.endTime
    );

    // Find an available time slot in a given lane for an effect of given duration
    // Returns the start time where the effect can be placed without overlapping
    const findAvailableSlotInLane = (lane: number, desiredStart: number, effectDuration: number, excludeId?: string): number => {
        const laneEffects = effects
            .filter(e => e.id !== excludeId && e.lane === lane)
            .sort((a, b) => a.startTime - b.startTime);

        // If no effects in lane, place at desired position
        if (laneEffects.length === 0) return desiredStart;

        // Check if we can fit at desired position
        const desiredEnd = desiredStart + effectDuration;
        const hasOverlap = laneEffects.some(e =>
            rangesOverlap(desiredStart, desiredEnd, e.startTime, e.endTime)
        );

        if (!hasOverlap) return desiredStart;

        // Find the end of the last effect in this lane and place after it
        const lastEffect = laneEffects[laneEffects.length - 1];
        return lastEffect.endTime;
    };

    // Snap effect to avoid overlaps - returns adjusted start/end times
    const snapToAvoidOverlap = (effectId: string, newStart: number, newEnd: number, lane: number): { start: number; end: number } => {
        const effectDuration = newEnd - newStart;
        const laneEffects = effects
            .filter(e => e.id !== effectId && e.lane === lane)
            .sort((a, b) => a.startTime - b.startTime);

        if (laneEffects.length === 0) return { start: newStart, end: newEnd };

        // Check for overlap
        const overlappingEffect = laneEffects.find(e =>
            rangesOverlap(newStart, newEnd, e.startTime, e.endTime)
        );

        if (!overlappingEffect) return { start: newStart, end: newEnd };

        // Determine if we should snap before or after the overlapping effect
        const midpoint = (overlappingEffect.startTime + overlappingEffect.endTime) / 2;
        const effectMidpoint = (newStart + newEnd) / 2;

        if (effectMidpoint < midpoint) {
            // Snap before the overlapping effect
            const adjustedEnd = overlappingEffect.startTime;
            const adjustedStart = Math.max(0, adjustedEnd - effectDuration);
            return { start: adjustedStart, end: adjustedEnd };
        } else {
            // Snap after the overlapping effect
            const adjustedStart = overlappingEffect.endTime;
            const adjustedEnd = adjustedStart + effectDuration;
            return { start: adjustedStart, end: adjustedEnd };
        }
    };

    // Video event handlers
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleLoadedMetadata = () => {
            setDuration(video.duration);
            setTrimEnd(video.duration);
            setVideoLoaded(true);
            setVideoError("");
        };

        const handleTimeUpdate = () => {
            setCurrentTime(video.currentTime);
            if (video.currentTime >= trimEnd) {
                video.pause();
                setIsPlaying(false);
            }
        };

        const handleError = () => {
            console.error("Video load error:", video.error);
            setVideoError(`Failed to load video: ${video.error?.message || "Unknown error"}`);
        };

        video.addEventListener("loadedmetadata", handleLoadedMetadata);
        video.addEventListener("timeupdate", handleTimeUpdate);
        video.addEventListener("error", handleError);

        return () => {
            video.removeEventListener("loadedmetadata", handleLoadedMetadata);
            video.removeEventListener("timeupdate", handleTimeUpdate);
            video.removeEventListener("error", handleError);
        };
    }, [trimEnd]);

    // Auto-generate zoom effects from recorded double-clicks
    useEffect(() => {
        if (!videoLoaded || clickEvents.length === 0) return;

        // Only auto-generate if no effects exist yet (first load)
        if (effects.length > 0) return;

        const zoomDuration = EFFECT_CONFIG.zoom.defaultDuration;
        const generatedEffects: Effect[] = [];

        clickEvents
            .filter(click => click.is_double_click)
            .forEach((click, index) => {
                const startTime = click.timestamp_ms / 1000; // Convert ms to seconds
                const endTime = startTime + zoomDuration;

                // Find available lane (use findAvailableSlotInLane logic)
                let lane = 0;
                let adjustedStart = startTime;

                // Check for overlaps with already generated effects
                const hasOverlap = generatedEffects.some(e =>
                    rangesOverlap(startTime, endTime, e.startTime, e.endTime)
                );

                if (hasOverlap) {
                    // Place after the last effect that would overlap
                    const lastOverlapping = [...generatedEffects]
                        .filter(e => rangesOverlap(startTime, endTime, e.startTime, e.endTime))
                        .sort((a, b) => b.endTime - a.endTime)[0];
                    if (lastOverlapping) {
                        adjustedStart = lastOverlapping.endTime;
                    }
                }

                const effect: Effect = {
                    id: `zoom-auto-${index}-${Date.now()}`,
                    type: 'zoom',
                    startTime: adjustedStart,
                    endTime: adjustedStart + zoomDuration,
                    lane,
                    scale: 1.5,
                    targetX: click.x, // Use normalized click position
                    targetY: click.y,
                    easingCurve: [...DEFAULT_EASING_CURVE], // Clone default curve
                };

                generatedEffects.push(effect);
            });

        if (generatedEffects.length > 0) {
            console.log("Auto-generated zoom effects from double-clicks:", generatedEffects);
            setEffects(generatedEffects);
        }
    }, [videoLoaded, clickEvents]);

    // Playback controls
    const togglePlay = () => {
        const video = videoRef.current;
        if (!video) return;

        if (isPlaying) {
            video.pause();
        } else {
            if (video.currentTime < trimStart || video.currentTime >= trimEnd) {
                video.currentTime = trimStart;
            }
            video.play();
        }
        setIsPlaying(!isPlaying);
    };

    // Timeline click to seek
    const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!timelineRef.current || !videoRef.current || duration === 0) return;
        if ((e.target as HTMLElement).closest('.effect-segment, .trim-handle, .effect-handle')) return;

        const rect = timelineRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = x / rect.width;
        const newTime = percentage * duration;

        videoRef.current.currentTime = Math.max(0, Math.min(duration, newTime));
        setCurrentTime(newTime);
    }, [duration]);

    // Time formatting
    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    const formatTimeDetailed = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 10);
        return `${mins}:${secs.toString().padStart(2, "0")}.${ms}`;
    };

    // Generate time markers
    const generateTimeMarkers = () => {
        if (timelineDuration === 0) return [];
        const interval = timelineDuration < 30 ? 5 : timelineDuration < 60 ? 10 : 30;
        const markers = [];
        for (let t = 0; t <= timelineDuration; t += interval) {
            markers.push(t);
        }
        return markers;
    };

    // Trim handlers
    const handleTrimStartDrag = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsDragging('trim-start');
    };

    const handleTrimEndDrag = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsDragging('trim-end');
    };

    // Effect functions
    const addEffect = (type: EffectType) => {
        const config = EFFECT_CONFIG[type];
        const effectDuration = config.defaultDuration;

        // Always try to place in lane 0, find available slot beside existing effects
        const startTime = findAvailableSlotInLane(0, currentTime, effectDuration);
        const endTime = startTime + effectDuration;

        const newEffect: Effect = {
            id: `${type}-${Date.now()}`,
            type,
            startTime,
            endTime,
            lane: 0, // Always add to first effect lane
        };

        // Add type-specific defaults
        if (type === 'zoom') {
            newEffect.scale = 1.5;
            newEffect.targetX = 0.5;
            newEffect.targetY = 0.5;
            newEffect.easingCurve = [...DEFAULT_EASING_CURVE]; // Clone default curve
        } else if (type === 'blur') {
            newEffect.intensity = 5;
        } else if (type === 'slowmo') {
            newEffect.speed = 0.5;
        }

        setEffects([...effects, newEffect]);
        setSelectedEffectId(newEffect.id);
    };

    const removeEffect = (id: string) => {
        setEffects(effects.filter(e => e.id !== id));
        if (selectedEffectId === id) {
            setSelectedEffectId(null);
        }
    };

    const updateEffect = (id: string, updates: Partial<Effect>) => {
        setEffects(effects.map(e =>
            e.id === id ? { ...e, ...updates } : e
        ));
    };

    // Mouse move handler for dragging
    useEffect(() => {
        if (!isDragging) return;

        const handleMouseMove = (e: MouseEvent) => {
            if (!timelineRef.current || duration === 0) return;

            const rect = timelineRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const percentage = Math.max(0, Math.min(1, x / rect.width));
            const newTime = percentage * duration;

            if (isDragging === 'trim-start') {
                if (newTime < trimEnd - 0.5) {
                    setTrimStart(newTime);
                }
            } else if (isDragging === 'trim-end') {
                if (newTime > trimStart + 0.5) {
                    setTrimEnd(newTime);
                }
            } else if (isDragging.endsWith('-move')) {
                // Moving entire effect (vertical lane change)
                const effectId = isDragging.replace('-move', '');
                const effect = effects.find(e => e.id === effectId);
                if (effect && tracksContainerRef.current) {
                    const deltaY = e.clientY - dragStartY;
                    const laneHeight = 36; // Height of each lane
                    const laneDelta = Math.round(deltaY / laneHeight);
                    const newLane = Math.max(0, dragStartLane + laneDelta);

                    if (newLane !== effect.lane) {
                        updateEffect(effectId, { lane: newLane });
                    }
                }
            } else if (isDragging.includes('-start') || isDragging.includes('-end')) {
                // Effect edge dragging
                const parts = isDragging.split('-');
                const edge = parts.pop();
                const effectId = parts.join('-');

                const effect = effects.find(e => e.id === effectId);
                if (effect) {
                    if (edge === 'start') {
                        if (newTime < effect.endTime - 0.5) {
                            updateEffect(effectId, { startTime: newTime });
                        }
                    } else if (edge === 'end') {
                        if (newTime > effect.startTime + 0.5) {
                            updateEffect(effectId, { endTime: newTime });
                        }
                    }
                }
            }
        };

        const handleMouseUp = () => {
            // On lane change, snap to avoid overlaps
            if (isDragging?.endsWith('-move')) {
                const effectId = isDragging.replace('-move', '');
                const effect = effects.find(e => e.id === effectId);
                if (effect) {
                    const snapped = snapToAvoidOverlap(
                        effect.id,
                        effect.startTime,
                        effect.endTime,
                        effect.lane
                    );
                    updateEffect(effect.id, { startTime: snapped.start, endTime: snapped.end });
                }
                // Compact lanes after adjustments
                setTimeout(compactLanes, 0);
            }
            setIsDragging(null);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, duration, trimStart, trimEnd, effects, dragStartY, dragStartLane]);

    // Compact lanes to remove gaps
    const compactLanes = () => {
        const usedLanes = [...new Set(effects.map(e => e.lane))].sort((a, b) => a - b);
        const laneMap = new Map<number, number>();
        usedLanes.forEach((lane, index) => laneMap.set(lane, index));

        setEffects(effects.map(e => ({
            ...e,
            lane: laneMap.get(e.lane) ?? e.lane
        })));
    };

    // Start moving effect (for lane change)
    const handleEffectMoveStart = (e: React.MouseEvent, effect: Effect) => {
        e.stopPropagation();
        setIsDragging(`${effect.id}-move`);
        setDragStartY(e.clientY);
        setDragStartLane(effect.lane);
        setSelectedEffectId(effect.id);
    };

    // Export handlers
    const handleExport = async () => {
        setIsExporting(true);
        setExportStatus("Exporting...");

        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const finalName = `recording_${timestamp}_edited.mp4`;

            const videosDir = await invoke<string>("move_video_to_videos", {
                tempPath: videoPath,
                finalName: `temp_${finalName}`
            });

            const inputPath = videosDir;
            const outputPath = inputPath.replace(`temp_${finalName}`, finalName);

            await invoke("trim_video", {
                inputPath,
                outputPath,
                startTime: trimStart,
                endTime: trimEnd,
            });

            try {
                await invoke("delete_temp_video", { tempPath: inputPath });
            } catch (e) {
                console.warn("Failed to cleanup temp file:", e);
            }

            setExportStatus("Saved!");
            setTimeout(() => onClose(), 1500);
        } catch (error) {
            console.error("Export failed:", error);
            setExportStatus("Export failed");
            setIsExporting(false);
        }
    };

    const handleSaveOriginal = async () => {
        setIsExporting(true);
        setExportStatus("Saving...");

        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const finalName = `recording_${timestamp}.mp4`;

            await invoke("move_video_to_videos", {
                tempPath: videoPath,
                finalName
            });

            setExportStatus("Saved!");
            setTimeout(() => onClose(), 1000);
        } catch (error) {
            console.error("Save failed:", error);
            setExportStatus("Save failed");
            setIsExporting(false);
        }
    };

    // Calculate zoom transform for preview with easing
    const getVideoTransform = () => {
        const zoomEffect = activeEffects.find(e => e.type === 'zoom');
        if (!zoomEffect || !zoomEffect.scale) return {};

        // Calculate progress within the zoom effect (0-1)
        const effectDuration = zoomEffect.endTime - zoomEffect.startTime;
        const progress = effectDuration > 0
            ? (currentTime - zoomEffect.startTime) / effectDuration
            : 0;

        // Get easing curve (use default if not set)
        const curve = zoomEffect.easingCurve || DEFAULT_EASING_CURVE;
        const easedIntensity = sampleEasingCurve(curve, progress);

        // Interpolate scale: 1 (no zoom) -> target scale based on easing
        const targetScale = zoomEffect.scale;
        const currentScale = 1 + (targetScale - 1) * easedIntensity;

        // Only apply transform if there's actual zoom
        if (currentScale <= 1.001) return {};

        const translateX = (0.5 - (zoomEffect.targetX || 0.5)) * (currentScale - 1) * 100;
        const translateY = (0.5 - (zoomEffect.targetY || 0.5)) * (currentScale - 1) * 100;
        return {
            transform: `scale(${currentScale.toFixed(3)}) translate(${translateX.toFixed(2)}%, ${translateY.toFixed(2)}%)`,
        };
    };

    // Get video filter for blur effect
    const getVideoFilter = () => {
        const blurEffect = activeEffects.find(e => e.type === 'blur');
        if (!blurEffect || !blurEffect.intensity) return {};
        return {
            filter: `blur(${blurEffect.intensity}px)`
        };
    };

    const selectedEffect = effects.find(e => e.id === selectedEffectId);

    // Group effects by lane
    const effectsByLane: Effect[][] = [];
    for (let i = 0; i < laneCount; i++) {
        effectsByLane.push(effects.filter(e => e.lane === i));
    }

    return (
        <div className="flex h-screen w-screen bg-gray-50 overflow-hidden">
            {/* Left Main Panel - Video, Toolbar, Timeline */}
            <div className="flex-1 flex flex-col p-4 min-w-0">
                {/* Header Bar */}
                <div className="flex items-center gap-3 mb-3 shrink-0">
                    <button
                        className="w-8 h-8 border-none bg-gray-200 rounded-lg cursor-pointer flex items-center justify-center text-gray-600 transition-all duration-200 hover:bg-gray-300 hover:text-gray-900"
                        onClick={onClose}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                            <polyline points="15,18 9,12 15,6" />
                        </svg>
                    </button>
                    <span className="text-base font-semibold text-gray-900">Edit Recording</span>
                    <div className="flex-1" />
                </div>

                {/* Video Preview */}
                <div className="relative flex-1 min-h-0 bg-gray-900 rounded-xl overflow-hidden flex flex-col">
                    {videoError && (
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-red-500 text-sm z-10">
                            <span>{videoError}</span>
                        </div>
                    )}
                    {!videoLoaded && !videoError && (
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-400 text-sm z-10">Loading video...</div>
                    )}
                    <div className="flex-1 flex items-center justify-center origin-center" style={{ ...getVideoTransform(), ...getVideoFilter() }}>
                        <video
                            ref={videoRef}
                            src={videoUrl}
                            className="max-w-full max-h-full object-contain"
                            onClick={togglePlay}
                            style={{ display: videoError ? 'none' : 'block' }}
                        />
                    </div>
                    <div className="absolute top-0 left-0 right-0 bottom-12 flex items-center justify-center cursor-pointer" onClick={togglePlay}>
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
                            onClick={togglePlay}
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

                {/* Toolbar */}
                <div className="flex items-center gap-2 py-3 shrink-0">
                    <button
                        className="w-10 h-10 border border-gray-300 bg-white rounded-lg cursor-pointer flex items-center justify-center text-gray-600 transition-all duration-200 hover:bg-gray-100 hover:border-gray-400 hover:text-gray-900"
                        onClick={() => addEffect('zoom')}
                        title="Add Zoom Effect"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            <line x1="11" y1="8" x2="11" y2="14" />
                            <line x1="8" y1="11" x2="14" y2="11" />
                        </svg>
                    </button>
                    <button
                        className="w-10 h-10 border border-gray-300 bg-white rounded-lg cursor-pointer flex items-center justify-center text-gray-600 transition-all duration-200 hover:bg-gray-100 hover:border-gray-400 hover:text-gray-900"
                        onClick={() => addEffect('blur')}
                        title="Add Blur Effect"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                            <circle cx="12" cy="12" r="10" />
                            <circle cx="12" cy="12" r="6" />
                            <circle cx="12" cy="12" r="2" />
                        </svg>
                    </button>
                    <button
                        className="w-10 h-10 border border-gray-300 bg-white rounded-lg cursor-pointer flex items-center justify-center text-gray-600 transition-all duration-200 hover:bg-gray-100 hover:border-gray-400 hover:text-gray-900"
                        onClick={() => addEffect('slowmo')}
                        title="Add Slow-Mo Effect"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12,6 12,12 16,14" />
                        </svg>
                    </button>
                    <div className="w-px h-6 bg-gray-300 mx-1" />
                    {selectedEffectId && (
                        <button
                            className="w-10 h-10 border border-red-200 bg-white rounded-lg cursor-pointer flex items-center justify-center text-red-600 transition-all duration-200 hover:bg-red-50 hover:border-red-600"
                            onClick={() => removeEffect(selectedEffectId)}
                            title="Delete Selected Effect"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                                <polyline points="3,6 5,6 21,6" />
                                <path d="M19,6V20a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6M8,6V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6" />
                            </svg>
                        </button>
                    )}
                </div>

                {/* Timeline */}
                <div className="bg-white rounded-xl px-4 py-3 shrink-0 border border-gray-200">
                    {/* Time Markers */}
                    <div className="relative h-5 mb-2">
                        {generateTimeMarkers().map(time => (
                            <div
                                key={time}
                                className="absolute -translate-x-1/2 text-[10px] text-gray-500 font-mono after:content-[''] after:absolute after:left-1/2 after:top-3.5 after:w-px after:h-1.5 after:bg-gray-300"
                                style={{ left: `${(time / timelineDuration) * 100}%` }}
                            >
                                <span>{formatTime(time)}</span>
                            </div>
                        ))}
                    </div>

                    {/* Timeline Tracks */}
                    <div className="max-h-28 overflow-y-auto scrollbar-thin" ref={tracksContainerRef}>
                        <div
                            className="relative flex flex-col gap-1.5 min-h-10 cursor-pointer"
                            ref={timelineRef}
                            onClick={handleTimelineClick}
                        >
                            {/* Video/Trim Track */}
                            <div className="h-9 bg-gray-100 rounded-md relative">
                                <div
                                    className="absolute top-1 bottom-1 bg-gradient-to-br from-indigo-400 to-indigo-500 rounded flex items-center justify-center min-w-10"
                                    style={{
                                        left: `${(trimStart / timelineDuration) * 100}%`,
                                        width: `${((trimEnd - trimStart) / timelineDuration) * 100}%`
                                    }}
                                >
                                    <div
                                        className="trim-handle absolute top-0 bottom-0 left-0 w-2 bg-black/20 cursor-ew-resize transition-colors duration-200 hover:bg-black/40 rounded-l"
                                        onMouseDown={handleTrimStartDrag}
                                    />
                                    <span className="text-[10px] text-white font-medium opacity-90">✂ Trim</span>
                                    <div
                                        className="trim-handle absolute top-0 bottom-0 right-0 w-2 bg-black/20 cursor-ew-resize transition-colors duration-200 hover:bg-black/40 rounded-r"
                                        onMouseDown={handleTrimEndDrag}
                                    />
                                </div>
                            </div>

                            {/* Effect Lanes */}
                            {effectsByLane.map((laneEffects, laneIndex) => (
                                <div key={laneIndex} className="h-9 bg-gray-50 rounded-md relative">
                                    {laneEffects.map(effect => {
                                        const config = EFFECT_CONFIG[effect.type];
                                        const isSelected = selectedEffectId === effect.id;
                                        return (
                                            <div
                                                key={effect.id}
                                                className={`effect-segment absolute top-1 bottom-1 rounded flex items-center justify-center cursor-grab min-w-8 z-[2] select-none transition-shadow duration-200 hover:shadow-md active:cursor-grabbing ${isSelected ? 'shadow-[0_0_0_2px_white,0_0_0_4px_currentColor] z-[3]' : ''}`}
                                                style={{
                                                    left: `${(effect.startTime / timelineDuration) * 100}%`,
                                                    width: `${((effect.endTime - effect.startTime) / timelineDuration) * 100}%`,
                                                    backgroundColor: config.color,
                                                }}
                                                onMouseDown={(e) => handleEffectMoveStart(e, effect)}
                                            >
                                                <div
                                                    className="effect-handle absolute top-0 bottom-0 left-0 w-1.5 cursor-ew-resize z-[3] transition-colors duration-200 hover:bg-white/30 rounded-l"
                                                    onMouseDown={(e) => {
                                                        e.stopPropagation();
                                                        setIsDragging(`${effect.id}-start`);
                                                    }}
                                                />
                                                <span className="text-[10px] font-semibold text-white pointer-events-none drop-shadow-sm">{config.label}</span>
                                                <div
                                                    className="effect-handle absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize z-[3] transition-colors duration-200 hover:bg-white/30 rounded-r"
                                                    onMouseDown={(e) => {
                                                        e.stopPropagation();
                                                        setIsDragging(`${effect.id}-end`);
                                                    }}
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}

                            {/* Playhead */}
                            <div
                                className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none before:content-[''] before:absolute before:-top-1 before:left-1/2 before:-translate-x-1/2 before:border-l-[6px] before:border-r-[6px] before:border-t-[6px] before:border-l-transparent before:border-r-transparent before:border-t-red-500"
                                style={{ left: `${(currentTime / timelineDuration) * 100}%` }}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Right Sidebar: Settings */}
            <div className="w-72 bg-white border-l border-gray-200 p-5 flex flex-col gap-4 overflow-y-auto shrink-0">
                {/* Export Button */}
                <button
                    className="flex items-center justify-center gap-2 px-6 py-3.5 bg-gradient-to-br from-green-500 to-green-600 border-none rounded-xl text-white text-sm font-semibold cursor-pointer transition-all duration-200 shadow-lg shadow-green-500/30 hover:translate-y-[-1px] hover:shadow-xl hover:shadow-green-500/40 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                    onClick={handleExport}
                    disabled={isExporting}
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                        <path d="M21,15V19a2,2,0,0,1-2,2H5a2,2,0,0,1-2-2V15" />
                        <polyline points="17,8 12,3 7,8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    {isExporting ? exportStatus : "Export video"}
                </button>

                {/* Quick Save */}
                <button
                    className="px-4 py-2.5 bg-transparent border border-gray-300 rounded-lg text-gray-600 text-sm font-medium cursor-pointer transition-all duration-200 hover:bg-gray-50 hover:border-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleSaveOriginal}
                    disabled={isExporting}
                >
                    Keep Original
                </button>

                <div className="h-px bg-gray-200" />

                {/* Effect Settings */}
                {selectedEffect ? (
                    <div className="flex flex-col gap-3">
                        <h3 className="text-sm font-semibold m-0" style={{ color: EFFECT_CONFIG[selectedEffect.type].color }}>
                            {EFFECT_CONFIG[selectedEffect.type].label} Settings
                        </h3>

                        {selectedEffect.type === 'zoom' && (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-xs text-gray-600 font-medium">Scale</label>
                                    <div className="flex items-center gap-2.5">
                                        <input
                                            type="range"
                                            min="1"
                                            max="3"
                                            step="0.1"
                                            value={selectedEffect.scale || 1.5}
                                            onChange={(e) => updateEffect(selectedEffect.id, {
                                                scale: parseFloat(e.target.value)
                                            })}
                                            className="range-slider"
                                        />
                                        <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{(selectedEffect.scale || 1.5).toFixed(1)}x</span>
                                    </div>
                                </div>

                                {/* Easing Curve Editor */}
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-xs text-gray-600 font-medium">Zoom Timing</label>
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <svg
                                        className="w-full h-14 bg-gray-900 rounded-md border border-gray-700"
                                        viewBox="0 0 100 50"
                                        preserveAspectRatio="none"
                                    >
                                        <line x1="0" y1="25" x2="100" y2="25" stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />
                                        <line x1="20" y1="0" x2="20" y2="50" stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />
                                        <line x1="80" y1="0" x2="80" y2="50" stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />

                                        <path
                                            d={`M ${(selectedEffect.easingCurve || DEFAULT_EASING_CURVE)
                                                .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.t * 100} ${50 - p.value * 50}`)
                                                .join(' ')}`}
                                            fill="none"
                                            stroke="#10b981"
                                            strokeWidth="2"
                                        />

                                        {(selectedEffect.easingCurve || DEFAULT_EASING_CURVE).map((point, index) => (
                                            <circle
                                                key={index}
                                                cx={point.t * 100}
                                                cy={50 - point.value * 50}
                                                r="4"
                                                fill={index === 0 || index === (selectedEffect.easingCurve || DEFAULT_EASING_CURVE).length - 1 ? "#666" : "#10b981"}
                                                stroke="#fff"
                                                strokeWidth="1"
                                                className={`transition-colors duration-100 ${index !== 0 && index !== (selectedEffect.easingCurve || DEFAULT_EASING_CURVE).length - 1 ? 'hover:fill-green-400 cursor-ns-resize' : 'cursor-default'}`}
                                                onMouseDown={(e) => {
                                                    if (index === 0 || index === (selectedEffect.easingCurve || DEFAULT_EASING_CURVE).length - 1) return;
                                                    e.stopPropagation();
                                                    const svg = e.currentTarget.closest('svg');
                                                    if (!svg) return;

                                                    const handleDrag = (moveEvent: MouseEvent) => {
                                                        const rect = svg.getBoundingClientRect();
                                                        const y = (moveEvent.clientY - rect.top) / rect.height;
                                                        const newValue = Math.max(0, Math.min(1, 1 - y));

                                                        const newCurve = [...(selectedEffect.easingCurve || DEFAULT_EASING_CURVE)];
                                                        newCurve[index] = { ...newCurve[index], value: newValue };
                                                        updateEffect(selectedEffect.id, { easingCurve: newCurve });
                                                    };

                                                    const handleUp = () => {
                                                        window.removeEventListener('mousemove', handleDrag);
                                                        window.removeEventListener('mouseup', handleUp);
                                                    };

                                                    window.addEventListener('mousemove', handleDrag);
                                                    window.addEventListener('mouseup', handleUp);
                                                }}
                                            />
                                        ))}
                                    </svg>
                                    <div className="flex justify-between text-[10px] text-gray-500">
                                        <span>Start</span>
                                        <span>End</span>
                                    </div>
                                    <button
                                        className="px-2.5 py-1.5 bg-transparent text-gray-600 border border-gray-300 rounded-md text-[11px] cursor-pointer transition-all duration-200 self-start hover:bg-gray-50 hover:border-green-500 hover:text-green-600"
                                        onClick={() => updateEffect(selectedEffect.id, {
                                            easingCurve: [...DEFAULT_EASING_CURVE]
                                        })}
                                    >
                                        Reset Curve
                                    </button>
                                </div>
                            </>
                        )}

                        {selectedEffect.type === 'blur' && (
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs text-gray-600 font-medium">Intensity</label>
                                <div className="flex items-center gap-2.5">
                                    <input
                                        type="range"
                                        min="1"
                                        max="20"
                                        step="1"
                                        value={selectedEffect.intensity || 5}
                                        onChange={(e) => updateEffect(selectedEffect.id, {
                                            intensity: parseInt(e.target.value)
                                        })}
                                        className="range-slider"
                                    />
                                    <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{selectedEffect.intensity || 5}px</span>
                                </div>
                            </div>
                        )}

                        {selectedEffect.type === 'slowmo' && (
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs text-gray-600 font-medium">Speed</label>
                                <div className="flex items-center gap-2.5">
                                    <input
                                        type="range"
                                        min="0.1"
                                        max="1"
                                        step="0.1"
                                        value={selectedEffect.speed || 0.5}
                                        onChange={(e) => updateEffect(selectedEffect.id, {
                                            speed: parseFloat(e.target.value)
                                        })}
                                        className="range-slider"
                                    />
                                    <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{((selectedEffect.speed || 0.5) * 100).toFixed(0)}%</span>
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col gap-3 text-gray-500 text-sm text-center py-5">
                        <span>Select an effect to edit</span>
                    </div>
                )}

                <div className="h-px bg-gray-200" />

                {/* Trim Info */}
                <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold m-0">Trim</h3>
                    <div className="flex flex-col gap-1 text-xs text-gray-600">
                        <span>{formatTimeDetailed(trimStart)} - {formatTimeDetailed(trimEnd)}</span>
                        <span className="font-semibold text-indigo-500">{formatTimeDetailed(trimEnd - trimStart)}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default VideoEditor;
