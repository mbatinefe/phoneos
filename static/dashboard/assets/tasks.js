const schedulesElement = document.querySelector('#schedules');
const executionsElement = document.querySelector('#executions');
const refresh = document.querySelector('#refresh-tasks');
const banner = document.querySelector('#scheduler-banner');
const newSchedule = document.querySelector('#new-schedule');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let plugins = [];
let devices = [];
function deviceName(udid) {
    return devices.find((device) => device.udid === udid)?.name ?? (udid.length > 20 ? `${udid.slice(0, 8)}…${udid.slice(-6)}` : udid);
}
function taskName(pluginId, taskType) {
    const plugin = plugins.find((entry) => entry.id === pluginId);
    const task = plugin?.tasks.find((entry) => entry.type === taskType);
    return task ? `${plugin.displayName} · ${task.displayName}` : `${pluginId} · ${taskType}`;
}
function date(value) {
    return value ? new Date(value).toLocaleString() : '—';
}
function when(schedule) {
    const { timing } = schedule;
    const text = timing.kind === 'once' ? `Once, ${date(timing.runAt)}`
        : timing.kind === 'daily' ? `Every day at ${timing.localTime ?? '—'}`
            : timing.kind === 'weekly' ? `Weekly (${(timing.weekdays ?? []).map((day) => WEEKDAYS[day]).join(', ')}) at ${timing.localTime ?? '—'}`
                : 'Right away';
    return schedule.nextRunAt ? `${text} · next ${date(schedule.nextRunAt)}` : text;
}
async function request(url, options) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok)
        throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}
