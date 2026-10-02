/**
 * AI Pulse — directory and search for AI tools.
 * Vanilla ES module. No build step.
 */

/* ---------------------------------------------------------------
 * 1. Configuration
 * ------------------------------------------------------------- */
const CONFIG = {
  // Базовий URL API
  TARGET_URL: 'https://freeserp.ai/api.php',
  // URL твого Cloudflare Worker (див. worker.js). Якщо вказано, використовується першим.
  // Приклад: 'https://ai-pulse-proxy.your-name.workers.dev'
  WORKER_URL: '',
  TIMEOUT_MS: 8000, // Скільки чекаємо відповідь від одного проксі, потім пробуємо наступний
  // Публічні проксі: запасний варіант, можуть бути нестабільними
  PUBLIC_PROXIES: [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  ],
  INDEX: 'sites',
  QUERY: 'ai',
  QUERY_PARAM: 'q',
  STORAGE_KEY: 'ai-pulse:favorites',
  SKELETON_COUNT: 12,
  SEARCH_MIN_MATCHES: 12, // Пошук підвантажує нові порції, доки не набереться стільки збігів
  SEARCH_MAX_PAGES: 5,    // Ліміт додаткових запитів за один пошук (щоб не навантажувати API)
  PAGE_SIZE: 24, // Скільки сайтів вантажимо за один раз (кнопка Load more додає ще стільки ж)
};

/* ---------------------------------------------------------------
 * 2. State and DOM references
 * ------------------------------------------------------------- */
const state = {
  tools: [],          // Нормалізовані результати з API
  query: '',          // Клієнтський пошуковий текст
  favoritesOnly: false,
  favorites: loadFavorites(), // Map of id -> tool
  offset: 0,          // Скільки результатів уже запитано (параметр from)
  total: Infinity,    // Загальна кількість у API
  hasMore: false,     // Чи показувати кнопку Load more
  loadingMore: false,
  searching: false,   // Йде автоматичне донавантаження під час пошуку
};

let searchTimer = null;
let searchRun = 0; // Номер поточного пошуку, щоб скасовувати застарілі

const $ = (id) => document.getElementById(id);
const els = {
  grid: $('grid'),
  message: $('message'),
  search: $('search'),
  favToggle: $('fav-toggle'),
  favCount: $('fav-count'),
  status: $('status'),
  title: $('view-title'),
  loadMoreWrap: $('load-more-wrap'),
  loadMore: $('load-more'),
};

/* ---------------------------------------------------------------
 * 3. Favorites persistence (localStorage)
 * ------------------------------------------------------------- */
function loadFavorites() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    return new Map(raw ? JSON.parse(raw) : []);
  } catch {
    return new Map();
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify([...state.favorites]));
  } catch {
    /* Storage full or unavailable */
  }
}

function toggleFavorite(tool) {
  if (state.favorites.has(tool.id)) state.favorites.delete(tool.id);
  else state.favorites.set(tool.id, tool);
  saveFavorites();
  render();
}

/* ---------------------------------------------------------------
 * 4. API layer
 * ------------------------------------------------------------- */

/** Формування цільового URL (без проксі) */
function buildTargetUrl(from = 0) {
  const target = new URL(CONFIG.TARGET_URL);
  target.searchParams.set('index', CONFIG.INDEX);
  target.searchParams.set(CONFIG.QUERY_PARAM, CONFIG.QUERY);
  target.searchParams.set('ai_startups', '1');
  target.searchParams.set('size', String(CONFIG.PAGE_SIZE));
  target.searchParams.set('from', String(from));
  target.searchParams.set('sort', 'went_live');
  target.searchParams.set('order', 'desc');
  return target.toString();
}

/** Fetch з таймаутом: зависла відповідь не блокує решту проксі */
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: ctrl.signal });
    if (!response.ok) throw new Error(`Сервер відповів із статусом ${response.status}.`);
    return await response.json(); // Кине помилку, якщо прийшов HTML замість JSON
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('Проксі не відповів вчасно.') : err;
  } finally {
    clearTimeout(timer);
  }
}

// Той самий домен: api/proxy.js на Vercel або server.js локально (CORS не потрібен)
const sameOriginProxy = (u) => `/api/proxy?url=${encodeURIComponent(u)}`;
const workerProxy = (u) => `${CONFIG.WORKER_URL}?url=${encodeURIComponent(u)}`; // worker.js
let workingProxy = null; // Запам'ятовуємо проксі, що вже спрацював

/** Порядок спроб: той, що вже працював → Worker → свій домен → публічні */
function proxyList() {
  const list = [
    ...(CONFIG.WORKER_URL ? [workerProxy] : []),
    sameOriginProxy,
    ...CONFIG.PUBLIC_PROXIES,
  ];
  return workingProxy ? [workingProxy, ...list.filter((p) => p !== workingProxy)] : list;
}

