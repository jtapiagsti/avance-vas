/* =========================================================
 *  CONFIGURACIÓN — cambia aquí la URL y el título
 * ========================================================= */
const CONFIG = {
  // Título que aparece en el encabezado (y en la pestaña).
  // Déjalo vacío ('') para usar el título que está escrito sobre la tabla en la hoja.
  title: 'Avance VAS',

  // URL del CSV. Acepta:
  //  - CSV publicado:  https://docs.google.com/spreadsheets/d/e/XXXX/pub?gid=0&single=true&output=csv
  //  - Enlace normal de la hoja (/edit?...#gid=...): se convierte solo a /export?format=csv
  //    (requiere que la hoja esté compartida como "Cualquier persona con el enlace").
  csvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS6N4bpo-a3FLFLWrDYMkBFrbUqXbpezgoOYf8w5yvUUKgLK0SaJGkF1Rob4aT4cWUCWLqH-XPHOEG2/pub?output=csv',

  // Enlace de EDICIÓN de la hoja (el que ves al abrirla en el navegador: .../d/XXXX/edit).
  // El botón ✏️ solo aparece en modo editor. La seguridad la da Google: solo tu cuenta puede editar.
  editUrl: 'https://docs.google.com/spreadsheets/d/1V0ZY1iTSO9pM0argyHjlWao1xteNBV5ZKv66B2X9LWk/edit?gid=755753427#gid=755753427',

  // SHA-256 de tu clave de editor. El modo editor se activa abriendo la app con ?editor=TU_CLAVE
  // (o tocando 5 veces el título y pegando la clave). Se desactiva con ?editor=off.
  // Para cambiar la clave: calcula el SHA-256 de la nueva y pégalo aquí.
  editorKeyHash: '98caa1e17a52d028a125422a826fc312a48160ea6a41b1e4e029de2cae21069c',

  // En el teléfono, agrupar las tarjetas por la primera columna cuando ésta se repite
  // (p. ej. una tarjeta por grúa con sus calles). false = una tarjeta por fila.
  groupCardsByFirstColumn: true,

  // Al volver a la app, recargar si pasaron al menos estos segundos desde la última carga.
  refreshOnReturnAfterSec: 30,
};

/* ========================================================= */

const STORAGE_KEY = 'sheet-dashboard:last';

const $ = (sel) => document.querySelector(sel);
const els = {
  title: $('#title'),
  updated: $('#updated'),
  refreshBtn: $('#refreshBtn'),
  editBtn: $('#editBtn'),
  search: $('#search'),
  sortSelect: $('#sortSelect'),
  sortDirBtn: $('#sortDirBtn'),
  banner: $('#banner'),
  count: $('#count'),
  summary: $('#summary'),
  content: $('#content'),
  ptr: $('#ptr'),
};

const state = {
  headers: [],      // nombres de columna
  rows: [],         // arrays de strings
  summaries: [],    // bloques "etiqueta: valor" a la derecha de la tabla
  numericCols: [],  // booleano por columna
  parsedNums: [],   // valores numéricos por fila/columna (o null)
  sortCol: -1,
  sortDir: 1,       // 1 asc, -1 desc
  query: '',
  loading: false,
  lastLoadedAt: 0,
};

/* ---------- Utilidades ---------- */

// Convierte un enlace de Google Sheets en una URL de descarga CSV.
function toCsvUrl(url) {
  try {
    const u = new URL(url);
    if (!/docs\.google\.com$/.test(u.hostname)) return url;
    // Publicado en la web: /spreadsheets/d/e/<id>/pubhtml -> pub?output=csv
    if (/\/spreadsheets\/d\/e\//.test(u.pathname)) {
      if (u.searchParams.get('output') === 'csv') return url;
      u.pathname = u.pathname.replace(/\/pubhtml$|\/pub$/, '/pub');
      u.searchParams.set('output', 'csv');
      return u.toString();
    }
    const m = u.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
    if (m && !/\/export$|\/gviz\//.test(u.pathname)) {
      const gid = u.searchParams.get('gid') || (u.hash.match(/gid=(\d+)/) || [])[1] || '0';
      return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
    }
  } catch (_) { /* URL relativa u otra: se usa tal cual */ }
  return url;
}

