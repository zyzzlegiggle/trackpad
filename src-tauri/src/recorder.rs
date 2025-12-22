 use std::process::{Command, Stdio};
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Instant, Duration};
use tauri::{AppHandle, Emitter, Manager};
use tauri::State;
use std::io::Cursor;
use image::DynamicImage;


use windows_capture::{

    capture::{Context, GraphicsCaptureApiHandler},

    frame::Frame,

    graphics_capture_api::InternalCaptureControl,

    settings::{

        ColorFormat, CursorCaptureSettings, DrawBorderSettings, Settings,

        SecondaryWindowSettings, MinimumUpdateIntervalSettings, DirtyRegionSettings

    },

    monitor::Monitor,

    // window::Window, // Commented out unused import

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

// Preview-only state
pub struct PreviewState {
    pub is_previewing: Arc<AtomicBool>,
}

impl PreviewState {
    pub fn new() -> Self {
        Self {
            is_previewing: Arc::new(AtomicBool::new(false)),
        }
    }
}

// Preview-only flags (no ffmpeg)
struct PreviewFlags {
    stop_signal: Arc<AtomicBool>,
    app_handle: AppHandle,
}

// Preview handler - only captures frames for display
struct PreviewHandler {
    stop_signal: Arc<AtomicBool>,
    app_handle: AppHandle,
    frame_count: u64,
}

impl GraphicsCaptureApiHandler for PreviewHandler {
    type Flags = PreviewFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            stop_signal: ctx.flags.stop_signal,
            app_handle: ctx.flags.app_handle,
            frame_count: 0,
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
        
        // Handle stride/padding - copy to tight buffer
        let row_pitch = src_data.len() / height as usize;
        let tight_pitch = (width * 4) as usize;
        
        let mut rgba_data = vec![0u8; (width * height * 4) as usize];
        
        for y in 0..height as usize {
            let src_start = y * row_pitch;
            let dst_start = y * tight_pitch;
            for x in 0..width as usize {
                let src_idx = src_start + x * 4;
                let dst_idx = dst_start + x * 4;
                if src_idx + 3 < src_data.len() {
                    // BGRA → RGBA swap
                    rgba_data[dst_idx] = src_data[src_idx + 2];     // R
                    rgba_data[dst_idx + 1] = src_data[src_idx + 1]; // G
                    rgba_data[dst_idx + 2] = src_data[src_idx];     // B
                    rgba_data[dst_idx + 3] = src_data[src_idx + 3]; // A
                }
            }
        }
        
        let img_buffer: Option<image::ImageBuffer<image::Rgba<u8>, Vec<u8>>> = 
            image::ImageBuffer::from_raw(width, height, rgba_data);
        
        if let Some(img) = img_buffer {
            let mut jpg_data = Vec::new();
            let mut cursor = Cursor::new(&mut jpg_data);
            if let Ok(_) = img.write_to(&mut cursor, image::ImageOutputFormat::Jpeg(95)) {
                let base64_str = base64::encode(&jpg_data);
                let _ = self.app_handle.emit("preview-frame", base64_str);
            }
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

#[tauri::command]
pub fn start_preview(app_handle: AppHandle, state: State<'_, PreviewState>) -> Result<(), String> {
    if state.is_previewing.load(Ordering::Relaxed) {
        return Ok(()); // Already previewing
    }
    
    state.is_previewing.store(true, Ordering::Relaxed);
    let signal = state.is_previewing.clone();
    
    thread::spawn(move || {
        let primary_monitor = Monitor::primary().expect("No primary monitor");
        
        let flags = PreviewFlags {
            stop_signal: signal.clone(),
            app_handle,
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

        let _ = PreviewHandler::start(settings);
        signal.store(false, Ordering::Relaxed);
    });

    Ok(())
}

#[tauri::command]
pub fn stop_preview(state: State<'_, PreviewState>) -> Result<(), String> {
    state.is_previewing.store(false, Ordering::Relaxed);
    Ok(())
}


// Data passed to the capture thread

struct CaptureFlags {

    filename: String,

    stop_signal: Arc<AtomicBool>,

    width: u32,

    height: u32,

    fps: String,
    app_handle: AppHandle,
}



// Capture Handler with constant framerate output
struct CaptureHandler {
    ffmpeg_process: std::process::Child,
    stop_signal: Arc<AtomicBool>,
    app_handle: Option<AppHandle>,
    preview_frame_count: u64,
    // Constant framerate fields
    recording_start: Option<Instant>,
    frames_written: u64,
    target_fps: f64,
    // Cached frame data for duplication (tight/unpaddded)
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
            app_handle: Some(flags.app_handle),
            preview_frame_count: 0,
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

        // Calculate pitches
        let row_pitch = src_data.len() / height as usize;
        let tight_pitch = (width * 4) as usize;
        let frame_size = (self.frame_width * self.frame_height * 4) as usize;

        // Extract tight frame data (remove padding) - reuse buffer
        if self.last_frame.len() != frame_size {
            self.last_frame = vec![0u8; frame_size];
        }
        
        if row_pitch == tight_pitch && width == self.frame_width && height == self.frame_height {
            self.last_frame.copy_from_slice(&src_data[..frame_size]);
        } else {
            // Copy row by row, removing padding
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

        // Initialize recording start time on first frame
        let now = Instant::now();
        if self.recording_start.is_none() {
            self.recording_start = Some(now);
        }

        // Calculate expected frames based on elapsed time
        let elapsed = now.duration_since(self.recording_start.unwrap());
        let expected_frames = (elapsed.as_secs_f64() * self.target_fps).ceil() as u64;

        // Write frames to catch up to expected count
        if let Some(stdin) = self.ffmpeg_process.stdin.as_mut() {
            while self.frames_written < expected_frames {
                stdin.write_all(&self.last_frame)?;
                self.frames_written += 1;
            }
        }

        // Preview (every 5th capture event)
        self.preview_frame_count += 1;
        if self.preview_frame_count % 5 == 0 {
            if let Some(app) = &self.app_handle {
                let img_buffer: Option<image::ImageBuffer<image::Rgba<u8>, &[u8]>> = 
                    image::ImageBuffer::from_raw(self.frame_width, self.frame_height, self.last_frame.as_slice());
                
                if let Some(img) = img_buffer {
                    let resized = image::imageops::resize(&img, 480, (480 * self.frame_height) / self.frame_width, image::imageops::FilterType::Nearest);
                    let mut jpg_data = Vec::new();
                    let mut cursor = Cursor::new(&mut jpg_data);
                    if let Ok(_) = resized.write_to(&mut cursor, image::ImageOutputFormat::Jpeg(50)) {
                        let base64_str = base64::encode(&jpg_data);
                        let _ = app.emit("preview-frame", base64_str);
                    }
                }
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


// Window Info Structs for list_windows command

#[derive(serde::Serialize)]

pub struct WindowInfo {

    id: u32,

    title: String,

}


#[tauri::command]

pub fn get_open_windows() -> Vec<WindowInfo> {

    // Stubbed to avoid compilation errors with Window API

    // We will just return empty list for now since we record primary monitor

    Vec::new()

}


#[derive(serde::Deserialize)]

pub struct RecordTarget {

    #[serde(rename = "type")]

    target_type: String,

    id: Option<u32>,

}


#[tauri::command]

pub fn start_recording(app_handle: AppHandle, state: State<'_, RecorderState>, filename: String, fps: String, _target: Option<RecordTarget>) -> Result<(), String> {
    if state.is_recording.load(Ordering::Relaxed) {
        return Err("Already recording".to_string());
    }
   
    state.is_recording.store(true, Ordering::Relaxed);
    let signal = state.is_recording.clone();
    let app_handle_clone = app_handle.clone();
   
    thread::spawn(move || {
        // Always capture primary monitor for now to fix errors
        let primary_monitor = Monitor::primary().expect("No primary monitor");
        let width = primary_monitor.width().expect("Failed to get monitor width");
        let height = primary_monitor.height().expect("Failed to get monitor height");
           
        let flags = CaptureFlags {
            filename,
            stop_signal: signal.clone(),
            width,
            height,
            fps,
            app_handle: app_handle_clone,
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