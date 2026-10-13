// Clicking the toolbar icon opens the side panel, where all capture and playback happens.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
