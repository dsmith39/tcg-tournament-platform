/*
 * Client-side application controller for the TCG platform.
 *
 * This script owns:
 * - SPA-style section routing and browser history behavior.
 * - Auth/session handling and API request orchestration.
 * - Tournament/decklist rendering and live update subscriptions.
 */
const API_URL = '/api';
const YGO_CARD_API_URL = '/api/v7/cardinfo.php';
// Global UI and request state for the single-page frontend.
let currentUser = null;
let currentFormat = 'all';
let sectionHistory = [];
let myDecklists = [];
let editingDecklistId = null;
let deckBuilder = { main: [], extra: [], side: [] };
const cardLookupCache = new Map();
let cardSuggestionTimer = null;
let cardSuggestionAbortController = null;
let activeCardSuggestions = [];
let activeCardSuggestionIndex = -1;
let decklistDetailViewMode = 'text';
let currentDecklistDetail = null;
const decklistImageSectionsCache = new Map();
let landingDecklistSearchTerm = '';
let landingDecklistGameFilter = 'all';
let currentTournamentDetailId = null;
let tournamentRoundViewMode = 'board';
let notificationItems = [];
let lastTournamentDigest = new Map();
let livePollTimer = null;
const detailedCardInfoCache = new Map();
let liveSocket = null;
let socketConnected = false;
let currentProfileUserId = null;
let pendingAppRequests = 0;
let loadingRevealTimer = null;
const DEFAULT_LOADING_MESSAGE = 'Loading data...';
const INVALID_STORED_TOKEN_VALUES = new Set(['', 'undefined', 'null']);
let activeSessionRefreshPromise = null;

function ensureLoadingScreenElements() {
    // Lazily create loading overlay markup when older HTML snapshots are missing it.
    let loadingScreen = document.getElementById('loading-screen');
    if (!loadingScreen) {
        loadingScreen = document.createElement('div');
        loadingScreen.id = 'loading-screen';
        loadingScreen.className = 'loading-screen';
        loadingScreen.setAttribute('aria-live', 'polite');
        loadingScreen.setAttribute('aria-busy', 'true');
        loadingScreen.setAttribute('role', 'status');
        loadingScreen.setAttribute('aria-hidden', 'true');
        loadingScreen.innerHTML = `
            <div class="loading-content">
                <div class="loading-spinner" aria-hidden="true"></div>
                <p id="loading-screen-message">${DEFAULT_LOADING_MESSAGE}</p>
            </div>
        `;
        document.body.appendChild(loadingScreen);
    }

    const loadingMessage = document.getElementById('loading-screen-message');
    if (!loadingMessage) {
        const message = document.createElement('p');
        message.id = 'loading-screen-message';
        message.textContent = DEFAULT_LOADING_MESSAGE;
        loadingScreen.querySelector('.loading-content')?.appendChild(message);
    }
}

function ensureDecklistArchetypeField() {
    // Backfill archetype field in legacy DOM snapshots where it may be absent.
    const form = document.getElementById('decklist-form');
    if (!form || document.getElementById('decklist-archetype')) return;

    const nameInput = document.getElementById('decklist-name');
    const nameGroup = nameInput?.closest('.form-group');
    const archetypeGroup = document.createElement('div');
    archetypeGroup.className = 'form-group';
    archetypeGroup.innerHTML = `
        <label for="decklist-archetype">Archetype Tag (optional)</label>
        <input type="text" id="decklist-archetype" placeholder="e.g., Blue-Eyes, Dragon Link">
    `;

    if (nameGroup && nameGroup.parentElement === form) {
        nameGroup.insertAdjacentElement('afterend', archetypeGroup);
    } else {
        form.prepend(archetypeGroup);
    }
}

function setLoadingScreenMessage(message = DEFAULT_LOADING_MESSAGE) {
    ensureLoadingScreenElements();
    const loadingMessage = document.getElementById('loading-screen-message');
    if (!loadingMessage) return;
    loadingMessage.textContent = message || DEFAULT_LOADING_MESSAGE;
}

function setLoadingScreenAria(isVisible) {
    ensureLoadingScreenElements();
    const loadingScreen = document.getElementById('loading-screen');
    if (!loadingScreen) return;
    loadingScreen.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
}

function beginGlobalLoading(options = {}) {
    // Track concurrent API requests so the spinner does not flicker for fast calls.
    const immediate = options.immediate === true;
    if (typeof options.message === 'string' && options.message.trim()) {
        setLoadingScreenMessage(options.message.trim());
    }

    pendingAppRequests += 1;

    if (document.body.classList.contains('loading')) {
        return;
    }

    if (immediate) {
        if (loadingRevealTimer) {
            clearTimeout(loadingRevealTimer);
            loadingRevealTimer = null;
        }

        document.body.classList.add('loading');
        setLoadingScreenAria(true);
        return;
    }

    if (!loadingRevealTimer) {
        loadingRevealTimer = setTimeout(() => {
            if (pendingAppRequests > 0) {
                document.body.classList.add('loading');
                setLoadingScreenAria(true);
            }
            loadingRevealTimer = null;
        }, 120);
    }
}

function endGlobalLoading() {
    pendingAppRequests = Math.max(0, pendingAppRequests - 1);
    if (pendingAppRequests > 0) {
        return;
    }

    if (loadingRevealTimer) {
        clearTimeout(loadingRevealTimer);
        loadingRevealTimer = null;
    }

    document.body.classList.remove('loading');
    setLoadingScreenAria(false);
    setLoadingScreenMessage();
}

function normalizeStoredToken(token) {
    // Defend against historically saved invalid values like "undefined" or "null".
    if (typeof token !== 'string') {
        return null;
    }

    const trimmedToken = token.trim();
    if (INVALID_STORED_TOKEN_VALUES.has(trimmedToken)) {
        return null;
    }

    return trimmedToken;
}

function getStoredAccessToken() {
    const token = normalizeStoredToken(localStorage.getItem('token'));
    if (!token) {
        localStorage.removeItem('token');
        return null;
    }

    return token;
}

function persistAccessToken(token) {
    const normalizedToken = normalizeStoredToken(token);
    if (!normalizedToken) {
        localStorage.removeItem('token');
        return null;
    }

    localStorage.setItem('token', normalizedToken);
    return normalizedToken;
}

function clearStoredAccessToken() {
    localStorage.removeItem('token');
}

function getRequestUrl(requestTarget) {
    if (typeof requestTarget === 'string') {
        return new URL(requestTarget, window.location.origin);
    }

    if (requestTarget && typeof requestTarget.url === 'string') {
        return new URL(requestTarget.url, window.location.origin);
    }

    return null;
}

function shouldAttemptSessionRefresh(requestTarget) {
    const url = getRequestUrl(requestTarget);
    if (!url || url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
        return false;
    }

    return ![
        '/api/auth/login',
        '/api/auth/register',
        '/api/auth/refresh',
        '/api/auth/logout',
        '/api/auth/logout-all'
    ].includes(url.pathname);
}

async function refreshAuthenticatedSession() {
    if (!activeSessionRefreshPromise) {
        activeSessionRefreshPromise = nativeFetch(`${API_URL}/auth/refresh`, {
            method: 'POST',
            credentials: 'same-origin'
        })
            .then((response) => response.ok)
            .catch(() => false)
            .finally(() => {
                activeSessionRefreshPromise = null;
            });
    }

    return activeSessionRefreshPromise;
}

function isAppApiRequest(requestTarget) {
    if (!requestTarget) return false;

    if (typeof requestTarget === 'string') {
        return requestTarget.startsWith(API_URL);
    }

    if (typeof requestTarget.url === 'string') {
        return requestTarget.url.startsWith(API_URL);
    }

    return false;
}

// Wrap fetch globally to enforce same-origin credential behavior for API calls,
// auto-refresh sessions on 401, and drive the global loading indicator.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
    const suppressLoading = !!(init && typeof init === 'object' && init.suppressLoading === true);
    const requestInit = suppressLoading ? { ...init } : init;
    if (requestInit && typeof requestInit === 'object') {
        delete requestInit.suppressLoading;
    }

    const isApiRequest = isAppApiRequest(input);
    let normalizedInit = requestInit;

    if (isApiRequest) {
        normalizedInit = normalizedInit && typeof normalizedInit === 'object'
            ? { ...normalizedInit }
            : {};

        const headers = new Headers(normalizedInit.headers || undefined);
        headers.delete('Authorization');
        normalizedInit.headers = headers;

        if (!normalizedInit.credentials) {
            normalizedInit.credentials = 'same-origin';
        }
    }

    const shouldTrack = isApiRequest && !suppressLoading;
    if (shouldTrack) {
        beginGlobalLoading();
    }

    try {
        let response = await nativeFetch(input, normalizedInit);

        if (response.status === 401 && shouldAttemptSessionRefresh(input)) {
            const refreshed = await refreshAuthenticatedSession();
            if (refreshed) {
                response = await nativeFetch(input, normalizedInit);
            } else {
                clearStoredAccessToken();
            }
        }

        return response;
    } finally {
        if (shouldTrack) {
            endGlobalLoading();
        }
    }
};

function getEntityId(entity) {
    if (!entity) return null;
    if (typeof entity === 'string') return entity;
    return entity._id || entity.id || null;
}

function getCurrentUserId() {
    return getEntityId(currentUser);
}

function isSameId(a, b) {
    if (!a || !b) return false;
    return String(a) === String(b);
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeCardImageUrl(imageUrl) {
    // Rewrite upstream YGO image URLs to local proxy routes for CORS/cache consistency.
    const rawUrl = String(imageUrl || '').trim();
    if (!rawUrl) return '';

    let parsedUrl;
    try {
        parsedUrl = new URL(rawUrl, window.location.origin);
    } catch {
        return rawUrl;
    }

    if (parsedUrl.origin === window.location.origin && parsedUrl.pathname.startsWith('/api/v7/')) {
        return parsedUrl.toString();
    }

    const match = parsedUrl.pathname.match(/\/images\/cards(?:_(small|cropped))?\/(\d+)\.jpg$/i);
    if (!match) {
        return rawUrl;
    }

    const size = match[1] || 'full';
    const cardId = match[2];
    const localUrl = new URL(`${API_URL}/v7/card-image/${encodeURIComponent(cardId)}`, window.location.origin);
    if (size !== 'full') {
        localUrl.searchParams.set('size', size);
    }

    return localUrl.toString();
}

function getPrimaryCardImageUrl(card) {
    return normalizeCardImageUrl(
        card?.card_images?.[0]?.image_url_small
        || card?.card_images?.[0]?.image_url
        || ''
    );
}

function getInitials(username) {
    const safe = String(username || '').trim();
    if (!safe) return '??';

    const parts = safe.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }

    return safe.slice(0, 2).toUpperCase();
}

function getAvatarHTML(user, size = '40px') {
    if (!user) return '';
    const username = typeof user === 'string' ? user : (user.username || 'User');
    const avatarUrl = typeof user === 'object' ? user.avatarUrl : null;
    const initials = getInitials(username);
    
    if (avatarUrl) {
        return `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(username)}" style="width:${size}; height:${size}; border-radius:50%; object-fit:cover; background:var(--primary-color);">`;
    }
    
    const hue = username.charCodeAt(0) * 137.508 % 360;
    const color = `hsl(${hue}, 70%, 60%)`;
    return `<div style="width:${size}; height:${size}; border-radius:50%; background:${color}; display:flex; align-items:center; justify-content:center; color:white; font-weight:700; font-size:${parseInt(size)/2}px;">${initials}</div>`;
}

function formatRoundTimeRemaining(timerStartedAt, roundTimerMinutes) {
    if (!timerStartedAt || !roundTimerMinutes || roundTimerMinutes <= 0) return '';
    const startTime = new Date(timerStartedAt).getTime();
    const endTime = startTime + roundTimerMinutes * 60 * 1000;
    const now = Date.now();
    const remaining = endTime - now;
    
    if (remaining <= 0) return '<span style="color: var(--danger); font-weight: 700;">⏱ Time\'s Up!</span>';
    
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `<span style="color: var(--primary-color); font-weight: 700;">⏱ ${minutes}:${seconds.toString().padStart(2, '0')}</span>`;
}

function renderNotificationsPanel() {
    const list = document.getElementById('notifications-list');
    if (!list) return;

    if (!notificationItems.length) {
        list.innerHTML = '<div class="empty-state" style="padding:1rem;">No notifications yet.</div>';
        return;
    }

    list.innerHTML = notificationItems.map((item) => `
        <div style="border:1px solid var(--border-color); border-radius:8px; padding:0.55rem; background:var(--light-bg);">
            <div style="font-size:0.86rem; color:var(--text-primary);">${escapeHtml(item.message)}</div>
            <div style="font-size:0.74rem; color:var(--text-secondary); margin-top:0.2rem;">${new Date(item.createdAt).toLocaleString()}</div>
        </div>
    `).join('');
}

function showNotificationToast(message, type = 'info') {
    const stack = document.getElementById('notification-toast-stack');
    if (!stack) return;

    const toast = document.createElement('div');
    toast.className = `notification-toast ${type}`;
    toast.textContent = message;
    stack.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.remove();
        }, 220);
    }, 3000);
}

function addNotification(message, type = 'info', silent = false) {
    if (!message) return;

    notificationItems.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message,
        type,
        createdAt: Date.now()
    });

    notificationItems = notificationItems.slice(0, 50);
    renderNotificationsPanel();

    if (!silent) {
        showNotificationToast(message, type);
    }
}

function clearNotifications() {
    notificationItems = [];
    renderNotificationsPanel();
}

function toggleNotificationsPanel() {
    const panel = document.getElementById('notifications-panel');
    if (!panel) return;

    const shouldOpen = panel.style.display === 'none';
    panel.style.display = shouldOpen ? 'block' : 'none';
    if (shouldOpen) {
        renderNotificationsPanel();
    }
}

function buildTournamentDigest(tournaments) {
    const digest = new Map();
    (tournaments || []).forEach((tournament) => {
        digest.set(String(tournament._id), {
            status: tournament.status || 'registration',
            currentPlayers: tournament.currentPlayers || 0,
            rounds: tournament.roundMeta?.roundsPlayed || 0,
            unresolved: tournament.roundMeta?.unresolvedMatchCount || 0,
            disputed: tournament.roundMeta?.disputedMatchCount || 0,
            name: tournament.name || 'Tournament'
        });
    });
    return digest;
}

function detectTournamentDigestChanges(nextDigest) {
    if (!lastTournamentDigest.size) {
        lastTournamentDigest = nextDigest;
        return;
    }

    nextDigest.forEach((value, id) => {
        if (!lastTournamentDigest.has(id)) {
            addNotification(`New tournament posted: ${value.name}`, 'info', true);
            return;
        }

        const previous = lastTournamentDigest.get(id);
        if (previous.status !== value.status) {
            addNotification(`${value.name} is now ${value.status}.`, value.status === 'active' ? 'success' : 'info', true);
        }
        if (previous.currentPlayers !== value.currentPlayers) {
            addNotification(`${value.name}: player count is now ${value.currentPlayers}.`, 'info', true);
        }
        if (previous.disputed !== value.disputed && value.disputed > previous.disputed) {
            addNotification(`${value.name}: a match was disputed.`, 'warning', true);
        }
    });

    lastTournamentDigest = nextDigest;
}

function describeTournamentSocketEvent(event) {
    const labels = {
        created: 'New tournament created',
        deleted: 'Tournament deleted',
        joined: 'A player joined a tournament',
        left: 'A player left a tournament',
        started: 'Tournament started',
        'match-reported': 'A match result was reported',
        'match-confirmed': 'A match result was confirmed',
        'match-disputed': 'A match result was disputed',
        'match-resolved': 'A match result was resolved',
        'match-reopened': 'A match result was reopened',
        'round-started': 'A round started',
        'round-locked': 'A round was locked',
        'round-generated': 'A new round was generated',
        completed: 'Tournament completed'
    };

    return labels[event?.reason] || 'Tournament updated';
}

function describeDecklistSocketEvent(event) {
    const labels = {
        created: 'New decklist saved',
        updated: 'Decklist updated',
        deleted: 'Decklist deleted'
    };

    return labels[event?.reason] || 'Decklist updated';
}

