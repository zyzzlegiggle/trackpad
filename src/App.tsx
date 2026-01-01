import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
// import { listen } from "@tauri-apps/api/event"; // Uncomment for preview feature
import VideoEditor from "./VideoEditor";

interface WindowInfo {
  id: number;
  title: string;
}

// Click event from backend
interface ClickEvent {
  timestamp_ms: number;
  x: number;
  y: number;
  is_double_click: boolean;
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
  const [editorMode, setEditorMode] = useState(false);
  const [lastRecordedFile, setLastRecordedFile] = useState("");
  const [recordedClicks, setRecordedClicks] = useState<ClickEvent[]>([]);

  // Preview state - uncomment to enable
  // const [livePreviewSrc, setLivePreviewSrc] = useState("");

  useEffect(() => {
    const initTempPath = async () => {
      try {
        const tempPath = await invoke<string>("get_temp_video_path");
        setFilename(tempPath);
      } catch (e) {
        console.error("Failed to get temp path", e);
        setStatus("Error: Could not get temp path");
      }
    };
    initTempPath();
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

        // Wait for FFmpeg to finish writing the file
        // stop_recording only signals the thread to stop, it doesn't wait for FFmpeg to complete
        await new Promise(resolve => setTimeout(resolve, 1500));

        setStatus("Saved!");

        // Fetch recorded click events
        try {
          const clicks = await invoke<ClickEvent[]>("get_recorded_clicks");
          console.log("Recorded clicks:", clicks);
          setRecordedClicks(clicks);
        } catch (e) {
          console.error("Failed to get recorded clicks:", e);
          setRecordedClicks([]);
        }

        // Open editor with the recorded file
        setLastRecordedFile(filename);
        setEditorMode(true);
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

  const handleEditorClose = async () => {
    setEditorMode(false);
    setStatus("Ready");
    // Generate new temp path for next recording
    try {
      const tempPath = await invoke<string>("get_temp_video_path");
      setFilename(tempPath);
    } catch (e) {
      console.error("Failed to get temp path", e);
      setStatus("Error: Could not get temp path");
    }
  };

  // Show editor if in editor mode
  if (editorMode && lastRecordedFile) {
    return <VideoEditor videoPath={lastRecordedFile} onClose={handleEditorClose} clickEvents={recordedClicks} />;
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen w-screen p-6">
      <div className="bg-white rounded-3xl shadow-lg p-10 flex flex-col items-center gap-7 border border-black/8">
        {/* Recording Indicator */}
        <div className={`w-36 h-36 rounded-full border-3 flex items-center justify-center transition-all duration-300 ${isRecording
            ? "border-accent-red shadow-[0_0_0_8px_rgba(239,68,68,0.2)] animate-[ring-pulse_2s_ease-in-out_infinite]"
            : "border-black/8"
          }`}>
          <div className={`w-24 h-24 rounded-full flex items-center justify-center ${isRecording ? "bg-red-500/10" : "bg-gray-100"
            }`}>
            {isRecording ? (
              <span className="text-3xl font-bold font-mono text-accent-red tracking-wider">
                {formatTime(recordingTime)}
              </span>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 text-gray-400">
                <circle cx="12" cy="12" r="8" />
              </svg>
            )}
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-full">
          <span className={`w-2 h-2 rounded-full ${isRecording ? "bg-accent-red animate-[dot-pulse_1s_ease-in-out_infinite]" : "bg-gray-400"
            }`} />
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-600">{status}</span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          <button
            className="flex flex-col items-center gap-1.5 px-5 py-3 bg-transparent border border-black/8 rounded-xl cursor-pointer text-gray-600 transition-all duration-200 hover:bg-gray-100 hover:border-gray-400 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => { refreshWindows(); setShowSourceModal(true); }}
            disabled={isRecording}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span className="text-xs font-medium uppercase tracking-tight">
              {selectedLabel.length > 12 ? selectedLabel.substring(0, 12) + "..." : selectedLabel}
            </span>
          </button>

          <button
            className={`flex flex-col items-center gap-1.5 px-8 py-4 border-none rounded-xl cursor-pointer transition-all duration-200 ${isRecording
                ? "bg-gray-800 border border-accent-red text-white hover:bg-gray-700"
                : "bg-accent-red text-white hover:bg-red-500 hover:scale-102 active:scale-98"
              }`}
            onClick={toggleRecording}
          >
            <span className={`${isRecording ? "w-3.5 h-3.5 bg-accent-red rounded-sm" : "w-4 h-4 bg-white rounded-full"}`} />
            <span className="text-xs font-semibold uppercase tracking-tight">{isRecording ? "Stop" : "Record"}</span>
          </button>

          <button
            className="flex flex-col items-center gap-1.5 px-5 py-3 bg-transparent border border-black/8 rounded-xl cursor-pointer text-gray-600 transition-all duration-200 hover:bg-gray-100 hover:border-gray-400 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={isRecording}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
            <span className="text-xs font-medium uppercase tracking-tight">Settings</span>
          </button>
        </div>
      </div>

      {/* Source Selection Modal */}
      {showSourceModal && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-[fade-in_0.2s_ease]"
          onClick={() => setShowSourceModal(false)}
        >
          <div
            className="bg-white border border-black/8 rounded-3xl shadow-lg w-[90%] max-w-sm max-h-[70vh] overflow-hidden animate-[slide-up_0.3s_ease]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-black/8 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-900">Select Source</span>
              <button
                className="w-8 h-8 border-none bg-transparent rounded-lg cursor-pointer flex items-center justify-center text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                onClick={() => setShowSourceModal(false)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="p-3 max-h-72 overflow-y-auto">
              <div className="flex flex-col gap-1">
                <button
                  className={`flex items-center gap-3 px-3.5 py-3 border rounded-lg cursor-pointer text-left transition-all duration-200 w-full ${selectedTarget === "monitor"
                      ? "bg-blue-500/10 border-accent-blue"
                      : "bg-transparent border-transparent hover:bg-gray-100"
                    }`}
                  onClick={() => selectSource("monitor", "Full Screen")}
                >
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${selectedTarget === "monitor" ? "bg-blue-500/15 text-accent-blue" : "bg-gray-100 text-gray-600"
                    }`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                      <rect x="2" y="3" width="20" height="14" rx="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </div>
                  <span className="flex-1 text-sm font-medium text-gray-900 whitespace-nowrap overflow-hidden text-ellipsis">Full Screen</span>
                </button>
                {windows.map((w) => (
                  <button
                    key={w.id}
                    className={`flex items-center gap-3 px-3.5 py-3 border rounded-lg cursor-pointer text-left transition-all duration-200 w-full ${selectedTarget === w.id.toString()
                        ? "bg-blue-500/10 border-accent-blue"
                        : "bg-transparent border-transparent hover:bg-gray-100"
                      }`}
                    onClick={() => selectSource(w.id.toString(), w.title)}
                  >
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${selectedTarget === w.id.toString() ? "bg-blue-500/15 text-accent-blue" : "bg-gray-100 text-gray-600"
                      }`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4.5 h-4.5">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="3" y1="9" x2="21" y2="9" />
                      </svg>
                    </div>
                    <span className="flex-1 text-sm font-medium text-gray-900 whitespace-nowrap overflow-hidden text-ellipsis">
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
