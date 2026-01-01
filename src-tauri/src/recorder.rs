use std::process::{Command, Stdio};
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Instant;
use tauri::State;

use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    settings::{
        ColorFormat, CursorCaptureSettings, DrawBorderSettings, Settings,
        SecondaryWindowSettings, MinimumUpdateIntervalSettings, DirtyRegionSettings
    },
    monitor::Monitor,
    window::Window,
};

// Click event captured during recording
#[derive(serde::Serialize, Clone, Debug)]
pub struct ClickEvent {
    pub timestamp_ms: u64,      // Time since recording start
    pub x: f64,                 // Normalized X (0.0 - 1.0)
    pub y: f64,                 // Normalized Y (0.0 - 1.0)
    pub is_double_click: bool,  // True if this was a double-click
}

// Global storage for click events during recording
lazy_static::lazy_static! {
    static ref CLICK_EVENTS: Mutex<Vec<ClickEvent>> = Mutex::new(Vec::new());
    static ref RECORDING_START_TIME: Mutex<Option<Instant>> = Mutex::new(None);
    static ref LAST_CLICK: Mutex<Option<(Instant, f64, f64)>> = Mutex::new(None);
    static ref SCREEN_SIZE: Mutex<(u32, u32)> = Mutex::new((1920, 1080));
}

pub struct RecorderState {
    pub is_recording: Arc<AtomicBool>,
}

impl RecorderState {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
        }
    }
}

// Data passed to the capture thread
struct CaptureFlags {
    filename: String,
    stop_signal: Arc<AtomicBool>,
    width: u32,
    height: u32,
    fps: String,
}

// Capture Handler with constant framerate output
struct CaptureHandler {
    ffmpeg_process: std::process::Child,
    stop_signal: Arc<AtomicBool>,
    recording_start: Option<Instant>,
    frames_written: u64,
    target_fps: f64,
    last_frame: Vec<u8>,
    frame_width: u32,
    frame_height: u32,
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        let fps_value: f64 = flags.fps.parse().unwrap_or(30.0);
        println!("Starting recording to: {} at {} FPS", flags.filename, fps_value);
       
        let width = if flags.width % 2 != 0 { flags.width - 1 } else { flags.width };
        let height = if flags.height % 2 != 0 { flags.height - 1 } else { flags.height };

        let child = Command::new("ffmpeg")
            .args(&[
                "-f", "rawvideo",
                "-pixel_format", "bgra",
                "-video_size", &format!("{}x{}", width, height),
                "-framerate", &flags.fps,
                "-i", "-",
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-preset", "ultrafast",
                "-r", &flags.fps,
                "-y",
                &flags.filename
            ])
            .stdin(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        Ok(Self {
            ffmpeg_process: child,
            stop_signal: flags.stop_signal,
            recording_start: None,
            frames_written: 0,
            target_fps: fps_value,
            last_frame: Vec::new(),
            frame_width: width,
            frame_height: height,
        })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, capture_control: InternalCaptureControl) -> Result<(), Self::Error> {
        if !self.stop_signal.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }

        let width = frame.width();
        let height = frame.height();
        let mut buffer_obj = frame.buffer()?;
        let src_data = buffer_obj.as_raw_buffer();

        let row_pitch = src_data.len() / height as usize;
        let tight_pitch = (width * 4) as usize;
        let frame_size = (self.frame_width * self.frame_height * 4) as usize;

        if self.last_frame.len() != frame_size {
            self.last_frame = vec![0u8; frame_size];
        }
        
        if row_pitch == tight_pitch && width == self.frame_width && height == self.frame_height {
            self.last_frame.copy_from_slice(&src_data[..frame_size]);
        } else {
            for i in 0..self.frame_height as usize {
                let src_start = i * row_pitch;
                let dst_start = i * (self.frame_width * 4) as usize;
                let copy_len = (self.frame_width * 4) as usize;
                if src_start + copy_len <= src_data.len() {
                    self.last_frame[dst_start..dst_start + copy_len]
                        .copy_from_slice(&src_data[src_start..src_start + copy_len]);
                }
            }
        }

        let now = Instant::now();
        if self.recording_start.is_none() {
            self.recording_start = Some(now);
        }

