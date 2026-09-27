// background.js — service worker. The only privileged thing we do here is
// screenshot the visible tab on behalf of the content script.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'capture') return false;
  const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
  chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 92 }, (dataUrl) => {
    const err = chrome.runtime.lastError;
    if (err || !dataUrl) sendResponse({ ok: false, error: (err && err.message) || 'capture returned no image' });
    else sendResponse({ ok: true, dataUrl });
  });
  return true; // async response
});
