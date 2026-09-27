const DEFAULTS = {
  enabled: true, source: 'visual', showMine: true, showTheirs: true,
  showDanger: true, opacity: 0.35, myColor: 'auto', mineColor: '#3b9cff', theirsColor: '#ff5d5d',
};
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
let settings = { ...DEFAULTS };
let tabId = null;
let pollTimer = null;

function setStatus(text, err = false) { statusEl.textContent = text; statusEl.classList.toggle('err', err); }

function send(msg) {
  return new Promise((res) => {
    if (tabId == null) return res(null);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return res(null);
      res(resp);
    });
  });
}

function applyToForm() {
  $('enabled').checked = settings.enabled;
  $('source').value = settings.source;
  $('myColor').value = settings.myColor;
  $('showMine').checked = settings.showMine;
  $('showTheirs').checked = settings.showTheirs;
  $('showDanger').checked = settings.showDanger;
  $('opacity').value = settings.opacity;
  $('mineColor').value = settings.mineColor;
  $('theirsColor').value = settings.theirsColor;
}
function save() { chrome.storage.sync.set({ settings }); }

for (const id of ['enabled', 'showMine', 'showTheirs', 'showDanger']) {
  $(id).addEventListener('change', (e) => { settings[id] = e.target.checked; save(); });
}
for (const id of ['source', 'myColor', 'mineColor', 'theirsColor']) {
  $(id).addEventListener('input', (e) => { settings[id] = e.target.value; save(); });
}
$('opacity').addEventListener('input', (e) => { settings.opacity = parseFloat(e.target.value); save(); });

async function action(type, btn) {
  btn.disabled = true;
  setStatus('Working…');
  const resp = await send({ type });
  btn.disabled = false;
  if (!resp) return setStatus('Overlay is not running on this tab.', true);
  if (!resp.ok) return setStatus(resp.error || 'Failed.', true);
  setStatus(resp.text || 'Done.');
  setTimeout(refresh, 1500);
}
$('calibrate').addEventListener('click', (e) => action('calibrate', e.target));
$('selectRegion').addEventListener('click', async (e) => { action('selectRegion', e.target); window.close(); });
$('clearRegion').addEventListener('click', (e) => action('clearRegion', e.target));
$('clearCal').addEventListener('click', (e) => action('clearCalibration', e.target));
$('activate').addEventListener('click', async () => {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['engine.js', 'content.js'] });
    $('activate').style.display = 'none';
    setStatus('Activated. Detecting board…');
    setTimeout(refresh, 800);
  } catch (e) { setStatus('Could not inject: ' + e.message, true); }
});

async function refresh() {
  const resp = await send({ type: 'status' });
  if (!resp) {
    $('activate').style.display = '';
    setStatus('Not active on this page. Click "Activate on this page", or open chess.com / lichess where it runs automatically.');
    return;
  }
  $('activate').style.display = 'none';
  let line = resp.status || '';
  line += `\nTemplates: ${resp.calibrated ? 'calibrated for ' + resp.host : 'none — calibrate at the starting position'}`;
  line += `\nBoard: ${resp.hasRect ? 'manual region' : 'auto-detected'}`;
  setStatus(line, /^Error|not found|Not calibrated/i.test(resp.status || ''));
}

(async () => {
  const s = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULTS, ...(s.settings || {}) };
  applyToForm();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  await refresh();
  pollTimer = setInterval(refresh, 1500);
})();