function withCacheBuster(url) {
  return url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
}

// Normaliza texto para búsqueda: minúsculas y sin tildes.
function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Intenta interpretar un texto como número. Devuelve {n, pre, suf} o null.
// Soporta: 1234567 · 1.234.567 · 1.234,56 · 12,5 · 1,234.56 · 12.5 · $ 1.000 · 45%
function parseNumber(raw) {
  let s = String(raw).trim();
  if (!s) return null;
  let pre = '', suf = '';
  const preM = s.match(/^(-?)\s*(\$|US\$|CLP\$?|UF)\s*/i);
  if (preM) { pre = preM[2] + (preM[2] === '$' ? '' : ' '); s = preM[1] + s.slice(preM[0].length); }
  if (s.endsWith('%')) { suf = '%'; s = s.slice(0, -1).trim(); }
  s = s.replace(/\s/g, '');
  let n;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) n = +s.replace(/\./g, '').replace(',', '.'); // 1.234.567,89
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) n = +s.replace(/,/g, '');               // 1,234,567.89
  else if (/^-?\d+,\d+$/.test(s)) n = +s.replace(',', '.');                                 // 12,5
  else if (/^-?\d+(\.\d+)?$/.test(s)) n = +s;                                               // 1234.5
  else return null;
  return Number.isFinite(n) ? { n, pre, suf } : null;
}

// Formato chileno: miles con punto, decimales con coma (1.234.567,5).
function formatCL(n) {
  const neg = n < 0;
  const abs = Math.abs(n);
  const decimals = Number.isInteger(abs) ? 0 : Math.min(2, (String(abs).split('.')[1] || '').length);
  const [int, dec] = abs.toFixed(decimals).split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + intFmt + (dec ? ',' + dec : '');
}

function formatTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `hoy ${time}`;
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + time;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Procesamiento del CSV ---------- */

function processCsv(text) {
  const result = Papa.parse(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
  const data = result.data;
  if (!data.length) throw new Error('El CSV está vacío.');

  // Normaliza el ancho de todas las filas.
  const width = Math.max(...data.map((r) => r.length));
  const grid = data.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').toString().trim()));

  // Fila de encabezados: la primera fila "llena" (≥ la mitad de celdas de la fila más llena).
  // Así se saltan títulos o instrucciones que haya sobre la tabla.
  const filled = grid.map((r) => r.filter((v) => v !== '').length);
  const minFilled = Math.max(2, Math.ceil(Math.max(...filled) * 0.5));
  let hdr = filled.findIndex((n) => n >= minFilled);
  if (hdr < 0) hdr = 0;
  const sheetTitle = grid.slice(0, hdr).flat().find((v) => v !== '') || '';
  const allHeaders = grid[hdr];
  const body = grid.slice(hdr + 1);

  // Columnas totalmente vacías actúan como separadores: dividen la hoja en bloques.
  const emptyCol = allHeaders.map((h, c) => h === '' && body.every((r) => r[c] === ''));
  const blocks = [];
  let cur = null;
  emptyCol.forEach((isEmpty, c) => {
    if (isEmpty) { cur = null; return; }
    if (!cur) blocks.push(cur = []);
    cur.push(c);
  });
  if (!blocks.length) throw new Error('El CSV no tiene datos.');

  // Primer bloque = tabla principal. Bloques de 2 columnas a la derecha = resumen (etiqueta: valor).
  let mainCols = blocks[0];
  const summaries = [];
  for (const b of blocks.slice(1)) {
    if (b.length === 2) {
      const items = body
        .filter((r) => r[b[0]] !== '' || r[b[1]] !== '')
        .map((r) => ({ label: r[b[0]], value: r[b[1]] }));
      if (items.length) summaries.push({ title: allHeaders[b[0]] || allHeaders[b[1]], items });
    } else {
      mainCols = mainCols.concat(b);
    }
  }

  let headers = mainCols.map((c) => allHeaders[c]);
  const rows = body.map((r) => mainCols.map((c) => r[c])).filter((r) => r.some((v) => v !== ''));

  const seen = {};
  headers = headers.map((h, i) => {
    let name = h || `Columna ${i + 1}`;
    if (seen[name]) name = `${name} (${++seen[name]})`; else seen[name] = 1;
    return name;
  });

  // Detecta columnas numéricas: todos los valores no vacíos son números.
  const parsedNums = rows.map((r) => r.map(parseNumber));
  const numericCols = headers.map((_, c) => {
    let any = false;
    for (let r = 0; r < rows.length; r++) {
      if (rows[r][c] === '') continue;
      if (!parsedNums[r][c]) return false;
      any = true;
    }
    return any;
  });

  return { headers, rows, numericCols, parsedNums, summaries, sheetTitle };
}

/* ---------- Carga de datos ---------- */

async function loadData({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  els.refreshBtn.disabled = true;
  els.refreshBtn.classList.add('spinning');
  if (!silent && !state.rows.length) showLoading();

  try {
    if (!navigator.onLine) throw Object.assign(new Error('offline'), { offline: true });

    const res = await fetch(withCacheBuster(toCsvUrl(CONFIG.csvUrl)), {
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(res.status === 401 || res.status === 403
        ? 'La hoja no es pública. Compártela como "Cualquier persona con el enlace" o publícala como CSV.'
        : `El servidor respondió ${res.status}.`);
    }
    const text = await res.text();
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/html') || /^\s*<(!doctype|html)/i.test(text)) {
      throw new Error('Se recibió una página web en vez de un CSV. Revisa que la hoja esté publicada/compartida y que la URL sea la del CSV.');
    }

    const parsed = processCsv(text);
    const now = Date.now();
    applyData(parsed, now);
    hideBanner();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ csv: text, ts: now })); } catch (_) { /* almacenamiento lleno o bloqueado */ }
  } catch (err) {
    console.error(err);
    const offline = err.offline || !navigator.onLine;
    const msg = err instanceof TypeError
      ? 'No se pudo acceder al CSV. Revisa tu conexión y que la hoja esté publicada o compartida como "Cualquier persona con el enlace".'
      : err.message;
    handleLoadError(offline, msg);
  } finally {
    state.loading = false;
    els.refreshBtn.disabled = false;
    els.refreshBtn.classList.remove('spinning');
  }
}

