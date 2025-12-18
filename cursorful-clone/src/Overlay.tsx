import { useEffect } from "react";
import "./Overlay.css";

function Overlay() {
    // Placeholder state for future mouse tracking
    // const [position, setPosition] = useState({ x: 0, y: 0 });
    // const [isClicking, setIsClicking] = useState(false);

    useEffect(() => {
        // Future: Track mouse via backend event
    }, []);

    return (
        <div className="overlay-container">
            {/* Visual placeholder for effect */}
            <div className="cursor-halo" style={{ left: '50%', top: '50%' }} />
            <div className="debug-info">Overlay Active</div>
        </div>
    );
}

export default Overlay;
