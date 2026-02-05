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
    easing: Option<String>,  // "slow", "mellow", "quick", "rapid" - matches preview presets
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
    smoothing: Option<f64>,  // Lerp factor to match preview cursor movement
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
    
    // FIRST PRINCIPLES FIX: Ensure file is fully written before FFmpeg reads it
    // On first run, the file is new and may not be fully flushed to disk
    // This causes "Failed to configure input pad on Parsed_overlay" errors
    img.save(&cursor_path).map_err(|e| format!("Failed to save cursor image: {}", e))?;
    
    // Explicitly sync to ensure file is on disk (fixes intermittent first-run failures)
    if let Ok(file) = std::fs::File::open(&cursor_path) {
        let _ = file.sync_all();
    }
    
    // Verify file exists and has content
    match std::fs::metadata(&cursor_path) {
        Ok(meta) => {
            println!("Generated cursor image: {:?} ({} bytes)", cursor_path, meta.len());
        }
        Err(e) => {
            return Err(format!("Cursor image not found after save: {}", e));
        }
    }
    
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
// FIRST PRINCIPLES RESTRUCTURE: 
// The cursor is overlaid on the raw video BEFORE any zoom/scale transforms.
// This means the cursor becomes part of the video content and naturally
// scales with it when zoom effects are applied.
// 
// Input: raw video stream
// Output: video stream with cursor baked in, ready for zoom processing
fn build_cursor_overlay_on_video(
    cursor_positions: &Option<Vec<CursorFrame>>,
    cursor_settings: &Option<CursorExportSettings>,
    video_width: i32,
    video_height: i32,
    trim_start: f64,
) -> Result<Option<String>, String> {
    // If no cursor settings or not visible, return None (no filter needed)
    let settings = match cursor_settings {
        Some(s) if s.visible => s,
        _ => return Ok(None),
    };
    
    let positions = match cursor_positions {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(None),
    };
    
    println!("Building cursor overlay for {} positions (applying to raw video)", positions.len());
    
    // Generate cursor image matching preview graphics
    let cursor_path = generate_cursor_image(&settings.style, settings.size, &settings.color)?;
    
    // FFmpeg movie filter path escaping for Windows
    let cursor_path_str = cursor_path.to_string_lossy()
        .replace("\\", "/")
        .replace(":", "\\:");
    
    println!("Cursor image path for FFmpeg: {}", cursor_path_str);
    
    let cursor_size = settings.size;
    
    // FIRST PRINCIPLES: Cursor positions are normalized (0-1) relative to the video content.
    // Since we're overlaying directly on the raw video (before any scaling),
    // we just convert normalized (0-1) to actual video pixel coordinates.
    // The cursor center should be at (x * width, y * height), so we subtract half cursor size.
    
    // FIRST PRINCIPLES: Balance smoothness vs FFmpeg expression complexity
    // WARNING: Too many keyframes causes "Error reinitializing filters!" because
    // each keyframe adds a nested if() statement, and FFmpeg has parser limits.
    // 100 keyframes is a safe limit that still provides smooth cursor movement.
    // At 60fps over 10s = 600 frames, 100 keyframes = 1 keyframe every 6 frames (acceptable)
    let max_keyframes = 100;  // Reduced from 500 to prevent FFmpeg expression overflow
    let step = (positions.len() / max_keyframes).max(1);
    
    let mut x_expr_parts: Vec<(f64, f64)> = Vec::new();
    let mut y_expr_parts: Vec<(f64, f64)> = Vec::new();
    
    for i in (0..positions.len()).step_by(step) {
        let p = &positions[i];
        let t = (p.timestamp_ms as f64 / 1000.0) - trim_start;
        
        if t < 0.0 {
            continue;
        }
        
        // Direct mapping: normalized position to pixels, centered
        let x_pos = p.x * video_width as f64 - (cursor_size as f64 / 2.0);
        let y_pos = p.y * video_height as f64 - (cursor_size as f64 / 2.0);
        
        // Clamp to valid range
        let x_clamped = x_pos.max(0.0).min((video_width - cursor_size) as f64);
        let y_clamped = y_pos.max(0.0).min((video_height - cursor_size) as f64);
        
        x_expr_parts.push((t, x_clamped));
        y_expr_parts.push((t, y_clamped));
    }
    
    if x_expr_parts.is_empty() {
        return Ok(None);
    }
    
    // Build interpolation expressions
    let x_expr = build_interpolation_expr(&x_expr_parts);
    let y_expr = build_interpolation_expr(&y_expr_parts);
    
    // Return filter that overlays cursor on input video
    // This filter transforms [0:v] into [vcur] (video with cursor)
    let cursor_filter = format!(
        "movie='{cursor}'[cur];[0:v][cur]overlay=x='{x}':y='{y}':eval=frame:format=auto[vcur]",
        cursor = cursor_path_str,
        x = x_expr,
        y = y_expr
    );
    
    println!("Cursor overlay filter built with {} keyframes", x_expr_parts.len());
    Ok(Some(cursor_filter))
}

