// Click event from recording
export interface ClickEvent {
    timestamp_ms: number;
    x: number;
    y: number;
    is_double_click: boolean;
}

// Cursor position from recording (for cursor-following zoom)
export interface CursorPosition {
    timestamp_ms: number;
    x: number;
    y: number;
}

export interface VideoEditorProps {
    videoPath: string;
    onClose: () => void;
    clickEvents?: ClickEvent[];
    cursorPositions?: CursorPosition[];
}

// Effect types
export type EffectType = 'zoom' | 'blur' | 'slowmo';

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
}

// Effect configuration type
export interface EffectConfig {
    label: string;
    color: string;
    defaultDuration: number;
}
