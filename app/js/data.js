/* ============================================================
   data.js: your playlists, turned into one tidy catalog.
   Sources: M3U playlists, Xtream accounts, Stalker portals and media
   servers: Jellyfin, Emby, Plex (several allowed).
   An M3U address that is really an Xtream one (get.php?username=…)
   becomes an Xtream source: you get covers, plots and the TV guide.
   Catalog (kept in IndexedDB, refreshed every 6 hours in the background):
     live:   categories + channels (number, logo, guide id, quality,
             variants of one channel put together)
     movies: categories + movies (cover, year, rating, date added)
     series: categories + series (M3U episodes grouped into shows)
   Also here: favorites, "My List", recent channels, resume points.
   ============================================================ */
(function (global) {
    "use strict";

    var TV = global.TV, S = TV.smart, T = TV.t;
    var MAX_AGE = 6 * 3600 * 1000;
    var CATALOG_V = 2;          // raise it when smart.js reads names differently: catalogs are then refreshed

    /* ---------- sources ---------- */
    function sources() { return TV.load("sources", []) || []; }
    function saveSources(list) { TV.save("sources", list); }

    function normServer(s) {
        s = String(s || "").trim().replace(/\s+/g, "");
        if (!s) return "";
        if (!/^https?:\/\//i.test(s)) s = "http://" + s;
        s = s.replace(/\/(player_api\.php|get\.php|xmltv\.php|panel_api\.php|c\/?)(\?.*)?$/i, "").replace(/\/+$/, "");
        return s;
    }
    /* An M3U address from an Xtream panel: get.php?username=U&password=P */
    function xtreamFromUrl(url) {
        var m = String(url || "").match(/^(https?:\/\/[^\/?#]+(?:\/[^?#]*?)?)\/get\.php\?(.*)$/i);
        if (!m) return null;
        var q = {};
        m[2].split("&").forEach(function (kv) { var p = kv.split("="); q[decodeURIComponent(p[0] || "").toLowerCase()] = decodeURIComponent((p[1] || "").replace(/\+/g, " ")); });
        if (!q.username || !q.password) return null;
        return { server: m[1], user: q.username, pass: q.password };
    }

    function addSource(src) {
        var list = sources();
        if (src.type === "m3u") {
            var x = xtreamFromUrl(src.url);
            if (x) src = { type: "xtream", name: src.name, server: x.server, user: x.user, pass: x.pass, epg: src.epg || "" };
        }
        if (src.type === "xtream") src.server = normServer(src.server);
        if (src.type === "m3u") src.url = String(src.url || "").trim();
        if (src.type === "stalker" && TV.stalker) { src.portal = TV.stalker.normPortal(src.portal); src.mac = TV.stalker.normMac(src.mac) || String(src.mac || "").trim(); }
        if (src.type === "jellyfin" && TV.media) { src.server = TV.media.normServer(src.server); if (!String(src.name || "").trim()) src.autoName = true; }
        src.id = src.id || TV.uid();
        src.name = String(src.name || "").trim() || hostName(src.type === "xtream" || src.type === "jellyfin" ? src.server : src.type === "stalker" ? src.portal : src.url) || T("My playlist");
        list.push(src);
        saveSources(list);
        return src;
    }
    function hostName(u) { var m = String(u || "").match(/^https?:\/\/([^\/:?#]+)/i); return m ? m[1].replace(/^www\./, "") : ""; }
    function removeSource(id) {
        saveSources(sources().filter(function (s) { return s.id !== id; }));
        TV.idb.del("cat:" + id); TV.idb.del("catm:" + id); TV.idb.del("cats:" + id); TV.idb.del("epg:" + id);
        delete cats[id];
        rebuild();
    }
    function updateSource(id, patch) {
        var list = sources();
        list.forEach(function (s) { if (s.id === id) Object.keys(patch).forEach(function (k) { s[k] = patch[k]; }); });
        saveSources(list);
    }

    /* ---------- Xtream ---------- */
    function xApi(src, action, extra) {
        var u = src.server + "/player_api.php?username=" + encodeURIComponent(src.user) + "&password=" + encodeURIComponent(src.pass);
        if (action) u += "&action=" + action;
        if (extra) u += "&" + extra;
        // the full lists of a big account (100,000 movies) can take minutes to arrive on a TV
        return TV.fetchJSON(u, { provider: true, timeout: !action ? 20000 : /_streams$|^get_series$/.test(action) ? 240000 : 90000 });
    }
    function xAuth(src) {
        return xApi(src, "").then(function (j) {
            var ui = j && j.user_info;
            if (!ui || String(ui.auth) !== "1") throw new Error(T("The server refused this username or password."));
            if (ui.status && !/^active$/i.test(ui.status)) {
                var exp = ui.exp_date ? new Date(ui.exp_date * 1000).toLocaleDateString(TV.locale) : "";
                throw new Error(exp ? T("This subscription is {status} (end: {date}).", { status: ui.status, date: exp }) : T("This subscription is {status}.", { status: ui.status }));
            }
            return j;
        });
    }
    function xUrl(src, kind, id, ext) {
        var p = src.server + "/" + kind + "/" + encodeURIComponent(src.user) + "/" + encodeURIComponent(src.pass) + "/" + id;
        return p + "." + (ext || "ts");
    }

    function catList(raw, srcId, kind) {
        return (raw || []).map(function (c) {
            var info = S.category(c.category_name || c.name || "");
            return { id: srcId + ":" + c.category_id, name: info.name, raw: info.raw, tag: info.tag, lang: info.lang, adult: info.adult, kind: kind, count: 0 };
        });
    }

    function loadXtream(src, progress, onLive) {
        var out = { id: src.id, v: CATALOG_V, at: Date.now(), type: "xtream", live: { cats: [], chans: [] }, movies: { cats: [], items: [] }, series: { cats: [], items: [] }, failed: {} };
        function lists(what) {
            return function (r) {
                if (!Array.isArray(r[1])) throw new Error(r[1] && r[1].error ? String(r[1].error) : T("no list"));
                if (!Array.isArray(r[0])) r[0] = [];
                return r;
            };
        }
        function lost(what) { return function (e) { TV.log(what + ": " + e.message); out.failed[what] = e.message; return [[], []]; }; }
        progress(T("Connecting to {name}…", { name: src.name }));
        return xAuth(src).then(function (auth) {
            out.account = { exp: auth.user_info.exp_date ? auth.user_info.exp_date * 1000 : 0, max: auth.user_info.max_connections, formats: auth.user_info.allowed_output_formats || [] };
            progress(T("Loading channels…"));
            return Promise.all([xApi(src, "get_live_categories"), xApi(src, "get_live_streams")]);
        }).then(function (r) {
            out.live.cats = catList(r[0], src.id, "live");
            var num = 0;
            (r[1] || []).forEach(function (c) {
                if (!c || S.isSeparator(c.name)) return;
                var info = S.channel(c.name);
                num++;
                out.live.chans.push({
                    id: src.id + "|" + c.stream_id, src: src.id, sid: c.stream_id, num: num, name: info.name, raw: c.name !== info.name ? c.name : undefined, q: info.quality, key: info.key,
                    logo: c.stream_icon || "", cat: src.id + ":" + c.category_id, epg: c.epg_channel_id || "", arch: parseInt(c.tv_archive, 10) ? (parseInt(c.tv_archive_duration, 10) || 1) : 0
                });
            });
            if (onLive) onLive(out);
            progress(T("Loading movies…"));
            return Promise.all([xApi(src, "get_vod_categories"), xApi(src, "get_vod_streams")]).then(lists("movies")).catch(lost("movies"));
        }).then(function (r) {
            out.movies.cats = catList(r[0], src.id, "movie");
            (r[1] || []).forEach(function (m) {
                if (!m || S.isSeparator(m.name)) return;
                var t = S.title(m.name);
                out.movies.items.push({
                    id: src.id + "|m" + m.stream_id, src: src.id, sid: m.stream_id, kind: "movie", name: m.name, title: t.title !== m.name ? t.title : undefined, year: t.year || 0,
                    poster: m.stream_icon || "", cat: src.id + ":" + m.category_id, rating: parseFloat(m.rating) || 0, added: parseInt(m.added, 10) || 0, ext: m.container_extension || "mp4"
                });
            });
            progress(T("Loading series…"));
            return Promise.all([xApi(src, "get_series_categories"), xApi(src, "get_series")]).then(lists("series")).catch(lost("series"));
        }).then(function (r) {
            out.series.cats = catList(r[0], src.id, "series");
            (r[1] || []).forEach(function (s) {
                if (!s || S.isSeparator(s.name)) return;
                var t = S.title(s.name), y = t.year || parseInt(String(s.releaseDate || s.release_date || "").slice(0, 4), 10) || 0;
                out.series.items.push({
                    id: src.id + "|s" + s.series_id, src: src.id, seriesId: s.series_id, kind: "series", name: s.name, title: t.title !== s.name ? t.title : undefined, year: y,
                    poster: s.cover || "", cat: src.id + ":" + s.category_id, rating: parseFloat(s.rating) || 0,
                    added: parseInt(s.last_modified, 10) || 0,
                    backdrop: (s.backdrop_path && s.backdrop_path[0]) || undefined
                });
            });
            return out;
        });
    }

    /* ---------- Stalker portal (MAG): js/stalker.js, in the same catalog shape ---------- */
    function loadStalker(src, progress) {
        if (!TV.stalker) return Promise.reject(new Error("no Stalker support"));
        return TV.stalker.load(src, progress, { id: src.id, v: CATALOG_V, at: Date.now(), type: "stalker", live: { cats: [], chans: [] }, movies: { cats: [], items: [] }, series: { cats: [], items: [] }, failed: {} });
    }

    /* ---------- media servers (Jellyfin, Emby, Plex): js/media.js, in the same catalog shape ---------- */
    function isMedia(src) { return !!src && (src.type === "jellyfin" || src.type === "plex"); }
    function loadMedia(src, progress) {
        if (!TV.media) return Promise.reject(new Error("no media server support"));
        return TV.media.load(src, progress, { id: src.id, v: CATALOG_V, at: Date.now(), type: src.type, live: { cats: [], chans: [] }, movies: { cats: [], items: [] }, series: { cats: [], items: [] }, failed: {} });
    }

    /* ---------- M3U ---------- */
    function attr(line, name) {
        var re = new RegExp(name + '="([^"]*)"', "i"), m = line.match(re);
        return m ? m[1] : "";
    }
    /* The title of an #EXTINF line: after the first comma that is not inside an attribute's quotes */
    function afterComma(l) {
        var q = false;
        for (var i = 8; i < l.length; i++) {
            var c = l.charCodeAt(i);
            if (c === 34) q = !q;
            else if (c === 44 && !q) return l.slice(i + 1);
        }
        return "";
    }
    function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

    function parseM3U(text, src, progress) {
        return new Promise(function (resolve, reject) {
            if (!/#EXTM3U|#EXTINF/i.test(String(text).slice(0, 4096))) { reject(new Error(T("This address does not give an M3U playlist."))); return; }
            var lines = String(text).split(/\r?\n/), i = 0, n = lines.length;
            var out = { id: src.id, v: CATALOG_V, at: Date.now(), type: "m3u", live: { cats: [], chans: [] }, movies: { cats: [], items: [] }, series: { cats: [], items: [] }, epgUrl: "" };
            var head = lines[0] || "";
            out.epgUrl = attr(head, "url-tvg") || attr(head, "x-tvg-url") || "";
            if (out.epgUrl.indexOf(",") > 0) out.epgUrl = out.epgUrl.split(",")[0];
            var catIndex = { live: {}, movie: {}, series: {} }, shows = {}, num = 0, cur = null, grp = "";
            function cat(kind, name) {
                var idx = catIndex[kind], key = name || T("Other");
                if (!idx[key]) {
                    var info = S.category(key);
                    idx[key] = { id: src.id + ":" + kind[0] + hash(key), name: info.name, raw: key, tag: info.tag, lang: info.lang, adult: info.adult, kind: kind, count: 0 };
                    out[kind === "live" ? "live" : kind === "movie" ? "movies" : "series"].cats.push(idx[key]);
                }
                return idx[key].id;
            }
            function step() {
                var stop = Math.min(n, i + 6000);
                for (; i < stop; i++) {
                    var l = lines[i];
                    if (!l) continue;
                    if (l.charCodeAt(0) === 35) {                         // '#'
                        if (/^#EXTINF/i.test(l)) {
                            var title = afterComma(l);
                            cur = { title: title.trim() || attr(l, "tvg-name"), id: attr(l, "tvg-id"), logo: attr(l, "tvg-logo"), group: attr(l, "group-title"),
                                    chno: attr(l, "tvg-chno"), type: attr(l, "tvg-type"), catchup: attr(l, "catchup-days") || attr(l, "tvg-rec") };
                            grp = "";
                        } else if (/^#EXTGRP:/i.test(l)) grp = l.slice(8).trim();
                        continue;
                    }
                    if (!cur) continue;
                    var url = l.trim(), group = cur.group || grp, gk = S.category(group).kind;
                    var file = /\.(mp4|mkv|avi|mov|wmv|m4v|webm)(\?|$)/i.test(url);
                    var kind = /\/movie\//i.test(url) || cur.type === "movie" ? "movie"
                             : /\/series\//i.test(url) || cur.type === "series" ? "series"
                             : file ? (gk === "series" ? "series" : "movie") : "live";
                    if (kind === "series" && !S.episode(cur.title)) kind = "movie";
                    if (S.isSeparator(cur.title)) { cur = null; continue; }
                    if (kind === "live") {
                        var info = S.channel(cur.title);
                        num++;
                        out.live.chans.push({ id: src.id + "|" + hash(url), src: src.id, url: url, num: parseInt(cur.chno, 10) || num, name: info.name, raw: cur.title, q: info.quality,
                                              key: info.key, logo: cur.logo, cat: cat("live", group), epg: cur.id || "", arch: parseInt(cur.catchup, 10) || 0 });
                    } else if (kind === "movie") {
                        var t = S.title(cur.title);
                        out.movies.items.push({ id: src.id + "|" + hash(url), src: src.id, kind: "movie", url: url, name: cur.title, title: t.title, year: t.year,
                                                poster: cur.logo, cat: cat("movie", group), rating: 0, added: out.movies.items.length });
                    } else {
                        var ep = S.episode(cur.title), cid = cat("series", group), sk = cid + "|" + S.fold(ep.show);
                        var show = shows[sk];
                        if (!show) {
                            var tt = S.title(ep.show);
                            show = shows[sk] = { id: src.id + "|" + hash(sk), src: src.id, kind: "series", name: ep.show, title: tt.title, year: tt.year, poster: cur.logo, cat: cid, rating: 0, added: out.series.items.length, eps: [] };
                            out.series.items.push(show);
                        }
                        show.eps.push({ id: src.id + "|" + hash(url), season: ep.season, episode: ep.episode, name: cur.title, url: url, image: cur.logo });
                    }
                    cur = null;
                }
                if (i < n) { progress(T("Reading the playlist… {p} %", { p: Math.round(i * 100 / n) })); setTimeout(step, 0); return; }
                lines = null;
                resolve(out);
            }
            step();
        });
    }

    function loadM3U(src, progress) {
        progress(T("Downloading {name}…", { name: src.name }));
        return TV.fetchText(src.url, { provider: true, timeout: 180000 }).then(function (text) { return parseM3U(text, src, progress); });
    }

    /* ---------- the merged catalog ---------- */
    var cats = {};               // source id -> catalog
    var merged = null;
    var listeners = [];
    function onChange(fn) { listeners.push(fn); }
    function fire(what) { if (TV.mark) TV.mark("data:" + (what || "catalog")); listeners.forEach(function (fn) { try { fn(what || "catalog"); } catch (e) { TV.log("listener: " + e.message); } }); }

    function rebuild() {
        var list = sources(), many = list.length > 1;
        // Settings > Sort the Categories / Tidy the Names (asked at the first start): off = your playlist as it is
        var tidyNames = TV.pref("tidyNames") !== false, tidyCats = TV.pref("tidyCats") !== false;
        var m = { live: { cats: [], chans: [], byId: {}, byCat: {} }, movies: { cats: [], items: [], byId: {}, byCat: {} }, series: { cats: [], items: [], byId: {}, byCat: {} }, epg: [] };
        list.forEach(function (src) {
            var c = cats[src.id];
            if (!c) return;
            ["live", "movies", "series"].forEach(function (k) {
                var part = c[k], counts = {};
                (k === "live" ? part.chans : part.items).forEach(function (x) { counts[x.cat] = (counts[x.cat] || 0) + 1; });
                part.cats.forEach(function (ct) {
                    if (ct.raw) { var info = S.category(ct.raw); ct.name = info.name; ct.tag = info.tag; ct.lang = info.lang; ct.adult = info.adult; ct.group = info.group; }
                    ct.ctag = ct.tag;                                  // the country, for the guides, whatever is shown
                    if (!tidyNames && ct.raw) { ct.name = ct.raw; ct.tag = ""; }
                    ct.count = counts[ct.id] || 0;
                    ct.srcName = many ? src.name : "";
                    if (ct.count) m[k].cats.push(ct);
                });
                (k === "live" ? part.chans : part.items).forEach(function (x) {
                    if (k === "live") { if (x.cname === undefined) x.cname = x.name; x.name = tidyNames ? x.cname : (x.raw || x.cname); }   // cname: the clean name, for the guide
                    (k === "live" ? m.live.chans : m[k].items).push(x);
                    m[k].byId[x.id] = x;
                    (m[k].byCat[x.cat] = m[k].byCat[x.cat] || []).push(x);
                });
            });
            var epg = src.epg || c.epgUrl || (src.type === "xtream" ? src.server + "/xmltv.php?username=" + encodeURIComponent(src.user) + "&password=" + encodeURIComponent(src.pass) : "");
            if (epg) m.epg.push({ src: src.id, url: epg, xtream: src.type === "xtream" });
        });
        if (tidyCats) ["live", "movies", "series"].forEach(function (k) { m[k].cats = S.sortCategories(m[k].cats); });
        // your own order (set on the phone): the categories you placed first, the others after as they were
        var ord = TV.pref("catOrder") || {};
        ["live", "movies", "series"].forEach(function (k) {
            var o = ord[k];
            if (!o || !o.length) return;
            var pos = {};
            o.forEach(function (key, i) { if (!(key in pos)) pos[key] = i; });
            m[k].cats = m[k].cats.map(function (c, i) { var p = pos[catKey(c)]; return [p === undefined ? 1e9 + i : p, i, c]; })
                .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }).map(function (r) { return r[2]; });
        });
        merged = m;
        applyOff();
        groupCache = {}; idxCache = {}; topLists = {}; genreLists = {}; trendLists = {};
        fire("catalog");
    }

    var retryTimers = {};
    function loadSource(src, progress, onLive) {
        return (src.type === "xtream" ? loadXtream(src, progress, onLive) : src.type === "stalker" ? loadStalker(src, progress) : isMedia(src) ? loadMedia(src, progress) : loadM3U(src, progress)).then(function (c) {
            /* The movies or the series did not come (the provider too slow, an error): the ones from before stay,
               instead of an empty Movies tab until the next refresh, and APL TV asks again in 10 minutes. */
            var prev = cats[src.id], failed = c.failed || {}, missed = [];
            delete c.failed;
            ["movies", "series"].forEach(function (k) {
                var had = prev && prev[k] && prev[k].items && prev[k].items.length || 0;
                if (failed[k] || (had >= 50 && !c[k].items.length)) {
                    missed.push(k);
                    if (had) { c[k] = prev[k]; TV.log(k + " of " + src.name + " not received (" + (failed[k] || "empty") + "): the " + had + " from before stay"); }
                }
            });
            if (missed.length) {
                if (!retryTimers[src.id]) retryTimers[src.id] = setTimeout(function () { whenQuiet(function () { delete retryTimers[src.id]; refresh([src]); }); }, 10 * 60000);
                if (missed.indexOf("movies") >= 0 && !c.movies.items.length) TV.toast(T("{name}: the movies did not arrive ({error}). APL TV tries again in 10 minutes.", { name: src.name, error: failed.movies || T("no list") }), true);
                if (missed.indexOf("series") >= 0 && !c.series.items.length) TV.toast(T("{name}: the series did not arrive ({error}). APL TV tries again in 10 minutes.", { name: src.name, error: failed.series || T("no list") }), true);
            }
            cats[src.id] = c;
            updateSource(src.id, { error: "", at: c.at, counts: { live: c.live.chans.length, movies: c.movies.items.length, series: c.series.items.length }, account: c.account || null });
            return saveCatalog(c).then(function () { return c; });
        }, function (e) {
            updateSource(src.id, { error: e.message });
            throw e;
        });
    }

    /* Saved in parts (channels, movies, series) and packed: rows of values instead of objects that repeat
       every field name, the source and the category written once. The screen gives the app 80 MB in all:
       a big Xtream account (27,000 channels, 100,000 movies) fits only this way. */
    var FIELDS = {
        live: ["id", "sid", "url", "num", "name", "raw", "q", "key", "logo", "cat", "epg", "arch"],
        movies: ["id", "sid", "url", "name", "title", "year", "poster", "cat", "rating", "added", "ext"],
        series: ["id", "seriesId", "name", "title", "year", "poster", "cat", "rating", "added", "backdrop", "eps"]
    };
    var PICS = { logo: 1, poster: 1, backdrop: 1 };
    function pack(part, kind, srcId) {
        var list = kind === "live" ? part.chans : part.items, idx = {}, F = FIELDS[kind], cut = srcId.length + 1, dirs = [], dirIdx = {};
        part.cats.forEach(function (c, i) { idx[c.id] = i; });
        function pic(v) {
            if (!v) return null;
            var k = v.lastIndexOf("/") + 1, d = v.slice(0, k);
            if (dirIdx[d] === undefined) { dirIdx[d] = dirs.length; dirs.push(d); }
            return dirIdx[d] + "|" + v.slice(k);
        }
        var rows = list.map(function (x) {
            var r = [];
            for (var i = 0; i < F.length; i++) {
                var f = F[i], v = x[f];
                r.push(f === "id" ? String(v).slice(cut) : f === "cat" ? idx[v] : PICS[f] ? pic(v) : (v === undefined || v === "" ? null : v));
            }
            while (r.length && r[r.length - 1] === null) r.pop();
            return r;
        });
        return { packed: 2, cats: part.cats, dirs: dirs, rows: rows };
    }
    function unpack(p, kind, srcId) {
        if (!p || !p.packed) return p;
        var F = FIELDS[kind], cats = p.cats, dirs = p.dirs || [], k = kind === "movies" ? "movie" : kind === "series" ? "series" : null;
        var list = p.rows.map(function (r) {
            var o = { src: srcId };
            if (k) o.kind = k;
            for (var i = 0; i < r.length; i++) {
                var v = r[i];
                if (v === null || v === undefined) continue;
                var f = F[i];
                if (PICS[f] && p.packed === 2) { var bar = v.indexOf("|"); v = dirs[+v.slice(0, bar)] + v.slice(bar + 1); }
                o[f] = f === "id" ? srcId + "|" + v : f === "cat" ? (cats[v] && cats[v].id) : v;
            }
            return o;
        });
        return kind === "live" ? { cats: cats, chans: list } : { cats: cats, items: list };
    }
    function saveCatalog(c) {
        var id = c.id, saved = { movies: false, series: false };
        // Room first: the previous copy goes before the new one is written
        return Promise.all([TV.idb.del("catm:" + id), TV.idb.del("cats:" + id)]).then(function () {
            return TV.idb.set("catm:" + id, pack(c.movies, "movies", id));
        }).then(function (r) {
            saved.movies = r !== false;
            if (!saved.movies) TV.idb.del("catm:" + id);
            return TV.idb.set("cats:" + id, pack(c.series, "series", id));
        }).then(function (r) {
            saved.series = r !== false;
            if (!saved.series) TV.idb.del("cats:" + id);
            var head = { id: id, v: c.v || 1, at: c.at, type: c.type, account: c.account || null, epgUrl: c.epgUrl || "", live: pack(c.live, "live", id), parts: 3, saved: saved };
            return TV.idb.set("cat:" + id, head);
        }).then(function (r) {
            TV.log("catalog saved: channels " + (r !== false) + ", movies " + saved.movies + ", series " + saved.series);
        });
    }
    function readCatalog(id) {
        return TV.idb.get("cat:" + id).then(function (c) {
            if (!c || !c.live) return null;
            if (!c.parts) return c;
            return Promise.all([TV.idb.get("catm:" + id), TV.idb.get("cats:" + id)]).then(function (r) {
                c.live = unpack(c.live, "live", id);
                c.movies = r[0] ? unpack(r[0], "movies", id) : null;
                c.series = r[1] ? unpack(r[1], "series", id) : null;
                if (c.parts < 3 && (!c.movies || !c.series)) return null;
                return c;
            });
        });
    }

    /* At start-up: cached sources show at once; missing ones load in parallel, channels first so Live TV
       appears as soon as the first source answers, with movies and series following in the background. */
    function start(progress) {
        var list = sources();
        return (TV.epg && TV.epg.prune ? TV.epg.prune() : Promise.resolve()).then(function () { return Promise.all(list.map(function (s) {
            return readCatalog(s.id).then(function (c) { if (c) cats[s.id] = c; });
        })); }).then(function () {
            var missing = list.filter(function (s) { return !cats[s.id]; });
            var partial = list.filter(function (s) { return cats[s.id] && (!cats[s.id].movies || !cats[s.id].series); });
            list.forEach(function (s) { var c = cats[s.id]; if (c) { c.movies = c.movies || { cats: [], items: [] }; c.series = c.series || { cats: [], items: [] }; } });
            if (partial.length) setTimeout(function () {
                TV.log("movies and series: loading again in the background (" + partial.length + ")");
                sequence(partial, function (s) { return loadSource(s, function () {}).catch(function (e) { TV.log("background " + s.name + ": " + e.message); }); }).then(rebuild);
            }, 4000);
            rebuild();
            if (!missing.length) return;
            var liveShown = false;
            function onLive(partial) {
                cats[partial.id] = partial;
                if (!liveShown) { liveShown = true; rebuild(); }
            }
            return Promise.all(missing.map(function (s) {
                return loadSource(s, progress, onLive).catch(function (e) { TV.log("load " + s.name + ": " + e.message); TV.toast(s.name + " : " + e.message, true); });
            })).then(rebuild);
        }).then(function () {
            var old = sources().filter(function (s) { return cats[s.id] && (Date.now() - (cats[s.id].at || 0) > MAX_AGE || (cats[s.id].v || 1) < CATALOG_V); });
            if (old.length) whenQuiet(function () { refresh(old, function () {}); });
        });
    }
    /* Refreshing a big account is seconds of heavy work for the TV (reading and saving 200,000 titles: up
       to 12 s on the LG G5, the first channel then took 12 s to show). It waits for a quiet moment: the
       remote unused for 45 s (counted from the start too) and no channel starting, so zapping and moving
       around stay quick. After 20 minutes it goes ahead anyway. */
    var bootAt = Date.now();
    function whenQuiet(fn) {
        var since = Date.now();
        (function check() {
            var still = Date.now() - Math.max(TV.keyAt || 0, bootAt) > 45000 && !(TV.player && TV.player.isBuffering());
            if (still || Date.now() - since > 20 * 60000) { TV.log("catalog refresh: starting (" + Math.round((Date.now() - bootAt) / 1000) + " s after start)"); fn(); }
            else setTimeout(check, 5000);
        })();
    }
    function refresh(list, progress) {
        list = list || sources();
        return sequence(list, function (s) { return loadSource(s, progress || function () {}).catch(function (e) { TV.log("refresh " + s.name + ": " + e.message); }); }).then(rebuild);
    }
    function sequence(items, fn) {
        return items.reduce(function (p, it) { return p.then(function () { return fn(it); }); }, Promise.resolve());
    }

    /* ---------- channels: variants of one channel together ---------- */
    var groupCache = {};
    function channelsIn(catId) {
        if (groupCache[catId]) return groupCache[catId];
        var src;
        if (catId === "fav") src = favChannels();
        else if (catId === "recent") src = recentChannels();
        else if (String(catId).indexOf("grp:") === 0) { var cg = chanGroupOf(catId); src = cg ? cg.ids.map(channel).filter(Boolean) : []; }
        else if (catId === "all") src = merged ? merged.live.chans.filter(function (c) { var ct = catOf(c); return (TV.pref("showAdult") || !ct.adult) && !ct.off; }) : [];
        else src = merged && !catOf({ cat: catId }).off && merged.live.byCat[catId] || [];
        var out = src;
        if (TV.pref("mergeQuality") && catId !== "fav" && catId !== "recent" && String(catId).indexOf("grp:") !== 0) {
            var seen = {};
            out = [];
            src.forEach(function (c) {
                var g = seen[c.key];
                if (g && g.cat === c.cat) {
                    g.variants = g.variants || [g.self];
                    g.variants.push(c);
                    return;
                }
                var e = { id: c.id, self: c, cat: c.cat };
                seen[c.key] = e;
                out.push(e);
            });
            out = out.map(function (e) {
                if (!e.variants) return e.self;
                var v = e.variants.slice().sort(function (a, b) { return S.qualityRank(b.q) - S.qualityRank(a.q); });
                var best = v[0], copy = {};
                Object.keys(best).forEach(function (k) { copy[k] = best[k]; });
                copy.variants = v; copy.num = Math.min.apply(null, v.map(function (x) { return x.num; }));
                if (!copy.logo) for (var i = 0; i < v.length; i++) if (v[i].logo) { copy.logo = v[i].logo; break; }
                return copy;
            });
        }
        if (catId !== "fav" && catId !== "recent") groupCache[catId] = out;
        return out;
    }
    function catOf(ch) {
        if (!merged) return {};
        if (!merged._catMap) { merged._catMap = {}; ["live", "movies", "series"].forEach(function (k) { merged[k].cats.forEach(function (c) { merged._catMap[c.id] = c; }); }); }
        return merged._catMap[ch.cat] || {};
    }
    function channel(id) { return merged && merged.live.byId[id] || null; }
    function streamUrl(ch) {
        if (ch.url) return ch.url;
        var src = sourceOf(ch);
        return src ? xUrl(src, "live", ch.sid, TV.pref("liveFormat") === "m3u8" ? "m3u8" : "ts") : "";
    }
    function sourceOf(x) { var id = x.src; var list = sources(); for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }

    /* ---------- favorites, recents, My List, resume points ---------- */
    function favIds() { return TV.load("favs", []) || []; }
    function isFav(id) { return favIds().indexOf(id) !== -1; }
    function toggleFav(id) {
        var f = favIds(), i = f.indexOf(id);
        if (i === -1) f.push(id); else f.splice(i, 1);
        TV.save("favs", f);
        delete groupCache.fav;
        fire("favs");
        return i === -1;
    }
    function favChannels() { return favIds().map(channel).filter(Boolean); }
    function moveFav(id, delta) {
        var f = favIds(), i = f.indexOf(id), j = i + delta;
        if (i < 0 || j < 0 || j >= f.length) return false;
        f.splice(j, 0, f.splice(i, 1)[0]);
        TV.save("favs", f);
        return true;
    }
    /* Your own groups of channels (hold OK on a channel > Add to a Group): [{ id, name, ids }], shown in
       Live TV and the Guide after Favorites, in the order you add their channels */
    function chanGroups() { return TV.load("chanGroups", []) || []; }
    function saveGroups(g) {
        TV.save("chanGroups", g);
        Object.keys(groupCache).forEach(function (k) { if (k.indexOf("grp:") === 0) delete groupCache[k]; });
        fire("groups");
    }
    function addChanGroup(name) { var g = chanGroups(), id = TV.uid(); g.push({ id: id, name: String(name).slice(0, 40), ids: [] }); saveGroups(g); return id; }
    function renameChanGroup(id, name) { var g = chanGroups(); g.forEach(function (x) { if (x.id === id) x.name = String(name).slice(0, 40); }); saveGroups(g); }
    function deleteChanGroup(id) { saveGroups(chanGroups().filter(function (x) { return x.id !== id; })); }
    function toggleChanGroup(id, chId) {
        var g = chanGroups(), on = false;
        g.forEach(function (x) { if (x.id !== id) return; var i = x.ids.indexOf(chId); if (i < 0) { x.ids.push(chId); on = true; } else x.ids.splice(i, 1); });
        saveGroups(g);
        return on;
    }
    function moveInChanGroup(id, chId, delta) {
        var g = chanGroups(), moved = false;
        g.forEach(function (x) {
            if (x.id !== id) return;
            var i = x.ids.indexOf(chId), j = i + delta;
            if (i < 0 || j < 0 || j >= x.ids.length) return;
            x.ids.splice(j, 0, x.ids.splice(i, 1)[0]); moved = true;
        });
        if (moved) saveGroups(g);
        return moved;
    }
    function chanGroupOf(catId) { var id = String(catId).replace(/^grp:/, ""); return chanGroups().filter(function (x) { return x.id === id; })[0] || null; }
    function pushRecent(id) {
        var r = (TV.load("recent", []) || []).filter(function (x) { return x !== id; });
        r.unshift(id);
        TV.save("recent", r.slice(0, 30));
    }
    function recentChannels() { return (TV.load("recent", []) || []).map(channel).filter(Boolean); }

    function myList() { return TV.load("mylist", []) || []; }
    function inMyList(id) { return myList().indexOf(id) !== -1; }
    function toggleMyList(id) {
        var l = myList(), i = l.indexOf(id);
        if (i === -1) l.unshift(id); else l.splice(i, 1);
        TV.save("mylist", l);
        fire("mylist");
        return i === -1;
    }

    /* Titles hidden by you: every version of the title (same name and year) disappears everywhere */
    function hiddenMap() { return TV.load("hidden", {}) || {}; }
    function hideKey(x) { if (!x._hk) x._hk = (x.kind === "series" ? "s:" : "m:") + versionKey(x); return x._hk; }
    function anyTitleHidden() { if (themeCount || themesOn().length) return true; for (var k in hiddenMap()) return true; return false; }
    function anyHidden() { return offCount > 0 || anyTitleHidden(); }
    function isHidden(x) {
        if (!x) return false;
        if (offCount && catOf(x).off) return true;
        if (!anyTitleHidden()) return false;
        var k = hideKey(x); return !!(hiddenMap()[k] || themeKeys[k] || catHidden(x));
    }

    /* ---------- countries and categories you hide (Settings > Countries and Categories) ----------
       A hidden category takes its channels, movies and series away from everywhere: the category rows,
       All Channels, Home, the genres, search, More Like This and voice. Your favorites stay.
       hiddenGroups: the countries or regions hidden ("AF"), hiddenCats: one category hidden (1) or
       shown again inside a hidden country (0), by its name in the playlist, so it stays after a refresh. */
    var offCount = 0;
    function catKey(c) { return c.kind + ":" + (c.raw || c.name); }
    function applyOff() {
        offCount = 0;
        if (!merged) return;
        var one = TV.pref("hiddenCats") || {}, groups = TV.pref("hiddenGroups") || [], n = {}, all = [];
        ["live", "movies", "series"].forEach(function (k) { merged[k].cats.forEach(function (c) { all.push(c); n[c.group || ""] = (n[c.group || ""] || 0) + 1; }); });
        all.forEach(function (c) {
            // a code APL TV does not know, seen on a single category ("TNT| Sport"), is not a country: Other Categories
            c.grp = c.group && (S.groupName(c.group) !== c.group || n[c.group] > 1) ? c.group : "";
            var key = catKey(c);
            c.off = key in one ? one[key] === 1 : groups.indexOf(c.grp) >= 0;
            if (c.off) offCount++;
        });
    }
    function offChanged() { applyOff(); groupCache = {}; fire("hidden"); }
    function setCatOff(c, on) {
        var one = TV.pref("hiddenCats") || {}, copy = {}, k;
        for (k in one) copy[k] = one[k];
        var inGroup = (TV.pref("hiddenGroups") || []).indexOf(c.grp) >= 0;
        if (on === inGroup) delete copy[catKey(c)]; else copy[catKey(c)] = on ? 1 : 0;
        TV.setPref("hiddenCats", copy);
        offChanged();
    }
    function setGroupOff(g, on) {
        var groups = (TV.pref("hiddenGroups") || []).filter(function (x) { return x !== g; }), one = TV.pref("hiddenCats") || {}, copy = {}, k;
        if (on) groups.push(g);
        var mine = {};
        offGroups().forEach(function (x) { if (x.id === g) x.cats.forEach(function (c) { mine[catKey(c)] = 1; }); });
        for (k in one) if (!mine[k]) copy[k] = one[k];          // the whole country now: its own exceptions go
        TV.setPref("hiddenGroups", groups);
        TV.setPref("hiddenCats", copy);
        offChanged();
    }
    /* The countries and regions of your playlists, each with its categories (adult ones only when shown) */
    function offGroups() {
        if (!merged) return [];
        var adult = TV.pref("showAdult"), by = {}, list = [];
        [["live", "live"], ["movies", "movie"], ["series", "series"]].forEach(function (k) {
            merged[k[0]].cats.forEach(function (c) {
                if (c.adult && !adult) return;
                var g = by[c.grp];
                if (!g) { g = by[c.grp] = { id: c.grp, name: c.grp ? S.groupName(c.grp) : T("Other Categories"), cats: [], off: 0, items: 0 }; list.push(g); }
                g.cats.push(c); g.items += c.count || 0; if (c.off) g.off++;
            });
        });
        return list.sort(function (a, b) { return (!a.id) - (!b.id) || b.items - a.items; });
    }
    function offCats() { return offCount; }

    /* ---------- edited on the phone (Settings > Edit on Your Phone, js/settings.js; the page: service.js) ----------
       What the phone gets: the categories of each kind in their order (hidden or not), your groups, your favorites
       and the channels' names to find them. What comes back: the same, changed. */
    function editData() {
        var out = { v: 1, kinds: {}, groups: chanGroups(), favs: favIds(), chans: [] };
        if (!merged) return out;
        var adult = TV.pref("showAdult");
        ["live", "movies", "series"].forEach(function (k) {
            out.kinds[k] = merged[k].cats.filter(function (c) { return adult || !c.adult; }).map(function (c) {
                return { key: catKey(c), name: c.name + (c.srcName ? " (" + c.srcName + ")" : ""), count: c.count || 0, off: !!c.off };
            });
        });
        var chans = merged.live.chans;
        for (var i = 0; i < chans.length && out.chans.length < 40000; i++) {
            var c = chans[i], ct = catOf(c);
            if (!adult && ct.adult) continue;
            out.chans.push([c.id, c.name + (c.q ? " " + c.q : ""), ct.name || ""]);
        }
        return out;
    }
    function applyPhoneEdit(d) {
        if (!d || typeof d !== "object") return false;
        var kinds = d.kinds || {}, one = TV.pref("hiddenCats") || {}, copy = {}, k, groups = TV.pref("hiddenGroups") || [], byKey = {};
        for (k in one) copy[k] = one[k];
        if (merged) ["live", "movies", "series"].forEach(function (x) { merged[x].cats.forEach(function (c) { byKey[catKey(c)] = c; }); });
        var order = {};
        ["live", "movies", "series"].forEach(function (x) {
            var list = Array.isArray(kinds[x]) ? kinds[x] : null;
            if (!list) return;
            order[x] = [];
            list.forEach(function (it) {
                if (!it || typeof it.key !== "string") return;
                order[x].push(it.key);
                var c = byKey[it.key];
                if (!c) return;
                var off = !!it.off, inGroup = groups.indexOf(c.grp) >= 0;
                if (off === inGroup) delete copy[it.key]; else copy[it.key] = off ? 1 : 0;
            });
        });
        TV.setPref("hiddenCats", copy);
        var ord = TV.pref("catOrder") || {}, newOrd = {};
        ["live", "movies", "series"].forEach(function (x) { newOrd[x] = order[x] || ord[x] || []; });
        TV.setPref("catOrder", newOrd);
        if (Array.isArray(d.groups)) {
            saveGroups(d.groups.filter(function (g) { return g && String(g.name || "").trim(); }).map(function (g) {
                return { id: g.id ? String(g.id) : TV.uid(), name: String(g.name).trim().slice(0, 40), ids: (Array.isArray(g.ids) ? g.ids : []).map(String).slice(0, 2000) };
            }));
        }
        if (Array.isArray(d.favs)) { TV.save("favs", d.favs.map(String).slice(0, 2000)); fire("favs"); }
        rebuild();
        return true;
    }
    /* A provider category whose name carries a hidden theme ("FR| LGBT", "Horreur"): everything in it is hidden */
    var catThemeCache = {};
    function catNameHidden(name) {
        if (!name) return false;
        if (catThemeCache[name] !== undefined) return catThemeCache[name];
        var on = themesOn(), hit = false;
        for (var i = 0; i < on.length && !hit; i++) { var re = TV.meta && TV.meta.themeWords(on[i]); if (re && re.test(name)) hit = true; }
        catThemeCache[name] = hit;
        return hit;
    }
    function catHidden(x) { var c = catOf(x); return !!(c && catNameHidden(c.name)); }

    /* Hidden themes (Settings > Hidden Themes): titles TMDB tags with a theme you hide disappear like hidden
       titles. Found at start-up from TMDB's lists, and as each title's information arrives (remembered). */
    var themeKeys = {}, themeCount = 0, themeTimer = null;
    function themesOn() { return TV.pref("hiddenThemes") || []; }
    function setThemeKey(k, t) { if (!themeKeys[k]) themeCount++; themeKeys[k] = t; }
    function restoreThemes() {
        var on = themesOn(), hits = TV.load("themeHits", {}) || {};
        themeKeys = {}; themeCount = 0;
        Object.keys(hits).forEach(function (k) { if (on.indexOf(hits[k]) >= 0) setThemeKey(k, hits[k]); });
    }
    function buildThemes() {
        var on = themesOn();
        catThemeCache = {};
        restoreThemes();
        groupCache = {};
        fire("hidden");
        if (!on.length || !merged || !TV.meta || !TV.meta.enabled()) return Promise.resolve();
        var t0 = Date.now();
        return Promise.all(on.map(function (t) {
            return Promise.all([TV.meta.themeTitles(t, "movie"), TV.meta.themeTitles(t, "tv")]).then(function (l) {
                var both = l[0].concat(l[1]);
                return Promise.all([findTitles("movies", both), findTitles("series", both)]);
            }).then(function (r) { r[0].concat(r[1]).forEach(function (x) { setThemeKey(hideKey(x), t); }); });
        })).then(function () {
            groupCache = {};
            TV.log("hidden themes " + on.join(",") + ": " + themeCount + " titles hidden in " + (Date.now() - t0) + " ms");
            fire("hidden");
        });
    }
    function checkTheme(item, m) {
        var on = themesOn();
        if (!on.length || !m || !item || !item.kind) return;
        for (var i = 0; i < on.length; i++) if (TV.meta.themeMatch(on[i], m)) {
            var k = hideKey(item);
            if (themeKeys[k]) return;
            setThemeKey(k, on[i]);
            var hits = TV.load("themeHits", {}) || {}, keys = Object.keys(hits);
            if (keys.length > 6000) keys.slice(0, keys.length - 6000).forEach(function (x) { delete hits[x]; });
            hits[k] = on[i];
            TV.save("themeHits", hits);
            clearTimeout(themeTimer);
            themeTimer = setTimeout(function () { groupCache = {}; fire("hidden"); }, 1500);
            return;
        }
    }
    function setHidden(x, on) {
        var h = hiddenMap(), k = hideKey(x);
        if (on) h[k] = { t: x.title || x.name, kind: x.kind, at: Date.now() }; else delete h[k];
        TV.save("hidden", h);
        groupCache = {};
        fire("hidden");
    }
    function hiddenList() { var h = hiddenMap(); return Object.keys(h).map(function (k) { return { key: k, t: h[k].t, kind: h[k].kind, at: h[k].at }; }).sort(function (a, b) { return b.at - a.at; }); }
    function unhide(key) { var h = hiddenMap(); delete h[key]; TV.save("hidden", h); fire("hidden"); }

    /* Resume points: id -> { pos, dur, at, item id, series episode } (seconds) */
    function resumes() { return TV.load("resume", {}) || {}; }
    function setResume(id, info) {
        var r = resumes();
        if (!info) delete r[id];
        else { info.at = Date.now(); r[id] = info; }
        trimResumes(r);
        TV.save("resume", r);
    }
    function trimResumes(r) {
        var keys = Object.keys(r);
        if (keys.length > 1500) keys.sort(function (a, b) { return r[a].at - r[b].at; }).slice(0, keys.length - 1500).forEach(function (k) { delete r[k]; });
    }
    function resumeOf(id) { return resumes()[id] || null; }
    function isDone(id) { var e = resumes()[id]; return !!(e && e.done); }
    /* Marked by hand (OK held): watched or not, a movie, an episode, or many episodes at once */
    function markWatched(item, eps, on) {
        var r = resumes(), list = eps && eps.length ? eps : [null];
        list.forEach(function (ep) {
            var k = ep ? item.id + "|" + ep.id : item.id;
            if (on) r[k] = { pos: 1, dur: 1, item: item.id, ep: ep ? ep.id : null, done: true, manual: true, at: Date.now() };
            else delete r[k];
        });
        trimResumes(r);
        TV.save("resume", r);
        fire("resume");
    }
    /* Out of "Continue Watching" (OK held): where you were is forgotten, what you finished stays ticked */
    function forget(item) {
        var r = resumes();
        Object.keys(r).forEach(function (k) { if ((k === item.id || k.indexOf(item.id + "|") === 0) && !(r[k] && r[k].done && k !== item.id)) delete r[k]; });
        TV.save("resume", r);
        fire("resume");
    }
    /* After a video: the rows and covers that show progress are drawn again */
    function resumeChanged() { fire("resume"); }
    /* "Recently Watched": what you played lately, finished or not, the latest first (marks by hand left out) */
    function recentlyWatched(kind) {
        var r = resumes(), seen = {}, out = [];
        Object.keys(r).map(function (k) { return r[k]; }).filter(function (e) { return e && e.item && !e.manual; })
            .sort(function (a, b) { return b.at - a.at; }).forEach(function (e) {
                if (seen[e.item] || !merged) return;
                seen[e.item] = 1;
                var it = (kind !== "series" && merged.movies.byId[e.item]) || (kind !== "movies" && merged.series.byId[e.item]);
                if (it && !isHidden(it)) out.push(it);
            });
        return out.slice(0, 80);
    }
    /* "Continue Watching": the last things started and not finished */
    function continueWatching() {
        var r = resumes(), out = [];
        Object.keys(r).forEach(function (k) {
            var e = r[k];
            if (!e || !e.item || e.manual) return;
            // a series whose episode is over: its next episode waits here ("up next")
            if (!e.upNext && (e.pos < 60 || e.done || (e.dur && e.pos > e.dur * 0.94))) return;
            var it = (merged && (merged.movies.byId[e.item] || merged.series.byId[e.item]));
            if (it && !isHidden(it)) out.push({ item: it, resume: e, key: k });
        });
        var seen = {};
        return out.sort(function (a, b) { return b.resume.at - a.resume.at; }).filter(function (x) {
            if (seen[x.item.id]) return false;
            seen[x.item.id] = true;
            return true;
        }).slice(0, 20);
    }

    /* ---------- movies and series ---------- */
    /* The same title in several categories or qualities: one card, its versions behind it */
    function versionKey(x) { return S.fold(x.title || x.name) + ":" + (x.year || ""); }
    /* The screen's language first in New and Top Rated: French titles on a French screen, the rest only if there are too few */
    function preferMine(list) {
        var mine = list.filter(function (x) { var c = catOf(x); return c.lang === TV.lang || c.lang === "multi"; });
        return mine.length >= 40 ? mine : list;
    }
    /* The version you chose on a title's page (4K, VOSTFR, another provider…) is the one shown and played next time */
    function versionPrefs() { return TV.load("prefVersion", {}) || {}; }
    function prefKey(x) { return (x.kind === "series" ? "s:" : "m:") + versionKey(x); }
    function preferVersion(x) {
        var p = versionPrefs(), keys = Object.keys(p);
        if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach(function (k) { delete p[k]; });
        delete p[prefKey(x)]; p[prefKey(x)] = x.id;
        TV.save("prefVersion", p);
        groupCache = {};
    }
    /* Without a choice of yours: the version in the screen's language (dubbed before subtitled), in the best quality
       the screen can show (4K only on a 4K screen). Before, the provider's first one: often HD when FHD or 4K was there. */
    var uhdScreen = null;
    function bestVersion(list) {
        if (uhdScreen === null) { try { uhdScreen = !global.webapis || !!global.webapis.productinfo.isUdPanelSupported(); } catch (e) { uhdScreen = true; } }
        var best = list[0], bestScore = -1;
        list.forEach(function (x) {
            var c = catOf(x), text = (x.name || "") + " " + (c.name || "") + " " + (c.raw || "");
            var lang = c.lang === TV.lang ? 3 : c.lang === "multi" ? 2 : !c.lang ? 1 : 0;
            if (lang === 3 && /\b(VOSTFR|VOST|VOSTA|SUBS?|VO)\b/i.test(text)) lang = 2.5;
            var q = /\b(4K|UHD|2160P?)\b/i.test(text) ? (uhdScreen ? 4 : 2.5) : /\b(FHD|1080P?)\b/i.test(text) ? 3 : /\b(SD|480P?|576P?)\b/i.test(text) ? 1 : 2;
            var score = lang * 10 + q;
            if (score > bestScore) { bestScore = score; best = x; }
        });
        return best;
    }
    function groupVersions(list) {
        var seen = {}, out = [], pref = null;
        list.forEach(function (x) {
            var k = versionKey(x), g = seen[k];
            if (g) { g.versions.push(x); return; }
            seen[k] = { item: x, versions: [x] };
            out.push(seen[k]);
        });
        return out.map(function (g) {
            if (g.versions.length > 1) {
                pref = pref || versionPrefs();
                var want = pref[prefKey(g.item)], chosen = null;
                if (want) for (var i = 0; i < g.versions.length; i++) if (g.versions[i].id === want) { chosen = g.versions[i]; break; }
                g.item = chosen || bestVersion(g.versions);
            }
            g.item.versions = g.versions.length > 1 ? g.versions : null;
            return g.item;
        });
    }
    function itemsIn(kind, catId) { return catId === "top" || catId === "trend" || String(catId).indexOf("g:") === 0 ? itemsInRaw(kind, catId) : groupVersions(itemsInRaw(kind, catId)); }

    /* A title reduced for comparing, in any alphabet (Arabic, Cyrillic… are kept): no case, accents, spaces or punctuation */
    function titleKey(s) {
        s = String(s || "").toLowerCase();
        try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
        return s.replace(/[\s\u0000-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u00bf\u2000-\u206f]+/g, "");
    }

    /* An index of your movies and series by title (no accents, no case), built a slice at a time */
    var idxCache = {}, idxWaiting = {};
    function titleIndex(kind) {
        if (idxCache[kind]) return Promise.resolve(idxCache[kind]);
        if (idxWaiting[kind]) return idxWaiting[kind];
        var t0 = Date.now();
        idxWaiting[kind] = new Promise(function (resolve) {
            var items = merged ? merged[kind].items : [], idx = {}, i = 0;
            (function step() {
                var stop = Math.min(items.length, i + 1500);
                for (; i < stop; i++) { var x = items[i], k = titleKey(x.title || x.name); if (k.length > 1) (idx[k] = idx[k] || []).push(x); }
                if (i < items.length) { setTimeout(step, 0); return; }
                idxCache[kind] = idx; delete idxWaiting[kind];
                TV.log("index " + kind + ": " + items.length + " titles in " + (Date.now() - t0) + " ms");
                resolve(idx);
            })();
        });
        return idxWaiting[kind];
    }
    /* TMDB titles (t: title, o: original title, y: year) found in your catalog, in the same order */
    function findTitles(kind, list) {
        return titleIndex(kind).then(function (idx) {
            var out = [], used = {};
            list.forEach(function (r) {
                var kt = titleKey(r.t), ko = titleKey(r.o);
                var cands = (kt.length > 1 && idx[kt] || []).concat(ko !== kt && ko.length > 1 && idx[ko] || []), hits = [];
                cands.forEach(function (x) {
                    if (used[x.id]) return;
                    if (r.y && x.year && Math.abs(x.year - r.y) > 1) return;
                    used[x.id] = 1; hits.push(x);
                });
                if (!hits.length) return;
                hits.sort(function (a, b) { return (catOf(b).lang === TV.lang ? 1 : 0) - (catOf(a).lang === TV.lang ? 1 : 0); });
                hits.forEach(function (x) { x._ref = r; out.push(x); });
            });
            return out;
        });
    }

    /* A genre: its popular titles found in your catalog, one card per title */
    var genreLists = {}, genreLoading = {};
    function oneCardPerTitle(found) {
        var byRef = {}, reps = [];
        found.forEach(function (x) {
            var r = byRef[x._ref.id];
            if (!r) { byRef[x._ref.id] = x; x.versions = null; reps.push(x); return; }
            r.versions = r.versions || [r]; r.versions.push(x);
        });
        return reps;
    }
    function genreItems(kind, gid, quiet) {
        var k = kind + ":" + gid;
        if (genreLists[k]) return Promise.resolve(genreLists[k]);
        if (genreLoading[k]) return genreLoading[k];
        genreLoading[k] = TV.meta.genreTitles(kind === "movies" ? "movie" : "tv", gid).then(function (list) {
            return findTitles(kind, list).then(function (found) {
                genreLists[k] = oneCardPerTitle(found);
                delete genreLoading[k];
                TV.log("genre " + k + ": " + genreLists[k].length + " titles in the catalog");
                if (!quiet) fire("genre");
                return genreLists[k];
            });
        }).catch(function (e) { delete genreLoading[k]; TV.log("genre " + k + ": " + e.message); return []; });
        return genreLoading[k];
    }

    /* "Top Rated": weighted by the number of votes (meta.js), found in your catalog */
    var topLists = {}, topLoading = {};
    function topRatedItems(kind) {
        if (topLists[kind]) return topLists[kind];
        if (!topLoading[kind] && TV.meta && TV.meta.enabled()) {
            topLoading[kind] = true;
            TV.meta.topRated(kind === "movies" ? "movie" : "tv").then(function (list) {
                var m = kind === "movies" ? 3000 : 1000, C = 7.0;
                list.forEach(function (r) { r.wr = (r.v * r.n + C * m) / (r.n + m); });
                list.sort(function (a, b) { return b.wr - a.wr; });
                return findTitles(kind, list).then(function (found) {
                    // One card per title: its other versions (another language, 4K…) behind it
                    var byRef = {}, reps = [];
                    found.forEach(function (x) {
                        var r = byRef[x._ref.id];
                        if (!r) { byRef[x._ref.id] = x; x.versions = null; reps.push(x); return; }
                        r.versions = r.versions || [r]; r.versions.push(x);
                    });
                    topLists[kind] = reps;
                    topLoading[kind] = false;
                    TV.log("top rated " + kind + ": " + found.length + " in the catalog, from " + list.length + " TMDB titles");
                    fire("top");
                });
            }).catch(function (e) { topLoading[kind] = false; TV.log("top rated: " + e.message); });
        }
        return null;
    }
    /* "Trending": TMDB's titles of the week found in your catalog, in their order (most watched first) */
    var trendLists = {}, trendLoading = {};
    function trendingItems(kind) {
        if (trendLists[kind]) return trendLists[kind];
        if (!trendLoading[kind] && TV.meta && TV.meta.enabled()) {
            trendLoading[kind] = true;
            TV.meta.trending(kind === "movies" ? "movie" : "tv").then(function (list) {
                return findTitles(kind, list).then(function (found) {
                    trendLists[kind] = oneCardPerTitle(found);
                    trendLoading[kind] = false;
                    TV.log("trending " + kind + ": " + trendLists[kind].length + " in the catalog, from " + list.length + " TMDB titles");
                    fire("trend");
                });
            }).catch(function (e) { trendLoading[kind] = false; TV.log("trending: " + e.message); });
        }
        return null;
    }
    function itemsInRaw(kind, catId) {
        var part = merged && merged[kind];
        if (!part) return [];
        var adult = TV.pref("showAdult"), hid = anyHidden();
        function ok(x) { return (adult || !catOf(x).adult) && (!hid || !isHidden(x)); }
        if (catId === "watched") return recentlyWatched(kind);
        if (catId === "recent") return preferMine(part.items.filter(ok)).slice().sort(function (a, b) { return b.added - a.added; }).slice(0, 300);
        // New releases: recently added AND out this year or last year (an old title added today is not new)
        if (catId === "new") {
            var since = new Date().getFullYear() - 1;
            return preferMine(part.items.filter(function (x) { return x.year >= since && ok(x); })).slice().sort(function (a, b) { return b.added - a.added; }).slice(0, 300);
        }
        if (catId === "trend") {
            var tr = trendingItems(kind);
            return tr ? tr.filter(ok) : [];
        }
        if (String(catId).indexOf("g:") === 0) {
            var gl = genreLists[kind + ":" + catId.slice(2)];
            if (gl) return gl.filter(ok);
            genreItems(kind, catId.slice(2));
            return [];
        }
        if (catId === "top") {
            var top = topRatedItems(kind);
            if (top) return top.filter(ok);
            return [];                       // a second, while the list is being found
        }
        if (catId === "mylist") return myList().map(function (id) { return part.byId[id]; }).filter(Boolean);
        if (catId === "all") return part.items.filter(ok);
        return hid ? (part.byCat[catId] || []).filter(ok) : (part.byCat[catId] || []);
    }
    function vodUrl(item, ep) {
        if (ep && ep.url) return ep.url;
        if (item.url) return item.url;
        var src = sourceOf(item);
        if (!src) return "";
        return ep ? xUrl(src, "series", ep.id, ep.ext || "mp4") : xUrl(src, "movie", item.sid, item.ext || "mp4");
    }
    function vodInfo(item) {
        var src = sourceOf(item);
        if (isMedia(src) && TV.media && item.kind === "movie") return Promise.resolve(TV.media.info(item));
        if (!src || src.type !== "xtream" || item.kind !== "movie") return Promise.resolve(null);
        return xApi(src, "get_vod_info", "vod_id=" + item.sid).catch(function () { return null; });
    }
    /* A series' seasons and episodes: from the Xtream server, or the episodes found in the M3U */
    function seriesInfo(item) {
        if (item.eps) {
            var seasons = {};
            item.eps.forEach(function (e) { (seasons[e.season] = seasons[e.season] || []).push({ id: e.id, season: e.season, episode: e.episode, title: "", url: e.url, image: e.image }); });
            Object.keys(seasons).forEach(function (s) { seasons[s].sort(function (a, b) { return a.episode - b.episode; }); });
            return Promise.resolve({ seasons: seasons, info: {} });
        }
        var src = sourceOf(item);
        if (!src) return Promise.resolve({ seasons: {}, info: {} });
        if (src.type === "stalker" && TV.stalker) return TV.stalker.seriesInfo(src, item);
        if (isMedia(src) && TV.media) return TV.media.seriesInfo(src, item);
        return xApi(src, "get_series_info", "series_id=" + item.seriesId).then(function (j) {
            var seasons = {};
            var eps = j && j.episodes || {};
            Object.keys(eps).forEach(function (s) {
                seasons[s] = (eps[s] || []).map(function (e) {
                    var inf = e.info || {};
                    return { id: e.id, season: parseInt(e.season || s, 10), episode: parseInt(e.episode_num, 10) || 0, title: epTitle(e.title, item), ext: e.container_extension || "mp4",
                             image: inf.movie_image || inf.cover_big || "", plot: inf.plot || inf.description || "", dur: parseInt(inf.duration_secs, 10) || 0, tmdb: inf.tmdb_id || "" };
                }).sort(function (a, b) { return a.episode - b.episode; });
            });
            return { seasons: seasons, info: j && j.info || {} };
        });
    }

    /* "Show - S01E02 - The Title" -> "The Title"; nothing left -> "" (the page says "Episode 2") */
    function epTitle(t, item) {
        t = String(t || "");
        var m = t.match(/S\d{1,2}\s*E\d{1,3}\s*[-:.]?\s*(.*)$/i);
        if (m) t = m[1];
        else if (item && (item.title || item.name) && t.toLowerCase().indexOf(String(item.title || item.name).toLowerCase()) === 0) t = t.slice(String(item.title || item.name).length);
        return t.replace(/^[\s\-:|.]+/, "").trim();
    }

    function search(q, limit) {
        q = S.fold(q);
        if (!q || !merged) return { live: [], movies: [], series: [] };
        var words = q.split(" "), adult = TV.pref("showAdult"), hid = anyHidden();
        function match(name) { var f = S.fold(name); for (var i = 0; i < words.length; i++) if (f.indexOf(words[i]) === -1) return false; return true; }
        function scan(arr) {
            var out = [];
            for (var i = 0; i < arr.length && out.length < (limit || 40); i++) {
                var x = arr[i];
                if ((adult || !catOf(x).adult) && match(x.title || x.name) && (!hid || !isHidden(x))) out.push(x);
            }
            return out;
        }
        var live = [], seen = {};
        scan(merged.live.chans).forEach(function (c) { if (!seen[c.key]) { seen[c.key] = 1; live.push(c); } });
        // your language first (then multi-language), the rest after, in the same order
        function mineFirst(list) {
            var rank = function (x) { var l = catOf(x).lang; return l === TV.lang ? 0 : (l === "multi" ? 1 : 2); };
            return list.map(function (x, i) { return [rank(x), i, x]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }).map(function (r) { return r[2]; });
        }
        return { live: live, movies: mineFirst(groupVersions(scan(merged.movies.items))), series: mineFirst(groupVersions(scan(merged.series.items))) };
    }

    /* Every channel whose variants' key is this name ("tf1"), all qualities and countries (voice: "mets TF1") */
    function channelsNamed(name) {
        if (!merged || !name) return [];
        var adult = TV.pref("showAdult"), hid = anyHidden();
        return merged.live.chans.filter(function (c) {
            return String(c.key || "").split(":").pop() === name && (adult || !catOf(c).adult) && (!hid || !isHidden(c));
        });
    }

    restoreThemes();            // the titles already known for your hidden themes, before anything is drawn
    TV.data = {
        sources: sources, addSource: addSource, removeSource: removeSource, updateSource: updateSource, normServer: normServer, xtreamFromUrl: xtreamFromUrl,
        loadSource: loadSource, start: start, refresh: refresh, onChange: onChange, rebuild: rebuild, xAuth: xAuth,
        catalog: function () { return merged; },
        channelsIn: channelsIn, channelsNamed: channelsNamed, channel: channel, streamUrl: streamUrl, catOf: catOf, sourceOf: sourceOf,
        favIds: favIds, isFav: isFav, toggleFav: toggleFav, favChannels: favChannels, moveFav: moveFav,
        chanGroups: chanGroups, chanGroupOf: chanGroupOf, addChanGroup: addChanGroup, renameChanGroup: renameChanGroup, deleteChanGroup: deleteChanGroup, toggleChanGroup: toggleChanGroup, moveInChanGroup: moveInChanGroup,
        pushRecent: pushRecent, recentChannels: recentChannels,
        myList: myList, inMyList: inMyList, toggleMyList: toggleMyList,
        setResume: setResume, resumeOf: resumeOf, continueWatching: continueWatching, isDone: isDone, markWatched: markWatched, recentlyWatched: recentlyWatched,
        forget: forget, resumeChanged: resumeChanged,
        isHidden: isHidden, setHidden: setHidden, preferVersion: preferVersion, setCatOff: setCatOff, setGroupOff: setGroupOff, editData: editData, applyPhoneEdit: applyPhoneEdit, offGroups: offGroups, offCats: offCats, hiddenList: hiddenList, unhide: unhide, versionKey: versionKey,
        buildThemes: buildThemes, checkTheme: checkTheme, themesOn: themesOn, catNameHidden: catNameHidden,
        itemsIn: itemsIn, vodUrl: vodUrl, vodInfo: vodInfo, seriesInfo: seriesInfo, search: search,
        xApi: xApi, parseM3U: parseM3U, pack: pack, unpack: unpack, findTitles: findTitles, titleIndex: titleIndex, genreItems: genreItems,
        genreReady: function (kind, gid) { return !!genreLists[kind + ":" + gid]; }, topReady: function (kind) { return !!topLists[kind]; }
    };
})(window);
