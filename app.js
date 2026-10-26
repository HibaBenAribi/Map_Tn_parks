"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TYPES = { "Animal observation": "#e53935", "Bioacoustic recording": "#ab47bc", "Photo": "#fb8c00", "Video": "#1e88e5", "Geospatial data": "#43a047", "Document": "#8d6e63", "Other": "#90a4ae" };
const nm = f => f.properties.NAME_ENG || f.properties.name || f.properties.NAME || "Park";

let parks = null, cur = null, pts = [], adding = false, editId = null, pending = null;

const dem = { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 15, tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"] };

const map = new maplibregl.Map({
  container: "map",
  center: [9.5, 34],
  zoom: 5.4,
  maxPitch: 85,
  style: {
    version: 8,
    sources: {
      sat: { type: "raster", tileSize: 256, maxzoom: 14, attribution: "Sentinel-2 cloudless (c) EOX", tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg"] },
      dem,
      hs: dem
    },
    layers: [
      { id: "sat", type: "raster", source: "sat" },
      { id: "hs", type: "hillshade", source: "hs", paint: { "hillshade-exaggeration": .35 } }
    ],
    terrain: { source: "dem", exaggeration: 1.5 }
  }
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
map.addControl(new maplibregl.ScaleControl());

/* ---- media ---- */
function media(p) {
  p = String(p).trim();
  if (!p) return "";
  const u = esc(p), E = ' onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{textContent:\'File not found: \'+this.getAttribute(\'src\')+\' (looked at \'+this.src+\')\'}))"';
  if (/youtu\.be\/|youtube\.com\/watch/.test(p)) {
    const m = p.match(/(?:v=|youtu\.be\/)([\w-]{6,})/);
    return m ? '<iframe width="100%" height="170" src="https://www.youtube.com/embed/' + m[1] + '" allowfullscreen></iframe>' : "";
  }
  if (/\.(jpe?g|png|gif|webp|svg)$/i.test(p)) return '<img src="' + u + '"' + E + ' loading="lazy">';
  if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(p)) return '<audio controls preload="none" src="' + u + '"' + E + '></audio>';
  if (/\.(mp4|webm|mov)$/i.test(p)) return '<video controls preload="metadata" src="' + u + '"' + E + '></video>';
  return '<div><a href="' + u + '" target="_blank">' + u + '</a></div>';
}

/* ---- persistence: points -> saved_data/, media -> media/ (done by start.py) ---- */
let loadToken = 0, loadedFor = null, saveTimer = null, dirty = null;

function setSaveMsg(t, bad) {
  const el = $("savemsg");
  if (!el) return;
  el.textContent = t;
  el.style.color = bad ? "#ef5350" : "";
}

// Server copy first; falls back to the committed static file (works on static hosting too).
async function loadSaved(park) {
  const urls = ["api/load?park=" + encodeURIComponent(park), "saved_data/" + slug(park) + "_public_points.json"];
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) continue;
      const d = await r.json();
      if (Array.isArray(d)) return d;
    } catch (e) { /* try next */ }
  }
  return [];
}

async function postSave(s) {
  try {
    const body = JSON.stringify(s);
    const r = await fetch("api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: body.length < 60000 });
    if (!r.ok) throw new Error(r.status);
    setSaveMsg("Saved " + s.points.length + " point(s) to saved_data/ at " + new Date().toLocaleTimeString());
  } catch (e) {
    setSaveMsg("Auto-save failed. Run the app with python start.py (static hosting cannot save). Use the export buttons to keep your work.", true);
  }
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty) return Promise.resolve();
  const s = dirty;
  dirty = null;
  return postSave(s);
}

// Call after every change to the points; snapshots the current park and saves shortly after.
function save() {
  if (!cur || loadedFor !== cur) return;
  dirty = { park: cur, points: JSON.parse(JSON.stringify(pts)) };
  setSaveMsg("Saving...");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}
window.addEventListener("pagehide", flush);

const toB64 = f => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] || "");
  r.onerror = rej;
  r.readAsDataURL(f);
});

async function uploadMedia(file) {
  const r = await fetch("api/upload-media", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, data: await toB64(file) }) });
  if (!r.ok) throw new Error(r.status);
  const j = await r.json();
  return j.filename || file.name;
}

/* ---- parks ---- */
async function init() {
  try {
    const r = await fetch("data/parks.geojson");
    if (!r.ok) throw 0;
    setParks(await r.json());
  } catch (e) {
    $("msg").innerHTML = 'Could not load <code>data/parks.geojson</code>. Choose the file: <input type="file" id="pf" accept=".geojson,.json">';
    $("pf").onchange = e => e.target.files[0].text().then(t => setParks(JSON.parse(t)));
  }
}

