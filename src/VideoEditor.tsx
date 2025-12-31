import { useState, useRef, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "./VideoEditor.css";

interface VideoEditorProps {
    videoPath: string;
    onClose: () => void;
}

// Unified effect interface for all effect types
type EffectType = 'zoom' | 'blur' | 'slowmo';

interface Effect {
    id: string;
    type: EffectType;
    startTime: number;
    endTime: number;
    // Type-specific properties
    scale?: number;      // For zoom
    targetX?: number;    // For zoom
    targetY?: number;    // For zoom
    intensity?: number;  // For blur
    speed?: number;      // For slowmo
}

const EFFECT_CONFIG: Record<EffectType, { label: string; color: string; defaultDuration: number }> = {
    zoom: { label: 'Zoom', color: '#10b981', defaultDuration: 2 },
    blur: { label: 'Blur', color: '#3b82f6', defaultDuration: 2 },
    slowmo: { label: 'Slow-Mo', color: '#f59e0b', defaultDuration: 3 },
};

function VideoEditor({ videoPath, onClose }: VideoEditorProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const timelineRef = useRef<HTMLDivElement>(null);

    // Video state
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [videoError, setVideoError] = useState("");

    // Trim state (video duration adjustment)
    const [trimStart, setTrimStart] = useState(0);
    const [trimEnd, setTrimEnd] = useState(0);

    // Effects state
    const [effects, setEffects] = useState<Effect[]>([]);
    const [selectedEffectId, setSelectedEffectId] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState<string | null>(null);

    // Export state
    const [isExporting, setIsExporting] = useState(false);
    const [exportStatus, setExportStatus] = useState("");

    const videoUrl = convertFileSrc(videoPath);

    // Get active effects at current playhead
    const activeEffects = effects.filter(
        e => currentTime >= e.startTime && currentTime <= e.endTime
    );

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
        // Only seek if clicking on the timeline background, not on handles
        if ((e.target as HTMLElement).closest('.effect-segment, .trim-handle')) return;

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
        if (duration === 0) return [];
        const interval = duration < 30 ? 5 : duration < 60 ? 10 : 30;
        const markers = [];
        for (let t = 0; t <= duration; t += interval) {
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
        const newEffect: Effect = {
            id: `${type}-${Date.now()}`,
            type,
            startTime: currentTime,
            endTime: Math.min(currentTime + config.defaultDuration, duration),
        };

        // Add type-specific defaults
        if (type === 'zoom') {
            newEffect.scale = 1.5;
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
            } else if (isDragging.includes('-start') || isDragging.includes('-end')) {
                // Effect dragging: format is "effectId-start" or "effectId-end"
                const parts = isDragging.split('-');
                const edge = parts.pop(); // 'start' or 'end'
                const effectId = parts.join('-'); // rejoin in case id has dashes

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
            setIsDragging(null);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, duration, trimStart, trimEnd, effects]);

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

    // Calculate zoom transform for preview
    const getVideoTransform = () => {
        const zoomEffect = activeEffects.find(e => e.type === 'zoom');
        if (!zoomEffect || !zoomEffect.scale) return {};

        const scale = zoomEffect.scale;
        const translateX = (0.5 - (zoomEffect.targetX || 0.5)) * (scale - 1) * 100;
        const translateY = (0.5 - (zoomEffect.targetY || 0.5)) * (scale - 1) * 100;
        return {
            transform: `scale(${scale}) translate(${translateX}%, ${translateY}%)`,
            transition: 'transform 0.3s ease-out'
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

                {/* Multi-Track Timeline */}
                <div className="timeline-wrapper">
                    {/* Time Markers */}
                    <div className="time-markers">
                        {generateTimeMarkers().map(time => (
                            <div
                                key={time}
                                className="time-marker"
                                style={{ left: `${(time / duration) * 100}%` }}
                            >
                                <span>{formatTime(time)}</span>
                            </div>
                        ))}
                    </div>

                    {/* Timeline Tracks */}
                    <div
                        className="timeline-tracks"
                        ref={timelineRef}
                        onClick={handleTimelineClick}
                    >
                        {/* Video Track */}
                        <div className="track video-track">
                            <div className="track-label">Video</div>
                            <div className="track-content">
                                {/* Trim region (visible video portion) */}
                                <div
                                    className="trim-region"
                                    style={{
                                        left: `${(trimStart / duration) * 100}%`,
                                        width: `${((trimEnd - trimStart) / duration) * 100}%`
                                    }}
                                >
                                    {/* Left trim handle */}
                                    <div
                                        className="trim-handle trim-handle-left"
                                        onMouseDown={handleTrimStartDrag}
                                    >
                                        <div className="handle-grip"></div>
                                    </div>
                                    {/* Right trim handle */}
                                    <div
                                        className="trim-handle trim-handle-right"
                                        onMouseDown={handleTrimEndDrag}
                                    >
                                        <div className="handle-grip"></div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Effect Tracks - Only show if effects exist */}
                        {effects.length > 0 && (
                            <div className="track effects-track">
                                <div className="track-label">Effects</div>
                                <div className="track-content">
                                    {effects.map(effect => {
                                        const config = EFFECT_CONFIG[effect.type];
                                        const isSelected = selectedEffectId === effect.id;
                                        return (
                                            <div
                                                key={effect.id}
                                                className={`effect-segment effect-${effect.type} ${isSelected ? 'selected' : ''}`}
                                                style={{
                                                    left: `${(effect.startTime / duration) * 100}%`,
                                                    width: `${((effect.endTime - effect.startTime) / duration) * 100}%`,
                                                    backgroundColor: config.color,
                                                }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelectedEffectId(effect.id);
                                                }}
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

                                                {/* Delete button - visible when selected */}
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
                        )}

                        {/* Playhead */}
                        <div
                            className="playhead"
                            style={{ left: `${(currentTime / duration) * 100}%` }}
                        />
                    </div>
                </div>

                {/* Selected Effect Settings */}
                {selectedEffect && (
                    <div className="effect-settings" style={{ borderColor: EFFECT_CONFIG[selectedEffect.type].color }}>
                        <span className="effect-settings-label" style={{ color: EFFECT_CONFIG[selectedEffect.type].color }}>
                            {EFFECT_CONFIG[selectedEffect.type].label} Settings
                        </span>

                        {selectedEffect.type === 'zoom' && (
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
