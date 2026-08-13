/* =========================================================================
 * spoiler-log.js:  Spoiler Log viewer + "Automate Map Linking"
 * -------------------------------------------------------------------------
 * Self-contained. Loaded from index.html after app.js. Adds:
 *   • Settings ▸ System ▸ "Spoiler Log" button (opens picker / modal)
 *   • A full-screen-ish modal that renders every section of the log
 *   • Top-bar "Upload New Log" (right) and "Automate Map Linking" (left)
 *   • Automation that clears map.html's chains, writes painting links, and
 *     links every subarea the log's Entrance Randomizer mentions.
 *
 * The log↔map bridge uses loading_zone_dictionary.json (generated from
 * route_edges.csv / rooms.csv / logic_tokens.csv + map.html's ZONE_IMAGES).
 * ========================================================================= */
(function () {
  'use strict';

  // ── localStorage keys ────────────────────────────────────────────────
  var LOG_TEXT_KEY = 'smo_spoiler_log_text';
  var LOG_NAME_KEY = 'smo_spoiler_log_name';
  var DICT_URL     = 'loading_zone_dictionary.json';

  // map.html's storage keys (must stay in sync with map.html) ────────────
  var MAP_STATE_KEY   = 'smo_map_state';
  var MAP_EDGES_KEY   = 'smo_edge_chains';
  var MAP_META_KEY    = 'smo_chain_meta';
  var MAP_SETTINGS    = 'smo_map_settings';

  // map.html's chain colour palette (kept identical so colours look native)
  var CHAIN_COLORS = [
    '#ff6b6b','#ff9f43','#ffd93d','#6bcb77','#4d96ff','#c77dff',
    '#00d2ff','#ff8c69','#b5e550','#f7a8d8','#ff4757','#2ed573',
    '#1e90ff','#eccc68','#ff6348','#7bed9f','#70a1ff','#a29bfe',
    '#fd79a8','#00b894','#0984e3','#e17055','#6c5ce7','#fdcb6e',
    '#55efc4','#fab1a0','#74b9ff','#b2bec3'
  ];

  var PAINTING_KINGDOMS = ['Cascade','Sand','Lake','Wooded','Metro','Snow',
                           'Seaside','Luncheon',"Bowser's",'Mushroom'];

  var SILENT_SKIP = [
    'shiveria town cold room',
    'shiveria town: cold room',
    'rabbit ridge tower topper battle',
    'rabbit ridge tower hariet battle',
    'rabbit ridge tower spewart battle',
    'rabbit ridge tower rango battle'
  ].sort(function (a, b) { return b.length - a.length; });

  // =====================================================================
  //  TODO (manual): override table for log entrances the automatic matching
  //  (kingdom + in-game-name, then map-label fallback) can't resolve. Keys
  //  are a distinctive lowercase SUBSTRING of the entrance name; they're
  //  tested against the whole cleaned token (longest key first), so they work
  //  regardless of the "Kingdom:" / "Deep Woods:" / "Shiveria Town:" prefix in
  //  front of them. Value = a map node id, or '' to mark "intentionally not on
  //  the map" (still counted once in the report). Anything unmatched is
  //  skipped and printed in the run report so you can copy it in here.
  //  For entrances that should never show up in the report at all, add them
  //  to SILENT_SKIP above instead.
  // =====================================================================
  var NODE_OVERRIDES = {
    // Deep Woods shows up on the map as Wooded's "DW …" zones:
    'costume room deep woods':      'zone:Wooded:DW Outfit',      // TODO verify
    'deep woods treasure vault':    'zone:Wooded:DW Treasure',
    'deep woods':                   'zone:Wooded:DW Odyssey',     // TODO: Odyssey vs Pond?
    // Shiveria Town is drawn under Snow Kingdom:
    'shiveria town crazy cap store':'zone:Snow:Shop',
    'shiveria town class a lobby':  '',                           // TODO
    'class s lobby':                'zone:Snow:Iceburn',          // TODO verify
    // Two Mushroom painting bosses the map labels differently:
    'mollusque-lanceur':            'zone:Mushroom:Octopus',      // TODO verify
    'lord of lightning':            'zone:Mushroom:Dragon',       // TODO verify
    // Dark Side Yoshi levels whose map labels differ from log names:
    'yoshi on the sinking island':  'zone:Darkside:Lava Rising',  // TODO verify
    // Darker Side final area:
    'inside culmina crater':        'zone:Darkerside:End'         // TODO (vs kingdom:Darkerside)
    // The *Boss Re-fight rooms, Inverted Pyramid, Underground Ruins/Caverns,
    // Wedding Room, Sky Garden Tower, Secret Flower Field and the vanilla
    // Picture-Match / Underwater-Tunnel rooms have no corresponding map node
    // and are intentionally left out.
  };
  // longest key first so specific keys win over generic ones ("… deep woods
  // treasure vault" before "deep woods")
  var OVERRIDE_KEYS = Object.keys(NODE_OVERRIDES).sort(function (a, b) { return b.length - a.length; });

  // For the 6 backend stages shared by two map nodes, pick a deterministic
  // default when the log can't tell them apart. TODO: adjust if you'd rather
  // the other node win, or split them by the (bar1)/(bar2)/(shop_coin) hint.
  var AMBIGUOUS_DEFAULT = {
    'zone:Metro:Yellow Shop':  'zone:Metro:Yellow Shop',   // Metro Crazy Cap Store
    'zone:Metro:Purple Shop':  'zone:Metro:Yellow Shop',
    'zone:Sand:Shop':          'zone:Sand:Shop',            // Sand Crazy Cap Store
    'zone:Sand:Employees':     'zone:Sand:Shop',
    'zone:Darkside:Lava Rising':'zone:Darkside:Magma Swamp',// "Yoshi's Magma Swamp" -> Magma Swamp
    'zone:Darkside:Magma Swamp':'zone:Darkside:Magma Swamp' // TODO verify
  };

  // ── module state ─────────────────────────────────────────────────────
  var dict = null;             // parsed dictionary
  var nameIndex = null;        // "kingdom\u0000ingamename" -> [map_node]
  var labelIndex = null;       // "kingdom" -> [{label, node}]
  var kingdomList = null;      // kingdom names, longest first
  var sections = [];           // parsed log sections
  var loaded = false;

  // search state
  var searchMatches = [];      // <mark> elements, in DOM order
  var searchIndex = -1;        // index into searchMatches of the "current" hit

  // =====================================================================
  //  Dictionary load + indexes
  // =====================================================================
  function loadDictionary() {
    if (dict) return Promise.resolve(dict);
    return fetch(DICT_URL).then(function (r) {
      if (!r.ok) throw new Error('dict ' + r.status);
      return r.json();
    }).then(function (j) {
      dict = j;
      buildIndexes();
      return dict;
    });
  }

  function buildIndexes() {
    nameIndex = {};
    labelIndex = {};
    var kSet = {};
    dict.zones.forEach(function (z) {
      if (z.kingdom) kSet[z.kingdom] = true;
      if (z.map_node.indexOf('zone:') === 0) {
        var nk = z.kingdom + '\u0000' + (z.in_game_name || '').toLowerCase();
        (nameIndex[nk] = nameIndex[nk] || []).push(z.map_node);
        var label = z.map_node.split(':').slice(2).join(':'); // short label
        (labelIndex[z.kingdom] = labelIndex[z.kingdom] || [])
          .push({ label: label.toLowerCase(), node: z.map_node });
      }
    });
    kingdomList = Object.keys(kSet).sort(function (a, b) { return b.length - a.length; });
  }

  // =====================================================================
  //  Log parsing  (section splitter adapted from the in-game index.js)
  // =====================================================================
  function parseLog(text) {
    var lines = text.split(/\r\n|\r|\n/);
    var header = /^\s*===\s*(.+?)\s*===\s*$/;
    var out = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(header);
      if (m) { cur = { title: m[1], lines: [] }; out.push(cur); }
      else if (cur) { cur.lines.push(lines[i]); }
      else if (lines[i].trim() !== '') {
        if (out.length === 0 || out[0].title !== 'Overview') {
          out.unshift({ title: 'Overview', lines: [] }); cur = out[0];
        }
        cur.lines.push(lines[i]);
      }
    }
    if (out.length === 0) out.push({ title: 'Spoiler Log', lines: lines });
    return out;
  }

  // =====================================================================
  //  Rendering the full log into the modal (all info, scrollable)
  // =====================================================================
  function renderLog() {
    var nav = document.getElementById('sl-nav');
    var body = document.getElementById('sl-body');
    nav.innerHTML = '';
    body.innerHTML = '';
    sections.forEach(function (sec, idx) {
      // nav chip
      var a = document.createElement('button');
      a.className = 'sl-nav-item';
      a.textContent = sec.title;
      a.onclick = function () {
        var el = document.getElementById('sl-sec-' + idx);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      nav.appendChild(a);

      // section block
      var wrap = document.createElement('section');
      wrap.className = 'sl-section';
      wrap.id = 'sl-sec-' + idx;
      var h = document.createElement('h3');
      h.className = 'sl-section-title';
      h.textContent = sec.title;
      wrap.appendChild(h);
      var pre = document.createElement('div');
      pre.className = 'sl-section-lines';
      // keep the log's own formatting/indentation but make it wrap nicely
      pre.textContent = sec.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      wrap.appendChild(pre);
      body.appendChild(wrap);
    });
    var fname = localStorage.getItem(LOG_NAME_KEY) || '';
    var fn = document.getElementById('sl-filename');
    if (fn) fn.textContent = fname;

    // a fresh render means fresh DOM nodes; drop stale search state/input
    searchMatches = [];
    searchIndex = -1;
    var si = document.getElementById('sl-search-input');
    if (si) si.value = '';
    var scnt = document.getElementById('sl-search-count');
    if (scnt) scnt.textContent = '';
  }

  // =====================================================================
  //  Search
  // =====================================================================
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Highlights every case-insensitive occurrence of `query` in `raw`,
  // returning escaped HTML with matches wrapped in <mark class="sl-hit">.
  function highlightText(raw, query) {
    var reSafe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp(reSafe, 'gi');
    var out = '', lastIndex = 0, m, count = 0;
    while ((m = re.exec(raw)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }   // guard against empty matches
      out += escapeHtml(raw.slice(lastIndex, m.index));
      out += '<mark class="sl-hit">' + escapeHtml(m[0]) + '</mark>';
      lastIndex = m.index + m[0].length;
      count++;
    }
    out += escapeHtml(raw.slice(lastIndex));
    return { html: out, count: count };
  }

  // Re-renders every section's text with (or without) highlights, dims nav
  // chips for sections with zero hits, and rebuilds the match list.
  function applySearch(query) {
    var body = document.getElementById('sl-body');
    if (!body) return;
    var pres = body.querySelectorAll('.sl-section-lines');
    var navItems = document.querySelectorAll('.sl-nav-item');
    var q = query.trim();

    pres.forEach(function (pre, idx) {
      // cache the original text once, so repeated searches never re-derive
      // it from already-highlighted markup
      if (!pre.hasAttribute('data-raw')) pre.setAttribute('data-raw', pre.textContent);
      var raw = pre.getAttribute('data-raw');

      if (!q) {
        pre.innerHTML = escapeHtml(raw);
        if (navItems[idx]) navItems[idx].classList.remove('sl-nav-dim');
        return;
      }
      var res = highlightText(raw, q);
      pre.innerHTML = res.html;
      if (navItems[idx]) navItems[idx].classList.toggle('sl-nav-dim', res.count === 0);
    });

    searchMatches = Array.prototype.slice.call(body.querySelectorAll('mark.sl-hit'));
    searchIndex = searchMatches.length ? 0 : -1;
    updateSearchCount();
    if (searchIndex >= 0) goToMatch(searchIndex, true);
  }

  function updateSearchCount() {
    var countEl = document.getElementById('sl-search-count');
    var input = document.getElementById('sl-search-input');
    if (!countEl) return;
    if (!searchMatches.length) {
      countEl.textContent = (input && input.value.trim()) ? '0/0' : '';
    } else {
      countEl.textContent = (searchIndex + 1) + '/' + searchMatches.length;
    }
  }

  function goToMatch(i, skipScroll) {
    if (!searchMatches.length) return;
    searchMatches.forEach(function (m) { m.classList.remove('sl-hit-current'); });
    searchIndex = ((i % searchMatches.length) + searchMatches.length) % searchMatches.length;
    var mark = searchMatches[searchIndex];
    mark.classList.add('sl-hit-current');
    if (!skipScroll) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateSearchCount();
  }

  function nextMatch() { if (searchMatches.length) goToMatch(searchIndex + 1); }
  function prevMatch() { if (searchMatches.length) goToMatch(searchIndex - 1); }

  function wireSearch() {
    var input = document.getElementById('sl-search-input');
    var prevBtn = document.getElementById('sl-search-prev');
    var nextBtn = document.getElementById('sl-search-next');
    var clearBtn = document.getElementById('sl-search-clear');
    if (!input || input._slWired) return;
    input._slWired = true;

    input.addEventListener('input', function (e) { applySearch(e.target.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) prevMatch(); else nextMatch();
      } else if (e.key === 'Escape') {
        input.value = '';
        applySearch('');
        input.blur();
      }
    });
    prevBtn.addEventListener('click', prevMatch);
    nextBtn.addEventListener('click', nextMatch);
    clearBtn.addEventListener('click', function () {
      input.value = '';
      applySearch('');
      input.focus();
    });
  }

  // =====================================================================
  //  Modal open / close, persistence, file picking
  // =====================================================================
  function haveStoredLog() { return !!localStorage.getItem(LOG_TEXT_KEY); }

  function ensureModal() { return document.getElementById('sl-modal'); }

  function openModal() {
    var modal = ensureModal();
    if (!modal) return;
    if (!loaded && haveStoredLog()) {
      sections = parseLog(localStorage.getItem(LOG_TEXT_KEY));
      loaded = true;
    }
    if (loaded) renderLog();
    modal.classList.remove('hidden');
    loadDictionary().catch(function () {/* surfaced later on automate */});
  }

  function closeModal() {
    var modal = ensureModal();
    if (modal) modal.classList.add('hidden');
  }

  function pickFile() {
    var input = document.getElementById('sl-file-input');
    if (input) { input.value = ''; input.click(); }
  }

  function onFileChosen(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var text = e.target.result;
      try {
        localStorage.setItem(LOG_TEXT_KEY, text);
        localStorage.setItem(LOG_NAME_KEY, file.name);
      } catch (err) {
        alert('This log is too large to store in the browser, but it will be '
            + 'shown for this session.');
      }
      sections = parseLog(text);
      loaded = true;
      renderLog();
      openModal();
    };
    reader.onerror = function () {
      alert('Could not read that file. Please pick a plain-text (.txt) spoiler log.');
    };
    reader.readAsText(file);
  }

  // "Spoiler Log" settings button: if we already have a log, just open the
  // modal; otherwise ask for the file first (then the modal opens itself).
  function onSpoilerSettingsClick() {
    if (haveStoredLog()) openModal();
    else pickFile();
  }

  // =====================================================================
  //  Log-area → map-node resolution
  // =====================================================================
  function cleanToken(tok) {
    tok = tok.replace(/\s*\[[^\]]*\]\s*$/, '');   // strip trailing [tag]
    tok = tok.replace(/\s*\([^)]*\)\s*$/, '');    // strip trailing (qualifier)
    return tok.trim();
  }

  // Returns { kingdom, area } or null. `ctxKingdom` is the section header the
  // line lives under, used when the token itself lacks a kingdom prefix.
  function splitKingdomArea(tok, ctxKingdom) {
    var t = cleanToken(tok);
    for (var i = 0; i < kingdomList.length; i++) {
      var k = kingdomList[i];
      if (t === k) return { kingdom: k, area: '' };
      if (t.indexOf(k + ':') === 0) return { kingdom: k, area: t.slice(k.length + 1).trim() };
      if (t.indexOf(k + ' ') === 0) return { kingdom: k, area: t.slice(k.length + 1).trim() };
    }
    // no kingdom prefix fall back to the section context kingdom
    return { kingdom: ctxKingdom || null, area: t };
  }

  function stripSuffix(area) {
    return area.replace(/\s+(Entrance|Exit)$/i, '').trim();
  }

  // Resolve a single log node token to a map node id, or null. Records misses.
  function resolveNode(tok, ctxKingdom, report) {
    var cleaned = stripSuffix(cleanToken(tok));      // full string, prefix included
    // normalise for override matching: drop ':' so "Town: Cold Room" == "Town Cold Room"
    var lc = cleaned.toLowerCase().replace(/:/g, ' ').replace(/\s+/g, ' ').trim();

    // 0) fully silent skips: confirmed not on the map, nothing to fix, so
    // never logged in the report at all
    for (var s = 0; s < SILENT_SKIP.length; s++) {
      if (lc.indexOf(SILENT_SKIP[s]) !== -1) return null;
    }

    // 1) substring overrides (longest key first) robust to sub-area prefixes
    for (var k = 0; k < OVERRIDE_KEYS.length; k++) {
      if (lc.indexOf(OVERRIDE_KEYS[k]) !== -1) {
        var ov = NODE_OVERRIDES[OVERRIDE_KEYS[k]];
        if (ov === '') { report.unmapped[cleaned] = (report.unmapped[cleaned] || 0) + 1; return null; }
        return ov;
      }
    }

    // 2) kingdom + area
    var ka = splitKingdomArea(tok, ctxKingdom);
    if (!ka || !ka.kingdom) { report.unmapped[cleaned] = (report.unmapped[cleaned] || 0) + 1; return null; }
    var area = stripSuffix(ka.area);
    if (area === '') return kingdomNodeFor(ka.kingdom);      // bare kingdom door

    // primary: (kingdom, in-game name)
    var hit = nameIndex[ka.kingdom + '\u0000' + area.toLowerCase()];
    if (hit && hit.length) return disambiguate(hit);

    // fallback: match on the map's short label appearing in the area string
    var labels = labelIndex[ka.kingdom] || [];
    var alc = area.toLowerCase();
    var best = null;
    for (var i = 0; i < labels.length; i++) {
      if (alc === labels[i].label || alc.indexOf(labels[i].label) !== -1) {
        if (!best || labels[i].label.length > best.label.length) best = labels[i];
      }
    }
    if (best) return best.node;

    report.unmapped[ka.kingdom + '::' + area] = (report.unmapped[ka.kingdom + '::' + area] || 0) + 1;
    return null;
  }

  function disambiguate(nodes) {
    if (nodes.length === 1) return nodes[0];
    for (var i = 0; i < nodes.length; i++) {
      if (AMBIGUOUS_DEFAULT[nodes[i]]) return AMBIGUOUS_DEFAULT[nodes[i]];
    }
    return nodes[0];
  }

  function kingdomNodeFor(kingdom) {
    // dictionary kingdom -> map short key (kingdom:Xxx)
    for (var i = 0; i < dict.zones.length; i++) {
      var z = dict.zones[i];
      if (z.kingdom === kingdom && z.map_node.indexOf('kingdom:') === 0) return z.map_node;
    }
    return null;
  }

  // =====================================================================
  //  Automation: build map state from the log and write it out
  // =====================================================================
  function ekey(src, sPart, tgt, tPart) { return src + '@' + sPart + '\u2192' + tgt + '@' + tPart; }

  function automateMapLinking() {
    if (!dict) {
      alert('Loading-zone dictionary not loaded yet. Make sure '
          + 'loading_zone_dictionary.json is present next to the page, then try again.');
      return;
    }
    var text = localStorage.getItem(LOG_TEXT_KEY);
    if (!text) { alert('No spoiler log loaded.'); return; }

    var report = { unmapped: {}, vanillaSkipped: 0, lines: 0, edges: 0, paintings: 0 };
    var lines = text.split(/\r\n|\r|\n/);

    var edgeList = [];
    var edgeChains = {};
    var chainColors = {};
    var nextChainId = 0;
    var seenEdge = {};   // ekey -> true, so identical links aren't duplicated

    function pickColor() {
      var used = {}; Object.keys(chainColors).forEach(function (k) { used[chainColors[k]] = 1; });
      var avail = CHAIN_COLORS.filter(function (c) { return !used[c]; });
      var pool = avail.length ? avail : CHAIN_COLORS;
      return pool[Math.floor(Math.random() * pool.length)];
    }
    // Returns true if a NEW edge was added, false if it was a duplicate.
    function addEdge(src, sPart, tgt, tPart, cid) {
      if (src === tgt) return false;                 // no self-links from a hop
      var k = ekey(src, sPart, tgt, tPart);
      if (seenEdge[k]) return false;                 // already have this exact link
      seenEdge[k] = true;
      edgeList.push({ src: src, sPart: sPart, tgt: tgt, tPart: tPart });
      edgeChains[k] = cid;
      report.edges++;
      return true;
    }

    // ---- Entrance Randomizer ------------------------------------------
    var inER = false, ctxKingdom = null;
    for (var li = 0; li < lines.length; li++) {
      var raw = lines[li];
      if (/^===\s*Entrance Randomizer/.test(raw)) { inER = true; continue; }
      if (inER && /^===/.test(raw)) break;
      if (!inER) continue;

      // section sub-header e.g. "Cap Kingdom:" or "Deep Woods:"
      var hdr = raw.match(/^(\S.*?):\s*$/);
      if (hdr && raw.indexOf('->') === -1) { ctxKingdom = hdr[1].trim(); continue; }
      if (!/^\s+\S/.test(raw) || raw.indexOf('->') === -1) continue;

      // Default #3: skip [vanilla] lines entirely
      if (/\[vanilla\]/i.test(raw)) { report.vanillaSkipped++; continue; }
      report.lines++;

      var toks = raw.trim().split(/\s*->\s*/);
      var resolved = toks.map(function (t, idx) {
        // first token's kingdom usually explicit; hops carry their own kingdom
        return resolveNode(t, ctxKingdom, report);
      });

      // Build the chain, skipping unresolved nodes but keeping resolved
      // neighbours connected (Default #1). Segments per your spec:
      //   first node exits from 'mid' (the door you go through),
      //   later nodes exit from 'out', every arrival lands on 'in'.
      var cid = nextChainId++;
      chainColors[cid] = pickColor();
      var prev = null, firstDone = false, added = 0;
      for (var n = 0; n < resolved.length; n++) {
        var node = resolved[n];
        if (!node) { continue; }
        if (prev) {
          var sPart = firstDone ? 'out' : 'mid';   // first hop leaves via the door ('mid')
          // paintings/kingdom nodes ignore parts in map.html; still fine.
          if (addEdge(prev, sPart, node, 'in', cid)) added++;
          firstDone = true;
        }
        prev = node;
      }
      // if this line added no new links (all duplicates / unmapped), reclaim id
      if (added === 0) { delete chainColors[cid]; nextChainId--; }
    }

    // ---- Painting Links ------------------------------------------------
    var inPL = false;
    for (var pj = 0; pj < lines.length; pj++) {
      var pr = lines[pj];
      if (/^===\s*Painting Links/.test(pr)) { inPL = true; continue; }
      if (inPL && /^===/.test(pr)) break;
      if (!inPL) continue;
      var pm = pr.match(/^\s*(.+?)\s*<->\s*(.+?)\s*$/);
      if (!pm) continue;
      var a = paintingNode(pm[1]);
      var b = paintingNode(pm[2]);
      if (!a || !b) { continue; }
      var pcid = nextChainId++;
      chainColors[pcid] = pickColor();
      // one-directional only: A -> B. No reciprocal B -> A edge is drawn,
      // so the map won't show a closed loop for painting links.
      var pa = addEdge(a, 'mid', b, 'in', pcid);
      if (pa) report.paintings++;
      else { delete chainColors[pcid]; nextChainId--; }
    }

    // ---- write map state (Default #7: clear first, then our links) -----
    try {
      localStorage.setItem(MAP_STATE_KEY, JSON.stringify({ outgoing: {}, marks: {}, edgeList: edgeList }));
      localStorage.setItem(MAP_EDGES_KEY, JSON.stringify(edgeChains));
      localStorage.setItem(MAP_META_KEY, JSON.stringify({ nextChainId: nextChainId, colors: chainColors }));
      // ensure the painting cluster is visible so painting links render
      if (report.paintings > 0) {
        var s = {};
        try { s = JSON.parse(localStorage.getItem(MAP_SETTINGS) || '{}'); } catch (e) {}
        s.paintingTracker = true;
        localStorage.setItem(MAP_SETTINGS, JSON.stringify(s));
      }
    } catch (err) {
      alert('Could not write the map state to storage: ' + err.message);
      return;
    }

    reloadMapViews();
    showReport(report);
  }

  function paintingNode(side) {
    // "Cascade Kingdom (WaterfallWorldHomeStage::…)" -> zone:Paintings:Cascade
    var name = side.replace(/\s*\(.*$/, '').replace(/\s*\[.*$/, '').trim();
    var label = name.replace(/\s+Kingdom$/, '').trim();
    if (PAINTING_KINGDOMS.indexOf(label) !== -1) return 'zone:Paintings:' + label;
    return null;
  }

  function reloadMapViews() {
    // Reload any embedded map.html iframe (same-origin) so it re-reads storage.
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      var src = frames[i].getAttribute('src') || '';
      if (src.indexOf('map.html') !== -1) {
        try { frames[i].contentWindow.location.reload(); } catch (e) {}
      }
    }
  }

  function showReport(r) {
    var unmapped = Object.keys(r.unmapped);
    var msg = 'Map linking complete.\n\n'
      + '• ' + r.lines + ' entrance lines processed\n'
      + '• ' + r.edges + ' subarea links drawn\n'
      + '• ' + r.paintings + ' painting links drawn\n'
      + '• ' + r.vanillaSkipped + ' [vanilla] lines skipped\n';
    if (unmapped.length) {
      msg += '\n' + unmapped.length + ' entrance name(s) had no map node and were skipped:\n  '
           + unmapped.slice(0, 25).join('\n  ')
           + (unmapped.length > 25 ? '\n  …and ' + (unmapped.length - 25) + ' more' : '')
           + '\n\n(Add these to NODE_OVERRIDES in spoiler-log.js to include them.)';
    }
    alert(msg);
  }

  function confirmAutomate() {
    if (confirm('This will ERASE all existing chains in the Connection Map and '
              + 'replace them with the links from the current spoiler log.\n\n'
              + 'This cannot be undone. Continue?')) {
      automateMapLinking();
    }
  }

  // =====================================================================
  //  DOM injection (settings button + modal) and wiring
  // =====================================================================
  function injectSettingsButton() {
    var btn = document.getElementById('btn-spoiler-log');
    var input = document.getElementById('sl-file-input');
    // Fallback: if the markup isn't in index.html, create it as the last
    // option in the System panel.
    if (!btn) {
      var panel = document.querySelector('.settings-panel[data-panel="system"]');
      if (!panel) return;
      btn = document.createElement('button');
      btn.className = 'sys-btn sys-btn-gray-yellow';
      btn.id = 'btn-spoiler-log';
      btn.textContent = 'Spoiler Log';
      panel.appendChild(btn);
    }
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,text/plain';
      input.id = 'sl-file-input';
      input.hidden = true;
      (btn.parentNode || document.body).appendChild(input);
    }
    if (!btn._slWired) {
      btn.addEventListener('click', onSpoilerSettingsClick);
      btn._slWired = true;
    }
    if (!input._slWired) {
      input.addEventListener('change', function (e) { onFileChosen(e.target.files[0]); });
      input._slWired = true;
    }
  }

  function injectModal() {
    if (document.getElementById('sl-modal')) return;
    var modal = document.createElement('div');
    modal.id = 'sl-modal';
    modal.className = 'sl-modal-backdrop hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Spoiler Log');
    modal.innerHTML =
      '<div class="sl-modal-box">' +
        '<div class="sl-topbar">' +
          '<button class="sl-topbtn sl-topbtn-left" id="sl-automate">Automate Map Linking</button>' +
          '<div class="sl-title"><span>Spoiler Log</span>' +
            '<span class="sl-filename" id="sl-filename"></span></div>' +
          '<div class="sl-topright">' +
            '<button class="sl-topbtn sl-topbtn-right" id="sl-upload">Upload New Log</button>' +
            '<button class="sl-close" id="sl-close" aria-label="Close">\u2715</button>' +
          '</div>' +
        '</div>' +
        '<div class="sl-searchbar">' +
          '<input type="text" id="sl-search-input" class="sl-search-input" placeholder="Search log\u2026" autocomplete="off">' +
          '<span class="sl-search-count" id="sl-search-count"></span>' +
          '<button class="sl-search-btn" id="sl-search-prev" title="Previous match (Shift+Enter)">\u25b2</button>' +
          '<button class="sl-search-btn" id="sl-search-next" title="Next match (Enter)">\u25bc</button>' +
          '<button class="sl-search-btn" id="sl-search-clear" title="Clear search">\u2715</button>' +
        '</div>' +
        '<div class="sl-content">' +
          '<nav class="sl-nav" id="sl-nav"></nav>' +
          '<div class="sl-body" id="sl-body"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    document.getElementById('sl-close').addEventListener('click', closeModal);
    document.getElementById('sl-upload').addEventListener('click', pickFile);
    document.getElementById('sl-automate').addEventListener('click', confirmAutomate);
    wireSearch();
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    });
  }

  function init() {
    injectModal();
    injectSettingsButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // expose a tiny hook for debugging / re-injection if the settings modal
  // is rebuilt dynamically
  window.SpoilerLog = { open: openModal, automate: confirmAutomate, reinit: init };
})();