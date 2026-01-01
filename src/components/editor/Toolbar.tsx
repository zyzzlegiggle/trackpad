import { EffectType } from './types';

interface ToolbarProps {
    onAddEffect: (type: EffectType) => void;
    onDeleteEffect: () => void;
    hasSelection: boolean;
}

export function Toolbar({ onAddEffect, onDeleteEffect, hasSelection }: ToolbarProps) {
    return (
        <div className="flex items-center gap-2 py-3 shrink-0">
            <button
                className="w-10 h-10 border border-gray-300 bg-white rounded-lg cursor-pointer flex items-center justify-center text-gray-600 transition-all duration-200 hover:bg-gray-100 hover:border-gray-400 hover:text-gray-900"
                onClick={() => onAddEffect('zoom')}
                title="Add Zoom Effect"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    <line x1="11" y1="8" x2="11" y2="14" />
                    <line x1="8" y1="11" x2="14" y2="11" />
                </svg>
            </button>
            <button
                className="w-10 h-10 border border-gray-300 bg-white rounded-lg cursor-pointer flex items-center justify-center text-gray-600 transition-all duration-200 hover:bg-gray-100 hover:border-gray-400 hover:text-gray-900"
                onClick={() => onAddEffect('blur')}
                title="Add Blur Effect"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="6" />
                    <circle cx="12" cy="12" r="2" />
                </svg>
            </button>
            <button
                className="w-10 h-10 border border-gray-300 bg-white rounded-lg cursor-pointer flex items-center justify-center text-gray-600 transition-all duration-200 hover:bg-gray-100 hover:border-gray-400 hover:text-gray-900"
                onClick={() => onAddEffect('slowmo')}
                title="Add Slow-Mo Effect"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12,6 12,12 16,14" />
                </svg>
            </button>
            <div className="w-px h-6 bg-gray-300 mx-1" />
            {hasSelection && (
                <button
                    className="w-10 h-10 border border-red-200 bg-white rounded-lg cursor-pointer flex items-center justify-center text-red-600 transition-all duration-200 hover:bg-red-50 hover:border-red-600"
                    onClick={onDeleteEffect}
                    title="Delete Selected Effect"
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                        <polyline points="3,6 5,6 21,6" />
                        <path d="M19,6V20a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6M8,6V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6" />
                    </svg>
                </button>
            )}
        </div>
    );
}
