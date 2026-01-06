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

// Zoom easing presets
export type EasingPreset = 'slow' | 'mellow' | 'quick' | 'rapid';

// Canvas styling settings
export interface CanvasSettings {
    backgroundColor: string;
    borderRadius: number;      // 0-32px
    paddingPercent: number;    // 0-20%
    clickRippleEnabled: boolean;
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
    easing?: EasingPreset; // Zoom animation speed preset
}

// Effect configuration type
export interface EffectConfig {
    label: string;
    color: string;
    defaultDuration: number;
}

// Export settings
export type ExportResolution = '720p' | '1080p' | '4k' | 'original';
export type ExportFormat = 'mp4' | 'webm';
export type ExportQuality = 'low' | 'medium' | 'high';

export interface ExportSettings {
    resolution: ExportResolution;
    format: ExportFormat;
    quality: ExportQuality;
}

// Sidebar tab types
export type SidebarTab = 'background' | 'export' | 'effects';