function handleLoadError(offline, message) {
  // Si ya hay datos en pantalla, se mantienen y solo se avisa.
  if (state.rows.length) {
    showBanner(offline
      ? `Sin conexión. Mostrando datos de ${formatTime(state.lastLoadedAt)}`
      : `No se pudo actualizar: ${message} Mostrando datos de ${formatTime(state.lastLoadedAt)}`,
      offline ? 'warn' : 'error');
    return;
  }
  // Si no, intenta con la última carga guardada.
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { /* ignore */ }
  if (cached && cached.csv) {
    try {
      applyData(processCsv(cached.csv), cached.ts);
      showBanner(offline
        ? `Sin conexión. Mostrando datos guardados de ${formatTime(cached.ts)}`
        : `No se pudo cargar el CSV (${message}). Mostrando datos guardados de ${formatTime(cached.ts)}`,
        offline ? 'warn' : 'error');
      return;
    } catch (_) { /* caché corrupta */ }
  }
  els.updated.textContent = 'Sin datos';
  els.count.textContent = '';
  els.content.innerHTML = `
    <div class="error-box">
      <h2>${offline ? 'Sin conexión' : 'No se pudieron cargar los datos'}</h2>
      <p>${escapeHtml(offline ? 'Conéctate a internet y toca "Actualizar".' : message)}</p>
    </div>`;
}

function applyData(parsed, ts) {
  const prevHeaders = state.headers.join('\u0001');
  Object.assign(state, parsed, { lastLoadedAt: ts });
  if (prevHeaders !== parsed.headers.join('\u0001')) {
    state.sortCol = -1;
    state.sortDir = 1;
    buildSortSelect();
  }
  els.updated.textContent = `Actualizado ${formatTime(ts)}`;
  if (!CONFIG.title && parsed.sheetTitle) {
    els.title.textContent = document.title = parsed.sheetTitle;
  }
  renderSummary();
  render();
}

// Formatea un valor suelto (números estilo Chile, resto tal cual).
function formatValue(raw) {
  const p = parseNumber(raw);
  return p ? p.pre + formatCL(p.n) + p.suf : raw;
}