function initializeRealtimeSocket() {
    if (typeof window.io !== 'function' || liveSocket) {
        return;
    }

    liveSocket = window.io(undefined, {
        transports: ['websocket', 'polling']
    });

    liveSocket.on('connect', () => {
        socketConnected = true;
    });

    liveSocket.on('disconnect', () => {
        socketConnected = false;
    });

    liveSocket.on('socket:ready', () => {
        socketConnected = true;
    });

    liveSocket.on('tournaments:updated', async (event) => {
        if (document.getElementById('dashboard').classList.contains('active') && currentUser) {
            await renderTournaments({ suppressLoading: true });
        }

        if (document.getElementById('landing').classList.contains('active') && !currentUser) {
            await renderLandingTournaments({ suppressLoading: true });
        }

        if (currentTournamentDetailId && String(currentTournamentDetailId) === String(event.tournamentId)) {
            await viewTournament(currentTournamentDetailId, {
                refresh: true,
                suppressLoading: true
            });
        }

        if (document.getElementById('user-profile').classList.contains('active') && currentProfileUserId) {
            await viewUserProfile(currentProfileUserId, {
                refresh: true,
                suppressLoading: true
            });
        }

        addNotification(`${describeTournamentSocketEvent(event)}: ${event.name || 'Tournament'}`, 'info', true);
    });

    liveSocket.on('decklists:updated', async (event) => {
        if (document.getElementById('decklists').classList.contains('active') && currentUser) {
            await renderDecklists({ suppressLoading: true });
        }

        if (document.getElementById('landing').classList.contains('active')) {
            await renderLandingDecklists({ suppressLoading: true });
        }

        if (currentDecklistDetail && String(getEntityId(currentDecklistDetail)) === String(event.decklistId)) {
            await viewDecklist(event.decklistId, {
                refresh: true,
                suppressLoading: true
            });
        }

        addNotification(`${describeDecklistSocketEvent(event)}: ${event.name || 'Decklist'}`, 'info', true);
    });
}

function createEmptyDeckBuilder() {
    return { main: [], extra: [], side: [] };
}

function normalizeDeckSection(value) {
    if (value === 'extra' || value === 'side') return value;
    return 'main';
}

function parseDeckTextToNames(deckText) {
    if (!deckText || typeof deckText !== 'string') return [];

    return deckText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^\d+\s*[xX]?\s+/, '').trim())
        .filter(Boolean);
}

function serializeDeckSection(cards) {
    return (cards || []).map((card) => card.name).join('\n');
}

function buildYdkContentFromSections(sections) {
    const main = parseDeckTextToNames(sections.main || '').join('\n');
    const extra = parseDeckTextToNames(sections.extra || '').join('\n');
    const side = parseDeckTextToNames(sections.side || '').join('\n');

    return [
        '#main',
        main,
        '#extra',
        extra,
        '!side',
        side,
        ''
    ].join('\n');
}

function parseYdkContentToSections(content) {
    const result = { main: [], extra: [], side: [] };
    if (!content || typeof content !== 'string') return result;

    let current = 'main';
    content.split(/\r?\n/).forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        if (line.toLowerCase() === '#main') {
            current = 'main';
            return;
        }
        if (line.toLowerCase() === '#extra') {
            current = 'extra';
            return;
        }
        if (line.toLowerCase() === '!side') {
            current = 'side';
            return;
        }
        if (line.startsWith('#')) return;

        result[current].push(line);
    });

    return result;
}

function triggerYdkImport() {
    const fileInput = document.getElementById('decklist-ydk-file');
    if (fileInput) {
        fileInput.click();
    }
}

async function importDeckFromTextPrompt(buttonEl = null) {
    const pasted = prompt('Paste your deck text list. Use section headers #main, #extra, !side (optional):', '#main\n\n#extra\n\n!side\n');
    if (pasted === null) return;

    const importTextBtn = buttonEl || document.querySelector('button[onclick^="importDeckFromTextPrompt"]');
    const originalImportText = importTextBtn ? importTextBtn.textContent : 'Import Text List';
    if (importTextBtn) {
        importTextBtn.disabled = true;
        importTextBtn.textContent = 'Importing...';
    }

    beginGlobalLoading({
        immediate: true,
        message: 'Importing text deck list...'
    });

    const parsed = parseYdkContentToSections(pasted);

    try {
        setDeckCardFeedback('Importing deck text...', 'success');
        setLoadingScreenMessage('Resolving card data...');
        deckBuilder = {
            main: await hydrateDeckSectionFromText(parsed.main.join('\n')),
            extra: await hydrateDeckSectionFromText(parsed.extra.join('\n')),
            side: await hydrateDeckSectionFromText(parsed.side.join('\n'))
        };
        renderDeckBuilder();
        setDeckCardFeedback('Deck text imported.', 'success');
        addNotification('Deck text list imported.', 'success');
    } catch (error) {
        setDeckCardFeedback('Failed to import deck text.');
        addNotification('Failed to import deck text list.', 'warning');
    } finally {
        endGlobalLoading();
        if (importTextBtn) {
            importTextBtn.disabled = false;
            importTextBtn.textContent = originalImportText;
        }
    }
}

function exportCurrentDeckAsYdk() {
    const content = buildYdkContentFromSections({
        main: serializeDeckSection(deckBuilder.main),
        extra: serializeDeckSection(deckBuilder.extra),
        side: serializeDeckSection(deckBuilder.side)
    });

    const nameInput = document.getElementById('decklist-name');
    const filename = `${(nameInput?.value || 'decklist').trim().replace(/[^a-zA-Z0-9-_]+/g, '_') || 'decklist'}.ydk`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setDeckCardFeedback('Exported current deck as .ydk', 'success');
}

async function exportDecklistByIdAsYdk(decklistId) {
    let decklist = currentDecklistDetail;
    if (!decklist || getEntityId(decklist) !== decklistId) {
        try {
            const token = localStorage.getItem('token');
            const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
            const response = await fetch(`${API_URL}/decklists/${decklistId}`, { headers });
            const data = await response.json();
            if (!response.ok) {
                addNotification(data.error || 'Unable to export decklist.', 'warning');
                return;
            }
            decklist = data;
        } catch (error) {
            addNotification('Unable to export decklist right now.', 'warning');
            return;
        }
    }

    const content = buildYdkContentFromSections({
        main: decklist.mainDeck || '',
        extra: decklist.extraDeck || '',
        side: decklist.sideDeck || ''
    });
    const filename = `${(decklist.name || 'decklist').trim().replace(/[^a-zA-Z0-9-_]+/g, '_') || 'decklist'}.ydk`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    addNotification('Decklist exported as .ydk.', 'success');
}

function getDecklistShareUrl(decklistId) {
    return `${window.location.origin}/decklists/${encodeURIComponent(decklistId)}`;
}

async function copyDecklistShareLink(decklistId) {
    try {
        const link = getDecklistShareUrl(decklistId);
        await navigator.clipboard.writeText(link);
        addNotification('Decklist share link copied to clipboard.', 'success');
    } catch (error) {
        addNotification('Could not copy share link. You can copy the URL manually.', 'warning');
    }
}

function getMaxAllowedCopiesByBanStatus(status) {
    if (status === 'Banned') return 0;
    if (status === 'Limited') return 1;
    if (status === 'Semi-Limited') return 2;
    return 3;
}

async function fetchDetailedCardByName(cardName) {
    const normalized = String(cardName || '').trim();
    if (!normalized) {
        throw new Error('Card name is required');
    }

    const cacheKey = normalized.toLowerCase();
    if (detailedCardInfoCache.has(cacheKey)) {
        return detailedCardInfoCache.get(cacheKey);
    }

    const response = await fetch(`${YGO_CARD_API_URL}?name=${encodeURIComponent(normalized)}`);
    if (!response.ok) {
        throw new Error('Card not found');
    }

    const data = await response.json();
    const card = data?.data?.[0];
    if (!card) {
        throw new Error('Card not found');
    }

    detailedCardInfoCache.set(cacheKey, card);
    return card;
}

