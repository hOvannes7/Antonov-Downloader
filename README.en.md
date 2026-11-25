# Antonov Downloader

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Chrome extension for downloading videos from antonov.media**

---

**[🇷🇺 Русская версия](README.md)**

## 📌 Description

Antonov Downloader is a Google Chrome browser extension that allows you to download videos from [antonov.media](https://www.antonov.media). The extension finds the HLS stream (`.m3u8`), downloads all segments, and assembles them into a single `.mp4` file.

## ✨ Features

- 🎯 **Automatic video detection** — the extension finds the video stream automatically
- 📥 **High quality download** — downloads the best available stream
- 📝 **Named files** — video title is taken from the page
- 🎨 **UI integration** — download button next to the "Like" button
- 📊 **Progress indicator** — displayed at the bottom of the page
- ⚡ **Fast loading** — segments are downloaded in parallel
- 🎞️ **Lossless MP4** — video is remuxed without re-encoding
- 🔄 **Works when navigating between videos** — no page reload needed

## 🚀 Installation

### From Repository

1. Clone the repository:
   ```bash
   git clone https://github.com/hOvannes7/antonov-downloader.git
   cd antonov-downloader
   ```

2. Open Chrome and go to `chrome://extensions/`

3. Enable **Developer Mode** (toggle in the top right corner)

4. Click **Load unpacked**

5. Select the `antonov-downloader` folder (the one containing `manifest.json`)

## 📖 Usage

1. Open any video at `www.antonov.media/watch*` (navigating between videos without a page reload is supported)
2. Wait for the video player to load
3. The **⬇ Download** button will appear to the left of the "Like" button
4. Click the button — the download starts and the file is saved as `.mp4`
5. Wait for the download to complete

## 📁 Project Structure

```
antonov-downloader/
├── .github/ISSUE_TEMPLATE/  # Issue templates
├── icons/                   # Icons
├── utils/
│   ├── downloader.js        # HLS utilities (playlists, segment download)
│   └── ts2mp4.js            # MPEG-TS → MP4 remuxer (no re-encoding)
├── content.js               # Page script
├── manifest.json            # Extension manifest
├── styles.css               # Styles
├── CONTRIBUTING.md / CONTRIBUTING.en.md
├── LICENSE
└── README.md / README.en.md
```

## ⚠️ Important Information

- Videos are saved as `.mp4`: MPEG-TS segments (H.264 + AAC) are remuxed into MP4 right in the browser, **without re-encoding** — quality is unchanged
- If the stream is unusual (e.g. HEVC or AC-3 audio), remuxing is skipped and the file is saved as `.ts` — the progress widget will say so
- A `.ts` file plays in most players (VLC, MPC-HC, PotPlayer) and can be converted manually:
  ```bash
  ffmpeg -i video.ts -c copy video.mp4
  ```
- To always save the raw `.ts`, set `OUTPUT_MP4 = false` at the top of `content.js`

## 🛠️ Troubleshooting

| Issue | Solution |
|-------|----------|
| Button doesn't appear | Wait for the player to load; if it doesn't help, refresh the page |
| Video not found | Start playback and retry; check for `.m3u8` requests in DevTools → Network |
| Stream is encrypted | Encrypted HLS streams (`#EXT-X-KEY`) are not supported |
| File doesn't download | One of the video parts failed to load — retry (the error text is shown in the progress widget) |
| CORS error | Some videos may require authorization |

## 📝 Notes

- If the site uses DRM protection — downloading is not possible
- Some videos may require cookies/authorization
- For debugging, set `DEBUG = true` at the top of `content.js` and open the console on a video page

## ⚖️ Disclaimer

This is an unofficial project and is not affiliated with antonov.media. The extension is intended for personal use: download only what you are entitled to save, and follow the site's rules and the laws of your country. The author is not responsible for how the extension is used.

## 🤝 Contributing

Welcome:
- Bug reports
- Feature suggestions
- Pull Requests

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.

## 📄 License

MIT — see [LICENSE](LICENSE) file for details.

## 📞 Contact

- **GitHub Issues**: [Report a bug](https://github.com/hOvannes7/antonov-downloader/issues)

---

MIT © 2026 Antonov Downloader