// Build interpolation expression for smooth cursor movement
// FIRST PRINCIPLES: Linear interpolation between keyframes, not step functions
// Preview uses lerp: newPos = oldPos + (targetPos - oldPos) * smoothing
// FFmpeg equivalent: lerp(a, b, t) = a + (b-a) * clamp((time-t1)/(t2-t1), 0, 1)
fn build_interpolation_expr(keyframes: &[(f64, f64)]) -> String {
    if keyframes.is_empty() {
        return "0".to_string();
    }
    if keyframes.len() == 1 {
        return format!("{:.2}", keyframes[0].1);
    }
    
    // FIRST PRINCIPLES FIX: Use proper linear interpolation between keyframes
    // Instead of step functions that cause jitter, we linearly blend between
    // adjacent keyframe values based on time position.
    //
    // For each segment [t1, t2] with values [v1, v2]:
    // lerp_t = clamp((t - t1) / (t2 - t1), 0, 1)
    // value = v1 + (v2 - v1) * lerp_t
    //
    // We build a nested expression that handles segments in order.
    
    // Start with the last value as default (for times beyond last keyframe)
    let mut expr = format!("{:.2}", keyframes.last().unwrap().1);
    
    // Build expression from end to start (for proper nesting)
    // Each segment handles times in [t_i, t_{i+1}] with linear interpolation
    for i in (0..keyframes.len() - 1).rev() {
        let (t1, v1) = keyframes[i];
        let (t2, v2) = keyframes[i + 1];
        let dt = t2 - t1;
        
        if dt <= 0.0 {
            continue; // Skip invalid segments
        }
        
        // Linear interpolation: v1 + (v2 - v1) * ((t - t1) / dt)
        // Clamp to [0, 1] range using min/max
        let dv = v2 - v1;
        
        // FFmpeg lerp expression for this segment
        // lerp_t = min(1, max(0, (t-t1)/dt))
        // result = v1 + dv * lerp_t
        let lerp_expr = format!(
            "{v1:.2}+{dv:.4}*min(1,max(0,(t-{t1:.4})/{dt:.4}))",
            v1 = v1, dv = dv, t1 = t1, dt = dt
        );
        
        // If time is in this segment's range, use lerp; otherwise use previous expr
        expr = format!("if(lt(t,{t2:.4}),{lerp},{prev})",
            t2 = t2, lerp = lerp_expr, prev = expr
        );
    }
    
    // Handle times before first keyframe
    let (t0, v0) = keyframes[0];
    expr = format!("if(lt(t,{t0:.4}),{v0:.2},{expr})", t0 = t0, v0 = v0, expr = expr);
    
    expr
}


