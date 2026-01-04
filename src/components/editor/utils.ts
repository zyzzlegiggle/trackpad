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
