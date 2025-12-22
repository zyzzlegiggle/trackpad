import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
// import { listen } from "@tauri-apps/api/event"; // Uncomment for preview feature
import "./App.css";

interface WindowInfo {
  id: number;
  title: string;
}

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [filename, setFilename] = useState("");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<string>("monitor");
  const [selectedLabel, setSelectedLabel] = useState("Full Screen");
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  // Preview state - uncomment to enable
  // const [livePreviewSrc, setLivePreviewSrc] = useState("");

  useEffect(() => {
    const date = new Date();
    const timestamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    setFilename(`C:/Users/josse/Videos/recording_${timestamp}.mp4`);
    refreshWindows();
  }, []);

  // Recording timer
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);
    } else {
      setRecordingTime(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  // Preview effect - uncomment to enable
  // useEffect(() => {
  //   let unlisten: (() => void) | undefined;
  //   async function setup() {
  //     await invoke("start_preview");
  //     unlisten = await listen<string>('preview-frame', (event) => {
  //       setLivePreviewSrc(`data:image/jpeg;base64,${event.payload}`);
  //     });
  //   }
  //   setup();
  //   return () => {
  //     if (unlisten) unlisten();
  //     invoke("stop_preview");
  //   };
  // }, []);

  const refreshWindows = async () => {
    try {
      const wins = await invoke<WindowInfo[]>("get_open_windows");
      setWindows(wins);
    } catch (e) {
      console.error("Failed to list windows", e);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const toggleRecording = async () => {
    try {
      if (isRecording) {
        setStatus("Saving...");
        await invoke("stop_recording");
        setIsRecording(false);
        setStatus("Saved!");
        setTimeout(() => setStatus("Ready"), 2000);
      } else {
        setStatus("Starting...");
        const target = selectedTarget !== "monitor"
          ? { type: "window", id: parseInt(selectedTarget) }
          : { type: "monitor", id: null };

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

  return (
    <div className="app-container">
      <div className="recorder-panel">
        {/* Recording Indicator */}
        <div className={`recording-ring ${isRecording ? "active" : ""}`}>
          <div className="ring-inner">
            {isRecording ? (
              <span className="time-display">{formatTime(recordingTime)}</span>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" className="rec-icon">
                <circle cx="12" cy="12" r="8" />
              </svg>
            )}
          </div>
        </div>

        {/* Status */}
        <div className="status-badge">
          <span className={`status-dot ${isRecording ? "recording" : ""}`} />
          <span className="status-label">{status}</span>
        </div>

        {/* Controls */}
        <div className="controls">
          <button
            className="source-btn"
            onClick={() => { refreshWindows(); setShowSourceModal(true); }}
            disabled={isRecording}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span>{selectedLabel.length > 12 ? selectedLabel.substring(0, 12) + "..." : selectedLabel}</span>
          </button>

          <button
            className={`record-btn ${isRecording ? "recording" : ""}`}
            onClick={toggleRecording}
          >
            <span className="btn-icon" />
            <span>{isRecording ? "Stop" : "Record"}</span>
          </button>

          <button className="settings-btn" disabled={isRecording}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
            <span>Settings</span>
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
                  className={`source-item ${selectedTarget === "monitor" ? "selected" : ""}`}
                  onClick={() => selectSource("monitor", "Full Screen")}
                >
                  <div className="source-item-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="3" width="20" height="14" rx="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </div>
                  <span className="source-item-text">Full Screen</span>
                </button>
                {windows.map((w) => (
                  <button
                    key={w.id}
                    className={`source-item ${selectedTarget === w.id.toString() ? "selected" : ""}`}
                    onClick={() => selectSource(w.id.toString(), w.title)}
                  >
                    <div className="source-item-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="3" y1="9" x2="21" y2="9" />
                      </svg>
                    </div>
                    <span className="source-item-text">
                      {w.title.length > 35 ? w.title.substring(0, 35) + "..." : w.title}
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