        let elapsed = now.duration_since(self.recording_start.unwrap());
        let expected_frames = (elapsed.as_secs_f64() * self.target_fps).ceil() as u64;

        if let Some(stdin) = self.ffmpeg_process.stdin.as_mut() {
            while self.frames_written < expected_frames {
                stdin.write_all(&self.last_frame)?;
                self.frames_written += 1;
            }
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        println!("Capture closed. Cleaning up ffmpeg.");
        if let Some(stdin) = self.ffmpeg_process.stdin.take() {
            drop(stdin);
        }
        self.ffmpeg_process.wait()?;
        println!("FFmpeg finished.");
        Ok(())
    }
}

// Window Info for frontend
#[derive(serde::Serialize, Clone)]
pub struct WindowInfo {
    pub id: isize,  // HWND as isize
    pub title: String,
}

#[tauri::command]
pub fn get_open_windows() -> Vec<WindowInfo> {
    let mut result = Vec::new();
    
    if let Ok(windows) = Window::enumerate() {
        for window in windows {
            // Only include valid windows with non-empty titles
            if window.is_valid() {
                if let Ok(title) = window.title() {
                    if !title.is_empty() {
                        // Get raw HWND as isize for serialization
                        let hwnd_ptr = window.as_raw_hwnd();
                        result.push(WindowInfo {
                            id: hwnd_ptr as isize,
                            title,
                        });
                    }
                }
            }
        }
    }
    
    result
}

// Spawn a mouse listener thread that captures clicks during recording
fn spawn_mouse_listener(stop_signal: Arc<AtomicBool>) {
    use rdev::{listen, Event, EventType, Button};
    
    thread::spawn(move || {
        let callback = move |event: Event| {
            // Only process while recording
            if !stop_signal.load(Ordering::Relaxed) {
                return;
            }
            
            if let EventType::ButtonPress(Button::Left) = event.event_type {
                let now = Instant::now();
                
                // Get screen size for normalization
                let (screen_w, screen_h) = *SCREEN_SIZE.lock().unwrap();
                
                // Get mouse position (rdev provides screen coordinates)
                let (x, y) = match (event.name, event.time) {
                    _ => {
                        // rdev doesn't give position in ButtonPress, we need to track it
                        // Use MouseMove events to track position
                        (0.0, 0.0)
                    }
                };
                
                // We'll track position from MouseMove events
                // For now, we'll capture the click without position
                // and update this logic
            }
        };
        
        // This blocks, so it runs in its own thread
        if let Err(e) = listen(callback) {
            eprintln!("Mouse listener error: {:?}", e);
        }
    });
}

// Better mouse listener that tracks position
fn spawn_mouse_listener_v2(stop_signal: Arc<AtomicBool>) {
    use rdev::{listen, Event, EventType, Button};
    
    thread::spawn(move || {
        let mut last_mouse_x: f64 = 0.0;
        let mut last_mouse_y: f64 = 0.0;
        
        let callback = move |event: Event| {
            // Track mouse position from move events
            if let EventType::MouseMove { x, y } = event.event_type {
                last_mouse_x = x;
                last_mouse_y = y;
                return;
            }
            
            // Only process clicks while recording
            if !stop_signal.load(Ordering::Relaxed) {
                return;
            }
            
            if let EventType::ButtonPress(Button::Left) = event.event_type {
                let now = Instant::now();
                
                // Get screen size for normalization
                let (screen_w, screen_h) = *SCREEN_SIZE.lock().unwrap();
                let norm_x = last_mouse_x / screen_w as f64;
                let norm_y = last_mouse_y / screen_h as f64;
                
                // Get timestamp since recording start
                let timestamp_ms = {
                    if let Some(start) = *RECORDING_START_TIME.lock().unwrap() {
                        now.duration_since(start).as_millis() as u64
                    } else {
                        0
                    }
                };
                
                // Check for double-click (within 500ms and close position)
                let is_double_click = {
                    let mut last_click = LAST_CLICK.lock().unwrap();
                    let is_double = if let Some((last_time, last_x, last_y)) = *last_click {
                        let time_diff = now.duration_since(last_time).as_millis();
                        let dist = ((norm_x - last_x).powi(2) + (norm_y - last_y).powi(2)).sqrt();
                        time_diff < 500 && dist < 0.05
                    } else {
                        false
                    };
                    *last_click = Some((now, norm_x, norm_y));
                    is_double
                };
                
                // Only store double-clicks (that's what triggers zoom)
                if is_double_click {
                    let click_event = ClickEvent {
                        timestamp_ms,
                        x: norm_x,
                        y: norm_y,
                        is_double_click: true,
                    };
                    println!("Double-click captured at {:.2}, {:.2} @ {}ms", norm_x, norm_y, timestamp_ms);
                    CLICK_EVENTS.lock().unwrap().push(click_event);
                }
            }
        };
        
        // This blocks until an error or the process ends
        if let Err(e) = listen(callback) {
            eprintln!("Mouse listener error: {:?}", e);
        }
    });
}

