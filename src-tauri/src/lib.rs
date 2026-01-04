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

// Zoom effect for export
#[derive(serde::Deserialize, Debug)]
struct ZoomEffect {
    start_time: f64,
    end_time: f64,
    scale: f64,
    target_x: f64,  // Normalized 0-1
    target_y: f64,  // Normalized 0-1
}

#[tauri::command]
async fn export_with_effects(
    input_path: String,
    output_path: String,
    trim_start: f64,
    trim_end: f64,
    effects: Vec<ZoomEffect>,
) -> Result<String, String> {
    let duration = trim_end - trim_start;
    
    println!("=== EXPORT WITH EFFECTS ===");
    println!("Input: {}", input_path);
    println!("Output: {}", output_path);
    println!("Trim: {:.2} - {:.2} (duration: {:.2})", trim_start, trim_end, duration);
    println!("Effects received: {}", effects.len());
    for (i, eff) in effects.iter().enumerate() {
        println!("  Effect {}: time={:.2}-{:.2}, scale={:.2}, target=({:.2},{:.2})", 
            i, eff.start_time, eff.end_time, eff.scale, eff.target_x, eff.target_y);
    }
    
    // Get video dimensions
    let probe_output = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0",
            &input_path,
        ])
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !probe_output.status.success() {
        return Err("Failed to probe video dimensions".to_string());
    }

    let dimensions = String::from_utf8_lossy(&probe_output.stdout);
    let dims: Vec<&str> = dimensions.trim().split(',').collect();
    if dims.len() < 2 {
        return Err("Could not parse video dimensions".to_string());
    }
    
    let width: i32 = dims[0].parse().map_err(|_| "Invalid width")?;
    let height: i32 = dims[1].parse().map_err(|_| "Invalid height")?;
    
    println!("Video dimensions: {}x{}", width, height);
    
    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-ss".to_string(), format!("{:.3}", trim_start),
        "-i".to_string(), input_path.clone(),
        "-t".to_string(), format!("{:.3}", duration),
    ];
    
    if !effects.is_empty() {
        // Take the first effect and use its parameters
        let eff = &effects[0];
        let s = eff.start_time - trim_start;
        let e = eff.end_time - trim_start;
        let scale = eff.scale;
        let tx = eff.target_x;
        let ty = eff.target_y;
        
        println!("Processing effect: relative time {:.2}-{:.2}, scale={:.2}", s, e, scale);
        
        // Calculate static pan offset based on target
        let pan_x = (tx - 0.5) * 2.0;  // -1 to 1
        let pan_y = (ty - 0.5) * 2.0;
        
        // Build a filter with time-based expressions
        // CRITICAL: scale filter needs eval=frame to use time variable 't'
        // Zoom timeline: 1 -> scale over ease period, hold, scale -> 1
        let ease = 0.3;  // 300ms ease in/out
        let si = s + ease;
        let so = e - ease;
        let delta = scale - 1.0;
        
        // Zoom expression with proper syntax
        // Using single quotes for the entire expression to avoid shell escaping issues
        let zoom_expr = format!(
            "if(lt(t,{s}),1,if(lt(t,{si}),1+{delta}*(t-{s})/{ease},if(lt(t,{so}),{scale},if(lt(t,{e}),{scale}-{delta}*(t-{so})/{ease},1))))",
            s = s,
            si = si,
            so = so,
            e = e,
            scale = scale,
            delta = delta,
            ease = ease
        );
        
        // Pan expressions: only shift during effect
        let x_expr = format!(
            "if(between(t,{s},{e}),{off},0)",
            s = s, e = e, off = pan_x
        );
        let y_expr = format!(
            "if(between(t,{s},{e}),{off},0)",
            s = s, e = e, off = pan_y
        );
        
        // Full filter: scale (with eval=frame for time-based) then crop
        // eval=frame is REQUIRED to use 't' variable in scale filter
        let filter = format!(
            "scale=w='iw*({z})':h='ih*({z})':eval=frame:flags=lanczos,crop=w={w}:h={h}:x='(iw-{w})/2*(1+({x}))':y='(ih-{h})/2*(1+({y}))'",
            z = zoom_expr,
            w = width,
            h = height,
            x = x_expr,
            y = y_expr
        );
        
        println!("Filter: {}", filter);
        
        args.push("-vf".to_string());
        args.push(filter);
    }
    
    // Encoding options
    args.extend([
        "-c:v".to_string(), "libx264".to_string(),
        "-preset".to_string(), "fast".to_string(),
        "-crf".to_string(), "18".to_string(),
        "-c:a".to_string(), "aac".to_string(),
        "-b:a".to_string(), "192k".to_string(),
        output_path.clone(),
    ]);
    
    println!("FFmpeg args: {:?}", args);
    
    let output = Command::new("ffmpeg")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run FFmpeg: {}", e))?;

    if output.status.success() {
        println!("Export successful!");
        Ok(output_path)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("FFmpeg FAILED!");
        println!("stderr: {}", stderr);
        Err(format!("FFmpeg failed: {}", stderr))
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
            export_with_effects,
            get_temp_video_path,
            move_video_to_videos,
            delete_temp_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}