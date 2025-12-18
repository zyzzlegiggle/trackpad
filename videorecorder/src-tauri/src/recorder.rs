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


// Data passed to the capture thread

struct CaptureFlags {

    filename: String,

    stop_signal: Arc<AtomicBool>,

    width: u32,

    height: u32,

    fps: String,

}


// Zoom State

struct CaptureHandler {
    ffmpeg_process: std::process::Child,
    stop_signal: Arc<AtomicBool>,
    // Reusable buffer to avoid allocation every frame
    compact_buffer: Vec<u8>,
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
            compact_buffer: vec![0u8; (width * height * 4) as usize],
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

pub fn start_recording(state: State<'_, RecorderState>, filename: String, fps: String, _target: Option<RecordTarget>) -> Result<(), String> {

    if state.is_recording.load(Ordering::Relaxed) {

        return Err("Already recording".to_string());

    }

   

    state.is_recording.store(true, Ordering::Relaxed);

    let signal = state.is_recording.clone();

   

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