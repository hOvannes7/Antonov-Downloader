// utils/ts2mp4.js — перепаковка HLS-сегментов MPEG-TS (H.264 + AAC) в обычный MP4.
// Перекодирования нет: видео- и аудиоданные копируются как есть, меняется только контейнер.
// Если в потоке есть что-то неподдерживаемое (HEVC, AC-3, MP3 и т.п.), remux() бросает
// ошибку, а content.js сохраняет исходный .ts.
//
// Подключается как обычный скрипт, API: AntonovMP4.remux(blobs, { signal, onProgress })
(function (global) {
    'use strict';

    const TS_PACKET = 188;
    const PTS_WRAP = 8589934592; // 2^33
    const CLOCK = 90000;
    const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
    const UNSUPPORTED_TYPES = { 0x24: 'HEVC', 0x03: 'MPEG audio', 0x04: 'MPEG audio', 0x81: 'AC-3', 0x87: 'E-AC-3', 0x11: 'AAC LATM' };

    // ───────────────────────── Байты и боксы ─────────────────────────

    const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const be16 = n => [(n >>> 8) & 255, n & 255];
    const str4 = s => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];

    function concat(chunks, total) {
        if (total === undefined) total = chunks.reduce((a, c) => a + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
    }

    function box(type, ...payloads) {
        const parts = payloads.map(p => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
        const len = 8 + parts.reduce((a, p) => a + p.length, 0);
        const out = new Uint8Array(len);
        out.set(be32(len), 0);
        out.set(str4(type), 4);
        let o = 8;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    const fullBox = (type, version, flags, ...payloads) =>
        box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...payloads);

    /** Таблица из 32-битных чисел (по `width` слов на запись). */
    function u32Table(values) {
        const out = new Uint8Array(values.length * 4);
        const dv = new DataView(out.buffer);
        for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i] >>> 0);
        return out;
    }

    function u64Table(values) {
        const out = new Uint8Array(values.length * 8);
        const dv = new DataView(out.buffer);
        for (let i = 0; i < values.length; i++) {
            dv.setUint32(i * 8, Math.floor(values[i] / 4294967296));
            dv.setUint32(i * 8 + 4, values[i] % 4294967296);
        }
        return out;
    }

    const MATRIX = [].concat(be32(0x00010000), be32(0), be32(0), be32(0), be32(0x00010000), be32(0), be32(0), be32(0), be32(0x40000000));

    // ───────────────────────── Разбор H.264 (SPS) ─────────────────────────

    class BitReader {
        constructor(bytes) { this.b = bytes; this.pos = 0; }
        u1() {
            const byte = this.b[this.pos >> 3];
            if (byte === undefined) throw new Error('SPS обрезан');
            const bit = (byte >> (7 - (this.pos & 7))) & 1;
            this.pos++;
            return bit;
        }
        u(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.u1(); return v; }
        ue() {
            let zeros = 0;
            while (this.u1() === 0) { if (++zeros > 32) throw new Error('Некорректный SPS'); }
            return 2 ** zeros - 1 + this.u(zeros);
        }
        se() { const k = this.ue(); return k % 2 ? (k + 1) / 2 : -k / 2; }
    }

    function unescapeRbsp(bytes) {
        const out = [];
        for (let i = 0, zeros = 0; i < bytes.length; i++) {
            if (zeros >= 2 && bytes[i] === 3) { zeros = 0; continue; }
            out.push(bytes[i]);
            zeros = bytes[i] === 0 ? zeros + 1 : 0;
        }
        return Uint8Array.from(out);
    }

    function skipScalingList(r, size) {
        let last = 8, next = 8;
        for (let j = 0; j < size; j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            if (next !== 0) last = next;
        }
    }

    function parseSps(nal) {
        const r = new BitReader(unescapeRbsp(nal.subarray(1)));
        const profile = r.u(8);
        r.u(8); // constraint flags
        r.u(8); // level
        r.ue(); // sps id
        let chroma = 1, bitL = 8, bitC = 8;
        if (HIGH_PROFILES.includes(profile)) {
            chroma = r.ue();
            if (chroma === 3) r.u1();
            bitL = r.ue() + 8;
            bitC = r.ue() + 8;
            r.u1();
            if (r.u1()) {
                const count = chroma !== 3 ? 8 : 12;
                for (let i = 0; i < count; i++) if (r.u1()) skipScalingList(r, i < 6 ? 16 : 64);
            }
        }
        r.ue(); // log2_max_frame_num
        const pocType = r.ue();
        if (pocType === 0) {
            r.ue();
        } else if (pocType === 1) {
            r.u1(); r.se(); r.se();
            const n = r.ue();
            for (let i = 0; i < n; i++) r.se();
        }
        r.ue(); r.u1(); // max_num_ref_frames, gaps
        const wMbs = r.ue() + 1;
        const hUnits = r.ue() + 1;
        const frameMbsOnly = r.u1();
        if (!frameMbsOnly) r.u1();
        r.u1(); // direct_8x8
        let crop = [0, 0, 0, 0];
        if (r.u1()) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
        const cropX = chroma === 1 || chroma === 2 ? 2 : 1;
        const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
        return {
            profile, chroma, bitL, bitC,
            width: wMbs * 16 - (crop[0] + crop[1]) * cropX,
            height: (2 - frameMbsOnly) * hUnits * 16 - (crop[2] + crop[3]) * cropY
        };
    }

    // ───────────────────────── Демультиплексор MPEG-TS ─────────────────────────

    function readTs(b, o) {
        const hi = (b[o] >> 1) & 7;
        const mid = (b[o + 1] << 7) | (b[o + 2] >> 1);
        const lo = (b[o + 3] << 7) | (b[o + 4] >> 1);
        return hi * 2 ** 30 + mid * 2 ** 15 + lo;
    }

    function unwrap(value, prev) {
        if (prev === null) return value;
        while (value < prev - PTS_WRAP / 2) value += PTS_WRAP;
        return value;
    }

    function splitNals(d) {
        const nals = [];
        let start = -1;
        const push = end => {
            while (end > start && d[end - 1] === 0) end--;
            if (end > start) nals.push(d.subarray(start, end));
        };
        let i = 0;
        const n = d.length;
        while (i + 2 < n) {
            if (d[i + 2] > 1) { i += 3; continue; }
            if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
                if (start >= 0) push(i);
                start = i + 3;
                i += 3;
            } else {
                i++;
            }
        }
        if (start >= 0) push(n);
        return nals;
    }

    function parsePat(payload) {
        const s = 1 + payload[0];
        const end = s + 3 + (((payload[s + 1] & 15) << 8) | payload[s + 2]) - 4;
        for (let p = s + 8; p + 4 <= end; p += 4) {
            const program = (payload[p] << 8) | payload[p + 1];
            if (program !== 0) return ((payload[p + 2] & 0x1f) << 8) | payload[p + 3];
        }
        return null;
    }

    function parsePmt(payload, st) {
        const s = 1 + payload[0];
        const end = s + 3 + (((payload[s + 1] & 15) << 8) | payload[s + 2]) - 4;
        let p = s + 12 + (((payload[s + 10] & 15) << 8) | payload[s + 11]);
        while (p + 5 <= end) {
            const type = payload[p];
            const pid = ((payload[p + 1] & 0x1f) << 8) | payload[p + 2];
            if (UNSUPPORTED_TYPES[type]) throw new Error(`Формат ${UNSUPPORTED_TYPES[type]} не поддерживается для MP4`);
            if (type === 0x1b && st.videoPid === null) st.videoPid = pid;
            if (type === 0x0f && st.audioPid === null) st.audioPid = pid;
            p += 5 + (((payload[p + 3] & 15) << 8) | payload[p + 4]);
        }
    }

    function parseVideoPes(data, pts, dts, st, out) {
        let au = null;
        let index = 0;
        const finish = () => {
            if (au && au.slice) {
                const total = au.parts.reduce((a, x) => a + x.length + 4, 0);
                const buf = new Uint8Array(total);
                const dv = new DataView(buf.buffer);
                let o = 0;
                for (const nal of au.parts) { dv.setUint32(o, nal.length); buf.set(nal, o + 4); o += nal.length + 4; }
                out.push({ data: buf, pts: au.pts, dts: au.dts, key: au.key });
            }
            au = null;
        };
        for (const nal of splitNals(data)) {
            const type = nal[0] & 0x1f;
            if (type === 9) { finish(); continue; }        // AUD — граница кадра
            if (type === 7) { st.addParamSet(st.sps, nal); continue; }
            if (type === 8) { st.addParamSet(st.pps, nal); continue; }
            if (type < 1 || type > 6) continue;             // filler, end-of-seq и т.п. не нужны
            if (!au) {
                // первый кадр PES получает таймстемпы PES; остальные (редкий случай) — оценку
                au = { parts: [], key: false, slice: false, pts: pts + index * st.vDur, dts: dts + index * st.vDur };
                index++;
            }
            if (type === 5) au.key = true;
            if (type <= 5) au.slice = true;
            au.parts.push(nal);
        }
        finish();
    }

    function parseAudioPes(data, pts, st, out) {
        let i = 0;
        let k = 0;
        while (i + 7 <= data.length) {
            if (data[i] !== 0xff || (data[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
            const hdr = data[i + 1] & 1 ? 7 : 9;
            const sfIdx = (data[i + 2] >> 2) & 15;
            const channels = ((data[i + 2] & 1) << 2) | (data[i + 3] >> 6);
            const len = ((data[i + 3] & 3) << 11) | (data[i + 4] << 3) | (data[i + 5] >> 5);
            if (len < hdr || i + len > data.length) break;
            const rate = AAC_RATES[sfIdx];
            if (!rate) throw new Error('Неподдерживаемая частота AAC');
            if (!st.audio) st.audio = { aot: ((data[i + 2] >> 6) & 3) + 1, sfIdx, channels, rate };
            out.push({ data: data.subarray(i + hdr, i + len), pts: pts === null ? null : pts + (k * 1024 * CLOCK) / rate });
            k++;
            i += len;
        }
    }

    /** Разбирает один TS-сегмент. Возвращает {video: [...], audio: [...]} в порядке декодирования. */
    function demuxSegment(bytes, st) {
        let start = 0;
        const synced = o => bytes[o] === 0x47 && (o + TS_PACKET >= bytes.length || bytes[o + TS_PACKET] === 0x47);
        while (start + TS_PACKET <= bytes.length && !synced(start)) start++;
        if (start + TS_PACKET > bytes.length) throw new Error('Сегмент не похож на MPEG-TS');

        const video = [], audio = [];
        const bufs = new Map();

        const flush = pid => {
            const b = bufs.get(pid);
            if (!b || !b.len) return;
            bufs.set(pid, { chunks: [], len: 0 });
            const buf = concat(b.chunks, b.len);
            if (buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) return;
            const flags = buf[7] >> 6;
            let pts = null, dts = null;
            if (flags & 2) { pts = readTs(buf, 9); dts = flags === 3 ? readTs(buf, 14) : pts; }
            const payload = buf.subarray(9 + buf[8]);
            if (pid === st.videoPid) {
                if (pts === null) return;
                pts = unwrap(pts, st.lastVPts); dts = unwrap(dts, st.lastVDts);
                st.lastVPts = pts; st.lastVDts = dts;
                parseVideoPes(payload, pts, dts, st, video);
            } else if (pid === st.audioPid) {
                if (pts !== null) { pts = unwrap(pts, st.lastAPts); st.lastAPts = pts; }
                parseAudioPes(payload, pts, st, audio);
            }
        };

        for (let off = start; off + TS_PACKET <= bytes.length; off += TS_PACKET) {
            if (bytes[off] !== 0x47) {
                let n = off;
                while (n + TS_PACKET <= bytes.length && bytes[n] !== 0x47) n++;
                off = n - TS_PACKET;
                continue;
            }
            const pusi = (bytes[off + 1] & 0x40) !== 0;
            const pid = ((bytes[off + 1] & 0x1f) << 8) | bytes[off + 2];
            const afc = (bytes[off + 3] >> 4) & 3;
            let p = off + 4;
            if (afc & 2) p += 1 + bytes[off + 4];
            if (!(afc & 1) || p >= off + TS_PACKET) continue;
            const payload = bytes.subarray(p, off + TS_PACKET);

            if (pid === 0) {
                if (pusi) { const pmt = parsePat(payload); if (pmt !== null) st.pmtPid = pmt; }
            } else if (pid === st.pmtPid) {
                if (pusi) parsePmt(payload, st);
            } else if (pid === st.videoPid || pid === st.audioPid) {
                if (pusi) flush(pid);
                const b = bufs.get(pid) || { chunks: [], len: 0 };
                b.chunks.push(payload); b.len += payload.length;
                bufs.set(pid, b);
            }
        }
        flush(st.videoPid); flush(st.audioPid);
        return { video, audio };
    }

    // ───────────────────────── Сборка MP4 ─────────────────────────

    function runLength(values) {
        const out = [];
        for (const v of values) {
            if (out.length && out[out.length - 1][0] === v) out[out.length - 1][1]++;
            else out.push([v, 1]);
        }
        return out;
    }

    function buildStsc(chunks) {
        const entries = [];
        chunks.forEach((c, i) => {
            if (!entries.length || entries[entries.length - 1][1] !== c.count) entries.push([i + 1, c.count, 1]);
        });
        return fullBox('stsc', 0, 0, be32(entries.length), u32Table(entries.flat()));
    }

    function buildChunkOffsets(chunks, base, use64) {
        const offs = chunks.map(c => base + c.offset);
        return use64
            ? fullBox('co64', 0, 0, be32(offs.length), u64Table(offs))
            : fullBox('stco', 0, 0, be32(offs.length), u32Table(offs));
    }

    function buildEdits(leadMs, mediaTime, segMs) {
        const entries = [];
        if (leadMs > 0) entries.push([leadMs, 0xffffffff, 0x00010000]);
        entries.push([Math.max(segMs, 0), mediaTime, 0x00010000]);
        return box('edts', fullBox('elst', 0, 0, be32(entries.length), u32Table(entries.flat())));
    }

    function buildTrack(o) {
        const isVideo = o.kind === 'video';
        const stbl = box('stbl',
            fullBox('stsd', 0, 0, be32(1), o.sampleEntry),
            fullBox('stts', 0, 0, be32(o.stts.length), u32Table(o.stts.map(([d, c]) => [c, d]).flat())),
            ...(o.ctts ? [fullBox('ctts', o.ctts.version, 0, be32(o.ctts.runs.length), u32Table(o.ctts.runs.map(([v, c]) => [c, v]).flat()))] : []),
            ...(o.sync ? [fullBox('stss', 0, 0, be32(o.sync.length), u32Table(o.sync))] : []),
            buildStsc(o.chunks),
            fullBox('stsz', 0, 0, be32(0), be32(o.sizes.length), u32Table(o.sizes)),
            buildChunkOffsets(o.chunks, o.base, o.use64)
        );
        const tkhd = fullBox('tkhd', 0, 3,
            be32(0), be32(0), be32(o.id), be32(0), be32(o.trackMs), new Array(8).fill(0),
            be16(0), be16(0), be16(isVideo ? 0 : 0x0100), be16(0), MATRIX,
            be32(isVideo ? o.width * 65536 : 0), be32(isVideo ? o.height * 65536 : 0));
        const mdhd = fullBox('mdhd', 0, 0, be32(0), be32(0), be32(o.timescale), be32(o.mediaDuration), be16(0x55c4), be16(0));
        const hdlr = fullBox('hdlr', 0, 0, be32(0), str4(isVideo ? 'vide' : 'soun'), new Array(12).fill(0),
            [...(isVideo ? 'VideoHandler' : 'SoundHandler')].map(c => c.charCodeAt(0)), [0]);
        const minf = box('minf',
            isVideo ? fullBox('vmhd', 0, 1, new Array(8).fill(0)) : fullBox('smhd', 0, 0, new Array(4).fill(0)),
            box('dinf', fullBox('dref', 0, 0, be32(1), fullBox('url ', 0, 1))),
            stbl);
        return box('trak', tkhd, o.edits, box('mdia', mdhd, hdlr, minf));
    }

    function videoSampleEntry(st) {
        const sps0 = parseSps(st.sps[0]);
        const avcc = [1, st.sps[0][1], st.sps[0][2], st.sps[0][3], 0xff, 0xe0 | st.sps.length];
        for (const s of st.sps) avcc.push(...be16(s.length), ...s);
        avcc.push(st.pps.length);
        for (const p of st.pps) avcc.push(...be16(p.length), ...p);
        if (HIGH_PROFILES.includes(sps0.profile)) avcc.push(0xfc | sps0.chroma, 0xf8 | (sps0.bitL - 8), 0xf8 | (sps0.bitC - 8), 0);
        const name = new Array(32).fill(0);
        const entry = box('avc1',
            new Array(6).fill(0), be16(1), new Array(16).fill(0),
            be16(sps0.width), be16(sps0.height), be32(0x00480000), be32(0x00480000), be32(0), be16(1),
            name, be16(0x18), be16(0xffff),
            box('avcC', avcc));
        return { entry, width: sps0.width, height: sps0.height };
    }

    function audioSampleEntry(a) {
        // AudioSpecificConfig: 5 бит object type, 4 бита индекс частоты, 4 бита каналы
        const asc = [(a.aot << 3) | (a.sfIdx >> 1), ((a.sfIdx & 1) << 7) | (a.channels << 3)];
        const decSpecific = [0x05, asc.length, ...asc];
        const decConfig = [0x04, 13 + decSpecific.length,
            0x40,                 // MPEG-4 Audio
            0x15,                 // audio stream
            0, 0, 0,              // bufferSizeDB
            0, 0, 0, 0,           // maxBitrate
            0, 0, 0, 0,           // avgBitrate
            ...decSpecific];
        const slConfig = [0x06, 1, 0x02];
        const esBody = [0, 1, 0, ...decConfig, ...slConfig]; // ES_ID=1, flags=0
        const esds = fullBox('esds', 0, 0, [0x03, esBody.length, ...esBody]);
        return box('mp4a', new Array(6).fill(0), be16(1), new Array(8).fill(0),
            be16(a.channels === 7 ? 8 : a.channels), be16(16), be16(0), be16(0), be32((a.rate * 65536) >>> 0), esds);
    }

    /**
     * Перепаковывает массив TS-сегментов (Blob) в один MP4.
     * @returns {Promise<Blob>}
     */
    async function remux(blobs, { signal, onProgress } = {}) {
        const st = {
            pmtPid: null, videoPid: null, audioPid: null, audio: null,
            sps: [], pps: [], lastVPts: null, lastVDts: null, lastAPts: null, vDur: 3000,
            addParamSet(list, nal) {
                const key = Array.from(nal).join(',');
                if (!list.seen) list.seen = new Set();
                if (!list.seen.has(key) && list.length < 31) { list.seen.add(key); list.push(Uint8Array.from(nal)); }
            }
        };
        const V = { sizes: [], pts: [], dts: [], key: [], chunks: [] };
        const A = { sizes: [], chunks: [], firstPts: null };
        const mdat = [];
        let rel = 0;

        for (let s = 0; s < blobs.length; s++) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const bytes = new Uint8Array(await blobs[s].arrayBuffer());
            const seg = demuxSegment(bytes, st);

            const vData = seg.video.map(x => x.data);
            const aData = seg.audio.map(x => x.data);
            const vLen = vData.reduce((a, d) => a + d.length, 0);
            const aLen = aData.reduce((a, d) => a + d.length, 0);
            if (seg.video.length) {
                V.chunks.push({ offset: rel, count: seg.video.length });
                for (const x of seg.video) { V.sizes.push(x.data.length); V.pts.push(x.pts); V.dts.push(x.dts); V.key.push(x.key); }
                if (V.dts.length > 1) st.vDur = Math.min(Math.max(V.dts[V.dts.length - 1] - V.dts[V.dts.length - 2], 1), 90000) || st.vDur;
            }
            if (seg.audio.length) {
                A.chunks.push({ offset: rel + vLen, count: seg.audio.length });
                for (const x of seg.audio) A.sizes.push(x.data.length);
                if (A.firstPts === null) A.firstPts = seg.audio.find(x => x.pts !== null)?.pts ?? null;
            }
            mdat.push(new Blob([...vData, ...aData]));
            rel += vLen + aLen;
            if (onProgress) onProgress(s + 1, blobs.length);
        }

        if (!V.sizes.length && !A.sizes.length) throw new Error('В сегментах не найдено H.264/AAC');
        if (V.sizes.length && (!st.sps.length || !st.pps.length)) throw new Error('В потоке нет SPS/PPS');

        const hdrLen = rel + 8 > 0xffffffff ? 16 : 8;
        const ftyp = box('ftyp', str4('isom'), be32(512), str4('isom'), str4('iso2'), str4('avc1'), str4('mp41'));
        const base = ftyp.length + hdrLen;
        const use64 = base + rel > 0xffffffff;
        const mdatHeader = hdrLen === 16
            ? Uint8Array.from([...be32(1), ...str4('mdat'), ...be32(Math.floor((rel + 16) / 4294967296)), ...be32((rel + 16) % 4294967296)])
            : Uint8Array.from([...be32(rel + 8), ...str4('mdat')]);

        // Общий ноль времени: самый ранний PTS среди дорожек
        let vStart = null;
        if (V.sizes.length) vStart = V.pts.reduce((m, x) => Math.min(m, x), Infinity);
        const starts = [vStart, A.firstPts].filter(x => x !== null);
        const origin = Math.min(...starts);

        const tracks = [];
        let nextId = 1;
        let movieMs = 0;

        if (V.sizes.length) {
            const n = V.dts.length;
            const durations = new Array(n);
            for (let i = 0; i < n - 1; i++) {
                const d = V.dts[i + 1] - V.dts[i];
                durations[i] = d > 0 && d <= 5 * CLOCK ? d : (i > 0 ? durations[i - 1] : 3000);
            }
            durations[n - 1] = n > 1 ? durations[n - 2] : 3000;
            // собственная непрерывная шкала декодирования
            const mediaDts = new Array(n);
            let acc = 0;
            for (let i = 0; i < n; i++) { mediaDts[i] = acc; acc += durations[i]; }
            const offsets = V.pts.map((p, i) => {
                const c = p - V.dts[i];
                return Math.abs(c) > 10 * CLOCK ? 0 : Math.round(c);
            });
            const minOffset = offsets.reduce((m, x) => Math.min(m, x), Infinity);
            const hasCtts = offsets.some(x => x !== 0);
            const earliest = mediaDts.reduce((m, d, i) => Math.min(m, d + offsets[i]), Infinity);
            const mediaStart = Math.max(0, Math.round(earliest));
            const syncList = [];
            V.key.forEach((k, i) => { if (k) syncList.push(i + 1); });
            const { entry, width, height } = videoSampleEntry(st);
            // длительность показа считаем по времени ПОКАЗА, а не декодирования: из-за B-кадров
            // последний показанный кадр заканчивается позже суммы длительностей
            const presEnd = mediaDts.reduce((m, d, i) => Math.max(m, d + offsets[i] + durations[i]), 0);
            const leadMs = Math.round((vStart - origin) / 90);
            const segMs = Math.round((presEnd - mediaStart) / 90);
            tracks.push(buildTrack({
                kind: 'video', id: nextId++, width, height, timescale: CLOCK, mediaDuration: acc,
                trackMs: leadMs + segMs, sampleEntry: entry,
                stts: runLength(durations),
                ctts: hasCtts ? { version: minOffset < 0 ? 1 : 0, runs: runLength(offsets) } : null,
                sync: syncList.length === n ? null : syncList,
                chunks: V.chunks, sizes: V.sizes, base, use64,
                edits: buildEdits(leadMs, mediaStart, segMs)
            }));
            movieMs = Math.max(movieMs, leadMs + segMs);
        }

        if (A.sizes.length) {
            const a = st.audio;
            const total = A.sizes.length * 1024;
            const leadMs = A.firstPts === null ? 0 : Math.round((A.firstPts - origin) / 90);
            const segMs = Math.round((total / a.rate) * 1000);
            tracks.push(buildTrack({
                kind: 'audio', id: nextId++, timescale: a.rate, mediaDuration: total,
                trackMs: leadMs + segMs, sampleEntry: audioSampleEntry(a),
                stts: [[1024, A.sizes.length]], ctts: null, sync: null,
                chunks: A.chunks, sizes: A.sizes, base, use64,
                edits: buildEdits(leadMs, 0, segMs)
            }));
            movieMs = Math.max(movieMs, leadMs + segMs);
        }

        const mvhd = fullBox('mvhd', 0, 0,
            be32(0), be32(0), be32(1000), be32(movieMs), be32(0x00010000), be16(0x0100), be16(0),
            new Array(8).fill(0), MATRIX, new Array(24).fill(0), be32(nextId));
        const moov = box('moov', mvhd, ...tracks);

        return new Blob([ftyp, mdatHeader, ...mdat, moov], { type: 'video/mp4' });
    }

    global.AntonovMP4 = { remux, parseSps };
})(typeof window !== 'undefined' ? window : globalThis);
