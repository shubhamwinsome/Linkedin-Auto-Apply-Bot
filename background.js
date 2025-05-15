let isApplying = false;
let appliedCount = 0;
let jobLinks = [];
let userData = {};

// Initialize storage
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    appliedCount: 0,
    status: 'Ready to start',
    maxApps: 10,
    delay: 5,
    onlyEasyApply: true
  });

  // Load user data from JSON file
  fetch(chrome.runtime.getURL('userdata.json'))
    .then(response => response.json())
    .then(data => {
      userData = data;
      console.log("User data loaded successfully");
    })
    .catch(error => console.error("Error loading user data:", error));
});

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startAutoApply') {
    startAutoApply(message.settings);
    sendResponse({success: true});
  }
  else if (message.action === 'stopAutoApply') {
    stopAutoApply();
    sendResponse({success: true});
  }
  else if (message.action === 'jobsCollected') {
    jobLinks = message.jobs;
    chrome.storage.local.set({
      status: `Found ${jobLinks.length} jobs. Starting application process...`
    });
    processNextJob();
  }
  else if (message.action === 'applicationComplete') {
    appliedCount++;
    chrome.storage.local.set({
      appliedCount: appliedCount,
      status: `Applied to ${appliedCount} jobs. Moving to next...`
    });
    // Wait a bit before processing the next job to mimic human behavior and avoid rate limiting
    setTimeout(processNextJob, message.delay ? message.delay * 1000 : 5000);
  }
  else if (message.action === 'applicationFailed') {
    chrome.storage.local.set({
      status: `Failed to apply: ${message.error}. Moving to next...`
    });
    setTimeout(processNextJob, message.delay ? message.delay * 1000 : 5000); // Still proceed to next job
  }
  return true; // Required for asynchronous sendResponse
});

function startAutoApply(settings) {
  isApplying = true;
  appliedCount = 0; // Reset count for new session
  jobLinks = [];
  chrome.storage.local.get(['appliedCount', 'maxApps', 'delay', 'onlyEasyApply'], (result) => {
    // Update global settings or use defaults if not set by popup
    const maxApplications = settings.maxApps || result.maxApps || 10;
    const baseDelay = (settings.delay || result.delay || 5) * 1000; // in ms
    const onlyEasyApply = typeof settings.onlyEasyApply !== 'undefined' ? settings.onlyEasyApply : (typeof result.onlyEasyApply !== 'undefined' ? result.onlyEasyApply : true);


    chrome.storage.local.set({
      appliedCount: 0, // Reset storage count as well
      status: 'Starting auto-apply process...',
      maxApps: maxApplications,
      delay: baseDelay / 1000,
      onlyEasyApply: onlyEasyApply
    });

    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0]) {
        chrome.scripting.executeScript({
          target: {tabId: tabs[0].id},
          function: collectJobLinks,
          args: [onlyEasyApply] // Pass the onlyEasyApply setting
        });
      }
    });
  });
}

function stopAutoApply() {
  isApplying = false;
  chrome.storage.local.set({
    status: 'Auto-apply stopped by user.'
  });
}

function processNextJob() {
  if (!isApplying || jobLinks.length === 0) {
    if (isApplying) { // Only update status if it was applying and now stopping due to no more jobs
      chrome.storage.local.set({
        status: `Completed! Applied to ${appliedCount} jobs.`
      });
      isApplying = false; // Ensure isApplying is set to false
    }
    return;
  }

  chrome.storage.local.get(['appliedCount', 'maxApps', 'delay'], (result) => {
    if (appliedCount >= (result.maxApps || 10) ) {
      stopAutoApply();
      chrome.storage.local.set({
        status: `Reached max applications limit of ${result.maxApps}. Stopping.`
      });
      return;
    }

    const jobUrl = jobLinks.shift(); // Get the next job URL
    const delay = result.delay ? result.delay * 1000 : 5000; // delay in ms from storage

    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0]) {
        // First, navigate to the job URL
        chrome.tabs.update(tabs[0].id, {url: jobUrl}, (tab) => {
          // Wait for the page to load before trying to click the job card
          setTimeout(() => {
            // Extract job ID from URL to find the card
            const urlParams = new URLSearchParams(new URL(jobUrl).search);
            const jobId = urlParams.get('currentJobId') || urlParams.get('jobCollectionJobId'); // Common params for job IDs

            if (!jobId) {
                console.error("Could not extract job ID from URL:", jobUrl);
                chrome.runtime.sendMessage({ action: 'applicationFailed', error: 'Could not extract job ID', delay: delay/1000 });
                return;
            }

            chrome.scripting.executeScript({
              target: {tabId: tab.id},
              function: clickJobCard,
              args: [jobId, userData, delay / 1000] // Pass delay for use in applicationComplete/Failed messages
            });
          }, 5000); // Wait 5 seconds for job page to potentially load/redirect
        });
      }
    });
  });
}


