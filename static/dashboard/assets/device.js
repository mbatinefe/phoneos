function element(selector) {
    const value = document.querySelector(selector);
    if (!value)
        throw new Error(`Missing element: ${selector}`);
    return value;
}
const udid = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) ?? '');
const api = (suffix) => `/api/devices/${encodeURIComponent(udid)}${suffix}`;
const ui = {
    screen: element('#screen'),
    phoneScreen: element('#phone-screen'),
    overlay: element('#overlay'),
    screenMessage: element('#screen-message'),
    status: element('#status'),
    statusText: element('#status-text'),
    refresh: element('#refresh'),
    toggle: element('#toggle'),
    remoteButtons: Array.from(document.querySelectorAll('[data-remote-action]')),
    screenshot: element('#screenshot'),
    tabs: Array.from(document.querySelectorAll('[role="tab"]')),
    elementFilter: element('#element-filter'),
    readElements: element('#read-elements'),
    elements: element('#elements'),
    appFilter: element('#app-filter'),
    loadApps: element('#load-apps'),
    apps: element('#apps'),
    typeForm: element('#type-form'),
    typeText: element('#type-text'),
    typeSubmit: element('#type-submit'),
    typeResult: element('#type-result'),
    hideKeyboard: element('#hide-keyboard'),
    runA11y: element('#run-a11y'),
    a11y: element('#a11y'),
    schedulerBanner: element('#scheduler-banner'),
    schedules: element('#device-schedules'),
    copyCommand: element('#copy-command'),
    command: element('#mcp-command'),
    settings: element('#settings-dialog'),
    openSettings: element('#open-settings'),
    closeSettings: element('#close-settings'),
    nameForm: element('#name-form'),
    nameInput: element('#device-name'),
    nameResult: element('#name-result'),
    profile: element('#profile'),
    profileResult: element('#profile-result'),
    passcodeForm: element('#passcode-form'),
    passcode: element('#device-passcode'),
    passcodeClear: element('#passcode-clear'),
    passcodeState: element('#passcode-state'),
    passcodeResult: element('#passcode-result'),
    removeDevice: element('#remove-device'),
    removeResult: element('#remove-result'),
};
let screenSize;
let paused = false;
let pointerStart;
let connectionPoll;
let connectionChecking = false;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function request(url, options) {
    const response = await fetch(url, options);
    const data = (response.status === 204 ? {} : await response.json().catch(() => ({})));
    if (!response.ok)
        throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
}
function send(url, method, body) {
    return request(url, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
}
/** Build an element with a class and text, the way every list here is made. */
function make(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text)
        node.textContent = text;
    return node;
}
function note(text, className = 'empty') {
    return make('p', className, text);
}
function loading(text) {
    const line = make('p', 'loading empty');
    line.append(make('span', 'spinner'), document.createTextNode(text));
    return line;
}
// ---- live screen --------------------------------------------------------------
function setStatus(message, state = '') {
    ui.status.dataset.state = state;
    ui.statusText.textContent = message;
}
function startStream() {
    if (paused || !screenSize)
        return;
    setStatus('Connecting…', 'busy');
    ui.screen.src = api(`/remote/stream?t=${Date.now()}`);
}
async function pollConnection(reloadWhenReady = false) {
    if (connectionChecking)
        return;
    connectionChecking = true;
    window.clearTimeout(connectionPoll);
    try {
        const connection = await request(api('/connection'));
        if (connection.wda === 'ready') {
            if (reloadWhenReady) {
                location.reload();
                return;
            }
            connectionPoll = window.setTimeout(startStream, 2_000);
            return;
        }
        setStatus(`${connection.message}.`.replace('..', '.'), connection.wda === 'error' ? 'error' : 'busy');
        ui.screenMessage.textContent = connection.message;
        connectionPoll = window.setTimeout(() => void pollConnection(reloadWhenReady), 2_000);
    }
    catch (error) {
        setStatus(errorMessage(error), 'error');
        connectionPoll = window.setTimeout(() => void pollConnection(reloadWhenReady), 2_000);
    }
    finally {
        connectionChecking = false;
    }
}
function deviceName() {
    return document.querySelector('#device-summary h1')?.textContent?.trim() || 'iPhone';
}
function useDeviceSummary(summary) {
    const width = Number(summary.dataset.screenWidth);
    const height = Number(summary.dataset.screenHeight);
    document.title = `${deviceName()} · phoneos`;
    if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) {
        setStatus('Not connected', 'error');
        ui.screenMessage.textContent = 'Connect the phone to this Mac with a cable.';
        void pollConnection(true);
        return;
    }
    screenSize = { width, height };
    // The frame follows the device's real screen, so the live image is never letterboxed.
    ui.phoneScreen.style.setProperty('--screen-aspect', `${width} / ${height}`);
    startStream();
    if (selectedTab() === 'elements' && !elementsRead)
        void readElements();
}
document.addEventListener('htmx:afterSwap', () => {
    const summary = document.querySelector('#device-summary:not([hx-get])');
    if (summary && summary.dataset.used !== 'yes') {
        summary.dataset.used = 'yes';
        useDeviceSummary(summary);
    }
});
function pointFromEvent(event) {
    if (!screenSize)
        throw new Error('Screen dimensions are unavailable');
    const rect = ui.screen.getBoundingClientRect();
    return {
        x: Math.round((event.clientX - rect.left) * screenSize.width / rect.width),
        y: Math.round((event.clientY - rect.top) * screenSize.height / rect.height),
    };
}
const ACTION_DONE = {
    home: 'Went home', lock: 'Locked', wake: 'Screen on', unlock: 'Unlocked', volumeUp: 'Volume up', volumeDown: 'Volume down', swipe: 'Swiped',
};
async function sendAction(action) {
    setStatus('Sending…', 'busy');
    ui.remoteButtons.forEach((button) => { button.disabled = true; });
    try {
        await send(api('/remote/action'), 'POST', action);
        setStatus(action.type === 'tap' ? `Tapped ${action.x}, ${action.y}` : ACTION_DONE[action.type] ?? 'Done', 'ready');
        return true;
    }
    catch (error) {
        setStatus(errorMessage(error), 'error');
        return false;
    }
    finally {
        ui.remoteButtons.forEach((button) => { button.disabled = false; });
    }
}
function directionalSwipe(direction) {
    if (!screenSize) {
        setStatus('The screen size is not known yet', 'error');
        return;
    }
    const left = Math.round(screenSize.width * 0.22);
    const right = Math.round(screenSize.width * 0.78);
    const top = Math.round(screenSize.height * 0.25);
    const bottom = Math.round(screenSize.height * 0.75);
    const centerX = Math.round(screenSize.width / 2);
    const centerY = Math.round(screenSize.height / 2);
    const points = {
        left: [right, centerY, left, centerY],
        right: [left, centerY, right, centerY],
        up: [centerX, bottom, centerX, top],
        down: [centerX, top, centerX, bottom],
    };
    const [startX, startY, endX, endY] = points[direction];
    return { type: 'swipe', startX, startY, endX, endY, durationMs: 350 };
}
ui.remoteButtons.forEach((button) => {
    button.addEventListener('click', () => {
        const action = button.dataset.remoteAction;
        if (action === 'home' || action === 'lock' || action === 'wake'
            || action === 'unlock' || action === 'volumeUp' || action === 'volumeDown') {
            void sendAction({ type: action }).then((sent) => { if (sent)
                markStale(); });
            return;
        }
        if (action === 'left' || action === 'right' || action === 'up' || action === 'down') {
            const swipe = directionalSwipe(action);
            if (swipe)
                void sendAction(swipe).then((sent) => { if (sent)
                    markStale(); });
        }
    });
});
ui.screen.addEventListener('pointerdown', (event) => {
    if (!screenSize)
        return;
    ui.screen.setPointerCapture(event.pointerId);
    pointerStart = { ...pointFromEvent(event), time: performance.now() };
});
ui.screen.addEventListener('pointerup', (event) => {
    if (!pointerStart || !screenSize)
        return;
    const end = pointFromEvent(event);
    const start = pointerStart;
    pointerStart = undefined;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const durationMs = Math.max(150, Math.min(1200, Math.round(performance.now() - (start.time ?? 0))));
    const action = distance < 12
        ? { type: 'tap', x: end.x, y: end.y }
        : { type: 'swipe', startX: start.x, startY: start.y, endX: end.x, endY: end.y, durationMs };
    void sendAction(action).then((sent) => { if (sent)
        markStale(); });
});
ui.screen.addEventListener('pointercancel', () => { pointerStart = undefined; });
ui.screen.addEventListener('load', () => {
    ui.phoneScreen.classList.add('live');
    setStatus('Live', 'ready');
});
ui.screen.addEventListener('error', () => {
    if (paused)
        return;
    ui.phoneScreen.classList.remove('live');
    ui.screen.removeAttribute('src');
    ui.screenMessage.textContent = 'Reconnecting…';
    setStatus('The live screen stopped; checking the phone…', 'error');
    void pollConnection();
});
ui.refresh.addEventListener('click', async () => {
    ui.refresh.disabled = true;
    window.clearTimeout(connectionPoll);
    ui.phoneScreen.classList.remove('live');
    ui.screen.removeAttribute('src');
    ui.screenMessage.textContent = 'Reconnecting…';
    setStatus('Reconnecting…', 'busy');
    try {
        await send(api('/reconnect'), 'POST');
        void pollConnection(true);
    }
    catch (error) {
        setStatus(errorMessage(error), 'error');
    }
    finally {
        ui.refresh.disabled = false;
    }
});
ui.toggle.addEventListener('click', () => {
    paused = !paused;
    ui.toggle.setAttribute('aria-pressed', String(paused));
    const label = paused ? 'Resume the live screen' : 'Pause the live screen';
    ui.toggle.setAttribute('aria-label', label);
    ui.toggle.title = label;
    if (paused) {
        ui.phoneScreen.classList.remove('live');
        ui.screen.removeAttribute('src');
        ui.screenMessage.textContent = 'Paused';
        setStatus('Paused');
    }
    else {
        startStream();
    }
});
ui.screenshot.addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    ui.screenshot.download = `${deviceName().replace(/[^\w .-]+/g, '')} ${stamp}.png`;
});
// ---- highlights on the live screen ----------------------------------------------
function highlight(frame, label) {
    ui.overlay.replaceChildren();
    if (!frame || !screenSize)
        return;
    const box = make('div', 'highlight');
    box.style.left = `${frame.x / screenSize.width * 100}%`;
    box.style.top = `${frame.y / screenSize.height * 100}%`;
    box.style.width = `${frame.width / screenSize.width * 100}%`;
    box.style.height = `${frame.height / screenSize.height * 100}%`;
    if (label)
        box.append(make('span', 'highlight-label', label));
    ui.overlay.append(box);
}
function pointsAt(row, frame, label) {
    row.addEventListener('mouseenter', () => highlight(frame, label));
    row.addEventListener('focus', () => highlight(frame, label));
    row.addEventListener('mouseleave', () => highlight(undefined));
    row.addEventListener('blur', () => highlight(undefined));
}
// ---- inspector tabs ----------------------------------------------------------------
const TAB_KEY = 'phoneos.inspector';
function selectedTab() {
    return ui.tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.tab ?? 'elements';
}
function selectTab(name, focus = false) {
    for (const tab of ui.tabs) {
        const on = tab.dataset.tab === name;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        element(`#panel-${tab.dataset.tab}`).hidden = !on;
        if (on && focus)
            tab.focus();
    }
    highlight(undefined);
    try {
        localStorage.setItem(TAB_KEY, name);
    }
    catch { /* storage is a convenience */ }
    if (name === 'elements' && screenSize && !elementsRead)
        void readElements();
    if (name === 'apps' && !appsLoaded)
        void loadApps();
    if (name === 'activity')
        void loadActivity();
}
ui.tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab ?? 'elements'));
    tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')
            return;
        const next = ui.tabs[(index + (event.key === 'ArrowRight' ? 1 : ui.tabs.length - 1)) % ui.tabs.length];
        selectTab(next.dataset.tab ?? 'elements', true);
    });
});
// ---- elements: what an agent sees ----------------------------------------------------
let elementsRead = false;
let elementsReply;
let staleTimer;
/** After a tap or swipe the list describes an old screen: read it again once things settle. */
function markStale() {
    if (!elementsRead || selectedTab() !== 'elements')
        return;
    window.clearTimeout(staleTimer);
    staleTimer = window.setTimeout(() => void readElements(), 1_200);
}
function describe(item) {
    return item.label || item.name || item.value || item.identifier || '';
}
function elementRow(item) {
    const row = make('button', 'element-row');
    row.type = 'button';
    const text = make('span', 'element-text');
    const words = describe(item);
    if (words)
        text.append(document.createTextNode(words));
    else
        text.append(make('span', 'muted', 'no label'));
    if (item.value && item.value !== words)
        text.append(make('span', 'value', ` — ${item.value}`));
    row.append(make('span', 'element-id', item.id), text, make('span', 'element-type', item.type));
    row.title = `Tap ${item.id}`;
    pointsAt(row, item.frame, item.id);
    row.addEventListener('click', () => {
        const x = Math.round(item.frame.x + item.frame.width / 2);
        const y = Math.round(item.frame.y + item.frame.height / 2);
        void sendAction({ type: 'tap', x, y }).then((sent) => { if (sent)
            markStale(); });
    });
    return row;
}
function renderElements() {
    const reply = elementsReply;
    if (!reply)
        return;
    const query = ui.elementFilter.value.trim().toLowerCase();
    const parts = [];
    const facts = make('div', 'screen-facts');
    const where = reply.locked ? 'Locked' : reply.app ? reply.app.name : 'Home Screen';
    facts.append(make('span', 'pill ok', where));
    if (reply.keyboardVisible)
        facts.append(make('span', 'pill', 'Keyboard up'));
    if (reply.alert)
        facts.append(make('span', 'pill warn', `Alert: ${reply.alert.title ?? reply.alert.text ?? 'open'}`));
    facts.append(make('span', 'pill', `${reply.elements.length} element${reply.elements.length === 1 ? '' : 's'}`));
    parts.push(facts);
    if (reply.locked) {
        parts.push(note('The phone is locked. Press Unlock, then read the screen again.'));
        ui.elements.replaceChildren(...parts);
        return;
    }
    if (reply.treeStatus !== 'ok') {
        parts.push(note(reply.treeStatus === 'skipped'
            ? 'The home screen\'s elements are not read on a phone: it takes about 20 seconds and holds the phone up. Open an app from the Apps tab, or tap the screen.'
            : 'This screen\'s elements could not be read (custom-drawn apps, games, video). An agent reads the screenshot instead and taps by position.'));
        ui.elements.replaceChildren(...parts);
        return;
    }
    const matches = reply.elements.filter((item) => !query
        || [item.id, item.type, item.label, item.name, item.value, item.identifier].some((field) => field?.toLowerCase().includes(query)));
    const tappable = matches.filter((item) => item.interactive);
    const other = matches.filter((item) => !tappable.includes(item));
    if (!matches.length)
        parts.push(note(query ? `Nothing matches “${ui.elementFilter.value.trim()}”.` : 'Nothing readable on this screen.'));
    for (const [title, items] of [['Tappable', tappable], ['Other', other]]) {
        if (!items.length)
            continue;
        parts.push(make('h3', 'list-title', `${title} · ${items.length}`));
        const list = make('div', 'element-list');
        list.append(...items.map(elementRow));
        parts.push(list);
    }
    ui.elements.replaceChildren(...parts);
}
async function readElements() {
    ui.readElements.disabled = true;
    if (!elementsReply)
        ui.elements.replaceChildren(loading('Reading the screen…'));
    else
        ui.readElements.textContent = 'Reading…';
    try {
        elementsReply = await request(api('/elements'));
        elementsRead = true;
        renderElements();
    }
    catch (error) {
        ui.elements.replaceChildren(note(errorMessage(error), 'empty run-error'));
    }
    finally {
        ui.readElements.disabled = false;
        ui.readElements.textContent = 'Read screen';
    }
}
ui.readElements.addEventListener('click', () => void readElements());
ui.elementFilter.addEventListener('input', renderElements);
// ---- apps ----------------------------------------------------------------------------
let appsLoaded = false;
let appsReply;
function appRow(app) {
    const row = make('div', 'app-row');
    const copy = make('div', 'app-copy');
    copy.append(make('div', 'app-name', app.name), make('div', 'app-id', `${app.bundleId}${app.version ? ` · ${app.version}` : ''}`));
    const open = make('button', 'button secondary small', 'Open');
    open.type = 'button';
    const restart = make('button', 'button plain small', 'Restart');
    restart.type = 'button';
    restart.title = 'Quit it first, then open it fresh';
    const launch = async (relaunch) => {
        open.disabled = true;
        restart.disabled = true;
        setStatus(`Opening ${app.name}…`, 'busy');
        try {
            await send(api('/apps/open'), 'POST', { bundleId: app.bundleId, relaunch });
            setStatus(`Opened ${app.name}`, 'ready');
            elementsRead = false;
        }
        catch (error) {
            setStatus(errorMessage(error), 'error');
        }
        finally {
            open.disabled = false;
            restart.disabled = false;
        }
    };
    open.addEventListener('click', () => void launch(false));
    restart.addEventListener('click', () => void launch(true));
    const actions = make('div', 'inline-actions');
    actions.append(restart, open);
    row.append(make('div', 'app-icon', app.name.trim().charAt(0).toUpperCase() || '?'), copy, actions);
    return row;
}
function renderApps() {
    if (!appsReply)
        return;
    const query = ui.appFilter.value.trim().toLowerCase();
    const matches = (apps) => apps.filter((app) => !query || app.name.toLowerCase().includes(query) || app.bundleId.toLowerCase().includes(query));
    const parts = [];
    for (const [title, apps] of [['Installed', matches(appsReply.apps)], ['Built in', matches(appsReply.system)]]) {
        if (!apps.length)
            continue;
        parts.push(make('h3', 'list-title', `${title} · ${apps.length}`));
        const list = make('div', 'app-list');
        list.append(...apps.map(appRow));
        parts.push(list);
    }
    ui.apps.replaceChildren(...(parts.length ? parts : [note(`No app matches “${ui.appFilter.value.trim()}”.`)]));
}
async function loadApps() {
    ui.loadApps.disabled = true;
    ui.apps.replaceChildren(loading('Asking the phone for its apps…'));
    try {
        appsReply = await request(api('/apps'));
        appsLoaded = true;
        renderApps();
    }
    catch (error) {
        ui.apps.replaceChildren(note(errorMessage(error), 'empty run-error'));
    }
    finally {
        ui.loadApps.disabled = false;
    }
}
ui.loadApps.addEventListener('click', () => void loadApps());
ui.appFilter.addEventListener('input', renderApps);
// ---- keyboard --------------------------------------------------------------------------
ui.typeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = ui.typeText.value;
    if (!text)
        return;
    ui.typeResult.textContent = 'Typing…';
    try {
        const result = await send(api('/type'), 'POST', { text, submit: ui.typeSubmit.checked });
        ui.typeResult.textContent = `Typed ${result.characters} character${result.characters === 1 ? '' : 's'}.`;
        ui.typeText.value = '';
        markStale();
    }
    catch (error) {
        ui.typeResult.textContent = errorMessage(error);
    }
});
ui.hideKeyboard.addEventListener('click', async () => {
    ui.typeResult.textContent = 'Hiding the keyboard…';
    try {
        await send(api('/keyboard/dismiss'), 'POST', {});
        ui.typeResult.textContent = 'Keyboard hidden.';
    }
    catch (error) {
        ui.typeResult.textContent = errorMessage(error);
    }
});
// ---- accessibility -------------------------------------------------------------------------
const ISSUES = {
    'no-label': 'No label',
    'small-target': 'Small tap target',
    'duplicate-label': 'Same label twice',
    'unlabeled-field': 'Field without a name',
    'file-name-label': 'Label is a file name',
};
function renderAudit(reply) {
    if (reply.treeStatus === 'skipped') {
        ui.a11y.replaceChildren(note('This is the home screen, whose element tree is not read. Open an app and check again.'));
        return;
    }
    if (reply.treeStatus !== 'ok') {
        ui.a11y.replaceChildren(note(`The screen's element tree could not be read (${reply.treeStatus}). Custom-drawn screens are invisible to VoiceOver too.`));
        return;
    }
    const where = reply.app?.name ?? 'this screen';
    const summary = make('div', 'audit-summary');
    const problems = reply.findings.length;
    summary.append(make('span', problems ? 'mark warn' : 'mark', problems ? '!' : '✓'), document.createTextNode(problems
        ? `${problems} problem${problems === 1 ? '' : 's'} in ${reply.checked} controls on ${where}`
        : `No problems in ${reply.checked} controls on ${where}`));
    const list = make('ul', 'finding-list');
    list.append(...reply.findings.map((finding) => {
        const item = make('li', 'finding');
        item.tabIndex = 0;
        const title = make('h4');
        title.append(make('span', 'element-id', finding.element.id), document.createTextNode(ISSUES[finding.issue] ?? finding.issue));
        item.append(title, make('p', '', finding.detail));
        pointsAt(item, finding.element.frame, finding.element.id);
        return item;
    }));
    ui.a11y.replaceChildren(summary, list);
}
ui.runA11y.addEventListener('click', async () => {
    ui.runA11y.disabled = true;
    ui.a11y.replaceChildren(loading('Checking the screen…'));
    try {
        renderAudit(await request(api('/accessibility')));
    }
    catch (error) {
        ui.a11y.replaceChildren(note(errorMessage(error), 'empty run-error'));
    }
    finally {
        ui.runA11y.disabled = false;
    }
});
// ---- activity ---------------------------------------------------------------------------------
let plugins;
let activityPoll;
function taskName(schedule) {
    const plugin = plugins?.find((entry) => entry.id === schedule.pluginId);
    const task = plugin?.tasks.find((entry) => entry.type === schedule.taskType);
    return task ? `${plugin.displayName} · ${task.displayName}` : `${schedule.pluginId} · ${schedule.taskType}`;
}
function timing(schedule) {
    const { timing: value } = schedule;
    const at = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
    const when = value.kind === 'once' ? `Once, ${at(value.runAt)}`
        : value.kind === 'daily' ? `Every day at ${value.localTime ?? '—'}`
            : value.kind === 'weekly' ? `Weekly (${(value.weekdays ?? []).map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ')}) at ${value.localTime ?? '—'}`
                : 'Right away';
    return schedule.nextRunAt ? `${when} · next ${at(schedule.nextRunAt)}` : when;
}
function scheduleRow(schedule) {
    const row = make('article', 'task-row');
    const copy = make('div');
    copy.append(make('h3', '', taskName(schedule)), make('p', '', timing(schedule)));
    const state = make('span', `status ${schedule.status}`);
    state.append(make('span', 'dot'), document.createTextNode(schedule.status));
    const actions = make('div', 'inline-actions');
    const act = (label, path) => {
        const button = make('button', 'button plain small', label);
        button.type = 'button';
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await send(`/api/schedules/${schedule.id}/${path}`, 'POST');
            }
            catch (error) {
                window.alert(errorMessage(error));
            }
            await loadActivity();
        });
        actions.append(button);
    };
    if (schedule.status === 'active')
        act('Pause', 'pause');
    if (schedule.status === 'paused')
        act('Resume', 'resume');
    if (schedule.status === 'active' || schedule.status === 'paused')
        act('Cancel', 'cancel');
    row.append(copy, state, actions);
    return row;
}
async function loadActivity() {
    window.clearTimeout(activityPoll);
    try {
        const [scheduler, scheduleData, pluginList] = await Promise.all([
            request('/api/scheduler'),
            request(`/api/schedules?deviceUdid=${encodeURIComponent(udid)}`),
            plugins ? Promise.resolve(plugins) : request('/api/plugins'),
        ]);
        plugins = pluginList;
        ui.schedulerBanner.hidden = scheduler.available;
        if (!scheduler.available) {
            ui.schedulerBanner.textContent = `Scheduling is off${scheduler.reason ? ` (${scheduler.reason})` : ''}. It needs PostgreSQL: run npm run db:up && npm run db:migrate, then restart the dashboard. Everything else here works without it.`;
        }
        const live = scheduleData.schedules.filter((schedule) => schedule.status === 'active' || schedule.status === 'paused');
        ui.schedules.replaceChildren(...(live.length ? live.map(scheduleRow) : [note(scheduler.available ? 'Nothing is scheduled for this phone.' : 'No schedules while scheduling is off.')]));
    }
    catch (error) {
        ui.schedules.replaceChildren(note(errorMessage(error), 'empty run-error'));
    }
    if (selectedTab() === 'activity')
        activityPoll = window.setTimeout(() => void loadActivity(), 5_000);
}
// ---- agent ------------------------------------------------------------------------------------
ui.copyCommand.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(ui.command.textContent ?? '');
        ui.copyCommand.textContent = 'Copied';
    }
    catch {
        ui.copyCommand.textContent = 'Select and copy';
    }
    window.setTimeout(() => { ui.copyCommand.textContent = 'Copy'; }, 1_600);
});
// ---- settings -----------------------------------------------------------------------------------
ui.openSettings.addEventListener('click', () => ui.settings.showModal());
ui.closeSettings.addEventListener('click', () => ui.settings.close());
ui.settings.addEventListener('click', (event) => { if (event.target === ui.settings)
    ui.settings.close(); });
