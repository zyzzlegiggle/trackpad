import { useEffect } from "react";

function Overlay() {
    // Placeholder state for future mouse tracking
    // const [position, setPosition] = useState({ x: 0, y: 0 });
    // const [isClicking, setIsClicking] = useState(false);

    useEffect(() => {
        // Future: Track mouse via backend event
    }, []);

    return (
        <div className="w-screen h-screen bg-transparent pointer-events-none overflow-hidden relative">
            {/* Visual placeholder for effect */}
            <div
                className="absolute w-12 h-12 rounded-full bg-yellow-400/30 border-2 border-yellow-400/60 pointer-events-none -translate-x-1/2 -translate-y-1/2 transition-all duration-100 shadow-[0_0_15px_rgba(255,255,0,0.4)]"
                style={{ left: '50%', top: '50%' }}
            />
            <div className="absolute top-2.5 left-2.5 text-white bg-black/50 p-1.5 font-mono">Overlay Active</div>
        </div>
    );
}

export default Overlay;