function button(label, action) {
    const value = document.createElement('button');
    value.className = 'button plain small';
    value.type = 'button';
    value.textContent = label;
    value.addEventListener('click', () => void action().catch((error) => {
        window.alert(error instanceof Error ? error.message : String(error));
    }));
    return value;
}
function empty(text) {
    const line = document.createElement('p');
    line.className = 'empty';
    line.textContent = text;
    return line;
}
function row(title, meta, status, actions) {
    const article = document.createElement('article');
    article.className = 'task-row';
    const copy = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const detail = document.createElement('p');
    detail.textContent = meta;
    copy.append(heading, detail);
    const state = document.createElement('span');
    state.className = `status ${status}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    state.append(dot, document.createTextNode(status));
    const host = document.createElement('div');
    host.className = 'inline-actions';
    host.append(...actions);
    article.append(copy, state, host);
    return article;
}
function renderSchedules(items) {
    if (!items.length) {
        schedulesElement.replaceChildren(empty('Nothing is scheduled.'));
        return;
    }
    schedulesElement.replaceChildren(...items.map((schedule) => {
        const actions = [];
        if (schedule.status === 'active' || schedule.status === 'paused')
            actions.push(button('Edit', async () => {
                const timingText = window.prompt('Timing (JSON)', JSON.stringify(schedule.timing));
                if (!timingText)
                    return;
                const windowText = window.prompt('Run window in minutes', String(schedule.runWindowMinutes));
                if (!windowText)
                    return;
                const timing = JSON.parse(timingText);
                // A pack task that publishes asks once for a schedule that will publish on every run.
                const recurringPublish = schedule.payload.destination === 'publish' && (timing.kind === 'daily' || timing.kind === 'weekly');
                if (recurringPublish && !window.confirm('This schedule publishes on every run, without asking each time. Continue?'))
                    return;
                await request(`/api/schedules/${schedule.id}`, {
                    method: 'PATCH', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ timing, runWindowMinutes: Number(windowText), recurringPublishConfirmed: recurringPublish }),
                });
                await load();
            }));
        if (schedule.status === 'active')
            actions.push(button('Pause', async () => { await request(`/api/schedules/${schedule.id}/pause`, { method: 'POST' }); await load(); }));
        if (schedule.status === 'paused')
            actions.push(button('Resume', async () => { await request(`/api/schedules/${schedule.id}/resume`, { method: 'POST' }); await load(); }));
        if (schedule.status !== 'cancelled' && schedule.status !== 'completed')
            actions.push(button('Cancel', async () => { await request(`/api/schedules/${schedule.id}/cancel`, { method: 'POST' }); await load(); }));
        return row(`${taskName(schedule.pluginId, schedule.taskType)} · ${deviceName(schedule.deviceUdid)}`, when(schedule), schedule.status, actions);
    }));
}
function renderExecutions(items) {
    if (!items.length) {
        executionsElement.replaceChildren(empty('Nothing has run yet.'));
        return;
    }
    executionsElement.replaceChildren(...items.map((execution) => {
        const actions = [];
        if (execution.status === 'queued' || execution.status === 'running') {
            actions.push(button(execution.status === 'queued' ? 'Cancel' : 'Stop', async () => {
                await request(`/api/executions/${execution.id}/stop`, { method: 'POST' });
                await load();
            }));
        }
        if (execution.status === 'failed' || execution.status === 'stopped') {
            actions.push(button('Retry', async () => {
                if (!window.confirm('Run it again? If it got partway, some of it may already have happened on the phone: check the phone first.'))
                    return;
                await request(`/api/executions/${execution.id}/retry`, { method: 'POST' });
                await load();
            }));
        }
        const meta = `${deviceName(execution.deviceUdid)} · ${date(execution.scheduledFor)}${execution.error ? ` · ${execution.error}` : ''}`;
        return row(taskName(execution.pluginId, execution.taskType), meta, execution.status, actions);
    }));
}
// ---- new schedule -------------------------------------------------------------
const dialog = document.querySelector('#schedule-dialog');
const form = document.querySelector('#schedule-form');
const deviceSelect = document.querySelector('#schedule-device');
const taskSelect = document.querySelector('#schedule-task');
const taskHelp = document.querySelector('#schedule-task-help');
const fieldsHost = document.querySelector('#schedule-fields');
const kindSelect = document.querySelector('#schedule-kind');
const onceField = document.querySelector('#schedule-once-field');
const timeField = document.querySelector('#schedule-time-field');
const weekdayField = document.querySelector('#schedule-weekday-field');
const weekdayHost = document.querySelector('#schedule-weekdays');
const runAtInput = document.querySelector('#schedule-run-at');
const localTimeInput = document.querySelector('#schedule-local-time');
const runWindowInput = document.querySelector('#schedule-run-window');
const resultLine = document.querySelector('#schedule-result');
function selectedTask() {
    const [pluginId, type, version] = taskSelect.value.split('|');
    const plugin = plugins.find((entry) => entry.id === pluginId);
    const task = plugin?.tasks.find((entry) => entry.type === type && String(entry.version) === version);
    return plugin && task ? { plugin, task } : undefined;
}
/** Build the payload form from the task's own field descriptors. */
function renderFields() {
    const selection = selectedTask();
    fieldsHost.replaceChildren();
    if (!selection)
        return;
    const { plugin, task } = selection;
    if (!task.fields) {
        taskHelp.textContent = 'This task takes files, so it cannot be set up here: use its pack\'s API or an agent.';
        return;
    }
    taskHelp.textContent = '';
    const device = devices.find((entry) => entry.udid === deviceSelect.value);
    for (const field of task.fields) {
        const wrapper = document.createElement('div');
        wrapper.className = field.type === 'boolean' ? 'field field-inline' : 'field';
        const label = document.createElement('label');
        label.htmlFor = `payload-${field.name}`;
        label.textContent = field.label;
        let input;
        if (field.type === 'select') {
            const select = document.createElement('select');
            if (!field.required)
                select.add(new Option('—', ''));
            for (const option of field.options ?? [])
                select.add(new Option(option.label, option.value));
            const fromDevice = field.optionsFromPluginData
                ? device?.pluginData?.[plugin.id]?.[field.optionsFromPluginData] ?? []
                : [];
            for (const value of fromDevice)
                if (typeof value === 'string')
                    select.add(new Option(value, value));
            if (typeof field.default === 'string')
                select.value = field.default;
            input = select;
        }
        else if (field.type === 'boolean') {
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = field.default === true;
            input = box;
        }
        else if (field.type === 'textarea') {
            const area = document.createElement('textarea');
            if (typeof field.default === 'string')
                area.value = field.default;
            input = area;
        }
        else {
            const text = document.createElement('input');
            text.type = field.type === 'number' ? 'number' : 'text';
            if (field.min !== undefined)
                text.min = String(field.min);
            if (field.max !== undefined)
                text.max = String(field.max);
            if (field.default !== undefined && field.default !== null)
                text.value = String(field.default);
            input = text;
        }
        input.id = `payload-${field.name}`;
        input.dataset.field = field.name;
        input.dataset.fieldType = field.type;
        if (field.required && field.type !== 'boolean')
            input.setAttribute('required', 'required');
        if (field.type === 'boolean')
            wrapper.append(input, label);
        else
            wrapper.append(label, input);
        if (field.help) {
            const help = document.createElement('span');
            help.className = 'field-help';
            help.textContent = field.help;
            wrapper.append(help);
        }
        fieldsHost.append(wrapper);
    }
}
function collectPayload() {
    const payload = {};
    for (const input of fieldsHost.querySelectorAll('[data-field]')) {
        const name = input.dataset.field;
        const type = input.dataset.fieldType;
        if (type === 'boolean')
            payload[name] = input.checked;
        else if (type === 'number') {
            if (input.value !== '')
                payload[name] = Number(input.value);
        }
        else if (input.value !== '')
            payload[name] = input.value;
    }
    return payload;
}
function timing() {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const kind = kindSelect.value;
    if (kind === 'now')
        return { kind: 'now' };
    if (kind === 'once') {
        if (!runAtInput.value)
            throw new Error('Pick a date and time.');
        return { kind: 'once', runAt: new Date(runAtInput.value).toISOString() };
    }
    if (kind === 'daily')
        return { kind: 'daily', localTime: localTimeInput.value, timezone };
    const weekdays = [...weekdayHost.querySelectorAll('input:checked')].map((box) => Number(box.value));
    if (!weekdays.length)
        throw new Error('Pick at least one day.');
    return { kind: 'weekly', localTime: localTimeInput.value, timezone, weekdays };
}
function syncTimingFields() {
    const kind = kindSelect.value;
    onceField.hidden = kind !== 'once';
    timeField.hidden = kind !== 'daily' && kind !== 'weekly';
    weekdayField.hidden = kind !== 'weekly';
}
async function openScheduleDialog() {
    resultLine.textContent = '';
    [plugins, devices] = await Promise.all([
        request('/api/plugins'),
        request('/api/devices'),
    ]);
    deviceSelect.replaceChildren();
    for (const device of devices.filter((entry) => !entry.disabled))
        deviceSelect.add(new Option(device.name, device.udid));
    taskSelect.replaceChildren();
    for (const plugin of plugins) {
        for (const task of plugin.tasks) {
            taskSelect.add(new Option(`${plugin.displayName} — ${task.displayName}`, `${plugin.id}|${task.type}|${task.version}`));
        }
    }
    if (!weekdayHost.childElementCount) {
        weekdayHost.replaceChildren(...WEEKDAYS.map((name, index) => {
            const label = document.createElement('label');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.value = String(index);
            box.checked = false;
            label.append(box, document.createTextNode(` ${name}`));
            return label;
        }));
    }
    renderFields();
    syncTimingFields();
    dialog.showModal();
}
newSchedule.addEventListener('click', () => void openScheduleDialog().catch((error) => window.alert(error instanceof Error ? error.message : String(error))));
document.querySelector('#close-schedule').addEventListener('click', () => dialog.close());
document.querySelector('#cancel-schedule').addEventListener('click', () => dialog.close());
taskSelect.addEventListener('change', renderFields);
deviceSelect.addEventListener('change', renderFields);
kindSelect.addEventListener('change', syncTimingFields);
form.addEventListener('submit', (event) => {
    event.preventDefault();
    const selection = selectedTask();
    if (!selection)
        return;
    resultLine.textContent = 'Creating…';
    void (async () => {
        try {
            await request('/api/schedules', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    deviceUdid: deviceSelect.value,
                    task: { pluginId: selection.plugin.id, taskType: selection.task.type, taskVersion: selection.task.version, payload: collectPayload() },
                    timing: timing(),
                    runWindowMinutes: Number(runWindowInput.value) || 30,
                }),
            });
            resultLine.textContent = '';
            dialog.close();
            await load();
        }
        catch (error) {
            resultLine.textContent = error instanceof Error ? error.message : String(error);
        }
    })();
});
async function load() {
    refresh.disabled = true;
    try {
        const [scheduler, scheduleData, executionData, pluginList, deviceList] = await Promise.all([
            request('/api/scheduler'),
            request('/api/schedules'),
            request('/api/executions'),
            request('/api/plugins'),
            request('/api/devices'),
        ]);
        plugins = pluginList;
        devices = deviceList;
        banner.hidden = scheduler.available;
        newSchedule.disabled = !scheduler.available;
        if (!scheduler.available) {
            banner.textContent = `Scheduling is off${scheduler.reason ? ` (${scheduler.reason})` : ''}. It needs PostgreSQL: run npm run db:up && npm run db:migrate, then restart the dashboard. The phones and agents work without it.`;
        }
        renderSchedules(scheduleData.schedules);
        renderExecutions(executionData.executions);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        schedulesElement.replaceChildren(empty(message));
        executionsElement.replaceChildren(empty(message));
    }
    finally {
        refresh.disabled = false;
    }
}
refresh.addEventListener('click', () => void load());
void load();
setInterval(() => void load(), 5_000);
export {};
