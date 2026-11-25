// utils/downloader.js — HLS-утилиты.
// Подключается в manifest.json как обычный скрипт ПЕРЕД content.js (ES-модули в
// content scripts не работают), поэтому всё живёт в глобальном объекте AntonovHLS.
(function (global) {
    'use strict';

    const M3U8_RE = /\.m3u8(?:$|[?#])/i;

    function isM3U8Url(url) {
        return typeof url === 'string' && M3U8_RE.test(url);
    }

    /** Корректно разрешает относительные / корневые / «../» пути и ссылки с query-токенами. */
    function resolveUrl(ref, base) {
        try {
            return new URL(ref, base).href;
        } catch {
            return null;
        }
    }

    /** Разбирает атрибуты тега: #EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="a,b" */
    function parseAttributes(line) {
        const attrs = {};
        const body = line.slice(line.indexOf(':') + 1);
        const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
        let m;
        while ((m = re.exec(body))) attrs[m[1]] = m[2].replace(/^"|"$/g, '');
        return attrs;
    }

    /** 'master' | 'media' | 'unknown' */
    function getKind(text) {
        if (!/^\s*#EXTM3U/.test(text)) return 'unknown';
        if (/^#EXT-X-STREAM-INF/m.test(text)) return 'master';
        if (/^#EXTINF/m.test(text)) return 'media';
        return 'unknown';
    }

    /** Варианты качества из master-плейлиста, лучший — первый. */
    function parseMaster(text, baseUrl) {
        const lines = text.split(/\r?\n/).map(l => l.trim());
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
            const attrs = parseAttributes(lines[i]);
            let j = i + 1;
            while (j < lines.length && !lines[j]) j++;
            if (j >= lines.length || lines[j].startsWith('#')) continue;
            const url = resolveUrl(lines[j], baseUrl);
            if (!url) continue;
            const height = Number((attrs.RESOLUTION || '').split('x')[1]) || 0;
            variants.push({
                url,
                bandwidth: Number(attrs.BANDWIDTH) || 0,
                height,
                resolution: attrs.RESOLUTION || 'unknown'
            });
        }
        return variants.sort((a, b) => b.bandwidth - a.bandwidth || b.height - a.height);
    }

    /** Сегменты media-плейлиста + признаки того, что поток мы скачать не сможем. */
    function parseMedia(text, baseUrl) {
        const segments = [];
        let init = null;
        let encrypted = null;
        let byteRange = false;

        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith('#')) {
                if (line.startsWith('#EXT-X-KEY')) {
                    const a = parseAttributes(line);
                    if (a.METHOD && a.METHOD !== 'NONE') encrypted = a.METHOD;
                } else if (line.startsWith('#EXT-X-MAP')) {
                    const a = parseAttributes(line);
                    if (a.URI) init = resolveUrl(a.URI, baseUrl);
                } else if (line.startsWith('#EXT-X-BYTERANGE')) {
                    byteRange = true;
                }
                continue;
            }
            const url = resolveUrl(line, baseUrl);
            if (url) segments.push(url);
        }
        return { segments, init, encrypted, byteRange };
    }

    function abortError() {
        return new DOMException('Aborted', 'AbortError');
    }

    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(abortError());
            const t = setTimeout(resolve, ms);
            if (signal) {
                signal.addEventListener('abort', () => {
                    clearTimeout(t);
                    reject(abortError());
                }, { once: true });
            }
        });
    }

    /** fetch с повторами. 4xx (кроме 429) не повторяем — смысла нет. */
    async function fetchWithRetry(url, { signal, retries = 3, type = 'blob' } = {}) {
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (signal && signal.aborted) throw abortError();
            try {
                const res = await fetch(url, { signal });
                if (!res.ok) {
                    const e = new Error(`HTTP ${res.status}`);
                    e.status = res.status;
                    throw e;
                }
                return type === 'text' ? await res.text() : await res.blob();
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                lastErr = err;
                if (err.status >= 400 && err.status < 500 && err.status !== 429) break;
                if (attempt < retries) await sleep(300 * 2 ** attempt, signal);
            }
        }
        throw lastErr;
    }

    /**
     * Из списка найденных URL (от старых к новым) выбирает плейлист для скачивания.
     * Идём от новых к старым: если нашли master — берём из него лучшее качество,
     * иначе используем самый свежий media-плейлист.
     * @returns {Promise<{url: string, text: string, resolution?: string} | null>}
     */
    async function resolveMediaPlaylist(candidateUrls, { signal } = {}) {
        let fallback = null;
        for (const url of [...candidateUrls].reverse()) {
            let text;
            try {
                text = await fetchWithRetry(url, { signal, retries: 1, type: 'text' });
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                continue; // протухший токен, 404 и т.п. — пробуем следующий
            }
            const kind = getKind(text);
            if (kind === 'master') {
                const best = parseMaster(text, url)[0];
                if (best) {
                    const variantText = await fetchWithRetry(best.url, { signal, type: 'text' });
                    return { url: best.url, text: variantText, resolution: best.resolution };
                }
            } else if (kind === 'media' && !fallback) {
                fallback = { url, text };
            }
        }
        return fallback;
    }

    /**
     * Параллельно качает все URL, сохраняя порядок. При первой же окончательной
     * ошибке отменяет остальные запросы и бросает понятную ошибку.
     */
    async function downloadAll(urls, { signal, concurrency = 8, onProgress } = {}) {
        const results = new Array(urls.length);
        const inner = new AbortController();
        if (signal) {
            if (signal.aborted) throw abortError();
            signal.addEventListener('abort', () => inner.abort(), { once: true });
        }
        let next = 0;
        let done = 0;

        async function worker() {
            for (;;) {
                if (inner.signal.aborted) throw abortError();
                const i = next++;
                if (i >= urls.length) return;
                try {
                    results[i] = await fetchWithRetry(urls[i], { signal: inner.signal, type: 'blob' });
                } catch (err) {
                    inner.abort();
                    if (err.name === 'AbortError') throw err;
                    throw new Error(`Не удалось загрузить сегмент ${i + 1} из ${urls.length} (${err.message})`);
                }
                done++;
                if (onProgress) onProgress(done, urls.length);
            }
        }

        const n = Math.max(1, Math.min(concurrency, urls.length));
        await Promise.all(Array.from({ length: n }, worker));
        return results;
    }

    global.AntonovHLS = {
        isM3U8Url, resolveUrl, parseAttributes, getKind,
        parseMaster, parseMedia, fetchWithRetry, resolveMediaPlaylist, downloadAll
    };
})(typeof window !== 'undefined' ? window : globalThis);