/** Запит даних: пробуємо проксі по черзі, поки один не поверне валідний JSON */
async function fetchTools(from = 0) {
  const target = buildTargetUrl(from);
  let lastError;

  for (const makeUrl of proxyList()) {
    try {
      const data = await fetchJson(makeUrl(target));
      workingProxy = makeUrl;
      return data;
    } catch (err) {
      console.warn('Проксі не спрацював, пробую наступний:', err.message);
      if (makeUrl === workingProxy) workingProxy = null;
      lastError = err;
    }
  }
  throw new Error(`Не вдалося завантажити дані через жоден проксі. ${lastError?.message ?? ''}`);
}

/**
 * Нормалізація даних під формат { id, title, url, snippet }, 
 * адаптована під структуру відповді FreeSERP API.
 */
function normalize(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.results ?? payload?.items ?? payload?.data ?? payload?.sites ?? [];
  
  if (!Array.isArray(list)) throw new Error('API повернуло неочікуваний формат даних.');

  return list
    .map((item) => {
      const domain = item.domain || '';
      const url = item.url || (domain ? `https://${domain}` : '');
      const title = item.title || domain || url;
      // FreeSERP повертає опис сайту у полі ai_summary
      const snippet = item.ai_summary || item.snippet || item.description || '';

      return { 
        id: url || title || domain, 
        title: String(title), 
        url: String(url), 
        snippet: String(snippet),
        dr: item.dr ?? null
      };
    })
    .filter((t) => t.id && t.url);
}

/* ---------------------------------------------------------------
 * 5. Rendering
 * ------------------------------------------------------------- */
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : '#');

const hostname = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
};

function skeletonCard() {
  return `
    <div class="rounded-2xl border border-white/10 bg-panel/60 p-5" aria-hidden="true">
      <div class="shimmer h-5 w-2/3 rounded-md"></div>
      <div class="shimmer mt-3 h-3 w-1/3 rounded-md"></div>
      <div class="shimmer mt-5 h-3 w-full rounded-md"></div>
      <div class="shimmer mt-2 h-3 w-5/6 rounded-md"></div>
      <div class="shimmer mt-2 h-3 w-2/3 rounded-md"></div>
    </div>`;
}

function showSkeletons() {
  els.grid.setAttribute('aria-busy', 'true');
  els.message.classList.add('hidden');
  els.status.textContent = 'Loading tools…';
  els.grid.innerHTML = Array.from({ length: CONFIG.SKELETON_COUNT }, skeletonCard).join('');
}

function toolCard(tool) {
  const saved = state.favorites.has(tool.id);
  return `
    <article class="card group flex flex-col rounded-2xl border border-white/10 bg-panel/60 p-5 transition">
      <div class="flex items-start justify-between gap-3">
        <h2 class="min-w-0 text-base font-semibold leading-snug text-white">${escapeHtml(tool.title)}</h2>
        <button type="button" data-id="${escapeHtml(tool.id)}" aria-pressed="${saved}"
          aria-label="${saved ? 'Remove' : 'Save'} ${escapeHtml(tool.title)} ${saved ? 'from' : 'to'} favorites"
          class="fav-btn -m-1.5 shrink-0 rounded-lg p-1.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-pulse/50 ${saved ? 'text-pulse' : 'text-slate-500 hover:text-slate-200'}">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="${saved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>
        </button>
      </div>
      <a href="${escapeHtml(safeHref(tool.url))}" target="_blank" rel="noopener noreferrer"
        class="mt-1 truncate text-sm text-pulse/90 hover:text-pulse hover:underline">${escapeHtml(hostname(tool.url))}</a>
      <p class="mt-3 line-clamp-4 text-sm leading-relaxed text-slate-400">${escapeHtml(tool.snippet || 'No description available.')}</p>
    </article>`;
}

function showMessage({ title, body, action }) {
  els.grid.innerHTML = '';
  els.message.className =
    'mx-auto mt-10 max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 text-center backdrop-blur';
  els.message.innerHTML = `
    <h2 class="text-lg font-semibold text-white">${escapeHtml(title)}</h2>
    <p class="mt-2 text-sm text-slate-400">${escapeHtml(body)}</p>
    ${action ? `<button id="msg-action" type="button" class="mt-5 rounded-xl bg-pulse px-4 py-2 text-sm font-semibold text-ink transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-pulse/60">${escapeHtml(action.label)}</button>` : ''}`;
  if (action) $('msg-action').addEventListener('click', action.handler);
}

/** Пошук та фільтрація на стороні клієнта. */
function getVisibleTools() {
  const source = state.favoritesOnly ? [...state.favorites.values()] : state.tools;
  const q = state.query.trim().toLowerCase();
  if (!q) return source;
  return source.filter((t) => `${t.title} ${t.url} ${t.snippet}`.toLowerCase().includes(q));
}

