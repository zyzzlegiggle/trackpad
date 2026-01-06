import { EffectType, EffectConfig, EasingPreset, CanvasSettings, CursorSettings, CursorStyle } from './types';

export const EFFECT_CONFIG: Record<EffectType, EffectConfig> = {
    zoom: { label: 'Zoom', color: '#10b981', defaultDuration: 2 },
    blur: { label: 'Blur', color: '#3b82f6', defaultDuration: 2 },
    slowmo: { label: 'Slow-Mo', color: '#f59e0b', defaultDuration: 3 },
};

// Zoom easing presets - duration in seconds
export const ZOOM_EASING_PRESETS: Record<EasingPreset, { duration: number; label: string }> = {
    slow: { duration: 0.5, label: 'Slow' },
    mellow: { duration: 0.35, label: 'Mellow' },
    quick: { duration: 0.2, label: 'Quick' },
    rapid: { duration: 0.1, label: 'Rapid' },
};

// Default canvas settings
export const DEFAULT_CANVAS_SETTINGS: CanvasSettings = {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    paddingPercent: 5,
    clickRippleEnabled: false,
};

// Cursor style options
export const CURSOR_STYLES: { value: CursorStyle; label: string }[] = [
    { value: 'pointer', label: 'Pointer' },
    { value: 'circle', label: 'Circle' },
    { value: 'crosshair', label: 'Crosshair' },
];

// Default cursor settings
export const DEFAULT_CURSOR_SETTINGS: CursorSettings = {
    visible: true,
    style: 'pointer',
    size: 24,
    color: '#ffffff',
    smoothing: 0.15,        // Lerp factor (higher = smoother)
    velocityScale: true,    // Enlarge on fast movement
    clickRipple: true,      // Show click ripples
};

// Export resolution options
export const RESOLUTION_OPTIONS = [
    { value: 'original', label: 'Original' },
    { value: '4k', label: '4K (2160p)' },
    { value: '1080p', label: 'Full HD (1080p)' },
    { value: '720p', label: 'HD (720p)' },
] as const;

// Export format options
export const FORMAT_OPTIONS = [
    { value: 'mp4', label: 'MP4' },
    { value: 'webm', label: 'WebM' },
] as const;

// Export quality options
export const QUALITY_OPTIONS = [
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
] as const;

// Default export settings
export const DEFAULT_EXPORT_SETTINGS = {
    resolution: 'original' as const,
    format: 'mp4' as const,
    quality: 'high' as const,
};
