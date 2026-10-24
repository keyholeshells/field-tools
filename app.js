// ========================================================================= //
// FIELD TOOLS APP (offline, installable)                                    //
// Source: field-app/app.js in the boosters repo (keyholeshells/            //
// laingsburg-band-booster-website). The whole field-app/ folder is the     //
// app: a plain static site published by GitHub Pages from the separate     //
// public repo keyholeshells/field-tools, because Wix blocks service        //
// workers (what lets a page open with no signal) on everything it hosts.   //
// After editing here: node scripts/sync-tool-engine.js (copies the shared //
// music-tools engine in), bump VERSION in sw.js, copy field-app/ to the    //
// field-tools repo and push.                                               //
//                                                                           //
// Tracks: the install link from the Stage (📲 Offline app) carries the    //
// director's field key (?k=...). With it, the boosters site's             //
// /_functions/fieldTracks returns the Media Handler's Field Pack (links to //
// static.wixstatic.com), and every track is downloaded into this phone   //
// (IndexedDB, MT.cache) so it plays offline. No tracks or keys are in this //
// repo. A new link on the Stage stops old keys loading the list (copies   //
// already on phones keep playing).                                         //
// ========================================================================= //
(function () {
    "use strict";

    /* <music-tools-engine> */
    // ------------------------------------------------------------------------- //
    // MUSIC TOOLS ENGINE (shared)                                              //
    // Source of truth: public/music-tools/engine.js                            //
    // Copied between the <music-tools-engine> markers into                     //
    //   public/custom-elements/stage-board.js     (the Stage / Podium boxes)   //
    //   public/custom-elements/classroom-view.js  (students' practice tools)   //
    // by  node scripts/sync-tool-engine.js  (run it after editing this file;  //
    // node scripts/sync-tool-engine.js --check fails if a copy is out of date). //
    // Wix loads each custom element as one file, so the code is copied, not    //
    // imported. Nothing here draws: each element draws its own boxes and reads //
    // these engines' state (sound, microphone and offline saving live here).   //
    //                                                                           //
    //   MT.Metronome  bpm 40-250, meter 2/4 3/4 4/4 6/8, feel Straight/Swing/  //
    //                 Shuffle, tap tempo. start() / stop(); takeBeat() returns  //
    //                 the newest beat that has sounded (or -1) for the flash.  //
    //   MT.Tuner      start() asks for the microphone (resolves "" or a        //
    //                 sentence saying what went wrong); reading = { note,      //
    //                 octave, hz, cents, at } or null; stop().                 //
    //   MT.Stopwatch  toggle / lap / reset (reset twice clears the runs);     //
    //                 elapsed(), runs [{ t, split }].                          //
    //   MT.cache      tracks saved in this browser (IndexedDB) for the field: //
    //                 has(id), keys(), urlFor(id) (an object URL or ""),       //
    //                 save(id, url, title), remove(id).                         //
    //   MT.clock(ms)  { main "01:23", cs ".45" }   MT.mmss(seconds) "1:23"    //
    // The old Tools page (/director-tools) used the same timing and pitch      //
    // finder (autocorrelation with parabolic interpolation).                   //
    // ------------------------------------------------------------------------- //
    const MT = (function () {
        const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
        const METERS = ["4/4", "3/4", "2/4", "6/8"];
        const FEELS = ["Straight", "Swing", "Shuffle"];
        const MIN_BPM = 40, MAX_BPM = 250;

        let audioCtx = null;
        /** One AudioContext for every tool, resumed on a tap (browsers start it paused). */
        function audio() {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            if (!audioCtx) { try { audioCtx = new AC(); } catch (e) { return null; } }
            if (audioCtx.state === "suspended") { try { audioCtx.resume(); } catch (e) { /* next tap */ } }
            return audioCtx;
        }

        function clock(ms) {
            const total = Math.max(0, Math.floor(ms / 10));
            const cs = total % 100, s = Math.floor(total / 100) % 60, m = Math.floor(total / 6000) % 60, h = Math.floor(total / 360000);
            const two = (n) => (n < 10 ? "0" : "") + n;
            return { main: (h ? h + ":" + two(m) : two(m)) + ":" + two(s), cs: "." + two(cs) };
        }
        function mmss(sec) {
            if (!isFinite(sec) || sec < 0) sec = 0;
            const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
            return `${m}:${s < 10 ? "0" : ""}${s}`;
        }

        // ------------------------------------------------------------ metronome
        class Metronome {
            constructor(saved) {
                const s = saved || {};
                this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(+s.bpm || 100)));
                this.meter = METERS.includes(s.meter) ? s.meter : "4/4";
                this.feel = FEELS.includes(s.feel) ? s.feel : "Straight";
                this.on = false;
                this.sub = 0;
                this.queue = [];
                this.taps = [];
                this.timer = null;
            }
            settings() { return { bpm: this.bpm, meter: this.meter, feel: this.feel }; }
            beatsPerBar() { return this.meter === "6/8" ? 6 : this.meter === "3/4" ? 3 : this.meter === "2/4" ? 2 : 4; }
            strong(beat) { return beat === 0 || (this.meter === "6/8" && beat === 3); }
            setBpm(v) { if (isFinite(+v)) this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(+v))); }
            nudge(d) { this.setBpm(this.bpm + d); }
            setMeter(v) { if (METERS.includes(v)) { this.meter = v; this.resync(); } }
            setFeel(v) { if (FEELS.includes(v)) { this.feel = v; this.resync(); } }
            resync() { this.sub = 0; if (this.on && audioCtx) this.next = audioCtx.currentTime + 0.05; }
            /** Tap tempo: the average of the last few taps (a gap over 2.5 s starts again). */
            tap() {
                const now = performance.now();
                if (this.taps.length && now - this.taps[this.taps.length - 1] > 2500) this.taps = [];
                this.taps.push(now);
                if (this.taps.length > 5) this.taps.shift();
                if (this.taps.length > 1) this.setBpm(60000 / ((this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1)));
            }
            start() {
                const ctx = audio();
                if (!ctx) return false;
                this.on = true; this.sub = 0; this.queue = [];
                this.next = ctx.currentTime + 0.06;
                this.schedule();
                return true;
            }
            stop() { this.on = false; clearTimeout(this.timer); this.queue = []; }
            toggle() { if (this.on) { this.stop(); return true; } return this.start(); }
            schedule() {
                if (!this.on || !audioCtx) return;
                while (this.next < audioCtx.currentTime + 0.12) { this.click(this.sub, this.next); this.advance(); }
                this.timer = setTimeout(() => this.schedule(), 25);
            }
            // 6/8 clicks eighth notes at twice the BPM; swing/shuffle stretch the even beats.
            advance() {
                let step = 60 / this.bpm;
                if (this.meter === "6/8") step = step / 2;
                else if (this.feel === "Shuffle") step = this.sub % 2 === 0 ? step * 4 / 3 : step * 2 / 3;
                else if (this.feel === "Swing") step = this.sub % 2 === 0 ? step * 1.2 : step * 0.8;
                this.next += step;
                this.sub = (this.sub + 1) % this.beatsPerBar();
            }
            click(beat, time) {
                const ctx = audioCtx, osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = "triangle";
                let pitch = 440, vol = 0.75;
                if (this.meter === "6/8") { if (beat === 0) { pitch = 920; vol = 1; } else if (beat === 3) { pitch = 660; vol = 0.8; } else vol = 0.4; }
                else if (beat === 0) { pitch = 880; vol = 1; }
                gain.gain.setValueAtTime(0, time);
                gain.gain.linearRampToValueAtTime(vol, time + 0.004);
                gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
                osc.frequency.setValueAtTime(pitch, time);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(time); osc.stop(time + 0.05);
                this.queue.push({ beat, time });
                if (this.queue.length > 32) this.queue.shift();
            }
            /** The newest beat that has sounded since the last call, or -1. */
            takeBeat() {
                if (!this.on || !audioCtx) return -1;
                let latest = -1;
                while (this.queue.length && this.queue[0].time <= audioCtx.currentTime) latest = this.queue.shift().beat;
                return latest;
            }
        }

        // ------------------------------------------------------------ tuner
        function autoCorrelate(buffer, sampleRate) {
            let size = buffer.length, rms = 0;
            for (let i = 0; i < size; i++) rms += buffer[i] * buffer[i];
            rms = Math.sqrt(rms / size);
            if (rms < 0.005) return -1;
            let r1 = 0, r2 = size - 1;
            const thres = 0.15;
            for (let i = 0; i < size / 2; i++) if (Math.abs(buffer[i]) < thres) { r1 = i; break; }
            for (let i = 1; i < size / 2; i++) if (Math.abs(buffer[size - i]) < thres) { r2 = size - i; break; }
            const b = buffer.slice(r1, r2);
            size = b.length;
            const c = new Float32Array(size);
            for (let i = 0; i < size; i++) { let sum = 0; for (let j = 0; j < size - i; j++) sum += b[j] * b[j + i]; c[i] = sum; }
            let d = 0;
            while (d < size - 1 && c[d] > c[d + 1]) d++;
            let maxval = -1, maxpos = -1;
            for (let i = d; i < size; i++) if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
            if (maxpos <= 0) return -1;
            let t0 = maxpos;
            const x1 = c[t0 - 1], x2 = c[t0], x3 = c[t0 + 1] || 0;
            const a = (x1 + x3 - 2 * x2) / 2, bb = (x3 - x1) / 2;
            if (a) t0 = t0 - bb / (2 * a);
            return sampleRate / t0;
        }
        function reading(f) {
            const noteNum = 12 * Math.log2(f / 440) + 69, n = Math.round(noteNum);
            return { note: NOTE_NAMES[((n % 12) + 12) % 12], octave: Math.floor(n / 12) - 1, hz: f, cents: Math.round(1200 * Math.log2(f / (440 * Math.pow(2, (n - 69) / 12)))), at: performance.now() };
        }
        class Tuner {
            constructor() { this.on = false; this.reading = null; this.error = ""; }
            async start() {
                this.error = "";
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return (this.error = "This browser can't use the microphone.");
                const ctx = audio();
                if (!ctx) return (this.error = "This browser can't run the tuner.");
                try {
                    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
                } catch (err) {
                    return (this.error = err && err.name === "NotAllowedError"
                        ? "The microphone is blocked. Allow it for this site (the icon in the address bar), then try again."
                        : "The microphone couldn't start. Is another app using it?");
                }
                this.analyser = ctx.createAnalyser();
                this.analyser.fftSize = 2048;
                this.buf = new Float32Array(this.analyser.fftSize);
                this.src = ctx.createMediaStreamSource(this.stream);
                this.src.connect(this.analyser);
                this.on = true;
                this.reading = null;
                this.listen();
                return "";
            }
            listen() {
                if (!this.on || !this.analyser) return;
                this.analyser.getFloatTimeDomainData(this.buf);
                const f = autoCorrelate(this.buf, audioCtx.sampleRate);
                if (f > 50 && f < 2000) this.reading = reading(f);
                else if (this.reading && performance.now() - this.reading.at > 1500) this.reading = null;
                this.timer = setTimeout(() => this.listen(), 50);
            }
            stop() {
                this.on = false;
                clearTimeout(this.timer);
                try { if (this.src) this.src.disconnect(); } catch (e) { /* already gone */ }
                if (this.stream) this.stream.getTracks().forEach(t => t.stop());
                this.stream = null; this.src = null; this.analyser = null; this.reading = null;
            }
            /** "flat" | "sharp" | "ok" | "listen" | "off" */
            verdict() {
                if (!this.on) return "off";
                if (!this.reading) return "listen";
                return this.reading.cents < -5 ? "flat" : this.reading.cents > 5 ? "sharp" : "ok";
            }
        }

        // ------------------------------------------------------------ stopwatch
        class Stopwatch {
            constructor() { this.running = false; this.start0 = 0; this.held = 0; this.runs = []; }
            elapsed() { return this.running ? performance.now() - this.start0 : this.held; }
            toggle() {
                if (this.running) { this.held = performance.now() - this.start0; this.running = false; }
                else { this.start0 = performance.now() - this.held; this.running = true; }
            }
            lap() {
                const t = this.elapsed();
                if (t <= 0) return;
                const prev = this.runs.length ? this.runs[this.runs.length - 1].t : 0;
                this.runs.push({ t, split: t - prev });
                if (this.runs.length > 99) this.runs.shift();
            }
            /** First press: back to zero. Pressed again at zero: clears the runs. */
            reset() { if (this.running || this.held > 0) { this.running = false; this.held = 0; } else this.runs = []; }
            atZero() { return !this.running && this.held === 0; }
        }

        // ------------------------------------------------------------ saved tracks (IndexedDB)
        const DB_NAME = "BandTrackCache", STORE = "tracks";
        let dbP = null;
        function db() {
            if (dbP) return dbP;
            dbP = new Promise((resolve) => {
                try {
                    const req = indexedDB.open(DB_NAME, 1);
                    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" }); };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = req.onblocked = () => resolve(null);
                } catch (e) { resolve(null); }
            });
            return dbP;
        }
        function run(mode, fn) {
            return db().then((d) => new Promise((resolve) => {
                if (!d) return resolve(null);
                try {
                    const tx = d.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
                    tx.oncomplete = () => resolve(req ? req.result : true);
                    tx.onerror = tx.onabort = () => resolve(null);
                } catch (e) { resolve(null); }
            }));
        }
        const cache = {
            saved: new Set(),
            saving: new Set(),
            urls: {},
            ready: null,
            /** Loads the list of saved ids once (call before has()). */
            load() { if (!this.ready) this.ready = run("readonly", s => s.getAllKeys()).then(k => { (k || []).forEach(id => this.saved.add(String(id))); return this.saved; }); return this.ready; },
            has(id) { return this.saved.has(String(id)); },
            isSaving(id) { return this.saving.has(String(id)); },
            /** A playable address for a saved track ("" when it isn't saved). */
            async urlFor(id) {
                id = String(id);
                if (this.urls[id]) return this.urls[id];
                const rec = await run("readonly", s => s.get(id));
                if (!rec || !rec.blob) return "";
                this.urls[id] = URL.createObjectURL(rec.blob);
                return this.urls[id];
            },
            /** Downloads a track and keeps it in this browser. Resolves true when saved. */
            async save(id, url, title) {
                id = String(id);
                if (!url || this.saved.has(id) || this.saving.has(id)) return this.saved.has(id);
                this.saving.add(id);
                let ok = false;
                try {
                    const res = await fetch(url);
                    if (!res.ok) throw new Error("HTTP " + res.status);
                    const blob = await res.blob();
                    if (!blob.size) throw new Error("empty file");
                    ok = !!(await run("readwrite", s => s.put({ id, title: String(title || ""), blob, savedAt: Date.now() })));
                    if (ok) this.saved.add(id);
                } catch (e) { console.warn("Couldn't save a track for offline use:", title || id, e); }
                this.saving.delete(id);
                return ok;
            },
            async remove(id) {
                id = String(id);
                await run("readwrite", s => s.delete(id));
                this.saved.delete(id);
                if (this.urls[id]) { URL.revokeObjectURL(this.urls[id]); delete this.urls[id]; }
            }
        };

        /** The tuner dial (a needle from -50 to +50 cents). `cls` lets each element style it. */
        function dialSvg(cls) {
            let ticks = "";
            for (let c = -50; c <= 50; c += 10) {
                const a = (c * 1.8 - 90) * Math.PI / 180, r1 = c === 0 ? 96 : 104, r2 = 118;
                ticks += `<line x1="${(150 + r1 * Math.cos(a)).toFixed(1)}" y1="${(150 + r1 * Math.sin(a)).toFixed(1)}" x2="${(150 + r2 * Math.cos(a)).toFixed(1)}" y2="${(150 + r2 * Math.sin(a)).toFixed(1)}" stroke="currentColor" stroke-opacity="${c === 0 ? 1 : 0.45}" stroke-width="${c === 0 ? 4 : 2}" stroke-linecap="round"/>`;
            }
            return `<svg class="${cls || "mt-dial"}" viewBox="0 0 300 170" aria-hidden="true"><path d="M40 150 A110 110 0 0 1 260 150" fill="none" stroke="currentColor" stroke-opacity=".18" stroke-width="16" stroke-linecap="round"/>
                <path d="M128 41 A110 110 0 0 1 172 41" fill="none" stroke="#1fbf5c" stroke-width="16" stroke-linecap="round"/>${ticks}
                <text x="34" y="168" font-size="16" fill="currentColor" font-weight="700" text-anchor="middle">♭</text><text x="266" y="168" font-size="16" fill="currentColor" font-weight="700" text-anchor="middle">♯</text>
                <g class="mt-needle" style="transform-origin:150px 150px;transition:transform .12s linear"><line x1="150" y1="150" x2="150" y2="36" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></g><circle cx="150" cy="150" r="9" fill="currentColor"/></svg>`;
        }

        return { Metronome, Tuner, Stopwatch, cache, audio, clock, mmss, dialSvg, autoCorrelate, METERS, FEELS, MIN_BPM, MAX_BPM };
    })();
    /* </music-tools-engine> */

    const esc = (v) => String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const store = {
        get(k, d) { try { const v = localStorage.getItem("field:" + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
        set(k, v) { try { localStorage.setItem("field:" + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
    };

    const SITE = "https://www.laingsburgbandboosters.org";
    // The key from the install link (kept so the home-screen app can refresh the list).
    const cleanKey = (v) => String(v || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const keyFrom = (text) => { const m = /[?&#]k=([A-Za-z0-9_-]{24,64})/.exec(String(text || "")); return m ? m[1] : (/^[A-Za-z0-9_-]{24,64}$/.test(String(text || "").trim()) ? String(text).trim() : ""); };
    const urlKey = cleanKey(new URLSearchParams(location.search).get("k")) || keyFrom(location.hash);
    if (urlKey) store.set("key", urlKey);
    let KEY = urlKey || store.get("key", "");

    const app = {
        tab: store.get("tab", "tracks"),
        tracks: store.get("tracks", []),          // [{ id, title, sub, url }]
        listAt: store.get("listAt", 0),
        status: "",
        bad: false,
        busy: false,
        metro: new MT.Metronome(store.get("metro", null)),
        tuner: new MT.Tuner(),
        sw: new MT.Stopwatch(),
        player: { audio: null, idx: -1, loading: false },
        installEvt: null
    };
    const root = document.getElementById("app");
    const standalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    // ---------------------------------------------------------------- tracks
    async function refreshList() {
        if (!KEY) { app.status = ""; render(); return; }
        if (navigator.onLine === false) { app.status = "No signal: using the tracks saved on this phone."; app.bad = false; render(); return; }
        app.busy = true; app.status = "Checking for new tracks…"; app.bad = false; render();
        try {
            const res = await fetch(SITE + "/_functions/fieldTracks?k=" + encodeURIComponent(KEY), { cache: "no-store", credentials: "omit" });
            const data = await res.json().catch(() => ({}));
            if (res.status === 403) { app.status = "This install link was replaced. Ask for the new link on the Podium (📲 Offline app). Saved tracks still play."; app.bad = true; }
            else if (!res.ok || !Array.isArray(data.tracks)) throw new Error("HTTP " + res.status);
            else {
                app.tracks = data.tracks; app.listAt = Date.now();
                store.set("tracks", app.tracks); store.set("listAt", app.listAt);
                await saveAll();
                // Drop saved copies of tracks no longer in the Field Pack.
                const keep = new Set(app.tracks.map(t => "trk:" + t.id));
                await MT.cache.load();
                for (const id of [...MT.cache.saved]) if (id.startsWith("trk:") && !keep.has(id)) await MT.cache.remove(id);
                const missing = app.tracks.filter(t => !MT.cache.has("trk:" + t.id)).length;
                app.status = missing ? `${missing} track${missing === 1 ? "" : "s"} couldn't be saved. Try again with a better signal.` : app.tracks.length ? "All tracks are saved on this phone. They play with no signal." : "No show tracks yet. Add them in the Media Handler and set them to Field Pack.";
                app.bad = !!missing;
            }
        } catch (e) {
            app.status = "Couldn't reach the site: using the tracks saved on this phone."; app.bad = false;
        }
        app.busy = false; render();
    }
    async function saveAll() {
        for (const t of app.tracks) {
            const key = "trk:" + t.id;
            if (MT.cache.has(key) || !t.url) continue;
            app.status = `Saving ${t.title}…`; render();
            await MT.cache.save(key, t.url, t.title);
        }
    }
    async function play(n) {
        const t = app.tracks[n], pl = app.player;
        if (!t) return;
        if (pl.idx === n && pl.audio) { if (pl.audio.paused) start(); else pl.audio.pause(); render(); return; }
        if (pl.audio) pl.audio.pause();
        pl.idx = n; pl.loading = true; pl.audio = null; render();
        const local = await MT.cache.urlFor("trk:" + t.id);
        if (pl.idx !== n) return;
        const src = local || (navigator.onLine !== false ? t.url : "");
        pl.loading = false;
        if (!src) { app.status = "That track isn't saved on this phone yet."; app.bad = true; render(); return; }
        pl.audio = new Audio(src);
        pl.audio.addEventListener("play", render); pl.audio.addEventListener("pause", render);
        pl.audio.addEventListener("ended", () => { if (n + 1 < app.tracks.length) play(n + 1); else render(); });
        if (!local) MT.cache.save("trk:" + t.id, t.url, t.title).then(render);
        start();
    }
    function start() { const p = app.player.audio && app.player.audio.play(); if (p && p.catch) p.catch(() => {}); }

    // ---------------------------------------------------------------- drawing
    function setupHtml() {
        return `<div class="setup"><b style="color:#fff">Connect your show tracks</b><br>Paste the link from the Podium (Field tools → 📲 Offline app → Copy link).
            <input data-setup placeholder="Paste the link here" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="go small" data-act="setup">Connect</button></div>`;
    }
    function tracksHtml() {
        if (!KEY) return setupHtml();
        const pl = app.player;
        const saved = app.tracks.filter(t => MT.cache.has("trk:" + t.id)).length;
        const cur = app.tracks[pl.idx];
        const playing = pl.audio && !pl.audio.paused;
        return `<div class="now"><div class="nt"><b>${esc(cur ? cur.title : app.tracks.length ? "Pick a track" : "No tracks yet")}</b><small>${esc(cur ? cur.sub || "" : "")}</small></div>
                <div class="bar" data-seek><i data-live="prog"></i></div><div class="time" data-live="time">0:00</div>
                <div class="pbtns"><button data-act="prev" aria-label="Previous" ${pl.idx > 0 ? "" : "disabled"}>⏮</button><button class="big" data-act="play" aria-label="Play or pause" ${app.tracks.length ? "" : "disabled"}>${pl.loading ? "…" : playing ? "❚❚" : "▶"}</button><button data-act="next" aria-label="Next" ${pl.idx < app.tracks.length - 1 ? "" : "disabled"}>⏭</button><button data-act="back10" aria-label="Back 10 seconds" ${pl.audio ? "" : "disabled"}>↺10</button></div></div>
            <ol class="list">${app.tracks.map((t, i) => `<li><button data-trk="${i}" class="${i === pl.idx ? "on" : ""}"><span class="tt"><b>${esc(t.title)}</b><small>${esc(t.sub || "")}</small></span>${MT.cache.has("trk:" + t.id) ? `<i class="ok">✓</i>` : MT.cache.isSaving("trk:" + t.id) ? `<i class="dim">…</i>` : `<i class="dim">○</i>`}</button></li>`).join("")}</ol>
            <div class="foot">${app.tracks.length ? `${saved} of ${app.tracks.length} saved on this phone · ` : ""}<button class="link" data-act="refresh" ${app.busy ? "disabled" : ""}>${app.busy ? "Checking…" : "Check for new tracks"}</button></div>`;
    }
    function metroHtml() {
        const m = app.metro, n = m.beatsPerBar();
        const seg = (k, list, cur) => `<div class="seg">${list.map(v => `<button data-mt="${k}" data-v="${esc(v)}" class="${v === cur ? "on" : ""}">${esc(v)}</button>`).join("")}</div>`;
        return `<div class="center"><div class="bpm"><button class="step" data-mt="minus" aria-label="Slower">−</button><div><b data-live="bpm">${m.bpm}</b><small>BPM</small></div><button class="step" data-mt="plus" aria-label="Faster">+</button></div>
            <div class="beats" data-live="beats">${Array.from({ length: n }, (_, i) => `<i class="${m.strong(i) ? "down" : ""}" data-b="${i}"></i>`).join("")}</div>
            <button class="tap" data-mt="tap">Tap the beat</button>
            <button class="go ${m.on ? "stop" : ""}" data-mt="toggle">${m.on ? "■ Stop" : "▶ Start"}</button>
            ${seg("meter", MT.METERS, m.meter)}${seg("feel", MT.FEELS, m.feel)}<small class="hint">No click? Check the phone isn't on silent.</small></div>`;
    }
    function tunerHtml() {
        const t = app.tuner;
        return `<div class="center">${MT.dialSvg("dial")}<div class="note" data-live="note">--</div><div class="hz" data-live="hz">${t.on ? "Listening… play one long note." : esc(t.error || "Uses the microphone. Play one long note close to it.")}</div>
            <div class="verdict" data-live="verdict">${t.on ? "Listening" : "Off"}</div><button class="go ${t.on ? "stop" : ""}" data-tn>${t.on ? "■ Stop tuner" : "🎤 Start tuner"}</button></div>`;
    }
    function swHtml() {
        const w = app.sw, c = MT.clock(w.elapsed()), zero = w.atZero();
        return `<div class="center"><div class="clock" data-live="clock">${c.main}<span>${c.cs}</span></div>
            <div class="row"><button class="go ${w.running ? "stop" : ""}" data-sw="toggle">${w.running ? "❚❚ Pause" : "▶ Start"}</button><button class="ghost" data-sw="lap" ${zero ? "disabled" : ""}>Lap</button><button class="ghost" data-sw="reset" ${zero && !w.runs.length ? "disabled" : ""}>${zero && w.runs.length ? "Clear" : "Reset"}</button></div>
            ${w.runs.length ? `<ol class="runs">${w.runs.slice().reverse().map((r, i) => { const n = w.runs.length - i, t = MT.clock(r.t), sp = MT.clock(r.split); return `<li><span>Run ${n}</span><b>${t.main}${t.cs}</b>${w.runs.length > 1 ? `<small>+${sp.main}${sp.cs}</small>` : ""}</li>`; }).join("")}</ol>` : ""}</div>`;
    }
    function installHtml() {
        if (standalone() || store.get("hideInstall", false)) return "";
        const how = app.installEvt ? `<button class="go small" data-act="install">📲 Install the app</button>`
            : isIOS() ? `In Safari tap <b>Share</b> (the square with the arrow), then <b>Add to Home Screen</b>.`
            : `In Chrome tap <b>⋮</b>, then <b>Add to Home screen</b> (or <b>Install app</b>).`;
        return `<div class="install"><b>Put this on your home screen</b> so it opens with no signal. ${how} <button class="link" data-act="hideInstall">Hide</button></div>`;
    }
    function render() {
        const tabs = [["tracks", "🎵 Tracks"], ["metronome", "🥁 Metronome"], ["tuner", "🎚️ Tuner"], ["stopwatch", "⏲️ Stopwatch"]];
        const live = { tracks: !!(app.player.audio && !app.player.audio.paused), metronome: app.metro.on, tuner: app.tuner.on, stopwatch: app.sw.running };
        const body = app.tab === "metronome" ? metroHtml() : app.tab === "tuner" ? tunerHtml() : app.tab === "stopwatch" ? swHtml() : tracksHtml();
        const sun = store.get("sun", true);
        document.body.classList.toggle("sun", sun);
        const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", sun ? "#ffffff" : "#16141b");
        root.innerHTML = `<header><span class="logo" aria-hidden="true">🎺</span><b>Field Tools</b>${navigator.onLine === false ? `<span class="off">No signal</span>` : ""}<button class="sunbtn" data-act="sun" aria-label="${sun ? "Switch to dark colors (indoors)" : "Switch to bright-sun colors (outside)"}">${sun ? "🌙 Dark" : "☀️ Sun"}</button></header>
            ${installHtml()}
            <nav>${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === app.tab ? "on" : ""} ${live[k] && k !== app.tab ? "live" : ""}">${l}</button>`).join("")}</nav>
            <main>${body}</main>
            ${app.status && (app.tab === "tracks" || app.bad) ? `<div class="status ${app.bad ? "bad" : ""}">${esc(app.status)}</div>` : ""}`;
        const on = root.querySelector("nav .on"); if (on && on.scrollIntoView) try { on.scrollIntoView({ inline: "center", block: "nearest" }); } catch (e) { /* old browser */ }
    }

    // ---------------------------------------------------------------- events
    root.addEventListener("click", async (e) => {
        const seek = e.target.closest("[data-seek]");
        if (seek && app.player.audio && app.player.audio.duration) { const r = seek.getBoundingClientRect(); app.player.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * app.player.audio.duration; return; }
        const b = e.target.closest("button"); if (!b) return;
        const d = b.dataset;
        if (d.tab) { app.tab = d.tab; store.set("tab", d.tab); render(); return; }
        if (d.trk) { play(+d.trk); return; }
        if (d.act === "play") { if (app.player.idx < 0) play(0); else play(app.player.idx); return; }
        if (d.act === "prev") { play(app.player.idx - 1); return; }
        if (d.act === "next") { play(app.player.idx + 1); return; }
        if (d.act === "back10" && app.player.audio) { app.player.audio.currentTime = Math.max(0, app.player.audio.currentTime - 10); return; }
        if (d.act === "refresh") { refreshList(); return; }
        if (d.act === "setup") {
            const k = keyFrom((root.querySelector("[data-setup]") || {}).value);
            if (!k) { app.status = "That doesn't look like the Field Tools link. Copy it again on the Podium."; app.bad = true; render(); return; }
            KEY = k; store.set("key", k); refreshList(); return;
        }
        if (d.act === "sun") { store.set("sun", !store.get("sun", true)); render(); return; }
        if (d.act === "hideInstall") { store.set("hideInstall", true); render(); return; }
        if (d.act === "install" && app.installEvt) { app.installEvt.prompt(); app.installEvt = null; render(); return; }
        if (d.mt) {
            const m = app.metro;
            if (d.mt === "toggle") m.toggle();
            else if (d.mt === "tap") { m.tap(); b.classList.add("flash"); setTimeout(() => b.classList.remove("flash"), 80); const n = root.querySelector('[data-live="bpm"]'); if (n) n.textContent = m.bpm; store.set("metro", m.settings()); return; }
            else if (d.mt === "minus") m.nudge(-1); else if (d.mt === "plus") m.nudge(1);
            else if (d.mt === "meter") m.setMeter(d.v); else if (d.mt === "feel") m.setFeel(d.v);
            store.set("metro", m.settings()); render(); return;
        }
        if (d.tn !== undefined) { if (app.tuner.on) app.tuner.stop(); else await app.tuner.start(); render(); return; }
        if (d.sw) { if (d.sw === "toggle") app.sw.toggle(); else if (d.sw === "lap") app.sw.lap(); else app.sw.reset(); render(); }
    });
    // Swipe left/right on the tool to move between tools.
    let sx = 0, sy = 0, swipeOk = false;
    root.addEventListener("touchstart", (e) => { const t = e.target; swipeOk = !!(t.closest && t.closest("main")) && !(t.closest && t.closest("button, .list, .runs, [data-seek]")); sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    root.addEventListener("touchend", (e) => {
        if (!swipeOk) return;
        const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        const order = ["tracks", "metronome", "tuner", "stopwatch"], i = order.indexOf(app.tab);
        app.tab = order[(i + (dx < 0 ? 1 : -1) + order.length) % order.length]; store.set("tab", app.tab); render();
    }, { passive: true });
    window.addEventListener("online", () => { render(); refreshList(); });
    window.addEventListener("offline", render);
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); app.installEvt = e; render(); });

    // ---------------------------------------------------------------- live bits
    let beatOff = 0;
    (function loop() {
        requestAnimationFrame(loop);
        const beat = app.metro.takeBeat();
        if (beat >= 0) {
            root.querySelectorAll('[data-live="beats"] i').forEach(i => i.classList.toggle("on", +i.dataset.b === beat));
            clearTimeout(beatOff); beatOff = setTimeout(() => root.querySelectorAll('[data-live="beats"] i').forEach(i => i.classList.remove("on")), 90);
        }
        if (app.sw.running) { const n = root.querySelector('[data-live="clock"]'); if (n) { const c = MT.clock(app.sw.elapsed()), h = `${c.main}<span>${c.cs}</span>`; if (n._l !== h) { n.innerHTML = h; n._l = h; } } }
        if (app.tuner.on) {
            const note = root.querySelector('[data-live="note"]');
            if (note) {
                const rd = app.tuner.reading, v = app.tuner.verdict(), k = rd ? rd.note + rd.octave + rd.cents : v;
                if (note._l !== k) {
                    note._l = k;
                    note.innerHTML = rd ? `${esc(rd.note)}<sub>${rd.octave}</sub>` : "--";
                    root.querySelector('[data-live="hz"]').textContent = rd ? `${rd.hz.toFixed(1)} Hz · ${rd.cents > 0 ? "+" : ""}${rd.cents} cents` : "Listening… play one long note.";
                    const vd = root.querySelector('[data-live="verdict"]'); vd.textContent = { ok: "In tune", flat: "Flat", sharp: "Sharp", listen: "Listening", off: "Off" }[v]; vd.className = "verdict " + v;
                    const nd = root.querySelector(".mt-needle"); if (nd) nd.style.transform = `rotate(${(Math.max(-50, Math.min(50, rd ? rd.cents : 0)) * 1.8).toFixed(1)}deg)`;
                }
            }
        }
        const a = app.player.audio;
        if (a && app.tab === "tracks") {
            const bar = root.querySelector('[data-live="prog"]'), time = root.querySelector('[data-live="time"]');
            if (bar) bar.style.width = a.duration ? `${(a.currentTime / a.duration) * 100}%` : "0%";
            if (time) { const t = `${MT.mmss(a.currentTime || 0)}${a.duration ? " / " + MT.mmss(a.duration) : ""}`; if (time._l !== t) { time.textContent = t; time._l = t; } }
        }
    })();

    // ---------------------------------------------------------------- start
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(err => console.warn("Offline mode couldn't start:", err));
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    MT.cache.load().then(() => { render(); refreshList(); });
    render();
})();