function setParks(fc) {
  if (fc.type === "Feature") fc = { type: "FeatureCollection", features: [fc] };
  fc.features = fc.features.filter(f => f.geometry && /Polygon/.test(f.geometry.type));
  parks = fc;
  const names = [...new Set(fc.features.map(nm))].sort();
  $("msg").textContent = names.length + " park(s) loaded";
  $("park").innerHTML = '<option value="">Select a park...</option>' + names.map(n => "<option>" + esc(n) + "</option>").join("");
  
  map.addSource("parks", { type: "geojson", data: fc });
  map.addLayer({ id: "parks-fill", type: "fill", source: "parks", paint: { "fill-color": "#2e7d32", "fill-opacity": .3 } });
  map.addLayer({ id: "parks-line", type: "line", source: "parks", paint: { "line-color": "#ffd54f", "line-width": 2 } });
  map.addSource("mask", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "mask", type: "fill", source: "mask", paint: { "fill-color": "#0b0f14", "fill-opacity": .88 } }, "parks-line");
  
  const col = ["match", ["get", "type"]];
  Object.entries(TYPES).forEach(([k, v]) => col.push(k, v));
  col.push("#90a4ae");
  
  map.addSource("pts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "pts", type: "circle", source: "pts", paint: { "circle-radius": 7, "circle-color": col, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  
  map.on("mouseenter", "parks-fill", () => { if (!adding) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "parks-fill", () => { map.getCanvas().style.cursor = adding ? "crosshair" : ""; });
  
  const b = bbox(fc.features);
  map.fitBounds(b, { padding: 40, duration: 0 });
}

function bbox(fs) {
  let b = [1e9, 1e9, -1e9, -1e9];
  const w = c => typeof c[0] === "number" ? b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])] : c.forEach(w);
  fs.forEach(f => w(f.geometry.coordinates));
  return b;
}

function maskFor(fs) {
  const holes = [];
  fs.forEach(f => (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).forEach(p => holes.push(p[0])));
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]].concat(holes) } };
}

function slug(name) {
  return String(name || cur || "").replace(/\W+/g, "_").toLowerCase();
}

async function selectPark(n) {
  flush();                       // save the park we are leaving
  const tok = ++loadToken;
  loadedFor = null;
  cur = n || null;
  $("park").value = n || "";
  const hasPark = !!cur;
  $("add").disabled = $("exp").disabled = $("expmap").disabled = $("expzip").disabled = !hasPark;
  if ($("reset")) $("reset").disabled = !hasPark;
  setAdd(false);
  map.getContainer().querySelectorAll(".maplibregl-popup").forEach(e => e.remove());
  setSaveMsg("");

  pts = [];
  draw();

  if (!cur) {
    map.getSource("mask").setData({ type: "FeatureCollection", features: [] });
    map.flyTo({ center: [9.5, 34], zoom: 5.4, pitch: 0, bearing: 0 });
    return;
  }

  const fs = parks.features.filter(f => nm(f) === cur);
  map.getSource("mask").setData(maskFor(fs));
  const b = bbox(fs);
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, pitch: 60, duration: 1800 });

  setSaveMsg("Loading saved points...");
  const saved = await loadSaved(cur);
  if (tok !== loadToken) return; // another park was selected meanwhile
  pts = saved;
  loadedFor = cur;
  draw();
  setSaveMsg(saved.length ? saved.length + " saved point(s) loaded." : "No saved points yet. Changes are saved automatically.");
}

$("park").onchange = e => selectPark(e.target.value);

function draw() {
  map.getSource("pts").setData({
    type: "FeatureCollection",
    features: pts.map(p => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] }, properties: { id: p.id, type: p.type } }))
  });
  $("list").innerHTML = !cur ? "Select a park first." : pts.length ? "" : "No points yet.";
  
  pts.forEach(p => {
    const d = document.createElement("div");
    d.innerHTML = '<span class="dot" style="background:' + (TYPES[p.type] || "#90a4ae") + '"></span>' + esc(p.title || "(untitled)") + ' <span class="mu">' + esc(p.type) + "</span>";
    d.onclick = () => { map.flyTo({ center: [p.lng, p.lat], zoom: 15, pitch: 65 }); popup(p); };
    $("list").appendChild(d);
  });
}

