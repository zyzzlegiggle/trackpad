interface TrimTrackProps {
    trimStart: number;
    trimEnd: number;
    timelineDuration: number;
    onDragStart: (e: React.MouseEvent) => void;
    onDragEnd: (e: React.MouseEvent) => void;
}

export function TrimTrack({ trimStart, trimEnd, timelineDuration, onDragStart, onDragEnd }: TrimTrackProps) {
    return (
        <div className="h-9 bg-gray-100 rounded-md relative">
            <div
                className="absolute top-1 bottom-1 bg-gradient-to-br from-indigo-400 to-indigo-500 rounded flex items-center justify-center min-w-10"
                style={{
                    left: `${(trimStart / timelineDuration) * 100}%`,
                    width: `${((trimEnd - trimStart) / timelineDuration) * 100}%`
                }}
            >
                <div
                    className="trim-handle absolute top-0 bottom-0 left-0 w-2 bg-black/20 cursor-ew-resize transition-colors duration-200 hover:bg-black/40 rounded-l"
                    onMouseDown={onDragStart}
                />
                <span className="text-[10px] text-white font-medium opacity-90">✂ Trim</span>
                <div
                    className="trim-handle absolute top-0 bottom-0 right-0 w-2 bg-black/20 cursor-ew-resize transition-colors duration-200 hover:bg-black/40 rounded-r"
                    onMouseDown={onDragEnd}
                />
            </div>
        </div>
    );
}
