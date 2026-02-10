mod recorder;

use recorder::RecorderState;
use tauri::Manager;
use std::process::Command;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn toggle_overlay(app: tauri::AppHandle, show: bool) {
    if let Some(window) = app.get_webview_window("overlay") {
        if show {
            window.show().unwrap();
        } else {
            window.hide().unwrap();
        }
    }
}

#[tauri::command]
fn get_temp_video_path() -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    let path = temp_dir.join(format!("visualcoder_recording_{}.mp4", timestamp));
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_videos_dir_path() -> Result<String, String> {
    let videos_dir = dirs::video_dir().ok_or("Could not find Videos directory")?;
    Ok(videos_dir.to_string_lossy().to_string())
}


#[tauri::command]
async fn move_video_to_videos(temp_path: String, final_name: String) -> Result<String, String> {
    let videos_dir = dirs::video_dir().ok_or("Could not find Videos directory")?;
    let final_path = videos_dir.join(&final_name);
    std::fs::copy(&temp_path, &final_path).map_err(|e| format!("Failed to copy video: {}", e))?;
    std::fs::remove_file(&temp_path).ok(); // Cleanup temp, ignore errors
    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_temp_video(temp_path: String) -> Result<(), String> {
    std::fs::remove_file(&temp_path).map_err(|e| format!("Failed to delete temp video: {}", e))
}

#[tauri::command]
async fn trim_video(
    input_path: String,
    output_path: String,
    start_time: f64,
    end_time: f64,
) -> Result<String, String> {
    let duration = end_time - start_time;
    
    // Use FFmpeg to trim the video
    let output = Command::new("ffmpeg")
        .args([
            "-y",                           // Overwrite output
            "-i", &input_path,              // Input file
            "-ss", &format!("{:.3}", start_time), // Start time
            "-t", &format!("{:.3}", duration),    // Duration
            "-c", "copy",                   // Copy codec (fast, no re-encoding)
            &output_path,                   // Output file
        ])
        .output()
        .map_err(|e| format!("Failed to run FFmpeg: {}", e))?;

    if output.status.success() {
        Ok(output_path)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("FFmpeg failed: {}", stderr))
    }
}

// ============================================================================
// ENCODING UTILITIES
// ============================================================================

// Get encoding parameters based on quality setting
fn get_encoding_params(quality: &str) -> (String, String, String) {
    // Returns (encoder, preset, crf/quality)
    // GPU encoding disabled - always use software encoder (libx264)
    let (preset, crf) = match quality {
        "high" => ("slower", "16"),     // Best quality
        "medium" => ("medium", "20"),   // Balanced
        "low" => ("fast", "26"),        // Fast encode
        _ => ("medium", "20"),
    };
    ("libx264".to_string(), preset.to_string(), crf.to_string())
}

// ============================================================================
// CANVAS-BASED EXPORT: Encode pre-rendered RGB frames
// ============================================================================
//
// FIRST PRINCIPLES: The frontend renders each frame using the same canvas code
// as the preview, ensuring pixel-perfect consistency. We receive raw RGB frames
// and encode them with FFmpeg.
//
// Frame Format: RGB24 (3 bytes per pixel: R, G, B)
// Input: Raw frame bytes sent from JS via Tauri command (base64 encoded)
// Output: Encoded video file

/// Encode raw RGB frames into a video file
/// 
/// This command receives all frame data at once and encodes to a video.
/// For large videos, we may need to stream frames, but this works for most cases.
#[tauri::command]
async fn encode_frames(
    output_path: String,
    width: i32,
    height: i32,
    fps: i32,
    quality: Option<String>,
    frames_base64: Vec<String>,  // Base64 encoded RGB frames
) -> Result<String, String> {
    use std::io::Write;
    use base64::Engine;
    
    let quality_setting = quality.unwrap_or_else(|| "high".to_string());
    let frame_count = frames_base64.len();
    
    println!("=== ENCODE FRAMES (Canvas-Based Export) ===");
    println!("Output: {}", output_path);
    println!("Resolution: {}x{} @ {}fps", width, height, fps);
    println!("Frames: {}", frame_count);
    println!("Quality: {}", quality_setting);
    
    if frame_count == 0 {
        return Err("No frames to encode".to_string());
    }
    
    // Create temp directory
    let temp_dir = std::env::temp_dir().join(format!("visualcoder_frames_{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {}", e))?;
    
    println!("Temp directory: {:?}", temp_dir);
    
    // FIRST PRINCIPLES: FFmpeg rawvideo format needs a single continuous raw file
    // File patterns (%06d) only work with image formats like PNG/JPEG, not raw data
    // So we concatenate all frames into one file
    let raw_video_path = temp_dir.join("frames.raw");
    let mut raw_file = std::fs::File::create(&raw_video_path)
        .map_err(|e| format!("Failed to create raw video file: {}", e))?;
    
    println!("Decoding and writing {} frames to raw file...", frame_count);
    
    for (i, frame_b64) in frames_base64.iter().enumerate() {
        let frame_data = base64::engine::general_purpose::STANDARD
            .decode(frame_b64)
            .map_err(|e| format!("Failed to decode frame {}: {}", i, e))?;
        
        raw_file.write_all(&frame_data)
            .map_err(|e| format!("Failed to write frame {}: {}", i, e))?;
        
        if i % 100 == 0 {
            println!("  Written frame {}/{}", i, frame_count);
        }
    }
    
    // Ensure all data is flushed to disk
    raw_file.flush().map_err(|e| format!("Failed to flush raw file: {}", e))?;
    drop(raw_file); // Close the file before FFmpeg reads it
    
    println!("Wrote all frames to {:?}", raw_video_path);
    
    // Build FFmpeg command for encoding raw RGB frames
    let (encoder, preset, crf) = get_encoding_params(&quality_setting);
    
    let raw_path_str = raw_video_path.to_string_lossy();
    
    let args = vec![
        "-y".to_string(),
        "-f".to_string(), "rawvideo".to_string(),
        "-pixel_format".to_string(), "rgb24".to_string(),
        "-video_size".to_string(), format!("{}x{}", width, height),
        "-framerate".to_string(), fps.to_string(),
        "-i".to_string(), raw_path_str.to_string(),
        "-c:v".to_string(), encoder,
        "-preset".to_string(), preset,
        "-crf".to_string(), crf,
        "-pix_fmt".to_string(), "yuv420p".to_string(),
        output_path.clone(),
    ];
    
    println!("Running FFmpeg with args: {:?}", args);
    
    let output = Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to execute FFmpeg: {}", e))?;
    
    // Cleanup temp directory
    if let Err(e) = std::fs::remove_dir_all(&temp_dir) {
        println!("Warning: Failed to cleanup temp directory: {}", e);
    }
    
    if output.status.success() {
        println!("Encode successful! File saved to: {}", output_path);
        Ok(output_path)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("FFmpeg failed: {}", stderr);
        Err(format!("FFmpeg encoding failed: {}", stderr))
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RecorderState::new())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            recorder::start_recording,
            recorder::stop_recording,
            recorder::get_open_windows,
            recorder::get_recorded_clicks,
            recorder::get_cursor_positions,
            trim_video,
            encode_frames,
            get_temp_video_path,
            get_videos_dir_path,
            move_video_to_videos,
            delete_temp_video
        ])

        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
