import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [filename, setFilename] = useState("");
  const [resolution, setResolution] = useState("");

  useEffect(() => {
    // Generate default filename
    const date = new Date();
    const timestamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    setFilename(`C:/Users/josse/Videos/recording_${timestamp}.mp4`);
  }, []);

  const toggleRecording = async () => {
    try {
      if (isRecording) {
        setStatus("Stopping...");
        await invoke("stop_recording");
        setIsRecording(false);
        setStatus(`Saved to ${filename}`);
      } else {
        setStatus("Starting...");
        // Ensure directory exists or let ffmpeg handle it (ffmpeg creates file but not dir)
        // For MVP we assume dir exists.
        await invoke("start_recording", { filename });
        setIsRecording(true);
        setStatus("Recording...");
      }
    } catch (error) {
      console.error(error);
      setStatus(`Error: ${error}`);
      setIsRecording(false);
    }
  };

  return (
    <main className="container">
      <h1 className="title">Cursorful Clone</h1>

      <div className="status-display">
        {status}
      </div>

      <div className="controls">
        <button
          className={`record-btn ${isRecording ? "recording" : ""}`}
          onClick={toggleRecording}
        >
          {isRecording ? "STOP" : "REC"}
        </button>
      </div>

      <div className="settings">
        <label>Output File:</label>
        <input
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          disabled={isRecording}
        />
      </div>
    </main>
  );
}

export default App;
