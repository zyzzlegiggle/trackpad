import { Effect } from './types';
import { EFFECT_CONFIG } from './constants';

interface EffectSegmentProps {
    effect: Effect;
    isSelected: boolean;
    timelineDuration: number;
    onSelect: (id: string) => void;
    onMoveStart: (e: React.MouseEvent, effect: Effect) => void;
    onResizeStart: (e: React.MouseEvent, effectId: string, edge: 'start' | 'end') => void;
}

export function EffectSegment({
    effect,
    isSelected,
    timelineDuration,
    onSelect,
    onMoveStart,
    onResizeStart,
}: EffectSegmentProps) {
    const config = EFFECT_CONFIG[effect.type];

    return (
        <div
            className={`effect-segment absolute top-1 bottom-1 rounded flex items-center justify-center cursor-grab min-w-8 z-[2] select-none transition-shadow duration-200 hover:shadow-md active:cursor-grabbing ${isSelected ? 'shadow-[0_0_0_2px_white,0_0_0_4px_currentColor] z-[3]' : ''}`}
            style={{
                left: `${(effect.startTime / timelineDuration) * 100}%`,
                width: `${((effect.endTime - effect.startTime) / timelineDuration) * 100}%`,
                backgroundColor: config.color,
            }}
            onMouseDown={(e) => {
                onSelect(effect.id);
                onMoveStart(e, effect);
            }}
        >
            <div
                className="effect-handle absolute top-0 bottom-0 left-0 w-1.5 cursor-ew-resize z-[3] transition-colors duration-200 hover:bg-white/30 rounded-l"
                onMouseDown={(e) => {
                    e.stopPropagation();
                    onResizeStart(e, effect.id, 'start');
                }}
            />
            <span className="text-[10px] font-semibold text-white pointer-events-none drop-shadow-sm">{config.label}</span>
            <div
                className="effect-handle absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize z-[3] transition-colors duration-200 hover:bg-white/30 rounded-r"
                onMouseDown={(e) => {
                    e.stopPropagation();
                    onResizeStart(e, effect.id, 'end');
                }}
            />
        </div>
    );
}