async function validateDecklistLegality(payload) {
    const errors = [];
    const warnings = [];

    const mainNames = parseDeckTextToNames(payload.mainDeck || '');
    const extraNames = parseDeckTextToNames(payload.extraDeck || '');
    const sideNames = parseDeckTextToNames(payload.sideDeck || '');

    if (payload.game === 'duel-links') {
        if (mainNames.length < 20 || mainNames.length > 30) {
            errors.push(`Duel Links Main Deck should be 20-30 cards (currently ${mainNames.length}).`);
        }
        if (extraNames.length > 9) {
            errors.push(`Duel Links Extra Deck can have at most 9 cards (currently ${extraNames.length}).`);
        }
    } else {
        if (mainNames.length < 40 || mainNames.length > 60) {
            errors.push(`Main Deck must be between 40 and 60 cards (currently ${mainNames.length}).`);
        }
        if (extraNames.length > 15) {
            errors.push(`Extra Deck can have at most 15 cards (currently ${extraNames.length}).`);
        }
        if (sideNames.length > 15) {
            errors.push(`Side Deck can have at most 15 cards (currently ${sideNames.length}).`);
        }
    }

    const counts = new Map();
    [...mainNames, ...extraNames, ...sideNames].forEach((name) => {
        counts.set(name, (counts.get(name) || 0) + 1);
    });

    counts.forEach((qty, name) => {
        if (qty > 3) {
            errors.push(`${name} appears ${qty} times. Maximum is 3.`);
        }
    });

    if (payload.game === 'ygo-tcg') {
        const entries = Array.from(counts.entries());

        for (let i = 0; i < entries.length; i += 1) {
            const [name, qty] = entries[i];
            try {
                const card = await fetchDetailedCardByName(name);
                const tcgStatus = card?.banlist_info?.ban_tcg || null;
                const maxAllowed = getMaxAllowedCopiesByBanStatus(tcgStatus);
                if (qty > maxAllowed) {
                    errors.push(`${name} is ${tcgStatus || 'Unlimited'} in TCG. Allowed copies: ${maxAllowed}.`);
                }
            } catch (error) {
                warnings.push(`Could not verify legality for ${name}.`);
            }
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

function setDeckCardFeedback(message, type = 'error') {
    const feedback = document.getElementById('deck-card-feedback');
    if (!feedback) return;

    if (!message) {
        feedback.style.display = 'none';
        feedback.textContent = '';
        feedback.className = 'error';
        return;
    }

    feedback.style.display = 'block';
    feedback.textContent = message;
    feedback.className = type === 'success' ? 'success' : 'error';
}

function hideCardSuggestions() {
    const container = document.getElementById('deck-card-suggestions');
    if (!container) return;

    container.innerHTML = '';
    container.style.display = 'none';
    activeCardSuggestions = [];
    activeCardSuggestionIndex = -1;
}

function renderCardSuggestions() {
    const container = document.getElementById('deck-card-suggestions');
    if (!container) return;

    if (!activeCardSuggestions.length) {
        hideCardSuggestions();
        return;
    }

    container.innerHTML = activeCardSuggestions.map((suggestion, index) => `
        <button
            type="button"
            class="card-suggestion-btn ${index === activeCardSuggestionIndex ? 'active' : ''}"
            onmousedown="event.preventDefault(); applyCardSuggestion(${index})"
        >
            ${suggestion.imageUrl ? `<img src="${suggestion.imageUrl}" alt="" class="suggestion-thumb">` : ''}
            <span>${escapeHtml(suggestion.name)}</span>
        </button>
    `).join('');

    container.style.display = 'block';
}

const MAX_CARD_COPIES = 3;

function countCardCopiesInDeck(cardName) {
    return ['main', 'extra', 'side'].reduce(
        (total, section) => total + (deckBuilder[section] || []).filter((c) => c.name === cardName).length,
        0
    );
}

function applyCardSuggestion(index) {
    const suggestion = activeCardSuggestions[index];
    const input = document.getElementById('deck-card-name');
    const sectionSelect = document.getElementById('deck-card-section');
    if (!suggestion || !input) return;

    const section = normalizeDeckSection(sectionSelect?.value || 'main');

    if (countCardCopiesInDeck(suggestion.name) >= MAX_CARD_COPIES) {
        setDeckCardFeedback(`You already have ${MAX_CARD_COPIES} copies of ${suggestion.name} in your deck.`);
        input.value = '';
        hideCardSuggestions();
        input.focus();
        return;
    }

    deckBuilder[section].push({
        name: suggestion.name,
        imageUrl: normalizeCardImageUrl(suggestion.imageUrl)
    });

    renderDeckBuilder();
    setDeckCardFeedback(`Added ${suggestion.name} to ${section} deck.`, 'success');

    input.value = '';
    hideCardSuggestions();
    input.focus();
}

async function fetchCardSuggestions(query) {
    const normalized = String(query || '').trim();
    if (normalized.length < 2) return [];

    if (cardSuggestionAbortController) {
        cardSuggestionAbortController.abort();
    }

    cardSuggestionAbortController = new AbortController();

    try {
        const response = await fetch(
            `${YGO_CARD_API_URL}?fname=${encodeURIComponent(normalized)}`,
            { signal: cardSuggestionAbortController.signal }
        );

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        const cards = Array.isArray(data?.data) ? data.data : [];

        const seen = new Set();
        const startsWith = [];
        const contains = [];
        const lowerQuery = normalized.toLowerCase();

        cards.forEach((card) => {
            const name = card?.name;
            if (!name) return;
            const key = name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            const cardInfo = {
                name,
                imageUrl: getPrimaryCardImageUrl(card)
            };

            if (key.startsWith(lowerQuery)) {
                startsWith.push(cardInfo);
            } else {
                contains.push(cardInfo);
            }
        });

        return [...startsWith, ...contains].slice(0, 8);
    } catch (error) {
        if (error.name === 'AbortError') return [];
        return [];
    }
}

function queueCardSuggestions() {
    const input = document.getElementById('deck-card-name');
    if (!input) return;

    const query = input.value.trim();
    if (cardSuggestionTimer) {
        clearTimeout(cardSuggestionTimer);
    }

    if (query.length < 2) {
        hideCardSuggestions();
        return;
    }

    cardSuggestionTimer = setTimeout(async () => {
        const currentQuery = input.value.trim();
        if (currentQuery.length < 2) {
            hideCardSuggestions();
            return;
        }

        const suggestions = await fetchCardSuggestions(currentQuery);
        if (currentQuery !== input.value.trim()) {
            return;
        }

        activeCardSuggestions = suggestions;
        activeCardSuggestionIndex = suggestions.length > 0 ? 0 : -1;
        renderCardSuggestions();
    }, 180);
}

async function fetchCardByName(cardName) {
    const normalized = String(cardName || '').trim();
    if (!normalized) {
        throw new Error('Card name is required');
    }

    const cacheKey = normalized.toLowerCase();
    if (cardLookupCache.has(cacheKey)) {
        return cardLookupCache.get(cacheKey);
    }

    const response = await fetch(`${YGO_CARD_API_URL}?name=${encodeURIComponent(normalized)}`);
    if (!response.ok) {
        throw new Error('Card not found');
    }

    const data = await response.json();
    const card = data?.data?.[0];
    if (!card) {
        throw new Error('Card not found');
    }

    const cardInfo = {
        name: card.name,
        imageUrl: getPrimaryCardImageUrl(card),
        banTcg: card?.banlist_info?.ban_tcg || null
    };

    cardLookupCache.set(cacheKey, cardInfo);
    return cardInfo;
}

async function fetchCardByPasscode(passcode) {
    const normalized = String(passcode || '').trim();
    if (!normalized) {
        throw new Error('Card passcode is required');
    }

    const cacheKey = `id:${normalized}`;
    if (cardLookupCache.has(cacheKey)) {
        return cardLookupCache.get(cacheKey);
    }

    const response = await fetch(`${YGO_CARD_API_URL}?id=${encodeURIComponent(normalized)}`);
    if (!response.ok) {
        throw new Error('Card not found by passcode');
    }

    const data = await response.json();
    const card = data?.data?.[0];
    if (!card) {
        throw new Error('Card not found by passcode');
    }

    const cardInfo = {
        name: card.name,
        imageUrl: getPrimaryCardImageUrl(card),
        banTcg: card?.banlist_info?.ban_tcg || null
    };

    cardLookupCache.set(cacheKey, cardInfo);
    // Also warm the name cache for quicker follow-up lookups.
    cardLookupCache.set(card.name.toLowerCase(), cardInfo);
    return cardInfo;
}

function isNumericPasscodeToken(value) {
    return /^\d+$/.test(String(value || '').trim());
}

async function hydrateDeckSectionFromText(deckText) {
    const tokens = parseDeckTextToNames(deckText);

    const cards = await Promise.all(tokens.map(async (token) => {
        try {
            if (isNumericPasscodeToken(token)) {
                return await fetchCardByPasscode(token);
            }
            return await fetchCardByName(token);
        } catch (error) {
            return { name: token, imageUrl: '' };
        }
    }));

    return cards;
}

function groupDeckCardsForDisplay(cards) {
    const grouped = new Map();

    (cards || []).forEach((card) => {
        const name = card?.name || 'Unknown Card';
        if (!grouped.has(name)) {
            grouped.set(name, {
                name,
                imageUrl: normalizeCardImageUrl(card?.imageUrl),
                quantity: 0
            });
        }

        const entry = grouped.get(name);
        entry.quantity += 1;
        if (!entry.imageUrl && card?.imageUrl) {
            entry.imageUrl = normalizeCardImageUrl(card.imageUrl);
        }
    });

    return Array.from(grouped.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function renderDecklistTextSection(title, deckText) {
    if (!deckText) return '';

    return `
        <div style="margin-bottom: 1rem;">
            <h3 style="margin-bottom: 0.35rem;">${title}</h3>
            <pre style="white-space: pre-wrap; margin: 0; font-family: inherit; background: var(--light-bg); border: 1px solid var(--border-color); border-radius: 6px; padding: 0.75rem;">${escapeHtml(deckText)}</pre>
        </div>
    `;
}

function renderDecklistImageSection(title, cards) {
    if (!cards || cards.length === 0) return '';

    const groupedCards = groupDeckCardsForDisplay(cards);
    const cardTiles = groupedCards.map((card) => `
        <div class="deck-image-card">
            ${card.imageUrl
                ? `<img class="deck-image-thumb" src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}">`
                : '<div class="deck-image-thumb deck-image-thumb-placeholder">No image</div>'}
            <div class="deck-image-name">${escapeHtml(card.name)}</div>
            <div class="deck-image-qty">x${card.quantity}</div>
        </div>
    `).join('');

    return `
        <div style="margin-bottom: 1rem;">
            <h3 style="margin-bottom: 0.4rem;">${title} (${cards.length})</h3>
            <div class="deck-image-grid">${cardTiles}</div>
        </div>
    `;
}

function renderDecklistNotesSection(notes) {
    if (!notes) return '';
    return `<div><h3 style="margin-bottom: 0.35rem;">Notes</h3><p style="margin: 0;">${escapeHtml(notes)}</p></div>`;
}

function renderDecklistDetailLayout(decklist, bodyContent) {
    const gameLabel = {
        'ygo-tcg': 'Yu-Gi-Oh! TCG',
        'master-duel': 'Master Duel',
        'duel-links': 'Duel Links'
    }[decklist.game] || decklist.game;

    const ownerLabel = decklist.owner
        ? createUserLink(decklist.owner, decklist.owner.username || 'Unknown')
        : 'Unknown';

    const shareButton = decklist.isPublic === false
        ? ''
        : `<button class="btn secondary" style="margin: 0;" onclick="copyDecklistShareLink('${decklist._id}')">Copy Share Link</button>`;

    const exportButton = `<button class="btn secondary" style="margin: 0;" onclick="exportDecklistByIdAsYdk('${decklist._id}')">Export .ydk</button>`;

    return `
        <div style="max-width: 960px; margin: 0 auto; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; padding: 1.2rem;">
            <div style="display: flex; justify-content: space-between; gap: 0.7rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.9rem;">
                <h1 style="margin: 0;">${escapeHtml(decklist.name)}</h1>
                <span class="status-badge ${decklist.isPublic === false ? 'status-completed' : 'status-registration'}">${decklist.isPublic === false ? 'Private' : 'Public'}</span>
            </div>

            <div style="display: flex; gap: 0.9rem; flex-wrap: wrap; color: var(--text-secondary); margin-bottom: 1rem;">
                <span>${escapeHtml(gameLabel)}</span>
                <span>Created by ${ownerLabel}</span>
                <span>Created ${new Date(decklist.createdAt).toLocaleString()}</span>
                <span>Updated ${new Date(decklist.updatedAt || decklist.createdAt).toLocaleString()}</span>
            </div>

            <div class="decklist-view-toggle">
                <button class="btn ${decklistDetailViewMode === 'text' ? '' : 'secondary'}" style="margin: 0;" onclick="setDecklistDetailMode('text')">Text List</button>
                <button class="btn ${decklistDetailViewMode === 'images' ? '' : 'secondary'}" style="margin: 0;" onclick="setDecklistDetailMode('images')">Images</button>
                ${shareButton}
                ${exportButton}
            </div>

            ${bodyContent}
        </div>
    `;
}

async function getDecklistImageSections(decklist) {
    const cacheKey = getEntityId(decklist);
    if (cacheKey && decklistImageSectionsCache.has(cacheKey)) {
        return decklistImageSectionsCache.get(cacheKey);
    }

    const sections = {
        main: await hydrateDeckSectionFromText(decklist.mainDeck || ''),
        extra: await hydrateDeckSectionFromText(decklist.extraDeck || ''),
        side: await hydrateDeckSectionFromText(decklist.sideDeck || '')
    };

    if (cacheKey) {
        decklistImageSectionsCache.set(cacheKey, sections);
    }

    return sections;
}

async function renderDecklistDetailContent() {
    const container = document.getElementById('decklist-detail-content');
    if (!container || !currentDecklistDetail) return;

    const decklist = currentDecklistDetail;
    const decklistId = getEntityId(decklist);

    if (decklistDetailViewMode === 'images') {
        container.innerHTML = renderDecklistDetailLayout(
            decklist,
            '<div class="empty-state" style="padding: 1rem 0;">Loading card images...</div>'
        );

        const sections = await getDecklistImageSections(decklist);

        if (!currentDecklistDetail || getEntityId(currentDecklistDetail) !== decklistId || decklistDetailViewMode !== 'images') {
            return;
        }

        const body = `
            ${renderDecklistImageSection('Main Deck', sections.main)}
            ${renderDecklistImageSection('Extra Deck', sections.extra)}
            ${renderDecklistImageSection('Side Deck', sections.side)}
            ${renderDecklistNotesSection(decklist.notes)}
        `;

        container.innerHTML = renderDecklistDetailLayout(decklist, body);
        return;
    }

    const body = `
        ${renderDecklistTextSection('Main Deck', decklist.mainDeck || '')}
        ${renderDecklistTextSection('Extra Deck', decklist.extraDeck || '')}
        ${renderDecklistTextSection('Side Deck', decklist.sideDeck || '')}
        ${renderDecklistNotesSection(decklist.notes)}
    `;

    container.innerHTML = renderDecklistDetailLayout(decklist, body);
}

function setDecklistDetailMode(mode) {
    if (!['text', 'images'].includes(mode)) return;
    decklistDetailViewMode = mode;
    renderDecklistDetailContent();
}

function renderDeckBuilderSection(section) {
    const normalized = normalizeDeckSection(section);
    const cards = deckBuilder[normalized] || [];
    const container = document.getElementById(`deck-builder-${normalized}`);
    const count = document.getElementById(`deck-count-${normalized}`);

    if (count) {
        count.textContent = String(cards.length);
    }

    if (!container) return;

    if (cards.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding: 0.6rem;">No cards added yet</div>';
        return;
    }

    // Group cards by name so duplicates show as a single row with a quantity
    const groups = [];
    const seen = new Map();
    cards.forEach((card) => {
        if (seen.has(card.name)) {
            groups[seen.get(card.name)].qty++;
        } else {
            seen.set(card.name, groups.length);
            groups.push({ name: card.name, imageUrl: card.imageUrl || '', qty: 1 });
        }
    });

    container.innerHTML = groups.map((group) => {
        const safeName = escapeHtml(JSON.stringify(group.name));
        const safeImg  = escapeHtml(JSON.stringify(group.imageUrl));
        return `
        <div class="deck-card-item">
            ${group.imageUrl ? `<img class="deck-card-thumb" src="${escapeHtml(group.imageUrl)}" alt="${escapeHtml(group.name)}">` : '<div class="deck-card-thumb"></div>'}
            <div class="deck-card-name">${escapeHtml(group.name)}</div>
            <div class="deck-card-qty-controls">
                <button type="button" class="deck-qty-btn" onclick="decrementCardInDeck('${normalized}', ${safeName})">&#8722;</button>
                <span class="deck-card-qty">${group.qty}</span>
                <button type="button" class="deck-qty-btn" onclick="incrementCardInDeck('${normalized}', ${safeName}, ${safeImg})" ${countCardCopiesInDeck(group.name) >= MAX_CARD_COPIES ? 'disabled title="Maximum 3 copies allowed"' : ''}>&#43;</button>
            </div>
        </div>`;
    }).join('');
}

function renderDeckBuilder() {
    renderDeckBuilderSection('main');
    renderDeckBuilderSection('extra');
    renderDeckBuilderSection('side');
}

function removeCardFromDeckBuilder(section, index) {
    const normalized = normalizeDeckSection(section);
    if (!Array.isArray(deckBuilder[normalized])) return;

    deckBuilder[normalized].splice(index, 1);
    renderDeckBuilder();
}

function incrementCardInDeck(section, cardName, imageUrl) {
    const normalized = normalizeDeckSection(section);
    if (countCardCopiesInDeck(cardName) >= MAX_CARD_COPIES) {
        setDeckCardFeedback(`You already have ${MAX_CARD_COPIES} copies of ${cardName} in your deck.`);
        return;
    }
    deckBuilder[normalized].push({ name: cardName, imageUrl: normalizeCardImageUrl(imageUrl) });
    renderDeckBuilder();
}

function decrementCardInDeck(section, cardName) {
    const normalized = normalizeDeckSection(section);
    const arr = deckBuilder[normalized];
    if (!Array.isArray(arr)) return;
    // Remove the last occurrence of this card name
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].name === cardName) {
            arr.splice(i, 1);
            break;
        }
    }
    renderDeckBuilder();
}

async function addCardToDeckBuilder() {
    const input = document.getElementById('deck-card-name');
    const sectionSelect = document.getElementById('deck-card-section');
    const addButton = document.getElementById('deck-add-card-btn');

    const enteredName = input?.value?.trim() || '';
    const section = normalizeDeckSection(sectionSelect?.value || 'main');

    if (!enteredName) {
        setDeckCardFeedback('Enter a card name first.');
        return;
    }

    if (addButton) addButton.disabled = true;
    setDeckCardFeedback('Searching card...', 'success');

    try {
        const card = await fetchCardByName(enteredName);
        if (countCardCopiesInDeck(card.name) >= MAX_CARD_COPIES) {
            setDeckCardFeedback(`You already have ${MAX_CARD_COPIES} copies of ${card.name} in your deck.`);
            if (input) input.focus();
            return;
        }
        deckBuilder[section].push(card);
        renderDeckBuilder();
        hideCardSuggestions();
        setDeckCardFeedback(`Added ${card.name} to ${section} deck.`, 'success');
        if (input) input.value = '';
        if (input) input.focus();
    } catch (error) {
        setDeckCardFeedback('Card not found. Try the exact card name.');
    } finally {
        if (addButton) addButton.disabled = false;
    }
}

function requireAuth(actionLabel) {
    if (currentUser) return true;
    alert(`Please log in to ${actionLabel}.`);
    goToAuth('login');
    return false;
}

function getSafeExternalUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.toString();
        }
    } catch (error) {
        return '';
    }
    return '';
}

function createUserLink(user, fallback = 'Unknown') {
    const userId = getEntityId(user);
    const username = escapeHtml(user?.username || fallback);

    if (!userId) {
        return `<span>${username}</span>`;
    }

    return `<button class="user-link" onclick="viewUserProfile('${userId}')">${username}</button>`;
}

function updateBrowserUrl(path, options = {}) {
    const replaceHistory = options.replaceHistory === true;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (currentPath === normalizedPath) {
        return;
    }

    if (replaceHistory) {
        window.history.replaceState({}, '', normalizedPath);
        return;
    }

    window.history.pushState({}, '', normalizedPath);
}

function getPathForSection(sectionId) {
    if (sectionId === 'tournament-detail' && currentTournamentDetailId) {
        return `/tournaments/${encodeURIComponent(String(currentTournamentDetailId))}`;
    }

    if (sectionId === 'decklist-detail') {
        const decklistId = getEntityId(currentDecklistDetail);
        if (decklistId) {
            return `/decklists/${encodeURIComponent(String(decklistId))}`;
        }
    }

    if (sectionId === 'user-profile' && currentProfileUserId) {
        return `/users/${encodeURIComponent(String(currentProfileUserId))}`;
    }

    const map = {
        landing: '/',
        auth: '/auth/login',
        dashboard: '/dashboard',
        create: '/tournaments/create',
        decklists: '/decklists',
        'tournament-detail': '/dashboard',
        'decklist-detail': '/decklists',
        'user-profile': currentUser ? '/dashboard' : '/'
    };

    return map[sectionId] || '/';
}

function syncUrlToSection(sectionId, options = {}) {
    updateBrowserUrl(getPathForSection(sectionId), options);
}

function getRouteFromLocation() {
    const pathname = window.location.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/') return { type: 'landing' };
    if (pathname === '/auth' || pathname === '/auth/login') return { type: 'auth', mode: 'login' };
    if (pathname === '/auth/signup') return { type: 'auth', mode: 'signup' };
    if (pathname === '/dashboard') return { type: 'dashboard' };
    if (pathname === '/tournaments/create') return { type: 'create' };
    if (pathname === '/decklists') return { type: 'decklists' };

    const tournamentMatch = pathname.match(/^\/tournaments\/([^/]+)$/);
    if (tournamentMatch) return { type: 'tournament-detail', id: decodeURIComponent(tournamentMatch[1]) };

    const decklistMatch = pathname.match(/^\/decklists\/([^/]+)$/);
    if (decklistMatch) return { type: 'decklist-detail', id: decodeURIComponent(decklistMatch[1]) };

    const userMatch = pathname.match(/^\/users\/([^/]+)$/);
    if (userMatch) return { type: 'user-profile', id: decodeURIComponent(userMatch[1]) };

    return { type: 'not-found' };
}

async function renderRouteFromLocation(options = {}) {
    const replaceHistory = options.replaceHistory === true;
    const route = getRouteFromLocation();

    if (route.type === 'landing') {
        showLanding({ updateUrl: false });
        return;
    }

    if (route.type === 'auth') {
        goToAuth(route.mode || 'login', { updateUrl: false });
        return;
    }

    if (route.type === 'dashboard') {
        if (!currentUser) {
            goToAuth('login', { replaceHistory: true });
            return;
        }
        switchSection('dashboard', { updateUrl: false, skipAuthPrompt: true });
        return;
    }

    if (route.type === 'create') {
        if (!currentUser) {
            goToAuth('login', { replaceHistory: true });
            return;
        }
        switchSection('create', { updateUrl: false, skipAuthPrompt: true });
        return;
    }

    if (route.type === 'decklists') {
        if (!currentUser) {
            goToAuth('login', { replaceHistory: true });
            return;
        }
        switchSection('decklists', { updateUrl: false, skipAuthPrompt: true });
        return;
    }

    if (route.type === 'tournament-detail' && route.id) {
        await viewTournament(route.id, { updateUrl: false });
        return;
    }

    if (route.type === 'decklist-detail' && route.id) {
        await viewDecklist(route.id, { updateUrl: false });
        return;
    }

    if (route.type === 'user-profile' && route.id) {
        await viewUserProfile(route.id, { updateUrl: false });
        return;
    }

    showLanding({ updateUrl: false });
    updateBrowserUrl('/', { replaceHistory: true });
}

function getActiveSectionId() {
    const activeSection = document.querySelector('section.active');
    return activeSection ? activeSection.id : null;
}

function activateSection(sectionId, trackHistory = true) {
    const currentSectionId = getActiveSectionId();

    if (trackHistory && currentSectionId && currentSectionId !== sectionId) {
        sectionHistory.push(currentSectionId);
        if (sectionHistory.length > 40) {
            sectionHistory.shift();
        }
    }

    document.querySelectorAll('section').forEach((s) => s.classList.remove('active'));

    const section = document.getElementById(sectionId);
    if (!section) return;

    section.classList.add('active');

    if (sectionId === 'dashboard') {
        renderTournaments();
    }

    if (sectionId === 'landing') {
        renderLandingTournaments();
        renderLandingDecklists();
    }

    if (sectionId === 'decklists' && currentUser) {
        renderDecklists();
    }
}

function goBack() {
    while (sectionHistory.length > 0) {
        const previousSection = sectionHistory.pop();

        if (previousSection === 'create' && !currentUser) {
            continue;
        }

        if (previousSection === 'decklists' && !currentUser) {
            continue;
        }

        if (previousSection === 'dashboard' && !currentUser) {
            showLanding();
            return;
        }

        activateSection(previousSection, false);
        syncUrlToSection(previousSection, { replaceHistory: true });
        return;
    }

    if (currentUser) {
        activateSection('dashboard', false);
        syncUrlToSection('dashboard', { replaceHistory: true });
    } else {
        showLanding({ replaceHistory: true });
    }
}

function applyAuthenticatedNavState() {
    if (!currentUser) {
        hidePrivateNav();
        return;
    }

    document.getElementById('dashboard-btn').style.display = 'block';
    document.getElementById('create-btn').style.display = 'block';
    document.getElementById('decklists-btn').style.display = 'block';
    document.getElementById('profile-btn').style.display = 'block';
    document.getElementById('notifications-btn').style.display = 'block';
    document.getElementById('logout-btn').style.display = 'block';
    document.getElementById('user-info').style.display = 'block';
    document.getElementById('user-info').textContent = `👤 ${currentUser.username}`;

    const createUserLinkEl = document.getElementById('create-user-link');
    if (createUserLinkEl) {
        createUserLinkEl.textContent = currentUser.username;
    }
}

async function init() {
    getStoredAccessToken();

    try {
        const response = await fetch(`${API_URL}/auth/me`, {
            suppressLoading: true
        });

        if (response.ok) {
            currentUser = await response.json();
            clearStoredAccessToken();
            applyAuthenticatedNavState();
        } else {
            clearStoredAccessToken();
        }
    } catch (error) {
        console.log('Unable to restore authenticated session.');
        clearStoredAccessToken();
    }

    if (!currentUser) {
        hidePrivateNav();
    }
    await renderRouteFromLocation({ replaceHistory: true });
}

async function login(buttonEl = null) {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const errorDiv = document.getElementById('login-error');
    const loginBtn = buttonEl || document.querySelector('#login-form button.btn');
    const originalLoginText = loginBtn ? loginBtn.textContent : 'Login';

    if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = 'Logging in...';
    }

    try {
        errorDiv.textContent = '';
        beginGlobalLoading({
            immediate: true,
            message: 'Logging in...'
        });

        const response = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (response.ok) {
            persistAccessToken(data.token);
            currentUser = data.user;
            setLoadingScreenMessage('Loading dashboard...');
            showDashboard();
            await openDeepLinkedDeckIfPresent();
        } else {
            errorDiv.textContent = data.error || 'Login failed';
        }
    } catch (error) {
        errorDiv.textContent = 'Network error - backend running?';
    } finally {
        endGlobalLoading();
        if (loginBtn) {
            loginBtn.disabled = false;
            loginBtn.textContent = originalLoginText;
        }
    }
}

async function signup(buttonEl = null) {
    const username = document.getElementById('signup-username').value;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    const errorDiv = document.getElementById('signup-error');
    const signupBtn = buttonEl || document.querySelector('#signup-form button.btn');
    const originalSignupText = signupBtn ? signupBtn.textContent : 'Sign Up';

    if (signupBtn) {
        signupBtn.disabled = true;
        signupBtn.textContent = 'Creating account...';
    }

    try {
        errorDiv.textContent = '';
        beginGlobalLoading({
            immediate: true,
            message: 'Creating account...'
        });

        const response = await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });

        const data = await response.json();

        if (response.ok) {
            persistAccessToken(data.token);
            currentUser = data.user;
            setLoadingScreenMessage('Loading dashboard...');
            showDashboard();
            await openDeepLinkedDeckIfPresent();
        } else {
            errorDiv.textContent = data.error || 'Signup failed';
        }
    } catch (error) {
        errorDiv.textContent = 'Network error - backend running?';
    } finally {
        endGlobalLoading();
        if (signupBtn) {
            signupBtn.disabled = false;
            signupBtn.textContent = originalSignupText;
        }
    }
}

async function logout() {
    try {
        await fetch(`${API_URL}/auth/logout`, {
            method: 'POST',
            suppressLoading: true
        });
    } catch (error) {
        console.log('Unable to notify server about logout. Clearing local session only.');
    }

    clearStoredAccessToken();
    currentUser = null;
    sectionHistory = [];
    myDecklists = [];
    editingDecklistId = null;
    currentTournamentDetailId = null;
    currentProfileUserId = null;
    showLanding();
}

function hidePrivateNav() {
    document.querySelectorAll('#nav-menu button, .user-info').forEach((el) => {
        el.style.display = 'none';
    });
}

function showLanding(options = {}) {
    activateSection('landing', false);
    hidePrivateNav();
    if (options.updateUrl !== false) {
        syncUrlToSection('landing', { replaceHistory: options.replaceHistory === true });
    }
    const notificationPanel = document.getElementById('notifications-panel');
    if (notificationPanel) {
        notificationPanel.style.display = 'none';
    }
}

function showAuth(options = {}) {
    activateSection('auth', false);
    hidePrivateNav();
    if (options.updateUrl !== false) {
        syncUrlToSection('auth', { replaceHistory: options.replaceHistory === true });
    }
}

function goToAuth(mode = 'login', options = {}) {
    showAuth({ updateUrl: false, replaceHistory: options.replaceHistory === true });
    if (mode === 'signup') {
        showSignup({ updateUrl: false });
        if (options.updateUrl !== false) {
            updateBrowserUrl('/auth/signup', { replaceHistory: options.replaceHistory === true });
        }
        return;
    }
    showLogin({ updateUrl: false });
    if (options.updateUrl !== false) {
        updateBrowserUrl('/auth/login', { replaceHistory: options.replaceHistory === true });
    }
}

function showDashboard() {
    if (!currentUser) {
        showLanding();
        return;
    }

    applyAuthenticatedNavState();

    switchSection('dashboard');
    renderTournaments();
}

function switchSection(sectionId, options = {}) {
    const skipAuthPrompt = options.skipAuthPrompt === true;
    const updateUrl = options.updateUrl !== false;
    const replaceHistory = options.replaceHistory === true;

    if ((sectionId === 'create' || sectionId === 'decklists') && !currentUser) {
        if (!skipAuthPrompt) {
            alert('You must create an account and log in to access this section.');
        }
        goToAuth('login', { replaceHistory: true });
        return;
    }

    if (sectionId === 'dashboard' && !currentUser) {
        if (skipAuthPrompt) {
            goToAuth('login', { replaceHistory: true });
        } else {
            showLanding();
        }
        return;
    }

    activateSection(sectionId, true);
    if (updateUrl) {
        syncUrlToSection(sectionId, { replaceHistory });
    }
}

async function renderLandingTournaments(options = {}) {
    const container = document.getElementById('landing-tournament-list');
    if (!container) return;

    container.innerHTML = '<div class="empty-state">Loading tournaments...</div>';

    try {
        const response = await fetch(`${API_URL}/tournaments`, {
            suppressLoading: options.suppressLoading === true
        });
        const tournaments = await response.json();

        if (!response.ok) {
            container.innerHTML = '<div class="empty-state">Unable to load tournaments right now.</div>';
            return;
        }

        const latestTournaments = tournaments.slice(0, 5);

        if (latestTournaments.length === 0) {
            container.innerHTML = '<div class="empty-state">No tournaments have been posted yet.</div>';
            return;
        }

        container.innerHTML = latestTournaments.map((tournament) => createTournamentListItem(tournament, true)).join('');
    } catch (error) {
        container.innerHTML = '<div class="empty-state">Unable to load tournaments right now.</div>';
    }
}

function createLandingDecklistItem(decklist) {
    const gameLabel = {
        'ygo-tcg': 'Yu-Gi-Oh! TCG',
        'master-duel': 'Master Duel',
        'duel-links': 'Duel Links'
    }[decklist.game] || decklist.game;

    const ownerLabel = decklist.owner
        ? createUserLink(decklist.owner, decklist.owner.username || 'Unknown')
        : 'Unknown';

    const archetypeTag = decklist.archetype ? `<span style="display: inline-block; background: var(--primary-color); color: white; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem;">${escapeHtml(decklist.archetype)}</span>` : '';

    return `
        <div class="tournament-item">
            <div class="tournament-main">
                <div class="tournament-name-row">
                    <div class="tournament-name">${escapeHtml(decklist.name)}</div>
                    <span class="status-badge status-registration">Decklist</span>
                </div>
                <div class="tournament-meta">
                    <span>${escapeHtml(gameLabel)}</span>
                    <span>Created by ${ownerLabel}</span>
                    <span>${new Date(decklist.createdAt).toLocaleDateString()}</span>
                </div>
                ${archetypeTag ? `<div style="margin-top: 0.5rem;">${archetypeTag}</div>` : ''}
            </div>
            <div class="tournament-actions">
                <button class="btn secondary" onclick="viewDecklist('${decklist._id}')">View Decklist</button>
            </div>
        </div>
    `;
}

async function renderLandingDecklists(options = {}) {
    const container = document.getElementById('landing-decklist-list');
    if (!container) return;

    container.innerHTML = '<div class="empty-state">Loading decklists...</div>';

    try {
        const response = await fetch(`${API_URL}/decklists/recent`, {
            suppressLoading: options.suppressLoading === true
        });
        const decklists = await response.json();

        if (!response.ok) {
            container.innerHTML = '<div class="empty-state">Unable to load decklists right now.</div>';
            return;
        }

        if (!Array.isArray(decklists) || decklists.length === 0) {
            container.innerHTML = '<div class="empty-state">No public decklists yet.</div>';
            return;
        }

        const normalizedSearch = landingDecklistSearchTerm.trim().toLowerCase();
        const filtered = decklists.filter((decklist) => {
            if (landingDecklistGameFilter !== 'all' && decklist.game !== landingDecklistGameFilter) {
                return false;
            }

            if (!normalizedSearch) return true;

            const ownerName = decklist.owner?.username || '';
            const haystack = `${decklist.name || ''} ${ownerName}`.toLowerCase();
            return haystack.includes(normalizedSearch);
        });

        if (!filtered.length) {
            container.innerHTML = '<div class="empty-state">No decklists match your filters.</div>';
            return;
        }

        container.innerHTML = filtered.map(createLandingDecklistItem).join('');
    } catch (error) {
        container.innerHTML = '<div class="empty-state">Unable to load decklists right now.</div>';
    }
}

async function renderTournaments(options = {}) {
    const activeContainer = document.getElementById('tournament-list');
    const completedContainer = document.getElementById('completed-tournament-list');

    activeContainer.innerHTML = '<div class="empty-state">Loading...</div>';
    completedContainer.innerHTML = '<div class="empty-state">Loading completed tournaments...</div>';

    try {
        const response = await fetch(`${API_URL}/tournaments`, {
            suppressLoading: options.suppressLoading === true
        });
        const tournaments = await response.json();

        if (!response.ok || !Array.isArray(tournaments)) {
            throw new Error('Failed to load tournaments');
        }

        if (currentUser) {
            detectTournamentDigestChanges(buildTournamentDigest(tournaments));
        }

        const activeTournaments = tournaments.filter(t => (t.status || 'registration') !== 'completed');
        const completedTournaments = tournaments.filter(t => (t.status || 'registration') === 'completed');

        const filteredActive = currentFormat === 'all'
            ? activeTournaments
            : activeTournaments.filter(t => t.game === currentFormat);

        const filteredCompleted = currentFormat === 'all'
            ? completedTournaments
            : completedTournaments.filter(t => t.game === currentFormat);

        if (filteredActive.length === 0) {
            activeContainer.innerHTML = '<div class="empty-state">No active tournaments found</div>';
        } else {
            activeContainer.innerHTML = filteredActive.map((tournament) => createTournamentListItem(tournament)).join('');
        }

        if (filteredCompleted.length === 0) {
            completedContainer.innerHTML = '<div class="empty-state">No completed tournaments yet</div>';
        } else {
            completedContainer.innerHTML = filteredCompleted.map((tournament) => createTournamentListItem(tournament)).join('');
        }
    } catch (error) {
        activeContainer.innerHTML = '<div class="empty-state">Error loading tournaments</div>';
        completedContainer.innerHTML = '<div class="empty-state">Error loading completed tournaments</div>';
        console.error(error);
    }
}

function createTournamentListItem(tournament, publicView = false) {
    const gameLabel = {
        'ygo-tcg': '🎴 Yu-Gi-Oh! TCG',
        'master-duel': '⚡ Master Duel',
        'duel-links': '📱 Duel Links'
    }[tournament.game] || tournament.game;

    const formatLabel = {
        'swiss': 'Swiss',
        'single-elim': 'Single Elimination',
        'double-elim': 'Double Elimination'
    }[tournament.format] || tournament.format;

    const currentUserId = getCurrentUserId();
    const isCreator = tournament.createdBy && isSameId(getEntityId(tournament.createdBy), currentUserId);
    const hasJoined = tournament.players && tournament.players.some(p => isSameId(getEntityId(p), currentUserId));
    const isFull = (tournament.currentPlayers || 0) >= tournament.maxPlayers;
    
    const statusClass = `status-${tournament.status || 'registration'}`;
    const statusLabel = {
        'registration': 'Open',
        'active': 'Live',
        'completed': 'Finished'
    }[tournament.status] || 'Open';

    const canUsePlayerActions = !!currentUser && !publicView;
    const creatorLink = createUserLink(tournament.createdBy);

    let actionButtons = '';

    if (tournament.status === 'registration' || !tournament.status) {
        if (!canUsePlayerActions) {
            actionButtons = `<button class="btn" onclick="goToAuth('login')">Login to Join</button>`;
        } else if (hasJoined) {
            actionButtons = `<button class="btn secondary" onclick="leaveTournament('${tournament._id}')">Leave</button>`;
        } else if (isFull) {
            actionButtons = `<button class="btn" disabled>Full</button>`;
        } else {
            actionButtons = `<button class="btn" onclick="joinTournament('${tournament._id}', '${tournament.game}')">Join</button>`;
        }

        if (canUsePlayerActions && isCreator) {
            actionButtons += ` <button class="btn" onclick="startTournament('${tournament._id}')" style="background-color: var(--success);">Start</button>`;
            actionButtons += ` <button class="btn danger" onclick="deleteTournament('${tournament._id}')">Delete</button>`;
        }
    } else if (tournament.status === 'active' && canUsePlayerActions) {
        actionButtons = `<button class="btn secondary" disabled>🏆 In Progress</button>`;
        if (isCreator) {
            actionButtons += ` <button class="btn" onclick="completeTournament('${tournament._id}')">Complete</button>`;
        }
    } else {
        actionButtons = `<button class="btn secondary" disabled>🏆 Completed</button>`;
    }

    return `
        <div class="tournament-item">
            <div class="tournament-main">
                <div class="tournament-name-row">
                    <div class="tournament-name">${escapeHtml(tournament.name)}</div>
                    <span class="status-badge ${statusClass}">${statusLabel}</span>
                </div>
                <div class="tournament-meta">
                    <span>${formatLabel}</span>
                    <span>📍 ${gameLabel}</span>
                    <span>👥 ${tournament.currentPlayers || 0}/${tournament.maxPlayers} Players</span>
                    <span>👤 Created by ${creatorLink}</span>
                </div>
                ${tournament.description ? `<p style="margin-top: 0.55rem; margin-bottom: 0;">📝 ${escapeHtml(tournament.description)}</p>` : ''}
            </div>
            <div class="tournament-actions">
                <button class="btn secondary" onclick="viewTournament('${tournament._id}')">View Details</button>
                ${actionButtons}
            </div>
        </div>
    `;
}

async function joinTournament(id, tournamentGame = null) {
    if (!requireAuth('join tournaments')) return;

    const selectedDecklist = await promptDecklistSelectionForJoin(tournamentGame);
    if (!selectedDecklist) return;

    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/tournaments/${id}/join`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ decklistId: selectedDecklist._id })
        });

        const data = await response.json();

        if (response.ok) {
            renderTournaments();
            refreshTournamentDetailIfOpen(id);
        } else {
            alert(data.error || 'Failed to join tournament');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function loadMyDecklists(options = {}) {
    if (!requireAuth('manage decklists')) return [];

    const token = localStorage.getItem('token');
    const response = await fetch(`${API_URL}/decklists`, {
        headers: { 'Authorization': `Bearer ${token}` },
        suppressLoading: options.suppressLoading === true
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Failed to load decklists');
    }

    myDecklists = Array.isArray(data) ? data : [];
    return myDecklists;
}

function resetDecklistForm() {
    editingDecklistId = null;
    deckBuilder = createEmptyDeckBuilder();

    const form = document.getElementById('decklist-form');
    if (form) form.reset();

    const title = document.getElementById('decklist-form-title');
    if (title) title.textContent = 'Create Decklist';

    const submitBtn = document.getElementById('decklist-submit-btn');
    if (submitBtn) submitBtn.textContent = 'Save Decklist';

    const publicToggle = document.getElementById('decklist-public');
    if (publicToggle) publicToggle.checked = true;

    const archetypeField = document.getElementById('decklist-archetype');
    if (archetypeField) archetypeField.value = '';

    setDeckCardFeedback('');
    hideCardSuggestions();
    renderDeckBuilder();
}

async function editDecklist(decklistId) {
    const decklist = myDecklists.find((item) => item._id === decklistId);
    if (!decklist) return;

    editingDecklistId = decklistId;

    document.getElementById('decklist-name').value = decklist.name || '';
    document.getElementById('decklist-game').value = decklist.game || '';
    const archetypeField = document.getElementById('decklist-archetype');
    if (archetypeField) archetypeField.value = decklist.archetype || '';
    document.getElementById('decklist-notes').value = decklist.notes || '';
    const publicToggle = document.getElementById('decklist-public');
    if (publicToggle) publicToggle.checked = decklist.isPublic !== false;

    setDeckCardFeedback('Loading saved cards...', 'success');
    deckBuilder = {
        main: await hydrateDeckSectionFromText(decklist.mainDeck || ''),
        extra: await hydrateDeckSectionFromText(decklist.extraDeck || ''),
        side: await hydrateDeckSectionFromText(decklist.sideDeck || '')
    };
    renderDeckBuilder();
    setDeckCardFeedback('');

    document.getElementById('decklist-form-title').textContent = 'Edit Decklist';
    document.getElementById('decklist-submit-btn').textContent = 'Update Decklist';

    switchSection('decklists');
}

async function deleteDecklist(decklistId) {
    if (!requireAuth('delete decklists')) return;
    if (!confirm('Delete this decklist?')) return;

    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/decklists/${decklistId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        if (!response.ok) {
            alert(data.error || 'Failed to delete decklist');
            return;
        }

        if (editingDecklistId === decklistId) {
            resetDecklistForm();
        }

        await renderDecklists();
    } catch (error) {
        alert('Network error while deleting decklist');
    }
}

function renderDecklistCard(decklist) {
    const gameLabel = {
        'ygo-tcg': 'Yu-Gi-Oh! TCG',
        'master-duel': 'Master Duel',
        'duel-links': 'Duel Links'
    }[decklist.game] || decklist.game;

    const archetypeTag = decklist.archetype ? `<span style="display: inline-block; background: var(--primary-color); color: white; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.75rem; margin-left: 0.5rem;">${escapeHtml(decklist.archetype)}</span>` : '';

    return `
        <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 0.8rem; background: var(--light-bg);">
            <div style="display: flex; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
                <div><strong>${escapeHtml(decklist.name)}</strong>${archetypeTag}</div>
                <span style="font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(gameLabel)} • ${decklist.isPublic === false ? 'Private' : 'Public'}</span>
            </div>
            <div style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 0.3rem;">
                Updated ${new Date(decklist.updatedAt || decklist.createdAt).toLocaleString()}
            </div>
            <details style="margin-top: 0.45rem;">
                <summary style="cursor: pointer; color: var(--text-secondary); font-size: 0.85rem;">Preview</summary>
                <div style="margin-top: 0.45rem; font-size: 0.85rem;">
                    <div style="font-weight: 600;">Main Deck</div>
                    <pre style="white-space: pre-wrap; margin: 0.2rem 0 0.5rem 0; font-family: inherit;">${escapeHtml(decklist.mainDeck || '')}</pre>
                    ${decklist.extraDeck ? `<div style="font-weight: 600;">Extra Deck</div><pre style="white-space: pre-wrap; margin: 0.2rem 0 0.5rem 0; font-family: inherit;">${escapeHtml(decklist.extraDeck)}</pre>` : ''}
                    ${decklist.sideDeck ? `<div style="font-weight: 600;">Side Deck</div><pre style="white-space: pre-wrap; margin: 0.2rem 0 0.5rem 0; font-family: inherit;">${escapeHtml(decklist.sideDeck)}</pre>` : ''}
                    ${decklist.notes ? `<div style="font-weight: 600;">Notes</div><p style="margin-top: 0.2rem;">${escapeHtml(decklist.notes)}</p>` : ''}
                </div>
            </details>
            <div style="display: flex; gap: 0.45rem; margin-top: 0.6rem; flex-wrap: wrap;">
                <button class="btn" style="margin: 0;" onclick="viewDecklist('${decklist._id}')">View</button>
                <button class="btn secondary" style="margin: 0;" onclick="editDecklist('${decklist._id}')">Edit</button>
                <button class="btn danger" style="margin: 0;" onclick="deleteDecklist('${decklist._id}')">Delete</button>
            </div>
        </div>
    `;
}

async function viewDecklist(decklistId, options = {}) {
    if (!decklistId) return;

    if (!options.refresh) {
        activateSection('decklist-detail', true);
        if (options.updateUrl !== false) {
            updateBrowserUrl(`/decklists/${encodeURIComponent(decklistId)}`);
        }
    }

    const container = document.getElementById('decklist-detail-content');
    if (!container) return;

    if (!options.refresh) {
        container.innerHTML = '<div class="empty-state">Loading decklist...</div>';
    }

    try {
        const token = localStorage.getItem('token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const response = await fetch(`${API_URL}/decklists/${decklistId}`, {
            headers,
            suppressLoading: options.suppressLoading === true
        });
        const data = await response.json();

        if (!response.ok) {
            container.innerHTML = `<div class="empty-state">${escapeHtml(data.error || 'Unable to load decklist')}</div>`;
            return;
        }

        currentDecklistDetail = data;
        decklistDetailViewMode = 'text';
        await renderDecklistDetailContent();
    } catch (error) {
        container.innerHTML = '<div class="empty-state">Unable to load decklist right now.</div>';
    }
}

async function renderDecklists(options = {}) {
    const container = document.getElementById('decklist-list');
    if (!container) return;

    const shouldForceOverlay = options.suppressLoading !== true;
    if (shouldForceOverlay) {
        beginGlobalLoading({
            immediate: true,
            message: 'Loading decklists...'
        });
    }

    container.innerHTML = '<div class="empty-state">Loading decklists...</div>';

    try {
        await loadMyDecklists(options);

        const visibilityFilter = document.getElementById('decklist-visibility-filter')?.value || 'all';
        const filteredDecklists = myDecklists.filter((decklist) => {
            if (visibilityFilter === 'public') return decklist.isPublic !== false;
            if (visibilityFilter === 'private') return decklist.isPublic === false;
            return true;
        });

        if (myDecklists.length === 0) {
            container.innerHTML = '<div class="empty-state">No decklists saved yet.</div>';
            return;
        }

        if (filteredDecklists.length === 0) {
            container.innerHTML = '<div class="empty-state">No decklists match this visibility filter.</div>';
            return;
        }

        container.innerHTML = filteredDecklists.map(renderDecklistCard).join('');
    } catch (error) {
        container.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Error loading decklists')}</div>`;
    } finally {
        if (shouldForceOverlay) {
            endGlobalLoading();
        }
    }
}

async function promptDecklistSelectionForJoin(tournamentGame = null) {
    await loadMyDecklists();

    const availableDecklists = tournamentGame
        ? myDecklists.filter((decklist) => decklist.game === tournamentGame)
        : myDecklists;

    if (availableDecklists.length === 0) {
        alert('Please create at least one decklist for this format before joining.');
        switchSection('decklists');
        return null;
    }

    const optionsText = availableDecklists
        .map((decklist, index) => `${index + 1}. ${decklist.name} (${decklist.game})`)
        .join('\n');

    const selectedRaw = prompt(`Choose a decklist number to submit:\n\n${optionsText}`);
    if (selectedRaw === null) return null;

    const selectedIndex = Number.parseInt(selectedRaw, 10) - 1;
    if (Number.isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= availableDecklists.length) {
        alert('Invalid decklist selection.');
        return null;
    }

    return availableDecklists[selectedIndex];
}

async function leaveTournament(id) {
    if (!requireAuth('leave tournaments')) return;

    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/tournaments/${id}/leave`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (response.ok) {
            renderTournaments();
            refreshTournamentDetailIfOpen(id);
        } else {
            alert(data.error || 'Failed to leave tournament');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function deleteTournament(id, returnToDashboardOnSuccess = false) {
    if (!requireAuth('delete tournaments')) return;
    if (!confirm('Delete this tournament?')) return;

    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/tournaments/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            renderTournaments();
            if (returnToDashboardOnSuccess) {
                switchSection('dashboard');
            }
        } else {
            alert('Failed to delete tournament');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function startTournament(id) {
    if (!requireAuth('start tournaments')) return;
    if (!confirm('Start this tournament? You need at least 4 players.')) return;

    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/tournaments/${id}/start`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (response.ok) {
            renderTournaments();
            refreshTournamentDetailIfOpen(id);
        } else {
            alert(data.error || 'Failed to start tournament');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function completeTournament(id) {
    if (!requireAuth('complete tournaments')) return;
    if (!confirm('Mark this tournament as completed?')) return;

    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/tournaments/${id}/complete`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (response.ok) {
            renderTournaments();
            refreshTournamentDetailIfOpen(id);
        } else {
            alert(data.error || 'Failed to complete tournament');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function checkInToTournament(id) {
    if (!requireAuth('check in to tournaments')) return;

    try {
        beginGlobalLoading({ immediate: true, message: 'Checking in...' });
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/tournaments/${id}/checkin`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (response.ok) {
            refreshTournamentDetailIfOpen(id);
            addNotification('You have checked in! ✓', 'success');
        } else {
            alert(data.error || 'Failed to check in');
        }
    } catch (error) {
        alert('Network error');
    } finally {
        endGlobalLoading();
    }
}

async function startTopCut(id) {
    if (!requireAuth('manage tournaments')) return;
    if (!confirm('Start top cut bracket from Swiss standings?')) return;

    try {
        beginGlobalLoading({ immediate: true, message: 'Starting top cut...' });
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/tournaments/${id}/start-top-cut`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (response.ok) {
            refreshTournamentDetailIfOpen(id);
            addNotification('Top cut bracket created!', 'success');
        } else {
            alert(data.error || 'Failed to start top cut');
        }
    } catch (error) {
        alert('Network error');
    } finally {
        endGlobalLoading();
    }
}

function refreshTournamentDetailIfOpen(tournamentId) {
    const isDetailOpen = document.getElementById('tournament-detail').classList.contains('active');
    if (isDetailOpen) {
        viewTournament(tournamentId);
    }
}

function renderStandingsSection(tournament) {
    const standings = tournament.standings || [];
    if (standings.length === 0) return '';

    const standingsRows = standings.map((entry) => `
        <tr>
            <td style="padding: 0.6rem; border-bottom: 1px solid var(--border-color); font-weight: 600;">${entry.rank}</td>
            <td style="padding: 0.6rem; border-bottom: 1px solid var(--border-color);">${createUserLink({ _id: entry.playerId, username: entry.username }, entry.username)}</td>
            <td style="padding: 0.6rem; border-bottom: 1px solid var(--border-color); text-align: center;">${entry.points}</td>
            <td style="padding: 0.6rem; border-bottom: 1px solid var(--border-color); text-align: center;">${entry.wins}-${entry.losses}-${entry.draws}</td>
            <td style="padding: 0.6rem; border-bottom: 1px solid var(--border-color); text-align: center;">${entry.byes}</td>
            <td style="padding: 0.6rem; border-bottom: 1px solid var(--border-color); text-align: center;">${Math.round((entry.opponentMatchWinPct || 0) * 100)}%</td>
        </tr>
    `).join('');

    return `
        <div style="margin-bottom: 2rem;">
            <h3 style="margin-bottom: 0.75rem; color: var(--text-primary);">Standings</h3>
            <div style="overflow-x: auto; border: 1px solid var(--border-color); border-radius: 8px;">
                <table style="width: 100%; border-collapse: collapse; background-color: var(--card-bg); min-width: 560px;">
                    <thead>
                        <tr style="background-color: var(--light-bg); color: var(--text-secondary);">
                            <th style="padding: 0.6rem; text-align: left;">#</th>
                            <th style="padding: 0.6rem; text-align: left;">Player</th>
                            <th style="padding: 0.6rem; text-align: center;">Pts</th>
                            <th style="padding: 0.6rem; text-align: center;">W-L-D</th>
                            <th style="padding: 0.6rem; text-align: center;">Byes</th>
                            <th style="padding: 0.6rem; text-align: center;">OMW%</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${standingsRows}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function getMatchResultText(match) {
    if (match.result === 'bye') {
        return 'Bye (auto win)';
    }
    if (match.result === 'draw') {
        return 'Draw';
    }
    if (match.result === 'player1') {
        return `${createUserLink(match.player1, 'Player 1')} won`;
    }
    if (match.result === 'player2') {
        return `${createUserLink(match.player2, 'Player 2')} won`;
    }
    return 'Pending';
}

function getMatchResultStatus(match) {
    if (match.resultStatus) return match.resultStatus;
    return match.result === 'pending' ? 'pending' : 'confirmed';
}

function isRoundLocked(round) {
    return ['locked', 'completed'].includes(round?.status);
}

function getRoundStatusLabel(round) {
    if (round?.status === 'not_started') return 'Not Started';
    if (isRoundLocked(round)) return 'Locked';
    return 'Active';
}

function getRoundStatusBadgeClass(round) {
    if (round?.status === 'not_started') return 'status-registration';
    if (isRoundLocked(round)) return 'status-completed';
    return 'status-active';
}

function renderCorrectionButton(tournament, match, isCreator) {
    const matchStatus = getMatchResultStatus(match);
    const canReopen = isCreator
        && ['active', 'completed'].includes(tournament.status)
        && match.player2
        && match.result !== 'bye'
        && !(match.result === 'pending' && matchStatus === 'pending');

    if (!canReopen) return '';

    return `<button class="btn danger" style="margin: 0; padding: 0.35rem 0.65rem;" onclick="reopenMatchResult('${tournament._id}', '${match._id}')">Reopen For Correction</button>`;
}

function renderDisputeHistoryPanel(match) {
    const history = match.disputeHistory || [];
    if (!history.length) return '';

    const entries = [...history].reverse().map((entry, index) => {
        const disputedBy = createUserLink(entry.disputedBy, 'Unknown');
        const disputedAt = entry.disputedAt ? new Date(entry.disputedAt).toLocaleString() : 'Unknown time';
        const resolvedBy = createUserLink(entry.resolvedBy, 'Unresolved');
        const resolvedAt = entry.resolvedAt ? new Date(entry.resolvedAt).toLocaleString() : 'Pending';
        const statusText = entry.status === 'open'
            ? 'Open Dispute'
            : entry.status === 'reopened'
                ? 'Reopened For Correction'
                : 'Resolved';
        const resolvedResult = entry.resolvedResult
            ? `Resolved result: ${entry.resolvedResult}`
            : '';

        return `
            <div style="padding: 0.55rem; border: 1px solid var(--border-color); border-radius: 6px; background-color: var(--card-bg); margin-bottom: 0.45rem;">
                <div style="display: flex; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.3rem;">
                    <strong style="font-size: 0.83rem;">Case ${history.length - index}</strong>
                    <span style="font-size: 0.78rem; color: var(--text-secondary);">${statusText}</span>
                </div>
                <div style="font-size: 0.8rem; color: var(--text-secondary);">Disputed by ${disputedBy} at ${disputedAt}</div>
                <div style="font-size: 0.82rem; color: var(--text-primary); margin-top: 0.2rem;">Reason: ${entry.reason || 'No reason provided'}</div>
                ${entry.status !== 'open' ? `<div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.2rem;">Resolved by ${resolvedBy} at ${resolvedAt}</div>` : ''}
                ${entry.resolutionNote ? `<div style="font-size: 0.82rem; color: var(--text-primary); margin-top: 0.2rem;">Resolution: ${entry.resolutionNote}</div>` : ''}
                ${resolvedResult ? `<div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.2rem;">${resolvedResult}</div>` : ''}
            </div>
        `;
    }).join('');

    return `
        <details style="margin-top: 0.55rem;">
            <summary style="cursor: pointer; font-size: 0.82rem; color: var(--text-secondary);">Dispute History (${history.length})</summary>
            <div style="margin-top: 0.5rem;">${entries}</div>
        </details>
    `;
}

function renderResolveButtons(tournament, match) {
    const drawButton = tournament.format === 'swiss'
        ? `<button class="btn secondary" style="margin: 0; padding: 0.35rem 0.65rem;" onclick="resolveMatchResult('${tournament._id}', '${match._id}', 'draw')">Resolve Draw</button>`
        : '';

    return `
        <div style="display: flex; gap: 0.45rem; flex-wrap: wrap; margin-top: 0.45rem;">
            <button class="btn secondary" style="margin: 0; padding: 0.35rem 0.65rem;" onclick="resolveMatchResult('${tournament._id}', '${match._id}', 'player1')">Resolve P1 Win</button>
            ${drawButton}
            <button class="btn secondary" style="margin: 0; padding: 0.35rem 0.65rem;" onclick="resolveMatchResult('${tournament._id}', '${match._id}', 'player2')">Resolve P2 Win</button>
        </div>
    `;
}

function renderRoundMatchActions(tournament, round, match, isCreator, currentUserId) {
    const roundIsActive = round?.status === 'active';
    const matchStatus = getMatchResultStatus(match);
    const isFinal = match.result === 'bye' || matchStatus === 'confirmed';
    const correctionButton = renderCorrectionButton(tournament, match, isCreator);

    if (!roundIsActive && !isFinal) {
        const waitingMessage = round?.status === 'not_started'
            ? 'Round has not started yet. Organizer must start it first.'
            : isRoundLocked(round)
                ? 'Round is locked. Organizer can reopen this match for corrections.'
                : 'Round is not active right now.';

        return `
            <div style="font-size: 0.85rem; color: var(--text-secondary);">${waitingMessage}</div>
            <div style="display: flex; gap: 0.45rem; flex-wrap: wrap; margin-top: 0.45rem;">${correctionButton}</div>
        `;
    }

    if (isFinal) {
        return `
            <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.35rem;">Result: ${getMatchResultText(match)}</div>
            <div style="display: flex; gap: 0.45rem; flex-wrap: wrap;">${correctionButton}</div>
        `;
    }

    const player1Id = getEntityId(match.player1);
    const player2Id = getEntityId(match.player2);
    const isParticipant = isSameId(currentUserId, player1Id) || isSameId(currentUserId, player2Id);
    const canReport = tournament.status === 'active' && roundIsActive && (
        isCreator || isParticipant
    );

    if (matchStatus === 'disputed') {
        const disputeLine = match.disputeReason
            ? `Disputed: ${match.disputeReason}`
            : 'Disputed result awaiting organizer review.';
        const resolveControls = tournament.status === 'active' && roundIsActive && isCreator
            ? renderResolveButtons(tournament, match)
            : '';

        return `
            <div style="font-size: 0.85rem; color: var(--danger);">${disputeLine}</div>
            ${resolveControls}
            <div style="display: flex; gap: 0.45rem; flex-wrap: wrap; margin-top: 0.45rem;">${correctionButton}</div>
        `;
    }

    if (matchStatus === 'awaiting-confirmation') {
        const confirmedIds = (match.confirmedBy || []).map(getEntityId);
        const alreadyConfirmed = confirmedIds.some((id) => isSameId(id, currentUserId));
        const canConfirm = tournament.status === 'active' && roundIsActive && (isParticipant || isCreator) && !alreadyConfirmed;
        const canDispute = tournament.status === 'active' && roundIsActive && (isParticipant || isCreator);
        const confirmationLine = `Reported: ${getMatchResultText(match)}. Confirmations: ${confirmedIds.length}/2`;

        const confirmButton = canConfirm
            ? `<button class="btn secondary" style="margin: 0; padding: 0.35rem 0.65rem;" onclick="confirmMatchResult('${tournament._id}', '${match._id}')">Confirm</button>`
            : '';
        const disputeButton = canDispute
            ? `<button class="btn danger" style="margin: 0; padding: 0.35rem 0.65rem;" onclick="disputeMatchResult('${tournament._id}', '${match._id}')">Dispute</button>`
            : '';
        const resolveControls = tournament.status === 'active' && roundIsActive && isCreator
            ? renderResolveButtons(tournament, match)
            : '';

        return `
            <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.4rem;">${confirmationLine}</div>
            <div style="display: flex; gap: 0.45rem; flex-wrap: wrap;">${confirmButton}${disputeButton}</div>
            ${resolveControls}
            <div style="display: flex; gap: 0.45rem; flex-wrap: wrap; margin-top: 0.45rem;">${correctionButton}</div>
        `;
    }

    if (!canReport) {
        return '<div style="font-size: 0.85rem; color: var(--text-secondary);">Waiting for players or organizer to report.</div>';
    }

    const drawButton = tournament.format === 'swiss'
        ? `<button class="btn secondary" style="margin: 0; padding: 0.4rem 0.7rem;" onclick="reportMatchResult('${tournament._id}', '${match._id}', 'draw')">Draw</button>`
        : '';

    return `
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
            <button class="btn secondary" style="margin: 0; padding: 0.4rem 0.7rem;" onclick="reportMatchResult('${tournament._id}', '${match._id}', 'player1')">Report P1 Win</button>
            ${drawButton}
            <button class="btn secondary" style="margin: 0; padding: 0.4rem 0.7rem;" onclick="reportMatchResult('${tournament._id}', '${match._id}', 'player2')">Report P2 Win</button>
            ${correctionButton}
        </div>
    `;
}

function getMatchBracketKey(tournament, match) {
    if (match.bracket) return match.bracket;
    if (tournament.format === 'single-elim') return 'single';
    if (tournament.format === 'double-elim') return 'winners';
    return 'swiss';
}

function renderBracketMatchCard(tournament, round, match, isCreator, currentUserId) {
    const player1Name = match.player1 ? createUserLink(match.player1, 'TBD') : 'TBD';
    const player2Name = match.player2 ? createUserLink(match.player2, 'BYE') : 'BYE';
    const matchStatus = getMatchResultStatus(match);
    const isCompleted = match.result === 'bye' || matchStatus === 'confirmed';
    const statusLabel = isCompleted
        ? 'Confirmed'
        : matchStatus === 'awaiting-confirmation'
            ? 'Awaiting Confirm'
            : matchStatus === 'disputed'
                ? 'Disputed'
                : 'Pending';
    const badgeClass = isCompleted
        ? 'status-completed'
        : matchStatus === 'disputed'
            ? 'status-registration'
            : 'status-active';

    return `
        <div style="padding: 0.85rem; border: 1px solid var(--border-color); border-radius: 6px; background-color: var(--card-bg); margin-bottom: 0.65rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem; flex-wrap: wrap;">
                <strong style="font-size: 0.9rem;">Table ${match.tableNumber}</strong>
                <span class="status-badge ${badgeClass}">${statusLabel}</span>
            </div>
            <div style="margin-bottom: 0.6rem; color: var(--text-primary); font-size: 0.95rem;">
                ${player1Name} vs ${player2Name}
            </div>
            ${renderRoundMatchActions(tournament, round, match, isCreator, currentUserId)}
            ${renderDisputeHistoryPanel(match)}
        </div>
    `;
}

function renderEliminationBracketSection(tournament, bracketKey, title, isCreator, currentUserId) {
    const rounds = tournament.rounds || [];

    const roundColumns = rounds.map((round) => {
        const matches = (round.matches || []).filter((match) => getMatchBracketKey(tournament, match) === bracketKey);
        if (matches.length === 0) return '';

        const matchCards = matches.map((match) => renderBracketMatchCard(tournament, round, match, isCreator, currentUserId)).join('');

        return `
            <div style="min-width: 260px; max-width: 280px; border: 1px solid var(--border-color); border-radius: 8px; padding: 0.8rem; background-color: var(--light-bg);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem; gap: 0.5rem;">
                    <strong style="font-size: 0.95rem;">Round ${round.number}</strong>
                    <span class="status-badge ${getRoundStatusBadgeClass(round)}">${getRoundStatusLabel(round)}</span>
                </div>
                ${matchCards}
            </div>
        `;
    }).filter(Boolean).join('');

    if (!roundColumns) return '';

    return `
        <div style="margin-bottom: 1.25rem;">
            <h4 style="margin-bottom: 0.6rem; color: var(--text-primary);">${title}</h4>
            <div style="display: flex; gap: 0.9rem; overflow-x: auto; padding-bottom: 0.4rem;">
                ${roundColumns}
            </div>
        </div>
    `;
}

function renderEliminationBrackets(tournament, isCreator, currentUserId) {
    if (tournament.format === 'single-elim') {
        return renderEliminationBracketSection(
            tournament,
            'single',
            'Single Elimination Bracket',
            isCreator,
            currentUserId
        );
    }

    if (tournament.format === 'double-elim') {
        const winners = renderEliminationBracketSection(
            tournament,
            'winners',
            'Winners Bracket',
            isCreator,
            currentUserId
        );
        const losers = renderEliminationBracketSection(
            tournament,
            'losers',
            'Losers Bracket',
            isCreator,
            currentUserId
        );
        const grandFinal = renderEliminationBracketSection(
            tournament,
            'grand-final',
            'Grand Final',
            isCreator,
            currentUserId
        );

        return `${winners}${losers}${grandFinal}`;
    }

    return '';
}

function renderSwissBoardColumns(tournament, isCreator, currentUserId) {
    const rounds = tournament.rounds || [];
    if (!rounds.length) return '';

    const columns = rounds.map((round) => {
        const matchCards = (round.matches || [])
            .map((match) => renderBracketMatchCard(tournament, round, match, isCreator, currentUserId))
            .join('');

        return `
            <div style="min-width: 280px; max-width: 300px; border: 1px solid var(--border-color); border-radius: 8px; padding: 0.8rem; background-color: var(--light-bg);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem; gap: 0.5rem;">
                    <strong style="font-size: 0.95rem;">Round ${round.number}</strong>
                    <span class="status-badge ${getRoundStatusBadgeClass(round)}">${getRoundStatusLabel(round)}</span>
                </div>
                ${matchCards}
            </div>
        `;
    }).join('');

    return `<div style="display: flex; gap: 0.9rem; overflow-x: auto; padding-bottom: 0.4rem;">${columns}</div>`;
}

function setTournamentRoundViewMode(mode) {
    if (!['board', 'list'].includes(mode)) return;
    tournamentRoundViewMode = mode;

    if (currentTournamentDetailId) {
        viewTournament(currentTournamentDetailId, { refresh: true });
    }
}

function renderRoundsSection(tournament, isCreator, currentUserId) {
    const rounds = tournament.rounds || [];

    if (rounds.length === 0) {
        if (tournament.status === 'registration') {
            return '<div style="margin-bottom: 2rem; color: var(--text-secondary);">Rounds and pairings will appear after the tournament is started.</div>';
        }
        return '<div style="margin-bottom: 2rem; color: var(--text-secondary);">No rounds available yet.</div>';
    }

    const roundCards = rounds.map((round) => {
        const matchesHtml = (round.matches || [])
            .map((match) => renderBracketMatchCard(tournament, round, match, isCreator, currentUserId))
            .join('');

        const timerHTML = round.timerStartedAt && (tournament.roundTimerMinutes || 0) > 0
            ? `<div style="font-size: 0.9rem; margin-left: auto;">${formatRoundTimeRemaining(round.timerStartedAt, tournament.roundTimerMinutes)}</div>`
            : '';

        return `
            <div style="margin-bottom: 1rem; padding: 1rem; border: 1px solid var(--border-color); border-radius: 8px; background-color: var(--light-bg);">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap;">
                    <h4 style="margin: 0; color: var(--text-primary);">Round ${round.number}</h4>
                    <span class="status-badge ${getRoundStatusBadgeClass(round)}">${getRoundStatusLabel(round)}</span>
                    ${timerHTML}
                </div>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                    ${matchesHtml}
                </div>
            </div>
        `;
    }).join('');

    const roundMeta = tournament.roundMeta || {};
    const canStartPendingRound = isCreator && !!roundMeta.canStartPendingRound && !!roundMeta.pendingRoundId;
    const canLockActiveRound = isCreator && !!roundMeta.canLockActiveRound && !!roundMeta.activeRoundId;
    const canGenerateNextRound = isCreator && !!roundMeta.canGenerateNextRound;
    const unresolvedCount = roundMeta.unresolvedMatchCount || 0;
    const disputedCount = roundMeta.disputedMatchCount || 0;
    const blockReason = roundMeta.hasPendingRound
        ? 'A generated round is waiting to be started.'
        : disputedCount > 0
        ? `${disputedCount} disputed match${disputedCount === 1 ? '' : 'es'} must be resolved first.`
        : unresolvedCount > 0
            ? `${unresolvedCount} reported match result${unresolvedCount === 1 ? '' : 's'} still need confirmation.`
            : 'Complete all pending matches to unlock the next round.';

    const organizerButtons = [
        canStartPendingRound
            ? `<button class="btn" onclick="startRound('${tournament._id}', '${roundMeta.pendingRoundId}')">Start Next Round</button>`
            : '',
        canLockActiveRound
            ? `<button class="btn" onclick="lockRound('${tournament._id}', '${roundMeta.activeRoundId}')">Lock Active Round</button>`
            : '',
        canGenerateNextRound
            ? `<button class="btn" onclick="createNextRound('${tournament._id}')">Generate Next Round</button>`
            : ''
    ].filter(Boolean).join(' ');

    const organizerActions = organizerButtons
        ? `<div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem;">${organizerButtons}</div>`
        : isCreator && tournament.status === 'active'
            ? `<div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">${roundMeta.canCompleteNow ? 'Final round is locked and winner is declared. You can complete the tournament above.' : roundMeta.isConcluded ? 'Winner is determined. Lock the active round to complete the tournament.' : blockReason}</div>`
            : '';

    const roundsPlayed = roundMeta.roundsPlayed || rounds.length;
    const suggestedRounds = roundMeta.recommendedSwissRounds || '-';
    const remainingPlayers = roundMeta.remainingPlayers ?? '-';
    const formatProgress = tournament.format === 'swiss'
        ? `Rounds played: ${roundsPlayed} / Suggested Swiss rounds: ${suggestedRounds}`
        : `Rounds played: ${roundsPlayed} / Remaining players: ${remainingPlayers}`;

    const eliminationBrackets = renderEliminationBrackets(tournament, isCreator, currentUserId);
    const swissBoard = renderSwissBoardColumns(tournament, isCreator, currentUserId);
    const boardContent = tournament.format === 'swiss'
        ? (swissBoard || roundCards)
        : (eliminationBrackets || roundCards);
    const roundsContent = tournamentRoundViewMode === 'list' ? roundCards : boardContent;
    const viewToggle = `
        <div style="display:flex; gap:0.45rem; flex-wrap:wrap; margin-bottom:0.85rem;">
            <button class="btn ${tournamentRoundViewMode === 'board' ? '' : 'secondary'}" style="margin:0;" onclick="setTournamentRoundViewMode('board')">Board View</button>
            <button class="btn ${tournamentRoundViewMode === 'list' ? '' : 'secondary'}" style="margin:0;" onclick="setTournamentRoundViewMode('list')">List View</button>
        </div>
    `;

    return `
        <div style="margin-bottom: 2rem;">
            <h3 style="margin-bottom: 0.5rem; color: var(--text-primary);">Rounds & Pairings</h3>
            <p style="margin-bottom: 1rem; font-size: 0.9rem; color: var(--text-secondary);">${formatProgress}</p>
            ${viewToggle}
            ${organizerActions}
            ${roundsContent}
        </div>
    `;
}

async function reportMatchResult(tournamentId, matchId, result) {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please log in to report a match result.');
        return;
    }

    const confirmLabel = {
        player1: 'Player 1 wins',
        player2: 'Player 2 wins',
        draw: 'Draw'
    }[result] || result;

    if (!confirm(`Report this match as: ${confirmLabel}?`)) return;

    try {
        const response = await fetch(`${API_URL}/tournaments/${tournamentId}/matches/${matchId}/report`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ result })
        });

        const data = await response.json();

        if (response.ok) {
            await viewTournament(tournamentId);
            renderTournaments();
            addNotification('Match result reported.', 'success');
        } else {
            alert(data.error || 'Failed to report match result');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function confirmMatchResult(tournamentId, matchId) {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please log in to confirm a match result.');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/tournaments/${tournamentId}/matches/${matchId}/confirm`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (response.ok) {
            await viewTournament(tournamentId);
            renderTournaments();
            addNotification('Match result confirmed.', 'success');
        } else {
            alert(data.error || 'Failed to confirm result');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function disputeMatchResult(tournamentId, matchId) {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please log in to dispute a match result.');
        return;
    }

    const reason = prompt('Reason for dispute (optional):', 'Result does not match what happened at the table.') || '';

    try {
        const response = await fetch(`${API_URL}/tournaments/${tournamentId}/matches/${matchId}/dispute`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ reason })
        });

        const data = await response.json();

        if (response.ok) {
            await viewTournament(tournamentId);
            renderTournaments();
            addNotification('Match result disputed.', 'warning');
        } else {
            alert(data.error || 'Failed to dispute result');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function resolveMatchResult(tournamentId, matchId, result) {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please log in to resolve a disputed result.');
        return;
    }

    const note = prompt('Resolution note (optional):', 'Organizer decision recorded.') || '';

    if (!confirm('Apply organizer resolution for this match?')) return;

    try {
        const response = await fetch(`${API_URL}/tournaments/${tournamentId}/matches/${matchId}/resolve`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ result, note })
        });

        const data = await response.json();

        if (response.ok) {
            await viewTournament(tournamentId);
            renderTournaments();
            addNotification('Organizer resolved a match result.', 'success');
        } else {
            alert(data.error || 'Failed to resolve match result');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function reopenMatchResult(tournamentId, matchId) {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please log in to reopen a match result.');
        return;
    }

    const note = prompt('Correction note (optional):', 'Result reopened by organizer for correction.') || '';

    if (!confirm('Reopen this match result for correction?')) return;

    try {
        const response = await fetch(`${API_URL}/tournaments/${tournamentId}/matches/${matchId}/reopen`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ note })
        });

        const data = await response.json();

        if (response.ok) {
            await viewTournament(tournamentId);
            renderTournaments();
            addNotification('Match reopened for correction.', 'warning');
        } else {
            alert(data.error || 'Failed to reopen match result');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function createNextRound(tournamentId) {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please log in to generate the next round.');
        return;
    }

    if (!confirm('Generate the next round pairings now? This creates the round in Not Started status.')) return;

    try {
        const response = await fetch(`${API_URL}/tournaments/${tournamentId}/rounds/next`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (response.ok) {
            await viewTournament(tournamentId);
            renderTournaments();
            addNotification('Next round generated.', 'success');
        } else {
            alert(data.error || 'Failed to generate next round');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function startRound(tournamentId, roundId) {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please log in to start rounds.');
        return;
    }

    if (!confirm('Start this round now? Match reporting will be enabled.')) return;

    try {
        const response = await fetch(`${API_URL}/tournaments/${tournamentId}/rounds/${roundId}/start`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (response.ok) {
            await viewTournament(tournamentId);
            renderTournaments();
            addNotification('Round started.', 'success');
        } else {
            alert(data.error || 'Failed to start round');
        }
    } catch (error) {
        alert('Network error');
    }
}

async function lockRound(tournamentId, roundId) {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please log in to lock rounds.');
        return;
    }

    if (!confirm('Lock this round? Results must already be confirmed.')) return;

    try {
        const response = await fetch(`${API_URL}/tournaments/${tournamentId}/rounds/${roundId}/lock`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (response.ok) {
            await viewTournament(tournamentId);
            renderTournaments();
            addNotification('Round locked.', 'success');
        } else {
            alert(data.error || 'Failed to lock round');
        }
    } catch (error) {
        alert('Network error');
    }
}

function renderProfileTournamentRows(tournaments, emptyText) {
    if (!Array.isArray(tournaments) || tournaments.length === 0) {
        return `<div class="empty-state" style="padding: 1rem;">${emptyText}</div>`;
    }

    return tournaments.map((tournament) => {
        const statusLabel = {
            registration: 'Open',
            active: 'Live',
            completed: 'Finished'
        }[tournament.status] || 'Open';

        const formatLabel = {
            swiss: 'Swiss',
            'single-elim': 'Single Elimination',
            'double-elim': 'Double Elimination'
        }[tournament.format] || tournament.format;

        return `
            <div style="padding: 0.75rem; border: 1px solid var(--border-color); border-radius: 6px; background: var(--card-bg); display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <div>
                    <button class="user-link" onclick="viewTournament('${tournament._id}')">${escapeHtml(tournament.name)}</button>
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">${formatLabel} • ${statusLabel}</div>
                </div>
                <span style="font-size: 0.8rem; color: var(--text-secondary);">${new Date(tournament.createdAt).toLocaleDateString()}</span>
            </div>
        `;
    }).join('');
}

function renderProfileRecentMatches(matches) {
    if (!Array.isArray(matches) || matches.length === 0) {
        return '<div class="empty-state" style="padding: 1rem;">No recorded match history yet.</div>';
    }

    return matches.map((match) => {
        const outcomeLabel = {
            win: 'Win',
            loss: 'Loss',
            draw: 'Draw',
            bye: 'Bye'
        }[match.outcome] || 'Match';

        return `
            <div style="padding: 0.75rem; border: 1px solid var(--border-color); border-radius: 6px; background: var(--card-bg); display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <div>
                    <button class="user-link" onclick="viewTournament('${match.tournamentId}')">${escapeHtml(match.tournamentName)}</button>
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">${outcomeLabel}</div>
                </div>
                <span style="font-size: 0.8rem; color: var(--text-secondary);">${new Date(match.reportedAt).toLocaleDateString()}</span>
            </div>
        `;
    }).join('');
}

async function saveMyProfile(buttonEl = null) {
    if (!requireAuth('update your profile')) return;

    const saveBtn = buttonEl || document.querySelector('#user-profile-content button.btn[onclick^="saveMyProfile"]');
    const originalSaveText = saveBtn ? saveBtn.textContent : 'Save Profile';

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
    }

    beginGlobalLoading({
        immediate: true,
        message: 'Saving profile...'
    });

    const token = localStorage.getItem('token');
    const payload = {
        avatarUrl: document.getElementById('profile-avatar-url')?.value || '',
        bio: document.getElementById('profile-bio')?.value || '',
        location: document.getElementById('profile-location')?.value || '',
        favoriteGame: document.getElementById('profile-favorite-game')?.value || '',
        favoriteDeck: document.getElementById('profile-favorite-deck')?.value || '',
        website: document.getElementById('profile-website')?.value || ''
    };

    try {
        const response = await fetch(`${API_URL}/users/me`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok) {
            alert(data.error || 'Failed to save profile');
            return;
        }

        setLoadingScreenMessage('Refreshing profile...');
        await viewUserProfile(getEntityId(data));
        alert('Profile updated.');
    } catch (error) {
        alert('Network error while updating profile');
    } finally {
        endGlobalLoading();

        if (saveBtn && saveBtn.isConnected) {
            saveBtn.disabled = false;
            saveBtn.textContent = originalSaveText;
        }
    }
}

async function viewUserProfile(userId, options = {}) {
    if (!userId) {
        alert('User profile not found.');
        return;
    }

    currentProfileUserId = userId;

    if (!options.refresh) {
        switchSection('user-profile');
        if (options.updateUrl !== false) {
            updateBrowserUrl(`/users/${encodeURIComponent(userId)}`);
        }
    }
    const container = document.getElementById('user-profile-content');
    if (!options.refresh) {
        container.innerHTML = '<div class="empty-state">Loading user profile...</div>';
    }

    try {
        const response = await fetch(`${API_URL}/users/${userId}`, {
            suppressLoading: options.suppressLoading === true
        });

        const rawResponse = await response.text();
        let payload = null;
        try {
            payload = rawResponse ? JSON.parse(rawResponse) : {};
        } catch (parseError) {
            payload = { error: 'Invalid profile response from server.' };
        }

        if (!response.ok) {
            container.innerHTML = `<div class="empty-state">${payload?.error || 'Unable to load profile.'}</div>`;
            return;
        }

        const profile = {
            _id: payload?._id || userId,
            username: payload?.username || 'Unknown User',
            email: payload?.email || 'Unknown email',
            avatarUrl: payload?.avatarUrl || '',
            bio: payload?.bio || '',
            location: payload?.location || '',
            favoriteGame: payload?.favoriteGame || '',
            favoriteDeck: payload?.favoriteDeck || '',
            website: payload?.website || '',
            createdAt: payload?.createdAt || new Date().toISOString(),
            stats: {
                createdCount: payload?.stats?.createdCount || 0,
                joinedCount: payload?.stats?.joinedCount || 0,
                wins: payload?.stats?.wins || 0,
                losses: payload?.stats?.losses || 0,
                draws: payload?.stats?.draws || 0,
                winRate: payload?.stats?.winRate || 0,
                championships: payload?.stats?.championships || 0
            },
            recentCreatedTournaments: Array.isArray(payload?.recentCreatedTournaments)
                ? payload.recentCreatedTournaments
                : [],
            recentJoinedTournaments: Array.isArray(payload?.recentJoinedTournaments)
                ? payload.recentJoinedTournaments
                : [],
            recentMatches: Array.isArray(payload?.recentMatches)
                ? payload.recentMatches
                : []
        };

        const profileId = getEntityId(profile);
        const isOwnProfile = !!currentUser && isSameId(getCurrentUserId(), profileId);
        const safeWebsite = getSafeExternalUrl(profile.website);

        const createdRows = renderProfileTournamentRows(
            profile.recentCreatedTournaments,
            'No tournaments created yet.'
        );
        const joinedRows = renderProfileTournamentRows(
            profile.recentJoinedTournaments,
            'No tournaments joined yet.'
        );
        const recentMatchRows = renderProfileRecentMatches(profile.recentMatches);

        container.innerHTML = `
            <div style="max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: 1rem;">
                <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; padding: 1.2rem;">
                    <div style="display: flex; gap: 1rem; align-items: flex-start; margin-bottom: 1rem;">
                        <div>${getAvatarHTML(profile, '80px')}</div>
                        <div style="flex: 1;">
                            <h1 style="margin: 0 0 0.3rem 0;">${escapeHtml(profile.username)}</h1>
                            <p style="margin: 0; color: var(--text-secondary);">${escapeHtml(profile.email)}</p>
                        </div>
                    </div>
                    <hr style="margin: 1rem 0; border: none; border-top: 1px solid var(--border-color);">
                    <p style="margin-bottom: 0.35rem;"><strong>Email:</strong> ${escapeHtml(profile.email)}</p>
                    <p style="margin-bottom: 0.35rem;"><strong>Location:</strong> ${escapeHtml(profile.location || 'Not provided')}</p>
                    <p style="margin-bottom: 0.35rem;"><strong>Favorite Game:</strong> ${escapeHtml(profile.favoriteGame || 'Not provided')}</p>
                    <p style="margin-bottom: 0.35rem;"><strong>Favorite Deck:</strong> ${escapeHtml(profile.favoriteDeck || 'Not provided')}</p>
                    <p style="margin-bottom: 0.35rem;"><strong>Website:</strong> ${safeWebsite ? `<a href="${safeWebsite}" target="_blank" rel="noopener noreferrer">${escapeHtml(profile.website)}</a>` : 'Not provided'}</p>
                    <p style="margin-bottom: 0;"><strong>Bio:</strong> ${escapeHtml(profile.bio || 'No bio yet.')}</p>
                </div>

                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.8rem;">
                    <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.9rem;">
                        <div style="color: var(--text-secondary); font-size: 0.85rem;">Tournaments Created</div>
                        <div style="font-size: 1.4rem; font-weight: 700;">${profile.stats?.createdCount || 0}</div>
                    </div>
                    <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.9rem;">
                        <div style="color: var(--text-secondary); font-size: 0.85rem;">Tournaments Joined</div>
                        <div style="font-size: 1.4rem; font-weight: 700;">${profile.stats?.joinedCount || 0}</div>
                    </div>
                    <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.9rem;">
                        <div style="color: var(--text-secondary); font-size: 0.85rem;">Member Since</div>
                        <div style="font-size: 1rem; font-weight: 700;">${new Date(profile.createdAt).toLocaleDateString()}</div>
                    </div>
                    <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.9rem;">
                        <div style="color: var(--text-secondary); font-size: 0.85rem;">Match Record</div>
                        <div style="font-size: 1rem; font-weight: 700;">${profile.stats?.wins || 0}-${profile.stats?.losses || 0}-${profile.stats?.draws || 0}</div>
                    </div>
                    <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.9rem;">
                        <div style="color: var(--text-secondary); font-size: 0.85rem;">Win Rate</div>
                        <div style="font-size: 1.2rem; font-weight: 700;">${profile.stats?.winRate || 0}%</div>
                    </div>
                    <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.9rem;">
                        <div style="color: var(--text-secondary); font-size: 0.85rem;">Championships</div>
                        <div style="font-size: 1.2rem; font-weight: 700;">${profile.stats?.championships || 0}</div>
                    </div>
                </div>

                ${isOwnProfile ? `
                    <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; padding: 1.1rem;">
                        <h3 style="margin-bottom: 0.9rem;">Edit Your Profile</h3>
                        <div class="form-group">
                            <label for="profile-avatar-url">Avatar URL (leave empty for initials)</label>
                            <input id="profile-avatar-url" type="text" value="${escapeHtml(profile.avatarUrl || '')}" placeholder="https://example.com/avatar.jpg">
                        </div>
                        <div class="form-group">
                            <label for="profile-bio">Bio</label>
                            <textarea id="profile-bio" rows="4">${escapeHtml(profile.bio || '')}</textarea>
                        </div>
                        <div class="form-group">
                            <label for="profile-location">Location</label>
                            <input id="profile-location" type="text" value="${escapeHtml(profile.location || '')}">
                        </div>
                        <div class="form-group">
                            <label for="profile-favorite-game">Favorite Game</label>
                            <input id="profile-favorite-game" type="text" value="${escapeHtml(profile.favoriteGame || '')}">
                        </div>
                        <div class="form-group">
                            <label for="profile-favorite-deck">Favorite Deck</label>
                            <input id="profile-favorite-deck" type="text" value="${escapeHtml(profile.favoriteDeck || '')}">
                        </div>
                        <div class="form-group">
                            <label for="profile-website">Website</label>
                            <input id="profile-website" type="text" value="${escapeHtml(profile.website || '')}">
                        </div>
                        <button class="btn" onclick="saveMyProfile(this)">Save Profile</button>
                    </div>
                ` : ''}

                <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; padding: 1.1rem;">
                    <h3 style="margin-bottom: 0.8rem;">Recent Tournaments Created</h3>
                    <div style="display: flex; flex-direction: column; gap: 0.6rem;">${createdRows}</div>
                </div>

                <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; padding: 1.1rem;">
                    <h3 style="margin-bottom: 0.8rem;">Recent Tournaments Joined</h3>
                    <div style="display: flex; flex-direction: column; gap: 0.6rem;">${joinedRows}</div>
                </div>

                <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; padding: 1.1rem;">
                    <h3 style="margin-bottom: 0.8rem;">Recent Matches</h3>
                    <div style="display: flex; flex-direction: column; gap: 0.6rem;">${recentMatchRows}</div>
                </div>
            </div>
        `;
    } catch (error) {
        console.error('Failed to render profile view:', error);
        container.innerHTML = '<div class="empty-state">Error loading user profile.</div>';
    }
}

async function viewTournament(id, options = {}) {
    if (!options.refresh) {
        switchSection('tournament-detail', { updateUrl: options.updateUrl !== false ? true : false });
        if (options.updateUrl !== false) {
            updateBrowserUrl(`/tournaments/${encodeURIComponent(id)}`);
        }
    }

    currentTournamentDetailId = id;
    const container = document.getElementById('tournament-detail-content');
    if (!options.refresh) {
        container.innerHTML = '<div class="empty-state">Loading tournament details...</div>';
    }

    try {
        const response = await fetch(`${API_URL}/tournaments/${id}`, {
            suppressLoading: options.suppressLoading === true
        });
        const tournament = await response.json();

        if (!response.ok) {
            container.innerHTML = '<div class="empty-state">Tournament not found</div>';
            return;
        }

        const gameLabel = {
            'ygo-tcg': '🎴 Yu-Gi-Oh! TCG',
            'master-duel': '⚡ Master Duel',
            'duel-links': '📱 Duel Links'
        }[tournament.game] || tournament.game;

        const formatLabel = {
            'swiss': 'Swiss',
            'single-elim': 'Single Elimination',
            'double-elim': 'Double Elimination'
        }[tournament.format] || tournament.format;

        const statusClass = `status-${tournament.status || 'registration'}`;
        const statusLabel = {
            'registration': 'Open for Registration',
            'active': 'Tournament Live',
            'completed': 'Tournament Completed'
        }[tournament.status] || 'Open for Registration';

        const currentUserId = getCurrentUserId();
        const isCreator = tournament.createdBy && isSameId(getEntityId(tournament.createdBy), currentUserId);
        const hasJoined = tournament.players && tournament.players.some(p => isSameId(getEntityId(p), currentUserId));
        const isFull = (tournament.currentPlayers || 0) >= tournament.maxPlayers;

        let actionButtons = '';
        if (tournament.status === 'registration' || !tournament.status) {
            if (hasJoined) {
                actionButtons = `<button class="btn secondary" onclick="leaveTournament('${tournament._id}')">Leave Tournament</button>`;
            } else if (isFull) {
                actionButtons = `<button class="btn" disabled>Tournament Full</button>`;
            } else {
                actionButtons = `<button class="btn" onclick="joinTournament('${tournament._id}', '${tournament.game}')">Join Tournament</button>`;
            }
            
            if (isCreator) {
                actionButtons += ` <button class="btn" onclick="startTournament('${tournament._id}')" style="background-color: var(--success);">Start Tournament</button>`;
                actionButtons += ` <button class="btn danger" onclick="deleteTournament('${tournament._id}', true)">Delete Tournament</button>`;
            }
        } else if (tournament.status === 'active') {
            if (hasJoined && !isCreator) {
                const isCheckedIn = (tournament.checkedInPlayerIds || []).includes(currentUserId);
                if (!isCheckedIn) {
                    actionButtons = `<button class="btn" onclick="checkInToTournament('${tournament._id}')">✓ Check In</button>`;
                } else {
                    actionButtons = `<button class="btn secondary" disabled>✓ Checked In</button>`;
                }
            }
            if (isCreator) {
                const actions = [];
                if (tournament.roundMeta?.canStartTopCut) {
                    actions.push(`<button class="btn" onclick="startTopCut('${tournament._id}')" style="background-color: var(--success);">Start Top Cut</button>`);
                }
                if (tournament.roundMeta?.canCompleteNow) {
                    actions.push(`<button class="btn" onclick="completeTournament('${tournament._id}')">Complete Tournament</button>`);
                } else if (!tournament.roundMeta?.canStartTopCut) {
                    actions.push(`<button class="btn" disabled>Winner Not Declared Yet</button>`);
                }
                actionButtons = actions.join(' ');
            }
        }

        const registrationsByUserId = new Map(
            (tournament.registrations || []).map((registration) => [
                getEntityId(registration.user),
                registration
            ])
        );

        const playersList = tournament.players && tournament.players.length > 0
            ? tournament.players.map((player, index) => {
                const playerId = getEntityId(player);
                const isCheckedIn = (tournament.checkedInPlayerIds || []).includes(playerId);
                const checkInBadge = isCheckedIn ? `<span style="display: inline-block; background: var(--success); color: white; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.75rem; margin-left: 0.5rem;">✓ Checked In</span>` : '';
                return `
                <div style="padding: 1rem; background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong>${index + 1}. ${createUserLink(player, player.username || 'Unknown')}${checkInBadge}</strong>
                        <div style="font-size: 0.85rem; color: var(--text-secondary);">${player.email}</div>
                        ${(() => {
                            const registration = registrationsByUserId.get(getEntityId(player));
                            if (!registration) return '<div style="font-size: 0.82rem; color: var(--text-secondary);">Decklist: Not submitted</div>';

                            const deckName = registration.deckName || registration.decklist?.name || 'Submitted Decklist';
                            const deckGame = registration.deckGame || registration.decklist?.game || '';

                            const deckPreview = registration.decklist
                                ? `<details style="margin-top: 0.3rem;"><summary style="cursor: pointer; font-size: 0.8rem; color: var(--text-secondary);">View decklist</summary><div style="margin-top: 0.3rem; font-size: 0.8rem;"><pre style="white-space: pre-wrap; margin: 0; font-family: inherit;">${escapeHtml(registration.decklist.mainDeck || '')}</pre></div></details>`
                                : '';

                            return `<div style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 0.2rem;">Decklist: ${escapeHtml(deckName)}${deckGame ? ` (${escapeHtml(deckGame)})` : ''}</div>${deckPreview}`;
                        })()}
                    </div>
                    ${isCreator && tournament.status === 'registration' ? `<button class="btn danger" style="padding: 0.4rem 0.8rem; font-size: 0.85rem;" onclick="alert('Kick player feature coming soon')">Remove</button>` : ''}
                </div>
            `;
            }).join('')
            : '<div class="empty-state">No players yet</div>';

        container.innerHTML = `
            <div style="max-width: 900px; margin: 0 auto;">
                <div class="tournament-card" style="box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);">
                    <div class="tournament-header">
                        <div class="tournament-title" style="font-size: 1.8rem;">${tournament.name}</div>
                        <div class="tournament-type">${formatLabel} <span class="status-badge ${statusClass}">${statusLabel}</span></div>
                    </div>
                    <div class="tournament-body">
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
                            <div>
                                <strong style="color: var(--text-secondary);">Game Format</strong>
                                <div style="font-size: 1.1rem; margin-top: 0.3rem;">${gameLabel}</div>
                            </div>
                            <div>
                                <strong style="color: var(--text-secondary);">Tournament Type</strong>
                                <div style="font-size: 1.1rem; margin-top: 0.3rem;">${formatLabel}</div>
                            </div>
                            <div>
                                <strong style="color: var(--text-secondary);">Players</strong>
                                <div style="font-size: 1.1rem; margin-top: 0.3rem;">${tournament.currentPlayers || 0} / ${tournament.maxPlayers}</div>
                            </div>
                            <div>
                                <strong style="color: var(--text-secondary);">Created By</strong>
                                <div style="font-size: 1.1rem; margin-top: 0.3rem;">${createUserLink(tournament.createdBy)}</div>
                            </div>
                        </div>

                        ${tournament.description ? `
                            <div style="margin-bottom: 1.5rem; padding: 1rem; background-color: var(--light-bg); border-radius: 6px;">
                                <strong style="color: var(--text-secondary);">Description</strong>
                                <p style="margin-top: 0.5rem;">${tournament.description}</p>
                            </div>
                        ` : ''}

                        <div style="margin-bottom: 1.5rem;">
                            <strong style="color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">Tournament Dates</strong>
                            <div style="font-size: 0.9rem; color: var(--text-secondary);">
                                Created: ${new Date(tournament.createdAt).toLocaleString()}
                                ${tournament.startedAt ? `<br>Started: ${new Date(tournament.startedAt).toLocaleString()}` : ''}
                                ${tournament.completedAt ? `<br>Completed: ${new Date(tournament.completedAt).toLocaleString()}` : ''}
                            </div>
                        </div>

                        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 2rem;">
                            ${actionButtons}
                        </div>

                        ${renderStandingsSection(tournament)}

                        ${renderRoundsSection(tournament, isCreator, currentUserId)}

                        <h3 style="margin-bottom: 1rem; color: var(--text-primary);">Registered Players (${tournament.players?.length || 0})</h3>
                        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                            ${playersList}
                        </div>
                    </div>
                </div>
            </div>
        `;
    } catch (error) {
        container.innerHTML = '<div class="empty-state">Error loading tournament details</div>';
        console.error(error);
    }
}

// Show/hide top-cut selector based on format choice
document.getElementById('tournament-format')?.addEventListener('change', (e) => {
    const group = document.getElementById('tournament-topcut-group');
    if (group) {
        group.style.display = e.target.value === 'swiss' ? '' : 'none';
    }
});

document.getElementById('tournament-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!requireAuth('create tournaments')) return;

    const createBtn = (e.submitter && e.submitter.type === 'submit')
        ? e.submitter
        : document.querySelector('#tournament-form button[type="submit"]');
    const originalCreateText = createBtn ? createBtn.textContent : 'Create Tournament';

    if (createBtn) {
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';
    }

    beginGlobalLoading({
        immediate: true,
        message: 'Creating tournament...'
    });

    const formData = {
        name: document.getElementById('tournament-name').value.trim(),
        game: document.getElementById('tournament-game').value,
        format: document.getElementById('tournament-format').value,
        maxPlayers: parseInt(document.getElementById('tournament-players').value),
        description: document.getElementById('tournament-desc').value.trim(),
        roundTimerMinutes: parseInt(document.getElementById('tournament-timer')?.value || '0') || 0,
        topCutSize: parseInt(document.getElementById('tournament-topcut')?.value || '0') || 0
    };

    try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/tournaments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(formData)
        });

        if (response.ok) {
            document.getElementById('tournament-form').reset();
            switchSection('dashboard');
            setLoadingScreenMessage('Refreshing tournaments...');
            await renderTournaments();
        } else {
            const error = await response.json();
            alert(error.error || 'Failed to create tournament');
        }
    } catch (error) {
        alert('Network error - backend running?');
    } finally {
        endGlobalLoading();

        if (createBtn && createBtn.isConnected) {
            createBtn.disabled = false;
            createBtn.textContent = originalCreateText;
        }
    }
});

const decklistForm = document.getElementById('decklist-form');
if (decklistForm) {
    decklistForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!requireAuth('save decklists')) return;

        if ((deckBuilder.main || []).length === 0) {
            alert('Add at least one Main Deck card before saving.');
            return;
        }

        const payload = {
            name: document.getElementById('decklist-name').value.trim(),
            game: document.getElementById('decklist-game').value,
            mainDeck: serializeDeckSection(deckBuilder.main),
            extraDeck: serializeDeckSection(deckBuilder.extra),
            sideDeck: serializeDeckSection(deckBuilder.side),
            isPublic: !!document.getElementById('decklist-public')?.checked,
            archetype: document.getElementById('decklist-archetype')?.value.trim() || '',
            notes: document.getElementById('decklist-notes').value.trim()
        };

        const decklistSubmitBtn = document.getElementById('decklist-submit-btn');
        if (decklistSubmitBtn) {
            decklistSubmitBtn.disabled = true;
            decklistSubmitBtn.textContent = 'Validating...';
        }

        beginGlobalLoading({
            immediate: true,
            message: 'Validating decklist...'
        });

        try {
            setDeckCardFeedback('Validating deck legality...', 'success');
            const legality = await validateDecklistLegality(payload);
            if (!legality.valid) {
                alert(`Deck legality check failed:\n\n${legality.errors.join('\n')}`);
                setDeckCardFeedback('Deck legality check failed. Please fix listed issues.');
                return;
            }
            if (legality.warnings.length > 0) {
                addNotification(`Deck saved with ${legality.warnings.length} legality warning(s).`, 'warning');
            }

            if (decklistSubmitBtn) {
                decklistSubmitBtn.textContent = 'Saving...';
            }
            setLoadingScreenMessage('Saving decklist...');

            const token = localStorage.getItem('token');
            const isEditing = !!editingDecklistId;
            const endpoint = isEditing
                ? `${API_URL}/decklists/${editingDecklistId}`
                : `${API_URL}/decklists`;
            const method = isEditing ? 'PATCH' : 'POST';

            const response = await fetch(endpoint, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (!response.ok) {
                alert(data.error || 'Failed to save decklist');
                return;
            }

            resetDecklistForm();
            await renderDecklists();
            addNotification('Decklist saved successfully.', 'success');
        } catch (error) {
            alert('Network error while saving decklist');
        } finally {
            endGlobalLoading();

            if (decklistSubmitBtn) {
                decklistSubmitBtn.disabled = false;
                decklistSubmitBtn.textContent = editingDecklistId ? 'Update Decklist' : 'Save Decklist';
            }
        }
    });
}

const decklistVisibilityFilter = document.getElementById('decklist-visibility-filter');
if (decklistVisibilityFilter) {
    decklistVisibilityFilter.addEventListener('change', () => {
        renderDecklists();
    });
}

const landingDecklistSearchInput = document.getElementById('landing-decklist-search');
if (landingDecklistSearchInput) {
    landingDecklistSearchInput.addEventListener('input', (event) => {
        landingDecklistSearchTerm = event.target.value || '';
        renderLandingDecklists();
    });
}

const landingDecklistGameFilterInput = document.getElementById('landing-decklist-game-filter');
if (landingDecklistGameFilterInput) {
    landingDecklistGameFilterInput.addEventListener('change', (event) => {
        landingDecklistGameFilter = event.target.value || 'all';
        renderLandingDecklists();
    });
}

const decklistYdkFileInput = document.getElementById('decklist-ydk-file');
if (decklistYdkFileInput) {
    decklistYdkFileInput.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const importYdkBtn = document.querySelector('button[onclick="triggerYdkImport()"]');
        const originalImportYdkText = importYdkBtn ? importYdkBtn.textContent : 'Import .ydk';
        if (importYdkBtn) {
            importYdkBtn.disabled = true;
            importYdkBtn.textContent = 'Importing...';
        }

        beginGlobalLoading({
            immediate: true,
            message: 'Importing .ydk deck...'
        });

        try {
            const content = await file.text();
            const parsed = parseYdkContentToSections(content);

            setDeckCardFeedback('Importing .ydk file...', 'success');
            setLoadingScreenMessage('Resolving card data...');
            deckBuilder = {
                main: await hydrateDeckSectionFromText(parsed.main.join('\n')),
                extra: await hydrateDeckSectionFromText(parsed.extra.join('\n')),
                side: await hydrateDeckSectionFromText(parsed.side.join('\n'))
            };
            renderDeckBuilder();
            setDeckCardFeedback(`Imported ${file.name}`, 'success');
            addNotification(`Imported deck from ${file.name}.`, 'success');
        } catch (error) {
            setDeckCardFeedback('Failed to import .ydk file.');
            addNotification('Failed to import .ydk file.', 'warning');
        } finally {
            endGlobalLoading();

            if (importYdkBtn) {
                importYdkBtn.disabled = false;
                importYdkBtn.textContent = originalImportYdkText;
            }

            event.target.value = '';
        }
    });
}

document.querySelectorAll('.format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        currentFormat = btn.dataset.format;
        document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderTournaments();
    });
});

function showSignup(options = {}) {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('signup-form').style.display = 'block';
    if (options.updateUrl !== false) {
        updateBrowserUrl('/auth/signup');
    }
}

function showLogin(options = {}) {
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('signup-form').style.display = 'none';
    if (options.updateUrl !== false) {
        updateBrowserUrl('/auth/login');
    }
}

['login-email', 'login-password'].forEach((id) => {
    const input = document.getElementById(id);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            login();
        }
    });
});

['signup-username', 'signup-email', 'signup-password'].forEach((id) => {
    const input = document.getElementById(id);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            signup();
        }
    });
});

const deckCardNameInput = document.getElementById('deck-card-name');
if (deckCardNameInput) {
    deckCardNameInput.addEventListener('input', () => {
        queueCardSuggestions();
    });

    deckCardNameInput.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' && activeCardSuggestions.length > 0) {
            event.preventDefault();
            activeCardSuggestionIndex = Math.min(activeCardSuggestionIndex + 1, activeCardSuggestions.length - 1);
            renderCardSuggestions();
            return;
        }

        if (event.key === 'ArrowUp' && activeCardSuggestions.length > 0) {
            event.preventDefault();
            activeCardSuggestionIndex = Math.max(activeCardSuggestionIndex - 1, 0);
            renderCardSuggestions();
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();

            if (activeCardSuggestions.length > 0 && activeCardSuggestionIndex >= 0) {
                applyCardSuggestion(activeCardSuggestionIndex);
                return;
            }

            addCardToDeckBuilder();
        }

        if (event.key === 'Escape') {
            hideCardSuggestions();
        }
    });

    deckCardNameInput.addEventListener('blur', () => {
        setTimeout(() => {
            hideCardSuggestions();
        }, 120);
    });
}

document.getElementById('hamburger-menu').addEventListener('click', () => {
    document.getElementById('nav-menu').classList.toggle('mobile-open');
    document.getElementById('hamburger-menu').classList.toggle('active');
});

document.addEventListener('click', (event) => {
    const panel = document.getElementById('notifications-panel');
    const btn = document.getElementById('notifications-btn');
    if (!panel || !btn) return;

    if (panel.style.display !== 'none' && !panel.contains(event.target) && !btn.contains(event.target)) {
        panel.style.display = 'none';
    }
});

const themeToggle = document.getElementById('theme-toggle');
if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark-mode');
    themeToggle.textContent = '☀️';
}

themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light');
    themeToggle.textContent = document.body.classList.contains('dark-mode') ? '☀️' : '🌙';
});

function startLivePolling() {
    if (livePollTimer) {
        clearInterval(livePollTimer);
    }

    livePollTimer = setInterval(async () => {
        if (socketConnected) {
            return;
        }

        if (document.getElementById('dashboard').classList.contains('active') && currentUser) {
            await renderTournaments({ suppressLoading: true });
        }

        if (document.getElementById('tournament-detail').classList.contains('active') && currentTournamentDetailId) {
            await viewTournament(currentTournamentDetailId, {
                refresh: true,
                suppressLoading: true
            });
        }

        if (document.getElementById('decklists').classList.contains('active') && currentUser) {
            await renderDecklists({ suppressLoading: true });
        }

        if (document.getElementById('landing').classList.contains('active') && !currentUser) {
            await renderLandingTournaments({ suppressLoading: true });
            await renderLandingDecklists({ suppressLoading: true });
        }
    }, 10000);
}

if (document.getElementById('decklist-form')) {
    ensureDecklistArchetypeField();
    resetDecklistForm();
}

initializeRealtimeSocket();
startLivePolling();

window.addEventListener('popstate', async () => {
    await renderRouteFromLocation({ replaceHistory: true });
});

init();
