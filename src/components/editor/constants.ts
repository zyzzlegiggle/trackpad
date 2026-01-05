import { EffectType, EffectConfig, EasingPreset, CanvasSettings } from './types';

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
    clickRippleEnabled: true,
};