function renderSummary() {
  const html = state.summaries.map((s) => `
    <section class="summary">
      ${s.title ? `<h2>${escapeHtml(s.title)}</h2>` : ''}
      <div class="tiles">
        ${s.items.map((it) => `
          <div class="tile">
            <div class="tile-value">${escapeHtml(formatValue(it.value) || '—')}</div>
            <div class="tile-label">${escapeHtml(it.label)}</div>
          </div>`).join('')}
      </div>
    </section>`).join('');
  els.summary.innerHTML = html;
  els.summary.hidden = !html;
}

/* ---------- Render ---------- */

function showLoading() {
  els.content.innerHTML = '<div class="loading"><div class="spinner"></div><p>Cargando datos…</p></div>';
}

function showBanner(msg, kind) {
  els.banner.textContent = msg;
  els.banner.className = `banner ${kind}`;
  els.banner.hidden = false;
}
function hideBanner() { els.banner.hidden = true; }

function getVisibleRows() {
  const q = norm(state.query.trim());
  let idx = state.rows.map((_, i) => i);
  if (q) {
    const terms = q.split(/\s+/);
    idx = idx.filter((i) => {
      const hay = norm(state.rows[i].join(' \u0001 '));
      return terms.every((t) => hay.includes(t));
    });
  }
  if (state.sortCol >= 0) {
    const c = state.sortCol;
    const dir = state.sortDir;
    const isNum = state.numericCols[c];
    const coll = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
    idx.sort((a, b) => {
      const va = state.rows[a][c], vb = state.rows[b][c];
      // Vacíos siempre al final
      if (va === '' && vb === '') return a - b;
      if (va === '') return 1;
      if (vb === '') return -1;
      const r = isNum ? state.parsedNums[a][c].n - state.parsedNums[b][c].n : coll.compare(va, vb);
      return (r * dir) || (a - b);
    });
  }
  return idx;
}

function cellHtml(r, c) {
  const raw = state.rows[r][c];
  if (raw === '') return '<span>—</span>';
  if (state.numericCols[c]) {
    const p = state.parsedNums[r][c];
    return `<span>${escapeHtml(p.pre + formatCL(p.n) + p.suf)}</span>`;
  }
  if (/^(ok|sí|si|listo|✓|✔)$/i.test(raw)) return `<span><b class="badge-ok">${escapeHtml(raw)}</b></span>`;
  return `<span>${escapeHtml(raw)}</span>`;
}

function render() {
  const { headers, numericCols } = state;
  if (!headers.length) return;
  const visible = getVisibleRows();

  els.count.textContent = state.query
    ? `${visible.length} de ${state.rows.length} filas`
    : `${state.rows.length} filas`;

  if (!visible.length) {
    els.content.innerHTML = `<div class="empty">${state.rows.length ? 'Sin resultados para la búsqueda.' : 'La hoja no tiene filas de datos.'}</div>`;
    return;
  }

  const thead = headers.map((h, c) => {
    const arrow = state.sortCol === c ? (state.sortDir === 1 ? '▲' : '▼') : '';
    const aria = state.sortCol === c ? (state.sortDir === 1 ? 'ascending' : 'descending') : 'none';
    return `<th data-col="${c}" class="${numericCols[c] ? 'num' : ''}" aria-sort="${aria}" tabindex="0">${escapeHtml(h)} <span class="arrow">${arrow}</span></th>`;
  }).join('');

  const labels = headers.map(escapeHtml);
  const tbody = visible.map((r) =>
    '<tr>' + headers.map((_, c) => {
      const cls = [numericCols[c] ? 'num' : '', c === 0 ? 'first' : '', state.rows[r][c] === '' ? 'empty-cell' : ''].join(' ').trim();
      return `<td data-label="${labels[c]}" class="${cls}">${cellHtml(r, c)}</td>`;
    }).join('') + '</tr>'
  ).join('');

  const groups = CONFIG.groupCardsByFirstColumn ? groupedHtml(visible) : '';
  els.content.innerHTML =
    `<div class="table-wrap${groups ? ' has-groups' : ''}"><table class="data"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>` +
    groups;
}

