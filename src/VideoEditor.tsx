import { useState, useRef, useEffect, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import {
    VideoEditorProps,
    Effect,
    EffectType,
    EFFECT_CONFIG,
    rangesOverlap,
    formatTimeDetailed,
    generateTimeMarkers,
} from "./components/editor";
import { VideoPreview } from "./components/editor/VideoPreview";
import { Toolbar } from "./components/editor/Toolbar";
import { Timeline } from "./components/editor/Timeline";
import { Sidebar } from "./components/editor/Sidebar";

function VideoEditor({ videoPath, onClose, clickEvents = [], cursorPositions = [] }: VideoEditorProps) {
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

    // Canvas background color (hex format)
    const [backgroundColor, setBackgroundColor] = useState("#1a1a2e");

    const videoUrl = convertFileSrc(videoPath);

    // Calculate timeline duration - extends beyond video if effects go further
    const maxEffectEnd = effects.length > 0 ? Math.max(...effects.map(e => e.endTime)) : 0;
    const timelineDuration = Math.max(duration, maxEffectEnd);

    // Get active effects at current playhead - memoized to prevent recalculation
    const activeEffects = useMemo(() =>
        effects.filter(e => currentTime >= e.startTime && currentTime <= e.endTime),
        [effects, currentTime]
    );

    // Find an available time slot in a given lane for an effect of given duration
    // Principle: Place effect as close to the desired time as possible
    const findAvailableSlotInLane = (lane: number, desiredStart: number, effectDuration: number, excludeId?: string): number => {
        const laneEffects = effects
            .filter(e => e.id !== excludeId && e.lane === lane)
            .sort((a, b) => a.startTime - b.startTime);

        if (laneEffects.length === 0) return Math.max(0, desiredStart);

        const desiredEnd = desiredStart + effectDuration;

        // Check if the desired position is free
        const hasOverlap = laneEffects.some(e =>
            rangesOverlap(desiredStart, desiredEnd, e.startTime, e.endTime)
        );

        if (!hasOverlap) return desiredStart;

        // Find the overlapping effect to determine best placement
        const overlappingEffect = laneEffects.find(e =>
            rangesOverlap(desiredStart, desiredEnd, e.startTime, e.endTime)
        );

        if (!overlappingEffect) return desiredStart;

        // Try placing immediately after the overlapping effect
        const afterEnd = overlappingEffect.endTime;
        const afterEndRange = { start: afterEnd, end: afterEnd + effectDuration };

        // Check if placing after the overlapping effect causes another overlap
        const hasOverlapAfter = laneEffects.some(e =>
            e.id !== overlappingEffect.id &&
            rangesOverlap(afterEndRange.start, afterEndRange.end, e.startTime, e.endTime)
        );

        if (!hasOverlapAfter) {
            return afterEnd;
        }

        // Try placing immediately before the overlapping effect
        const beforeStart = Math.max(0, overlappingEffect.startTime - effectDuration);
        const hasOverlapBefore = laneEffects.some(e =>
            e.id !== overlappingEffect.id &&
            rangesOverlap(beforeStart, beforeStart + effectDuration, e.startTime, e.endTime)
        );

        if (!hasOverlapBefore && beforeStart >= 0) {
            return beforeStart;
        }

        // Last resort: find the first gap in the timeline that fits
        for (let i = 0; i < laneEffects.length - 1; i++) {
            const gap = laneEffects[i + 1].startTime - laneEffects[i].endTime;
            if (gap >= effectDuration) {
                return laneEffects[i].endTime;
            }
        }

        // No gap found, append after the last effect
        const lastEffect = laneEffects[laneEffects.length - 1];
        return lastEffect.endTime;
    };

    // Snap effect to avoid overlaps
    const snapToAvoidOverlap = (effectId: string, newStart: number, newEnd: number, lane: number): { start: number; end: number } => {
        const effectDuration = newEnd - newStart;
        const laneEffects = effects
            .filter(e => e.id !== effectId && e.lane === lane)
            .sort((a, b) => a.startTime - b.startTime);

        if (laneEffects.length === 0) return { start: newStart, end: newEnd };

        const overlappingEffect = laneEffects.find(e =>
            rangesOverlap(newStart, newEnd, e.startTime, e.endTime)
        );

        if (!overlappingEffect) return { start: newStart, end: newEnd };

        const midpoint = (overlappingEffect.startTime + overlappingEffect.endTime) / 2;
        const effectMidpoint = (newStart + newEnd) / 2;

        if (effectMidpoint < midpoint) {
            const adjustedEnd = overlappingEffect.startTime;
            const adjustedStart = Math.max(0, adjustedEnd - effectDuration);
            return { start: adjustedStart, end: adjustedEnd };
        } else {
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
            // Throttle updates to reduce re-renders
            const newTime = video.currentTime;
            setCurrentTime(prev => {
                // Only update if change is significant (>16ms worth)
                if (Math.abs(newTime - prev) > 0.016) {
                    return newTime;
                }
                return prev;
            });
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
        if (effects.length > 0) return;

        const zoomDuration = EFFECT_CONFIG.zoom.defaultDuration;
        const generatedEffects: Effect[] = [];

        // Filter and deduplicate click events
        // Principle: Remove clicks that are too close in time (duplicate protection)
        const MIN_CLICK_GAP_MS = 300; // Minimum gap between distinct double-clicks

        const doubleClicks = clickEvents
            .filter(click => click.is_double_click)
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms);

        // Deduplicate: keep only clicks that are MIN_CLICK_GAP_MS apart
        const deduplicatedClicks = doubleClicks.filter((click, index) => {
            if (index === 0) return true;
            const prevClick = doubleClicks[index - 1];
            return click.timestamp_ms - prevClick.timestamp_ms >= MIN_CLICK_GAP_MS;
        });

        console.log(`Click events: ${clickEvents.length} total, ${doubleClicks.length} double-clicks, ${deduplicatedClicks.length} after deduplication`);

        deduplicatedClicks.forEach((click, index) => {
            const startTime = click.timestamp_ms / 1000;
            const endTime = startTime + zoomDuration;

            let adjustedStart = startTime;

            const hasOverlap = generatedEffects.some(e =>
                rangesOverlap(startTime, endTime, e.startTime, e.endTime)
            );

            if (hasOverlap) {
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
                lane: 0,
                scale: 1.5,
                targetX: click.x,
                targetY: click.y,
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

    // Effect functions
    const addEffect = (type: EffectType) => {
        const config = EFFECT_CONFIG[type];
        const effectDuration = config.defaultDuration;

        const startTime = findAvailableSlotInLane(0, currentTime, effectDuration);
        const endTime = startTime + effectDuration;

        const newEffect: Effect = {
            id: `${type}-${Date.now()}`,
            type,
            startTime,
            endTime,
            lane: 0,
        };

        if (type === 'zoom') {
            newEffect.scale = 2.0;  // Increased from 1.5 for tighter focus
            newEffect.targetX = 0.5;
            newEffect.targetY = 0.5;
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
                const effectId = isDragging.replace('-move', '');
                const effect = effects.find(e => e.id === effectId);
                if (effect && tracksContainerRef.current) {
                    const deltaY = e.clientY - dragStartY;
                    const laneHeight = 36;
                    const laneDelta = Math.round(deltaY / laneHeight);
                    const newLane = Math.max(0, dragStartLane + laneDelta);

                    if (newLane !== effect.lane) {
                        updateEffect(effectId, { lane: newLane });
                    }
                }
            } else if (isDragging.includes('-start') || isDragging.includes('-end')) {
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

            // Get zoom effects to export
            const zoomEffects = effects
                .filter(e => e.type === 'zoom' && e.startTime >= trimStart && e.endTime <= trimEnd)
                .map(e => ({
                    start_time: e.startTime,
                    end_time: e.endTime,
                    scale: e.scale || 1.5,
                    target_x: e.targetX || 0.5,
                    target_y: e.targetY || 0.5,
                }));

            if (zoomEffects.length > 0) {
                // Export with effects (slower, re-encodes)
                setExportStatus("Applying effects...");
                await invoke("export_with_effects", {
                    inputPath,
                    outputPath,
                    trimStart,
                    trimEnd,
                    effects: zoomEffects,
                    backgroundColor: backgroundColor.replace('#', ''),  // Pass color without # prefix
                });
            } else {
                // Fast export (no effects)
                await invoke("trim_video", {
                    inputPath,
                    outputPath,
                    startTime: trimStart,
                    endTime: trimEnd,
                });
            }

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

    const handleSeek = (newTime: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime = newTime;
            setCurrentTime(newTime);
        }
    };

    const selectedEffect = effects.find(e => e.id === selectedEffectId);

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
                <VideoPreview
                    videoUrl={videoUrl}
                    videoRef={videoRef}
                    isPlaying={isPlaying}
                    videoLoaded={videoLoaded}
                    videoError={videoError}
                    activeEffects={activeEffects}
                    currentTime={currentTime}
                    duration={duration}
                    cursorPositions={cursorPositions}
                    clickEvents={clickEvents}
                    backgroundColor={backgroundColor}
                    onTogglePlay={togglePlay}
                    formatTimeDetailed={formatTimeDetailed}
                />

                {/* Toolbar */}
                <Toolbar
                    onAddEffect={addEffect}
                    onDeleteEffect={() => selectedEffectId && removeEffect(selectedEffectId)}
                    hasSelection={!!selectedEffectId}
                />

                {/* Timeline */}
                <Timeline
                    duration={duration}
                    timelineDuration={timelineDuration}
                    currentTime={currentTime}
                    effects={effects}
                    trimStart={trimStart}
                    trimEnd={trimEnd}
                    selectedEffectId={selectedEffectId}
                    timeMarkers={generateTimeMarkers(timelineDuration)}
                    onSeek={handleSeek}
                    onTrimDragStart={(type) => setIsDragging(`trim-${type}`)}
                    onEffectSelect={setSelectedEffectId}
                    onEffectMoveStart={handleEffectMoveStart}
                    onEffectResizeStart={(e, effectId, edge) => {
                        e.stopPropagation();
                        setIsDragging(`${effectId}-${edge}`);
                    }}
                    timelineRef={timelineRef}
                    tracksContainerRef={tracksContainerRef}
                />
            </div>

            {/* Right Sidebar: Settings */}
            <Sidebar
                selectedEffect={selectedEffect}
                isExporting={isExporting}
                exportStatus={exportStatus}
                trimStart={trimStart}
                trimEnd={trimEnd}
                backgroundColor={backgroundColor}
                onBackgroundChange={setBackgroundColor}
                onExport={handleExport}
                onSaveOriginal={handleSaveOriginal}
                onEffectUpdate={updateEffect}
            />
        </div>
    );
}

export default VideoEditor;
