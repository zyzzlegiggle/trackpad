import { useState, useEffect } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [filename, setFilename] = useState("");

  // ... imports

  interface WindowInfo {
    id: number;
    title: string;
  }

  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<string>("monitor"); // "monitor" or window ID as string

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

  const [showOverlay, setShowOverlay] = useState(false);
  const [fps, setFps] = useState("60");
  const [previewSrc, setPreviewSrc] = useState("");

  const toggleOverlay = async (show: boolean) => {
    setShowOverlay(show);
    await invoke("toggle_overlay", { show });
  };

  const toggleRecording = async () => {
    try {
      if (isRecording) {
        setStatus("Stopping...");
        await invoke("stop_recording");
        setIsRecording(false);
        setStatus("Saved!");
        // Update preview
        setPreviewSrc(convertFileSrc(filename));


      } else {
        setStatus("Starting...");

        // Prepare target
        let target = null;
        if (selectedTarget !== "monitor") {
          target = {
            type: "window",
            id: parseInt(selectedTarget)
          };
        } else {
          target = { type: "monitor", id: null };
        }

        await invoke("start_recording", { filename, fps, target });
        setIsRecording(true);
        setStatus("Recording...");
        setPreviewSrc(""); // Clear preview
      }
    } catch (error) {
      console.error(error);
      setStatus(`Error: ${error}`);
      setIsRecording(false);
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <span className="brand">RECORDER</span>
        <span className="app-status">{status}</span>
      </header>

      <section className="preview-section">
        <div className="preview-container">
          {previewSrc ? (
            <video src={previewSrc} controls className="preview-player" />
          ) : (
            <div className="preview-placeholder">
              <div className="placeholder-content">
                <span className="icon">📺</span>
                <span>No Preview Available</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <footer className="control-dock">
        <div className="dock-column source-panel">
          <h4>SOURCES</h4>
          <div className="control-group">
            <label>Capture Target</label>
            <div className="input-row">
              <select
                value={selectedTarget}
                onChange={(e) => setSelectedTarget(e.target.value)}
                disabled={isRecording}
              >
                <option value="monitor">Primary Monitor</option>
                {windows.map(w => (
                  <option key={w.id} value={w.id.toString()}>
                    {w.title.length > 20 ? w.title.substring(0, 20) + '...' : w.title}
                  </option>
                ))}
              </select>
              <button className="icon-btn" onClick={refreshWindows} disabled={isRecording} title="Refresh Windows">↻</button>
            </div>
          </div>
        </div>

        <div className="dock-column action-panel">
          <button
            className={`main-record-btn ${isRecording ? "recording" : ""}`}
            onClick={toggleRecording}
          >
            {isRecording ? "STOP RECORDING" : "START RECORDING"}
          </button>
        </div>

        <div className="dock-column settings-panel">
          <h4>SETTINGS</h4>
          <div className="control-group">
            <label>Output Filename</label>
            <input
              className="text-input"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              disabled={isRecording}
              placeholder="C:/Videos/output.mp4"
            />
          </div>
          <div className="control-group row">
            <div className="half">
              <label>FPS</label>
              <select value={fps} onChange={(e) => setFps(e.target.value)} disabled={isRecording}>
                <option value="30">30</option>
                <option value="60">60</option>
              </select>
            </div>
            <div className="half checkbox-container">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showOverlay}
                  onChange={(e) => toggleOverlay(e.target.checked)}
                />
                Effects
              </label>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