function popup(p) {
  const m = (p.media || []).map(media).join("");
  new maplibregl.Popup({ maxWidth: "320px" })
    .setLngLat([p.lng, p.lat])
    .setHTML('<div class="pop"><h3>' + esc(p.title) + '</h3><div class="mu"><span class="dot" style="background:' + (TYPES[p.type] || "#90a4ae") + '"></span>' + esc(p.type) + (p.date ? " | " + esc(p.date) : "") + "</div><p>" + esc(p.desc) + "</p>" + m + '<p><button onclick="edit(\'' + p.id + '\')">Edit</button></p></div>')
    .addTo(map);
}

function setAdd(on) {
  adding = on;
  $("add").classList.toggle("on", on);
  map.getCanvas().style.cursor = on ? "crosshair" : "";
}

$("add").onclick = () => setAdd(!adding);

if ($("reset")) {
  $("reset").onclick = () => {
    if (!cur) return;
    if (confirm("Are you sure you want to clear all points for this park?")) {
      pts = [];
      draw();
      save();
      map.getContainer().querySelectorAll(".maplibregl-popup").forEach(e => e.remove());
    }
  };
}

$("f_type").innerHTML = Object.keys(TYPES).map(t => "<option>" + t + "</option>").join("");

let formMedia = [];

function renderFormMedia() {
  const box = $("f_medialist");
  box.innerHTML = "";
  if (!formMedia.length) { box.textContent = "No media attached to this point."; return; }
  formMedia.forEach((m, i) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0";
    const name = document.createElement("span");
    name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    name.textContent = m.replace(/^media\//, "");
    name.title = m;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "Remove";
    rm.style.cssText = "width:auto;flex:none;padding:2px 8px";
    rm.onclick = () => { formMedia.splice(i, 1); renderFormMedia(); };
    row.append(name, rm);
    box.appendChild(row);
  });
}

function openForm(p, at) {
  editId = p ? p.id : null;
  pending = at;
  $("dt").textContent = p ? "Edit point" : "New point";
  $("f_title").value = p ? p.title : "";
  $("f_type").value = p ? p.type : "Animal observation";
  $("f_date").value = p ? p.date : new Date().toISOString().slice(0, 10);
  $("f_desc").value = p ? p.desc : "";
  formMedia = p ? (p.media || []).slice() : [];
  renderFormMedia();
  $("f_del").hidden = !p;
  $("f_upmsg").textContent = "";
  $("dlg").showModal();
}

window.edit = id => { const p = pts.find(x => x.id === id); if (p) openForm(p, null); };
$("f_no").onclick = () => $("dlg").close();

$("f_files").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const note = $("f_upmsg"), okBtn = $("f_ok");
  okBtn.disabled = true;
  const failed = [];
  for (const [i, file] of files.entries()) {
    note.textContent = "Uploading " + (i + 1) + "/" + files.length + ": " + file.name + " ...";
    try {
      const p = "media/" + await uploadMedia(file);
      if (!formMedia.includes(p)) formMedia.push(p);
      renderFormMedia();
    } catch (err) { failed.push(file.name); }
  }
  okBtn.disabled = false;
  note.textContent = failed.length
    ? "Upload failed for: " + failed.join(", ") + ". Run the app with python start.py."
    : files.length + " file(s) uploaded to media/.";
};

$("f_ok").onclick = () => {
  const o = {
    title: $("f_title").value.trim(),
    type: $("f_type").value,
    date: $("f_date").value,
    desc: $("f_desc").value.trim(),
    media: formMedia.slice()
  };
  if (editId) {
    Object.assign(pts.find(x => x.id === editId), o);
  } else {
    pts.push(Object.assign({ id: "p" + Date.now(), lng: pending.lng, lat: pending.lat }, o));
  }
  $("dlg").close();
  setAdd(false);
  draw();
  save();
};

$("f_del").onclick = () => {
  if (confirm("Delete this point?")) {
    pts = pts.filter(x => x.id !== editId);
    $("dlg").close();
    map.getContainer().querySelectorAll(".maplibregl-popup").forEach(e => e.remove());
    draw();
    save();
  }
};

map.on("click", e => {
  if (adding && cur) { openForm(null, e.lngLat); return; }
  const f = map.getLayer("pts") && map.queryRenderedFeatures(e.point, { layers: ["pts"] })[0];
  if (f) { const p = pts.find(x => x.id === f.properties.id); if (p) popup(p); return; }
  if (!cur && map.getLayer("parks-fill")) {
    const g = map.queryRenderedFeatures(e.point, { layers: ["parks-fill"] })[0];
    if (g) selectPark(nm(g));
  }
});

$("t3d").onchange = e => map.setTerrain(e.target.checked ? { source: "dem", exaggeration: 1.5 } : null);

