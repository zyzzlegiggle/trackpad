import { useState } from 'react';
import { Effect, CanvasSettings, ExportSettings, SidebarTab } from './types';
import { formatTimeDetailed } from './utils';
import { EffectSettings } from './EffectSettings';
import { CURSOR_SIZES, RESOLUTION_OPTIONS, FORMAT_OPTIONS, QUALITY_OPTIONS } from './constants';

// Preset background colors
const BACKGROUND_PRESETS = [
    { name: 'Dark Blue', color: '#1a1a2e' },
    { name: 'Dark Purple', color: '#2d1b4e' },
    { name: 'Black', color: '#000000' },
    { name: 'Dark Gray', color: '#1f1f1f' },
    { name: 'White', color: '#ffffff' },
    { name: 'Light Gray', color: '#f0f0f0' },
];

// Tab icons as SVG components
const TabIcons = {
    background: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
            <path d="M21 15l-5-5L5 21" />
        </svg>
    ),
    cursor: (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
            <path d="M4 4l7.07 17 2.51-7.39L21 11.07z" />
        </svg>
    ),
    export: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
            <path d="M12 3v12M12 3l4 4M12 3L8 7" />
            <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
        </svg>
    ),
    effects: (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
            <path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7-6.3-4.6L5.7 21 8 14 2 9.4h7.6z" />
        </svg>
    ),
};

