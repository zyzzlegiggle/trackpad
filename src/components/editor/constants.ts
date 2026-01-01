import { EffectType, EffectConfig, EasingPoint } from './types';

export const EFFECT_CONFIG: Record<EffectType, EffectConfig> = {
    zoom: { label: 'Zoom', color: '#10b981', defaultDuration: 2 },
    blur: { label: 'Blur', color: '#3b82f6', defaultDuration: 2 },
    slowmo: { label: 'Slow-Mo', color: '#f59e0b', defaultDuration: 3 },
};

// Default S-curve: fade in, hold, fade out
export const DEFAULT_EASING_CURVE: EasingPoint[] = [
    { t: 0, value: 0 },      // Start: no zoom
    { t: 0.2, value: 1 },    // 20%: fully zoomed in
    { t: 0.8, value: 1 },    // 80%: still zoomed
    { t: 1, value: 0 },      // End: zoom out
];