/* Vista agrupada para móvil: una tarjeta por cada valor de la primera columna (p. ej. cada grúa).
 * - Columnas con un solo valor por grupo (p. ej. AVANCE) van en el encabezado de la tarjeta.
 * - El resto se muestra como mini-tabla dentro de la tarjeta.
 * Devuelve '' si la primera columna no se repite (no tiene sentido agrupar). */
function groupedHtml(visible) {
  const { headers, rows, numericCols } = state;
  if (headers.length < 3) return '';

  const allGroups = new Map();
  rows.forEach((r, i) => {
    const k = r[0];
    if (!allGroups.has(k)) allGroups.set(k, []);
    allGroups.get(k).push(i);
  });
  if (allGroups.size === rows.length || allGroups.has('')) return '';

  // Columna "de grupo" = en todos los grupos, el único valor está en la primera fila del grupo
  // (típico de celdas combinadas, como un % de avance por equipo).
  const groupLevel = headers.map((_, c) => c !== 0 && [...allGroups.values()].every((idx) =>
    idx.slice(1).every((i) => rows[i][c] === '')));
  const detailCols = headers.map((_, c) => c).filter((c) => c !== 0 && !groupLevel[c]);
  const headerCols = headers.map((_, c) => c).filter((c) => groupLevel[c]);
  if (!detailCols.length) return '';

  // Orden de los grupos = orden en que aparecen en la lista visible (respeta búsqueda y orden).
  const order = [];
  const visibleByGroup = new Map();
  for (const i of visible) {
    const k = rows[i][0];
    if (!visibleByGroup.has(k)) { visibleByGroup.set(k, []); order.push(k); }
    visibleByGroup.get(k).push(i);
  }

  const cards = order.map((k) => {
    const all = allGroups.get(k);
    const meta = headerCols.map((c) => {
      const i = all.find((j) => rows[j][c] !== '');
      if (i === undefined) return '';
      return `<span class="g-meta"><span class="g-meta-label">${escapeHtml(headers[c])}</span> ${cellHtml(i, c)}</span>`;
    }).join('');
    const thead = detailCols.map((c) => `<th class="${numericCols[c] ? 'num' : ''}">${escapeHtml(headers[c])}</th>`).join('');
    const tbody = visibleByGroup.get(k).map((i) =>
      '<tr>' + detailCols.map((c) => `<td class="${numericCols[c] ? 'num' : ''}${rows[i][c] === '' ? ' empty-cell' : ''}">${cellHtml(i, c)}</td>`).join('') + '</tr>'
    ).join('');
    return `
      <article class="group-card">
        <header class="g-head"><h3>${escapeHtml(k)}</h3><div class="g-metas">${meta}</div></header>
        <table class="g-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
      </article>`;
  }).join('');

  return `<div class="groups">${cards}</div>`;
}

function buildSortSelect() {
  els.sortSelect.innerHTML = '<option value="-1">Orden original</option>' +
    state.headers.map((h, i) => `<option value="${i}">Ordenar por: ${escapeHtml(h)}</option>`).join('');
  syncSortControls();
}

function syncSortControls() {
  els.sortSelect.value = String(state.sortCol);
  els.sortDirBtn.textContent = state.sortDir === 1 ? '↑' : '↓';
  els.sortDirBtn.disabled = state.sortCol < 0;
}

function setSort(col, dir) {
  state.sortCol = col;
  state.sortDir = dir;
  syncSortControls();
  render();
}

/* ---------- Eventos ---------- */

els.refreshBtn.addEventListener('click', () => loadData());

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = els.search.value; render(); }, 120);
});

// Ordenar tocando el encabezado (tabla en pantallas anchas)
function onHeaderActivate(e) {
  const th = e.target.closest('th[data-col]');
  if (!th) return;
  const c = +th.dataset.col;
  setSort(c, state.sortCol === c ? -state.sortDir : 1);
}
els.content.addEventListener('click', onHeaderActivate);
els.content.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHeaderActivate(e); }
});

// Ordenar en móvil (tarjetas)
els.sortSelect.addEventListener('change', () => setSort(+els.sortSelect.value, 1));
els.sortDirBtn.addEventListener('click', () => setSort(state.sortCol, -state.sortDir));

