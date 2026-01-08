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
    style: String,   // "pointer", "circle", or "crosshair"
}

// Generate cursor image as PNG file for FFmpeg overlay
// First Principles: FFmpeg can overlay images with transparency, so we generate
// the exact cursor graphics used in the preview (pointer/circle/crosshair)
fn generate_cursor_image(style: &str, size: i32, color: &str) -> Result<std::path::PathBuf, String> {
    use image::{Rgba, RgbaImage};
    
    let size_u = size as u32;
    let mut img = RgbaImage::new(size_u, size_u);
    
    // Parse hex color
    let r = u8::from_str_radix(&color[0..2], 16).unwrap_or(255);
    let g = u8::from_str_radix(&color[2..4], 16).unwrap_or(255);
    let b = u8::from_str_radix(&color[4..6], 16).unwrap_or(255);
    let cursor_color = Rgba([r, g, b, 230]); // Slightly transparent
    let outline_color = Rgba([0, 0, 0, 180]);
    let center_color = Rgba([0, 0, 0, 128]);
    
    let center = size as f32 / 2.0;
    
    match style {
        "circle" => {
            // Draw filled circle with outer ring and center dot
            let outer_radius = size as f32 * 0.42;
            let inner_radius = size as f32 * 0.12;
            
            for y in 0..size_u {
                for x in 0..size_u {
                    let dx = x as f32 - center;
                    let dy = y as f32 - center;
                    let dist = (dx * dx + dy * dy).sqrt();
                    
                    if dist <= inner_radius {
                        // Center dot
                        img.put_pixel(x, y, center_color);
                    } else if dist <= outer_radius {
                        // Main circle
                        img.put_pixel(x, y, cursor_color);
                    } else if dist <= outer_radius + 1.5 {
                        // Outline
                        img.put_pixel(x, y, outline_color);
                    }
                }
            }
        }
        "crosshair" => {
            // Draw crosshair with central circle
            let line_width = (size as f32 * 0.08).max(2.0) as i32;
            let circle_radius = size as f32 * 0.18;
            let arm_length = size as f32 * 0.4;
            
            for y in 0..size_u {
                for x in 0..size_u {
                    let dx = x as f32 - center;
                    let dy = y as f32 - center;
                    let dist = (dx * dx + dy * dy).sqrt();
                    
                    // Central circle (hollow)
                    if dist >= circle_radius - 1.5 && dist <= circle_radius + 1.5 {
                        img.put_pixel(x, y, cursor_color);
                    }
                    // Horizontal arms
                    else if (dy.abs() as i32) < line_width && dx.abs() > circle_radius && dx.abs() < arm_length + circle_radius {
                        img.put_pixel(x, y, cursor_color);
                    }
                    // Vertical arms
                    else if (dx.abs() as i32) < line_width && dy.abs() > circle_radius && dy.abs() < arm_length + circle_radius {
                        img.put_pixel(x, y, cursor_color);
                    }
                }
            }
        }
        _ => {
            // "pointer" - Draw arrow cursor (matches SVG path "M4 4l7.07 17 2.51-7.39L21 11.07z")
            // Simplified triangular pointer shape
            let scale = size as f32 / 24.0;
            
            // Define pointer polygon points (from SVG, scaled)
            let points: [(f32, f32); 4] = [
                (4.0 * scale, 4.0 * scale),      // Top-left tip
                (11.07 * scale, 21.0 * scale),   // Bottom
                (13.58 * scale, 13.61 * scale),  // Inner corner
                (21.0 * scale, 11.07 * scale),   // Right point
            ];
            
            // Simple point-in-polygon test for each pixel
            for y in 0..size_u {
                for x in 0..size_u {
                    let px = x as f32;
                    let py = y as f32;
                    
                    // Check if point is inside the pointer polygon
                    if point_in_polygon(px, py, &points) {
                        img.put_pixel(x, y, cursor_color);
                    }
                    // Check if point is on the edge (for outline)
                    else if is_near_polygon_edge(px, py, &points, 1.2) {
                        img.put_pixel(x, y, outline_color);
                    }
                }
            }
        }
    }
    
    // Save to temp file
    let temp_dir = std::env::temp_dir();
    let cursor_path = temp_dir.join(format!("visualcoder_cursor_{}_{}.png", style, size));
    img.save(&cursor_path).map_err(|e| format!("Failed to save cursor image: {}", e))?;
    
    println!("Generated cursor image: {:?}", cursor_path);
    Ok(cursor_path)
}

