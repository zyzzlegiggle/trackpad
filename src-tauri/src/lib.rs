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

// Cursor frame for export - represents cursor position at a point in time
#[derive(serde::Deserialize, Debug, Clone)]
struct CursorFrame {
    timestamp_ms: u64,
    x: f64,  // Normalized 0-1
    y: f64,  // Normalized 0-1
}

// Cursor settings for export rendering
#[derive(serde::Deserialize, Debug)]
struct CursorExportSettings {
    visible: bool,
    size: i32,       // Cursor size in pixels
    color: String,   // Hex color without #
}

// Build cursor filter for FFmpeg - generates drawbox commands for cursor positions
// First Principles: FFmpeg can't iterate arrays, so we generate time-segmented drawbox filters
fn build_cursor_filter(
    cursor_positions: &Option<Vec<CursorFrame>>,
    cursor_settings: &Option<CursorExportSettings>,
    width: i32,
    height: i32,
    base_scale: f64,
    trim_start: f64,
    _duration: f64,
    base_filter: String,
) -> String {
    // If no cursor settings or not visible, just return base filter with rename
    let settings = match cursor_settings {
        Some(s) if s.visible => s,
        _ => return format!("{};[out]copy[final]", base_filter),
    };
    
    let positions = match cursor_positions {
        Some(p) if !p.is_empty() => p,
        _ => return format!("{};[out]copy[final]", base_filter),
    };
    
    println!("Building cursor filter for {} positions", positions.len());
    
    let cursor_size = settings.size;
    let cursor_color = &settings.color;
    
    // Calculate video offset in canvas (video is centered with base_scale)
    let margin = (1.0 - base_scale) / 2.0;
    let video_offset_x = (margin * width as f64) as i32;
    let video_offset_y = (margin * height as f64) as i32;
    let video_w = (width as f64 * base_scale) as i32;
    let video_h = (height as f64 * base_scale) as i32;
    
    // Build drawbox filter chain
    // Strategy: For each pair of adjacent cursor positions, draw cursor for that time segment
    // FFmpeg drawbox with enable='between(t,start,end)' and x/y as linear interpolation
    
    // Limit number of drawbox filters to avoid FFmpeg filter graph limit
    // Sample every Nth position if too many
    let max_segments = 500;
    let step = (positions.len() / max_segments).max(1);
    
    let mut drawbox_chain = String::new();
    let mut filter_count = 0;
    
    for i in (0..positions.len().saturating_sub(1)).step_by(step) {
        let p1 = &positions[i];
        let p2 = &positions[(i + step).min(positions.len() - 1)];
        
        // Convert timestamps to seconds relative to trim
        let t1 = (p1.timestamp_ms as f64 / 1000.0) - trim_start;
        let t2 = (p2.timestamp_ms as f64 / 1000.0) - trim_start;
        
        // Skip if outside valid range
        if t2 < 0.0 || t1 < 0.0 {
            continue;
        }
        
        // Calculate pixel positions (cursor position is in video coords, need canvas coords)
        // Canvas position = video_offset + cursor_norm * video_size
        let x1 = video_offset_x + (p1.x * video_w as f64) as i32;
        let y1 = video_offset_y + (p1.y * video_h as f64) as i32;
        let x2 = video_offset_x + (p2.x * video_w as f64) as i32;
        let y2 = video_offset_y + (p2.y * video_h as f64) as i32;
        
        // For simplicity, draw at interpolated position using enable
        // FFmpeg doesn't support dynamic x/y in drawbox, so we use center of segment
        let x_center = (x1 + x2) / 2 - cursor_size / 2;
        let y_center = (y1 + y2) / 2 - cursor_size / 2;
        
        // Clamp to valid range
        let x_clamped = x_center.max(0).min(width - cursor_size);
        let y_clamped = y_center.max(0).min(height - cursor_size);
        
        // Add drawbox filter
        let enable = format!("between(t,{:.3},{:.3})", t1, t2);
        let drawbox = format!(
            "drawbox=x={}:y={}:w={}:h={}:c=0x{}@0.9:t=fill:enable='{}'",
            x_clamped, y_clamped, cursor_size, cursor_size, cursor_color, enable
        );
        
        if drawbox_chain.is_empty() {
            drawbox_chain = drawbox;
        } else {
            drawbox_chain = format!("{},{}", drawbox_chain, drawbox);
        }
        filter_count += 1;
    }
    
    println!("Generated {} cursor drawbox filters", filter_count);
    
    if drawbox_chain.is_empty() {
        format!("{};[out]copy[final]", base_filter)
    } else {
        format!("{};[out]{}[final]", base_filter, drawbox_chain)
    }
}

