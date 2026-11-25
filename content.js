// content.js — кнопка «Скачать» и логика скачивания на страницах antonov.media
(() => {
    'use strict';

    if (window.__antonovDownloaderLoaded) return;
    window.__antonovDownloaderLoaded = true;

    const HLS = window.AntonovHLS;
    const BTN_ID = 'antonov-download-btn';
    const TOAST_ID = 'antonov-download-progress';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const DEBUG = false;
    const OUTPUT_MP4 = true; // false — всегда сохранять сырой .ts
    const log = (...args) => DEBUG && console.log('[Antonov Downloader]', ...args);

    // ───────────────────────── Состояние ─────────────────────────

    const state = {
        routeKey: routeKey(),
        navStart: 0,        // performance.now() момента, когда открылась текущая страница
        playlists: [],      // найденные .m3u8: [{url, time}], от старых к новым
        abort: null,        // AbortController активной загрузки
        hideTimer: null,
        ready: document.readyState === 'complete'
    };

    function routeKey() {
        return location.pathname + location.search;
    }

    function isWatchPage() {
        return location.pathname.startsWith('/watch');
    }

    // ─────────────── Поиск .m3u8 (то, что раньше «залипало») ───────────────
    //
    // Раньше ссылку искали через performance.getEntriesByType('resource') и брали
    // ПЕРВУЮ найденную. На SPA-сайте это давало ссылку от предыдущего видео, а
    // плюс буфер resource timing ограничен (~250 записей) и забивается сегментами,
    // так что новые плейлисты в нём вообще не появлялись. Перехваты XHR/fetch в
    // content script не работали: он живёт в изолированном мире и не видит
    // window.fetch страницы. PerformanceObserver получает записи независимо от
    // заполненности буфера, поэтому используем его.

    function recordPlaylist(url, time) {
        if (!HLS.isM3U8Url(url)) return;
        const i = state.playlists.findIndex(p => p.url === url);
        if (i !== -1) state.playlists.splice(i, 1);
        state.playlists.push({ url, time });
        state.playlists.sort((a, b) => a.time - b.time);
        if (state.playlists.length > 50) state.playlists.splice(0, state.playlists.length - 50);
        log('m3u8:', url);
    }

    try {
        new PerformanceObserver(list => {
            for (const e of list.getEntries()) recordPlaylist(e.name, e.startTime);
        }).observe({ type: 'resource', buffered: true });
    } catch (err) {
        console.warn('Antonov Downloader: PerformanceObserver недоступен', err);
    }

    /** Плейлисты, загруженные уже ПОСЛЕ перехода на текущую страницу (старые → новые). */
    function collectCandidates() {
        for (const e of performance.getEntriesByType('resource')) recordPlaylist(e.name, e.startTime);
        return state.playlists.filter(p => p.time >= state.navStart).slice(-8).map(p => p.url);
    }

    // ─────────────── Отслеживание SPA-навигации ───────────────

    let lastCheck = performance.now();

    function checkRoute() {
        const now = performance.now();
        const key = routeKey();
        if (key !== state.routeKey) {
            state.routeKey = key;
            state.navStart = lastCheck; // всё, что загружено раньше, относится к прошлой странице
            log('route →', key);
            removeButton();
            scheduleEnsure();
        }
        lastCheck = now;
    }

    // ─────────────── Заголовок видео ───────────────

    function sanitizeFilename(s) {
        return s
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100)
            .replace(/[. ]+$/, '');
    }

    function getVideoTitle() {
        // 1. h2 ближе всего к блоку с кнопками (на SPA «первый h2 на странице» может быть чужим)
        for (let el = findLikeButton(), depth = 0; el && depth < 8; el = el.parentElement, depth++) {
            const h = el.querySelector('h2');
            if (h && sanitizeFilename(h.textContent)) return sanitizeFilename(h.textContent);
        }
        // 2. первый h2 на странице
        const h2 = document.querySelector('h2');
        if (h2 && sanitizeFilename(h2.textContent)) return sanitizeFilename(h2.textContent);
        // 3. заголовок вкладки
        const t = sanitizeFilename(document.title.replace(/\s*-\s*Антонов Медиа\s*$/, ''));
        return t || 'video';
    }

    // ─────────────── Скачивание ───────────────

    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // для больших файлов 1 секунды может не хватить браузеру на старт загрузки
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async function handleDownload() {
        if (state.abort) return; // загрузка уже идёт
        const ctrl = new AbortController();
        const { signal } = ctrl;
        state.abort = ctrl;
        setBusy(true);

        // Имя файла фиксируем сразу: пока идёт загрузка, пользователь может уйти на другое видео.
        const titleAtStart = getVideoTitle();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

        try {
            showProgress(0, 'Поиск видео...');
            const playlist = await HLS.resolveMediaPlaylist(collectCandidates(), { signal });
            if (!playlist) {
                throw new Error('Видео не найдено. Запустите воспроизведение и попробуйте ещё раз.');
            }

            const media = HLS.parseMedia(playlist.text, playlist.url);
            if (media.encrypted) throw new Error(`Поток зашифрован (${media.encrypted}) — скачивание не поддерживается.`);
            if (media.byteRange) throw new Error('Потоки с BYTERANGE не поддерживаются.');
            if (!media.segments.length) throw new Error('Не найдено сегментов видео.');

            const urls = media.init ? [media.init, ...media.segments] : media.segments;
            log('playlist:', playlist.url, 'segments:', media.segments.length);
            showProgress(5, `Найдено сегментов: ${media.segments.length}`);

            const parts = await HLS.downloadAll(urls, {
                signal,
                concurrency: 8,
                onProgress: (done, total) => showProgress(5 + (done / total) * 85, `Сегмент ${done} из ${total}`)
            });

            // Сегменты fMP4 (init + фрагменты) после склейки — уже готовый MP4.
            // Сегменты MPEG-TS перепаковываем в MP4; если не получилось — сохраняем как .ts.
            let blob, ext, note = '';
            if (media.init) {
                blob = new Blob(parts, { type: 'video/mp4' });
                ext = 'mp4';
            } else if (OUTPUT_MP4 && window.AntonovMP4) {
                showProgress(90, 'Конвертация в MP4...');
                try {
                    blob = await window.AntonovMP4.remux(parts, {
                        signal,
                        onProgress: (done, total) => showProgress(90 + (done / total) * 9, `Конвертация ${done} из ${total}`)
                    });
                    ext = 'mp4';
                } catch (err) {
                    if (signal.aborted) throw err;
                    console.warn('Antonov Downloader: конвертация в MP4 не удалась, сохраняю .ts —', err);
                    note = ` (MP4 не получился: ${err.message}; сохранён .ts)`;
                }
            }
            if (!blob) {
                blob = new Blob(parts, { type: 'video/mp2t' });
                ext = 'ts';
            }

            showProgress(99, 'Сохранение файла...');
            saveBlob(blob, `${titleAtStart}_${stamp}.${ext}`);
            showProgress(100, 'Готово' + note, { hideAfter: note ? 8000 : 3000 });
        } catch (err) {
            if (signal.aborted) return; // отмену обработал тот, кто её вызвал
            console.error('Antonov Downloader:', err);
            showProgress(null, '⚠️ ' + err.message, { error: true, hideAfter: 8000 });
        } finally {
            if (state.abort === ctrl) {
                state.abort = null;
                setBusy(false);
            }
        }
    }

    function cancelDownload() {
        if (state.abort) state.abort.abort();
        state.abort = null;
        hideProgress();
        setBusy(false);
    }

    // ─────────────── Индикатор прогресса ───────────────

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        Object.assign(node, props);
        children.forEach(c => node.append(c));
        return node;
    }

    function showProgress(percent, status, { error = false, hideAfter = 0 } = {}) {
        clearTimeout(state.hideTimer);
        let toast = document.getElementById(TOAST_ID);

        if (!toast) {
            const cancel = el('button', { id: 'antonov-cancel-btn', type: 'button', textContent: '×', title: 'Отмена' });
            cancel.addEventListener('click', cancelDownload);
            toast = el('div', { id: TOAST_ID }, [
                el('div', { className: 'antonov-toast-head' }, [el('span', { textContent: '⬇ Скачивание' }), cancel]),
                el('div', { className: 'antonov-bar' }, [el('div', { id: 'antonov-progress-bar' })]),
                el('div', { className: 'antonov-toast-foot' }, [
                    el('span', { id: 'antonov-progress-text' }),
                    el('span', { id: 'antonov-progress-status' })
                ])
            ]);
            document.body.appendChild(toast);
        }

        toast.classList.toggle('antonov-error', error);
        if (percent !== null) {
            toast.querySelector('#antonov-progress-bar').style.width = percent + '%';
            toast.querySelector('#antonov-progress-text').textContent = Math.round(percent) + '%';
        }
        toast.querySelector('#antonov-progress-status').textContent = status;

        // таймер хранится в state: старый таймер больше не может скрыть новый индикатор
        if (hideAfter) state.hideTimer = setTimeout(hideProgress, hideAfter);
    }

    function hideProgress() {
        clearTimeout(state.hideTimer);
        const toast = document.getElementById(TOAST_ID);
        if (toast) toast.remove();
    }

    // ─────────────── Кнопка «Скачать» ───────────────
    //
    // Вместо ручной «рисовалки» кнопка клонируется с родной кнопки «Нравится» —
    // классы, размеры, шрифты и отступы совпадают с сайтом автоматически
    // (и продолжат совпадать, если сайт поменяет вёрстку).

    const STATE_ATTRS = [
        'aria-pressed', 'aria-checked', 'aria-selected', 'aria-expanded', 'aria-haspopup',
        'aria-controls', 'aria-describedby', 'data-state', 'data-active', 'data-selected', 'data-pressed'
    ];

    function findLikeButton() {
        const exact = document.querySelector('button[aria-label="Нравится"]');
        if (exact) return exact;
        for (const b of document.querySelectorAll('button[aria-label]')) {
            const label = b.getAttribute('aria-label').trim();
            if (/нравится|лайк|like/i.test(label) && !/не\s+нравится|дизлайк|dislike/i.test(label)) return b;
        }
        return null;
    }

    function makeIcon(model) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        // размер берём у родной иконки; классы цвета/заливки отбрасываем (иначе иконка «лайка» перекрасит нашу)
        if (model) {
            for (const a of ['width', 'height']) if (model.hasAttribute(a)) svg.setAttribute(a, model.getAttribute(a));
            const cls = (model.getAttribute('class') || '').split(/\s+/)
                .filter(c => c && !/(^|:)(fill|stroke|text)-/.test(c)).join(' ');
            if (cls) svg.setAttribute('class', cls);
        }
        if (!svg.hasAttribute('width')) svg.setAttribute('width', '16');
        if (!svg.hasAttribute('height')) svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.fill = 'none';
        svg.innerHTML = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>';
        return svg;
    }

    function setLabel(btn, icon, text) {
        const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
        let first = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.nodeValue.trim() || n.parentElement.closest('svg')) continue;
            if (!first) first = n; else n.nodeValue = '';
        }
        if (first) {
            first.nodeValue = text;
        } else {
            icon.after(el('span', { textContent: text }));
        }
    }

    function buildFromLike(like) {
        const btn = like.cloneNode(true);
        for (const node of [btn, ...btn.querySelectorAll('*')]) {
            node.removeAttribute('id');
            STATE_ATTRS.forEach(a => node.removeAttribute(a));
        }
        btn.id = BTN_ID;
        btn.type = 'button';
        btn.disabled = false;
        btn.removeAttribute('disabled');
        btn.setAttribute('aria-label', 'Скачать видео');
        btn.title = 'Скачать видео';

        const oldSvg = btn.querySelector('svg');
        const icon = makeIcon(oldSvg);
        if (oldSvg) oldSvg.replaceWith(icon); else btn.prepend(icon);
        setLabel(btn, icon, 'Скачать');
        return btn;
    }

    /** Запасной вариант, если клонирование по какой-то причине не удалось. */
    function buildFallback(like) {
        const btn = el('button', { id: BTN_ID, type: 'button', className: like.className, title: 'Скачать видео' });
        const icon = makeIcon(null);
        btn.append(el('div', { className: 'flex items-center gap-2 px-2' }, [icon, el('span', { textContent: 'Скачать' })]));
        return btn;
    }

    function createButton(like) {
        let btn;
        try {
            btn = buildFromLike(like);
        } catch (err) {
            console.warn('Antonov Downloader: клонирование не удалось, использую запасную кнопку', err);
            btn = buildFallback(like);
        }
        btn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation(); // клон не знает про React-обработчики, но родители могут их иметь
            handleDownload();
        });

        like.parentNode.insertBefore(btn, like);

        // «Нравится» стоит в одной группе с «Не нравится», поэтому у неё срезаны правые углы и,
        // возможно, граница. Наша кнопка отдельная — скругляем все углы как у левого края оригинала.
        const lcs = getComputedStyle(like);
        btn.style.borderRadius = lcs.borderTopLeftRadius;
        if (parseFloat(lcs.borderRightWidth) === 0) {
            btn.style.borderRight = `${lcs.borderLeftWidth} ${lcs.borderLeftStyle} ${lcs.borderLeftColor}`;
        }

        // если родитель не раздвигает элементы через gap — добавляем отступ сами
        const cs = getComputedStyle(like.parentNode);
        const hasGap = /flex|grid/.test(cs.display) && parseFloat(cs.columnGap) > 0;
        if (!hasGap) btn.style.marginRight = '8px';

        setBusy(Boolean(state.abort));
        log('button created');
    }

    function removeButton() {
        const btn = document.getElementById(BTN_ID);
        if (btn) btn.remove();
    }

    function setBusy(busy) {
        const btn = document.getElementById(BTN_ID);
        if (!btn) return;
        btn.disabled = busy;
        btn.classList.toggle('antonov-busy', busy);
        btn.setAttribute('aria-busy', String(busy));
    }

    function ensureButton() {
        if (!state.ready) return;
        if (!isWatchPage()) return removeButton();
        const like = findLikeButton();
        if (!like) return;
        const existing = document.getElementById(BTN_ID);
        if (existing && existing.parentNode === like.parentNode) return;
        if (existing) existing.remove();
        createButton(like);
    }

    // ─────────────── Запуск ───────────────
    //
    // Раньше кнопка создавалась по таймеру только первые 10 секунд после загрузки,
    // а скрипт подключался лишь на /watch*. После SPA-перехода (или перерисовки
    // страницы фреймворком) кнопка уже не появлялась до обновления страницы.
    // Теперь скрипт работает на всём сайте и следит за DOM и адресом постоянно.

    let ensureQueued = false;
    function scheduleEnsure() {
        if (ensureQueued) return;
        ensureQueued = true;
        requestAnimationFrame(() => {
            ensureQueued = false;
            checkRoute();
            ensureButton();
        });
    }

    new MutationObserver(scheduleEnsure).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => { checkRoute(); ensureButton(); }, 500); // страховка (в т.ч. для фоновых вкладок)
    window.addEventListener('popstate', scheduleEnsure);
    if (window.navigation) window.navigation.addEventListener('currententrychange', scheduleEnsure);

    // не вставляем элементы до окончания гидратации страницы, чтобы не ломать React
    if (!state.ready) {
        window.addEventListener('load', () => setTimeout(() => {
            state.ready = true;
            scheduleEnsure();
        }, 500));
    }
})();
