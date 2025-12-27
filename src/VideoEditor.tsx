import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./VideoEditor.css";

interface VideoEditorProps {
    videoPath: string;
    onClose: () => void;
}

function VideoEditor({ videoPath, onClose }: VideoEditorProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [trimStart, setTrimStart] = useState(0);
    const [trimEnd, setTrimEnd] = useState(0);
    const [isExporting, setIsExporting] = useState(false);
    const [exportStatus, setExportStatus] = useState("");

    // Convert file path to asset URL for video playback
    const videoUrl = `asset://localhost/${videoPath.replace(/\\/g, "/").replace("C:/", "")}`;

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleLoadedMetadata = () => {
            setDuration(video.duration);
            setTrimEnd(video.duration);
        };

        const handleTimeUpdate = () => {
            setCurrentTime(video.currentTime);
            // Stop at trim end
            if (video.currentTime >= trimEnd) {
                video.pause();
                setIsPlaying(false);
            }
        };

        video.addEventListener("loadedmetadata", handleLoadedMetadata);
        video.addEventListener("timeupdate", handleTimeUpdate);

        return () => {
            video.removeEventListener("loadedmetadata", handleLoadedMetadata);
            video.removeEventListener("timeupdate", handleTimeUpdate);
        };
    }, [trimEnd]);

    const togglePlay = () => {
        const video = videoRef.current;
        if (!video) return;

        if (isPlaying) {
            video.pause();
        } else {
            // Start from trim start if at beginning or past trim end
            if (video.currentTime < trimStart || video.currentTime >= trimEnd) {
                video.currentTime = trimStart;
            }
            video.play();
        }
        setIsPlaying(!isPlaying);
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const time = parseFloat(e.target.value);
        setCurrentTime(time);
        if (videoRef.current) {
            videoRef.current.currentTime = time;
        }
    };

    const handleTrimStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = parseFloat(e.target.value);
        if (value < trimEnd) {
            setTrimStart(value);
            if (videoRef.current && videoRef.current.currentTime < value) {
                videoRef.current.currentTime = value;
                setCurrentTime(value);
            }
        }
    };

    const handleTrimEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = parseFloat(e.target.value);
        if (value > trimStart) {
            setTrimEnd(value);
            if (videoRef.current && videoRef.current.currentTime > value) {
                videoRef.current.currentTime = value;
                setCurrentTime(value);
            }
        }
    };

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 10);
        return `${mins}:${secs.toString().padStart(2, "0")}.${ms}`;
    };

    const handleExport = async () => {
        setIsExporting(true);
        setExportStatus("Trimming video...");

        try {
            const outputPath = videoPath.replace(".mp4", "_edited.mp4");
            await invoke("trim_video", {
                inputPath: videoPath,
                outputPath,
                startTime: trimStart,
                endTime: trimEnd,
            });
            setExportStatus("Saved!");
            setTimeout(() => {
                onClose();
            }, 1500);
        } catch (error) {
            console.error("Export failed:", error);
            setExportStatus("Export failed");
            setIsExporting(false);
        }
    };

    const handleSaveOriginal = () => {
        // Just close without trimming - original is already saved
        onClose();
    };

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
                    <video
                        ref={videoRef}
                        src={videoUrl}
                        className="video-player"
                        onClick={togglePlay}
                    />
                    <div className="video-overlay" onClick={togglePlay}>
                        {!isPlaying && (
                            <div className="play-button-overlay">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <polygon points="5,3 19,12 5,21" />
                                </svg>
                            </div>
                        )}
                    </div>
                </div>

                {/* Timeline */}
                <div className="timeline-section">
                    <div className="time-display">
                        <span>{formatTime(currentTime)}</span>
                        <span className="time-separator">/</span>
                        <span>{formatTime(duration)}</span>
                    </div>

                    <div className="timeline-container">
                        {/* Trim region background */}
                        <div
                            className="trim-region"
                            style={{
                                left: `${(trimStart / duration) * 100}%`,
                                width: `${((trimEnd - trimStart) / duration) * 100}%`,
                            }}
                        />

                        {/* Playhead */}
                        <input
                            type="range"
                            className="timeline-slider"
                            min="0"
                            max={duration}
                            step="0.1"
                            value={currentTime}
                            onChange={handleSeek}
                        />

                        {/* Trim handles */}
                        <div className="trim-handles">
                            <input
                                type="range"
                                className="trim-handle trim-start"
                                min="0"
                                max={duration}
                                step="0.1"
                                value={trimStart}
                                onChange={handleTrimStartChange}
                            />
                            <input
                                type="range"
                                className="trim-handle trim-end"
                                min="0"
                                max={duration}
                                step="0.1"
                                value={trimEnd}
                                onChange={handleTrimEndChange}
                            />
                        </div>
                    </div>

                    <div className="trim-info">
                        <span>Trim: {formatTime(trimStart)} - {formatTime(trimEnd)}</span>
                        <span className="trim-duration">
                            Duration: {formatTime(trimEnd - trimStart)}
                        </span>
                    </div>
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
                            disabled={isExporting || trimStart === 0 && trimEnd === duration}
                        >
                            {isExporting ? exportStatus : "Export Trimmed"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default VideoEditor;