function render() {
  els.favCount.textContent = state.favorites.size;
  els.favToggle.setAttribute('aria-pressed', String(state.favoritesOnly));
  els.title.textContent = state.favoritesOnly ? 'Your favorites' : 'AI tools';

  const tools = getVisibleTools();
  els.grid.setAttribute('aria-busy', 'false');

  if (tools.length === 0 && state.searching) {
    els.status.textContent = '';
    showMessage({ title: 'Searching more results…', body: 'Checking the next batch of tools for your query.' });
    updateLoadMore();
    return;
  }

  if (tools.length === 0) {
    els.status.textContent = '';
    updateLoadMore();
    if (state.favoritesOnly && !state.query) {
      showMessage({
        title: 'No favorites yet',
        body: 'Select the star on any tool to save it here.',
        action: { label: 'Browse all tools', handler: () => setFavoritesOnly(false) },
      });
    } else {
      showMessage({
        title: 'No AI tools found for your query',
        body: 'Check the spelling or try a broader keyword.',
        action: state.query ? { label: 'Clear search', handler: clearSearch } : null,
      });
    }
    return;
  }

  els.message.className = 'hidden';
  els.status.textContent = `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`;
  updateLoadMore();
  els.grid.innerHTML = tools.map(toolCard).join('');
}

/** Показує кнопку Load more лише в загальному списку, коли є що вантажити */
function updateLoadMore() {
  const visible = state.hasMore && !state.favoritesOnly;
  els.loadMoreWrap.classList.toggle('hidden', !visible);
  els.loadMore.disabled = state.loadingMore;
  els.loadMore.textContent = state.loadingMore ? 'Loading…' : 'Load more';
}

/** Запитує наступну порцію й додає її до списку без дублікатів */
async function fetchNextPage() {
  const next = normalize(await fetchTools(state.offset));
  const known = new Set(state.tools.map((t) => t.id));
  const fresh = next.filter((t) => !known.has(t.id));
  state.tools.push(...fresh);
  state.offset += CONFIG.PAGE_SIZE;
  // Якщо нових немає (API ігнорує from) або дійшли до кінця, ховаємо кнопку
  state.hasMore = fresh.length > 0 && state.offset < state.total;
}

/** Кнопка Load more */
async function loadMore() {
  if (state.loadingMore) return;
  state.loadingMore = true;
  updateLoadMore();
  try {
    await fetchNextPage();
  } catch (err) {
    console.error(err);
    els.loadMore.textContent = 'Failed. Try again';
  } finally {
    state.loadingMore = false;
    render();
  }
}

/**
 * Якщо в уже завантаженому мало збігів із запитом, підтягуємо наступні порції
 * (до SEARCH_MAX_PAGES), доки не набереться SEARCH_MIN_MATCHES або дані не закінчаться.
 */
async function searchMore() {
  const run = ++searchRun;
  if (!state.query.trim() || state.favoritesOnly || state.loadingMore) return;

  state.loadingMore = true;
  state.searching = true;
  let pages = 0;
  try {
    while (
      run === searchRun &&
      state.hasMore &&
      pages < CONFIG.SEARCH_MAX_PAGES &&
      getVisibleTools().length < CONFIG.SEARCH_MIN_MATCHES
    ) {
      render(); // Показуємо "Searching…" і поточні збіги
      await fetchNextPage();
      pages++;
    }
  } catch (err) {
    console.error(err);
  } finally {
    state.loadingMore = false;
    state.searching = false;
    render();
  }
}

/* ---------------------------------------------------------------
 * 6. Events
 * ------------------------------------------------------------- */
function setFavoritesOnly(value) {
  state.favoritesOnly = value;
  render();
}

function clearSearch() {
  els.search.value = '';
  state.query = '';
  searchRun++;
  render();
}

function bindEvents() {
  // Миттєва фільтрація по завантаженому + відкладене донавантаження, якщо збігів мало
  els.search.addEventListener('input', (e) => {
    state.query = e.target.value;
    searchRun++; // Скасовує попередній пошук, що ще триває
    render();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchMore, 350);
  });

  els.loadMore.addEventListener('click', loadMore);

  els.favToggle.addEventListener('click', () => setFavoritesOnly(!state.favoritesOnly));

  els.grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.fav-btn');
    if (!btn) return;
    const tool = state.tools.find((t) => t.id === btn.dataset.id) ?? state.favorites.get(btn.dataset.id);
    if (tool) toggleFavorite(tool);
  });
}

/* ---------------------------------------------------------------
 * 7. Boot
 * ------------------------------------------------------------- */
async function init() {
  bindEvents();
  showSkeletons();
  try {
    const rawData = await fetchTools(0);
    state.tools = normalize(rawData);
    state.offset = CONFIG.PAGE_SIZE;
    state.total = Number(rawData?.total) || Infinity;
    state.hasMore = state.tools.length > 0 && state.offset < state.total;
    render();
  } catch (err) {
    console.error(err);
    els.status.textContent = '';
    els.grid.setAttribute('aria-busy', 'false');
    showMessage({
      title: 'Could not load AI tools',
      body: err.message || 'Check your connection and try again.',
      action: { label: 'Try again', handler: init },
    });
  }
}

init();