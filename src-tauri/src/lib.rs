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
        println!("Building filter for {} zoom effects", effects.len());
        
        // Build expressions that handle ALL effects
        // Each effect has: start_time, end_time, scale, target_x, target_y
        // We need expressions that:
        // 1. zoom_expr: returns the current zoom level based on time
        // 2. x_expr, y_expr: returns the crop offset based on time and target
        
        let ease = 0.3; // 300ms ease in/out
        
        // Build composite expressions for all effects
        // Start with default values (no zoom, center position)
        let mut zoom_parts: Vec<String> = Vec::new();
        let mut x_parts: Vec<String> = Vec::new();
        let mut y_parts: Vec<String> = Vec::new();
        
        for eff in effects.iter() {
            // Adjust times relative to trim start
            let s = eff.start_time - trim_start;
            let e = eff.end_time - trim_start;
            let scale = eff.scale;
            let tx = eff.target_x;
            let ty = eff.target_y;
            
            // Skip effects outside the trimmed range
            if e < 0.0 || s > duration {
                continue;
            }
            
            let si = s + ease;
            let so = e - ease;
            let delta = scale - 1.0;
            
            println!("Effect: time={:.2}-{:.2}, scale={:.2}, target=({:.3},{:.3})", s, e, scale, tx, ty);
            
            // Zoom expression for this effect
            // Returns zoom level when inside effect time range, otherwise continues to next check
            let zoom_expr = format!(
                "if(between(t,{s},{e}),if(lt(t,{si}),1+{delta}*(t-{s})/{ease},if(lt(t,{so}),{scale},{scale}-{delta}*(t-{so})/{ease})),0)",
                s = s, si = si, so = so, e = e, scale = scale, delta = delta, ease = ease
            );
            zoom_parts.push(zoom_expr);
            
            // Position expressions for this effect
            // target_x/y are normalized 0-1, need to convert to pixel offsets
            // When zoomed at scale S, the visible area is (width/S, height/S)
            // To center on target (tx, ty), we need to crop at:
            //   crop_x = tx * width * S - width/2 = width * (tx * S - 0.5)
            // But we're cropping AFTER scale, so iw = width * S
            //   crop_x = tx * iw - width/2
            let crop_x = format!(
                "if(between(t,{s},{e}),{tx}*iw-{half_w},0)",
                s = s, e = e, tx = tx, half_w = width as f64 / 2.0
            );
            let crop_y = format!(
                "if(between(t,{s},{e}),{ty}*ih-{half_h},0)",
                s = s, e = e, ty = ty, half_h = height as f64 / 2.0
            );
            x_parts.push(crop_x);
            y_parts.push(crop_y);
        }
        
        if zoom_parts.is_empty() {
            println!("No valid effects after filtering, skipping zoom filter");
        } else {
            // Combine all zoom parts: take max (only one effect active at a time typically)
            // Use nested if-else: check each effect in order
            let zoom_combined: String = if zoom_parts.len() == 1 {
                format!("max(1,{})", zoom_parts[0])
            } else {
                // Sum all zoom expressions (each returns 0 when not active) and take max with 1
                let sum = zoom_parts.join("+");
                format!("max(1,{})", sum)
            };
            
            // Combine position parts similarly (sum, each returns 0 when not active)
            let x_combined = if x_parts.len() == 1 {
                x_parts[0].clone()
            } else {
                x_parts.join("+")
            };
            
            let y_combined = if y_parts.len() == 1 {
                y_parts[0].clone()
            } else {
                y_parts.join("+")
            };
            
            // Build the filter
            // scale: multiply dimensions by zoom factor
            // crop: extract original resolution centered on target position
            let filter = format!(
                "scale=w='iw*({z})':h='ih*({z})':eval=frame:flags=lanczos,crop=w={w}:h={h}:x='max(0,min(iw-{w},{x}))':y='max(0,min(ih-{h},{y}))'",
                z = zoom_combined,
                w = width,
                h = height,
                x = x_combined,
                y = y_combined
            );
            
            println!("Filter: {}", filter);
            
            args.push("-vf".to_string());
            args.push(filter);
        }
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