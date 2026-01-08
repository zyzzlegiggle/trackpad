# Trackpad

A lightweight, high-performance desktop video recorder with built-in video editing capabilities. Built with Tauri, React, and Rust for minimal resource usage and native performance.

## Features

- **Screen Recording** - Capture your entire screen or specific application windows
- **High Frame Rate** - Record at up to 60 FPS with hardware-accelerated encoding
- **Built-in Editor** - Trim recordings before saving without external software
- **Low Resource Usage** - Minimal CPU and RAM footprint during recording
- **Temp-First Workflow** - Recordings save to temp folder first, allowing you to preview and edit before committing to final location

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | React + TypeScript |
| Backend | Rust |
| Framework | Tauri v2 |
| Capture | Windows Capture API |
| Encoding | FFmpeg (libx264) |

## Prerequisites

Before running the application, ensure you have the following installed:

- [Node.js](https://nodejs.org/) (v18 or later)
- [Rust](https://rustup.rs/) (latest stable)
- [FFmpeg](https://ffmpeg.org/) - must be available in your system PATH
- Windows 10/11 (required for Windows Capture API)

### Installing FFmpeg

1. Download FFmpeg from [https://ffmpeg.org/download.html](https://ffmpeg.org/download.html)
2. Extract to a folder (e.g., `C:\ffmpeg`)
3. Add `C:\ffmpeg\bin` to your system PATH environment variable
4. Verify installation: `ffmpeg -version`

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd visualcoder

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## Usage

### Recording

1. Launch the application
2. Select your capture source:
   - **Full Screen** - Records the primary monitor
   - **Window** - Select a specific application window
3. Click **Record** to start recording
4. Click **Stop** to end the recording

### Editing

After stopping a recording, the built-in editor opens automatically:

1. **Preview** - Click the video to play/pause
2. **Trim** - Drag the purple handles on the timeline to set start and end points
3. **Keep Original** - Save the full recording without changes
4. **Export Trimmed** - Save only the selected portion

Saved videos are stored in your Videos folder (`C:\Users\<username>\Videos`).

## Project Structure

```
video-recorder/
├── src/                    # React frontend
│   ├── App.tsx            # Main recorder UI
│   ├── VideoEditor.tsx    # Built-in video editor
│   └── *.css              # Styling
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── lib.rs         # Tauri commands & setup
│   │   ├── recorder.rs    # Screen capture logic
│   │   └── main.rs        # Entry point
│   ├── Cargo.toml         # Rust dependencies
│   └── tauri.conf.json    # Tauri configuration
└── package.json           # Node dependencies
```

## Configuration

Key settings in `src-tauri/tauri.conf.json`:

- **Asset Protocol Scope** - Defines which directories the app can access for video playback
- **Window Settings** - Configure default window size and overlay properties

## Development

### Running Tests

```bash
# Frontend tests
npm test

# Rust tests
cd src-tauri && cargo test
```

### Building for Release

```bash
npm run tauri build
```

The built executable will be in `src-tauri/target/release/`.

## Known Limitations

- Windows only (uses Windows Capture API)
- Requires FFmpeg to be installed and in PATH
- Single monitor capture (multi-monitor support planned)

## License

MIT License - See LICENSE file for details.

## Acknowledgments

- [Tauri](https://tauri.app/) - Framework for building desktop apps
- [windows-capture](https://crates.io/crates/windows-capture) - Rust bindings for Windows Capture API
- [FFmpeg](https://ffmpeg.org/) - Video encoding
