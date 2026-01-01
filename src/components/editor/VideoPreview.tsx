import { RefObject } from 'react';
import { Effect } from './types';
import { sampleEasingCurve } from './utils';
import { DEFAULT_EASING_CURVE } from './constants';

interface VideoPreviewProps {
    videoUrl: string;
    videoRef: RefObject<HTMLVideoElement | null>;
    isPlaying: boolean;
    videoLoaded: boolean;
    videoError: string;
    activeEffects: Effect[];
    currentTime: number;
    duration: number;
    onTogglePlay: () => void;
    formatTimeDetailed: (seconds: number) => string;
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
    onTogglePlay,
    formatTimeDetailed,
}: VideoPreviewProps) {
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
            <div className="flex-1 flex items-center justify-center origin-center" style={{ ...getVideoTransform(), ...getVideoFilter() }}>
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
