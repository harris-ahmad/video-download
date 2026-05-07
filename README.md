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

## One-click TS → MP4 conversion (no native setup)

The extension performs TS → MP4 conversion directly in-browser using `ffmpeg.wasm`.

No terminal commands or OS-level helper install are required.
Just reload the extension and use `Convert TS→MP4` in the popup download queue.