#[tauri::command]
async fn export_with_effects(
    input_path: String,
    output_path: String,
    trim_start: f64,
    trim_end: f64,
    effects: Vec<ZoomEffect>,
    background_color: Option<String>,
    cursor_positions: Option<Vec<CursorFrame>>,
    cursor_settings: Option<CursorExportSettings>,
) -> Result<String, String> {
    let duration = trim_end - trim_start;
    let bg_color = background_color.unwrap_or_else(|| "1a1a2e".to_string());
    
    println!("=== EXPORT WITH EFFECTS (Zoomed-Out Canvas) ===");
    println!("Input: {}", input_path);
    println!("Output: {}", output_path);
    println!("Trim: {:.2} - {:.2} (duration: {:.2})", trim_start, trim_end, duration);
    println!("Background color: #{}", bg_color);
    println!("Effects received: {}", effects.len());
    for (i, eff) in effects.iter().enumerate() {
        println!("  Effect {}: time={:.2}-{:.2}, scale={:.2}, target=({:.3},{:.3})", 
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
    
    // === ZOOMED-OUT CANVAS APPROACH ===
    // Base state: Video scaled to 85% to show background padding
    // Zoomed state: Video scaled to base_scale * zoom_factor
    //
    // This ensures:
    // 1. Background is always visible in base state
    // 2. Zoom effects work correctly by scaling video up
    // 3. Edge zooms show background instead of black
    
    let base_scale = 0.85;  // Video at 85% size in base state
    let margin = (1.0 - base_scale) / 2.0;  // 7.5% margin on each side
    
    println!("Base scale: {:.2}, Margin: {:.1}%", base_scale, margin * 100.0);
    
    if !effects.is_empty() {
        println!("Building filter for {} zoom effects", effects.len());
        
        let ease = 0.3; // 300ms ease in/out
        
        // Build zoom expressions
        let mut zoom_parts: Vec<String> = Vec::new();
        let mut x_parts: Vec<String> = Vec::new();
        let mut y_parts: Vec<String> = Vec::new();
        
        for eff in effects.iter() {
            // Adjust times relative to trim start
            let s = eff.start_time - trim_start;
            let e = eff.end_time - trim_start;
            let zoom_scale = eff.scale;  // This is the ADDITIONAL zoom (e.g., 1.5 means 1.5x)
            let tx = eff.target_x;  // Normalized 0-1 in video
            let ty = eff.target_y;
            
            // Skip effects outside the trimmed range
            if e < 0.0 || s > duration {
                println!("  Skipping effect (outside trim range)");
                continue;
            }
            
            let si = s + ease;
            let so = e - ease;
            
            println!("Effect: time={:.2}-{:.2}, zoom={:.2}, target=({:.3},{:.3})", s, e, zoom_scale, tx, ty);
            
            // Zoom expression: returns current scale factor
            // Base = 1.0, zoomed = zoom_scale
            // Eased transition in and out
            let delta = zoom_scale - 1.0;
            let zoom_expr = format!(
                "if(between(t,{s},{e}),if(lt(t,{si}),1+{delta}*(t-{s})/{ease},if(lt(t,{so}),{zoom_scale},{zoom_scale}-{delta}*(t-{so})/{ease})),1)",
                s = s, si = si, so = so, e = e, zoom_scale = zoom_scale, delta = delta, ease = ease
            );
            zoom_parts.push(format!("if(between(t,{},{}),{},0)", s, e, zoom_expr));
            
            // Position expressions
            // When zoomed, we need to offset the video to center the target point
            // Target position in base-scaled video: tx * video_width_scaled = tx * width * base_scale * zoom
            // To center this in output: offset = output_center - target_position
            //                                  = width/2 - (margin * width + tx * width * base_scale) * zoom
            // But it's simpler to think in terms of the video placement offset from center
            
            // x_offset = (0.5 - (margin + tx * base_scale)) * width * (zoom - 1)
            // When zoom=1: offset=0 (video centered)
            // When zoom>1: offset shifts to center the target point
            
            let target_in_canvas = margin + tx * base_scale;  // Where target is in normalized canvas coords
            let y_target_in_canvas = margin + ty * base_scale;
            
            let x_offset_formula = format!("(0.5-{})*{}*(({zoom_expr})-1)", 
                target_in_canvas, width,
                zoom_expr = zoom_expr);
            let y_offset_formula = format!("(0.5-{})*{}*(({zoom_expr})-1)", 
                y_target_in_canvas, height,
                zoom_expr = zoom_expr);
            
            x_parts.push(format!("if(between(t,{},{}),{},0)", s, e, x_offset_formula));
            y_parts.push(format!("if(between(t,{},{}),{},0)", s, e, y_offset_formula));
        }
        
        // Combine expressions
        let zoom_combined = if zoom_parts.is_empty() {
            "1".to_string()
        } else if zoom_parts.len() == 1 {
            format!("max(1,{})", zoom_parts[0])  
        } else {
            let sum = zoom_parts.join("+");
            format!("max(1,{})", sum)
        };
        
        let x_offset = if x_parts.is_empty() {
            "0".to_string()
        } else if x_parts.len() == 1 {
            x_parts[0].clone()
        } else {
            x_parts.join("+")
        };
        
        let y_offset = if y_parts.is_empty() {
            "0".to_string()
        } else if y_parts.len() == 1 {
            y_parts[0].clone()
        } else {
            y_parts.join("+")
        };
        
        // Build the complete filter chain using overlay approach
        // 1. Create background canvas at output size
        // 2. Scale video by base_scale * zoom_factor
        // 3. Overlay video centered on canvas with offset for target
        
        let filter = format!(
            "color=c=0x{bg}:s={w}x{h}:d={dur}[bg];\
             [0:v]scale=w='iw*{base}*({zoom})':h='ih*{base}*({zoom})':eval=frame:flags=lanczos[vid];\
             [bg][vid]overlay=x='({w}-overlay_w)/2+({x_off})':y='({h}-overlay_h)/2+({y_off})':eval=frame[out]",
            bg = bg_color,
            w = width,
            h = height,
            dur = duration,
            base = base_scale,
            zoom = zoom_combined,
            x_off = x_offset,
            y_off = y_offset
        );
        
        println!("Filter: {}", filter);
        
        // Add cursor filter if positions available
        let final_filter = build_cursor_filter(
            &cursor_positions,
            &cursor_settings,
            width,
            height,
            base_scale,
            trim_start,
            duration,
            filter,
        );
        
        args.push("-filter_complex".to_string());
        args.push(final_filter);
        args.push("-map".to_string());
        args.push("[final]".to_string());
    } else {
        // No effects - just apply base scale with background
        let filter = format!(
            "color=c=0x{bg}:s={w}x{h}:d={dur}[bg];\
             [0:v]scale=w='iw*{base}':h='ih*{base}':flags=lanczos[vid];\
             [bg][vid]overlay=x='({w}-overlay_w)/2':y='({h}-overlay_h)/2'[out]",
            bg = bg_color,
            w = width,
            h = height,
            dur = duration,
            base = base_scale
        );
        
        println!("Filter (no effects): {}", filter);
        
        // Add cursor filter if positions available
        let final_filter = build_cursor_filter(
            &cursor_positions,
            &cursor_settings,
            width,
            height,
            base_scale,
            trim_start,
            duration,
            filter,
        );
        
        args.push("-filter_complex".to_string());
        args.push(final_filter);
        args.push("-map".to_string());
        args.push("[final]".to_string());
    }
    
    // Encoding options - optimized for quality and smooth playback
    args.extend([
        "-c:v".to_string(), "libx264".to_string(),
        "-preset".to_string(), "medium".to_string(),  // Better quality than fast
        "-crf".to_string(), "16".to_string(),         // Higher quality (lower = better)
        "-r".to_string(), "60".to_string(),           // Force 60fps output
        "-pix_fmt".to_string(), "yuv420p".to_string(), // Ensure compatibility
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