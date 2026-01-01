import { EasingPoint } from './types';
import { DEFAULT_EASING_CURVE } from './constants';

interface EasingCurveEditorProps {
    curve: EasingPoint[];
    onChange: (curve: EasingPoint[]) => void;
    onReset: () => void;
}

export function EasingCurveEditor({ curve, onChange, onReset }: EasingCurveEditorProps) {
    const handlePointDrag = (index: number, e: React.MouseEvent<SVGCircleElement>) => {
        // First and last points are fixed
        if (index === 0 || index === curve.length - 1) return;

        e.stopPropagation();
        const svg = e.currentTarget.closest('svg');
        if (!svg) return;

        const handleDrag = (moveEvent: MouseEvent) => {
            const rect = svg.getBoundingClientRect();
            const y = (moveEvent.clientY - rect.top) / rect.height;
            const newValue = Math.max(0, Math.min(1, 1 - y));

            const newCurve = [...curve];
            newCurve[index] = { ...newCurve[index], value: newValue };
            onChange(newCurve);
        };

        const handleUp = () => {
            window.removeEventListener('mousemove', handleDrag);
            window.removeEventListener('mouseup', handleUp);
        };

        window.addEventListener('mousemove', handleDrag);
        window.addEventListener('mouseup', handleUp);
    };

    return (
        <div className="flex flex-col gap-1.5">
            <svg
                className="w-full h-14 bg-gray-900 rounded-md border border-gray-700"
                viewBox="0 0 100 50"
                preserveAspectRatio="none"
            >
                <line x1="0" y1="25" x2="100" y2="25" stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />
                <line x1="20" y1="0" x2="20" y2="50" stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />
                <line x1="80" y1="0" x2="80" y2="50" stroke="#333" strokeWidth="0.5" strokeDasharray="2,2" />

                <path
                    d={`M ${curve
                        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.t * 100} ${50 - p.value * 50}`)
                        .join(' ')}`}
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="2"
                />

                {curve.map((point, index) => (
                    <circle
                        key={index}
                        cx={point.t * 100}
                        cy={50 - point.value * 50}
                        r="4"
                        fill={index === 0 || index === curve.length - 1 ? "#666" : "#10b981"}
                        stroke="#fff"
                        strokeWidth="1"
                        className={`transition-colors duration-100 ${index !== 0 && index !== curve.length - 1 ? 'hover:fill-green-400 cursor-ns-resize' : 'cursor-default'}`}
                        onMouseDown={(e) => handlePointDrag(index, e)}
                    />
                ))}
            </svg>
            <div className="flex justify-between text-[10px] text-gray-500">
                <span>Start</span>
                <span>End</span>
            </div>
            <button
                className="px-2.5 py-1.5 bg-transparent text-gray-600 border border-gray-300 rounded-md text-[11px] cursor-pointer transition-all duration-200 self-start hover:bg-gray-50 hover:border-green-500 hover:text-green-600"
                onClick={onReset}
            >
                Reset Curve
            </button>
        </div>
    );
}