// ---- Content Scripts to be Injected ---- //

function collectJobLinks(onlyEasyApplyFilter) {
  const jobCards = document.querySelectorAll('.job-card-container, .job-card-list__entity-lockup, .jobs-search-results-list__item');
  const links = [];
  jobCards.forEach(card => {
    let easyApplyButton = card.querySelector('.jobs-apply-button, button[aria-label*="Easy Apply"], button[data-control-name="easy_apply_button"]');
    let buttonText = easyApplyButton ? easyApplyButton.textContent.toLowerCase() : "";

    if (onlyEasyApplyFilter) {
      if (!easyApplyButton) {
         // Fallback: check all text content of the card for "easy apply" if specific button not found
         const cardText = card.textContent.toLowerCase();
         if (!cardText.includes('easy apply')) return; // Skip if not Easy Apply
      } else if (!buttonText.includes('easy apply')) {
         return; // Skip if button exists but doesn't say Easy Apply
      }
    }
    // If not filtering by Easy Apply, or if it is an Easy Apply job, get the link
    const linkElement = card.querySelector('a[data-tracking-control-name="public_jobs_jserp-result_search-card"]');
    if (linkElement && linkElement.href) {
      links.push(linkElement.href);
    }
  });
  if (links.length > 0) {
    chrome.runtime.sendMessage({action: 'jobsCollected', jobs: links});
  } else {
    chrome.runtime.sendMessage({action: 'applicationFailed', error: 'No jobs found with current filters'});
  }
}

function clickJobCard(jobId, userDataParam, delay) {
    // Find the job card that corresponds to the current job ID
    // LinkedIn might use different selectors for the focused/active job card
    const jobCard = document.querySelector(`[data-job-id="${jobId}"], [data-entity-urn="urn:li:jobPosting:${jobId}"]`);

    if (jobCard) {
        jobCard.click(); // Click the card to make sure the details pane is for this job

        // Wait a moment for the job details pane to potentially update
        setTimeout(() => {
            chrome.scripting.executeScript({
                target: { func: applyToJob, args: [userDataParam, delay] } // applyToJob is a global function in this execution context
            });
        }, 3000); // Wait 3 seconds
    } else {
        console.error("Could not find job card for ID:", jobId);
        chrome.runtime.sendMessage({ action: 'applicationFailed', error: 'Could not find job card', delay: delay });
    }
}


