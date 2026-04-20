# Native Helper (macOS)

This helper enables one-click `TS -> MP4` conversion from the extension using native messaging + local `ffmpeg`.

## Prerequisites

- macOS
- Node.js installed
- `ffmpeg` installed and available in `PATH`
- Chrome extension loaded (you need its extension ID)

## Install host manifest

From repo root:

```bash
npm run native:install:macos -- <your-extension-id>
```

Example:

```bash
npm run native:install:macos -- abcdefghijklmnopqrstuvwxyzabcdef
```

The script installs:

- Host manifest at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.harrisahmad.video_download_helper.json`
- Executable host at `native-helper/index.js`

## Manual local test (without Chrome)

```bash
node native-helper/test-host.js /absolute/path/to/file.ts
```

If successful, helper returns JSON with `success: true` and `outputPath`.
