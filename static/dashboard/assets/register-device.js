// Built-in checks must pass; an app pack's checks (`<pack>:<check>`) are shown but optional.
const CHECK_TITLES = {
    host: 'This Mac', connection: 'Connection', signing: 'Signing', developer: 'Developer Mode',
    wda: 'WebDriverAgent', video: 'Screen video', touch: 'Touch',
};
function checkTitle(key) {
    if (!key.includes(':'))
        return CHECK_TITLES[key] ?? key.replace(/^./, (letter) => letter.toUpperCase());
    const pack = key.split(':')[0];
    return `${pack.replace(/^./, (letter) => letter.toUpperCase())} pack`;
}
const candidatePanel = document.querySelector('#candidate-panel');
const candidateList = document.querySelector('#candidate-list');
const registrationPanel = document.querySelector('#registration-panel');
const title = document.querySelector('#registration-title');
const busy = document.querySelector('#registration-busy');
const errorBox = document.querySelector('#registration-error');
const form = document.querySelector('#registration-details');
const nameInput = document.querySelector('#registration-name');
const profileInput = document.querySelector('#registration-profile');
const passcodeInput = document.querySelector('#registration-passcode');
const ports = document.querySelector('#registration-ports');
const checks = document.querySelector('#registration-checks');
const logs = document.querySelector('#registration-logs');
const authorize = document.querySelector('#authorize-registration');
const finalizeButton = document.querySelector('#action-finalize');
let currentId;
let poll;
async function request(url, options) {
    const response = await fetch(url, options);
    if (response.status === 204)
        return undefined;
    const body = await response.json();
    if (!response.ok)
        throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}
function showError(error) {
    errorBox.hidden = !error;
    errorBox.textContent = error ? (error instanceof Error ? error.message : String(error)) : '';
}
async function candidates() {
    showError();
    candidateList.innerHTML = '<p class="loading empty"><span class="spinner" aria-hidden="true"></span>Looking for phones…</p>';
    try {
        const data = await request('/api/device-registrations/candidates');
        if (!data.devices.length) {
            candidateList.innerHTML = '<div class="empty-state"><h3>No new iPhone found</h3><p>Connect one with a cable, unlock it, tap Trust, then check again.</p></div>';
            return;
        }
        candidateList.replaceChildren(...data.devices.map((device) => {
            const card = document.createElement('article');
            card.className = 'candidate-card';
            const copy = document.createElement('div');
            const heading = document.createElement('h3');
            heading.textContent = device.name;
            const meta = document.createElement('p');
            meta.textContent = `${device.modelName ?? ''} iOS ${device.osVersion} · ${device.kind === 'simulator' ? 'simulator · ' : ''}${device.udid}`;
            copy.append(heading, meta);
            const button = document.createElement('button');
            button.className = 'button primary';
            button.type = 'button';
            button.textContent = 'Set up';
            button.addEventListener('click', () => void create(device.udid));
            card.append(copy, button);
            return card;
        }));
    }
    catch (error) {
        candidateList.textContent = '';
        showError(error);
    }
}
async function create(udid) {
    const snapshot = await request('/api/device-registrations', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ udid }),
    });
    currentId = snapshot.id;
    candidatePanel.hidden = true;
    registrationPanel.hidden = false;
    render(snapshot);
    poll = window.setInterval(() => void refreshSnapshot(), 2_000);
}
function render(snapshot) {
    title.textContent = [snapshot.name, snapshot.device.modelName ?? snapshot.device.productType, `iOS ${snapshot.device.osVersion}`, snapshot.device.kind === 'simulator' ? 'simulator' : undefined].filter(Boolean).join(' · ');
    busy.hidden = !snapshot.busy;
    if (document.activeElement !== nameInput)
        nameInput.value = snapshot.name;
    if (document.activeElement !== profileInput)
        profileInput.value = snapshot.humanProfile;
    passcodeInput.placeholder = snapshot.hasPasscode ? 'Passcode saved in this setup session' : 'Optional numeric passcode';
    ports.textContent = `WDA ${snapshot.wdaLocalPort} · video ${snapshot.mjpegLocalPort}`;
    checks.replaceChildren(...Object.entries(snapshot.checks).map(([key, value]) => {
        const optional = key.includes(':');
        const row = document.createElement('article');
        row.className = `registration-check ${value.state}${optional ? ' optional' : ''}`;
        const state = document.createElement('span');
        state.className = `check-mark ${value.state}`;
        state.textContent = value.state === 'passed' ? '✓' : value.state === 'checking' ? '…' : value.state === 'pending' ? '' : '!';
        const copy = document.createElement('div');
        const heading = document.createElement('h3');
        heading.textContent = checkTitle(key);
        if (optional) {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = 'Optional';
            heading.append(tag);
        }
        const message = document.createElement('p');
        message.textContent = value.message;
        copy.append(heading, message);
        row.append(state, copy);
        return row;
    }));
    logs.textContent = snapshot.logs.length ? snapshot.logs.join('\n') : 'Nothing yet.';
    finalizeButton.disabled = !snapshot.canFinalize || snapshot.busy;
    for (const element of registrationPanel.querySelectorAll('button')) {
        if (element.id !== 'action-cancel')
            element.disabled = snapshot.busy || (element.id === 'action-finalize' && !snapshot.canFinalize);
    }
    if (snapshot.finalized) {
        if (poll)
            window.clearInterval(poll);
        window.location.assign(`/devices/${encodeURIComponent(snapshot.device.udid)}`);
    }
}
async function refreshSnapshot() {
    if (!currentId)
        return;
    try {
        render(await request(`/api/device-registrations/${encodeURIComponent(currentId)}`));
    }
    catch (error) {
        showError(error);
    }
}
async function action(name) {
    if (!currentId)
        return;
    showError();
    try {
        const snapshot = await request(`/api/device-registrations/${encodeURIComponent(currentId)}/actions/${name}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ authorizeTeamRegistration: authorize.checked }),
        });
        render(snapshot);
    }
    catch (error) {
        showError(error);
    }
}
document.querySelector('#refresh-candidates').addEventListener('click', () => void candidates());
document.querySelector('#action-refresh').addEventListener('click', () => void action('refresh'));
document.querySelector('#action-prepare').addEventListener('click', () => {
    if (!authorize.checked && !window.confirm('Continue without allowing automatic Apple Developer team device registration? Xcode may ask you to register it manually.'))
        return;
    void action('prepare');
});
document.querySelector('#action-verify').addEventListener('click', () => void action('verify'));
finalizeButton.addEventListener('click', () => void action('finalize'));
document.querySelector('#action-cancel').addEventListener('click', async () => {
    if (!currentId || !window.confirm('Cancel this setup? Apple Developer registration or an installed WDA app cannot be undone automatically.'))
        return;
    await request(`/api/device-registrations/${encodeURIComponent(currentId)}`, { method: 'DELETE' });
    if (poll)
        window.clearInterval(poll);
    currentId = undefined;
    registrationPanel.hidden = true;
    candidatePanel.hidden = false;
    await candidates();
});
form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentId)
        return;
    showError();
    try {
        const snapshot = await request(`/api/device-registrations/${encodeURIComponent(currentId)}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                name: nameInput.value, humanProfile: profileInput.value,
                passcode: passcodeInput.value || undefined,
            }),
        });
        passcodeInput.value = '';
        render(snapshot);
    }
    catch (error) {
        showError(error);
    }
});
void (async () => {
    await candidates();
    const requestedUdid = new URLSearchParams(window.location.search).get('udid');
    if (requestedUdid)
        await create(requestedUdid).catch(showError);
})();
export {};
