 use std::process::{Command, Stdio};

use std::io::Write;

use std::sync::{Arc, Mutex};

use std::sync::atomic::{AtomicBool, Ordering};

use std::thread;
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

        self.frame_count += 1;
        if self.frame_count % 5 == 0 {
            let width = frame.width();
            let height = frame.height();
            let mut buffer_obj = frame.buffer()?;
            let src_data = buffer_obj.as_raw_buffer();
            
            let img_buffer: Option<image::ImageBuffer<image::Rgba<u8>, &[u8]>> = 
                image::ImageBuffer::from_raw(width, height, src_data);
            
            if let Some(img) = img_buffer {
                let resized = image::imageops::resize(&img, 480, (480 * height) / width, image::imageops::FilterType::Nearest);
                let mut jpg_data = Vec::new();
                let mut cursor = Cursor::new(&mut jpg_data);
                if let Ok(_) = resized.write_to(&mut cursor, image::ImageOutputFormat::Jpeg(50)) {
                    let base64_str = base64::encode(&jpg_data);
                    let _ = self.app_handle.emit("preview-frame", base64_str);
                }
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



// Zoom State

struct CaptureHandler {
    ffmpeg_process: std::process::Child,
    stop_signal: Arc<AtomicBool>,
    // Reusable buffer to avoid allocation every frame
    compact_buffer: Vec<u8>,
    app_handle: Option<AppHandle>, 
    frame_count: u64,
}



impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        println!("Starting recording to: {} at {} FPS", flags.filename, flags.fps);
       
        // Use capturing dimensions directly for now to ensure speed
        let width = flags.width;
        let height = flags.height;
       
        // Align to even
        let width = if width % 2 != 0 { width - 1 } else { width };
        let height = if height % 2 != 0 { height - 1 } else { height };



       

        // Input Listener removed



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
            compact_buffer: vec![0u8; (width * height * 4) as usize],
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

       

        // Handle stride/padding

        // frame.buffer() returns the raw buffer which might be padded.

        // We need to check the description or just manually copy row by row if needed.

        // Windows Capture usually returns data with a specific Stride (RowPitch).

        // Since `windows-capture` wrapper abstracts some of this, let's verify.

        // But the `buffer()` method returns `FrameBuffer` which has `as_raw_buffer`.

        // Let's proceed with manual row copy which is safest.

       

        // We need to know the source stride.

        // NOTE: The `windows-capture` crate 1.5.0 Frame struct doesn't expose stride directly easily

        // in previous versions, but let's assume standard BGRA 32-bit.

        // Wait, `windows-capture` usually handles the mapping.

        // If the black screen issue persists, it's often because the texture is in GPU memory

        // and mapped incorrectly or simply `padded`.

        // Let's trust `frame.buffer()?` gives us access.

       

        let mut buffer_obj = frame.buffer()?;

        let src_data = buffer_obj.as_raw_buffer();

       

        // Basic check assuming 4 bytes per pixel

        let row_pitch = src_data.len() / height as usize;

        let tight_pitch = (width * 4) as usize;

       

        // Normal Recording only
        if let Some(stdin) = self.ffmpeg_process.stdin.as_mut() {
             if row_pitch == tight_pitch {
                stdin.write_all(src_data)?;
            } else {
                for i in 0..height as usize {
                    let src_start = i * row_pitch;
                    let src_end = src_start + tight_pitch;
                    if src_end <= src_data.len() {
                         stdin.write_all(&src_data[src_start..src_end])?;
                    }
                }
            }
        }





        self.frame_count += 1;
        if self.frame_count % 5 == 0 { // ~12 FPS
             if let Some(app) = &self.app_handle {

                
                // Convert raw buffer to DynamicImage
                // We assume BGRA8 (which is what windows-capture provides usually)
                let img_buffer: Option<image::ImageBuffer<image::Rgba<u8>, &[u8]>> = 
                    image::ImageBuffer::from_raw(width, height, src_data);
                
                if let Some(img) = img_buffer {
                     // Resize to generic preview width (e.g. 480px width)
                     let resized = image::imageops::resize(&img, 480, (480 * height) / width, image::imageops::FilterType::Nearest);
                     
                     // Encode to JPEG
                     let mut jpg_data = Vec::new();
                     let mut cursor = Cursor::new(&mut jpg_data);
                     if let Ok(_) = resized.write_to(&mut cursor, image::ImageOutputFormat::Jpeg(50)) {
                         // Base64 encode
                         let base64_str = base64::encode(&jpg_data);
                        // Emit
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