/* ---- import (GeoJSON or GPX) ---- */
const SKIP = ["id", "park", "title", "name", "type", "date", "description", "desc", "media"];

function toPoints(o, seed) {
  const out = [];
  (o.features || (o.type === "Feature" ? [o] : [])).forEach((f, i) => {
    if (!f.geometry) return;
    const q = f.properties || {};
    const cs = f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.type === "MultiPoint" ? f.geometry.coordinates : [];
    cs.forEach((c, j) => {
      const extra = Object.keys(q).filter(k => !SKIP.includes(k) && q[k] != null && q[k] !== "").map(k => k + ": " + (typeof q[k] === "object" ? JSON.stringify(q[k]) : q[k]));
      let desc = q.description || q.desc || "";
      if (extra.length) desc += (desc ? "\n" : "") + extra.join("\n");
      out.push({
        id: "p" + seed + "_" + i + "_" + j,
        lng: +c[0],
        lat: +c[1],
        title: q.title || q.name || "",
        type: TYPES[q.type] ? q.type : "Other",
        date: q.date || "",
        desc: desc,
        media: Array.isArray(q.media) ? q.media : q.media ? String(q.media).split(/\n/).map(s => s.trim()).filter(Boolean) : []
      });
    });
  });
  return out;
}

function inRing(x, y, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

function inFeat(f, x, y) {
  const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some(p => inRing(x, y, p[0]) && !p.slice(1).some(h => inRing(x, y, h)));
}

function parkAt(x, y) {
  const f = parks.features.find(f => inFeat(f, x, y));
  return f ? nm(f) : null;
}

function gpxToPoints(text, seed) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("invalid XML");
  const t = (el, n) => { const x = el.getElementsByTagName(n)[0]; return x ? x.textContent.trim() : ""; };
  const points = [];
  [...doc.getElementsByTagName("wpt")].forEach((w, i) => {
    const lat = parseFloat(w.getAttribute("lat")), lng = parseFloat(w.getAttribute("lon"));
    if (!isFinite(lat) || !isFinite(lng)) return;
    const name = t(w, "name"), desc = t(w, "desc"), cmt = t(w, "cmt"), ele = parseFloat(t(w, "ele")), time = t(w, "time"), sym = t(w, "sym");
    const lines = [];
    if (cmt && cmt !== desc && cmt !== name) lines.push(cmt);
    if (isFinite(ele)) lines.push("Elevation: " + Math.round(ele * 10) / 10 + " m");
    if (time) lines.push("Recorded (UTC): " + time.replace("T", " ").replace("Z", ""));
    if (sym) lines.push("Symbol: " + sym);
    const links = [...w.getElementsByTagName("link")].map(l => l.getAttribute("href")).filter(Boolean);
    points.push({
      id: "p" + seed + "_g" + i,
      lng: lng,
      lat: lat,
      title: desc && desc !== name ? (name ? name + " - " + desc : desc) : (name || "(waypoint)"),
      type: "Geospatial data",
      date: time ? time.slice(0, 10) : "",
      desc: lines.join("\n"),
      media: links
    });
  });
  return { points: points, tracks: doc.getElementsByTagName("trk").length, routes: doc.getElementsByTagName("rte").length };
}

$("imp").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  let added = 0, errs = [], notes = [];
  for (const [k, f] of files.entries()) {
    try {
      const text = await f.text();
      let np;
      if (/\.gpx$/i.test(f.name) || /^\s*(<\?xml|<gpx)/i.test(text)) {
        const g = gpxToPoints(text, Date.now() + "_" + k);
        if (!g.points.length) { errs.push(f.name + ": no waypoints found"); continue; }
        if (!cur && parks) {
          const cnt = {};
          g.points.forEach(p => { const n = parkAt(p.lng, p.lat); if (n) cnt[n] = (cnt[n] || 0) + 1; });
          const best = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
          if (best) { await selectPark(best); notes.push("park set to " + best + "."); }
        }
        if (!cur) { errs.push(f.name + ": select a park first"); continue; }
        np = g.points;
      } else {
        const o = JSON.parse(text);
        if (!cur && o.park && parks && parks.features.some(x => nm(x) === o.park)) await selectPark(o.park);
        if (!cur) { errs.push(f.name + ": select a park first"); continue; }
        np = toPoints(o, Date.now() + "_" + k);
        if (!np.length) { errs.push(f.name + ": no Point features found"); continue; }
      }
      pts = pts.concat(np);
      added += np.length;
    } catch (err) { errs.push(f.name + ": invalid file"); }
  }
  if (added) {
    draw();
    save();
    const b = bbox(pts.map(p => ({ geometry: { coordinates: [p.lng, p.lat] } })));
    if (pts.length) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, maxZoom: 14, pitch: 60, duration: 1200 });
  }
  $("impmsg").textContent = (added ? added + " point(s) imported. " : "") + notes.join(" ");
};