// Recargar al volver a la app
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' &&
      Date.now() - state.lastLoadedAt > CONFIG.refreshOnReturnAfterSec * 1000) {
    loadData({ silent: true });
  }
});
window.addEventListener('online', () => loadData({ silent: true }));
window.addEventListener('offline', () => {
  if (state.rows.length) showBanner(`Sin conexión. Mostrando datos de ${formatTime(state.lastLoadedAt)}`, 'warn');
});

// Deslizar hacia abajo para actualizar
(function pullToRefresh() {
  const THRESHOLD = 70;
  let startY = null, dy = 0;
  window.addEventListener('touchstart', (e) => {
    startY = (window.scrollY <= 0 && e.touches.length === 1) ? e.touches[0].clientY : null;
    dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    if (window.scrollY > 0) { dy = 0; }
    const pull = Math.min(dy * 0.5, 90);
    els.ptr.style.transform = `translateY(${pull - 60}px)`;
    els.ptr.style.opacity = String(Math.min(1, dy / THRESHOLD));
    els.ptr.classList.toggle('ready', dy > THRESHOLD);
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (startY === null) return;
    const trigger = dy > THRESHOLD;
    startY = null;
    els.ptr.style.transition = 'transform .2s, opacity .2s';
    if (trigger) {
      els.ptr.classList.remove('ready');
      els.ptr.classList.add('loading-ptr');
      els.ptr.style.transform = 'translateY(0)';
      els.ptr.style.opacity = '1';
      await loadData();
      els.ptr.classList.remove('loading-ptr');
    }
    els.ptr.style.transform = 'translateY(-60px)';
    els.ptr.style.opacity = '0';
    setTimeout(() => { els.ptr.style.transition = ''; }, 220);
  });
})();

/* ---------- Modo editor (solo muestra el botón; la seguridad real es la cuenta de Google) ---------- */

const EDITOR_KEY = 'sheet-dashboard:editor';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isEditor() {
  try { return localStorage.getItem(EDITOR_KEY) === CONFIG.editorKeyHash; } catch (_) { return false; }
}

function updateEditButton() {
  if (!els.editBtn) return;
  const show = isEditor() && !!CONFIG.editUrl;
  els.editBtn.hidden = !show;
  if (show) els.editBtn.href = CONFIG.editUrl;
}

async function tryActivateEditor(key) {
  if (!key || !CONFIG.editorKeyHash || !window.crypto?.subtle) return false;
  if (await sha256(key.trim()) !== CONFIG.editorKeyHash) return false;
  try { localStorage.setItem(EDITOR_KEY, CONFIG.editorKeyHash); } catch (_) { return false; }
  updateEditButton();
  return true;
}

async function initEditorMode() {
  const url = new URL(location.href);
  const key = url.searchParams.get('editor');
  if (key !== null) {
    if (key === 'off') {
      try { localStorage.removeItem(EDITOR_KEY); } catch (_) { /* ignore */ }
    } else {
      await tryActivateEditor(key);
    }
    // Quita la clave de la barra de direcciones y del historial.
    url.searchParams.delete('editor');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  updateEditButton();

  // Plan B (útil en iPhone): 5 toques seguidos en el título para ingresar la clave.
  let taps = 0, tapTimer;
  els.title.addEventListener('click', async () => {
    taps++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 1500);
    if (taps < 5) return;
    taps = 0;
    if (isEditor()) {
      if (confirm('Modo editor activo. ¿Desactivarlo en este dispositivo?')) {
        try { localStorage.removeItem(EDITOR_KEY); } catch (_) { /* ignore */ }
        updateEditButton();
      }
      return;
    }
    const k = prompt('Clave de editor:');
    if (k === null) return;
    alert(await tryActivateEditor(k) ? 'Modo editor activado.' : 'Clave incorrecta.');
  });
}

/* ---------- Inicio ---------- */

initEditorMode();

document.title = CONFIG.title;
els.title.textContent = CONFIG.title;

if (typeof Papa === 'undefined') {
  els.content.innerHTML = '<div class="error-box"><h2>No se pudo cargar la app</h2><p>Falta la librería PapaParse. Revisa tu conexión y vuelve a abrir.</p></div>';
} else {
  loadData();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Si un service worker nuevo toma el control (app actualizada), recarga una vez para usarlo.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        // Busca actualizaciones también al volver a la app.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch((e) => console.warn('SW no registrado:', e));
  });
}
