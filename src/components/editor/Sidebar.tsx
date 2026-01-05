import { Effect, CanvasSettings } from './types';
import { formatTimeDetailed } from './utils';
import { EffectSettings } from './EffectSettings';

// Preset background colors
const BACKGROUND_PRESETS = [
    { name: 'Dark Blue', color: '#1a1a2e' },
    { name: 'Dark Purple', color: '#2d1b4e' },
    { name: 'Black', color: '#000000' },
    { name: 'Dark Gray', color: '#1f1f1f' },
    { name: 'White', color: '#ffffff' },
    { name: 'Light Gray', color: '#f0f0f0' },
];

interface SidebarProps {
    selectedEffect: Effect | undefined;
    isExporting: boolean;
    exportStatus: string;
    trimStart: number;
    trimEnd: number;
    canvasSettings: CanvasSettings;
    onCanvasSettingsChange: (settings: Partial<CanvasSettings>) => void;
    onExport: () => void;
    onSaveOriginal: () => void;
    onEffectUpdate: (id: string, updates: Partial<Effect>) => void;
}

export function Sidebar({
    selectedEffect,
    isExporting,
    exportStatus,
    trimStart,
    trimEnd,
    canvasSettings,
    onCanvasSettingsChange,
    onExport,
    onSaveOriginal,
    onEffectUpdate,
}: SidebarProps) {
    return (
        <div className="w-72 bg-white border-l border-gray-200 p-5 flex flex-col gap-4 overflow-y-auto shrink-0">
            {/* Export Button */}
            <button
                className="flex items-center justify-center gap-2 px-6 py-3.5 bg-gradient-to-br from-green-500 to-green-600 border-none rounded-xl text-white text-sm font-semibold cursor-pointer transition-all duration-200 shadow-lg shadow-green-500/30 hover:translate-y-[-1px] hover:shadow-xl hover:shadow-green-500/40 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                onClick={onExport}
                disabled={isExporting}
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                    <path d="M21,15V19a2,2,0,0,1-2,2H5a2,2,0,0,1-2-2V15" />
                    <polyline points="17,8 12,3 7,8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                {isExporting ? exportStatus : "Export video"}
            </button>

            {/* Quick Save */}
            <button
                className="px-4 py-2.5 bg-transparent border border-gray-300 rounded-lg text-gray-600 text-sm font-medium cursor-pointer transition-all duration-200 hover:bg-gray-50 hover:border-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={onSaveOriginal}
                disabled={isExporting}
            >
                Keep Original
            </button>

            <div className="h-px bg-gray-200" />

            {/* Canvas Settings */}
            <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold m-0">Canvas Style</h3>

                {/* Background Color Presets */}
                <div className="grid grid-cols-6 gap-1.5">
                    {BACKGROUND_PRESETS.map((preset) => (
                        <button
                            key={preset.color}
                            title={preset.name}
                            className={`w-full aspect-square rounded-md border-2 transition-all duration-200 hover:scale-105 ${canvasSettings.backgroundColor === preset.color
                                ? 'border-indigo-500 ring-2 ring-indigo-200'
                                : 'border-gray-200 hover:border-gray-300'
                                }`}
                            style={{ backgroundColor: preset.color }}
                            onClick={() => onCanvasSettingsChange({ backgroundColor: preset.color })}
                        />
                    ))}
                </div>

                {/* Custom color input */}
                <div className="flex items-center gap-2">
                    <input
                        type="color"
                        value={canvasSettings.backgroundColor}
                        onChange={(e) => onCanvasSettingsChange({ backgroundColor: e.target.value })}
                        className="w-8 h-8 rounded cursor-pointer border border-gray-200"
                    />
                    <input
                        type="text"
                        value={canvasSettings.backgroundColor}
                        onChange={(e) => onCanvasSettingsChange({ backgroundColor: e.target.value })}
                        className="flex-1 px-2 py-1 text-xs font-mono border border-gray-200 rounded"
                        placeholder="#000000"
                    />
                </div>

                {/* Border Radius */}
                <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-gray-600 font-medium">Corner Radius</label>
                    <div className="flex items-center gap-2.5">
                        <input
                            type="range"
                            min="0"
                            max="32"
                            step="2"
                            value={canvasSettings.borderRadius}
                            onChange={(e) => onCanvasSettingsChange({ borderRadius: parseInt(e.target.value) })}
                            className="range-slider flex-1"
                        />
                        <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{canvasSettings.borderRadius}px</span>
                    </div>
                </div>

                {/* Padding */}
                <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-gray-600 font-medium">Padding</label>
                    <div className="flex items-center gap-2.5">
                        <input
                            type="range"
                            min="0"
                            max="20"
                            step="1"
                            value={canvasSettings.paddingPercent}
                            onChange={(e) => onCanvasSettingsChange({ paddingPercent: parseInt(e.target.value) })}
                            className="range-slider flex-1"
                        />
                        <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{canvasSettings.paddingPercent}%</span>
                    </div>
                </div>

                {/* Click Ripple Toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={canvasSettings.clickRippleEnabled}
                        onChange={(e) => onCanvasSettingsChange({ clickRippleEnabled: e.target.checked })}
                        className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-xs text-gray-600 font-medium">Show click ripples</span>
                </label>
            </div>

            <div className="h-px bg-gray-200" />

            {/* Effect Settings */}
            {selectedEffect ? (
                <EffectSettings effect={selectedEffect} onUpdate={onEffectUpdate} />
            ) : (
                <div className="flex flex-col gap-3 text-gray-500 text-sm text-center py-5">
                    <span>Select an effect to edit</span>
                </div>
            )}

            <div className="h-px bg-gray-200" />

            {/* Trim Info */}
            <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold m-0">Trim</h3>
                <div className="flex flex-col gap-1 text-xs text-gray-600">
                    <span>{formatTimeDetailed(trimStart)} - {formatTimeDetailed(trimEnd)}</span>
                    <span className="font-semibold text-indigo-500">{formatTimeDetailed(trimEnd - trimStart)}</span>
                </div>
            </div>
        </div>
    );
}