function applyToJob(userDataParam, delay) {
  // Default user data if nothing is passed
  const userData = userDataParam || {
    name: "Your Name",
    email: "your.email@example.com",
    phone: "123-456-7890",
    resume: "path/to/your/resume.pdf",
    coverLetter: "Optional: Your cover letter content or path.",
    portfolio: "yourportfolio.com",
    linkedin: "linkedin.com/in/yourprofile",
    github: "github.com/yourusername",
    customAnswers: {
      "Why do you want to work here?": "I am passionate about this company's mission...",
      // Add more custom questions and answers here
    }
  };

  // Helper function to find and click the Easy Apply button
  async function clickEasyApply() {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const easyApplyButton = document.querySelector(
          '.jobs-apply-button--top-card .jobs-apply-button, button[aria-label*="Easy Apply"], button[data-control-name="easy_apply_button"], .jobs-apply__button button'
        );
        if (easyApplyButton && !easyApplyButton.disabled && easyApplyButton.offsetParent !== null) {
          console.log("Easy Apply button found, clicking it:", easyApplyButton.textContent);
          easyApplyButton.click();
          resolve();
        } else {
          console.error("No apply button found");
          reject('Easy Apply button not found');
        }
      }, 2000); // Wait for button to appear
    });
  }

  // Helper function to fill form fields
  // Enhanced to handle more field types and provide specific answers
  function fillForm() {
    const allInputs = document.querySelectorAll('input, textarea, select, div[role="combobox"], div[role="radiogroup"]');
    let allFieldsFilled = true;

    allInputs.forEach(input => {
      try {
        if (input.offsetParent === null || input.disabled) return; // Skip hidden or disabled fields

        const labelElement = document.getElementById(input.getAttribute('aria-labelledby')) || input.closest('label') || input.closest('.fb-form-element-label') || input.closest('div')?.querySelector('label, .artdeco-form-item-label');
        const labelText = labelElement ? labelElement.textContent.toLowerCase().trim() : '';
        const allText = (labelText + ' ' + (input.placeholder || '') + ' ' + (input.name || '') + ' ' + (input.id || '')).toLowerCase();
        let foundMatch = false;

        // Generic function to check for keywords
        const containsAny = (text, keywords) => keywords.some(keyword => text.includes(keyword));

        // Fill based on type and label
        if (input.tagName === 'INPUT') {
          const inputType = input.type.toLowerCase();
          if (['text', 'email', 'tel', 'url', 'search', 'number'].includes(inputType) || inputType === "") { // Treat empty type as text
            if (containsAny(allText, ['full name', 'name', 'legal name'])) { input.value = userData.name; foundMatch = true; }
            else if (containsAny(allText, ['email', 'e-mail'])) { input.value = userData.email; foundMatch = true; }
            else if (containsAny(allText, ['phone', 'mobile', 'contact number'])) { input.value = userData.phone; foundMatch = true; }
            else if (containsAny(allText, ['portfolio', 'website', 'profile url'])) { input.value = userData.portfolio || userData.linkedin; foundMatch = true; }
            else if (containsAny(allText, ['linkedin'])) { input.value = userData.linkedin; foundMatch = true; }
            else if (containsAny(allText, ['github'])) { input.value = userData.github; foundMatch = true; }
            else if (containsAny(allText, ['city', 'location'])) { input.value = userData.city || "Your City"; foundMatch = true; }
            else if (containsAny(allText, ['salary', 'compensation', 'expected pay'])) { input.value = userData.expectedSalary || "Negotiable"; foundMatch = true; }
            // Try to match custom answers for any remaining text fields
            else if (userData.customAnswers) {
              for (const question in userData.customAnswers) {
                if (allText.includes(question.toLowerCase())) {
                  input.value = userData.customAnswers[question];
                  foundMatch = true;
                  break;
                }
              }
            }
            if (!foundMatch && input.required && !input.value) {
                input.value = "N/A"; // Default for other required text fields
                foundMatch = true; // Mark as handled
            }
          } else if (inputType === 'file' && containsAny(allText, ['resume', 'cv'])) {
            // File input for resume - requires manual intervention or more complex handling
            console.log("Resume upload field found. Manual upload might be required.", input);
            // Note: Direct file path setting is not allowed for security reasons.
            // This part will likely need extension mechanisms to interact with user's file system if fully automated.
            // For now, we acknowledge it. If it's required and empty, it might block submission.
            if (input.required && !input.value) allFieldsFilled = false;

          } else if (inputType === 'radio' || inputType === 'checkbox') {
            // For radio/checkbox, check for yes/no, true/false type questions or specific keywords
             const parentGroup = input.closest('fieldset, div[role="radiogroup"], div.fb-radio-buttons');
             const groupLabelText = parentGroup?.querySelector('legend, .fb-form-element-label, .artdeco-form-item-label')?.textContent.toLowerCase() || '';
             const combinedLabel = (labelText + ' ' + groupLabelText).trim();

            if (containsAny(combinedLabel, ['sponsorship', 'visa', 'work authorization', 'authorised to work'])) {
              // Prefer "No" for sponsorship questions if not specified in userData
              if (input.value.toLowerCase().includes('no') && !input.checked) { input.click(); foundMatch = true;}
              else if (input.value.toLowerCase().includes('yes') && userData.requiresSponsorship === false && !input.checked) {input.click(); foundMatch = true;}
              else if (input.value.toLowerCase().includes('yes') && userData.requiresSponsorship === true && !input.checked) {input.click(); foundMatch = true;}

            } else if (containsAny(combinedLabel, ['gender', 'race', 'ethnicity', 'disability', 'veteran'])) {
              // Prefer "Decline to self-identify" or similar for EEO questions
              if (containsAny(input.value.toLowerCase(), ['decline', 'prefer not to say', 'do not wish']) && !input.checked) {
                input.click();
                foundMatch = true;
              }
            }
            // If still not matched and it's a radio group where one must be selected
            if (!foundMatch && inputType === 'radio' && input.required) {
                const groupName = input.name;
                if (groupName && !document.querySelector(`input[name="${groupName}"]:checked`)) {
                    // If a group of required radios has none selected, we can't safely pick one.
                    // However, LinkedIn often pre-selects or has a clear default.
                    // If we must pick, picking the first option is a blind guess.
                    // For now, we'll rely on user data or manual intervention for complex radios.
                }
            }
             if (input.required && !input.checked && !foundMatch) {
                // If a single required checkbox is not checked, and no specific logic handled it.
                // This is risky to auto-check. It's better to rely on specific userData flags.
             }
          }
        } else if (input.tagName === 'TEXTAREA') {
          if (userData.customAnswers) {
            for (const question in userData.customAnswers) {
              if (allText.includes(question.toLowerCase())) {
                input.value = userData.customAnswers[question];
                foundMatch = true;
                break;
              }
            }
          }
          if (!foundMatch && containsAny(allText, ['cover letter', 'additional information', 'why you'])) {
             input.value = userData.coverLetter || userData.customAnswers["Why do you want to work here?"] || "I am very interested in this opportunity and believe my skills are a great fit.";
             foundMatch = true;
          }
          if (input.required && !input.value && !foundMatch) {
             input.value = "As per my resume and qualifications, I believe I am a strong candidate for this role.";
             foundMatch = true;
          }
        } else if (input.tagName === 'SELECT') {
          // Handle select dropdowns
          if (userData.customSelects) {
            for (const selectLabel in userData.customSelects) {
              if (allText.includes(selectLabel.toLowerCase())) {
                const desiredOptionText = userData.customSelects[selectLabel].toLowerCase();
                Array.from(input.options).forEach(option => {
                  if (option.textContent.toLowerCase().includes(desiredOptionText)) {
                    option.selected = true;
                    foundMatch = true;
                  }
                });
                if (foundMatch) break;
              }
            }
          }
          if (!foundMatch && input.required && input.selectedIndex === -1 || (input.options[input.selectedIndex] && input.options[input.selectedIndex].disabled)) {
            // If required and no valid option selected, try to select the first non-disabled, non-placeholder option
            for (let i = 0; i < input.options.length; i++) {
                if (input.options[i].value && !input.options[i].disabled && !input.options[i].textContent.toLowerCase().includes('select')) {
                    input.selectedIndex = i;
                    foundMatch = true;
                    break;
                }
            }
          }
        } else if (input.getAttribute('role') === 'combobox') {
            // Handle ARIA comboboxes (often text input with suggestions)
            const comboboxInput = input.querySelector('input[type="text"], input:not([type])') || input; // The actual input field might be nested
            if (containsAny(allText, ['location', 'city'])) { comboboxInput.value = userData.city || "Your City"; foundMatch = true; }
            // More specific combobox handling can be added here
            if (!foundMatch && input.getAttribute('aria-required') === 'true' && !comboboxInput.value) {
                 comboboxInput.value = "N/A"; // Default for required comboboxes
                 foundMatch = true;
            }
        } else if (input.getAttribute('role') === 'radiogroup') {
            // Logic similar to input type radio, but for ARIA radiogroups
            // Iterate through child radio buttons (div[role="radio"])
            const radios = input.querySelectorAll('div[role="radio"]');
            const groupLabelText = input.querySelector('label, .artdeco-form-item-label')?.textContent.toLowerCase() || '';
            const combinedLabel = (labelText + ' ' + groupLabelText).trim();
            let oneSelected = Array.from(radios).some(r => r.getAttribute('aria-checked') === 'true');

            if (!oneSelected) {
                radios.forEach(radio => {
                    const radioLabel = document.getElementById(radio.getAttribute('aria-labelledby'))?.textContent.toLowerCase() || radio.textContent.toLowerCase();
                    if (containsAny(combinedLabel, ['sponsorship', 'visa', 'work authorization'])) {
                         if (radioLabel.includes('no') && userData.requiresSponsorship === false) { radio.click(); foundMatch = true;}
                         else if (radioLabel.includes('yes') && userData.requiresSponsorship === true) { radio.click(); foundMatch = true;}
                         else if (radioLabel.includes('no')) { radio.click(); foundMatch = true;} // Default to No if not specified
                    } else if (containsAny(combinedLabel, ['gender', 'race', 'ethnicity', 'disability', 'veteran'])) {
                        if (containsAny(radioLabel, ['decline', 'prefer not to say', 'do not wish'])) {
                            radio.click(); foundMatch = true;
                        }
                    }
                    if (foundMatch) return; // Exit loop if one is clicked
                });
            }
            if (input.getAttribute('aria-required') === 'true' && !foundMatch && !Array.from(radios).some(r => r.getAttribute('aria-checked') === 'true')) {
                // If still none selected and required, click the first available option as a last resort
                // This is risky, better if userData covers these.
            }
        }


        // Final check for required fields that weren't filled
        const isRequired = input.required || input.getAttribute('aria-required') === 'true';
        if (isRequired && !foundMatch) {
          if (input.tagName === 'INPUT' && (input.type === 'text' || input.type === 'email' || input.type === 'tel' || input.type === 'url') && !input.value) {
            // If it's a text-like input and still empty, mark that not all fields are filled yet.
            // Could add a very generic value here but it's risky.
            allFieldsFilled = false;
          } else if (input.tagName === 'TEXTAREA' && !input.value) {
            allFieldsFilled = false;
          } else if (input.tagName === 'SELECT' && (input.selectedIndex === -1 || (input.options[input.selectedIndex] && input.options[input.selectedIndex].disabled))) {
            allFieldsFilled = false;
          }
          // Add checks for other required types if necessary
        }

        // Dispatch change event to ensure website JS picks up the changes
        if (foundMatch || (input.value || input.checked)) { // Only dispatch if we made a change or it has a value
          ['input', 'change', 'blur'].forEach(eventType => {
            const event = new Event(eventType, { bubbles: true });
            input.dispatchEvent(event);
          });
        }

      } catch (e) {
        console.error("Error filling form field:", e, input);
      }
    });
    return allFieldsFilled; // This return value might not be perfectly indicative if some fields are complex (e.g. file uploads)
  }

  // Function to check if application seems complete (e.g., on a review page or success message)
  function isApplicationComplete() {
    // Look for common "review application" or "application submitted" texts/buttons
    const reviewTexts = ['review your application', 'review application', 'application submitted', 'applied successfully', 'thanks for applying'];
    const pageText = document.body.innerText.toLowerCase();
    if (reviewTexts.some(text => pageText.includes(text))) {
      console.log("Application seems complete or on review page.");
      return true;
    }

    // Also check if the modal is gone or the primary "easy apply" button is no longer present
    const easyApplyModal = document.querySelector('.jobs-easy-apply-modal, .artdeco-modal[aria-labelledby*="easy-apply"]');
    if (!easyApplyModal) {
        console.log("Easy Apply modal seems to be closed.");
        return true;
    }
    // Check if a "submit application" button is no longer visible/active within the modal
    const submitButtonInsideModal = easyApplyModal.querySelector('button[aria-label*="Submit application"], button[data-control-name="submit_application"]');
    if (easyApplyModal && !submitButtonInsideModal) {
        console.log("No final submit button in modal, might be complete or on a non-standard step.");
        // This could be a point where it's complete, or stuck on a custom question page not handled.
    }

    return false;
  }


  // Function to click submit/next/continue buttons
  function clickSubmit() {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const buttonTexts = ['submit', 'next', 'review', 'apply', 'continue', 'send', 'save'];
        // Query for buttons and also roles that act as buttons if they are links
        const allButtons = Array.from(document.querySelectorAll('button, a.artdeco-button'));
        let buttonFound = false;

        // Try to find the button with the matching text - more aggressive search
        for (const text of buttonTexts) {
          const button = allButtons.find(btn => {
            const btnText = (btn.textContent || btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase().trim();
            return btnText.includes(text) && !btn.disabled && btn.offsetParent !== null; // Visible and enabled
          });

          if (button) {
            console.log("Found button by text, clicking it:", button.textContent || button.getAttribute('aria-label'));
            button.click();
            buttonFound = true;
            resolve(true); // Indicate a button was clicked
            return;
          }
        }

        // If no text match, look for buttons in modal footers or common action areas
        if (!buttonFound) {
          const modalFooter = document.querySelector('.artdeco-modal__actionbar, footer, .jobs-easy-apply-footer');
          if (modalFooter) {
            const footerButtons = Array.from(modalFooter.querySelectorAll('button, a.artdeco-button'));
            
            // Look for primary action button
            const primaryButton = footerButtons.find(btn => {
              return btn.classList.contains('artdeco-button--primary') && 
                     !btn.disabled && 
                     btn.offsetParent !== null;
            });
            
            if (primaryButton) {
              console.log("Found primary footer button, clicking it:", primaryButton.textContent);
              primaryButton.click();
              buttonFound = true;
              resolve(true);
              return;
            }

            // If no primary button, try the rightmost button (usually the action button)
            if (footerButtons.length > 0) {
              const lastButton = footerButtons[footerButtons.length - 1]; // often the affirmative action
              if (!lastButton.disabled && lastButton.offsetParent !== null) {
                console.log("Clicking last footer button:", lastButton.textContent);
                lastButton.click();
                buttonFound = true;
                resolve(true);
                return;
              }
            }
          }
        }
        
        // As a last resort, look for any visible primary button or the last visible button on the page if no specific one found
        if (!buttonFound) {
            const visibleButtons = allButtons.filter(btn => !btn.disabled && btn.offsetParent !== null);
            if (visibleButtons.length > 0) {
                const primaryVisibleButton = visibleButtons.find(btn => btn.classList.contains('artdeco-button--primary'));
                const buttonToClick = primaryVisibleButton || visibleButtons[visibleButtons.length - 1]; // Prefer primary, else last
                
                console.log("Clicking last resort button:", buttonToClick.textContent || buttonToClick.getAttribute('aria-label'));
                buttonToClick.click();
                buttonFound = true;
                resolve(true);
                return;
            }
        }


        if (!buttonFound) {
          console.error("No submit/next button found");
          reject('No submit/next button found'); // No button was clicked
        }
      }, 1000); // Wait for buttons to render
    });
  }

  // Function to find and fix validation errors
  async function fixValidationErrors() {
    let errorsFixed = false;
    const errorMessages = document.querySelectorAll('.artdeco-inline-feedback[role="alert"], .artdeco-text-input--error, span[id*="-error"]');
    if (errorMessages.length > 0) {
        console.log(`Found ${errorMessages.length} validation error messages. Attempting to fix.`);
        for (const errorElement of errorMessages) {
            if (errorElement.offsetParent === null) continue; // Skip hidden errors

            let associatedInput = null;
            // Try to find associated input based on common patterns
            const inputId = errorElement.id.replace('-error', '').replace('-feedback', '');
            if (inputId) {
                associatedInput = document.getElementById(inputId) || document.querySelector(`[aria-describedby*="${errorElement.id}"], [aria-controls="${inputId}"]`);
            }
            if (!associatedInput) {
                associatedInput = errorElement.closest('.artdeco-form-item, .fb-form-element')?.querySelector('input, textarea, select, div[role="combobox"], div[role="radiogroup"]');
            }
             if (!associatedInput && errorElement.previousElementSibling && ['INPUT', 'TEXTAREA', 'SELECT'].includes(errorElement.previousElementSibling.tagName)) {
                associatedInput = errorElement.previousElementSibling;
            }


            if (associatedInput && (associatedInput.offsetParent !== null) && !associatedInput.disabled) {
                console.log("Attempting to fix error for input:", associatedInput, "Error message:", errorElement.textContent);
                // Basic fix: if it's a text input and empty, fill with "N/A" or a default
                if ( (associatedInput.tagName === 'INPUT' && (associatedInput.type === 'text' || associatedInput.type === "") && !associatedInput.value) ||
                     (associatedInput.tagName === 'TEXTAREA' && !associatedInput.value) ) {
                    associatedInput.value = "N/A"; // Generic fix
                    ['input', 'change', 'blur'].forEach(eventType => associatedInput.dispatchEvent(new Event(eventType, { bubbles: true })));
                    errorsFixed = true;
                } else if (associatedInput.tagName === 'SELECT' && (associatedInput.selectedIndex === -1 || (associatedInput.options[associatedInput.selectedIndex] && input.options[associatedInput.selectedIndex].disabled))) {
                    for (let i = 0; i < associatedInput.options.length; i++) {
                        if (associatedInput.options[i].value && !associatedInput.options[i].disabled && !associatedInput.options[i].textContent.toLowerCase().includes('select')) {
                            associatedInput.selectedIndex = i;
                            ['input', 'change', 'blur'].forEach(eventType => associatedInput.dispatchEvent(new Event(eventType, { bubbles: true })));
                            errorsFixed = true;
                            break;
                        }
                    }
                }
                // Add more specific fixes based on error message content if needed
            }
        }
    }
    return errorsFixed;
  }


  // Main application flow
  async function applyForJob() {
    try {
      await clickEasyApply(); // Click the main "Easy Apply" button
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for modal to open

      let attemptCount = 0;
      const MAX_ATTEMPTS = 10; // Max steps/clicks to prevent infinite loops
      let isComplete = false;

      while (!isComplete && attemptCount < MAX_ATTEMPTS) {
        console.log(`Application attempt #${attemptCount + 1}`);
        fillForm(); // Fill known fields
        await new Promise(resolve => setTimeout(resolve, 1500)); // Wait for any dynamic updates after filling

        // Check for validation errors and try to fix them
        const errorsWereFixed = await fixValidationErrors();
        if (errorsWereFixed) {
            await new Promise(resolve => setTimeout(resolve, 1500)); // Wait after fixing errors
            fillForm(); // Re-fill form in case fixing errors changed something
            await new Promise(resolve => setTimeout(resolve, 1000));
        }


        isComplete = isApplicationComplete();
        if (isComplete) {
          // Check if we are on a "Review Application" page, if so, final submit might be needed.
          const reviewButton = Array.from(document.querySelectorAll('button, a.artdeco-button'))
                                  .find(btn => (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase().includes('submit application'));
          if (reviewButton && reviewButton.offsetParent !== null && !reviewButton.disabled) {
            console.log("Found final 'Submit Application' button on review page. Clicking it.");
            reviewButton.click();
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for submission
            isComplete = true; // Assume completion after final submit
          }
          break; 
        }

        try {
          await clickSubmit(); // Click Next/Submit/Continue
        } catch (e) {
          // If clickSubmit fails (no button found), it might be a complex custom question page or end of flow.
          console.warn("clickSubmit failed to find a button. Checking completion status.", e.message);
          isComplete = isApplicationComplete(); // Re-check if current state is "complete"
          if (isComplete) break;

          // Fallback: if no standard buttons and not complete, look for any primary or last button again
          // This could be a last-ditch effort on unusual pages
          const allButtons = Array.from(document.querySelectorAll('button:not([aria-label*="Dismiss"]):not([aria-label*="Close"]), a.artdeco-button:not([aria-label*="Dismiss"]):not([aria-label*="Close"])'))
                                .filter(btn => !btn.disabled && btn.offsetParent !== null);
          
          if (allButtons.length > 0) {
            const primaryButton = allButtons.find(btn => btn.classList.contains('artdeco-button--primary'));
            
            if (primaryButton) {
              console.log("Clicking primary button as fallback");
              primaryButton.click();
            } else {
              console.log("Clicking last visible button as ultimate fallback");
              allButtons[allButtons.length - 1].click();
            }
            
            // Wait for next page
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            // If we couldn't find any buttons, this might be a dead end
            throw new Error("No buttons found to continue application");
          }
        }
        attemptCount++;
        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for next page/step to load
      }

      if (isComplete || attemptCount >= MAX_ATTEMPTS && isApplicationComplete()) { // Also check isApplicationComplete if max attempts reached
        console.log("Application process finished or max attempts reached on a completion-like page.");
        chrome.runtime.sendMessage({action: 'applicationComplete', delay: delay});
      } else if (attemptCount >= MAX_ATTEMPTS && !isComplete) {
        console.error("Reached maximum number of application steps without completing");
        chrome.runtime.sendMessage({
          action: 'applicationFailed',
          error: 'Reached maximum steps without completing application',
          delay: delay
        });
      }
    } catch (error) {
      console.error("Error during application process:", error);
      chrome.runtime.sendMessage({
        action: 'applicationFailed',
        error: error.message || 'Unknown error during application',
        delay: delay
      });
    }
  }

  // Start the application process
  applyForJob();
}