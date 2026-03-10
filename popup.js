document.addEventListener('DOMContentLoaded', async () => {
  const launchBtn = document.getElementById('launch');
  const gotoBtn = document.getElementById('gotoWL');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Check if on Watch Later page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isWatchLater = tab?.url?.includes('youtube.com/playlist?list=WL') ||
                       tab?.url?.includes('youtube.com/feed/queue');

  if (isWatchLater) {
    statusDot.classList.add('active');
    statusText.textContent = 'Watch Later page detected ✓';
    launchBtn.style.background = '#00aa33';
  } else {
    statusText.textContent = 'Click "Go to Watch Later" below';
  }

  launchBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('youtube.com')) {
      statusText.textContent = 'Please open YouTube first';
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        window.postMessage({ type: 'SWIPE_LATER_LAUNCH' }, '*');
      }
    });

    window.close();
  });

  gotoBtn.addEventListener('click', async () => {
    chrome.tabs.create({ url: 'https://www.youtube.com/playlist?list=WL' });
    window.close();
  });
});
