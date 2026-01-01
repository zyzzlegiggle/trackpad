import { Effect } from './types';
import { EFFECT_CONFIG, DEFAULT_EASING_CURVE } from './constants';
import { EasingCurveEditor } from './EasingCurveEditor';

interface EffectSettingsProps {
    effect: Effect;
    onUpdate: (id: string, updates: Partial<Effect>) => void;
}

export function EffectSettings({ effect, onUpdate }: EffectSettingsProps) {
    return (
        <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold m-0" style={{ color: EFFECT_CONFIG[effect.type].color }}>
                {EFFECT_CONFIG[effect.type].label} Settings
            </h3>

            {effect.type === 'zoom' && (
                <>
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-gray-600 font-medium">Scale</label>
                        <div className="flex items-center gap-2.5">
                            <input
                                type="range"
                                min="1"
                                max="3"
                                step="0.1"
                                value={effect.scale || 1.5}
                                onChange={(e) => onUpdate(effect.id, {
                                    scale: parseFloat(e.target.value)
                                })}
                                className="range-slider"
                            />
                            <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{(effect.scale || 1.5).toFixed(1)}x</span>
                        </div>
                    </div>

                    {/* Easing Curve Editor */}
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-gray-600 font-medium">Zoom Timing</label>
                    </div>
                    <EasingCurveEditor
                        curve={effect.easingCurve || DEFAULT_EASING_CURVE}
                        onChange={(curve) => onUpdate(effect.id, { easingCurve: curve })}
                        onReset={() => onUpdate(effect.id, { easingCurve: [...DEFAULT_EASING_CURVE] })}
                    />
                </>
            )}

            {effect.type === 'blur' && (
                <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-gray-600 font-medium">Intensity</label>
                    <div className="flex items-center gap-2.5">
                        <input
                            type="range"
                            min="1"
                            max="20"
                            step="1"
                            value={effect.intensity || 5}
                            onChange={(e) => onUpdate(effect.id, {
                                intensity: parseInt(e.target.value)
                            })}
                            className="range-slider"
                        />
                        <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{effect.intensity || 5}px</span>
                    </div>
                </div>
            )}

            {effect.type === 'slowmo' && (
                <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-gray-600 font-medium">Speed</label>
                    <div className="flex items-center gap-2.5">
                        <input
                            type="range"
                            min="0.1"
                            max="1"
                            step="0.1"
                            value={effect.speed || 0.5}
                            onChange={(e) => onUpdate(effect.id, {
                                speed: parseFloat(e.target.value)
                            })}
                            className="range-slider"
                        />
                        <span className="text-xs text-gray-900 font-medium min-w-10 text-right">{((effect.speed || 0.5) * 100).toFixed(0)}%</span>
                    </div>
                </div>
            )}
        </div>
    );
}
