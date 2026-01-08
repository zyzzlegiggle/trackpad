import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
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

// Cursor position from backend
interface CursorPosition {
  timestamp_ms: number;
  x: number;
  y: number;
}

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [filename, setFilename] = useState("");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<string>("");
  const [selectedLabel, setSelectedLabel] = useState("Select App");
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [editorMode, setEditorMode] = useState(false);
  const [lastRecordedFile, setLastRecordedFile] = useState("");
  const [recordedClicks, setRecordedClicks] = useState<ClickEvent[]>([]);
  const [cursorPositions, setCursorPositions] = useState<CursorPosition[]>([]);

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

        // Fetch recorded cursor positions
        try {
          const positions = await invoke<CursorPosition[]>("get_cursor_positions");
          console.log("Recorded cursor positions:", positions.length);
          setCursorPositions(positions);
        } catch (e) {
          console.error("Failed to get cursor positions:", e);
          setCursorPositions([]);
        }

        // Open editor with the recorded file
        setLastRecordedFile(filename);
        setEditorMode(true);
      } else {
        if (!selectedTarget) {
          setStatus("Please select an app first");
          return;
        }
        setStatus("Starting...");
        const target = { type: "window", id: parseInt(selectedTarget) };

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
    // Restore compact bar window to original floating bar state
    const win = getCurrentWindow();
    try {
      await win.unmaximize();
      await win.setDecorations(false);  // Remove title bar
      await win.setShadow(false);       // Remove shadow/border
      await win.setResizable(false);    // Disable resize
      await win.setSize(new LogicalSize(420, 400));
      await win.center();
    } catch (e) {
      console.error("Failed to restore window:", e);
    }

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

  // Resize window for editor mode
  useEffect(() => {
    const setupWindowForEditor = async () => {
      if (editorMode) {
        console.log("Setting up window for editor mode...");
        const win = getCurrentWindow();
        try {
          // First, enable resizing so user can adjust
          await win.setResizable(true);
          console.log("Resizable: true");

          // Set a reasonable size before maximizing (fallback if maximize fails)
          await win.setSize(new LogicalSize(1200, 800));
          console.log("Size set to 1200x800");

          // Enable window shadow
          await win.setShadow(true);
          console.log("Shadow: true");

          // Enable decorations (title bar with close/minimize/maximize)
          await win.setDecorations(true);
          console.log("Decorations: true");

          // Center the window
          await win.center();
          console.log("Window centered");

          // Finally, maximize
          await win.maximize();
          console.log("Window maximized");
        } catch (e) {
          console.error("Failed to setup editor window:", e);
        }
      }
    };
    setupWindowForEditor();
  }, [editorMode]);

  // Show editor if in editor mode
  if (editorMode && lastRecordedFile) {
    return <VideoEditor videoPath={lastRecordedFile} onClose={handleEditorClose} clickEvents={recordedClicks} cursorPositions={cursorPositions} />;
  }

  // Handle dropdown toggle
  const handleToggleDropdown = async () => {
    if (!showSourceModal) {
      console.log("Opening dropdown...");
      await refreshWindows();
    }
    setShowSourceModal(!showSourceModal);
  };

  // Handle source selection
  const handleSelectSource = (id: string, title: string) => {
    selectSource(id, title);
    setShowSourceModal(false);
  };

  // Handle close - try close, then destroy as fallback
  const handleClose = async () => {
    console.log("Closing window...");
    const win = getCurrentWindow();
    try {
      // Try normal close first
      await win.close();
    } catch (e) {
      console.error("close() failed, trying destroy():", e);
      try {
        // Fallback: force destroy the window
        await win.destroy();
      } catch (e2) {
        console.error("destroy() also failed:", e2);
      }
    }
  };

  return (
    <div
      className="w-full h-full p-2 flex flex-col justify-end"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Container for bar and dropdown - uses relative positioning */}
      <div className="relative w-full">
        {/* Main Bar - always at bottom */}
        <div
          className="w-full h-14 bg-white rounded-2xl shadow-lg border border-black/10 flex items-center gap-2 px-3"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {/* Grip dots */}
          <div className="flex flex-col gap-0.5 px-1 opacity-40">
            <div className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-gray-400"></span>
              <span className="w-1 h-1 rounded-full bg-gray-400"></span>
            </div>
            <div className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-gray-400"></span>
              <span className="w-1 h-1 rounded-full bg-gray-400"></span>
            </div>
            <div className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-gray-400"></span>
              <span className="w-1 h-1 rounded-full bg-gray-400"></span>
            </div>
          </div>

          {/* Divider */}
          <div className="h-7 w-px bg-gray-200"></div>

          {/* Source Selector - with dropdown */}
          <div className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleToggleDropdown(); }}
              disabled={isRecording}
              className="flex items-center gap-2 px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-700 text-xs font-medium border-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-gray-500">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span className="max-w-20 truncate">{selectedLabel}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`w-3 h-3 text-gray-400 transition-transform ${showSourceModal ? 'rotate-180' : ''}`}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {/* Dropdown Panel - compact, positioned above button */}
            {showSourceModal && (
              <div className="absolute bottom-full left-0 mb-2 w-56 bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden">
                <div className="px-2.5 py-1.5 border-b border-gray-100 flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Select Source</span>
                  <button
                    type="button"
                    onClick={() => setShowSourceModal(false)}
                    className="w-4 h-4 border-none bg-transparent rounded cursor-pointer flex items-center justify-center text-gray-400 hover:text-gray-600"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-2.5 h-2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <div className="p-1 max-h-40 overflow-y-auto">
                  {windows.length === 0 ? (
                    <div className="px-2 py-2.5 text-center text-gray-400 text-xs">
                      No windows found.
                    </div>
                  ) : (
                    <div className="flex flex-col">
                      {windows.map((w) => (
                        <button
                          type="button"
                          key={w.id}
                          onClick={() => handleSelectSource(w.id.toString(), w.title)}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-left w-full border-none transition-colors ${selectedTarget === w.id.toString()
                            ? "bg-blue-50 text-blue-700"
                            : "bg-transparent hover:bg-gray-50 text-gray-700"
                            }`}
                        >
                          <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ${selectedTarget === w.id.toString() ? "bg-blue-100 text-blue-600" : "bg-gray-100 text-gray-500"}`}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-2 h-2">
                              <rect x="3" y="3" width="18" height="18" rx="2" />
                            </svg>
                          </div>
                          <span className="flex-1 text-[11px] font-medium truncate">
                            {w.title}
                          </span>
                          {selectedTarget === w.id.toString() && (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="w-2.5 h-2.5 text-blue-500">
                              <path d="M5 12l5 5L20 7" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Recording Time */}
          {isRecording && (
            <div className="flex items-center gap-2 px-2.5 py-1 bg-red-50 rounded-lg border border-red-200">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
              <span className="text-sm font-mono font-semibold text-red-600">
                {formatTime(recordingTime)}
              </span>
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1"></div>

          {/* Record/Stop Button */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleRecording(); }}
            title={isRecording ? "Stop Recording" : "Start Recording"}
            className={`flex items-center justify-center w-9 h-9 rounded-xl border-none cursor-pointer transition-all duration-200 ${isRecording
              ? "bg-gray-200 hover:bg-gray-300"
              : "bg-red-500 hover:bg-red-400 hover:scale-105 active:scale-95"
              }`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {isRecording ? (
              <span className="w-3 h-3 bg-red-500 rounded-sm"></span>
            ) : (
              <span className="w-3.5 h-3.5 bg-white rounded-full"></span>
            )}
          </button>

          {/* Divider */}
          <div className="h-7 w-px bg-gray-200"></div>

          {/* Settings */}
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            disabled={isRecording}
            title="Settings"
            className="flex items-center justify-center w-7 h-7 bg-transparent hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600 border-none cursor-pointer disabled:opacity-40"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          </button>

          {/* Close */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleClose(); }}
            title="Close"
            className="flex items-center justify-center w-7 h-7 bg-transparent hover:bg-red-50 rounded-lg text-gray-400 hover:text-red-500 border-none cursor-pointer"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
