import { useState, useRef, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "./VideoEditor.css";

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
        <div className="editor-container">
            <div className="editor-panel">
                {/* Header */}
                <div className="editor-header">
                    <h2>Edit Recording</h2>
                    <button className="close-btn" onClick={onClose}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* Video Preview */}
                <div className="video-container">
                    {videoError && (
                        <div className="video-error">
                            <span>{videoError}</span>
                        </div>
                    )}
                    {!videoLoaded && !videoError && (
                        <div className="video-loading">Loading video...</div>
                    )}
                    <div className="video-wrapper" style={{ ...getVideoTransform(), ...getVideoFilter() }}>
                        <video
                            ref={videoRef}
                            src={videoUrl}
                            className="video-player"
                            onClick={togglePlay}
                            style={{ display: videoError ? 'none' : 'block' }}
                        />
                    </div>
                    <div className="video-overlay" onClick={togglePlay}>
                        {!isPlaying && videoLoaded && (
                            <div className="play-button-overlay">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <polygon points="5,3 19,12 5,21" />
                                </svg>
                            </div>
                        )}
                    </div>
                </div>

                {/* Time Display */}
                <div className="time-display">
                    <span className="current-time">{formatTimeDetailed(currentTime)}</span>
                    <span className="time-separator">/</span>
                    <span className="total-time">{formatTimeDetailed(duration)}</span>
                </div>

                {/* Effect Buttons Toolbar */}
                <div className="effects-toolbar">
                    <span className="toolbar-label">Add Effect:</span>
                    <button
                        className="effect-btn effect-btn-zoom"
                        onClick={() => addEffect('zoom')}
                        title="Add Zoom Effect"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            <line x1="11" y1="8" x2="11" y2="14" />
                            <line x1="8" y1="11" x2="14" y2="11" />
                        </svg>
                        Zoom
                    </button>
                    <button
                        className="effect-btn effect-btn-blur"
                        onClick={() => addEffect('blur')}
                        title="Add Blur Effect"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <circle cx="12" cy="12" r="6" />
                            <circle cx="12" cy="12" r="2" />
                        </svg>
                        Blur
                    </button>
                    <button
                        className="effect-btn effect-btn-slowmo"
                        onClick={() => addEffect('slowmo')}
                        title="Add Slow-Mo Effect"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12,6 12,12 16,14" />
                        </svg>
                        Slow-Mo
                    </button>
                </div>

                {/* Multi-Lane Timeline */}
                <div className="timeline-wrapper">
                    {/* Time Markers */}
                    <div className="time-markers">
                        {generateTimeMarkers().map(time => (
                            <div
                                key={time}
                                className="time-marker"
                                style={{ left: `${(time / timelineDuration) * 100}%` }}
                            >
                                <span>{formatTime(time)}</span>
                            </div>
                        ))}
                    </div>

                    {/* Scrollable Timeline Tracks */}
                    <div className="timeline-scroll-container" ref={tracksContainerRef}>
                        <div
                            className="timeline-tracks"
                            ref={timelineRef}
                            onClick={handleTimelineClick}
                        >
                            {/* Video Track - Always first */}
                            <div className="track video-track">
                                <div className="track-label">Video</div>
                                <div className="track-content">
                                    <div
                                        className="trim-region"
                                        style={{
                                            left: `${(trimStart / timelineDuration) * 100}%`,
                                            width: `${((trimEnd - trimStart) / timelineDuration) * 100}%`
                                        }}
                                    >
                                        <div
                                            className="trim-handle trim-handle-left"
                                            onMouseDown={handleTrimStartDrag}
                                        >
                                            <div className="handle-grip"></div>
                                        </div>
                                        <div
                                            className="trim-handle trim-handle-right"
                                            onMouseDown={handleTrimEndDrag}
                                        >
                                            <div className="handle-grip"></div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Effect Lanes - Dynamic */}
                            {effectsByLane.map((laneEffects, laneIndex) => (
                                <div key={laneIndex} className="track effect-lane">
                                    <div className="track-label">
                                        {laneIndex === 0 ? 'Effects' : ''}
                                    </div>
                                    <div className="track-content">
                                        {laneEffects.map(effect => {
                                            const config = EFFECT_CONFIG[effect.type];
                                            const isSelected = selectedEffectId === effect.id;
                                            return (
                                                <div
                                                    key={effect.id}
                                                    className={`effect-segment effect-${effect.type} ${isSelected ? 'selected' : ''}`}
                                                    style={{
                                                        left: `${(effect.startTime / timelineDuration) * 100}%`,
                                                        width: `${((effect.endTime - effect.startTime) / timelineDuration) * 100}%`,
                                                        backgroundColor: config.color,
                                                    }}
                                                    onMouseDown={(e) => handleEffectMoveStart(e, effect)}
                                                >
                                                    {/* Left handle */}
                                                    <div
                                                        className="effect-handle effect-handle-left"
                                                        onMouseDown={(e) => {
                                                            e.stopPropagation();
                                                            setIsDragging(`${effect.id}-start`);
                                                        }}
                                                    />

                                                    {/* Label */}
                                                    <span className="effect-label">{config.label}</span>

                                                    {/* Delete button */}
                                                    {isSelected && (
                                                        <button
                                                            className="effect-delete-btn"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                removeEffect(effect.id);
                                                            }}
                                                            title="Delete effect"
                                                        >
                                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                <line x1="18" y1="6" x2="6" y2="18" />
                                                                <line x1="6" y1="6" x2="18" y2="18" />
                                                            </svg>
                                                        </button>
                                                    )}

                                                    {/* Right handle */}
                                                    <div
                                                        className="effect-handle effect-handle-right"
                                                        onMouseDown={(e) => {
                                                            e.stopPropagation();
                                                            setIsDragging(`${effect.id}-end`);
                                                        }}
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}

                            {/* Playhead */}
                            <div
                                className="playhead"
                                style={{ left: `${(currentTime / timelineDuration) * 100}%` }}
                            />
                        </div>
                    </div>
                </div>

                {/* Selected Effect Settings */}
                {selectedEffect && (
                    <div className="effect-settings" style={{ borderColor: EFFECT_CONFIG[selectedEffect.type].color }}>
                        <span className="effect-settings-label" style={{ color: EFFECT_CONFIG[selectedEffect.type].color }}>
                            {EFFECT_CONFIG[selectedEffect.type].label} Settings
                        </span>

                        {selectedEffect.type === 'zoom' && (
                            <>
                                <label>
                                    Scale: {(selectedEffect.scale || 1.5).toFixed(1)}x
                                    <input
                                        type="range"
                                        min="1"
                                        max="3"
                                        step="0.1"
                                        value={selectedEffect.scale || 1.5}
                                        onChange={(e) => updateEffect(selectedEffect.id, {
                                            scale: parseFloat(e.target.value)
                                        })}
                                    />
                                </label>

                                {/* Easing Curve Editor */}
                                <div className="easing-curve-editor">
                                    <span className="easing-label">Zoom Timing</span>
                                    <svg
                                        className="easing-curve-graph"
                                        viewBox="0 0 100 50"
                                        preserveAspectRatio="none"
                                    >
                                        {/* Grid lines */}
                                        <line x1="0" y1="25" x2="100" y2="25" stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />
                                        <line x1="20" y1="0" x2="20" y2="50" stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />
                                        <line x1="80" y1="0" x2="80" y2="50" stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />

                                        {/* Curve path */}
                                        <path
                                            d={`M ${(selectedEffect.easingCurve || DEFAULT_EASING_CURVE)
                                                .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.t * 100} ${50 - p.value * 50}`)
                                                .join(' ')}`}
                                            fill="none"
                                            stroke="#10b981"
                                            strokeWidth="2"
                                        />

                                        {/* Control points */}
                                        {(selectedEffect.easingCurve || DEFAULT_EASING_CURVE).map((point, index) => (
                                            <circle
                                                key={index}
                                                cx={point.t * 100}
                                                cy={50 - point.value * 50}
                                                r="4"
                                                fill={index === 0 || index === (selectedEffect.easingCurve || DEFAULT_EASING_CURVE).length - 1 ? "#666" : "#10b981"}
                                                stroke="#fff"
                                                strokeWidth="1"
                                                style={{ cursor: index === 0 || index === (selectedEffect.easingCurve || DEFAULT_EASING_CURVE).length - 1 ? 'default' : 'ns-resize' }}
                                                onMouseDown={(e) => {
                                                    // Don't allow dragging first/last points
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
                                    <div className="easing-labels">
                                        <span>Start</span>
                                        <span>End</span>
                                    </div>
                                </div>

                                <button
                                    className="reset-curve-btn"
                                    onClick={() => updateEffect(selectedEffect.id, {
                                        easingCurve: [...DEFAULT_EASING_CURVE]
                                    })}
                                >
                                    Reset Curve
                                </button>
                            </>
                        )}

                        {selectedEffect.type === 'blur' && (
                            <label>
                                Intensity: {selectedEffect.intensity || 5}px
                                <input
                                    type="range"
                                    min="1"
                                    max="20"
                                    step="1"
                                    value={selectedEffect.intensity || 5}
                                    onChange={(e) => updateEffect(selectedEffect.id, {
                                        intensity: parseInt(e.target.value)
                                    })}
                                />
                            </label>
                        )}

                        {selectedEffect.type === 'slowmo' && (
                            <label>
                                Speed: {((selectedEffect.speed || 0.5) * 100).toFixed(0)}%
                                <input
                                    type="range"
                                    min="0.1"
                                    max="1"
                                    step="0.1"
                                    value={selectedEffect.speed || 0.5}
                                    onChange={(e) => updateEffect(selectedEffect.id, {
                                        speed: parseFloat(e.target.value)
                                    })}
                                />
                            </label>
                        )}

                        <button
                            className="effect-delete-text-btn"
                            onClick={() => removeEffect(selectedEffect.id)}
                        >
                            Delete Effect
                        </button>
                    </div>
                )}

                {/* Trim Info */}
                <div className="trim-info">
                    <span>Trim: {formatTimeDetailed(trimStart)} - {formatTimeDetailed(trimEnd)}</span>
                    <span className="trim-duration">
                        Duration: {formatTimeDetailed(trimEnd - trimStart)}
                    </span>
                </div>

                {/* Controls */}
                <div className="editor-controls">
                    <button className="control-btn play-btn" onClick={togglePlay}>
                        {isPlaying ? (
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <rect x="6" y="4" width="4" height="16" />
                                <rect x="14" y="4" width="4" height="16" />
                            </svg>
                        ) : (
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5,3 19,12 5,21" />
                            </svg>
                        )}
                    </button>

                    <div className="export-controls">
                        <button
                            className="secondary-btn"
                            onClick={handleSaveOriginal}
                            disabled={isExporting}
                        >
                            Keep Original
                        </button>
                        <button
                            className="primary-btn"
                            onClick={handleExport}
                            disabled={isExporting}
                        >
                            {isExporting ? exportStatus : "Export"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default VideoEditor;