interface SidebarProps {
    selectedEffect: Effect | undefined;
    isExporting: boolean;
    exportStatus: string;
    trimStart: number;
    trimEnd: number;
    canvasSettings: CanvasSettings;
    exportSettings: ExportSettings;
    onCanvasSettingsChange: (settings: Partial<CanvasSettings>) => void;
    onExportSettingsChange: (settings: Partial<ExportSettings>) => void;
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
    exportSettings,
    onCanvasSettingsChange,
    onExportSettingsChange,
    onExport,
    onSaveOriginal,
    onEffectUpdate,
}: SidebarProps) {
    const [activeTab, setActiveTab] = useState<SidebarTab>('background');

    const tabs: { id: SidebarTab; icon: React.ReactNode; label: string }[] = [
        { id: 'background', icon: TabIcons.background, label: 'Background' },
        { id: 'cursor', icon: TabIcons.cursor, label: 'Cursor' },
        { id: 'export', icon: TabIcons.export, label: 'Export' },
        { id: 'effects', icon: TabIcons.effects, label: 'Effects' },
    ];

    return (
        <div className="w-80 bg-white border-l border-gray-200 flex flex-col shrink-0">
            {/* Export Button - Always visible at top */}
            <div className="p-4 border-b border-gray-200">
                <button
                    className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-gradient-to-br from-green-500 to-green-600 border-none rounded-xl text-white text-sm font-semibold cursor-pointer transition-all duration-200 shadow-lg shadow-green-500/30 hover:translate-y-[-1px] hover:shadow-xl hover:shadow-green-500/40 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
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
            </div>

            {/* Main content area with tab bar */}
            <div className="flex flex-1 min-h-0">
                {/* Vertical Tab Bar */}
                <div className="w-12 bg-gray-50 border-r border-gray-200 flex flex-col py-2">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            title={tab.label}
                            className={`w-10 h-10 mx-auto mb-1 rounded-lg flex items-center justify-center transition-all duration-200 ${activeTab === tab.id
                                    ? 'bg-indigo-100 text-indigo-600'
                                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                                }`}
                        >
                            {tab.icon}
                        </button>
                    ))}
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-y-auto p-4">
                    {activeTab === 'background' && (
                        <BackgroundTab
                            canvasSettings={canvasSettings}
                            onCanvasSettingsChange={onCanvasSettingsChange}
                        />
                    )}
                    {activeTab === 'cursor' && (
                        <CursorTab
                            canvasSettings={canvasSettings}
                            onCanvasSettingsChange={onCanvasSettingsChange}
                        />
                    )}
                    {activeTab === 'export' && (
                        <ExportTab
                            exportSettings={exportSettings}
                            onExportSettingsChange={onExportSettingsChange}
                            onSaveOriginal={onSaveOriginal}
                            isExporting={isExporting}
                            trimStart={trimStart}
                            trimEnd={trimEnd}
                        />
                    )}
                    {activeTab === 'effects' && (
                        <EffectsTab
                            selectedEffect={selectedEffect}
                            onEffectUpdate={onEffectUpdate}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

// Background Tab Content
function BackgroundTab({
    canvasSettings,
    onCanvasSettingsChange,
}: {
    canvasSettings: CanvasSettings;
    onCanvasSettingsChange: (settings: Partial<CanvasSettings>) => void;
}) {
    return (
        <div className="flex flex-col gap-5">
            <h3 className="text-sm font-semibold m-0 text-gray-900">Background</h3>

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

            <div className="h-px bg-gray-200" />

            {/* Corner Radius */}
            <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-600 font-medium">Corner Radius</label>
                <div className="flex items-center gap-2.5">
                    <input
                        type="range"
                        min="0"
                        max="32"
                        step="2"
                        value={canvasSettings.borderRadius}
                        onChange={(e) => onCanvasSettingsChange({ borderRadius: parseInt(e.target.value) })}
                        className="flex-1"
                    />
                    <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{canvasSettings.borderRadius}px</span>
                </div>
            </div>

            {/* Padding */}
            <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-600 font-medium">Padding</label>
                <div className="flex items-center gap-2.5">
                    <input
                        type="range"
                        min="0"
                        max="20"
                        step="1"
                        value={canvasSettings.paddingPercent}
                        onChange={(e) => onCanvasSettingsChange({ paddingPercent: parseInt(e.target.value) })}
                        className="flex-1"
                    />
                    <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{canvasSettings.paddingPercent}%</span>
                </div>
            </div>

            <div className="h-px bg-gray-200" />

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
    );
}

// Cursor Tab Content
function CursorTab({
    canvasSettings,
    onCanvasSettingsChange,
}: {
    canvasSettings: CanvasSettings;
    onCanvasSettingsChange: (settings: Partial<CanvasSettings>) => void;
}) {
    return (
        <div className="flex flex-col gap-5">
            <h3 className="text-sm font-semibold m-0 text-gray-900">Cursor</h3>

            {/* Cursor Overlay Toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
                <input
                    type="checkbox"
                    checked={canvasSettings.showCursor}
                    onChange={(e) => onCanvasSettingsChange({ showCursor: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-xs text-gray-600 font-medium">Show cursor overlay</span>
            </label>

            {/* Cursor Size (only show if cursor is enabled) */}
            {canvasSettings.showCursor && (
                <div className="flex flex-col gap-2">
                    <label className="text-xs text-gray-600 font-medium">Cursor Size</label>
                    <div className="flex items-center gap-2">
                        {[1, 2, 3].map((size) => (
                            <button
                                key={size}
                                className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all duration-150 ${canvasSettings.cursorSize === size
                                        ? 'bg-indigo-50 border-indigo-400 text-indigo-700'
                                        : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                                    }`}
                                onClick={() => onCanvasSettingsChange({ cursorSize: size })}
                            >
                                {size === 1 ? 'Small' : size === 2 ? 'Medium' : 'Large'}
                            </button>
                        ))}
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                        Size: {CURSOR_SIZES[canvasSettings.cursorSize]}px
                    </p>
                </div>
            )}
        </div>
    );
}

// Export Tab Content
function ExportTab({
    exportSettings,
    onExportSettingsChange,
    onSaveOriginal,
    isExporting,
    trimStart,
    trimEnd,
}: {
    exportSettings: ExportSettings;
    onExportSettingsChange: (settings: Partial<ExportSettings>) => void;
    onSaveOriginal: () => void;
    isExporting: boolean;
    trimStart: number;
    trimEnd: number;
}) {
    return (
        <div className="flex flex-col gap-5">
            <h3 className="text-sm font-semibold m-0 text-gray-900">Export Settings</h3>

            {/* Resolution */}
            <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-600 font-medium">Resolution</label>
                <select
                    value={exportSettings.resolution}
                    onChange={(e) => onExportSettingsChange({ resolution: e.target.value as ExportSettings['resolution'] })}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                >
                    {RESOLUTION_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                </select>
            </div>

            {/* Format */}
            <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-600 font-medium">Format</label>
                <div className="flex gap-2">
                    {FORMAT_OPTIONS.map((opt) => (
                        <button
                            key={opt.value}
                            onClick={() => onExportSettingsChange({ format: opt.value })}
                            className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all duration-150 ${exportSettings.format === opt.value
                                    ? 'bg-indigo-50 border-indigo-400 text-indigo-700'
                                    : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Quality */}
            <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-600 font-medium">Quality</label>
                <div className="flex gap-2">
                    {QUALITY_OPTIONS.map((opt) => (
                        <button
                            key={opt.value}
                            onClick={() => onExportSettingsChange({ quality: opt.value })}
                            className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all duration-150 ${exportSettings.quality === opt.value
                                    ? 'bg-indigo-50 border-indigo-400 text-indigo-700'
                                    : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="h-px bg-gray-200" />

            {/* Trim Info */}
            <div className="flex flex-col gap-2">
                <label className="text-xs text-gray-600 font-medium">Duration</label>
                <div className="flex flex-col gap-1 text-xs text-gray-600">
                    <span>{formatTimeDetailed(trimStart)} - {formatTimeDetailed(trimEnd)}</span>
                    <span className="font-semibold text-indigo-500">{formatTimeDetailed(trimEnd - trimStart)}</span>
                </div>
            </div>

            <div className="h-px bg-gray-200" />

            {/* Keep Original Button */}
            <button
                className="px-4 py-2.5 bg-transparent border border-gray-300 rounded-lg text-gray-600 text-sm font-medium cursor-pointer transition-all duration-200 hover:bg-gray-50 hover:border-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={onSaveOriginal}
                disabled={isExporting}
            >
                Keep Original
            </button>
        </div>
    );
}

// Effects Tab Content
function EffectsTab({
    selectedEffect,
    onEffectUpdate,
}: {
    selectedEffect: Effect | undefined;
    onEffectUpdate: (id: string, updates: Partial<Effect>) => void;
}) {
    return (
        <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold m-0 text-gray-900">Effects</h3>
            {selectedEffect ? (
                <EffectSettings effect={selectedEffect} onUpdate={onEffectUpdate} />
            ) : (
                <div className="text-gray-500 text-sm text-center py-8">
                    Select an effect on the timeline to edit its settings
                </div>
            )}
        </div>
    );
}
