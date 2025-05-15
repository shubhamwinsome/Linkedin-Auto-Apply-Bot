// This script is injected into LinkedIn pages and helps with direct page manipulation
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // This content script can be used for specific page interactions that need to run in page context
  // For now, we just acknowledge messages to ensure the extension is working
  if (message.action === 'check') {
    console.log("Content script is active on LinkedIn page");
    sendResponse({success: true, message: "Content script is active"});
  }
  
  return true; // Keep the message channel open for async responses
});