#[derive(serde::Deserialize, Debug)]
pub struct RecordTarget {
    #[serde(rename = "type")]
    pub target_type: String,
    pub id: Option<i64>,  // HWND as i64 for JSON compatibility
}

#[tauri::command]
pub fn start_recording(state: State<'_, RecorderState>, filename: String, fps: String, target: Option<RecordTarget>) -> Result<(), String> {
    if state.is_recording.load(Ordering::Relaxed) {
        return Err("Already recording".to_string());
    }
   
    // Clear previous click events and initialize tracking
    CLICK_EVENTS.lock().unwrap().clear();
    *LAST_CLICK.lock().unwrap() = None;
    *RECORDING_START_TIME.lock().unwrap() = Some(Instant::now());
    
    // Get screen size for coordinate normalization
    let primary_monitor = Monitor::primary().expect("No primary monitor");
    let screen_w = primary_monitor.width().unwrap_or(1920);
    let screen_h = primary_monitor.height().unwrap_or(1080);
    *SCREEN_SIZE.lock().unwrap() = (screen_w, screen_h);
    
    state.is_recording.store(true, Ordering::Relaxed);
    let signal = state.is_recording.clone();
    
    // Spawn mouse listener in background
    spawn_mouse_listener_v2(signal.clone());
   
    thread::spawn(move || {
        // Determine capture source based on target
        let capture_result = match &target {
            Some(t) if t.target_type == "window" && t.id.is_some() => {
                // Window capture
                let hwnd = t.id.unwrap() as isize as *mut std::ffi::c_void;
                let window = Window::from_raw_hwnd(hwnd);
                
                println!("Capturing window: {:?}", window.title());
                
                // Get window dimensions
                let rect = window.rect().map_err(|e| format!("Failed to get window rect: {:?}", e))?;
                let width = (rect.right - rect.left) as u32;
                let height = (rect.bottom - rect.top) as u32;
                
                let flags = CaptureFlags {
                    filename,
                    stop_signal: signal.clone(),
                    width,
                    height,
                    fps,
                };

                let settings = Settings::new(
                    window,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::Default,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );

                CaptureHandler::start(settings)
            }
            _ => {
                // Monitor capture (default)
                let primary_monitor = Monitor::primary().expect("No primary monitor");
                let width = primary_monitor.width().expect("Failed to get monitor width");
                let height = primary_monitor.height().expect("Failed to get monitor height");
                
                println!("Capturing primary monitor: {}x{}", width, height);
                   
                let flags = CaptureFlags {
                    filename,
                    stop_signal: signal.clone(),
                    width,
                    height,
                    fps,
                };

                let settings = Settings::new(
                    primary_monitor,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::Default,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );

                CaptureHandler::start(settings)
            }
        };

        match capture_result {
            Ok(_) => println!("Recording finished successfully"),
            Err(e) => eprintln!("Recording error: {:?}", e),
        }

        signal.store(false, Ordering::Relaxed);
        Ok::<(), String>(())
    });

    Ok(())
}

#[tauri::command]
pub fn stop_recording(state: State<'_, RecorderState>) -> Result<(), String> {
    if !state.is_recording.load(Ordering::Relaxed) {
        return Err("Not recording".to_string());
    }
    state.is_recording.store(false, Ordering::Relaxed);
    *RECORDING_START_TIME.lock().unwrap() = None;
    Ok(())
}

// Get recorded click events (call after stopping recording)
#[tauri::command]
pub fn get_recorded_clicks() -> Vec<ClickEvent> {
    let events = CLICK_EVENTS.lock().unwrap();
    events.clone()
}