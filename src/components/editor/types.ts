// Click event from recording
export interface ClickEvent {
    timestamp_ms: number;
    x: number;
    y: number;
    is_double_click: boolean;
}

export interface VideoEditorProps {
    videoPath: string;
    onClose: () => void;
    clickEvents?: ClickEvent[];
}

// Effect types
export type EffectType = 'zoom' | 'blur' | 'slowmo';

// Easing curve point for controlling zoom in/out intensity over time
export interface EasingPoint {
    t: number;     // Normalized time (0-1) within the effect
    value: number; // Intensity (0-1), where 0=no effect, 1=full effect
}

// Unified effect interface with lane support
export interface Effect {
    id: string;
    type: EffectType;
    startTime: number;
    endTime: number;
    lane: number; // 0-indexed lane for effect placement
    // Type-specific properties
    scale?: number;
    targetX?: number;
    targetY?: number;
    intensity?: number;
    speed?: number;
    // Easing curve for zoom effects
    easingCurve?: EasingPoint[];
}

// Effect configuration type
export interface EffectConfig {
    label: string;
    color: string;
    defaultDuration: number;
}