ui.nameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = ui.nameInput.value.trim();
    if (!name)
        return;
    ui.nameResult.textContent = 'Saving…';
    try {
        await send(api(''), 'PATCH', { name });
        const heading = document.querySelector('#device-summary h1');
        if (heading)
            heading.textContent = name;
        document.title = `${name} · phoneos`;
        ui.nameResult.textContent = 'Renamed. Agents find it by this name.';
    }
    catch (error) {
        ui.nameResult.textContent = errorMessage(error);
    }
});
const profileButtons = Array.from(ui.profile.querySelectorAll('[data-value]'));
function showProfile(value) {
    for (const button of profileButtons)
        button.setAttribute('aria-checked', String(button.dataset.value === value));
}
showProfile(ui.profile.dataset.profile ?? 'natural');
profileButtons.forEach((button) => button.addEventListener('click', async () => {
    const value = button.dataset.value ?? 'natural';
    const before = profileButtons.find((entry) => entry.getAttribute('aria-checked') === 'true')?.dataset.value ?? 'natural';
    showProfile(value);
    ui.profileResult.textContent = 'Saving…';
    try {
        await send(api(''), 'PATCH', { humanProfile: value });
        ui.profileResult.textContent = `Saved: ${button.textContent}.`;
    }
    catch (error) {
        showProfile(before);
        ui.profileResult.textContent = errorMessage(error);
    }
}));
async function savePasscode(passcode, done) {
    ui.passcodeResult.textContent = 'Saving…';
    try {
        const data = await send(api(''), 'PATCH', { passcode });
        ui.passcodeState.textContent = data.hasPasscode ? 'Set' : 'Not set';
        ui.passcode.value = '';
        ui.passcodeResult.textContent = done;
    }
    catch (error) {
        ui.passcodeResult.textContent = errorMessage(error);
    }
}
ui.passcodeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = ui.passcode.value.trim();
    if (!/^\d{4,}$/.test(value)) {
        ui.passcodeResult.textContent = 'Enter at least four digits.';
        return;
    }
    void savePasscode(value, 'Passcode saved.');
});
ui.passcodeClear.addEventListener('click', () => {
    if (!window.confirm('Clear the passcode? A locked phone can then only be unlocked by hand.'))
        return;
    void savePasscode('', 'Passcode cleared.');
});
ui.removeDevice.addEventListener('click', async () => {
    if (!window.confirm(`Remove “${deviceName()}” from phoneos? Its schedules are cancelled and its settings forgotten.`))
        return;
    ui.removeDevice.disabled = true;
    ui.removeResult.textContent = 'Removing…';
    try {
        await send(api(''), 'DELETE');
        location.href = '/';
    }
    catch (error) {
        ui.removeDevice.disabled = false;
        ui.removeResult.textContent = errorMessage(error);
    }
});
// ---- start ---------------------------------------------------------------------------------------
let savedTab = 'elements';
try {
    savedTab = localStorage.getItem(TAB_KEY) ?? 'elements';
}
catch { /* storage is a convenience */ }
selectTab(ui.tabs.some((tab) => tab.dataset.tab === savedTab) ? savedTab : 'elements');
const loadedSummary = document.querySelector('#device-summary:not([hx-get])');
if (loadedSummary) {
    loadedSummary.dataset.used = 'yes';
    useDeviceSummary(loadedSummary);
}
export {};
