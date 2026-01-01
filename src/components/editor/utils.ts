import { EasingPoint } from './types';

// Interpolate easing curve to get intensity at a given progress (0-1)
export const sampleEasingCurve = (curve: EasingPoint[], progress: number): number => {
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

// Check if two time ranges overlap
export const rangesOverlap = (s1: number, e1: number, s2: number, e2: number): boolean => {
    return s1 < e2 && e1 > s2;
};

// Time formatting - simple mm:ss
export const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
};

// Time formatting - detailed mm:ss.d
export const formatTimeDetailed = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, "0")}.${ms}`;
};

// Generate time markers for timeline
export const generateTimeMarkers = (timelineDuration: number): number[] => {
    if (timelineDuration === 0) return [];
    const interval = timelineDuration < 30 ? 5 : timelineDuration < 60 ? 10 : 30;
    const markers = [];
    for (let t = 0; t <= timelineDuration; t += interval) {
        markers.push(t);
    }
    return markers;
};