/* ---- exports ---- */
const isRemote = p => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(p) || /^(data|mailto|blob):/i.test(p);
function mediaPath(p) {
  p = String(p).trim();
  if (!p || isRemote(p)) return p;
  const base = p.split(/[\\/]/).filter(Boolean).pop();
  return base ? "media/" + base : p;
}
function exportPoints() { return pts.map(p => Object.assign({}, p, { media: (p.media || []).map(mediaPath) })); }
function mediaFiles() {
  const set = new Set();
  exportPoints().forEach(p => p.media.forEach(m => { if (m && !isRemote(m) && /^media\//.test(m)) set.add(m.slice(6)); }));
  return [...set].sort();
}

function download(name, text, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$("exp").onclick = () => {
  const fc = {
    type: "FeatureCollection",
    park: cur,
    features: pts.map(p => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: { id: p.id, park: cur, title: p.title, type: p.type, date: p.date, description: p.desc, media: p.media }
    }))
  };
  download(slug() + "_points.geojson", JSON.stringify(fc, null, 2), "application/geo+json");
};

/* ---- export interactive 3D map ---- */
function buildEmbed() {
  const fs = parks.features.filter(f => nm(f) === cur);
  const data = { park: cur, parks: { type: "FeatureCollection", features: fs }, mask: maskFor(fs), points: exportPoints(), types: TYPES, dem: dem };
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const css = [
    "*{box-sizing:border-box}html,body{height:100%;margin:0;font:14px system-ui,sans-serif}",
    "#wrap{position:relative;height:100%;min-height:320px}#map{position:absolute;inset:0}",
    "#panel{position:absolute;top:10px;left:10px;z-index:2;max-width:250px;max-height:60%;overflow:auto;background:#161d23ee;color:#e8eef2;border-radius:8px;padding:10px;font-size:13px}",
    "#panel h1{font-size:15px;margin:0 0 6px}#panel label{display:block;margin-bottom:6px;cursor:pointer}",
    "#list div{padding:4px 0;border-top:1px solid #27323a;cursor:pointer}#list div:hover{color:#ffd54f}",
    ".dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}.mu{color:#93a1ab;font-size:12px}",
    ".pop{color:#111;max-width:300px}.pop h3{margin:0 0 4px}.pop img,.pop video{width:100%;border-radius:6px;margin-top:6px}.pop audio{width:100%;margin-top:6px}"
  ].join("\n");
  const js = [
    "var D=" + json + ";",
    "var esc=" + esc.toString() + ";",
    "var media=" + media.toString() + ";",
    "var bbox=" + bbox.toString() + ";",
    "var map=new maplibregl.Map({container:'map',center:[9.5,34],zoom:5,maxPitch:85,style:{version:8,sources:{",
    " sat:{type:'raster',tileSize:256,maxzoom:14,attribution:'Sentinel-2 cloudless (c) EOX',tiles:['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg']},dem:D.dem,hs:D.dem},",
    " layers:[{id:'sat',type:'raster',source:'sat'},{id:'hs',type:'hillshade',source:'hs',paint:{'hillshade-exaggeration':.35}}],",
    " terrain:{source:'dem',exaggeration:1.5}}});",
    "map.addControl(new maplibregl.NavigationControl({visualizePitch:true}));",
    "map.addControl(new maplibregl.ScaleControl());",
    "var fs=D.parks.features,b=bbox(fs);",
    "function pop(p){var m=(p.media||[]).map(media).join('');",
    " new maplibregl.Popup({maxWidth:'320px'}).setLngLat([p.lng,p.lat]).setHTML('<div class=\"pop\"><h3>'+esc(p.title)+'</h3><div class=\"mu\"><span class=\"dot\" style=\"background:'+(D.types[p.type]||'#90a4ae')+'\"></span>'+esc(p.type)+(p.date?' | '+esc(p.date):'')+'</div><p style=\"white-space:pre-line\">'+esc(p.desc)+'</p>'+m+'</div>').addTo(map)}",
    "map.on('load',function(){",
    " map.addSource('parks',{type:'geojson',data:D.parks});",
    " map.addLayer({id:'parks-fill',type:'fill',source:'parks',paint:{'fill-color':'#2e7d32','fill-opacity':.25}});",
    " map.addSource('mask',{type:'geojson',data:D.mask});",
    " map.addLayer({id:'mask',type:'fill',source:'mask',paint:{'fill-color':'#0b0f14','fill-opacity':.88}});",
    " map.addLayer({id:'parks-line',type:'line',source:'parks',paint:{'line-color':'#ffd54f','line-width':2}});",
    " var col=['match',['get','type']];Object.keys(D.types).forEach(function(k){col.push(k,D.types[k])});col.push('#90a4ae');",
    " map.addSource('pts',{type:'geojson',data:{type:'FeatureCollection',features:D.points.map(function(p){return{type:'Feature',geometry:{type:'Point',coordinates:[p.lng,p.lat]},properties:{id:p.id,type:p.type}}})}});",
    " map.addLayer({id:'pts',type:'circle',source:'pts',paint:{'circle-radius':7,'circle-color':col,'circle-stroke-color':'#fff','circle-stroke-width':2}});",
    " map.on('click','pts',function(e){var id=e.features[0].properties.id;D.points.forEach(function(p){if(p.id===id)pop(p)})});",
    " map.on('mouseenter','pts',function(){map.getCanvas().style.cursor='pointer'});",
    " map.on('mouseleave','pts',function(){map.getCanvas().style.cursor=''});",
    " map.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:60,pitch:60,duration:0});",
    "});",
    "document.getElementById('ttl').textContent=D.park;",
    "var L=document.getElementById('list');",
    "if(!D.points.length)L.innerHTML='<div class=\"mu\">No points.</div>';",
    "D.points.forEach(function(p){var d=document.createElement('div');d.innerHTML='<span class=\"dot\" style=\"background:'+(D.types[p.type]||'#90a4ae')+'\"></span>'+esc(p.title||'(untitled)');",
    " d.onclick=function(){map.flyTo({center:[p.lng,p.lat],zoom:15,pitch:65});pop(p)};L.appendChild(d)});",
    "document.getElementById('t3d').onchange=function(e){map.setTerrain(e.target.checked?{source:'dem',exaggeration:1.5}:null)};"
  ].join("\n");
  const S = "script";
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>' + esc(cur) + ' - interactive map</title>\n' +
    '<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">\n<style>\n' + css + '\n</style></head><body>\n' +
    '<div id="wrap"><div id="map"></div><div id="panel"><h1 id="ttl"></h1><label><input type="checkbox" id="t3d" checked> 3D terrain</label><div id="list"></div></div></div>\n' +
    '<' + S + ' src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></' + S + '>\n<' + S + '>\n' + js + '\n</' + S + '>\n</body></html>\n';
}

// Copies every local media file used by the points from media/ (saved by start.py) into the zip.
async function addMedia(z, names) {
  const missing = [];
  for (const [i, n] of names.entries()) {
    setSaveMsg("Packing media " + (i + 1) + "/" + names.length + ": " + n);
    try {
      const r = await fetch("media/" + encodeURIComponent(n), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      z.file("media/" + n, await r.blob());
    } catch (e) { missing.push(n); }
  }
  setSaveMsg("");
  return missing;
}
const warnMissing = m => m.length && alert("These media files were not found in the media/ folder and are not in the package:\n\n" + m.join("\n"));

$("expmap").onclick = async () => {
  if (!cur) return;
  const s = slug(), html = buildEmbed(), mf = mediaFiles();
  if (!mf.length) { download(s + "_map.html", html, "text/html"); return; }
  try {
    if (!window.JSZip) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
    const z = new JSZip();
    z.file(s + "_map.html", html);
    const missing = await addMedia(z, mf);
    download(s + "_map_package.zip", await z.generateAsync({ type: "blob" }), "application/zip");
    warnMissing(missing);
  } catch (e) {
    download(s + "_map.html", html, "text/html");
    alert("Could not build the ZIP, so only the HTML was downloaded. Copy your files into a media/ folder next to it.");
  }
};


/* ---- web component packaging ---- */
function parkMapComponent() {
  if (customElements.get("tunisia-park-map")) return;
  var CSS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css", JS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
  var DEM = { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 15, tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"] };
  var lib = null;
  function loadLib() {
    if (window.maplibregl) return Promise.resolve();
    if (lib) return lib;
    lib = new Promise(function (res, rej) { var s = document.createElement("script"); s.src = JS; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    return lib;
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function media(p) {
    p = String(p).trim(); if (!p) return ""; var u = esc(p), E = ' onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{textContent:\'File not found: \'+this.getAttribute(\'src\')+\' (looked at \'+this.src+\')\'}))"';
    if (/youtu\.be\/|youtube\.com\/watch/.test(p)) { var m = p.match(/(?:v=|youtu\.be\/)([\w-]{6,})/); return m ? '<iframe width="100%" height="170" src="https://www.youtube.com/embed/' + m[1] + '" allowfullscreen></iframe>' : ""; }
    if (/\.(jpe?g|png|gif|webp|svg)$/i.test(p)) return '<img src="' + u + '"' + E + ' loading="lazy">';
    if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(p)) return '<audio controls preload="none" src="' + u + '"' + E + '></audio>';
    if (/\.(mp4|webm|mov)$/i.test(p)) return '<video controls preload="metadata" src="' + u + '"' + E + '></video>';
    return '<div><a href="' + u + '" target="_blank">' + u + '</a></div>';
  }
  function bbox(fs) {
    var b = [1e9, 1e9, -1e9, -1e9];
    function w(c) { if (typeof c[0] === "number") { b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])]; } else c.forEach(w); }
    fs.forEach(function (f) { w(f.geometry.coordinates); });
    return b;
  }
  var STYLE = ":host{display:block;height:600px;position:relative;font:14px system-ui,sans-serif}#wrap{position:relative;height:100%}#map{position:absolute;inset:0}" +
    "#panel{position:absolute;top:10px;left:10px;z-index:2;max-width:250px;max-height:60%;overflow:auto;background:#161d23ee;color:#e8eef2;border-radius:8px;padding:10px;font-size:13px}" +
    "#panel.hide{display:none}#ttl{font-size:15px;display:block;margin-bottom:6px}#panel label{display:block;margin-bottom:6px;cursor:pointer}" +
    "#list div{padding:4px 0;border-top:1px solid #27323a;cursor:pointer}#list div:hover{color:#ffd54f}"+
    ".dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}.mu{color:#93a1ab;font-size:12px}"+
    ".pop{color:#111;max-width:300px}.pop h3{margin:0 0 4px}.pop img,.pop video{width:100%;border-radius:6px;margin-top:6px}.pop audio{width:100%;margin-top:6px}"+
    "#err{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#161d23;color:#e8eef2;padding:20px;text-align:center}";
  
  class ParkMap extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return; var self = this;
      if (this.getAttribute("height")) this.style.height = this.getAttribute("height");
      var root = this.attachShadow({ mode: "open" });
      root.innerHTML = '<link rel="stylesheet" href="' + CSS + '"><style>' + STYLE + '</style><div id="wrap"><div id="map"></div>'+
        '<div id="panel"><b id="ttl"></b><label><input type="checkbox" id="t3d"> 3D terrain</label><div id="list"></div></div></div>';
      if (this.getAttribute("panel") === "false") root.getElementById("panel").classList.add("hide");
      var src = this.getAttribute("src");
      Promise.all([loadLib(), fetch(src).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()})])
        .then(function(a){self.init(root,a[1])})
        .catch(function(e){var d=document.createElement("div");d.id="err";d.textContent="Could not load map data ("+src+"). Serve the page over http(s), not file://.";root.getElementById("wrap").appendChild(d)})}
    disconnectedCallback() { if (this._map) { this._map.remove(); this._map = null; } }
    init(root, D) {
      var terrain = this.getAttribute("terrain") !== "false", pitch = +(this.getAttribute("pitch") || 60);
      var cb = root.getElementById("t3d"); cb.checked = terrain; root.getElementById("ttl").textContent = D.park;
      var map = this._map = new maplibregl.Map({
        container: root.getElementById("map"), center: [9.5, 34], zoom: 5, maxPitch: 85, style: {
          version: 8, sources: {
            sat: { type: "raster", tileSize: 256, maxzoom: 14, attribution: "Sentinel-2 cloudless (c) EOX", tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg"] }, dem: DEM, hs: DEM
          },
          layers: [{ id: "sat", type: "raster", source: "sat" }, { id: "hs", type: "hillshade", source: "hs", paint: { "hillshade-exaggeration": .35 } }],
          terrain: { source: "dem", exaggeration: 1.5 }
        }
      });
      if (!terrain) map.once("style.load", function(){map.setTerrain(null)});
      map.addControl(new maplibregl.NavigationControl({visualizePitch:true})); map.addControl(new maplibregl.ScaleControl());
      var b = bbox(D.parks.features);
      function pop(p){var m=(p.media||[]).map(media).join("");
        new maplibregl.Popup({maxWidth:"320px"}).setLngLat([p.lng,p.lat]).setHTML('<div class="pop"><h3>'+esc(p.title)+'</h3><div class="mu"><span class="dot" style="background:'+(D.types[p.type]||"#90a4ae")+'"></span>'+esc(p.type)+(p.date?" | "+esc(p.date):"")+'</div><p style="white-space:pre-line">'+esc(p.desc)+"</p>"+m+"</div>").addTo(map)}
      map.on("load",function(){
        map.addSource("parks",{type:"geojson",data:D.parks});
        map.addLayer({id:"parks-fill",type:"fill",source:"parks",paint:{"fill-color":"#2e7d32","fill-opacity":.25}});
        map.addSource("mask",{type:"geojson",data:D.mask});
        map.addLayer({id:"mask",type:"fill",source:"mask",paint:{"fill-color":"#0b0f14","fill-opacity":.88}});
        map.addLayer({id:"parks-line",type:"line",source:"parks",paint:{"line-color":"#ffd54f","line-width":2}});
        var col=["match",["get","type"]];Object.keys(D.types).forEach(function(k){col.push(k,D.types[k])});col.push("#90a4ae");
        map.addSource("pts",{type:"geojson",data:{type:"FeatureCollection",features:D.points.map(function(p){return{type:"Feature",geometry:{type:"Point",coordinates:[p.lng,p.lat]},properties:{id:p.id,type:p.type}}})}});
        map.addLayer({id:"pts",type:"circle",source:"pts",paint:{"circle-radius":7,"circle-color":col,"circle-stroke-color":"#fff","circle-stroke-width":2}});
        map.on("click","pts",function(e){var id=e.features[0].properties.id;D.points.forEach(function(p){if(p.id===id)pop(p)})});
        map.on("mouseenter","pts",function(){map.getCanvas().style.cursor="pointer"});
        map.on("mouseleave","pts",function(){map.getCanvas().style.cursor=""});
        map.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:60,pitch:pitch,duration:0})});
      var L=root.getElementById("list");if(!D.points.length)L.innerHTML='<div class="mu">No points.</div>';
      D.points.forEach(function(p){var d=document.createElement("div");d.innerHTML='<span class="dot" style="background:'+(D.types[p.type]||"#90a4ae")+'"></span>'+esc(p.title||"(untitled)");
        d.onclick=function(){map.flyTo({center:[p.lng,p.lat],zoom:15,pitch:65});pop(p)};L.appendChild(d)});
      cb.onchange=function(e){map.setTerrain(e.target.checked?{source:"dem",exaggeration:1.5}:null)};
    }
  }
  customElements.define("tunisia-park-map",ParkMap);
}

