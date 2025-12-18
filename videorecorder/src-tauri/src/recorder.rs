use std::process::{Command, Stdio};
use std::io::Write;
use std::sync::{Arc, Mutex, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
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
};
use image::{ImageBuffer, Rgba, imageops, GenericImageView};

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

struct CaptureFlags {
    filename: String,
    stop_signal: Arc<AtomicBool>,
    width: u32,
    height: u32,
    fps: String,
}

struct ZoomState {
    active: bool,
    cursor_x: f64,
    cursor_y: f64,
}

struct CaptureHandler {
    sender: mpsc::Sender<Vec<u8>>,
    stop_signal: Arc<AtomicBool>,
}

#[derive(serde::Serialize)]
pub struct WindowInfo {
    id: u32,
    title: String,
}

#[derive(serde::Deserialize)]
pub struct RecordTarget {
    #[serde(rename = "type")]
    pub target_type: String, 
    pub id: Option<u32>,
}

#[tauri::command]
pub fn get_open_windows() -> Vec<WindowInfo> {
    // Stubbed for now as you are capturing the primary monitor
    Vec::new()
}

#[tauri::command]
pub fn start_recording(
    state: State<'_, RecorderState>, 
    filename: String, 
    fps: String, 
    _target: Option<RecordTarget>
) -> Result<(), String> {
    // Check if already recording
    if state.is_recording.load(Ordering::Relaxed) {
        return Err("Already recording".to_string());
    }
    
    // Set recording flag to true
    state.is_recording.store(true, Ordering::Relaxed);
    let signal = state.is_recording.clone();
    
    // Spawn the capture thread
    thread::spawn(move || {
        let primary_monitor = Monitor::primary().expect("No primary monitor found");
        
        // Get dimensions or fallback to common 1080p if detection fails
        let width = primary_monitor.width().unwrap_or(1920);
        let height = primary_monitor.height().unwrap_or(1080);
            
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

        // Start the capture loop (this blocks until capture_control.stop() is called)
        match CaptureHandler::start(settings) {
            Ok(_) => println!("Recording finished successfully"),
            Err(e) => {
                eprintln!("Recording error: {:?}", e);
                signal.store(false, Ordering::Relaxed);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_recording(state: State<'_, RecorderState>) -> Result<(), String> {
    if !state.is_recording.load(Ordering::Relaxed) {
        return Err("Not recording".to_string());
    }
    // Setting this to false triggers the stop logic in on_frame_arrived
    state.is_recording.store(false, Ordering::Relaxed);
    Ok(())
}


impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        
        let stop_signal_worker = flags.stop_signal.clone();
        let width = flags.width;
        let height = flags.height;
        let fps = flags.fps.clone();
        let filename = flags.filename.clone();

        let zoom_state = Arc::new(Mutex::new(ZoomState {
            active: false,
            cursor_x: 0.0,
            cursor_y: 0.0,
        }));

        let zoom_clone = zoom_state.clone();
        
        // 1. INPUT LISTENER THREAD
        thread::spawn(move || {
            let _ = rdev::listen(move |event| {
                if let Ok(mut state) = zoom_clone.lock() {
                    match event.event_type {
                        rdev::EventType::MouseMove { x, y } => {
                            state.cursor_x = x;
                            state.cursor_y = y;
                        }
                        rdev::EventType::ButtonPress(rdev::Button::Left) => {
                            // Simplified toggle for testing; add double-click logic back later
                            state.active = !state.active;
                        }
                        _ => {}
                    }
                }
            });
        });

        // 2. WORKER THREAD (Image Processing & FFmpeg)
        thread::spawn(move || {
            let mut child = Command::new("ffmpeg")
                .args(&[
                    "-f", "rawvideo",
                    "-pixel_format", "bgra",
                    "-video_size", &format!("{}x{}", width, height),
                    "-framerate", &fps,
                    "-i", "-",
                    "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", // Standard compatibility
                    "-preset", "ultrafast",
                    "-tune", "zerolatency",
                    "-y", &filename
                ])
                .stdin(Stdio::piped())
                .spawn()
                .expect("Failed to start ffmpeg");

            let mut stdin = child.stdin.take().expect("Failed to open stdin");

            while let Ok(raw_data) = rx.recv() {
                if !stop_signal_worker.load(Ordering::Relaxed) { break; }

                let zoom = {
                    let s = zoom_state.lock().unwrap();
                    (s.active, s.cursor_x, s.cursor_y)
                };

                if zoom.0 {
                    // Zoom Logic (Heavy)
                    let img: ImageBuffer<Rgba<u8>, _> = ImageBuffer::from_raw(width, height, raw_data).unwrap();
                    let view_w = width / 2;
                    let view_h = height / 2;
                    let x = (zoom.1 as u32).saturating_sub(view_w / 2).min(width - view_w);
                    let y = (zoom.2 as u32).saturating_sub(view_h / 2).min(height - view_h);
                    
                    let cropped = img.view(x, y, view_w, view_h).to_image();
                    let resized = imageops::resize(&cropped, width, height, imageops::FilterType::Triangle);
                    let _ = stdin.write_all(&resized);
                } else {
                    // Fast path
                    let _ = stdin.write_all(&raw_data);
                }
            }
            drop(stdin);
            let _ = child.wait();
        });

        Ok(Self {
            sender: tx,
            stop_signal: flags.stop_signal,
        })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, capture_control: InternalCaptureControl) -> Result<(), Self::Error> {
        if !self.stop_signal.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }

        // Send raw buffer to worker immediately to keep capture loop fast
        let mut buffer = frame.buffer()?;
        let data = buffer.as_raw_buffer().to_vec();
        let _ = self.sender.send(data);

        Ok(())
    }

    
}