use std::process::{Command, Stdio};
use std::io::Write;
use std::sync::{Arc, Mutex};
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
}

struct CaptureHandler {
    ffmpeg_process: std::process::Child,
    stop_signal: Arc<AtomicBool>,
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        println!("Starting recording to: {}", flags.filename);
        let width = flags.width;
        let height = flags.height;

        // Align width/height to even numbers for x264
        let width = if width % 2 != 0 { width - 1 } else { width };
        let height = if height % 2 != 0 { height - 1 } else { height };

        let child = Command::new("ffmpeg")
            .args(&[
                "-f", "rawvideo",
                "-pixel_format", "bgra",
                "-video_size", &format!("{}x{}", width, height),
                "-framerate", "60",
                "-i", "-", 
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-y",
                &flags.filename
            ])
            .stdin(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        Ok(Self {
            ffmpeg_process: child,
            stop_signal: flags.stop_signal,
        })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, capture_control: InternalCaptureControl) -> Result<(), Self::Error> {
        if !self.stop_signal.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }

        let mut buffer = frame.buffer()?;
        // buffer is FrameBuffer. Using as_raw_buffer() based on docs.
        let raw_slice = buffer.as_raw_buffer();
        
        if let Some(stdin) = self.ffmpeg_process.stdin.as_mut() {
            stdin.write_all(raw_slice)?;
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

#[tauri::command]
pub fn start_recording(state: State<'_, RecorderState>, filename: String) -> Result<(), String> {
    if state.is_recording.load(Ordering::Relaxed) {
        return Err("Already recording".to_string());
    }
    
    state.is_recording.store(true, Ordering::Relaxed);
    let signal = state.is_recording.clone();
    
    thread::spawn(move || {
        let primary_monitor = Monitor::primary().expect("No primary monitor");
        let width = primary_monitor.width().expect("Failed to get monitor width");
        let height = primary_monitor.height().expect("Failed to get monitor height");
        
        // Check documentation: primary() returns Result<Monitor, ...>
        // Monitor has width() -> Result<u32, ...>? or u32?
        // Assuming Result based on error handling pattern. if u32, remove expect.
        // Actually, let's assume they are methods.
        
        let flags = CaptureFlags {
            filename,
            stop_signal: signal.clone(),
            width,
            height,
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

        match CaptureHandler::start(settings) {
            Ok(_) => println!("Recording finished successfully"),
            Err(e) => eprintln!("Recording error: {:?}", e),
        }
        
        signal.store(false, Ordering::Relaxed);
    });

    Ok(())
}

#[tauri::command]
pub fn stop_recording(state: State<'_, RecorderState>) -> Result<(), String> {
    if !state.is_recording.load(Ordering::Relaxed) {
        return Err("Not recording".to_string());
    }
    state.is_recording.store(false, Ordering::Relaxed);
    Ok(())
}
