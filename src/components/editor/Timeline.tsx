import { useRef, useCallback } from 'react';
import { Effect } from './types';
import { formatTime } from './utils';
import { TrimTrack } from './TrimTrack';
import { EffectSegment } from './EffectSegment';

interface TimelineProps {
    duration: number;
    timelineDuration: number;
    currentTime: number;
    effects: Effect[];
    trimStart: number;
    trimEnd: number;
    selectedEffectId: string | null;
    timeMarkers: number[];
    onSeek: (time: number) => void;
    onTrimDragStart: (type: 'start' | 'end') => void;
    onEffectSelect: (id: string) => void;
    onEffectMoveStart: (e: React.MouseEvent, effect: Effect) => void;
    onEffectResizeStart: (e: React.MouseEvent, effectId: string, edge: 'start' | 'end') => void;
    timelineRef: React.RefObject<HTMLDivElement | null>;
    tracksContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function Timeline({
    duration,
    timelineDuration,
    currentTime,
    effects,
    trimStart,
    trimEnd,
    selectedEffectId,
    timeMarkers,
    onSeek,
    onTrimDragStart,
    onEffectSelect,
    onEffectMoveStart,
    onEffectResizeStart,
    timelineRef,
    tracksContainerRef,
}: TimelineProps) {
    // Group effects by lane
    const laneCount = effects.length > 0 ? Math.max(...effects.map(e => e.lane)) + 1 : 0;
    const effectsByLane: Effect[][] = [];
    for (let i = 0; i < laneCount; i++) {
        effectsByLane.push(effects.filter(e => e.lane === i));
    }

    // Timeline click to seek
    const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!timelineRef.current || duration === 0) return;
        if ((e.target as HTMLElement).closest('.effect-segment, .trim-handle, .effect-handle')) return;

        const rect = timelineRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = x / rect.width;
        const newTime = percentage * duration;

        onSeek(Math.max(0, Math.min(duration, newTime)));
    }, [duration, onSeek, timelineRef]);

    return (
        <div className="bg-white rounded-xl px-4 py-3 shrink-0 border border-gray-200">
            {/* Time Markers */}
            <div className="relative h-5 mb-2">
                {timeMarkers.map(time => (
                    <div
                        key={time}
                        className="absolute -translate-x-1/2 text-[10px] text-gray-500 font-mono after:content-[''] after:absolute after:left-1/2 after:top-3.5 after:w-px after:h-1.5 after:bg-gray-300"
                        style={{ left: `${(time / timelineDuration) * 100}%` }}
                    >
                        <span>{formatTime(time)}</span>
                    </div>
                ))}
            </div>

            {/* Timeline Tracks */}
            <div className="max-h-28 overflow-y-auto scrollbar-thin" ref={tracksContainerRef}>
                <div
                    className="relative flex flex-col gap-1.5 min-h-10 cursor-pointer"
                    ref={timelineRef}
                    onClick={handleTimelineClick}
                >
                    {/* Video/Trim Track */}
                    <TrimTrack
                        trimStart={trimStart}
                        trimEnd={trimEnd}
                        timelineDuration={timelineDuration}
                        onDragStart={(e) => {
                            e.stopPropagation();
                            onTrimDragStart('start');
                        }}
                        onDragEnd={(e) => {
                            e.stopPropagation();
                            onTrimDragStart('end');
                        }}
                    />

                    {/* Effect Lanes */}
                    {effectsByLane.map((laneEffects, laneIndex) => (
                        <div key={laneIndex} className="h-9 bg-gray-50 rounded-md relative">
                            {laneEffects.map(effect => (
                                <EffectSegment
                                    key={effect.id}
                                    effect={effect}
                                    isSelected={selectedEffectId === effect.id}
                                    timelineDuration={timelineDuration}
                                    onSelect={onEffectSelect}
                                    onMoveStart={onEffectMoveStart}
                                    onResizeStart={onEffectResizeStart}
                                />
                            ))}
                        </div>
                    ))}

                    {/* Playhead */}
                    <div
                        className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none before:content-[''] before:absolute before:-top-1 before:left-1/2 before:-translate-x-1/2 before:border-l-[6px] before:border-r-[6px] before:border-t-[6px] before:border-l-transparent before:border-r-transparent before:border-t-red-500"
                        style={{ left: `${(currentTime / timelineDuration) * 100}%` }}
                    />
                </div>
            </div>
        </div>
    );
}