// Helper: Check if point is inside polygon using ray casting
fn point_in_polygon(px: f32, py: f32, polygon: &[(f32, f32)]) -> bool {
    let n = polygon.len();
    let mut inside = false;
    let mut j = n - 1;
    
    for i in 0..n {
        let (xi, yi) = polygon[i];
        let (xj, yj) = polygon[j];
        
        if ((yi > py) != (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

// Helper: Check if point is near any edge of polygon
fn is_near_polygon_edge(px: f32, py: f32, polygon: &[(f32, f32)], threshold: f32) -> bool {
    let n = polygon.len();
    for i in 0..n {
        let j = (i + 1) % n;
        let (x1, y1) = polygon[i];
        let (x2, y2) = polygon[j];
        
        // Distance from point to line segment
        let dx = x2 - x1;
        let dy = y2 - y1;
        let len_sq = dx * dx + dy * dy;
        
        if len_sq == 0.0 {
            continue;
        }
        
        let t = ((px - x1) * dx + (py - y1) * dy) / len_sq;
        let t = t.clamp(0.0, 1.0);
        
        let closest_x = x1 + t * dx;
        let closest_y = y1 + t * dy;
        
        let dist = ((px - closest_x).powi(2) + (py - closest_y).powi(2)).sqrt();
        if dist <= threshold {
            return true;
        }
    }
    false
}

// Build cursor filter for FFmpeg - uses overlay with cursor image
// First Principles: Generate cursor PNG once, then overlay at each position using FFmpeg expressions
fn build_cursor_filter(
    cursor_positions: &Option<Vec<CursorFrame>>,
    cursor_settings: &Option<CursorExportSettings>,
    width: i32,
    height: i32,
    base_scale: f64,
    trim_start: f64,
    _duration: f64,
    base_filter: String,
) -> Result<String, String> {
    // If no cursor settings or not visible, just return base filter with rename
    let settings = match cursor_settings {
        Some(s) if s.visible => s,
        _ => return Ok(format!("{};[out]copy[final]", base_filter)),
    };
    
    let positions = match cursor_positions {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(format!("{};[out]copy[final]", base_filter)),
    };
    
    println!("Building cursor overlay filter for {} positions", positions.len());
    
    // Generate cursor image matching preview graphics
    let cursor_path = generate_cursor_image(&settings.style, settings.size, &settings.color)?;
    
    // FFmpeg movie filter path escaping for Windows:
    // - Convert backslashes to forward slashes
    // - Escape colons (C: becomes C\\:)
    // - Escape special characters
    let cursor_path_str = cursor_path.to_string_lossy()
        .replace("\\", "/")
        .replace(":", "\\:");
    
    println!("Cursor image path for FFmpeg: {}", cursor_path_str);
    
    let cursor_size = settings.size;
    
    // Calculate video offset in canvas (video is centered with base_scale)
    let margin = (1.0 - base_scale) / 2.0;
    let video_offset_x = margin * width as f64;
    let video_offset_y = margin * height as f64;
    let video_w = width as f64 * base_scale;
    let video_h = height as f64 * base_scale;
    
    // Build overlay expression for cursor position
    // We need to build a piecewise expression that evaluates cursor position based on time
    // FFmpeg overlay supports 'x' and 'y' expressions evaluated per frame
    
    // Sample positions to avoid expression length limits
    // Reduced from 200 to 100 for simpler expressions and faster export
    let max_keyframes = 100;
    let step = (positions.len() / max_keyframes).max(1);
    
    // Build x and y position expressions as nested if() statements
    // Format: if(lt(t,t1),x0,if(lt(t,t2),x1,...))
    let mut x_expr_parts: Vec<(f64, f64)> = Vec::new();
    let mut y_expr_parts: Vec<(f64, f64)> = Vec::new();
    
    for i in (0..positions.len()).step_by(step) {
        let p = &positions[i];
        let t = (p.timestamp_ms as f64 / 1000.0) - trim_start;
        
        if t < 0.0 {
            continue;
        }
        
        // Calculate pixel position: offset + normalized * video_size - cursor_half_size
        let x_pos = video_offset_x + p.x * video_w - (cursor_size as f64 / 2.0);
        let y_pos = video_offset_y + p.y * video_h - (cursor_size as f64 / 2.0);
        
        // Clamp to valid range
        let x_clamped = x_pos.max(0.0).min((width - cursor_size) as f64);
        let y_clamped = y_pos.max(0.0).min((height - cursor_size) as f64);
        
        x_expr_parts.push((t, x_clamped));
        y_expr_parts.push((t, y_clamped));
    }
    
    // Build nested if expressions for smooth interpolation
    // Use linear interpolation between keyframes
    let x_expr = build_interpolation_expr(&x_expr_parts);
    let y_expr = build_interpolation_expr(&y_expr_parts);
    
    // Load cursor image and overlay on video
    // movie filter loads the cursor, overlay composites it
    let cursor_filter = format!(
        "{base};movie='{cursor}'[cur];[out][cur]overlay=x='{x}':y='{y}':eval=frame:format=auto[final]",
        base = base_filter,
        cursor = cursor_path_str,
        x = x_expr,
        y = y_expr
    );
    
    println!("Cursor overlay filter built with {} keyframes", x_expr_parts.len());
    Ok(cursor_filter)
}

// Build interpolation expression for smooth cursor movement
// Returns FFmpeg expression that linearly interpolates between keyframes
fn build_interpolation_expr(keyframes: &[(f64, f64)]) -> String {
    if keyframes.is_empty() {
        return "0".to_string();
    }
    if keyframes.len() == 1 {
        return format!("{:.1}", keyframes[0].1);
    }
    
    // For performance, limit nesting depth by using simple piecewise constant
    // This avoids FFmpeg expression complexity issues while still being smooth enough
    // at 60fps with 200 keyframes
    
    let mut expr = format!("{:.1}", keyframes.last().unwrap().1); // Default to last value
    
    for kf in keyframes.iter().rev() {
        let (t, v) = kf;
        expr = format!("if(lt(t,{:.3}),{:.1},{})", t, v, expr);
    }
    
    expr
}

// Export settings struct for quality/resolution/format
#[derive(serde::Deserialize, Debug, Clone)]
struct ExportOptions {
    resolution: Option<String>,  // "720p", "1080p", "4k", "original"
    quality: Option<String>,     // "low", "medium", "high"
    format: Option<String>,      // "mp4", "webm"
}

// Check if hardware encoder is available
fn detect_hardware_encoder() -> Option<String> {
    // Try NVENC first (NVIDIA)
    let nvenc_test = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output();
    
    if let Ok(output) = nvenc_test {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("h264_nvenc") {
            println!("Hardware encoder detected: NVENC");
            return Some("h264_nvenc".to_string());
        }
        if stdout.contains("h264_qsv") {
            println!("Hardware encoder detected: QuickSync");
            return Some("h264_qsv".to_string());
        }
        if stdout.contains("h264_amf") {
            println!("Hardware encoder detected: AMF (AMD)");
            return Some("h264_amf".to_string());
        }
    }
    
    println!("No hardware encoder detected, using libx264");
    None
}

// Get encoding parameters based on quality setting
fn get_encoding_params(quality: &str, hw_encoder: &Option<String>) -> (String, String, String) {
    // Returns (encoder, preset, crf/quality)
    match hw_encoder {
        Some(encoder) => {
            // Hardware encoder parameters
            let (preset, qp) = match quality {
                "high" => ("p7", "18"),    // Highest quality, slower
                "medium" => ("p4", "23"),  // Balanced
                "low" => ("p1", "28"),     // Fast, lower quality
                _ => ("p4", "23"),
            };
            (encoder.clone(), preset.to_string(), qp.to_string())
        }
        None => {
            // Software encoder (libx264)
            let (preset, crf) = match quality {
                "high" => ("slower", "16"),     // Best quality
                "medium" => ("medium", "20"),   // Balanced
                "low" => ("fast", "26"),        // Fast encode
                _ => ("medium", "20"),
            };
            ("libx264".to_string(), preset.to_string(), crf.to_string())
        }
    }
}

// Get target resolution dimensions
fn get_target_resolution(resolution: &str, orig_width: i32, orig_height: i32) -> (i32, i32) {
    match resolution {
        "720p" => (1280, 720),
        "1080p" => (1920, 1080),
        "4k" => (3840, 2160),
        _ => (orig_width, orig_height),  // "original" or unknown
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
    resolution: Option<String>,
    quality: Option<String>,
    format: Option<String>,
) -> Result<String, String> {
    let duration = trim_end - trim_start;
    let bg_color = background_color.unwrap_or_else(|| "1a1a2e".to_string());
    let quality_setting = quality.unwrap_or_else(|| "high".to_string());
    let resolution_setting = resolution.unwrap_or_else(|| "original".to_string());
    let _format_setting = format.unwrap_or_else(|| "mp4".to_string());
    
    // Detect hardware encoder once at export start
    let hw_encoder = detect_hardware_encoder();
    
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
        )?;
        
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
        )?;
        
        args.push("-filter_complex".to_string());
        args.push(final_filter);
        args.push("-map".to_string());
        args.push("[final]".to_string());
    }
    
    // Get encoding parameters based on quality setting and hardware availability
    let (mut encoder, mut preset, mut crf_or_qp) = get_encoding_params(&quality_setting, &hw_encoder);
    
    // Get target resolution
    let (target_width, target_height) = get_target_resolution(&resolution_setting, width, height);
    
    // Add resolution scaling to the filter chain if needed
    // The previous blocks (effects/no-effects) pushed: -filter_complex, FILTER, -map, [final]
    // We need to pop them to append our scaling filter
    
    args.pop(); // Remove [final]
    args.pop(); // Remove -map
    let mut filter_chain = args.pop().expect("Failed to retrieve filter chain"); // Remove final_filter
    args.pop(); // Remove -filter_complex
    
    // Append scaling if needed
    if target_width != width || target_height != height {
        filter_chain = format!("{};[final]scale={}:{}:flags=lanczos[scaled]", filter_chain, target_width, target_height);
        args.push("-filter_complex".to_string());
        args.push(filter_chain);
        args.push("-map".to_string());
        args.push("[scaled]".to_string());
    } else {
        args.push("-filter_complex".to_string());
        args.push(filter_chain);
        args.push("-map".to_string());
        args.push("[final]".to_string());
    }

    // Common output args (framerate, audio, pixel format)
    // Note: pixel format is critical for compatibility
    let common_args = vec![
        "-r".to_string(), "60".to_string(),
        "-pix_fmt".to_string(), "yuv420p".to_string(),
        "-c:a".to_string(), "aac".to_string(),
        "-b:a".to_string(), "192k".to_string(),
        output_path.clone(),
    ];
    
    // Retry loop: Try Hardware (if available) -> Then Software
    let attempts = if hw_encoder.is_some() { 2 } else { 1 };
    
    for attempt in 0..attempts {
        let mut current_args = args.clone();
        
        // If this is the second attempt (attempt == 1), fall back to software
        if attempt == 1 {
            println!("Hardware encoding failed. Retrying with software encoding (libx264)...");
            encoder = "libx264".to_string();
            let params = get_encoding_params(&quality_setting, &None);
            preset = params.1;
            crf_or_qp = params.2;
        }
        
        println!("Attempt {}/{} with encoder: {}", attempt + 1, attempts, encoder);
        
        // Add encoder-specific args
        current_args.push("-c:v".to_string());
        current_args.push(encoder.clone());
        
        if encoder == "libx264" {
            current_args.extend([
                "-preset".to_string(), preset.clone(),
                "-crf".to_string(), crf_or_qp.clone(),
            ]);
        } else {
            current_args.extend([
                "-preset".to_string(), preset.clone(),
                "-qp".to_string(), crf_or_qp.clone(),
                "-rc".to_string(), "constqp".to_string(),
            ]);
        }
        
        // Add common args
        current_args.extend(common_args.clone());
        
        println!("Running FFmpeg...");
        // println!("Args: {:?}", current_args); // Debug if needed
        
        let output = Command::new("ffmpeg")
            .args(&current_args)
            .output()
            .map_err(|e| format!("Failed to execute FFmpeg: {}", e))?;
            
        if output.status.success() {
            println!("Export successful!");
            return Ok(output_path);
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            println!("FFmpeg failed with stderr: {}", stderr);
            
            // If this was the last attempt, return error
            if attempt == attempts - 1 {
                return Err(format!("FFmpeg failed: {}", stderr));
            }
            // Otherwise loop continues to retry
        }
    }
    
    Err("Export failed after retries".to_string())
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