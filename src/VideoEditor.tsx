import { useState, useRef, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "./VideoEditor.css";

interface VideoEditorProps {
    videoPath: string;
    onClose: () => void;
}

interface ZoomEffect {
    id: string;
    startTime: number;
    endTime: number;
    scale: number;
    targetX: number;
    targetY: number;
}

function VideoEditor({ videoPath, onClose }: VideoEditorProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const timelineRef = useRef<HTMLDivElement>(null);

    // Video state
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [videoError, setVideoError] = useState("");

    // Trim state
    const [trimStart, setTrimStart] = useState(0);
    const [trimEnd, setTrimEnd] = useState(0);

    // Zoom effects state
    const [zoomEffects, setZoomEffects] = useState<ZoomEffect[]>([]);
    const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState<string | null>(null);

    // Export state
    const [isExporting, setIsExporting] = useState(false);
    const [exportStatus, setExportStatus] = useState("");

    const videoUrl = convertFileSrc(videoPath);

    // Get current zoom effect at playhead
    const activeZoom = zoomEffects.find(
        z => currentTime >= z.startTime && currentTime <= z.endTime
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

    // Zoom effect functions
    const addZoomEffect = () => {
        const newZoom: ZoomEffect = {
            id: `zoom-${Date.now()}`,
            startTime: currentTime,
            endTime: Math.min(currentTime + 2, duration),
            scale: 1.5,
            targetX: 0.5,
            targetY: 0.5,
        };
        setZoomEffects([...zoomEffects, newZoom]);
        setSelectedZoomId(newZoom.id);
    };

    const removeZoomEffect = (id: string) => {
        setZoomEffects(zoomEffects.filter(z => z.id !== id));
        if (selectedZoomId === id) {
            setSelectedZoomId(null);
        }
    };

    const updateZoomEffect = (id: string, updates: Partial<ZoomEffect>) => {
        setZoomEffects(zoomEffects.map(z =>
            z.id === id ? { ...z, ...updates } : z
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
            } else if (isDragging.startsWith('zoom-')) {
                const [, zoomId, edge] = isDragging.split('-');
                const zoom = zoomEffects.find(z => z.id === `zoom-${zoomId}`);
                if (zoom) {
                    if (edge === 'start') {
                        if (newTime < zoom.endTime - 0.5) {
                            updateZoomEffect(`zoom-${zoomId}`, { startTime: newTime });
                        }
                    } else if (edge === 'end') {
                        if (newTime > zoom.startTime + 0.5) {
                            updateZoomEffect(`zoom-${zoomId}`, { endTime: newTime });
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
    }, [isDragging, duration, trimStart, trimEnd, zoomEffects]);

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
    const getZoomTransform = () => {
        if (!activeZoom) return {};
        const scale = activeZoom.scale;
        const translateX = (0.5 - activeZoom.targetX) * (scale - 1) * 100;
        const translateY = (0.5 - activeZoom.targetY) * (scale - 1) * 100;
        return {
            transform: `scale(${scale}) translate(${translateX}%, ${translateY}%)`,
            transition: 'transform 0.3s ease-out'
        };
    };

    const selectedZoom = zoomEffects.find(z => z.id === selectedZoomId);

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
                    <div className="video-wrapper" style={getZoomTransform()}>
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
                                {/* Trim region */}
                                <div
                                    className="trim-region"
                                    style={{
                                        left: `${(trimStart / duration) * 100}%`,
                                        width: `${((trimEnd - trimStart) / duration) * 100}%`
                                    }}
                                />
                                {/* Trim handles */}
                                <div
                                    className="trim-handle trim-handle-start"
                                    style={{ left: `${(trimStart / duration) * 100}%` }}
                                    onMouseDown={handleTrimStartDrag}
                                />
                                <div
                                    className="trim-handle trim-handle-end"
                                    style={{ left: `${(trimEnd / duration) * 100}%` }}
                                    onMouseDown={handleTrimEndDrag}
                                />
                            </div>
                        </div>

                        {/* Zoom Track */}
                        <div className="track zoom-track">
                            <div className="track-label">Zoom</div>
                            <div className="track-content">
                                {zoomEffects.map(zoom => (
                                    <div
                                        key={zoom.id}
                                        className={`zoom-segment ${selectedZoomId === zoom.id ? 'selected' : ''}`}
                                        style={{
                                            left: `${(zoom.startTime / duration) * 100}%`,
                                            width: `${((zoom.endTime - zoom.startTime) / duration) * 100}%`
                                        }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedZoomId(zoom.id);
                                        }}
                                    >
                                        <div
                                            className="zoom-handle zoom-handle-start"
                                            onMouseDown={(e) => {
                                                e.stopPropagation();
                                                setIsDragging(`zoom-${zoom.id.split('-')[1]}-start`);
                                            }}
                                        />
                                        <span className="zoom-label">{zoom.scale}x</span>
                                        <div
                                            className="zoom-handle zoom-handle-end"
                                            onMouseDown={(e) => {
                                                e.stopPropagation();
                                                setIsDragging(`zoom-${zoom.id.split('-')[1]}-end`);
                                            }}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Playhead */}
                        <div
                            className="playhead"
                            style={{ left: `${(currentTime / duration) * 100}%` }}
                        />
                    </div>
                </div>

                {/* Zoom Controls */}
                <div className="zoom-controls">
                    <button className="add-zoom-btn" onClick={addZoomEffect}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            <line x1="11" y1="8" x2="11" y2="14" />
                            <line x1="8" y1="11" x2="14" y2="11" />
                        </svg>
                        Add Zoom
                    </button>

                    {selectedZoom && (
                        <div className="zoom-settings">
                            <label>
                                Scale: {selectedZoom.scale.toFixed(1)}x
                                <input
                                    type="range"
                                    min="1"
                                    max="3"
                                    step="0.1"
                                    value={selectedZoom.scale}
                                    onChange={(e) => updateZoomEffect(selectedZoom.id, {
                                        scale: parseFloat(e.target.value)
                                    })}
                                />
                            </label>
                            <button
                                className="delete-zoom-btn"
                                onClick={() => removeZoomEffect(selectedZoom.id)}
                            >
                                Delete
                            </button>
                        </div>
                    )}
                </div>

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