function loadScript(u){return new Promise((res,rej)=>{const s=document.createElement("script");s.src=u;s.onload=res;s.onerror=rej;document.head.appendChild(s)})}

$("expzip").onclick=async()=>{if(!cur)return;
 const fs=parks.features.filter(f=>nm(f)===cur);
 const data={park:cur,parks:{type:"FeatureCollection",features:fs},mask:maskFor(fs),points:exportPoints(),types:TYPES};
 const s=slug();
 const example='<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>'+esc(cur)+'</title></head>\n<body>\n<h1>'+esc(cur)+'</h1>\n\n<!-- 1. load the component once per page -->\n<script src="tunisia-park-map.js"><\/script>\n\n<!-- 2. place the map wherever you want it -->\n<tunisia-park-map src="'+s+'.json" height="600px"></tunisia-park-map>\n\n<!-- optional attributes: pitch="60"  terrain="false"  panel="false" -->\n</body></html>\n';
 const mf=mediaFiles();
 const readme="MEDIA FOLDER\n============\nThe media files used by the map are included in this folder. Keep the exact file names below when you upload the site.\nThe map looks for them at media/<file name>, next to the page that contains the map.\n\n"+(mf.length?mf.join("\n"):"(no local media files referenced; only web links are used)")+"\n\nNote: two files with the same name from different folders become one entry, so give them different names.\n";
 const files={"media/README.txt":readme,"tunisia-park-map.js":"("+parkMapComponent.toString()+")();\n",[s+".json"]:JSON.stringify(data),"example.html":example};
 try{
  if(!window.JSZip)await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  const z=new JSZip();Object.entries(files).forEach(([n,t])=>z.file(n,t));const missing=await addMedia(z,mf);
  download(s+"_website_package.zip",await z.generateAsync({type:"blob"}),"application/zip");warnMissing(missing)}
 catch(e){Object.entries(files).forEach(([n,t],i)=>setTimeout(()=>download(n.replace("/","_"),t,"text/plain"),i*400));alert("ZIP library could not be loaded, so the files were downloaded separately. Create a media/ folder next to them yourself.")}};

map.on("load",init);
