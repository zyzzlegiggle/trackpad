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
        
        // === PADDED CANVAS APPROACH ===
        // Like Cursorful/Screen Studio: add padding around video so edge zooms show 
        // gradient background instead of black
        //
        // Pipeline: pad → scale → crop
        // 1. pad: Add gradient background padding around video
        // 2. scale: Zoom by scaling up the padded canvas
        // 3. crop: Extract output viewport centered on target position
        
        let ease = 0.3; // 300ms ease in/out
        
        // Calculate padding needed for maximum zoom at edges
        // At max_scale zoom, we need (max_scale - 1) * dimension / 2 padding on each side
        let max_scale = effects.iter().map(|e| e.scale).fold(1.5_f64, f64::max);
        let pad_x = ((width as f64 * (max_scale - 1.0) / 2.0).ceil() as i32).max(100);
        let pad_y = ((height as f64 * (max_scale - 1.0) / 2.0).ceil() as i32).max(100);
        
        // Padded canvas dimensions
        let padded_w = width as i32 + 2 * pad_x;
        let padded_h = height as i32 + 2 * pad_y;
        
        println!("Padding: {}x{} -> {}x{} (pad: {}x{})", width, height, padded_w, padded_h, pad_x, pad_y);
        println!("Max scale: {:.2}", max_scale);
        
        // Default crop position when no effect is active:
        // Show the original video (which is centered in the padded canvas)
        // When z=1, padded canvas size = padded_w, so crop should start at pad_x
        // But since z varies, we need: pad_x * z = pad_x * iw / padded_w
        let default_x_expr = format!("{}*iw/{}", pad_x, padded_w);
        let default_y_expr = format!("{}*ih/{}", pad_y, padded_h);
        
        // Build effect expressions
        // Each effect provides a complete expression that evaluates to the correct value
        // when active, or to -1 when inactive (we'll use max to combine them)
        let mut zoom_parts: Vec<String> = Vec::new();
        let mut x_parts: Vec<String> = Vec::new();
        let mut y_parts: Vec<String> = Vec::new();
        
        for eff in effects.iter() {
            // Adjust times relative to trim start
            let s = eff.start_time - trim_start;
            let e = eff.end_time - trim_start;
            let scale = eff.scale;
            let tx = eff.target_x;  // Normalized 0-1 in original video
            let ty = eff.target_y;
            
            // Skip effects outside the trimmed range
            if e < 0.0 || s > duration {
                println!("  Skipping effect (outside trim range)");
                continue;
            }
            
            let si = s + ease;
            let so = e - ease;
            let delta = scale - 1.0;
            
            println!("Effect: time={:.2}-{:.2}, scale={:.2}, target=({:.3},{:.3})", s, e, scale, tx, ty);
            
            // Target point in padded canvas (before scale):
            //   target_x_padded = pad_x + tx * width
            // After scaling by z=iw/padded_w:
            //   target_x_scaled = (pad_x + tx * width) * iw / padded_w
            // Crop offset to center output on target:
            //   crop_x = target_x_scaled - width/2
            let target_x_padded = pad_x as f64 + tx * width as f64;
            let target_y_padded = pad_y as f64 + ty * height as f64;
            
            println!("  Target in padded canvas: ({:.1}, {:.1})", target_x_padded, target_y_padded);
            
            // Zoom expression with smooth ease in/out
            // Returns the actual zoom factor when active, 0 when inactive
            let zoom_expr = format!(
                "if(between(t,{s},{e}),if(lt(t,{si}),1+{delta}*(t-{s})/{ease},if(lt(t,{so}),{scale},{scale}-{delta}*(t-{so})/{ease})),0)",
                s = s, si = si, so = so, e = e, scale = scale, delta = delta, ease = ease
            );
            zoom_parts.push(zoom_expr);
            
            // crop_x = target_x_padded * iw / padded_w - width/2
            // Returns the actual crop position when active (guaranteed positive due to padding)
            // When inactive, returns -1 (invalid, will be filtered by max)
            let crop_x_formula = format!(
                "{}*iw/{}-{}",
                target_x_padded, padded_w, width as f64 / 2.0
            );
            let crop_y_formula = format!(
                "{}*ih/{}-{}",
                target_y_padded, padded_h, height as f64 / 2.0
            );
            
            // Wrap in time check: return actual value when active, -1 when inactive
            let crop_x = format!("if(between(t,{s},{e}),{formula},-1)", s = s, e = e, formula = crop_x_formula);
            let crop_y = format!("if(between(t,{s},{e}),{formula},-1)", s = s, e = e, formula = crop_y_formula);
            
            x_parts.push(crop_x);
            y_parts.push(crop_y);
        }
        
        if zoom_parts.is_empty() {
            println!("No valid effects after filtering, skipping zoom filter");
        } else {
            // Combine zoom expressions (sum them; each returns 0 when not active)
            let zoom_combined: String = if zoom_parts.len() == 1 {
                format!("max(1,{})", zoom_parts[0])
            } else {
                let sum = zoom_parts.join("+");
                format!("max(1,{})", sum)
            };
            
            // Combine position expressions using max
            // Each returns -1 when inactive, valid positive value when active
            // max of all: gives the active one's value, or -1 if none active
            // Then use if to fall back to default when none active
            let x_max = if x_parts.len() == 1 {
                x_parts[0].clone()
            } else {
                // Create nested max: max(a,max(b,max(c,...)))
                let mut expr = x_parts[0].clone();
                for part in x_parts.iter().skip(1) {
                    expr = format!("max({},{})", expr, part);
                }
                expr
            };
            
            let y_max = if y_parts.len() == 1 {
                y_parts[0].clone()
            } else {
                let mut expr = y_parts[0].clone();
                for part in y_parts.iter().skip(1) {
                    expr = format!("max({},{})", expr, part);
                }
                expr
            };
            
            // If max result is -1 (no effect active), use default position
            let x_combined = format!("if(lt({x_max},0),{default},{x_max})", 
                x_max = x_max, default = default_x_expr);
            let y_combined = format!("if(lt({y_max},0),{default},{y_max})", 
                y_max = y_max, default = default_y_expr);
            
            // Build the complete filter chain:
            // 1. pad: Add gradient padding around video (dark blue)
            // 2. scale: Zoom by scaling up
            // 3. crop: Extract output size centered on target
            let filter = format!(
                "pad=w={pw}:h={ph}:x={px}:y={py}:color=0x1a1a2e,\
                 scale=w='iw*({z})':h='ih*({z})':eval=frame:flags=lanczos,\
                 crop=w={w}:h={h}:x='max(0,min(iw-{w},{x}))':y='max(0,min(ih-{h},{y}))'",
                pw = padded_w, ph = padded_h, px = pad_x, py = pad_y,
                z = zoom_combined,
                w = width, h = height,
                x = x_combined, y = y_combined
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