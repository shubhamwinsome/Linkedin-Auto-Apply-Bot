// Initialize UI elements
document.addEventListener('DOMContentLoaded', function() {
  // Get UI elements
  const startButton = document.getElementById('startApply');
  const stopButton = document.getElementById('stopApply');
  const statusElement = document.getElementById('status');
  const appliedCountElement = document.getElementById('appliedCount');
  const maxAppsInput = document.getElementById('maxApps');
  const delayInput = document.getElementById('delay');
  const onlyEasyApplyCheckbox = document.getElementById('onlyEasyApply');
  
  // Load saved settings
  chrome.storage.local.get(['maxApps', 'delay', 'onlyEasyApply', 'status', 'appliedCount'], function(data) {
    if (data.maxApps) maxAppsInput.value = data.maxApps;
    if (data.delay) delayInput.value = data.delay;
    if (data.onlyEasyApply !== undefined) onlyEasyApplyCheckbox.checked = data.onlyEasyApply;
    if (data.status) statusElement.textContent = data.status;
    if (data.appliedCount !== undefined) appliedCountElement.textContent = data.appliedCount;
    
    // Check if we should disable the start button (if already running)
    if (data.status && (data.status.includes('Starting') || data.status.includes('Processing'))) {
      startButton.disabled = true;
      stopButton.disabled = false;
    }
  });
  
  // Validate and save settings when changed
  maxAppsInput.addEventListener('change', function() {
    // Ensure value is within range
    const value = parseInt(maxAppsInput.value);
    if (isNaN(value) || value < 1) maxAppsInput.value = 1;
    if (value > 100) maxAppsInput.value = 100;
    
    chrome.storage.local.set({ maxApps: parseInt(maxAppsInput.value) });
  });
  
  delayInput.addEventListener('change', function() {
    // Ensure value is within range
    const value = parseInt(delayInput.value);
    if (isNaN(value) || value < 3) delayInput.value = 3; // Minimum 3 seconds delay
    if (value > 30) delayInput.value = 30;
    
    chrome.storage.local.set({ delay: parseInt(delayInput.value) });
  });
  
  onlyEasyApplyCheckbox.addEventListener('change', function() {
    chrome.storage.local.set({ onlyEasyApply: onlyEasyApplyCheckbox.checked });
  });
  
  // Start button click event
  startButton.addEventListener('click', function() {
    // Verify we're on a LinkedIn jobs page first
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs.length === 0) {
        updateStatus('No active tab found.');
        return;
      }
      
      const currentUrl = tabs[0].url;
      if (!currentUrl.includes('linkedin.com/jobs')) {
        updateStatus('Please navigate to LinkedIn Jobs page first.');
        return;
      }
      
      // Check if the content script is ready
      chrome.tabs.sendMessage(tabs[0].id, { action: 'check' }, function(response) {
        // No response handling needed - errors will be caught in the callback
        
        // Save current settings
        const settings = {
          maxApps: parseInt(maxAppsInput.value),
          delay: parseInt(delayInput.value),
          onlyEasyApply: onlyEasyApplyCheckbox.checked
        };
        
        // Store settings
        chrome.storage.local.set(settings);
        
        // Send message to background script to start auto-apply
        chrome.runtime.sendMessage({
          action: 'startAutoApply',
          settings: settings
        }, function(response) {
          if (response && response.success) {
            updateStatus('Starting job collection...');
            startButton.disabled = true;
            stopButton.disabled = false;
          } else {
            updateStatus('Failed to start auto-apply.');
          }
        });
      });
    });
  });
  
  // Stop button click event
  stopButton.addEventListener('click', function() {
    chrome.runtime.sendMessage({
      action: 'stopAutoApply'
    }, function(response) {
      if (response && response.success) {
        updateStatus('Auto apply stopped.');
        startButton.disabled = false;
        stopButton.disabled = true;
      }
    });
  });
  
  // Helper function to update status
  function updateStatus(text) {
    statusElement.textContent = text;
    chrome.storage.local.set({ status: text });
  }
  
  // Update UI from storage changes
  chrome.storage.onChanged.addListener(function(changes) {
    if (changes.status && changes.status.newValue) {
      statusElement.textContent = changes.status.newValue;
      
      // If the status indicates completion or stopping, enable the start button
      if (changes.status.newValue.includes('Completed') || 
          changes.status.newValue.includes('stopped') || 
          changes.status.newValue.includes('Reached maximum')) {
        startButton.disabled = false;
        stopButton.disabled = true;
      }
    }
    
    if (changes.appliedCount && changes.appliedCount.newValue !== undefined) {
      appliedCountElement.textContent = changes.appliedCount.newValue;
    }
  });
});