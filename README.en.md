<div align="center">

<img src="icons/128.png" width="96" alt="Antonov Downloader">

# Antonov Downloader

**Chrome extension for downloading videos from [antonov.media](https://www.antonov.media)**

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)
![Chrome](https://img.shields.io/badge/Chrome-extension-green.svg)

**[🇷🇺 Русская версия](README.md)**

</div>

---

## ✨ Features

- 🎯 **Automatic video detection** — the extension finds the stream by itself
- 📥 **Best quality** — the highest quality variant is downloaded
- 🎞️ **Lossless MP4** — video is remuxed without re-encoding
- 📝 **Proper file names** — the title is taken from the page
- 🎨 **Built-in button** — sits next to "Like" and looks native
- 📊 **Progress indicator** — with a cancel option
- ⚡ **Fast loading** — segments are downloaded in parallel

## 🚀 Installation

1. Get the project: `git clone https://github.com/hOvannes7/Antonov-Downloader.git` (or **Code → Download ZIP** on GitHub and unzip)
2. Open `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder

## 📖 Usage

1. Open a video on [antonov.media](https://www.antonov.media)
2. Wait for the player to load
3. Click **⬇ Download** to the left of the "Like" button
4. The file is saved as `.mp4`

## 🛠️ Troubleshooting

| Issue | Solution |
|-------|----------|
| Button doesn't appear | Wait for the player to load or refresh the page |
| "Video not found" | Start playback and click the button again |
| "Stream is encrypted" | Encrypted streams (`#EXT-X-KEY`) are not supported |
| Download error | One of the video parts failed to download — try again |
| Got a `.ts` instead of `.mp4` | The stream is non-standard (e.g. HEVC) and can't be remuxed. The file plays in VLC and can be converted with `ffmpeg -i video.ts -c copy video.mp4` |

For debugging, set `DEBUG = true` at the top of `content.js` and open the console on a video page.

## ⚖️ Disclaimer

This is an unofficial project and is not affiliated with antonov.media. The extension is intended for personal use: download only what you are entitled to save, and follow the site's rules and the laws of your country. The author is not responsible for how the extension is used.

---

<div align="center">

MIT © 2026 Antonov Downloader · [Report a bug](https://github.com/hOvannes7/Antonov-Downloader/issues)

</div>
