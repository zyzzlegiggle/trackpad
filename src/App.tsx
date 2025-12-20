import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface WindowInfo {
  id: number;
  title: string;
}

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Standby");
  const [filename, setFilename] = useState("");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<string>("monitor");
  const [selectedLabel, setSelectedLabel] = useState("Primary Monitor");
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [livePreviewSrc, setLivePreviewSrc] = useState("");

  useEffect(() => {
    // Generate default filename
    const date = new Date();
    const timestamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    setFilename(`C:/Users/josse/Videos/recording_${timestamp}.mp4`);
    refreshWindows();
  }, []);

  const refreshWindows = async () => {
    try {
      const wins = await invoke<WindowInfo[]>("get_open_windows");
      setWindows(wins);
    } catch (e) {
      console.error("Failed to list windows", e);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    async function setup() {
      await invoke("start_preview");
      unlisten = await listen<string>('preview-frame', (event) => {
        setLivePreviewSrc(`data:image/jpeg;base64,${event.payload}`);
      });
    }
    setup();

    return () => {
      if (unlisten) unlisten();
      invoke("stop_preview");
    };
  }, []);

  const toggleRecording = async () => {
    try {
      if (isRecording) {
        setStatus("Stopping...");
        await invoke("stop_recording");
        setIsRecording(false);
        setStatus("Saved!");
        setTimeout(() => setStatus("Standby"), 2000);
      } else {
        setStatus("Starting...");

        const target = selectedTarget !== "monitor"
          ? { type: "window", id: parseInt(selectedTarget) }
          : { type: "monitor", id: null };

        // Always use 60 FPS
        await invoke("start_recording", { filename, fps: "60", target });
        setIsRecording(true);
        setStatus("Recording");
      }
    } catch (error) {
      console.error(error);
      setStatus("Error");
      setIsRecording(false);
    }
  };

  const selectSource = (id: string, label: string) => {
    setSelectedTarget(id);
    setSelectedLabel(label);
    setShowSourceModal(false);
  };

  const openSourceModal = () => {
    refreshWindows();
    setShowSourceModal(true);
  };

  return (
    <div className="app-container">
      <div className="main-card">
        {/* Header */}
        <header className="app-header">
          <div className="status-indicator">
            <div className={`status-dot ${isRecording ? 'recording' : ''}`} />
            <span className="status-text">{status}</span>
          </div>
          <div className="header-actions">
            <button className="icon-btn" title="Open folder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button className="icon-btn" title="Settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </header>

        {/* Preview */}
        <section className="preview-section">
          <div className="preview-container">
            {livePreviewSrc ? (
              <img src={livePreviewSrc} className="preview-player" alt="Live Preview" />
            ) : (
              <div className="preview-placeholder">
                <div className="preview-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </div>
                <span className="preview-text">No Active Stream</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Bottom Dock */}
      <div className="bottom-dock">
        <div className="dock-container">
          <button className="source-selector" onClick={openSourceModal} disabled={isRecording}>
            <div>
              <div className="source-label">Ready</div>
              <div className="source-value">Select Source</div>
            </div>
          </button>
          <button
            className={`record-btn ${isRecording ? 'recording' : ''}`}
            onClick={toggleRecording}
          >
            <span className="record-dot" />
            {isRecording ? "Stop Recording" : "Start Recording"}
          </button>
        </div>
      </div>

      {/* Source Selection Modal */}
      {showSourceModal && (
        <div className="modal-overlay" onClick={() => setShowSourceModal(false)}>
          <div className="source-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Select Source</span>
              <button className="modal-close" onClick={() => setShowSourceModal(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="source-list">
                <button
                  className={`source-item ${selectedTarget === "monitor" ? 'selected' : ''}`}
                  onClick={() => selectSource("monitor", "Primary Monitor")}
                >
                  <div className="source-item-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </div>
                  <span className="source-item-text">Primary Monitor</span>
                </button>
                {windows.map((w) => (
                  <button
                    key={w.id}
                    className={`source-item ${selectedTarget === w.id.toString() ? 'selected' : ''}`}
                    onClick={() => selectSource(w.id.toString(), w.title)}
                  >
                    <div className="source-item-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <line x1="3" y1="9" x2="21" y2="9" />
                      </svg>
                    </div>
                    <span className="source-item-text">
                      {w.title.length > 35 ? w.title.substring(0, 35) + '...' : w.title}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