// FIRST PRINCIPLES: Build dynamic pan expressions that follow cursor during zoom
// 
// ANTICIPATION TIMING MODEL (matches preview exactly):
// - Zoom-in phase (effect_start to zoom_in_end): pan stays at initial target, zoom animates in
// - Hold phase (zoom_in_end to zoom_out_start): follow cursor with exponential smoothing (0.12 lerp per frame)
// - Zoom-out phase (zoom_out_start to effect_end): maintain last position, zoom animates out
//
// With anticipation, effect_start = startTime - easingDuration (zoom begins BEFORE the click)
// and zoom_in_end = startTime (fully zoomed AT the click moment)
//
// Key insight: Preview uses exponential smoothing which creates natural deceleration.
// We simulate this by generating keyframes at 60fps with the same lerp formula.
fn build_dynamic_pan_during_effect(
    positions: &Vec<CursorFrame>,
    effect_start: f64,
    zoom_in_end: f64,
    zoom_out_start: f64,
    effect_end: f64,
    initial_x: f64,
    initial_y: f64,
    trim_start: f64,
    zoom_scale: f64,  // Added: needed for viewport clamping
) -> (String, String) {
    // If no positions, return static target
    if positions.is_empty() {
        println!("  Dynamic pan: no cursor data, using static target ({:.3}, {:.3})", initial_x, initial_y);
        return (format!("{:.4}", initial_x), format!("{:.4}", initial_y));
    }
    
    // VIEWPORT CLAMPING: Prevent pan from showing outside video bounds when zoomed
    // When zoomed in, the viewport center must stay within bounds so edges don't show black
    // min_center = 0.5 / scale, max_center = 1 - min_center
    let min_center = 0.5 / zoom_scale;
    let max_center = 1.0 - min_center;
    
    // Clamp initial position
    let initial_x_clamped = initial_x.max(min_center).min(max_center);
    let initial_y_clamped = initial_y.max(min_center).min(max_center);
    
    // SIMULATE FRAME-BY-FRAME SMART VIEWPORT PANNING
    // Preview uses smart panning: only move viewport when cursor approaches edges
    // Inner container: 70% of viewport, Outer margin: 15% on each edge
    let fps = 60.0;
    let inner_margin = 0.15;  // Match preview INNER_MARGIN
    let pan_speed = 0.08;     // Match preview PAN_SPEED
    let effect_duration = effect_end - effect_start;
    let total_frames = (effect_duration * fps).ceil() as usize;
    
    // Calculate viewport size at zoom scale
    let half_viewport = 0.5 / zoom_scale;
    let inner_half = half_viewport * (1.0 - 2.0 * inner_margin);
    
    // Convert positions to a lookup structure for efficient time-based access
    let effect_start_ms = ((effect_start + trim_start) * 1000.0) as u64;
    let effect_end_ms = ((effect_end + trim_start) * 1000.0) as u64;
    
    // Collect positions during effect for lookup
    let mut effect_positions: Vec<(u64, f64, f64)> = Vec::new(); // (timestamp_ms, x, y)
    for pos in positions.iter() {
        if pos.timestamp_ms >= effect_start_ms && pos.timestamp_ms <= effect_end_ms {
            effect_positions.push((pos.timestamp_ms, pos.x, pos.y));
        }
    }
    
    if effect_positions.is_empty() {
        println!("  Dynamic pan: no cursor data in effect range, using clamped target ({:.3}, {:.3})", 
                 initial_x_clamped, initial_y_clamped);
        return (format!("{:.4}", initial_x_clamped), format!("{:.4}", initial_y_clamped));
    }
    
    // Binary search helper to find cursor position at a given time
    fn get_cursor_at_time_ms(positions: &[(u64, f64, f64)], time_ms: u64) -> Option<(f64, f64)> {
        if positions.is_empty() {
            return None;
        }
        // Find the position closest to time_ms
        let idx = positions.partition_point(|p| p.0 < time_ms);
        if idx == 0 {
            return Some((positions[0].1, positions[0].2));
        }
        if idx >= positions.len() {
            let last = positions.last().unwrap();
            return Some((last.1, last.2));
        }
        // Interpolate between adjacent positions
        let before = &positions[idx - 1];
        let after = &positions[idx];
        let range = after.0 - before.0;
        if range == 0 {
            return Some((before.1, before.2));
        }
        let t = (time_ms - before.0) as f64 / range as f64;
        Some((
            before.1 + (after.1 - before.1) * t,
            before.2 + (after.2 - before.2) * t,
        ))
    }
    
    // Generate keyframes with smart panning at 60fps
    let mut x_keyframes: Vec<(f64, f64)> = Vec::new();
    let mut y_keyframes: Vec<(f64, f64)> = Vec::new();
    
    // Start with clamped initial position
    let mut current_x = initial_x_clamped;
    let mut current_y = initial_y_clamped;
    
    // Sample every N frames to keep expression size reasonable
    // CRITICAL: FFmpeg has limits on expression complexity. Keep keyframes <= 40
    // to prevent "Error reinitializing filters" from overly nested if() expressions.
    // We still simulate at 60fps internally for smooth interpolation.
    let max_output_keyframes = 40;
    let sample_step = (total_frames / max_output_keyframes).max(1);
    
    for frame in 0..=total_frames {
        let t = effect_start + (frame as f64 / fps);
        let time_ms = ((t + trim_start) * 1000.0) as u64;
        
        // Determine which phase we're in
        if t < zoom_in_end {
            // ZOOM-IN PHASE: Stay at initial target (no cursor following)
            // Just keep current position (already set to initial)
        } else if t < zoom_out_start {
            // HOLD PHASE: Smart viewport panning (match preview exactly)
            if let Some((cursor_x, cursor_y)) = get_cursor_at_time_ms(&effect_positions, time_ms) {
                // Calculate cursor position relative to viewport center
                let rel_x = cursor_x - current_x;
                let rel_y = cursor_y - current_y;
                
                // Only pan if cursor is outside inner container
                if rel_x.abs() > inner_half {
                    let direction = if rel_x > 0.0 { 1.0 } else { -1.0 };
                    let overshoot = rel_x.abs() - inner_half;
                    current_x += direction * pan_speed * overshoot * 2.0;
                }
                if rel_y.abs() > inner_half {
                    let direction = if rel_y > 0.0 { 1.0 } else { -1.0 };
                    let overshoot = rel_y.abs() - inner_half;
                    current_y += direction * pan_speed * overshoot * 2.0;
                }
                
                // Clamp to viewport bounds
                current_x = current_x.max(min_center).min(max_center);
                current_y = current_y.max(min_center).min(max_center);
            }
        }
        // ZOOM-OUT PHASE: Maintain last position (don't update current_x/y)
        
        // Add keyframe at sample points
        if frame % sample_step == 0 || frame == total_frames {
            x_keyframes.push((t, current_x));
            y_keyframes.push((t, current_y));
        }
    }
    
    println!("  Dynamic pan: built {} keyframes with smart viewport panning (inner_margin={:.2})", 
             x_keyframes.len(), inner_margin);
    println!("  Viewport clamped to [{:.3}, {:.3}] based on zoom scale {:.2}", 
             min_center, max_center, zoom_scale);
    
    // Build interpolation expressions
    let x_expr = build_interpolation_expr(&x_keyframes);
    let y_expr = build_interpolation_expr(&y_keyframes);
    
    (x_expr, y_expr)
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
    // FIRST PRINCIPLES: Accept canvas settings to match preview exactly
    padding_percent: Option<f64>,
    border_radius: Option<i32>,
) -> Result<String, String> {
    let duration = trim_end - trim_start;
    let bg_color = background_color.unwrap_or_else(|| "1a1a2e".to_string());
    let quality_setting = quality.unwrap_or_else(|| "high".to_string());
    let resolution_setting = resolution.unwrap_or_else(|| "original".to_string());
    let _format_setting = format.unwrap_or_else(|| "mp4".to_string());
    
    // FIRST PRINCIPLES: Use padding_percent from preview to calculate base_scale
    // Preview: padding creates margins around video, reducing visible video size
    // Export: base_scale = 1.0 - (2 * padding_percent / 100) to match
    // E.g., 5% padding = 10% total margin = 0.90 scale
    let padding = padding_percent.unwrap_or(5.0);
    let _border_rad = border_radius.unwrap_or(12);
    
    // Detect hardware encoder once at export start
    let hw_encoder = detect_hardware_encoder();
    
    println!("=== EXPORT WITH EFFECTS (Zoomed-Out Canvas) ===");
    println!("Input: {}", input_path);
    println!("Output: {}", output_path);
    println!("Trim: {:.2} - {:.2} (duration: {:.2})", trim_start, trim_end, duration);
    println!("Background color: #{}", bg_color);
    println!("Padding: {:.1}%, Border radius: {}px", padding, _border_rad);
    println!("Effects received: {}", effects.len());
    for (i, eff) in effects.iter().enumerate() {
        println!("  Effect {}: time={:.2}-{:.2}, scale={:.2}, target=({:.3},{:.3}), easing={:?}", 
            i, eff.start_time, eff.end_time, eff.scale, eff.target_x, eff.target_y, eff.easing);
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
    
    // === ZOOMED-OUT CANVAS APPROACH (FIRST PRINCIPLES FIX) ===
    // CRITICAL: base_scale must match preview's paddingPercent setting
    // Preview applies padding as: style={{ padding: `${paddingPercent}%` }}
    // This creates a margin on all sides, effectively scaling video down
    // Formula: base_scale = 1.0 - (2 * padding / 100)
    // Examples:
    //   5% padding = 0.90 scale (10% total padding)
    //   10% padding = 0.80 scale (20% total padding)
    //   0% padding = 1.0 scale (no padding, full frame)
    
    let base_scale = 1.0 - (2.0 * padding / 100.0);
    let margin = (1.0 - base_scale) / 2.0;
    
    println!("FIRST PRINCIPLES: padding={}% → base_scale={:.3}, margin={:.1}%", 
             padding, base_scale, margin * 100.0);
    
    if !effects.is_empty() {
        println!("Building filter for {} zoom effects (with per-effect easing)", effects.len());
        
        // FIRST PRINCIPLES: Match preview's zoom behavior exactly
        // Preview uses smoothstep: t * t * (3 - 2 * t) for smooth in/out
        // Preview follows cursor during hold phase with 0.12 smoothing
        
        // NOTE: ease duration is now PER-EFFECT, moved inside the loop
        
        // Build zoom expressions with SMOOTHSTEP easing (matches preview exactly)
        // Smoothstep formula: t² × (3 - 2t) where t = normalized time (0-1)
        let mut zoom_parts: Vec<String> = Vec::new();
        let mut x_parts: Vec<String> = Vec::new();
        let mut y_parts: Vec<String> = Vec::new();
        
        for eff in effects.iter() {
            // FIRST PRINCIPLES: Use per-effect easing duration
            // Preview maps easing presets to duration: slow=0.5, mellow=0.35, quick=0.2, rapid=0.1
            let ease = match eff.easing.as_ref().map(|s| s.as_str()) {
                Some("slow") => 0.5,
                Some("quick") => 0.2,
                Some("rapid") => 0.1,
                _ => 0.35, // "mellow" is default
            };
            
            // Adjust times relative to trim start
            let s = eff.start_time - trim_start;
            let e = eff.end_time - trim_start;
            let zoom_scale = eff.scale;
            let tx = eff.target_x;
            let ty = eff.target_y;
            
            // Skip effects outside the trimmed range
            // With anticipation, effect starts earlier at (s - ease)
            let anticipation_start = (s - ease).max(0.0); // Clamp to 0 if before video start
            if e < 0.0 || anticipation_start > duration {
                println!("  Skipping effect (outside trim range)");
                continue;
            }
            
            // ANTICIPATION TIMING MODEL (matches preview exactly):
            // - Zoom-in: from (s - ease) to s → fully zoomed AT s (the click moment)
            // - Hold: from s to (e - ease)
            // - Zoom-out: from (e - ease) to e
            let so = e - ease;  // Start of zoom-out phase
            let delta = zoom_scale - 1.0;
            
            println!("Effect: time={:.2}-{:.2} (anticipation starts at {:.2}), zoom={:.2}, target=({:.3},{:.3}), ease={:.2}s", 
                anticipation_start, e, s, zoom_scale, tx, ty, ease);
            
            // SMOOTHSTEP ZOOM EXPRESSION with ANTICIPATION
            // For zoom-in (anticipation_start to s): intensity = smoothstep((t-anticipation_start)/ease)
            // For hold (s to so): intensity = 1 (fully zoomed)
            // For zoom-out (so to e): intensity = smoothstep((e-t)/ease)
            // 
            // smoothstep(t) = t*t*(3-2*t)
            let zoom_expr = format!(
                "if(between(t,{ant_s},{e}),\
                    if(lt(t,{s}),\
                        1+{delta}*pow((t-{ant_s})/{ease},2)*(3-2*(t-{ant_s})/{ease}),\
                        if(lt(t,{so}),\
                            {zoom_scale},\
                            1+{delta}*pow(({e}-t)/{ease},2)*(3-2*({e}-t)/{ease})\
                        )\
                    ),\
                1)",
                ant_s = anticipation_start, s = s, so = so, e = e, zoom_scale = zoom_scale, delta = delta, ease = ease
            );
            zoom_parts.push(format!("if(between(t,{},{}),{},0)", anticipation_start, e, zoom_expr));
            
            // CURSOR-FOLLOWING PAN with anticipation timing
            // - Zoom-in phase (anticipation_start to s): pan to initial target
            // - Hold phase (s to so): smoothly follow cursor position frame-by-frame
            // - Zoom-out phase (so to e): maintain last position
            
            // Build dynamic pan expressions based on cursor positions during effect
            let (pan_x_expr, pan_y_expr) = if let Some(ref positions) = cursor_positions {
                build_dynamic_pan_during_effect(positions, anticipation_start, s, so, e, tx, ty, trim_start, zoom_scale)
            } else {
                // No cursor data, use static target
                (format!("{:.4}", tx), format!("{:.4}", ty))
            };
            
            // FIRST PRINCIPLES: Match preview's exact transform formula
            // Preview: translateX = (0.5 - viewportX) * (scale - 1) * 100%
            // 
            // In FFmpeg, we overlay the scaled video on a canvas.
            // The video is scaled by base_scale * zoom, so its size is: iw * base * zoom
            // The centered position is: (canvas_w - video_w) / 2
            // To pan to target: we need to offset so the target point is at canvas center
            //
            // When zoomed, the target pixel in video is at: pan_x * video_w (from left edge of video)
            // We want this pixel to be at canvas center: canvas_w / 2
            // So video left edge should be at: canvas_w/2 - pan_x * video_w
            // Normal centered position is: (canvas_w - video_w) / 2
            // Offset from centered = target_position - centered_position
            //                      = canvas_w/2 - pan_x * video_w - (canvas_w - video_w)/2
            //                      = canvas_w/2 - pan_x * video_w - canvas_w/2 + video_w/2
            //                      = video_w * (0.5 - pan_x)
            //                      = (iw * base * zoom) * (0.5 - pan_x)
            //
            // This is the key formula that matches preview behavior!
            
            // x_offset = (0.5 - pan_x) * iw * base_scale * zoom_factor
            // But since video_w = iw * base * zoom = width * base * zoom (for 1:1 aspect)
            // We can express as: (0.5 - pan_expr) * width * base_scale * (zoom_expr)
            
            let x_offset_formula = format!("(0.5-({pan}))*{w}*{base}*({zoom_expr})", 
                pan = pan_x_expr,
                w = width,
                base = base_scale,
                zoom_expr = zoom_expr);
            let y_offset_formula = format!("(0.5-({pan}))*{h}*{base}*({zoom_expr})", 
                pan = pan_y_expr,
                h = height,
                base = base_scale,
                zoom_expr = zoom_expr);
            
            x_parts.push(format!("if(between(t,{},{}),{},0)", anticipation_start, e, x_offset_formula));
            y_parts.push(format!("if(between(t,{},{}),{},0)", anticipation_start, e, y_offset_formula));
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
        
        // FIRST PRINCIPLES: Apply cursor overlay to raw video BEFORE zoom transforms
        // This way the cursor becomes part of the video content and scales with it
        let cursor_overlay = build_cursor_overlay_on_video(
            &cursor_positions,
            &cursor_settings,
            width,
            height,
            trim_start,
        )?;
        
        // Determine input stream for zoom processing
        // If cursor overlay exists, use [vcur]; otherwise use [0:v]
        let (cursor_prefix, video_input) = match &cursor_overlay {
            Some(filter) => (format!("{};", filter), "[vcur]"),
            None => (String::new(), "[0:v]"),
        };
        
        // Build the complete filter chain using overlay approach
        // 1. (Optional) Apply cursor overlay to raw video
        // 2. Create background canvas at output size
        // 3. Scale video (with cursor) by base_scale * zoom_factor
        // 4. Overlay video centered on canvas with offset for target
        
        let filter = format!(
            "{cursor_prefix}color=c=0x{bg}:s={w}x{h}:d={dur}[bg];\
             {input}scale=w='iw*{base}*({zoom})':h='ih*{base}*({zoom})':eval=frame:flags=lanczos[vid];\
             [bg][vid]overlay=x='({w}-overlay_w)/2+({x_off})':y='({h}-overlay_h)/2+({y_off})':eval=frame[final]",
            cursor_prefix = cursor_prefix,
            bg = bg_color,
            w = width,
            h = height,
            dur = duration,
            input = video_input,
            base = base_scale,
            zoom = zoom_combined,
            x_off = x_offset,
            y_off = y_offset
        );
        
        println!("Filter: {}", filter);
        
        args.push("-filter_complex".to_string());
        args.push(filter);
        args.push("-map".to_string());
        args.push("[final]".to_string());
    } else {
        // No zoom effects - just apply base scale with background
        
        // FIRST PRINCIPLES: Apply cursor overlay to raw video BEFORE scaling
        let cursor_overlay = build_cursor_overlay_on_video(
            &cursor_positions,
            &cursor_settings,
            width,
            height,
            trim_start,
        )?;
        
        // Determine input stream for scaling
        let (cursor_prefix, video_input) = match &cursor_overlay {
            Some(filter) => (format!("{};", filter), "[vcur]"),
            None => (String::new(), "[0:v]"),
        };
        
        let filter = format!(
            "{cursor_prefix}color=c=0x{bg}:s={w}x{h}:d={dur}[bg];\
             {input}scale=w='iw*{base}':h='ih*{base}':flags=lanczos[vid];\
             [bg][vid]overlay=x='({w}-overlay_w)/2':y='({h}-overlay_h)/2'[final]",
            cursor_prefix = cursor_prefix,
            bg = bg_color,
            w = width,
            h = height,
            dur = duration,
            input = video_input,
            base = base_scale
        );
        
        println!("Filter (no effects): {}", filter);
        
        args.push("-filter_complex".to_string());
        args.push(filter);
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