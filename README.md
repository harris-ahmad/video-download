# video-download
download every video that you see online! nothing to worry. it's free, you don't pay anything.

## Update vendored `mux.min.js`

This project keeps `mux.min.js` as a vendored static file for extension use.

Update to latest:

```bash
npm run vendor:update:mux
```

Update to a specific version:

```bash
node scripts/update-mux.js 7.1.0
```

## One-click TS → MP4 conversion (native helper)

The extension can call a local native helper to run `ffmpeg` for conversion.

1. Get your extension ID from `chrome://extensions` (Developer mode on).
2. Install the native host manifest:

```bash
npm run native:install:macos -- <your-extension-id>
```

3. Reload the extension.
4. Use `Convert TS→MP4` in the popup download queue.

Native helper docs: `native-helper/README.md`
